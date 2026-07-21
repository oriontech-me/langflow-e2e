import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createRunnableChatFlowViaApi,
  type RunnableChatFlow,
} from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Playground — send a message while a response is in progress (QA-CHECKLIST
 * §9.1). While a run is streaming, the Playground disables the chat input and
 * swaps `button-send` for `button-stop`, so a second send is impossible until
 * the run settles — a "wait" that prevents session corruption.
 *
 * The in-progress window is created deterministically (no LLM): the run request
 * (`POST /api/v2/workflows`) is held open by the test until it releases it. The
 * flow is a ChatInput -> ChatOutput passthrough, so no provider key is needed.
 *
 * Distinctive observable: the chat input goes enabled -> disabled (in progress)
 * -> enabled, paired with the send/stop swap, and exactly one response is
 * rendered (no duplicate/interleaved run from the blocked second send).
 */

const RUN_ENDPOINT = /\/api\/v2\/workflows\b/;

// Serial: creates and runs a named playground flow.
test.describe.configure({ mode: "serial" });

test.describe("Playground — send while a response is in progress", () => {
  let flow: RunnableChatFlow;

  test.afterEach(async ({ request }) => {
    if (!flow?.flowId) return;
    const bearer = await getAuthToken(request);
    // Scoped teardown by id — never a global cleanAllFlows.
    await deleteFlow(request, flow.flowId, {
      headers: { Authorization: bearer },
    }).catch(() => {});
  });

  test(
    "input is locked while a run is in progress and recovers after it completes",
    { tag: ["@regression", "@playground"] },
    async ({ page, request }) => {
      const bearer = await getAuthToken(request);
      flow = await createRunnableChatFlowViaApi(request, { Authorization: bearer });

      await test.step("open the flow and its Playground", async () => {
        await page.goto(`/flow/${flow.flowId}`);
        await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible({
          timeout: 30000,
        });
        await page.getByTestId("playground-btn-flow-io").click();
        await expect(
          page.getByTestId("input-chat-playground").last(),
        ).toBeVisible({ timeout: 30000 });
      });

      const input = page.getByTestId("input-chat-playground").last();

      await test.step("baseline — input enabled, send button present", async () => {
        await expect(input).toBeEnabled();
        await expect(page.getByTestId("button-send").last()).toBeVisible();
      });

      // Hold the run request open until we release it, creating a deterministic
      // in-progress window without depending on model latency.
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route(RUN_ENDPOINT, async (route) => {
        await held;
        // The request may have been aborted (navigation/retry) while held; a
        // stale route then throws "already handled" — swallow it.
        await route.continue().catch(() => {});
      });

      await test.step("send the first message (run stays in progress)", async () => {
        await input.fill("first message");
        await page.getByTestId("button-send").last().click();
      });

      await test.step("in progress — input disabled, send hidden, stop shown", async () => {
        await expect(page.getByTestId("button-stop").last()).toBeVisible({
          timeout: 30000,
        });
        await expect(page.getByTestId("button-send")).toHaveCount(0);
        // The disabled input is the block: a second message cannot be entered
        // or submitted while the run is in progress.
        await expect(input).toBeDisabled({ timeout: 10000 });
      });

      await test.step("release the run and let it complete", async () => {
        // Releasing lets the held handler continue the request; the route stays
        // registered so any subsequent run calls pass straight through.
        release();
      });

      await test.step("recovery — input re-enabled, one response, state intact", async () => {
        await expect(page.getByTestId("button-send").last()).toBeVisible({
          timeout: 60000,
        });
        await expect(input).toBeEnabled({ timeout: 60000 });
        // Exactly one response rendered — the blocked second send leaked no
        // duplicate or interleaved run.
        await expect(page.getByTestId("div-chat-message")).toHaveCount(1);
      });
    },
  );
});
