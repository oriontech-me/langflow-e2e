import { type Page, expect } from "@playwright/test";
import {
  closeAdvancedOptions,
  openAdvancedOptions,
} from "./open-advanced-options";

/**
 * Set the Agent node's `max_iterations` cap and read the value back.
 *
 * dev49: `max_iterations` is an ADVANCED field — it is not on the node body by
 * default, so it cannot simply be filled. Expose it via the node inspector
 * (select the Agent node → `parameters-button` → `inspector-add-max_iterations`
 * → `inspection-panel-close`), which replaced the old Controls dialog /
 * edit-button-modal, then fill it on the body. That sequence is the reason this
 * helper looks the way it does.
 *
 * The `toHaveValue` check at the end is part of the contract, not a courtesy: a
 * fill that silently no-ops leaves the template default (15) in place. What that
 * costs is NOT the same on both sides, and reading it as one thing gets one of
 * them wrong. In `agent-multi-tool-selection` the cap is the only bound on an
 * open-ended sequence, so a no-op fill is a run that still looks green while
 * re-opening the #1378 context blow-up. In `agent-max-iterations` it is not a
 * false green — Test 1 goes red either way, because a default of 15 produces no
 * limit message — but it reds 30 s later on `toContainText`, blaming the missing
 * message. Here the read-back buys ATTRIBUTION: the run stops at the fill, on the
 * real cause.
 *
 * The add-then-fill sequence LOOKS racy and is not — measured rather than
 * argued, because the reasoning that says it is racy is sound and wrong (#1739,
 * on 1.13.0.dev4). Three facts, in the order they matter:
 *
 *   1. The add does schedule an autosave, and ON ITS OWN it carries the template
 *      default — proven from the intercepted payload (`max_iterations.value =
 *      15`) in an add-only run. In THIS sequence it never reaches the wire, and
 *      the reason is worth knowing before reasoning about a new call site: the
 *      autosave is a TRAILING debounce keyed on flow mutations (upstream
 *      `use-autosave-flow.ts`), so the fill cancels the add's pending timer and
 *      ONE coalesced PATCH goes out an interval later carrying the FILLED value.
 *      The interval is `GET /api/v1/config.auto_saving_interval` — 2000 ms on
 *      this image, and 1000 when `SimpleAgentTemplatePage.ts` measured the same
 *      mechanism — never the 300 ms `SAVE_DEBOUNCE_TIME` that
 *      `wait-for-flow-save-settled.ts` still quotes.
 *   2. Forcing the hostile ordering anyway — holding a stale add-PATCH response
 *      until after the fill and the read-back, which is what a slow runner would
 *      do — does NOT revert the field: 2 of 2 runs kept the filled value, in the
 *      node and in the database. The `setCurrentFlow` re-render that
 *      `agent-config-persistence.spec.ts` guards against does not reach this
 *      field on this build. Two forced runs on one dev build is not a proof for
 *      all time, and the exposure if it returns is asymmetric: this assertion
 *      samples BEFORE any such revert, and `agent-multi-tool-selection` asserts
 *      only the tool ORDER, so a cap that silently failed to apply would come
 *      back as #1378's context blow-up rather than as a red. Re-measure there
 *      before trusting this paragraph on a much newer nightly.
 *   3. The read-back therefore guards the right thing. The IN-EDITOR Playground
 *      run posts the CLIENT store's graph (`flowData: { nodes, edges }`, upstream
 *      `flowStore.ts`) as the request's `data`, which the v2 endpoint documents
 *      as taking priority over the saved flow — so the value this assertion reads
 *      IS the value the run executes. Persistence lags it by one debounce and is
 *      not what these two specs depend on. The exception is the shareable PUBLIC
 *      playground, whose schema forbids `data`: there the persisted flow runs and
 *      this whole argument inverts. Both specs use the in-editor playground.
 *
 * Do not add a settle between the add and the fill "to be safe": it cannot help
 * — `waitForFlowSaveSettled` arms a 700 ms quiet window and returns long before a
 * 2000 ms debounce fires (measured here at 701 ms having tracked no request at
 * all; `SimpleAgentTemplatePage.ts` and `general-bugs-save-changes-on-node.spec.ts`
 * measured the same thing independently) — and it would buy 700 ms per call for
 * nothing. That gap belongs to the barrier, not here: #1741.
 *
 * Deliberately not extended to cover `addAgentFieldsToBody` in
 * `agent-config-persistence.spec.ts`, which drives the same four handles. Merging
 * the two functions is ruled out on its merits: that spec adds SEVERAL fields in
 * one inspector session and must let the add-autosave settle BEFORE writing any
 * value, so its add and its fill are separate steps by design, and folding them
 * back together would re-introduce the mid-edit re-render that separation exists
 * to avoid. The option that IS viable — extract the add loop as its own helper
 * and build this one on top of it — was declined for scope, not for design: it
 * would pull a third `@stable` spec into #1380's blast radius, the same reason
 * #1378 left the duplication for #1380 in the first place.
 *
 * The value itself is the caller's decision. Only `agent-multi-tool-selection`'s
 * `MAX_ITERATIONS_SEQUENCE` is a MEASURED number, documented next to the
 * constant; `agent-max-iterations` derives both of its values from the cap
 * semantics instead, at the call site and next to `HIGH_LIMIT`.
 */
export async function setAgentMaxIterations(
  page: Page,
  maxIterations: string,
): Promise<void> {
  await page.locator('[data-testid^="rf__node-Agent"]').first().click();
  await openAdvancedOptions(page);
  await page.getByTestId("inspector-add-max_iterations").click();
  await closeAdvancedOptions(page);

  const maxIter = page.getByTestId("int_int_max_iterations");
  await expect(maxIter).toBeVisible({ timeout: 15000 });
  await maxIter.scrollIntoViewIfNeeded();
  await maxIter.fill(maxIterations);
  await maxIter.blur();
  await expect(maxIter).toHaveValue(maxIterations, { timeout: 10000 });
}
