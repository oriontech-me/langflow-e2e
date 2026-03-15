import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

async function addChatOutputAndShowToolbar(page: any) {
  await awaitBootstrapTest(page);

  await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
  await page.getByTestId("blank-flow").click();

  // Add a ChatOutput component
  await page.getByTestId("sidebar-search-input").fill("chat output");
  await page.waitForSelector('[data-testid="input_outputChat Output"]', {
    timeout: 30000,
  });
  await page
    .getByTestId("input_outputChat Output")
    .hover()
    .then(async () => {
      await page.getByTestId("add-component-button-chat-output").click();
    });

  await adjustScreenView(page);

  await expect(page.locator(".react-flow__node")).toHaveCount(1, {
    timeout: 10000,
  });

  // Click the node to select it and show the toolbar
  await page.locator(".react-flow__node").first().click();
  await page.waitForTimeout(400);

  // Wait for the Freeze button to appear in the toolbar
  await page.waitForSelector('[data-testid="freeze-all-button-modal"]', {
    timeout: 8000,
  });
}

// Helper: check if freeze button has the active (blue) style
async function isFreezeButtonActive(page: any): Promise<boolean> {
  const cls = await page
    .locator('[data-testid="freeze-all-button-modal"]')
    .first()
    .getAttribute("class");
  return cls?.includes("text-blue-500") ?? false;
}

test(
  "frozen component shows frozen indicator, clicking again unfreezes it",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addChatOutputAndShowToolbar(page);

    // Initially the freeze button should NOT be active (blue)
    const initiallyFrozen = await isFreezeButtonActive(page);
    expect(initiallyFrozen).toBe(false);

    // Click the Freeze button directly in the toolbar
    await page.getByTestId("freeze-all-button-modal").first().click();
    await page.waitForTimeout(1500);

    // After freezing, the Freeze button should become blue/active
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(400);
    await page.waitForSelector('[data-testid="freeze-all-button-modal"]', {
      timeout: 5000,
    });

    const frozenState = await isFreezeButtonActive(page);
    expect(
      frozenState,
      "Freeze button should be active (blue) after freezing",
    ).toBe(true);

    // Click Freeze again to unfreeze
    await page.getByTestId("freeze-all-button-modal").first().click();
    await page.waitForTimeout(1500);

    // Re-select node to show toolbar
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(400);
    await page.waitForSelector('[data-testid="freeze-all-button-modal"]', {
      timeout: 5000,
    });

    const unfrozenState = await isFreezeButtonActive(page);
    expect(
      unfrozenState,
      "Freeze button should not be active after unfreezing",
    ).toBe(false);
  },
);

test(
  "freeze button toggles on each click",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addChatOutputAndShowToolbar(page);

    const clickFreeze = async () => {
      // Click node to select and show toolbar
      await page.locator(".react-flow__node").first().click();
      await page.waitForTimeout(400);
      await page.waitForSelector('[data-testid="freeze-all-button-modal"]', {
        timeout: 8000,
      });
      await page.getByTestId("freeze-all-button-modal").first().click();
      await page.waitForTimeout(1500);
    };

    // First click: freeze
    await clickFreeze();

    // Re-select to check button state
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(400);
    await page.waitForSelector('[data-testid="freeze-all-button-modal"]', {
      timeout: 5000,
    });
    const frozenState = await isFreezeButtonActive(page);
    expect(frozenState, "Freeze button should be active after first click").toBe(
      true,
    );

    // Second click: unfreeze
    await clickFreeze();

    // Re-select to check button state
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(400);
    await page.waitForSelector('[data-testid="freeze-all-button-modal"]', {
      timeout: 5000,
    });
    const unfrozenState = await isFreezeButtonActive(page);
    expect(
      unfrozenState,
      "Freeze button should not be active after second click",
    ).toBe(false);
  },
);

test(
  "frozen component can still be selected",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await addChatOutputAndShowToolbar(page);

    // Click the Freeze button
    await page.getByTestId("freeze-all-button-modal").first().click();
    await page.waitForTimeout(1500);

    // Click somewhere empty to deselect
    await page.locator('//*[@id="react-flow-id"]').click({
      position: { x: 50, y: 400 },
    });
    await page.waitForTimeout(300);

    // Click on the frozen node — it should become selected
    await page.locator(".react-flow__node").first().click();
    await page.waitForTimeout(300);

    // The node must have the selected class after clicking
    await expect(
      page.locator(".react-flow__node.selected").first(),
    ).toBeVisible({ timeout: 5000 });
  },
);
