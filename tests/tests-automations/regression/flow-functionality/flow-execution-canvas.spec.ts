import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  createRunnableChatFlowViaApi,
  RUNNABLE_CHAT_FLOW_DEFAULT_INPUT,
} from "../../../helpers/flows/create-runnable-chat-flow-via-api";
import { runFlow } from "../../../helpers/flows/run-flow";

/**
 * Flow execution via the canvas — one ChatInput -> ChatOutput journey, split
 * into three sequential tests for clarity:
 *   1. Run the flow from the canvas (Langflow 1.11 has no global run button — a
 *      flow is run from a terminal node's `button_run_{node}`, which builds the
 *      whole upstream graph). Uses the reusable `runFlow` helper and anchors
 *      completion on the terminal node's persistent success badge (not the
 *      transient "built successfully" toast, which flakes — see #506 / #507).
 *   2. The flow ran correctly — every node reached build success (both duration
 *      badges), the same signal asserted by the original merged test.
 *   3. The chat input and chat output are visible in the Playground — covers the
 *      "Send a chat input" and "Verify the chat output" checklist items.
 *
 * The three tests share ONE flow and ONE page (`test.describe.configure` serial
 * + a page created once in `beforeAll`), so the journey is not restarted between
 * steps — step 3 sees the output produced by step 1's run.
 *
 * Note: the shared page is created via `browser.newPage()`, so the fixture's
 * automatic backend-error monitor (which wraps the per-test `page` fixture) does
 * not apply here; the happy-path assertions below (built successfully, duration
 * badges, echoed bubbles) fail on a real flow error anyway.
 *
 * Distinct from sibling specs (intentionally not duplicated):
 *   - `run-flow.spec.ts` covers the RunFlow *component* (one flow invoking another).
 *   - `chat-input-output-component-regression.spec.ts` covers the components'
 *     handles/fields/propagation.
 *   - `stop-building.spec.ts` / `stop-button-playground.spec.ts` cover stopping a run.
 *
 * Deterministic: ChatInput -> ChatOutput echo, no LLM / provider / API key.
 */
test.describe("Flow execution — run a ChatInput -> ChatOutput flow", () => {
  // Serial: the three tests are a single dependent journey on a shared page.
  test.describe.configure({ mode: "serial" });

  let page: Page;
  let flowId: string;
  let deleteFlow: () => Promise<void>;

  test.beforeAll(async ({ browser, request }) => {
    // Create the flow once via the API (deterministic, avoids the UI
    // unique-name race) and open its canvas once — no per-test restart.
    const authToken = await getAuthToken(request);
    ({ flowId, deleteFlow } = await createRunnableChatFlowViaApi(request, {
      Authorization: authToken,
    }));

    page = await browser.newPage();
    await page.goto(`/flow/${flowId}`);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });
  });

  test.afterAll(async () => {
    // Unmount the editor before deleting so its GET /flows/{id}/events poll does
    // not 404 mid-delete (same teardown race fixed in publish-flow / triage #364).
    await page.goto("/").catch(() => {});
    await deleteFlow();
    await page.close();
  });

  test("1 - runs the flow from the canvas terminal node",
    { tag: ["@stable", "@release", "@workspace", "@regression"] },
    async () => {
      // Gate on the run control being rendered so the run does not race canvas
      // hydration.
      await expect(page.getByTestId("button_run_chat output")).toBeVisible({
        timeout: 30000,
      });
      await runFlow(page, "chat output");
      // Anchor build completion on the terminal node's persistent success badge,
      // NOT the transient "built successfully" toast — the toast fades and flakes
      // the wait (same fix as #506 / #507: anchor on node status, not toast). The
      // badge renders only on a successful build, so failure semantics are kept.
      await expect(page.getByTestId("node_duration_chat output")).toBeVisible({
        timeout: 45000,
      });
    },
  );

  test("2 - the flow ran correctly: every node reached build success",
    { tag: ["@stable", "@release", "@workspace", "@regression"] },
    async () => {
      // A duration badge renders only when a node's build succeeded — asserting
      // BOTH proves the whole graph built, not just the output node.
      await expect(page.getByTestId("node_duration_chat input")).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByTestId("node_duration_chat output")).toBeVisible({
        timeout: 15000,
      });
    },
  );

  test("3 - the chat input and chat output are visible in the Playground",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@playground"] },
    async () => {
      await page.getByTestId("playground-btn-flow-io").click();
      // The run from step 1 produced a session message: the User bubble is the
      // chat input, the AI bubble is the Chat Output echo. Both embed the input
      // value in their testid.
      await expect(
        page.getByTestId(`chat-message-User-${RUNNABLE_CHAT_FLOW_DEFAULT_INPUT}`),
      ).toBeVisible({ timeout: 30000 });
      await expect(
        page.getByTestId(`chat-message-AI-${RUNNABLE_CHAT_FLOW_DEFAULT_INPUT}`),
      ).toBeVisible({ timeout: 45000 });
    },
  );
});
