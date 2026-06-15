import { type Page, expect } from "@playwright/test";
import { waitForFlowSaveSettled } from "./wait-for-flow-save-settled";

// Generous, load-tolerant timeout for the modal interactions. The previous
// hardcoded 3000ms waits were the fragile part flagged in issue #357: under
// nightly backend load the flow-settings modal re-renders when an in-flight
// autosave response lands, and 3s was not enough headroom for the inputs to
// stabilise or for `save-flow-settings` to become enabled.
const MODAL_TIMEOUT = 15000;

/**
 * Opens the flow-settings modal from the flow header, optionally edits the
 * name and/or description, and saves (or cancels when nothing changed).
 *
 * Hardening (issue #357): every gate is now a real auto-waiting assertion
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
 * @returns the name/description present in the inputs *before* any edit.
 */
export const renameFlow = async (
  page: Page,
  {
    flowName,
    flowDescription,
  }: { flowName?: string; flowDescription?: string } = {},
) => {
  // Let any in-flight editor autosave settle so opening/saving the modal does
  // not race a PATCH that would re-render the dialog and detach its inputs.
  await waitForFlowSaveSettled(page);

  // Open the flow-settings modal from the header.
  await expect(page.getByTestId("flow_name")).toBeVisible({
    timeout: MODAL_TIMEOUT,
  });
  await page.getByTestId("flow_name").hover();
  await page.getByTestId("flow_name").click();

  // Wait for the modal's name input to be present and interactable before
  // reading/editing it (avoids acting on a half-rendered dialog).
  const nameInput = page.getByTestId("input-flow-name");
  await expect(nameInput).toBeVisible({ timeout: MODAL_TIMEOUT });
  await expect(nameInput).toBeEnabled({ timeout: MODAL_TIMEOUT });

  const flowNameInput = await nameInput.inputValue();
  if (flowName) {
    await nameInput.fill(flowName);
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

    if (flowName) {
      await page.waitForFunction(
        (expected) => {
          const header = document.querySelector('[data-testid="flow_name"]');
          return header && header.textContent?.trim() === expected;
        },
        flowName,
        { timeout: 30000 },
      );
    }
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
