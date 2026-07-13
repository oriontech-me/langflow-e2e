import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Settings > Model Providers page actions (QA-CHECKLIST §7.5 "Available
// provider count" + key validation). Hardened for @stable (issue #505): the
// previous version carried `expect(x || true).toBe(true)` dead assertions and
// clicked the FIRST provider (risking the environment's real key). The
// invalid-key test now targets OpenRouter (never configured) and asserts the
// backend actually rejected the key — scouted live: a fake key creates no
// global variable and no "N models" badge.

const MIN_PROVIDER_COUNT = 8;

async function openModelProviders(page: any): Promise<void> {
  await awaitBootstrapTest(page, { skipModal: true });
  await navigateSettingsPages(page, "Settings", "Model Providers");
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 10000 },
  );
}

test.describe("Model Provider Modal Actions", () => {
  // @stable removed by daily triage #704 — provider count assertion fails
  // deterministically (hardcoded 8, live catalog now 9 on 1.11.0.dev41).
  // Restore once reconciled — see #721.
  test(
    "page opens with its description and the available provider count",
    { tag: ["@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await openModelProviders(page);

      await expect(
        page.getByText("Configure AI model providers and manage their API keys."),
      ).toBeVisible({ timeout: 10000 });

      // §7.5 "Available provider count" — the unified catalog ships 8
      // providers on 1.11; fewer means the list regressed.
      await expect(
        page.locator('[data-testid^="provider-item-"]'),
      ).toHaveCount(MIN_PROVIDER_COUNT, { timeout: 10000 });
    },
  );

  test(
    "an invalid API key is rejected and does not enable the provider",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page, request }) => {
      await openModelProviders(page);

      await page.getByTestId("provider-item-OpenRouter").click();
      const keyInput = page.getByTestId("provider-variable-input-OPENROUTER_API_KEY");
      await expect(keyInput).toBeVisible({ timeout: 10000 });

      await keyInput.fill(`sk-or-invalid-${Date.now()}`);
      await page.getByRole("button", { name: "Save", exact: true }).click();

      // Save validates the key against the provider's API (a real 1-token
      // call) and rejects it. Give the round-trip time to settle, then assert
      // the provider did NOT become configured.
      await page.waitForTimeout(5000);

      // The list item never gains the "N models" configured badge.
      await expect(page.getByTestId("provider-item-OpenRouter")).not.toContainText(
        /\d+\s*models/,
        { timeout: 10000 },
      );

      // And the backend stored no credential for it.
      const bearer = await getAuthToken(request);
      const vars = await request
        .get("/api/v1/variables/", { headers: { Authorization: bearer } })
        .then((r) => r.json());
      const created = (Array.isArray(vars) ? vars : []).some(
        (v: { name?: string }) => v.name === "OPENROUTER_API_KEY",
      );
      expect(created, "rejected key must not create a global variable").toBe(false);
    },
  );

  test(
    "selecting another provider switches the visible detail panel",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await openModelProviders(page);

      await page.getByTestId("provider-item-OpenRouter").click();
      await expect(
        page.getByTestId("provider-variable-input-OPENROUTER_API_KEY"),
      ).toBeVisible({ timeout: 10000 });

      // The detail area is an accordion — selecting Anthropic must render its
      // own key input and drop OpenRouter's.
      await page.getByTestId("provider-item-Anthropic").click();
      await expect(
        page.getByTestId("provider-variable-input-ANTHROPIC_API_KEY"),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.getByTestId("provider-variable-input-OPENROUTER_API_KEY"),
      ).toBeHidden({ timeout: 10000 });
    },
  );
});
