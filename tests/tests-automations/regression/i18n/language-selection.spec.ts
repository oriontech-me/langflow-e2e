import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../../../fixtures/fixtures";
import { awaitBootstrapTest } from "../../../helpers/other/await-bootstrap-test";

// i18n — Language selection (QA-CHECKLIST §18.1).
// Spec doc: docs/i18n/language-selection.md
//
// The seam immediately past ui-ux/settings-general-section.spec.ts, which
// asserts the Language card exists and stops there. Nothing here needs a
// provider, an LLM or a flow — the whole surface is client-side.
//
// Sibling coverage, deliberately not duplicated: i18n/locale-resilience.spec.ts
// (§18.2) owns the browser-locale axis and the missing-key fallback.

/**
 * The primary observable, in preference to any translated string.
 *
 * The frontend assigns it at boot and again on every `languageChanged` event
 * (measured in the shipped bundle: the handler is
 * `e => {document.documentElement.lang = e}`). It is product state that upstream
 * cannot reword, so it survives a translation edit that would break a string
 * assertion.
 */
function documentLanguage(page: Page): Locator {
  return page.locator("html");
}

/**
 * The language selector, resolved by role and pinned to a single match.
 *
 * NOT by accessible name. The trigger carries no `id` and no `data-testid` —
 * only `aria-label={t("settings.languageSelectAriaLabel")}`, which is itself
 * translated: `Select language` in English, `Selecionar idioma` in Portuguese,
 * `言語の選択` in Japanese (all measured on 1.12.0.dev33). A name-based handle
 * therefore resolves exactly once and matches nothing after the first switch,
 * which is what makes the "every offered language" test unwritable if taken
 * naively.
 *
 * Settings → General renders exactly one combobox in all seven languages
 * (measured). Asserting the count first is what turns a second one appearing
 * into a named failure instead of a click on the wrong control.
 */
async function languageSelect(page: Page): Promise<Locator> {
  const select = page.getByRole("combobox");
  await expect(select).toHaveCount(1);
  return select;
}

/** Settings → General, the same path ui-ux/settings-general-section.spec.ts uses. */
async function openSettingsGeneral(page: Page): Promise<void> {
  await page.getByTestId("user-profile-settings").click();
  await page.getByTestId("menu_settings_button").click();
  await page.waitForSelector('[data-testid="settings_menu_header"]', {
    timeout: 15000,
  });
  await page.getByRole("link", { name: "General", exact: true }).click();
  await expect(page.getByTestId("settings_menu_header")).toContainText(
    "General",
    { timeout: 10000 },
  );
}

/**
 * An option's label with its trailing parenthetical removed.
 *
 * The option labels are hardcoded native names and do NOT move with the
 * interface language — except the `(Recommended)` suffix on the English entry,
 * which does (`(Recommandé)`, `(推荐)`). Since the round trip back to English
 * happens last, by which point the interface is in some other language, the
 * English option has to be matched on its stable prefix.
 */
function stableOptionPrefix(label: string): string {
  return label.replace(/\s*\(.*\)\s*$/, "").trim();
}

function prefixMatcher(label: string): RegExp {
  const escaped = stableOptionPrefix(label).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  return new RegExp(`^${escaped}`);
}

/** Opens the selector and returns every option's visible label, in order. */
async function readOfferedLanguages(page: Page): Promise<string[]> {
  const select = await languageSelect(page);
  await select.click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 10000 });
  const labels = (await options.allTextContents()).map((l) => l.trim());
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  return labels;
}

/**
 * Selects one option and waits for the switch to land.
 *
 * Gated on `<html lang>` actually moving off its previous value rather than on
 * a fixed wait: the change handler awaits a dynamic import of the locale chunk
 * before it calls `changeLanguage`, so the interface is briefly still in the old
 * language after the click.
 */
async function selectLanguage(
  page: Page,
  label: string,
  previousLanguage: string,
): Promise<string> {
  const option = page.getByRole("option", { name: prefixMatcher(label) });
  await (await languageSelect(page)).click();
  // Exactly one match, so a future selector entry sharing a prefix with another
  // fails here by name instead of resolving to whichever came first.
  await expect(option).toHaveCount(1);
  await option.click();
  await expect(documentLanguage(page)).not.toHaveAttribute(
    "lang",
    previousLanguage,
    { timeout: 15000 },
  );
  return (await documentLanguage(page).getAttribute("lang")) ?? "";
}

/** The locale chunk a given language code would be served from, if any. */
function localeChunkPattern(language: string): RegExp {
  const escaped = language.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`/assets/${escaped}-[A-Za-z0-9_-]+\\.js$`);
}

test.describe("i18n — the Settings display-language selector", () => {
  test.beforeEach(async ({ page }) => {
    await awaitBootstrapTest(page, { skipModal: true });
    await openSettingsGeneral(page);
  });

  test(
    "changing the display language re-renders the interface",
    { tag: ["@stable", "@regression", "@ui-ux", "@settings"] },
    async ({ page }) => {
      await test.step("the interface starts in English with no stored preference", async () => {
        await expect(documentLanguage(page)).toHaveAttribute("lang", "en");
        // Null, not "en": the default is applied without ever being written, so
        // a stored value here would mean some earlier state leaked into the test.
        expect(
          await page.evaluate(() =>
            localStorage.getItem("languagePreference"),
          ),
        ).toBeNull();
      });

      await test.step("selecting Português switches the document language", async () => {
        await selectLanguage(page, "Português", "en");
        await expect(documentLanguage(page)).toHaveAttribute("lang", "pt");
      });

      await test.step("the interface renders in the selected language", async () => {
        // The settings header is the closest translated string to the control
        // that changed it, so a switch that writes the preference without
        // re-rendering cannot pass.
        await expect(page.getByTestId("settings_menu_header")).toHaveText(
          "Geral",
          { timeout: 15000 },
        );
        await expect(await languageSelect(page)).toHaveText("Português");
      });

      await test.step("the choice is stored as the language preference", async () => {
        await expect
          .poll(
            () =>
              page.evaluate(() =>
                localStorage.getItem("languagePreference"),
              ),
            { timeout: 10000 },
          )
          .toBe("pt");
      });
    },
  );

  test(
    "the selected language survives a reload and a second tab of the same session",
    { tag: ["@stable", "@regression", "@ui-ux", "@settings"] },
    async ({ page }) => {
      await test.step("switch the interface to Português", async () => {
        await selectLanguage(page, "Português", "en");
        await expect(page.getByTestId("settings_menu_header")).toHaveText(
          "Geral",
          { timeout: 15000 },
        );
      });

      await test.step("a reload comes back in Portuguese", async () => {
        await page.reload();
        await expect(documentLanguage(page)).toHaveAttribute("lang", "pt", {
          timeout: 30000,
        });
        await expect(page.getByTestId("settings_menu_header")).toHaveText(
          "Geral",
          { timeout: 30000 },
        );
      });

      await test.step("a second tab of the same browser session comes up in Portuguese", async () => {
        // A second PAGE, never a second CONTEXT. The preference lives in
        // localStorage, so a fresh context correctly does not inherit it —
        // checking "a new session" that way would read designed behaviour as a
        // regression.
        const secondTab = await page.context().newPage();
        try {
          await secondTab.goto("/");
          await secondTab.waitForSelector('[data-testid="mainpage_title"]', {
            timeout: 30000,
          });
          await expect(secondTab.locator("html")).toHaveAttribute("lang", "pt", {
            timeout: 15000,
          });
          expect(
            await secondTab.evaluate(() =>
              localStorage.getItem("languagePreference"),
            ),
          ).toBe("pt");
        } finally {
          await secondTab.close();
        }
      });
    },
  );

  test(
    "every language the selector offers loads a translation bundle",
    { tag: ["@stable", "@regression", "@ui-ux", "@settings"] },
    async ({ page }) => {
      const chunkRequests: Array<{ path: string; status: number }> = [];
      page.on("response", (response) => {
        chunkRequests.push({
          path: new URL(response.url()).pathname,
          status: response.status(),
        });
      });

      const startLanguage =
        (await documentLanguage(page).getAttribute("lang")) ?? "";
      const startHeader =
        (await page.getByTestId("settings_menu_header").textContent())?.trim() ??
        "";
      const offered = await readOfferedLanguages(page);

      await test.step("the selector offers a choice at all", async () => {
        // Without this a selector reduced to one entry would satisfy the loop
        // below vacuously.
        expect(offered.length).toBeGreaterThanOrEqual(2);
      });

      // The option matching the current selection is the starting language. It
      // is identified from the product's own state rather than by hardcoding
      // "English", and it is walked LAST so that its own switch is observable —
      // selecting the already-active language changes nothing.
      const startLabel =
        (await (await languageSelect(page)).textContent())?.trim() ?? "";
      const startOption = offered.find(
        (label) => stableOptionPrefix(label) === stableOptionPrefix(startLabel),
      );
      expect(
        startOption,
        `the selector's current value ${JSON.stringify(startLabel)} matches none of its options ${JSON.stringify(offered)}`,
      ).toBeDefined();

      const walkOrder = [
        ...offered.filter((label) => label !== startOption),
        startOption as string,
      ];

      let previousLanguage = startLanguage;
      for (const label of walkOrder) {
        const isStartLanguage = label === startOption;
        await test.step(`"${label}" ${isStartLanguage ? "restores the inlined bundle" : "loads its bundle and re-renders"}`, async () => {
          const seenBefore = chunkRequests.length;
          const language = await selectLanguage(page, label, previousLanguage);
          previousLanguage = language;

          expect(
            language,
            `selecting ${JSON.stringify(label)} left <html lang> empty`,
          ).not.toBe("");

          const newChunks = chunkRequests.slice(seenBefore);
          const localeChunks = newChunks.filter((chunk) =>
            localeChunkPattern(language).test(chunk.path),
          );

          if (isStartLanguage) {
            // The starting language is the one whose translations are inlined
            // in the app bundle — the loader short-circuits on `!== "en"`, so
            // there is no chunk to fetch. Asserted rather than skipped: a test
            // that merely skipped this case would also pass if it started
            // fetching a chunk that does not exist.
            expect(
              localeChunks,
              `${JSON.stringify(label)} resolved to "${language}" and fetched a locale chunk, which the inlined language should never do`,
            ).toHaveLength(0);
            await expect(page.getByTestId("settings_menu_header")).toHaveText(
              startHeader,
              { timeout: 15000 },
            );
            return;
          }

          // Two separate failures, asserted separately: a selector entry with no
          // bundle 404s the dynamic import and leaves the interface silently in
          // the previous language (the upstream #12738/#12740 shape), so the
          // request alone and the re-render alone each report the right verdict
          // for the wrong reason.
          expect(
            localeChunks.map((chunk) => `${chunk.status} ${chunk.path}`),
            `${JSON.stringify(label)} resolved to "${language}" but fetched no /assets/${language}-<hash>.js — the selector offers a language the image ships no bundle for`,
          ).not.toHaveLength(0);
          expect(
            localeChunks.every((chunk) => chunk.status === 200),
            `${JSON.stringify(label)} fetched its bundle with a non-200: ${JSON.stringify(localeChunks)}`,
          ).toBe(true);

          await expect(
            page.getByTestId("settings_menu_header"),
            `${JSON.stringify(label)} loaded its bundle but the interface still reads ${JSON.stringify(startHeader)}`,
          ).not.toHaveText(startHeader, { timeout: 15000 });
        });
      }
    },
  );
});
