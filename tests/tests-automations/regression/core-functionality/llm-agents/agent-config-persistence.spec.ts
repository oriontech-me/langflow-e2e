import type { Page } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { loadTemplateByName } from "../../../../helpers/flows/load-template-by-name";
import { hideInspectorPanel } from "../../../../helpers/ui/hide-inspector-panel";
import { waitForFlowSaveSettled } from "../../../../helpers/flows/wait-for-flow-save-settled";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

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
 * (saved), and the Controls dialog after a full home-navigation reopen
 * (re-rendered). See the spec doc for the false-positive guards.
 */

const MAX_ITERATIONS_SENTINEL = "7";

// The Controls dialog trigger (edit-button-modal) only renders with the node
// selected AND the Inspector Panel hidden.
async function openAgentControls(page: Page): Promise<void> {
  await hideInspectorPanel(page);
  await page.locator('[data-testid^="rf__node-Agent"]').first().click();
  const trigger = page.getByTestId("edit-button-modal");
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(page.getByTestId("int_int_edit_max_iterations")).toBeVisible({
    timeout: 15000,
  });
}

// Int fields reject fill() and swallow fast keystrokes (see
// agent-max-tokens.md): click, settle, clear, slow-type, verify the DOM.
async function setIntField(page: Page, testId: string, value: string): Promise<void> {
  const field = page.getByTestId(testId);
  await field.click();
  await page.waitForTimeout(600);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await field.pressSequentially(value, { delay: 150 });
  await expect(field).toHaveValue(value, { timeout: 5000 });
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
    await page.request.delete(`/api/v1/flows/${createdFlowId}`).catch(() => {});
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
    });

    await test.step("set string, int and bool sentinels in the Controls dialog", async () => {
      await openAgentControls(page);

      // The dialog's fields are controlled inputs that only register REAL
      // keystrokes: fill() sets the DOM value but the edit is silently
      // dropped on close (node-level fill+blur doesn't trigger autosave at
      // all on 1.11 — 0/5 runs persisted). Clear + type is the only path
      // that reliably commits the textarea.
      const prompt = page.getByTestId("textarea_str_edit_system_prompt");
      // Select-all fired before focus settles selects nothing and the typed
      // nonce lands IN FRONT of the default text — clear+type is retried
      // with a DOM verification between attempts (same family as the int
      // field's swallowed-first-event quirk).
      for (let attempt = 0; attempt < 3; attempt++) {
        await prompt.click();
        await page.waitForTimeout(600);
        await page.keyboard.press("ControlOrMeta+a");
        await page.keyboard.press("Backspace");
        await prompt.pressSequentially(nonce, { delay: 20 });
        if ((await prompt.inputValue()) === nonce) break;
      }
      await expect(prompt).toHaveValue(nonce, { timeout: 5000 });
      await page.keyboard.press("Tab");
      await page.waitForTimeout(800);

      await setIntField(page, "int_int_edit_max_iterations", MAX_ITERATIONS_SENTINEL);

      // Assert the pre-flip default so the flip below is a proven WRITE — a
      // changed template default fails loudly here instead of silently
      // inverting the sentinel's meaning.
      const toggle = page.getByTestId("toggle_bool_edit_add_current_date_tool");
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");

      await page.waitForTimeout(800);
      await page.getByTestId("edit-button-close").click();
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
    });

    await test.step("reopened: node and Controls dialog render the exact sentinels", async () => {
      await openAgentControls(page);

      await expect(page.getByTestId("textarea_str_edit_system_prompt")).toHaveValue(
        nonce,
        { timeout: 10000 },
      );
      await expect(page.getByTestId("int_int_edit_max_iterations")).toHaveValue(
        MAX_ITERATIONS_SENTINEL,
      );
      await expect(
        page.getByTestId("toggle_bool_edit_add_current_date_tool"),
      ).toHaveAttribute("aria-checked", "false");
    });
  },
);
