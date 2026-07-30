import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";

// Keyboard-driven component search and add — QA-CHECKLIST §15.1
// "Keyboard search (keyboard shortcut)".
// Spec doc: docs/ui-ux/keyboardComponentSearch.md
//
// One journey: `/` focuses the sidebar search from the canvas, typing filters the
// tree, Tab walks into the results, and Space / Enter add the focused component.
//
// Rewritten from the inherited version, which pressed Tab three times blindly and
// then asserted only a node COUNT: the live focus order is
// sidebar-options-trigger -> disclosure-<category> -> first result card, so one
// extra focusable element upstream would have moved Space onto another control
// with the test still green. Here the Tab walk stops on the expected testid and
// each added node is asserted by TYPE. The inherited version also opened a blank
// flow through the UI and never deleted it.

// Focus targets in the filtered result list.
const CHAT_INPUT_CARD = "input_output_chat input_draggable";
const CHAT_OUTPUT_CARD = "input_output_chat output_draggable";
// A component that must not survive the "chat" query.
const NON_MATCHING_CARD = "models_and_agentsPrompt Template";
// Bounded Tab walk: the live order needs 3 presses, so this only runs out when
// the card is unreachable by keyboard — which is the failure being tested.
const MAX_TAB_PRESSES = 10;

/** The `data-testid` of the currently focused element, if it has one. */
async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null,
  );
}

/** Presses Tab until `testId` holds focus; fails if it never does. */
async function tabUntilFocused(page: Page, testId: string): Promise<number> {
  for (let presses = 1; presses <= MAX_TAB_PRESSES; presses++) {
    await page.keyboard.press("Tab");
    if ((await focusedTestId(page)) === testId) return presses;
  }
  throw new Error(
    `"${testId}" never received focus within ${MAX_TAB_PRESSES} Tab presses ` +
      `(last focused: ${await focusedTestId(page)})`,
  );
}

test.describe("ui-ux — keyboard component search", () => {
  let token: string;
  let flowId: string;

  test.beforeEach(async ({ page, request }) => {
    token = await getAuthToken(request);
    flowId = await createFlow(
      request,
      {
        name: `keyboard-search-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        description: "Empty canvas for the §15.1 keyboard-search test",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
      { headers: { Authorization: token } },
    );

    await page.goto(`/flow/${flowId}`);
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  });

  test.afterEach(async ({ page, request }) => {
    await page.goto("/").catch(() => {});
    await deleteFlow(request, flowId, { headers: { Authorization: token } });
  });

  test("user can search and add components using keyboard shortcuts",
    { tag: ["@workspace", "@ui-ux"] },
    async ({ page }) => {
      const search = page.getByTestId("sidebar-search-input");
      const nodes = page.locator(".react-flow__node");

      await test.step("'/' focuses the sidebar search from the canvas", async () => {
        await page
          .locator(".react-flow__pane")
          .click({ position: { x: 500, y: 350 } });

        await page.keyboard.press("/");

        await expect(search).toBeFocused({ timeout: 10000 });
        // The shortcut must not land in the field as text.
        await expect(search).toHaveValue("");
      });

      await test.step("typing filters the component tree", async () => {
        await page.keyboard.type("chat");

        await expect(page.getByTestId(CHAT_INPUT_CARD)).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByTestId(NON_MATCHING_CARD)).toBeHidden();
      });

      await test.step("Tab reaches the first result and Space adds it", async () => {
        await tabUntilFocused(page, CHAT_INPUT_CARD);
        await page.keyboard.press("Space");

        await expect(nodes).toHaveCount(1, { timeout: 15000 });
        // Identity, not just count: this is what proves the keyboard added the
        // FOCUSED component.
        await expect(nodes.first()).toHaveAttribute(
          "data-testid",
          /^rf__node-ChatInput-/,
        );
      });

      await test.step("Tab reaches the next result and Enter adds it", async () => {
        await search.click();
        await tabUntilFocused(page, CHAT_OUTPUT_CARD);
        await page.keyboard.press("Enter");

        await expect(nodes).toHaveCount(2, { timeout: 15000 });
        await expect(
          page.locator('[data-testid^="rf__node-ChatOutput-"]'),
        ).toHaveCount(1);
      });

      await test.step("Escape returns focus out of the search field", async () => {
        await search.click();
        await expect(search).toBeFocused();

        await page.keyboard.press("Escape");

        // Escape blurs the field on 1.12; it does NOT clear the query, so the
        // text is deliberately not asserted here.
        await expect(search).not.toBeFocused({ timeout: 10000 });
      });
    });
});
