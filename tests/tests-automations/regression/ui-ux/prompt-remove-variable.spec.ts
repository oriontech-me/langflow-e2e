import { expect, test } from "../../../fixtures/fixtures";
import { adjustScreenView } from "../../../helpers/ui/adjust-screen-view";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "removing a variable from prompt removes its input handle",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

    // Add Prompt Template (exact pattern from working test)
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

    // Open modal and add {name} variable
    await page.getByTestId("button_open_prompt_modal").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const textarea = page
      .locator('[role="dialog"]')
      .locator("textarea")
      .first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.click();
    await page.keyboard.press("Control+a");
    await textarea.fill("Hello {name}!");

    // Save via Check & Save button
    await page.getByTestId("genericModalBtnSave").click();
    await page
      .waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // Verify {name} handle appeared
    const nameHandle = page.getByTestId(
      "handle-prompt template-shownode-name-left",
    );
    await expect(nameHandle).toBeVisible({ timeout: 5000 });

    const handleCountBefore = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();

    // Remove variable: open modal again and clear {name}
    await page.getByTestId("button_open_prompt_modal").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    // After saving, isEdit=false so preview is shown — click it to re-enter edit mode
    const preview = page.getByTestId("edit-prompt-sanitized");
    if (await preview.isVisible({ timeout: 2000 }).catch(() => false)) {
      await preview.click();
      await page.waitForTimeout(300);
    }

    const textarea2 = page
      .locator('[role="dialog"]')
      .locator("textarea")
      .first();
    await expect(textarea2).toBeVisible({ timeout: 5000 });
    await textarea2.click();
    await page.keyboard.press("Control+a");
    await textarea2.fill("Hello world!");

    await page.getByTestId("genericModalBtnSave").click();
    await page
      .waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // The {name} handle must disappear
    await expect(nameHandle).toHaveCount(0, { timeout: 5000 });

    const handleCountAfter = await page
      .locator('[data-testid*="handle-prompt template"]')
      .count();
    expect(handleCountAfter).toBeLessThan(handleCountBefore);
  },
);

test(
  "replacing a variable in prompt updates handles accordingly",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

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

    // Add two variables {name} and {role}
    await page.getByTestId("button_open_prompt_modal").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const textarea = page
      .locator('[role="dialog"]')
      .locator("textarea")
      .first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.click();
    await page.keyboard.press("Control+a");
    await textarea.fill("Hello {name}, you are {role}.");

    await page.getByTestId("genericModalBtnSave").click();
    await page
      .waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    await expect(
      page.getByTestId("handle-prompt template-shownode-name-left"),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("handle-prompt template-shownode-role-left"),
    ).toBeVisible({ timeout: 5000 });

    // Replace {role} with {title}
    await page.getByTestId("button_open_prompt_modal").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    // After saving, isEdit=false so preview is shown — click it to re-enter edit mode
    const preview2 = page.getByTestId("edit-prompt-sanitized");
    if (await preview2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await preview2.click();
      await page.waitForTimeout(300);
    }

    const textarea2 = page
      .locator('[role="dialog"]')
      .locator("textarea")
      .first();
    await expect(textarea2).toBeVisible({ timeout: 5000 });
    await textarea2.click();
    await page.keyboard.press("Control+a");
    await textarea2.fill("Hello {name}, you are {title}.");

    await page.getByTestId("genericModalBtnSave").click();
    await page
      .waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // {name} still exists
    await expect(
      page.getByTestId("handle-prompt template-shownode-name-left"),
    ).toBeVisible({ timeout: 5000 });

    // {role} must be gone
    await expect(
      page.getByTestId("handle-prompt template-shownode-role-left"),
    ).toHaveCount(0, { timeout: 5000 });

    // {title} must appear
    await expect(
      page.getByTestId("handle-prompt template-shownode-title-left"),
    ).toBeVisible({ timeout: 5000 });
  },
);

test(
  "clearing prompt text removes all dynamic variable handles",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    await page.waitForSelector('[data-testid="blank-flow"]', { timeout: 30000 });
    await page.getByTestId("blank-flow").click();

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

    // Set prompt with multiple variables
    await page.getByTestId("button_open_prompt_modal").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    const textarea = page
      .locator('[role="dialog"]')
      .locator("textarea")
      .first();
    await expect(textarea).toBeVisible({ timeout: 5000 });
    await textarea.click();
    await page.keyboard.press("Control+a");
    await textarea.fill("{a} and {b} and {c}");

    await page.getByTestId("genericModalBtnSave").click();
    await page
      .waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // Verify dynamic handles exist
    const handlesBefore = await page
      .locator(
        '[data-testid*="handle-prompt template-shownode"][data-testid$="-left"]',
      )
      .count();
    expect(handlesBefore).toBeGreaterThan(0);

    // Clear the prompt — open modal and set plain text
    await page.getByTestId("button_open_prompt_modal").click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });

    // After saving, isEdit=false so preview is shown — click it to re-enter edit mode
    const preview3 = page.getByTestId("edit-prompt-sanitized");
    if (await preview3.isVisible({ timeout: 2000 }).catch(() => false)) {
      await preview3.click();
      await page.waitForTimeout(300);
    }

    const textarea2 = page
      .locator('[role="dialog"]')
      .locator("textarea")
      .first();
    await expect(textarea2).toBeVisible({ timeout: 5000 });
    await textarea2.click();
    await page.keyboard.press("Control+a");
    await textarea2.fill("No variables here.");

    await page.getByTestId("genericModalBtnSave").click();
    await page
      .waitForSelector('[role="dialog"]', { state: "hidden", timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(1500);

    // All dynamic input handles must be gone
    const handlesAfter = await page
      .locator(
        '[data-testid*="handle-prompt template-shownode"][data-testid$="-left"]',
      )
      .count();
    expect(handlesAfter).toBe(0);
  },
);
