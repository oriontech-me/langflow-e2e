import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

/**
 * §15.9 — Main menu actions.
 *
 * On 1.12.x the flow editor has no dedicated "menu bar" dropdown anymore — the
 * breadcrumb's `menu_bar_display` opens the Flow settings dialog — so the
 * application's main menu is the header account menu, whose items are named
 * `menu_*_button` upstream. `user_menu_button` is the real `<button>`;
 * `user-profile-settings` is the `div` wrapping it.
 *
 * The version row is the spec's distinctive observable: it must match
 * `GET /api/v1/version` exactly, so the menu cannot pass on a hardcoded or
 * stale string.
 *
 * Sibling coverage not duplicated here: `ui-ux/settings-navigation.spec.ts`
 * (§15.10, the Settings page structure — this spec only proves the menu → route
 * wiring) and `ui-ux/settings-theme-toggle.spec.ts` (§15.10, actually switching
 * theme). The theme buttons are asserted present and never clicked: the theme is
 * persisted per user, so toggling it here would mutate state shared with every
 * other spec on the instance. The external links are likewise asserted by
 * `href`/`target` and never opened, keeping the run offline and deterministic.
 *
 * No flow is created, so there is nothing to clean up.
 */

/** Every item the main menu must expose on 1.12.0.dev8. */
const MENU_ITEM_TESTIDS = [
  "menu_version_button",
  "menu_settings_button",
  "menu_docs_button",
  "menu_github_button",
  "menu_discord_button",
  "menu_twitter_button",
  "menu_light_button",
  "menu_dark_button",
  "menu_system_button",
];

/** External destinations, asserted by attribute instead of by navigation. */
const EXTERNAL_LINKS: Array<[string, string]> = [
  ["menu_docs_button", "https://docs.langflow.org"],
  ["menu_github_button", "https://github.com/langflow-ai/langflow"],
  ["menu_discord_button", "https://discord.com/invite/EqksyE2EX9"],
  ["menu_twitter_button", "https://x.com/langflow_ai"],
];

test.describe("App header — main menu", () => {
  test("the main menu lists every item, reports the running version and links out",
    { tag: ["@stable", "@release", "@mainpage", "@ui-ux", "@settings"] },
    async ({ page, request }) => {
      // skipModal keeps awaitBootstrapTest from opening the templates modal,
      // which would create a flow this spec has no reason to own.
      await awaitBootstrapTest(page, { skipModal: true });

      const menu = page.getByRole("menu");

      await test.step("Open the main menu from the header", async () => {
        await page.getByTestId("user_menu_button").click();
        await expect(menu).toBeVisible({ timeout: 10000 });
        await expect(menu).toHaveAttribute("data-state", "open");
      });

      await test.step("Every documented item is present", async () => {
        for (const testId of MENU_ITEM_TESTIDS) {
          await expect(menu.getByTestId(testId)).toBeVisible({
            timeout: 10000,
          });
        }
      });

      await test.step("The version row matches GET /api/v1/version", async () => {
        const response = await request.get("/api/v1/version");
        expect(response.status()).toBe(200);
        const { version } = await response.json();
        expect(version, "the version endpoint must report a version").toBeTruthy();

        // The label span carries only "Version"; the value lives in its sibling
        // div, so the assertion targets the row that wraps both. The freshness
        // suffix ("(latest)") is not asserted — it depends on Langflow reaching
        // GitHub's release feed from the test host.
        const versionRow = menu.getByTestId("menu_version_button").locator("..");
        await expect(versionRow).toContainText(version, { timeout: 10000 });
      });

      await test.step("Each external item points at its documented URL", async () => {
        for (const [testId, href] of EXTERNAL_LINKS) {
          const anchor = menu
            .getByTestId(testId)
            .locator("xpath=ancestor::a[1]");
          await expect(anchor).toHaveAttribute("href", href);
          await expect(anchor).toHaveAttribute("target", "_blank");
        }
      });

      await test.step("Escape closes the menu", async () => {
        await page.keyboard.press("Escape");
        await expect(menu).toHaveCount(0, { timeout: 10000 });
      });
    },
  );

  test("the main menu's Settings action navigates to the Settings page",
    { tag: ["@stable", "@release", "@mainpage", "@ui-ux", "@settings"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("Open the main menu and choose Settings", async () => {
        await page.getByTestId("user_menu_button").click();
        await expect(page.getByTestId("menu_settings_button")).toBeVisible({
          timeout: 10000,
        });
        await page.getByTestId("menu_settings_button").click();
      });

      await test.step("The Settings route rendered and the menu closed", async () => {
        // 1.12 lands on /settings/general; the regex keeps the assert alive if
        // upstream changes the default section.
        await expect(page).toHaveURL(/\/settings/, { timeout: 15000 });
        await expect(page.getByTestId("settings_menu_header")).toBeVisible({
          timeout: 15000,
        });
        await expect(page.getByRole("menu")).toHaveCount(0);
      });
    },
  );
});
