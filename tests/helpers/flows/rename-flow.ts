import { type Page, expect } from "@playwright/test";
import { pendingSaveQuietMs } from "./autosave-interval";
import { waitForFlowSaveSettled } from "./wait-for-flow-save-settled";
import { openFlowSettings } from "./open-flow-settings";

// Generous, load-tolerant timeout for the modal interactions. The previous
// hardcoded 3000ms waits were the fragile part flagged in issue #357: under
// nightly backend load the flow-settings modal re-renders when an in-flight
// autosave response lands, and 3s was not enough headroom for the inputs to
// stabilise or for `save-flow-settings` to become enabled.
//
// #1222 asked whether this should still be the same number as the header gate,
// now that the gate no longer lives inside `renameFlow`. **It should not, and it
// no longer is.** The permissions gate moved into `openFlowSettings` in #1215 and
// is now `PERMISSIONS_GATE_TIMEOUT_MS` (30 s, measured — see
// `permissions-gate.ts`); this budget covers the modal's INPUTS after it opened,
// which is what #357 sized it for. The two were only ever the same number because
// the gate inherited this one's value, and that provenance is exactly what made
// the divergence look principled. They are independent now, and this one stays at
// 15 s because nothing about the modal changed — lowering or raising it wants its
// own evidence, not this issue's.
const MODAL_TIMEOUT = 15000;

/**
 * The quiet window EVERY drain in this helper waits out, and why it is not the
 * helper's own default (#1902).
 *
 * `waitForFlowSaveSettled`'s 700 ms default arms IMMEDIATELY when nothing is in
 * flight, and the autosave an edit schedules is issued one full debounce later —
 * `GET /api/v1/config.auto_saving_interval` answered 2000 on `1.13.0.dev15`
 * (#1741). So the default expires BEFORE the save these barriers exist to wait
 * out. That is not a theory here, it is this file's own history: the second
 * barrier below was added precisely because the first kept returning early, with
 * the clobbering PATCH observed 183 ms after it on `1.12.0.dev7`. A save issued
 * just after a barrier resolved is what a scheduled save looks like from the
 * outside.
 *
 * `pendingSaveQuietMs()` is read from the instance under test and is the only
 * window that also closes a save still on the DEBOUNCE. It does not close one
 * upstream has DEFERRED into `pendingAutoSaveRef` while the permissions query is
 * loading — no window does, that helper's header has the mechanism, and this is
 * the helper where it is most live, since #1005 recorded the permissions query
 * re-entering `isLoading` on every save. A drain is not a proof of quiescence
 * here; it is the part of it that arithmetic can deliver.
 *
 * It is ONE rule for all four drains rather than a window per site: a mixed
 * regime is where the next gap opens, and one rule is a property
 * `rename-flow.test.ts` can state and guard, where "this site needs it and that
 * one does not" is an argument that has to be re-derived every time the file is
 * edited.
 *
 * Cost: ~+2.8 s per drain (~3500 ms against 700 ms). Count the drains per call,
 * because they are not uniform and an earlier version of this note halved one of
 * them: a `renameFlow({flowName})` pass is **4** (~+11.2 s) — the two in
 * `applyFlowSettings` plus the loop's and the arbiter's — a `renameFlow()`
 * no-edit reopen is **1** (~+2.8 s), since the second barrier is inside the
 * edited branch and the function returns before the loop, and a re-apply pass
 * adds **2** more. `edit-flow-name.spec.ts`, the heaviest caller, runs 2 names ×
 * (4 + 1) = 10 drains — measured on `1.13.0.dev15`, **20.8/21.1 s -> 50.4/50.4 s**,
 * 2 runs each side, which is the arithmetic and not a surprise. Know that number
 * before reading this as free. Against it: #357 and #995 are both a PATCH landing
 * inside this helper, each of which cost far more than seconds to diagnose, and
 * the 8 affected spec files together measured 2.3 m -> 4.1 m for 13 tests, i.e.
 * **+108 s** for one pass over all of them. What that is worth per daily shard
 * depends on how the partition lands them (`partition-shards.mjs`), so it is not
 * stated as a per-shard number here.
 */
export function renameDrainQuietMs(): number {
  return pendingSaveQuietMs();
}

// One re-apply is enough in practice: the clobbering autosave belongs to the
// editor's mount burst, which is long over by the time a second attempt runs.
// A third attempt costs ~15s and has never been observed to be needed.
const MAX_RENAME_ATTEMPTS = 2;

type RenameOptions = { flowName?: string; flowDescription?: string };
type RenameResult = { flowName: string; flowDescription: string };

/**
 * One pass through the flow-settings modal: open it from the header, optionally
 * edit name/description, save (or cancel when nothing changed).
 *
 * @returns the name/description present in the inputs *before* any edit.
 */
const applyFlowSettings = async (
  page: Page,
  { flowName, flowDescription }: RenameOptions,
): Promise<RenameResult> => {
  // Drain the editor's autosave before the modal opens, so no PATCH response
  // lands while it is up: that re-render detaches the dialog's inputs mid-edit
  // (#357) and, if it carries a pre-rename store, clobbers the rename (#995).
  // In flight AND merely scheduled — see `renameDrainQuietMs` (#1902).
  await waitForFlowSaveSettled(page, { quietMs: renameDrainQuietMs() });

  // Open the flow-settings popover from the header, through the shared opener.
  //
  // It asserts the header is present (absent ⇒ the editor never mounted, since it
  // renders only under `onFlowPage`), then drives the `menu_bar_display` BUTTON
  // once it reports enabled — never the `aria-hidden` `flow_name` span inside it.
  // Upstream disables that button for the whole time
  // `POST /api/v1/authz/me/permissions` is in flight, and a click on a span is
  // swallowed with no error in that window because a span is not a form control
  // (#1005). The logic was inline here after #1152; #1215 made it shared, because
  // six other call sites had the un-fixed version.
  //
  // The gate NARROWS this window, it does not close it, and the next triager
  // should not have to re-derive why. `PermissionsProvider` (mounted around the
  // app header in `DashboardWrapperPage`) keys its query on
  // `domain: project:{folder_id}` read off `currentFlow`, and `use-save-flow`
  // replaces that object via `setCurrentFlow(updatedFlow)` on every save — so a
  // response that changes or drops `folder_id` changes the query key, re-enters
  // `isLoading`, and re-disables the button. Landing between the assertion and the
  // click, the click is swallowed again and the failure surfaces at the
  // `input-flow-name` assertion instead. If that is ever observed, the fix is to
  // retry open→dialog-visible rather than to widen a timeout.
  //
  // A read-only flip landing AFTER the dialog opened is a second consequence:
  // `<Popover open={openSettings && !isReadOnly}>` tears it down, and remounting
  // `FlowSettingsComponent` re-runs its `useEffect` and resets `name` to the
  // flow's own — which is what the `toHaveValue` assertion below catches.
  await openFlowSettings(page);

  // Wait for the modal's name input to be present and interactable before
  // reading/editing it (avoids acting on a half-rendered dialog).
  const nameInput = page.getByTestId("input-flow-name");
  await expect(nameInput).toBeVisible({ timeout: MODAL_TIMEOUT });
  await expect(nameInput).toBeEnabled({ timeout: MODAL_TIMEOUT });

  const flowNameInput = await nameInput.inputValue();
  if (flowName) {
    await nameInput.fill(flowName);
    // Prove the edit actually registered before waiting on the save button.
    // `save-flow-settings` is `disabled={disableSave || isReadOnly}`, and
    // `disableSave` is recomputed from `flow.name !== name` — so a dialog that
    // remounted between the fill and here (see the read-only note above) has
    // silently reset `name`, and the save button then stays disabled for the
    // full budget with nothing in the failure naming the cause (#1005).
    await expect(nameInput).toHaveValue(flowName, { timeout: MODAL_TIMEOUT });
  }

  const descriptionInput = page.getByTestId("input-flow-description");
  // Guard the read symmetrically with the name input above: `inputValue()` does
  // not auto-wait, so reading mid-render would throw or return a stale value.
  await expect(descriptionInput).toBeVisible({ timeout: MODAL_TIMEOUT });
  const flowDescriptionInput = await descriptionInput.inputValue();
  if (flowDescription) {
    await descriptionInput.fill(flowDescription);
  }

  if (flowName || flowDescription) {
    const saveButton = page.getByTestId("save-flow-settings");
    await expect(saveButton).toBeEnabled({ timeout: MODAL_TIMEOUT });

    // Second barrier, immediately before the PATCH we are about to fire
    // (issue #995). The barrier at the top of the helper was not enough: the
    // editor's mount autosave is debounced, so under load it was routinely
    // *issued* after that barrier returned (observed 183 ms after it, natural
    // repro on 1.12.0.dev7) — which #1741 later named, that being exactly what a
    // scheduled save does to a window shorter than the debounce. With both
    // windows derived (#1902) the first barrier now covers that case, and this
    // one keeps its own job: with the modal already filled, so nothing else can
    // mutate the flow, it leaves only the click→request hop between the last
    // observed save and ours. Re-assert the filled value and the button
    // afterwards: a landing autosave re-renders the dialog.
    await waitForFlowSaveSettled(page, { quietMs: renameDrainQuietMs() });

    // Re-assert the CAUSE, not only its consequence (#1902 review). The
    // `toHaveValue` further up exists because a dialog that remounts resets
    // `name` in silence and `save-flow-settings` — `disabled={disableSave ||
    // isReadOnly}`, with `disableSave` recomputed from `flow.name !== name` —
    // then stays disabled for the full budget with nothing in the failure
    // naming the cause (#1005). Since #1902 this drain holds the modal open for
    // one autosave debounce plus slack instead of 700 ms, so the window in
    // which that remount can happen now sits BETWEEN that assertion and the
    // click: the attribution it buys was silently given back. It costs nothing
    // when the value holds, and when it does not it fails on the reset field
    // rather than on a button that has been disabled for 15 s.
    if (flowName) {
      await expect(nameInput).toHaveValue(flowName, { timeout: MODAL_TIMEOUT });
    }
    await expect(saveButton).toBeEnabled({ timeout: MODAL_TIMEOUT });
    await saveButton.click();

    // Confirm the save succeeded by asserting the modal closed. Upstream
    // `flowSettingsComponent.handleSubmit` only calls `close()` after the save
    // resolves (the error path leaves the dialog open), so the name input
    // disappearing is the deterministic success signal. Unlike the "Changes
    // saved successfully" toast it does not auto-dismiss (asserting a fading
    // toast races its own timeout), and unlike a bare sidebar check it cannot
    // pass while the modal still overlays the editor.
    await expect(nameInput).toBeHidden({ timeout: MODAL_TIMEOUT });

    // Editor is interactive again.
    await expect(page.getByTestId("sidebar-search-input")).toBeVisible({
      timeout: 30000,
    });
  } else {
    await expect(page.getByTestId("save-flow-settings")).toBeDisabled({
      timeout: MODAL_TIMEOUT,
    });
    const cancelButton = page.getByTestId("cancel-flow-settings");
    await expect(cancelButton).toBeEnabled({ timeout: MODAL_TIMEOUT });
    await cancelButton.click();
  }

  return {
    flowName: flowNameInput,
    flowDescription: flowDescriptionInput,
  };
};

/**
 * Opens the flow-settings modal from the flow header, optionally edits the
 * name and/or description, and saves (or cancels when nothing changed).
 *
 * Hardening (issue #357): every gate is a real auto-waiting assertion
 * (`expect(...).toBeVisible/toBeEnabled/toBeDisabled`) instead of the
 * non-waiting `locator.isVisible()/isEnabled()/isDisabled()` queries, whose
 * boolean results were discarded — they never actually waited. Before opening
 * the modal we also wait for the editor's autosave to settle
 * (`waitForFlowSaveSettled`, with the derived window — see
 * `renameDrainQuietMs`): a debounced `PATCH /api/v1/flows/{id}` whose response
 * lands while the modal is open re-renders the dialog, detaching
 * `input-flow-name` mid-click and briefly disabling `save-flow-settings` —
 * exactly the race that destabilised this helper.
 *
 * WHICH action scheduled that PATCH is a property of the build, and this header
 * used to name one that no longer does it: *"entering the editor fits the
 * viewport and schedules"* it. Measured on `1.13.0.dev15`, opening a flow issues
 * no PATCH at all and neither does a viewport change — only graph and node
 * mutations autosave (#1743). The caller's own edits before the rename are what
 * this barrier drains now; do not re-derive a precondition from the old claim.
 *
 * Hardening (issue #995): the same PATCH race has a second, worse outcome — an
 * UPSTREAM defect this helper can only work around. `PATCH /api/v1/flows/{id}`
 * has no version check and `use-save-flow.ts` applies whichever response lands
 * last (`setCurrentFlow(updatedFlow)` in the mutation's `onSuccess`), so an
 * autosave that overlaps the rename rewrites the flow with the PRE-rename name
 * in the store AND in the database. Confirmed live on 1.12.0.dev7: the header
 * reverts and `GET /api/v1/flows/` returns the old name.
 *
 * Two of the three variants are prevented by closing the save barrier twice
 * (before opening the modal, and again once it is interactive) — and by closing
 * it for long enough, which is the half #1902 repaired: at the helper's 700 ms
 * default both barriers expired before a save still sitting on a 2000 ms
 * debounce. The third is not
 * preventable from the test side: the clobbering autosave can be *issued after*
 * our own PATCH — observed 176 ms after it — built from a store that has not yet
 * received our response. For that one the rename is re-applied once, after the
 * trailing autosave burst has drained. The final assertion is unconditional, so
 * a rename that genuinely never persists still fails the caller.
 *
 * Hardening (issue #1005): the modal is opened through the `menu_bar_display`
 * BUTTON once it reports enabled, instead of clicking the aria-hidden
 * `flow_name` span inside it. Upstream disables that button for the whole time
 * the effective-permissions query is in flight, and a click on the span is
 * swallowed with no error in that window; the same flip landing *after* the
 * dialog opened unmounts it and resets the typed name. Both surfaced here as a
 * `save-flow-settings` that never enables.
 *
 * @returns the name/description present in the inputs *before* any edit.
 */
export const renameFlow = async (
  page: Page,
  { flowName, flowDescription }: RenameOptions = {},
): Promise<RenameResult> => {
  const previous = await applyFlowSettings(page, { flowName, flowDescription });

  if (!flowName) return previous;

  const header = page.getByTestId("flow_name");

  for (let attempt = 1; attempt < MAX_RENAME_ATTEMPTS; attempt++) {
    // Drain the trailing autosave burst before judging the header: the
    // clobbering PATCH lands up to ~350 ms after ours, so reading the header
    // straight after the modal closes would see the correct name and miss it.
    //
    // The ~350 ms is a measurement of a save already IN FLIGHT, which this
    // barrier does hold (#995). What it does not cover on its own is a save
    // still on the debounce — the window has to outlast that too, or the drain
    // returns, the header reads correct, and this loop skips the re-apply it
    // exists to perform (#1741/#1902).
    await waitForFlowSaveSettled(page, { quietMs: renameDrainQuietMs() });
    if ((await header.textContent())?.trim() === flowName) break;

    // Loud on purpose — a silent retry would hide how often the upstream race
    // fires, which is the only signal we have on it.
    console.warn(
      `[renameFlow] rename to "${flowName}" was reverted by a concurrent flow autosave ` +
        `(upstream PATCH race, issue #995) — re-applying (attempt ${attempt + 1}/${MAX_RENAME_ATTEMPTS})`,
    );
    try {
      await applyFlowSettings(page, { flowName, flowDescription });
    } catch (error) {
      // A re-apply can legitimately find nothing to change — if the flow
      // already holds the requested name, `save-flow-settings` stays disabled
      // and the pass throws. Swallow it: the unconditional assertion below is
      // the arbiter, so a rename that really never landed still fails loudly.
      console.warn(`[renameFlow] re-apply pass did not complete: ${error}`);
    }
  }

  // The arbiter, and the same window for the same reason: `toHaveText` passes on
  // the first matching tick, so a revert still sitting on the debounce would
  // land after this assertion had already succeeded (#1902).
  await waitForFlowSaveSettled(page, { quietMs: renameDrainQuietMs() });
  await expect(header).toHaveText(flowName, { timeout: 30000 });

  return previous;
};
