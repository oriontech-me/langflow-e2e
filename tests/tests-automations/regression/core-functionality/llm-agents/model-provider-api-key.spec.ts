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
//  - the configured-provider edit surface (masked key + the `Replace`-labelled
//    submit arming only once a value is typed) is proven here with zero writes.

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
      //
      // Deliberately NOT gated on provider health (#1029 audit): this asserts the
      // key-edit SURFACE, and a configured-but-drained key is exactly a state it
      // must still cover. It drives no completion — the models badge comes from the
      // catalog and the typed value is never submitted — so it cannot produce the
      // hung request that wedges a shard. The instance-side variable check below is
      // already stronger than env-var presence.
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

      // There is no distinct "Replace" button (#1431). The panel has ONE submit
      // control, `provider-save-button`, whose label is picked at render time:
      // `Retry save` after a failed validation, `Replace` when the panel
      // considers the provider already configured, `Save` otherwise. That last
      // state is not hypothetical — `isAlreadyConfigured` is derived from the
      // credential variables, so the label reads `Save` until
      // `GET /api/v1/variables/` resolves, while the models badge and the key
      // input are ALREADY rendered. Locating by role+name matched nothing for
      // the full 10 s in that window and reported `element(s) not found`
      // instead of the label it actually found (daily 2026-08-12; reproduced
      // locally by delaying that request: `Save` for 9 s, then `Replace`).
      const saveButton = page.getByTestId("provider-save-button");
      const keyInput = page.getByTestId("provider-variable-input-OPENAI_API_KEY");

      await test.step("configured state: models badge, key input, Replace disabled", async () => {
        await expect(page.getByTestId("provider-item-OpenAI")).toContainText(
          /\d+\s*models/,
          { timeout: 10000 },
        );
        await expect(keyInput).toBeVisible({ timeout: 10000 });
        await expect(saveButton).toBeVisible({ timeout: 10000 });

        // Settle the panel first: while `loading`, the button keeps its
        // accessible name but renders it twice (a width-reserving copy plus an
        // `sr-only` one) and is blocked via `aria-disabled`, not `disabled`.
        await expect(saveButton).not.toHaveAttribute("aria-busy", "true", {
          timeout: 15000,
        });
        // The premise of this test: a configured provider offers REPLACEMENT of
        // the stored key, not raw editing. Asserted as a property of the
        // located button, so `Save` (variables not loaded) and `Retry save`
        // (previous validation failed) fail HERE, naming what was found.
        await expect(saveButton).toHaveAccessibleName("Replace", {
          timeout: 15000,
        });

        // Replace is the SUBMIT of a key replacement — with nothing typed it
        // must be disabled (nothing to replace with). Assert the NATIVE
        // mechanism: `toBeDisabled()` alone is also satisfied by the
        // `aria-disabled` a mid-request button carries, which would let a
        // permanently-busy panel read as a correctly-guarded one.
        await expect(saveButton).toHaveJSProperty("disabled", true);
      });

      await test.step("typing a value arms Replace; clearing it disarms again", async () => {
        // Typing does not write anything — only clicking Replace would, and
        // this test never does (a destructive re-add poisons the backend's
        // credential cache; see the header comment).
        await keyInput.fill("sk-draft-never-submitted");
        await expect(saveButton).toHaveJSProperty("disabled", false);
        await expect(saveButton).toBeEnabled({ timeout: 10000 });
        // Still the replacement surface — arming it must not have flipped the
        // panel into the unconfigured (`Save`) or failed (`Retry save`) state.
        await expect(saveButton).toHaveAccessibleName("Replace");

        await keyInput.fill("");
        await expect(saveButton).toHaveJSProperty("disabled", true);
      });
    },
  );
});
