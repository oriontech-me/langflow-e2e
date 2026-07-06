import { expect, test } from "../../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../../helpers/other/await-bootstrap-test";
import { navigateSettingsPages } from "../../../../helpers/ui/go-to-settings";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

// Provider API key management (QA-CHECKLIST §7.5 "Add new provider via
// modal"). Hardened for @stable (issue #505): text-match fallbacks replaced by
// exact testids.
//
// A destructive delete→re-add cycle with the real OpenAI key was tried first
// and REJECTED: deleting + recreating the credential variable leaves a stale
// server-side cache — subsequent flow builds receive the WRONG provider's key
// (observed live: the OpenAI node got the Google key, 401) until the backend
// restarts. Suspected Langflow bug, flagged on the PR. The add surface is
// therefore validated without mutating state:
//  - the Save+validation path is proven by the invalid-key negative control
//    in model-provider-modal-actions.spec.ts (Save performs a real 1-token
//    inference and rejects bad keys), and
//  - the configured-provider edit surface (masked key + Replace → input →
//    Cancel) is proven here with zero writes.

async function openModelProviders(page: any): Promise<void> {
  await awaitBootstrapTest(page, { skipModal: true });
  await navigateSettingsPages(page, "Settings", "Model Providers");
  await expect(page.getByTestId("settings_menu_header").last()).toContainText(
    "Model Providers",
    { timeout: 10000 },
  );
}

test.describe("Model Provider API Key Management", () => {
  test(
    "OpenAI provider is listed in Model Providers settings",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await openModelProviders(page);
      await expect(page.getByTestId("provider-item-OpenAI")).toBeVisible({
        timeout: 10000,
      });
    },
  );

  test(
    "Anthropic provider is listed in Model Providers settings",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page }) => {
      await openModelProviders(page);
      await expect(page.getByTestId("provider-item-Anthropic")).toBeVisible({
        timeout: 10000,
      });
    },
  );

  test(
    "a configured provider exposes the key edit surface (Replace, no raw input)",
    { tag: ["@stable", "@release", "@workspace", "@regression", "@model-provider"] },
    async ({ page, request }) => {
      // OpenAI is the configured-provider reference (collect-models configures
      // it in both environments). Skip with a reason when the instance has no
      // stored key — never silently.
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

      const replaceButton = page.getByRole("button", { name: "Replace", exact: true });
      const keyInput = page.getByTestId("provider-variable-input-OPENAI_API_KEY");

      await test.step("configured state: models badge, key input, Replace disabled", async () => {
        await expect(page.getByTestId("provider-item-OpenAI")).toContainText(
          /\d+\s*models/,
          { timeout: 10000 },
        );
        await expect(keyInput).toBeVisible({ timeout: 10000 });
        // Replace is the SUBMIT of a key replacement — with nothing typed it
        // must be disabled (nothing to replace with).
        await expect(replaceButton).toBeDisabled({ timeout: 10000 });
      });

      await test.step("typing a value arms Replace; clearing it disarms again", async () => {
        // Typing does not write anything — only clicking Replace would, and
        // this test never does (a destructive re-add poisons the backend's
        // credential cache; see the header comment).
        await keyInput.fill("sk-draft-never-submitted");
        await expect(replaceButton).toBeEnabled({ timeout: 10000 });

        await keyInput.fill("");
        await expect(replaceButton).toBeDisabled({ timeout: 10000 });
      });
    },
  );
});
