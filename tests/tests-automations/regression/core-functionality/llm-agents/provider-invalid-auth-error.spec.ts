import * as dotenv from "dotenv";
import path from "path";
import { expect, test } from "../../../../fixtures/fixtures";
import { SettingsPage } from "../../../../pages/SettingsPage";
import {
  hasProviderEnvKeys,
  keyedProviders,
  type Provider,
} from "../../../../helpers/provider-setup";
import { errorToastLocator } from "../../../../helpers/ui/error-toast";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
}

// ─── Target builder ───────────────────────────────────────────────────────────
// Configuração por provider centralizada em helpers/provider-setup/provider-config.ts

type ProviderTarget = {
  provider: Provider;
  primaryEnvVar: string;
  providerTestId: string;
  keyPlaceholder: string;
  invalidKey: string;
};

// Iterates `keyedProviders`, not every provider (#1187). This test's subject IS the
// API key — it saves a deliberately invalid one and asserts the error toast — so a
// keyless provider (Ollama, configured by a base URL) has no such journey: it would
// contribute a test case that types an invalid "key" into a field that does not
// exist. The narrowing is the compiler's, not a filter to remember: `keyedProviders`
// carries `ApiKeyProviderConfig`, so `keyPlaceholder` / `invalidKey` are reachable
// here precisely because the entry has them.
function getProviderTargets(): ProviderTarget[] {
  return keyedProviders
    .filter(([provider]) => hasProviderEnvKeys(provider))
    .map(([provider, config]) => ({
      provider,
      primaryEnvVar: config.envKeys[0],
      providerTestId: config.providerTestId,
      keyPlaceholder: config.keyPlaceholder,
      invalidKey: config.invalidKey,
    }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Fills the API key input on the current provider page and clicks Save/Replace.
// Use when already on the provider configuration screen.
//
// #933 — every step here used to be a SNAPSHOT, not a wait:
//
//     if ((await apiKeyInput.count()) > 0) { … if ((await saveBtn.count()) > 0) … }
//
// `count()` resolves against the DOM as it is at that instant. When the provider
// form had not finished mounting, the `if` simply did not run and the function
// returned as if it had done its job — so the test went on to assert a toast for a
// save that never happened, and waited the full 30 s for an effect nobody had
// triggered. The daily's own step timings show this happening: on 2026-07-22 the
// restore step took 75 / 253 / 195 ms across three attempts and on 2026-07-24 it
// took 162 ms — far too little to fill an input and click a button, i.e. the
// conditional never entered and the invalid key was left in place, silently.
//
// Now every step asserts. `expect(...).toBeVisible()` waits, and `click()` carries
// Playwright's own actionability checks, so a form that never mounts fails here,
// naming this function, instead of surfacing 30 s later as "toast not visible".
async function fillProviderApiKey(
  page: any,
  apiKeyPlaceholder: string,
  apiKey: string,
): Promise<void> {
  const apiKeyInput = page.getByPlaceholder(apiKeyPlaceholder);
  await expect(
    apiKeyInput,
    `The API key input (placeholder "${apiKeyPlaceholder}") never appeared — ` +
      "the provider form did not mount, so nothing was saved (#933)",
  ).toBeVisible({ timeout: 15000 });
  await apiKeyInput.fill(apiKey);

  const saveBtn = page
    .getByRole("button", {
      name: /^(Save|Replace|Retry Save)$|Save Configuration|Replace Configuration/i,
    })
    .first();
  await expect(
    saveBtn,
    "The Save/Replace button never appeared, so the key was never submitted (#933)",
  ).toBeVisible({ timeout: 15000 });
  await saveBtn.click();

  // Replacing an existing key opens a disconnect-warning dialog; a first-time save
  // does not. Absence is legitimate, so this stays optional — but the click itself
  // is a real click now. It used to be `page.evaluate(() => btn?.click())`, which
  // fires on the raw DOM node and bypasses every actionability check, so a dialog
  // whose React handler was not yet attached swallowed the confirmation and the
  // save never completed. Scoping to the dialog handles the layout overlap that
  // motivated the evaluate in the first place.
  //
  // The presence check must WAIT, not sample. `locator.isVisible()` resolves
  // against the DOM as it is right now — using it here would reproduce the exact
  // bug this function is being fixed for, one line further down: a dialog that
  // takes 200 ms to mount would be declared absent, the confirmation skipped, and
  // the save left uncommitted. `waitFor` gives the dialog its 5 s and reports
  // absence as absence.
  const dialog = page.getByRole("dialog");
  const confirmBtn = dialog.getByRole("button", { name: "Confirm" });
  const dialogAppeared = await confirmBtn
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (dialogAppeared) {
    await confirmBtn.click();
    await expect(
      confirmBtn,
      "The confirmation dialog stayed open — the save was not committed (#933)",
    ).toBeHidden({ timeout: 10000 });
  }
}

// Navigates to Settings > Model Providers > provider and fills the API key.
// Use when not yet on the provider configuration screen.
async function navigateAndFillProviderApiKey(
  page: any,
  providerTestId: string,
  apiKeyPlaceholder: string,
  apiKey: string,
): Promise<void> {
  const settingsPage = new SettingsPage(page);
  await settingsPage.navigate();

  // Both clicks carry Playwright's actionability wait; the provider form's own
  // readiness is asserted by fillProviderApiKey below, which is where a form that
  // never mounts must be reported (#933).
  await page.getByTestId("icon-BrainCircuit").click();
  await page.getByTestId(providerTestId).click();

  await fillProviderApiKey(page, apiKeyPlaceholder, apiKey);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const targets = getProviderTargets();

for (const {
  provider,
  primaryEnvVar,
  providerTestId,
  keyPlaceholder,
  invalidKey,
} of targets) {
  test.describe.serial(`Invalid Auth Error — ${provider}`, () => {
    // The google variant was quarantined here for #933 (recurrent on the dailies of
    // 2026-07-22 and 2026-07-24) via an in-body `test.fixme`, because the `@stable`
    // tag is shared by every provider variant of this parameterized test and could
    // not be dropped for google alone. The quarantine is lifted: the cause was this
    // spec's own action path, fixed above and below, not anything google-specific.
    test(
      `should display error message when using invalid authentication for provider ${provider}`,
      { tag: ["@stable", "@regression", "@model-provider", "@agents"] },
      async ({ page }) => {
        // Guaranteed non-empty: `getProviderTargets()` filters on
        // `hasProviderEnvKeys`, which is `every(key => !!process.env[key])` — an
        // absent OR empty key drops the provider from the matrix altogether, so the
        // restore below can never blank out the provider's configuration. (An
        // explicit guard here was tried and removed: force-failing it showed it can
        // never fire, because with an empty key this variant does not exist.)
        const validKey = process.env[primaryEnvVar] as string;

        // Unique per run (#933). Langflow validates a provider key on save, and
        // saving the SAME value it already holds produces no validation and no
        // toast at all — measured: a second identical fill left the screen with no
        // `.error-build-message` after 15 s. Combined with a cleanup that could
        // silently fail to restore, that made retries structurally unable to pass:
        // attempt 1 left the invalid key stored, attempt 2 re-submitted the very
        // same string, nothing was validated, and the assertion waited out its full
        // 30 s. That is exactly the shape of 2026-07-22, where all three attempts
        // failed with identical timings. A unique suffix guarantees the save is a
        // real state change, independent of what the instance already holds.
        const uniqueInvalidKey = `${invalidKey}-${Date.now()}`;

        await page.goto("/");
        await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });

        await test.step(`Set invalid authentication for ${provider}`, async () => {
          await navigateAndFillProviderApiKey(
            page,
            providerTestId,
            keyPlaceholder,
            uniqueInvalidKey,
          );
        });

        // A restore that fails must be reported, but it must never replace the
        // reason the test failed in the first place: an exception thrown from
        // `finally` would overwrite the assertion error below. So it is captured
        // here and asserted after — if the body already threw, its error wins and
        // this assertion is never reached (#933).
        let restoreError = "";
        try {
          await test.step("Validate that the invalid authentication error is displayed", async () => {
            const errorBox = errorToastLocator(page);
            await expect(
              errorBox.getByText(/Invalid API key/i),
            ).toBeVisible({ timeout: 30000 });
          });
        } finally {
          await test.step(`Restore valid authentication for provider ${provider}`, async () => {
            try {
              await fillProviderApiKey(page, keyPlaceholder, validKey);
            } catch (e) {
              restoreError = (e as Error)?.message ?? String(e);
              console.log(
                `🚨 #933 restore FAILED for ${provider} — this instance may still ` +
                  `hold an invalid ${primaryEnvVar}, which will break every later ` +
                  `spec that uses this provider: ${restoreError}`,
              );
            }
          });
        }
        expect(
          restoreError,
          `Cleanup did not restore ${primaryEnvVar}: the instance is left holding an ` +
            "invalid provider key, which silently breaks later specs (#933)",
        ).toBe("");
      },
    );
  });
}
