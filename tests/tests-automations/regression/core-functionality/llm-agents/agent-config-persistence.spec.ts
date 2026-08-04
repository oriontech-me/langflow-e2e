import type { Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { loadTemplateByName } from "../../../../helpers/flows/load-template-by-name";
import { adjustScreenView } from "../../../../helpers/ui/adjust-screen-view";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "../../../../helpers/ui/open-advanced-options";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";

/**
 * Agent config persistence (QA-CHECKLIST §6.2 "Flow with Agent saved and
 * reopened → settings preserved").
 *
 * Model-free by design (area rule): persistence is a backend/autosave
 * contract — no LLM call, no provider key, no Playground. Three sentinels
 * cover the template's three field serializations:
 *   string — system_prompt = "PERSIST_PROBE <nonce>" (per-run nonce);
 *   int    — max_iterations = 7 (non-default);
 *   bool   — add_current_date_tool flipped true → false (pre-flip state
 *            asserted, so the flip is a proven write, not a default).
 *
 * Both persistence halves are asserted: the flows API after save settles
 * (saved), and the node body after a full home-navigation reopen
 * (re-rendered). See the spec doc for the false-positive guards.
 *
 * dev49: the old Controls dialog (edit-button-modal) is gone. max_iterations
 * and add_current_date_tool are advanced fields exposed on the node body via
 * the inspector side-panel (select node → parameters-button → inspector-add
 * → inspection-panel-close); system_prompt is on the body by default. Body
 * inputs accept fill() (the controlled-dialog typing quirk left with the
 * modal). The inspector-added fields persist on the body across reload, so
 * the reopened assert reads them directly.
 */

const MAX_ITERATIONS_SENTINEL = "7";

// Expose the given advanced Agent fields on the node body in ONE inspector
// session, then close. Doing all the adds before touching any value keeps the
// add-autosave (debounced PATCH) from re-rendering the node mid-edit and
// detaching a field being filled (waitForFlowSaveSettled's documented race).
async function addAgentFieldsToBody(page: Page, fields: string[]): Promise<void> {
  await page.locator('[data-testid^="rf__node-Agent"]').first().click();
  await openAdvancedOptions(page);
  for (const field of fields) {
    await page.getByTestId(`inspector-add-${field}`).click();
  }
  await closeAdvancedOptions(page);
}

// Fetch the flow by the id captured at template instantiation (the canvas URL
// id is transient on 1.11) and return its Agent node's template. Resolving by
// id — instead of scanning the whole flows list — keeps the assert immune to
// flows created by other specs or parallel workers (#553).
async function getPersistedAgentTemplate(
  request: APIRequestContext,
  flowId: string,
): Promise<any> {
  const bearer = await getAuthToken(request);
  const res = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: bearer },
  });
  expect(res.status()).toBe(200);
  const flow = await res.json();
  const agentNodes = (flow.data?.nodes ?? []).filter(
    (n: any) => n.data?.type === "Agent",
  );
  expect(agentNodes.length, "the template flow must have exactly one Agent node").toBe(1);
  return agentNodes[0].data.node.template;
}

test.describe.configure({ mode: "serial" });

let createdFlowId: string | null = null;

// Delete only the flow this test created (by id) — a broad cleanup here
// would kill parallel workers' in-flight flows (#553).
test.afterEach(async ({ page }) => {
  if (createdFlowId) {
    // `deleteFlow` rather than a raw DELETE: it absorbs 404-as-done and one
    // transient 5xx, surfaces a real failure instead of silence, and -- the
    // reason this spec was migrated -- it is where token attribution happens,
    // immediately before the DELETE that 404s the trace (§3.1).
    try {
      await deleteFlow(page.request, createdFlowId);
    } catch {
      // Deliberately silent, matching the `.catch(() => {})` this replaces.
    }
    createdFlowId = null;
  }
});

test(
  "Agent settings survive save and reopen",
  { tag: ["@stable", "@regression", "@agents", "@workspace"] },
  async ({ page, request }) => {
    const nonce = `PERSIST_PROBE_${Date.now()}`;
    let flowId = "";

    await test.step("load the Simple Agent template (no provider setup — model-free)", async () => {
      flowId = await loadTemplateByName(page, "Simple Agent");
      createdFlowId = flowId;
      // Fit the canvas so the Agent node (loaded outside the initial viewport)
      // mounts its body fields — SimpleAgentTemplatePage does this for the
      // sibling agent specs; this model-free spec must do it itself.
      await adjustScreenView(page);
      // The template load + fit-view schedule a debounced autosave PATCH.
      // Editing before it lands lets its response re-render the node from
      // server state and revert the edit — settle it FIRST (the sibling specs
      // get this settle from provider setup, which this spec skips).
      await waitForFlowSaveSettled(page);
    });

    await test.step("expose the two advanced fields on the node body", async () => {
      // Add both advanced fields in one inspector session, then let the
      // add-autosave settle BEFORE editing any value — otherwise the PATCH
      // response detaches the just-filled field mid-edit.
      await addAgentFieldsToBody(page, ["max_iterations", "add_current_date_tool"]);
      await waitForFlowSaveSettled(page);
    });

    await test.step("set string, int and bool sentinels on the node body", async () => {
      // system_prompt is on the body by default. Clear + type (never fill()):
      // the node-level textarea is a controlled input that fill() sets in the
      // DOM without marking the node dirty, so the edit never autosaves and is
      // reverted on the next re-render (0/5 persisted historically). Real
      // keystrokes commit it.
      const prompt = page.locator(
        '[data-testid^="rf__node-Agent"] [data-testid="textarea_str_system_prompt"]',
      );
      await expect(prompt).toBeVisible({ timeout: 15000 });
      await prompt.scrollIntoViewIfNeeded();
      await prompt.click();
      await page.keyboard.press("ControlOrMeta+a");
      await page.keyboard.press("Backspace");
      await prompt.pressSequentially(nonce, { delay: 20 });
      await expect(prompt).toHaveValue(nonce, { timeout: 5000 });
      await prompt.blur();
      await waitForFlowSaveSettled(page);

      // max_iterations (int) — body int fields accept fill() + blur.
      const maxIter = page.getByTestId("int_int_max_iterations");
      await expect(maxIter).toBeVisible({ timeout: 15000 });
      await maxIter.scrollIntoViewIfNeeded();
      await maxIter.fill(MAX_ITERATIONS_SENTINEL);
      await expect(maxIter).toHaveValue(MAX_ITERATIONS_SENTINEL, { timeout: 5000 });
      await maxIter.blur();
      await waitForFlowSaveSettled(page);

      // add_current_date_tool (bool) — assert the pre-flip default so the flip
      // is a proven WRITE (a changed template default fails loudly instead of
      // silently inverting the sentinel).
      const toggle = page.getByTestId("toggle_bool_add_current_date_tool");
      await expect(toggle).toBeVisible({ timeout: 15000 });
      await toggle.scrollIntoViewIfNeeded();
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await waitForFlowSaveSettled(page);
    });

    await test.step("saved: the flows API shows all three sentinels", async () => {
      await expect
        .poll(
          async () => {
            const t = await getPersistedAgentTemplate(request, flowId);
            return {
              system_prompt: t.system_prompt?.value,
              max_iterations: t.max_iterations?.value,
              add_current_date_tool: t.add_current_date_tool?.value,
            };
          },
          { timeout: 15000 },
        )
        .toEqual({
          system_prompt: nonce,
          max_iterations: Number(MAX_ITERATIONS_SENTINEL),
          add_current_date_tool: false,
        });
    });

    await test.step("reopen the flow from the home page", async () => {
      await page.goto("/");
      await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });
      // The /flows a11y refactor (Langflow #13891) makes the card content
      // pointer-events-none; open the flow via the card's overlay button.
      await page
        .getByTestId("list-card")
        .filter({ has: page.getByTestId(`flow-name-${flowId}`) })
        .getByTestId("list-card-open-button")
        .first()
        .click();
      await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
        timeout: 30000,
      });
      await adjustScreenView(page);
    });

    await test.step("reopened: node body renders the exact sentinels", async () => {
      // The inspector-added fields persist on the body across reload — read
      // them directly (no inspector re-open needed).
      await expect(
        page.locator(
          '[data-testid^="rf__node-Agent"] [data-testid="textarea_str_system_prompt"]',
        ),
      ).toHaveValue(nonce, { timeout: 10000 });
      await expect(page.getByTestId("int_int_max_iterations")).toHaveValue(
        MAX_ITERATIONS_SENTINEL,
      );
      await expect(
        page.getByTestId("toggle_bool_add_current_date_tool"),
      ).toHaveAttribute("aria-checked", "false");
    });
  },
);
