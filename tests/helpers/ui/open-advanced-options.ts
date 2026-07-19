import type { Page } from "@playwright/test";

// The nightly (~dev46) replaced the "Controls" edit modal with a node inspector
// side-panel. Selecting a node exposes a `parameters-button` in its toolbar that
// opens the panel; every input renders as `inspector-param-<field>` and gains an
// add-to-node toggle `inspector-add-<field>` (the modern equivalent of the old
// `show<field>` toggles). The panel closes via `inspection-panel-close`.
// Callers must select the target node before calling (unchanged contract). The
// `parameters-button` only mounts for the currently-selected node, so it is
// unique as long as the more-options dropdown is not open.
export const openAdvancedOptions = async (page: Page) => {
  await page.getByTestId("parameters-button").click();
};

export const closeAdvancedOptions = async (page: Page) => {
  await page.getByTestId("inspection-panel-close").click();
};

export const enableInspectPanel = async (page: Page) => {
  await page.getByTestId("canvas_controls_dropdown_help").click();
  if (
    !(await page
      .getByTestId("canvas_controls_dropdown_toggle_inspector-toggle")
      .isChecked())
  ) {
    await page.getByTestId("canvas_controls_dropdown_toggle_inspector").click();
  }
  await page
    .getByTestId("canvas_controls_dropdown_help")
    .click({ force: true });
};

export const disableInspectPanel = async (page: Page) => {
  await page.getByTestId("canvas_controls_dropdown_help").click();
  if (
    await page
      .getByTestId("canvas_controls_dropdown_toggle_inspector-toggle")
      .isChecked()
  ) {
    await page.getByTestId("canvas_controls_dropdown_toggle_inspector").click();
  }
  await page
    .getByTestId("canvas_controls_dropdown_help")
    .click({ force: true });
};
