import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// Verified testids from live UI inspection:
//   add button:      "add-component-button-prompt-template"
//   prompt area:     "promptarea_prompt_template"
//   modal open btn:  "button_open_prompt_modal"
//   run button:      "button_run_prompt template"
//   output handle:   "handle-prompt template-shownode-prompt-right"
//   dynamic handles: "handle-prompt template-shownode-{varname}-left"

test(
  "Prompt Template component is visible on canvas after adding",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Search and add Prompt Template
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("prompt");
    await page.waitForSelector(
      '[data-testid="add-component-button-prompt-template"]',
      { timeout: 30000 },
    );
    await page.getByTestId("add-component-button-prompt-template").click();

    await adjustScreenView(page);

    // Node must appear on canvas
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Output handle is visible (source side)
    await expect(
      page.getByTestId("handle-prompt template-shownode-prompt-right"),
    ).toBeVisible({ timeout: 5000 });
  },
);

test(
  "Prompt Template creates dynamic input ports for {variable} placeholders",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add Prompt Template
    await page.getByTestId("sidebar-search-input").click();
    await page.getByTestId("sidebar-search-input").fill("prompt");
    await page.waitForSelector(
      '[data-testid="add-component-button-prompt-template"]',
      { timeout: 30000 },
    );
    await page.getByTestId("add-component-button-prompt-template").click();

    await adjustScreenView(page);
    await expect(page.locator(".react-flow__node")).toHaveCount(1, {
      timeout: 10000,
    });

    // Count existing handles before adding variables
    const initialHandleCount = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();

    // Open the Prompt modal via the dedicated button
    await page.getByTestId("button_open_prompt_modal").click();

    // Wait for modal dialog to open
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    // Find the prompt textarea inside the modal
    const modalTextarea = page
      .locator('[role="dialog"]')
      .locator("textarea")
      .first();

    await expect(modalTextarea).toBeVisible({ timeout: 5000 });
    await modalTextarea.click();
    await page.keyboard.press("Control+a");
    await modalTextarea.fill("Hello {name}, your job is {profession}.");

    // Check the Check button or close the modal to apply changes
    const checkButton = page
      .locator('[role="dialog"]')
      .getByRole("button", { name: /check|save|apply|ok/i })
      .first();

    if (await checkButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await checkButton.click();
    } else {
      // Press Escape to close and apply
      await page.keyboard.press("Escape");
    }

    // Wait for canvas to re-render with new input ports
    await page.waitForTimeout(1500);

    // Dynamic input handles for {name} and {profession} must have appeared
    const newHandleCount = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();

    expect(newHandleCount).toBeGreaterThan(initialHandleCount);

    // Both variable port handles must be visible — one for {name} and one for {profession}
    await expect(
      page.getByTestId("handle-prompt template-shownode-name-left"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("handle-prompt template-shownode-profession-left"),
    ).toBeVisible({ timeout: 5000 });
  },
);
