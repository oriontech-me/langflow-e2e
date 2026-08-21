import type { Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { withLocale } from "../../../fixtures/locale";
import { getAuthToken } from "../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../helpers/flows/create-flow";
import { deleteFlow } from "../../../helpers/flows/delete-flow";
import { openFlowById } from "../../../helpers/flows/open-flow-by-id";
import { unmountEditorForCleanup } from "../../../helpers/flows/unmount-editor-for-cleanup";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// i18n — Locale resilience (QA-CHECKLIST §18.2).
// Spec doc: docs/i18n/locale-resilience.md
//
// That an unsupported language degrades instead of breaking the product. The
// upstream reports this pins are total-failure ones: a missing Chinese bundle
// (langflow-ai/langflow#12923, #13477) and Norwegian Bokmål (#13196) each
// rendered a BLACK SCREEN — the product did not open at all. Measured fixed on
// 1.12.0.dev33, so this is a regression guard, not a reproduction.
//
// Sibling coverage, deliberately not duplicated: i18n/language-selection.spec.ts
// (§18.1) owns the Settings selector itself.

/**
 * The language ladder the frontend applies to the stored preference before
 * i18next ever sees it, transcribed from the shipped bundle:
 *
 * ```js
 * const SUPPORTED = ["en", "de", "es", "fr", "ja", "pt", "zh-Hans"];
 * const normalize = (e) => {
 *   if (SUPPORTED.includes(e)) return e;
 *   if (["zh-hans", "zh-cn", "zh-sg"].includes(e.toLowerCase())) return "zh-Hans";
 *   const primary = e.split("-")[0];
 *   return SUPPORTED.includes(primary) ? primary : "en";
 * };
 * ```
 *
 * Each row exercises one branch, so a regression that flattens the ladder to
 * "unknown ⇒ en" is still caught by the `zh-CN`/`de-AT` rows, and one that drops
 * the final `en` fallback — the black-screen shape — by the first four.
 */
const PREFERENCE_LADDER: Array<{
  seed: string | null;
  expected: string;
  branch: string;
}> = [
  {
    seed: "nb-NO",
    expected: "en",
    branch: "no bundle, no primary subtag match — upstream #13196 black-screened on this exact tag",
  },
  {
    seed: "ru",
    expected: "en",
    branch: "no bundle — upstream #12738 offered it in the selector without one",
  },
  {
    seed: "ko",
    expected: "en",
    branch: "no bundle — upstream #12740, the same defect",
  },
  {
    seed: "xx",
    expected: "en",
    branch: "well-formed but not a language Langflow ships",
  },
  {
    seed: "zh-CN",
    expected: "zh-Hans",
    branch: "the Chinese special case — upstream #12923/#13477 black-screened on it",
  },
  {
    seed: "zh-SG",
    expected: "zh-Hans",
    branch: "the second arm of the same special case",
  },
  {
    seed: "pt-BR",
    expected: "pt",
    branch: "primary-subtag fallback",
  },
  {
    seed: "de-AT",
    expected: "de",
    branch: "primary-subtag fallback, a second language",
  },
  {
    seed: null,
    expected: "en",
    branch: "no preference stored at all",
  },
];

/**
 * Writes the preference and reloads, because the frontend reads it exactly once.
 *
 * `normalize(localStorage.getItem("languagePreference") || "en")` runs at module
 * evaluation, so a value written after the page has loaded changes nothing until
 * the next load — a test that seeded and then asserted without reloading would
 * read the default and pass for the wrong reason.
 */
async function reloadWithPreference(
  page: Page,
  seed: string | null,
): Promise<void> {
  await page.evaluate((value) => {
    if (value === null) {
      localStorage.removeItem("languagePreference");
    } else {
      localStorage.setItem("languagePreference", value);
    }
  }, seed);
  await page.reload();
}

test.describe("i18n — a stored language preference Langflow cannot place", () => {
  test(
    "the application boots into a shipped language for every unsupported or regional preference",
    { tag: ["@stable", "@regression", "@ui-ux"] },
    async ({ page }) => {
      // Nine reloads of the home screen; measured at ~30 s in total.
      test.setTimeout(180000);
      await awaitBootstrapTest(page, { skipModal: true });

      for (const { seed, expected, branch } of PREFERENCE_LADDER) {
        const label = seed === null ? "(unset)" : JSON.stringify(seed);
        await test.step(`${label} → "${expected}" (${branch})`, async () => {
          await reloadWithPreference(page, seed);

          // Soft, so one broken branch reports itself without hiding the other
          // eight — the value of a table test is seeing which rows moved.
          //
          // "Boots" is three assertions because the defect being pinned renders
          // a black page with a LIVE document: the navigation resolves and the
          // URL is right, so a waitForURL or a bare shell check passes on the
          // very failure this exists to catch.
          await expect
            .soft(
              page.getByTestId("mainpage_title"),
              `${label}: the application never reached its main page`,
            )
            .toBeVisible({ timeout: 30000 });

          await expect
            .soft(
              page.locator("html"),
              `${label}: expected the ladder to resolve to "${expected}"`,
            )
            .toHaveAttribute("lang", expected, { timeout: 15000 });

          const rendered = (
            await page.locator("body").innerText().catch(() => "")
          ).trim();
          expect
            .soft(
              rendered.length,
              `${label}: the document rendered but its body is empty — this is the black-screen failure mode`,
            )
            .toBeGreaterThan(0);
        });
      }
    },
  );
});

test.describe("i18n — an unshipped browser locale", () => {
  // The sanctioned opt-in (#1400), never a bare `test.use({ locale })`:
  // CONTRIBUTING.md bans that spelling, and the ban is what made this bullet
  // unwritable before the fixture landed.
  test.use(withLocale("nb-NO"));

  test(
    "the application boots in English and never adopts the browser locale as a preference",
    { tag: ["@stable", "@regression", "@ui-ux"] },
    async ({ page }) => {
      await awaitBootstrapTest(page, { skipModal: true });

      await test.step("the browser really is running under the unshipped locale", async () => {
        // Without this the rest of the test would pass on a context that quietly
        // stayed en-US, which is exactly the false negative to avoid.
        expect(await page.evaluate(() => navigator.language)).toBe("nb-NO");
      });

      await test.step("the interface renders, in English", async () => {
        await expect(page.getByTestId("mainpage_title")).toBeVisible({
          timeout: 30000,
        });
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
      });

      await test.step("the browser locale did not become a language preference", async () => {
        // The load-bearing half. Langflow's i18n reads only
        // localStorage.languagePreference and ships no language-detector, so
        // navigator.language is inert — this is the one assertion in the suite
        // that fails if upstream ever adds detection, at which point every
        // unshipped browser locale becomes a boot risk again.
        expect(
          await page.evaluate(() =>
            localStorage.getItem("languagePreference"),
          ),
        ).toBeNull();
      });
    },
  );
});

test.describe("i18n — a key the active bundle does not carry", () => {
  let token: string;
  let flowId: string;

  test.beforeEach(async ({ page, request }) => {
    token = await getAuthToken(request);
    flowId = await createFlow(
      request,
      {
        name: `i18n-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        description: "Empty flow for the §18.2 missing-key fallback test",
        data: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
        is_component: false,
      },
      { headers: { Authorization: token } },
    );

    // Seeded before the first navigation: the preference is read once, at module
    // evaluation. openFlowById performs that navigation.
    await page.addInitScript(() =>
      localStorage.setItem("languagePreference", "pt"),
    );
    await openFlowById(page, flowId);
    await expect(page.locator("html")).toHaveAttribute("lang", "pt", {
      timeout: 30000,
    });
  });

  test.afterEach(async ({ page, request }) => {
    // Leave the editor BEFORE deleting: an editor mounted over a deleted flow
    // 404s its own polls into the fixture's HTTP log.
    await unmountEditorForCleanup(page);
    await deleteFlow(request, flowId, { headers: { Authorization: token } });
  });

  test(
    "a missing key falls back to English beside siblings the bundle translates",
    { tag: ["@stable", "@regression", "@ui-ux", "@workspace"] },
    async ({ page }) => {
      // On 1.12.0.dev33 all six non-English bundles are missing the same five
      // keys `en` carries (2387 vs 2382). Two of them render unconditionally in
      // this modal, on an instance with nothing configured.
      //
      // A third, `shortcuts.modifierOnly`, is a DECOY and must not be used: its
      // call site passes an inline `defaultValue`, so it renders English whether
      // or not `fallbackLng` works. These two are called with no defaultValue at
      // all, so English here can only come from the fallback.
      const FALLBACK_LABEL = "Vector Database";
      const FALLBACK_DESCRIPTION =
        "Where this memory base stores vectors. Configured providers come from DB Providers settings.";
      const FALLBACK_KEY = "memory.dbProviderLabel";
      const EXPIRY_HINT =
        `if upstream has translated ${FALLBACK_KEY}, re-measure by diffing the en translation ` +
        `object in the container's langflow/frontend/assets/index-*.js against assets/pt-*.js and ` +
        `pick another key present only in en`;

      await page.getByTestId("sidebar-nav-memories").click();
      // `/^Mem/` covers the English and Portuguese headings alike, so the
      // navigation does not itself depend on the translation under test.
      const panel = page
        .locator("aside")
        .filter({ has: page.getByRole("heading", { name: /^Mem/ }) });
      await expect(panel).toBeVisible({ timeout: 20000 });

      await panel.getByRole("button", { name: /^(Criar|Create)$/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 15000 });

      await test.step("the dialog's translated keys render in Portuguese", async () => {
        // The half that makes the English assertion falsifiable: "this label is
        // in English" is also true of an instance that never switched language.
        await expect(
          dialog.getByRole("heading", { name: /Criar Memória/ }),
        ).toBeVisible({ timeout: 15000 });
        await expect(
          dialog.getByText("Tamanho do lote", { exact: false }).first(),
        ).toBeVisible();
      });

      await test.step("the two keys the bundle lacks render their English text", async () => {
        await expect(
          dialog.getByText(FALLBACK_LABEL, { exact: false }).first(),
          `${FALLBACK_LABEL} did not fall back to English — ${EXPIRY_HINT}`,
        ).toBeVisible({ timeout: 15000 });
        await expect(
          dialog.getByText(FALLBACK_DESCRIPTION, { exact: false }),
          `the description did not fall back to English — ${EXPIRY_HINT}`,
        ).toBeVisible();
      });

      await test.step("no raw i18n key leaks into the dialog", async () => {
        // i18next's other failure mode: with the fallback gone it echoes the key
        // itself. Excluded explicitly so "missing" cannot pass as "handled".
        expect(
          await dialog.innerText(),
          `the dialog rendered the raw key instead of a string — fallbackLng is not doing its job`,
        ).not.toContain(FALLBACK_KEY);
      });

      // Nothing is created: the modal is only read, then dismissed.
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden({ timeout: 10000 });
    },
  );
});
