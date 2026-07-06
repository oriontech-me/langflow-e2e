import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Settings > Model Providers page (QA-CHECKLIST §7.5 "Manage Model Providers"
// modal). Hardened for @stable (issue #505): the previous version wrapped every
// assertion in `if (visible)` guards and passed when nothing rendered.

// The 8 providers shipped by the unified catalog on 1.11 — the list assertion
// pins each one so a provider silently dropping from the page fails loudly.
const KNOWN_PROVIDERS = [
  "Google Generative AI",
  "OpenAI",
  "Anthropic",
  "IBM WatsonX",
  "Ollama",
  "OpenAI Compatible",
  "OpenRouter",
  "vLLM",
];

async function openModelProviders(page: any): Promise<void> {
  await awaitBootstrapTest(page, { skipModal: true });
  await navigateSettingsPages(page, "Settings", "Model Providers");
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 10000 },
  );
}

test.describe("ModelProviderModal", () => {
  test(
    "provider list renders with the known providers",
    { tag: ["@stable", "@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      await openModelProviders(page);

      await expect(page.getByTestId("provider-list")).toBeVisible({ timeout: 10000 });
      for (const name of KNOWN_PROVIDERS) {
        await expect(page.getByTestId(`provider-item-${name}`)).toBeVisible({
          timeout: 10000,
        });
      }
    },
  );

  test(
    "selecting a provider opens its API key configuration detail",
    { tag: ["@stable", "@release", "@components", "@workspace", "@model-provider"] },
    async ({ page }) => {
      await openModelProviders(page);

      // OpenRouter is never configured in the test environments, so its detail
      // always renders the key input (a configured provider shows Replace).
      await page.getByTestId("provider-item-OpenRouter").click();
      await expect(
        page.getByTestId("provider-variable-input-OPENROUTER_API_KEY"),
      ).toBeVisible({ timeout: 10000 });
    },
  );

  test(
    "a configured provider shows its model selection panel",
    { tag: ["@stable", "@release", "@components", "@workspace", "@model-provider"] },
    async ({ page, request }) => {
      // OpenAI is the configured-provider reference: collect-models configures
      // it in both environments (local .env and the CI secret). Skip — with an
      // explicit reason, never silently — when the instance has no key stored.
      const bearer = await getAuthToken(request);
      const vars = await request
        .get("/api/v1/variables/", { headers: { Authorization: bearer } })
        .then((r) => r.json());
      const configured = (Array.isArray(vars) ? vars : []).some(
        (v: { name?: string }) => v.name === "OPENAI_API_KEY",
      );
      test.skip(
        !configured,
        "OPENAI_API_KEY not configured on this instance — run collect-models.spec.ts first",
      );

      await openModelProviders(page);
      await page.getByTestId("provider-item-OpenAI").click();

      await expect(page.getByTestId("model-provider-selection")).toBeVisible({
        timeout: 10000,
      });
      // Model toggles render only for an authenticated provider — at least one
      // must be present (":visible" excludes the collapsed deprecated section).
      await expect(
        page.locator('[data-testid^="llm-toggle"]:visible').first(),
      ).toBeVisible({ timeout: 15000 });
    },
  );
});
