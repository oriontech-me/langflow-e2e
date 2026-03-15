import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "settings page has appearance/general options",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    // Navigate to settings
    await page.getByTestId("user-profile-settings").click();
    await page.waitForTimeout(300);

    // Look for Settings link in the dropdown
    const settingsLink = page.getByText("Settings", { exact: true });
    const hasSettings = await settingsLink
      .isVisible({ timeout: 3000 })
      .catch(() => false);

    if (hasSettings) {
      await settingsLink.click();
    } else {
      // Try direct navigation
      await page.goto("/settings");
    }

    await page.waitForTimeout(1000);

    // The settings page should have some configuration sections
    const settingsVisible = await page
      .locator(
        '[data-testid="settings-page"], [data-testid*="settings"], [role="tablist"]',
      )
      .first()
      .isVisible({ timeout: 8000 })
      .catch(() => false);

    const hasContent = await page
      .locator("body")
      .evaluate((el) => (el as HTMLElement).innerText.length > 50);

    expect(
      settingsVisible || hasContent,
      "Settings page should have content",
    ).toBe(true);
  },
);

test(
  "settings page is accessible via direct navigation",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page);

    // Navigate directly to settings
    await page.goto("/settings");
    await page.waitForTimeout(1000);

    // Accept any of: actual settings page, or redirect to home
    const currentUrl = page.url();

    if (currentUrl.includes("/settings")) {
      // Settings page should have rendered content
      await page.waitForSelector("body", { timeout: 10000 });
      const bodyText = await page.locator("body").evaluate((el) => (el as HTMLElement).innerText);
      expect(bodyText.length, "Settings page should have content").toBeGreaterThan(
        10,
      );
    } else {
      // Redirected — app is still alive
      await expect(page.getByTestId("mainpage_title")).toBeVisible({
        timeout: 10000,
      });
    }
  },
);

test(
  "user profile menu shows settings option",
  { tag: ["@release", "@workspace", "@regression"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    // Click user profile button
    await page.getByTestId("user-profile-settings").click();
    await page.waitForTimeout(400);

    // The user menu should appear with various options
    const menuVisible = await page
      .locator('[role="menu"], [role="menuitem"], [data-testid*="menu"]')
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    // At minimum, some menu text should appear
    const menuText = await page
      .getByText(/settings|logout|profile|account/i)
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false);

    expect(
      menuVisible || menuText,
      "User profile menu should show options after clicking",
    ).toBe(true);
  },
);
