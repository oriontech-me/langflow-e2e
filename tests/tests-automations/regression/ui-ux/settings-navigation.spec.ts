import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

test(
  "user can access Settings page from the profile menu",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@settings"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    // Navigate to Settings via profile menu
    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    // Settings page must load with the General section as default
    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });
    await expect(page.getByTestId("settings_menu_header")).toBeVisible();
  },
);

test(
  "Settings page shows all main sections in sidebar navigation",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@settings"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });

    // All main settings sections must be listed as navigation links in the sidebar
    await expect(page.getByRole("link", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Model Providers", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Shortcuts", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Messages", exact: true })).toBeVisible();
  },
);

test(
  "Settings Shortcuts section lists keyboard shortcuts",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@settings"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });

    // Navigate to Shortcuts section
    await page.getByText("Shortcuts", { exact: true }).click();
    await page.waitForTimeout(500);

    // Shortcuts header must appear
    await expect(page.getByTestId("settings_menu_header")).toContainText(
      "Shortcuts",
    );

    // The Shortcuts page renders an AG Grid (columns `display_name` /
    // `shortcut`), NOT an HTML table — `role="row"` includes the header row on
    // top of the data rows. The catalog (`defaultShortcuts`) has 27 entries on
    // the 1.12 nightly, so the grid must list at least that many bindings, and
    // every one of them must actually show a key combination. This is the
    // "documented shortcuts are all listed" half of §15.10; exercising the
    // bindings on canvas lives in `langflowShortcuts.spec.ts`.
    const shortcutCells = page.locator('[role="row"] [col-id="shortcut"]');
    await expect(shortcutCells.first()).toBeVisible({ timeout: 5000 });

    const shortcutTexts = await shortcutCells.allTextContents();
    // Drop the header cell ("Keyboard Shortcut") — only data rows carry bindings.
    const bindings = shortcutTexts.slice(1).map((t) => t.trim());
    expect(
      bindings.length,
      "Settings > Shortcuts must list the whole documented shortcut catalog",
    ).toBeGreaterThanOrEqual(27);
    expect(
      bindings.filter((b) => b.length === 0),
      "every documented shortcut must show a key combination",
    ).toEqual([]);
  },
);

test(
  "Settings Model Providers section loads with provider configuration",
  { tag: ["@stable", "@release", "@workspace", "@regression", "@settings"] },
  async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });

    await page.getByTestId("user-profile-settings").click();
    await page.getByTestId("menu_settings_button").click();

    await page.waitForSelector('[data-testid="settings_menu_header"]', {
      timeout: 10000,
    });

    // Navigate to Model Providers
    await page.getByText("Model Providers", { exact: true }).click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId("settings_menu_header").last()).toContainText(
      "Model Providers",
      { timeout: 5000 },
    );

    // Page should contain provider configuration description
    await expect(
      page.getByText(
        "Configure AI model providers and manage their API keys.",
      ),
    ).toBeVisible({ timeout: 5000 });
  },
);
