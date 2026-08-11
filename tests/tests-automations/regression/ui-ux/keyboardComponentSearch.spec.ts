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

// The result card wrapper is the observable of the FILTER, not a focus target:
// on the 1.12 line it carries no tabIndex. The keyboard affordance is the
// per-result ROW (`<category><Display Name>`) — a `role="button"` carrying
// tabIndex={0}, an aria-label "Add <name> to canvas" and the Enter/Space
// handler. It has moved twice on this line: card wrapper -> add button (#1124)
// -> row (#1384, upstream #14250, which put the "+" back at tabIndex={-1}). See
// the spec doc -> "The keyboard affordance has moved TWICE".
const CHAT_INPUT_CARD = "input_output_chat input_draggable";
const CHAT_INPUT_ROW = "input_outputChat Input";
const CHAT_OUTPUT_ROW = "input_outputChat Output";
// A component that must not survive the "chat" query.
const NON_MATCHING_CARD = "models_and_agentsPrompt Template";
// Bounded Tab walk: the live order needs 3 presses (sidebar-options-trigger ->
// disclosure-<category> -> the row), so this only runs out when the component is
// unreachable by keyboard — which is the failure being tested.
const MAX_TAB_PRESSES = 10;

/** The `data-testid` of the currently focused element, if it has one. */
async function focusedTestId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.getAttribute("data-testid") ?? null,
  );
}

/**
 * Diagnostic for the way this walk is most likely to break again: an image whose
 * sidebar predates the CURRENT tab-stop shape. The nightly image is built from a
 * release branch (`release-1.12.0` at the time of writing) while upstream `main`
 * lags it, so the pin moving to a branch cut from `main` is enough to bring an
 * older DOM back. Both older shapes are named, because they fail identically
 * (the walk runs out of presses) and are repaired differently.
 *
 * Returns "" on a build that has the current shape, so a genuine keyboard
 * regression reads as one.
 */
async function legacyTabStopHint(page: Page): Promise<string> {
  const cardWrapperTabStops = await page
    .locator('[data-testid$="_draggable"][tabindex="0"]')
    .count();
  if (cardWrapperTabStops > 0) {
    return (
      ` — the result card wrapper is the tab stop and neither the row nor the ` +
      `add button is: this build predates the 1.12 a11y change (#1124), not a ` +
      `regression.`
    );
  }

  // Pre-#14250 (nightly dev10..dev21): the "+" button was the tab stop and the
  // row was not. `tabindex="-1"` is what #14250 put back on the button, so a
  // button WITHOUT it is the older shape.
  const focusableAddButtons = await page
    .locator('[data-testid^="add-component-button-"]:not([tabindex="-1"])')
    .count();
  return focusableAddButtons > 0
    ? ` — the add button is the tab stop and the row is not: this build ` +
        `predates upstream #14250 (#1384), not a regression.`
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
        await tabUntilFocused(page, CHAT_INPUT_ROW);

        // The row is a div, so "it took focus" alone would also be satisfied by
        // an inert wrapper that happens to be tabbable. `role="button"` is what
        // makes the tab stop an operable control (and it is not an i18n string,
        // unlike the aria-label the row also carries).
        await expect(page.getByTestId(CHAT_INPUT_ROW)).toHaveAttribute(
          "role",
          "button",
        );

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
        // disabled and stops rendering its add button — but since #14250 the ROW
        // keeps tabIndex={0} even when disabled (only its key handler
        // early-returns), so it still costs a press and this walk needs one MORE
        // than the Chat Input one did. Bounded by testid, not by press count,
        // precisely so that asymmetry costs nothing.
        await tabUntilFocused(page, CHAT_OUTPUT_ROW);
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
