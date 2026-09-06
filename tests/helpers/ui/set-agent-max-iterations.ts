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
 * What the read-back does NOT prove is that the value SURVIVED. `toHaveValue` is
 * a poll that returns on the first matching sample, and nothing settles between
 * the add and the fill here — so an add-autosave PATCH response landing after it
 * can still re-render the node at the template default, with the assertion
 * already green. `agent-config-persistence.spec.ts` documents that window and
 * settles for it. Closing it here is #1739, deliberately not folded into #1380:
 * it changes the behaviour of an `@stable` daily spec and owes its own
 * force-fails.
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
