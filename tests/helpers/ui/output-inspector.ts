import type { Locator, Page } from "@playwright/test";

/**
 * Locating a node's output inspector ("Component Output" modal), as one mechanism
 * (issues #2177 and #2210).
 *
 * The inspector used to be located as `page.locator('[role="dialog"]').last()`, i.e.
 * by POSITION. Two dialogs compete for that position. The inspector is one. The
 * other is the assistant onboarding tooltip ("Try the new Langflow Assistant!",
 * `assistant-onboarding-tooltip` in `CanvasControls.tsx`), a Radix popover that also
 * carries `role="dialog"` and mounts 10 s after the canvas does. When it mounts AFTER
 * the inspector opens, it becomes the last dialog, and the caller reads the promo
 * instead of the output. This was reproduced on 1.13.0.dev34 by forcing that order:
 * the positional read failed with the daily's exact message (`got: Try the new
 * Langflow Assistant!`). With the opposite order it passed, which is why the failure
 * was intermittent and why it was triaged twice as an agent problem.
 *
 * The inspector has an identity of its own, so it is selected by that instead. Its
 * header title carries `data-testid="<nodeId>-<outputName>-output-modal"`
 * (`outputModal/index.tsx`, present from `release-1.11.0` through `main`). The testid
 * marks the TITLE, not the dialog root, so the dialog is the one that CONTAINS it
 * (the pattern `loop-component.spec.ts` already used).
 *
 * Seeding `seedAssistantDiscovered` keeps the tooltip from mounting at all, and the
 * specs that read the inspector do that too. The two defences are independent on
 * purpose: the seed keeps the overlay off the canvas controls, and this locator
 * keeps the read correct if the seed ever stops suppressing it (a renamed storage
 * key, a new `role="dialog"` overlay the seed knows nothing about).
 */

/**
 * The internal output names this helper accepts: identifier characters only. The
 * name is interpolated into a CSS attribute selector, so a quote or a bracket would
 * produce a selector that matches nothing. That fails as a visibility timeout which
 * blames the product, not the call site, hence the throw.
 */
const OUTPUT_NAME = /^[A-Za-z0-9_]+$/;

/**
 * CSS selector for the inspector's header title.
 *
 * @param outputName The output's INTERNAL name (`Output(name=…)` in the component
 *   source, e.g. `structured_response`, `messages_text`), never its display name.
 *   Pass it whenever it is stable, because it also asserts that the inspector opened
 *   for THAT output. Omit it for components whose outputs are generated at runtime
 *   (the unified Operations component), where any open inspector is the right one.
 */
export function outputInspectorTitleSelector(outputName?: string): string {
  if (outputName === undefined) return '[data-testid$="-output-modal"]';
  if (!OUTPUT_NAME.test(outputName)) {
    throw new Error(
      `outputInspectorTitleSelector: "${outputName}" is not an internal output name ` +
        "(letters, digits and underscores only). Use the `name=` of the component's " +
        "Output, not its display name.",
    );
  }
  return `[data-testid$="-${outputName}-output-modal"]`;
}

/**
 * The open output inspector's dialog, found by its own header testid, never by
 * position. See the module comment for why `[role="dialog"].last()` is wrong.
 */
export function outputInspectorDialog(page: Page, outputName?: string): Locator {
  return page
    .getByRole("dialog")
    .filter({ has: page.locator(outputInspectorTitleSelector(outputName)) });
}
