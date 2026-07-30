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
// then asserted only a node COUNT: one extra focusable element upstream would
// have moved Space onto another control with the test still green. Here the Tab
// walk stops on the expected testid and each added node is asserted by TYPE. The
// inherited version also opened a blank flow through the UI and never deleted it.

// The result card is the observable of the FILTER, not a focus target: on the
// 1.12 line it carries no tabIndex. The keyboard affordance is the per-result
// "Add <name> to canvas" button, the same handle the rest of the suite uses to
// add from the sidebar (helpers/flows/add-component-from-sidebar.ts). See the
// spec doc -> "The keyboard affordance moved (upstream, 1.12 line) — #1124".
const CHAT_INPUT_CARD = "input_output_chat input_draggable";
const CHAT_INPUT_ADD = "add-component-button-chat-input";
const CHAT_OUTPUT_ADD = "add-component-button-chat-output";
// A component that must not survive the "chat" query.
const NON_MATCHING_CARD = "models_and_agentsPrompt Template";
// Bounded Tab walk: the live order needs 3 presses (sidebar-options-trigger ->
// disclosure-<category> -> the add button), so this only runs out when the
// component is unreachable by keyboard — which is the failure being tested.
const MAX_TAB_PRESSES = 10;

/** The `data-testid` of the currently focused element, if it has one. */
async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null,
  );
}

/**
 * Diagnostic for the way this walk is most likely to break again: an image that
 * predates the 1.12 a11y change, where the result CARD wrapper is the tab stop
 * and the add button is out of the tab order (#1124). The nightly image is built
 * from a release branch (`release-1.12.0` at the time of writing) while upstream
 * `main` still carries the old shape, so the pin moving to a branch cut from
 * `main` is enough to bring the old DOM back — with the exact failure signature
 * of #1124. Naming it in the error saves triage from re-deriving it.
 *
 * Returns "" on a build that has the change, so a genuine keyboard regression
 * reads as one.
 */
async function legacyTabStopHint(page: Page): Promise<string> {
  const legacyTabStops = await page
    .locator('[data-testid$="_draggable"][tabindex="0"]')
    .count();

  return legacyTabStops > 0
    ? ` — the result card wrapper is the tab stop and the add button is not: ` +
        `this build predates the 1.12 a11y change (#1124), not a regression.`
    : "";
}

/** Presses Tab until `testId` holds focus; fails if it never does. */
async function tabUntilFocused(page: Page, testId: string): Promise<number> {
  for (let presses = 1; presses <= MAX_TAB_PRESSES; presses++) {
    await page.keyboard.press("Tab");
    if ((await focusedTestId(page)) === testId) return presses;
  }
  throw new Error(
    `"${testId}" never received focus within ${MAX_TAB_PRESSES} Tab presses ` +
      `(last focused: ${await focusedTestId(page)})` +
      (await legacyTabStopHint(page)),
  );
}

/**
 * Presses `/` until the sidebar search holds focus.
 *
 * Bounded on purpose: a shortcut that is really unbound never focuses the field,
 * so the step still fails — the retry only absorbs a keypress lost to the race
 * between the canvas click and the hotkey under CI load (#1124, second symptom).
 * It never presses while the field already has focus: the hotkey does not fire
 * from form tags, so a second press would type "/" into it and defeat the
 * empty-value assertion that follows.
 */
async function focusSearchWithSlash(page: Page): Promise<void> {
  const search = page.getByTestId("sidebar-search-input");

  await expect(async () => {
    const alreadyFocused = await search.evaluate(
      (el) => el === document.activeElement,
    );
    if (!alreadyFocused) await page.keyboard.press("/");

    await expect(search).toBeFocused({ timeout: 2000 });
  }).toPass({ timeout: 20000, intervals: [250, 500, 1000, 2000] });
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
    { tag: ["@stable", "@workspace", "@ui-ux"] },
    async ({ page }) => {
      const search = page.getByTestId("sidebar-search-input");
      const nodes = page.locator(".react-flow__node");

      await test.step("'/' focuses the sidebar search from the canvas", async () => {
        await page
          .locator(".react-flow__pane")
          .click({ position: { x: 500, y: 350 } });

        await focusSearchWithSlash(page);

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
        await tabUntilFocused(page, CHAT_INPUT_ADD);
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
        // ChatInput is a singleton: now that one is on the canvas its entry is
        // disabled and stops rendering an add button, so this walk costs the
        // same number of presses the Chat Input one did.
        await tabUntilFocused(page, CHAT_OUTPUT_ADD);
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
