import { type Page, expect } from "@playwright/test";
import { waitForFlowSaveSettled } from "./wait-for-flow-save-settled";

// Generous, load-tolerant timeout for the modal interactions. The previous
// hardcoded 3000ms waits were the fragile part flagged in issue #357: under
// nightly backend load the flow-settings modal re-renders when an in-flight
// autosave response lands, and 3s was not enough headroom for the inputs to
// stabilise or for `save-flow-settings` to become enabled.
const MODAL_TIMEOUT = 15000;

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
  // Let any in-flight editor autosave settle so opening/saving the modal does
  // not race a PATCH that would re-render the dialog and detach its inputs.
  await waitForFlowSaveSettled(page);

  // Open the flow-settings modal from the header. Assert the header first: it
  // renders only under `onFlowPage`, so its absence means the editor never
  // mounted — a caller that has not landed on the canvas yet, which is a very
  // different failure from the gate below (#1005).
  await expect(page.getByTestId("flow_name")).toBeVisible({
    timeout: MODAL_TIMEOUT,
  });

  // Drive the BUTTON, and only once write permission has RESOLVED. Upstream
  // renders the header as
  //   <button data-testid="menu_bar_display" disabled={isReadOnly}>
  //     <span aria-hidden data-testid="flow_name">…</span>
  // with `useIsFlowReadOnly = Boolean(flowId) && (isLoading || !can(flowId,"write"))`,
  // which fails CLOSED for the whole time `POST /api/v1/authz/me/permissions` is
  // in flight (deliberately, per its own docstring). Two consequences, both of
  // which cost this helper flakes:
  //  - Clicking the aria-hidden span does not exercise Playwright's disabled
  //    check — a span is not a form control — so a click landed in that window
  //    is swallowed by the browser with no error at all. Targeting the button
  //    makes the wait explicit AND puts the check back.
  //  - `<Popover open={openSettings && !isReadOnly}>` means a read-only flip
  //    AFTER the dialog opened tears it down; remounting `FlowSettingsComponent`
  //    re-runs its `useEffect` and resets `name` to the flow's own, leaving
  //    `save-flow-settings` disabled for the rest of the budget (#1005).
  // Same gate #1063/#1147 added for `useAddComponent`, which bails out silently
  // under the identical predicate.
  //
  // The gate NARROWS this window, it does not close it, and the next triager
  // should not have to re-derive why. `PermissionsProvider` (mounted around the
  // app header in `DashboardWrapperPage`) keys its query on
  // `domain: project:{folder_id}` read off `currentFlow`, and `use-save-flow`
  // replaces that object via `setCurrentFlow(updatedFlow)` on every save — so a
  // response that changes or drops `folder_id` changes the query key, re-enters
  // `isLoading`, and re-disables the button. Landing between the assertion and
  // the click below, the click is swallowed again and the failure surfaces at the
  // `input-flow-name` assertion instead. If that is ever observed, the fix is to
  // retry open→dialog-visible rather than to widen a timeout.
  const flowHeaderButton = page.getByTestId("menu_bar_display");
  await expect(flowHeaderButton).toBeEnabled({ timeout: MODAL_TIMEOUT });
  await flowHeaderButton.hover();
  await flowHeaderButton.click();

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
    // (issue #995). The barrier at the top of the helper is not enough: the
    // editor's mount autosave is debounced, so under load it is routinely
    // *issued* after that barrier returned (observed 183 ms after it, natural
    // repro on 1.12.0.dev7). Waiting here — with the modal already filled, so
    // nothing else can mutate the flow — leaves only the click→request hop
    // between the last observed save and ours. Re-assert the button afterwards:
    // a landing autosave re-renders the dialog.
    await waitForFlowSaveSettled(page);
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
 * (`waitForFlowSaveSettled`): entering the editor fits the viewport and
 * schedules a debounced `PATCH /api/v1/flows/{id}`, and if that response lands
 * while the modal is open it re-renders the dialog, detaching `input-flow-name`
 * mid-click and briefly disabling `save-flow-settings` — exactly the race that
 * destabilised this helper.
 *
 * Hardening (issue #995): the same PATCH race has a second, worse outcome — an
 * UPSTREAM defect this helper can only work around. `PATCH /api/v1/flows/{id}`
 * has no version check and `use-save-flow.ts` applies whichever response lands
 * last (`setCurrentFlow(updatedFlow)` in the mutation's `onSuccess`), so an
 * autosave that overlaps the rename rewrites the flow with the PRE-rename name
 * in the store AND in the database. Confirmed live on 1.12.0.dev7: the header
 * reverts and `GET /api/v1/flows/` returns the old name.
 *
 * Two of the three variants are now prevented by closing the save barrier twice
 * (before opening the modal, and again once it is interactive). The third is not
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
    await waitForFlowSaveSettled(page);
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

  await waitForFlowSaveSettled(page);
  await expect(header).toHaveText(flowName, { timeout: 30000 });

  return previous;
};
