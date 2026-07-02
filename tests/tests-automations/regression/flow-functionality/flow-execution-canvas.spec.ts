import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import {
  createRunnableChatFlowViaApi,
  RUNNABLE_CHAT_FLOW_DEFAULT_INPUT,
} from "../../../helpers/flows/create-runnable-chat-flow-via-api";
import { runFlow } from "../../../helpers/flows/run-flow";

/**
 * Flow execution via the canvas — the generic "run a flow" journey.
 *
 * Langflow (1.11) has no global run button: a flow is run by triggering a
 * terminal node's run control (`button_run_{node}`), which builds the whole
 * upstream graph. This test asserts that journey end to end — the build reaches
 * EVERY node (both duration badges) and the output is produced — exercising the
 * reusable `runFlow` helper.
 *
 * Distinct from sibling specs (intentionally not duplicated here):
 *   - `run-flow.spec.ts` covers the RunFlow *component* (one flow invoking another).
 *   - `chat-input-output-component-regression.spec.ts` covers the components'
 *     handles/fields/propagation.
 *   - `stop-building.spec.ts` / `stop-button-playground.spec.ts` cover stopping a run.
 *
 * Idempotent re-run is intentionally not covered — after the first build the
 * terminal node's run control sits under a right-anchored react-flow panel that
 * intercepts a second click; see the spec doc's "does not cover" section.
 *
 * Deterministic: ChatInput -> ChatOutput echo, no LLM / provider / API key.
 */

// Open the Chat Output inspection dialog and return its full text. Reading the
// whole dialog (not one inner node) mirrors the chat-input-output spec: the
// Message output renders as a structured view that may mix labeled sections
// with a JSON-style preview.
async function readChatOutputInspection(page: Page) {
  const inspect = page.getByTestId("output-inspection-output message-chatoutput");
  await expect(inspect).toBeAttached({ timeout: 10000 });
  await inspect.click();
  // Scope out the first-run `assistant-onboarding-tooltip`, which also carries
  // role="dialog" and would otherwise make this locator strict-mode-ambiguous.
  const dialog = page.locator(
    '[role="dialog"]:not([data-testid="assistant-onboarding-tooltip"])',
  );
  await expect(dialog).toBeVisible({ timeout: 10000 });
  const text =
    (await dialog.evaluate((el: HTMLElement) => el.textContent ?? "")) ?? "";
  // No need to close the dialog — reading the output is the last assertion of
  // the test; the flow is deleted in `finally`. (Test 2 runs on its own flow.)
  return text;
}

test("user can run a flow from the canvas; every node reaches build success and output is produced",
  { tag: ["@stable", "@release", "@workspace", "@regression"] },
  async ({ page, request }) => {
    const authToken = await getAuthToken(request);
    const { flowId, deleteFlow } = await createRunnableChatFlowViaApi(request, {
      Authorization: authToken,
    });

    try {
      await test.step("Open the created flow on the canvas", async () => {
        await page.goto(`/flow/${flowId}`);
        await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
          timeout: 30000,
        });
      });

      await test.step("Run the flow from the terminal node", async () => {
        // Gate on the terminal node's run control being rendered before running,
        // so runFlow does not race canvas hydration (previously masked by
        // adjustScreenView, removed by request).
        await expect(page.getByTestId("button_run_chat output")).toBeVisible({
          timeout: 30000,
        });
        await runFlow(page, "chat output");
        await expect(page.getByText("built successfully").last()).toBeVisible({
          timeout: 45000,
        });
      });

      await test.step("Every node reached build success (duration badge)", async () => {
        await expect(page.getByTestId("node_duration_chat input")).toBeVisible({
          timeout: 15000,
        });
        await expect(
          page.getByTestId("node_duration_chat output"),
        ).toBeVisible({ timeout: 15000 });
      });

      await test.step("Output was produced (echoed input value)", async () => {
        const text = await readChatOutputInspection(page);
        expect(text).toContain(RUNNABLE_CHAT_FLOW_DEFAULT_INPUT);
      });
    } finally {
      // Unmount the editor before deleting: it keeps a GET /flows/{id}/events
      // subscription polling build state; deleting mid-poll yields a benign but
      // log-dirtying 404 "Flow not found" (same teardown race fixed in
      // publish-flow.spec.ts / triage #364).
      await page.goto("/").catch(() => {});
      await deleteFlow();
    }
  },
);
