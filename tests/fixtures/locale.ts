/**
 * Decides the browser context locale every test runs under, and provides the one
 * sanctioned way for a spec to opt out of it (#1400).
 *
 * ## Why this is a module and not a literal in the config
 *
 * `playwright.config.ts` pinned `locale: "en-US"` inline (#225) and
 * `CONTRIBUTING.md` forbade overriding it anywhere, which is the right default —
 * the suite asserts on English strings throughout — but it left non-English
 * coverage with no route at all: the i18n checklist bullets could not be written,
 * because the only mechanism available (`test.use({ locale })`) was exactly what
 * the rule banned. Parameterising it here keeps the default untouched, gives the
 * opt-in a single validated entry point, and makes both testable by
 * `npm run test:units` instead of by reading a terminal.
 *
 * ## What the locale actually controls — measured, because the obvious reading is wrong
 *
 * Measured on Langflow Nightly `1.12.0.dev20`, two browser contexts identical
 * except for `locale` (en-US vs pt-BR). Non-English behaviour has **three
 * independent axes**, and this option governs exactly one of them:
 *
 * 1. **The UI language is NOT one of them.** `src/frontend/src/i18n.ts` reads
 *    `localStorage.getItem("languagePreference")` (default `"en"`) and never
 *    consults `navigator.language` — there is no language-detector plugin. Under
 *    `locale: "pt-BR"` the app still renders English and `<html lang>` still reads
 *    `en`. A spec that needs a translated UI must drive the language selector (app
 *    header, or Settings → General) or seed that key; changing the locale will not
 *    do it, and assuming otherwise is how such a spec fails and gets misdiagnosed.
 * 2. **`Intl` formatting and the document/asset `Accept-Language` ARE.** The same
 *    instant renders `12/31/1969, 9:00:00 PM` under en-US and `31/12/1969,
 *    21:00:00` under pt-BR. This is the axis the option exists for.
 * 3. **The backend's locale is NOT.** Langflow's `set_locale` middleware
 *    (`src/backend/base/langflow/main.py`) reads `Accept-Language`, but the
 *    frontend's axios layer pins `Accept-Language: i18n.language` on every
 *    `/api/**` call, so it always sent `en` regardless of the context locale. A
 *    spec that needs a localised backend response sets `extraHTTPHeaders` on a
 *    direct API request.
 *
 * That measurement is why `withLocale()` returns **only** `locale`: bundling
 * `extraHTTPHeaders: { "Accept-Language": … }` into it would override the header
 * the frontend sets per request, leaving the app announcing one language to the
 * backend while rendering another — a state no product build can reach.
 */

/**
 * The locale every spec runs under unless it opts out. Changing this changes the
 * meaning of every English-string assertion in the suite (#225).
 */
export const DEFAULT_LOCALE = "en-US";

/** Run-wide override, read by `playwright.config.ts`. Empty/unset means the default. */
export const LOCALE_ENV_VAR = "PW_LOCALE";

/**
 * The languages Langflow ships a translation bundle for
 * (`src/frontend/src/locales/*.json`, identical on `main` and `release-1.12.0`).
 *
 * Recorded for the reader, NOT used as a validation list: the browser locale and
 * the UI bundle are independent axes (see the header), so `withLocale("it-IT")` is
 * legitimate — it changes `Intl` formatting — even though Langflow ships no
 * Italian bundle, and `withLocale("pt-BR")` does NOT produce a Portuguese UI even
 * though it ships a Portuguese one.
 */
export const LANGFLOW_UI_LANGUAGES = [
  "en",
  "de",
  "es",
  "fr",
  "ja",
  "pt",
  "zh-Hans",
] as const;

/**
 * Validate and canonicalise a BCP-47 tag, naming the caller in the failure.
 *
 * Fail-closed on purpose: an unusable value must abort with its cause named
 * rather than fall back to `en-US`, which would run the whole suite in English
 * under a command line that asked for something else (#1012's rule).
 *
 * The check is **syntactic** — `Intl.getCanonicalLocales` accepts any
 * well-formed tag, so `"xx"` passes and only the browser will tell you it is not
 * a real language. It does catch the slip this is most likely to see: the POSIX
 * spelling `pt_BR`, which is a `RangeError`.
 */
export function canonicalLocale(value: string, source: string): string {
  const trimmed = value.trim();
  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(trimmed);
  } catch {
    canonical = [];
  }
  if (canonical.length !== 1) {
    throw new Error(
      `${source}: ${JSON.stringify(value)} is not a valid BCP-47 locale tag. ` +
        `Use a hyphenated tag such as "en-US" or "pt-BR" — the POSIX form ` +
        `"pt_BR" and an empty value are both rejected here rather than ` +
        `silently falling back to ${DEFAULT_LOCALE}.`,
    );
  }
  return canonical[0];
}

/**
 * The sanctioned per-spec opt-in. Use it in a `test.use()` at describe level:
 *
 * ```ts
 * test.describe("date rendering under a non-English locale", () => {
 *   test.use(withLocale("pt-BR"));
 *   …
 * });
 * ```
 *
 * A bare `test.use({ locale })` is what `CONTRIBUTING.md` bans, and the ban is
 * worth keeping for two reasons this helper preserves: the tag is validated at
 * collection time instead of producing a confusing browser-launch failure, and
 * every opt-out in the suite is findable with one grep.
 *
 * Returns only `locale` — see the header for the measurement behind that.
 */
export function withLocale(locale: string): { locale: string } {
  return { locale: canonicalLocale(locale, "withLocale()") };
}

export interface RunLocale {
  /** The value `playwright.config.ts` puts in `use.locale`. */
  locale: string;
  /** Where it came from — `env` only when `PW_LOCALE` carried a usable value. */
  source: "default" | "env";
  /**
   * Set only when the effective locale differs from `DEFAULT_LOCALE`. The config
   * prints it on **stderr**: an override changes what every English-string
   * assertion in the suite is running against, and a run whose meaning changed
   * must say so (#1010) — but stdout is a machine contract for the daily's shard
   * matrix and must stay clean (#1024).
   */
  notice?: string;
}

/**
 * Resolve the run-wide locale from the environment.
 *
 * Pure, so the config stays a wiring layer: `playwright.config.ts` reads the
 * result and prints the notice, and every branch below is covered by
 * `npm run test:units` without launching a browser.
 */
export function resolveRunLocale(
  env: NodeJS.ProcessEnv = process.env,
): RunLocale {
  const raw = env[LOCALE_ENV_VAR];
  // Empty and whitespace-only are treated as unset, mirroring how the config
  // already reads PLAYWRIGHT_RETRIES — an exported-but-blank variable is the
  // shell's idea of "not set", not a request for an invalid locale.
  if (raw === undefined || raw.trim() === "") {
    return { locale: DEFAULT_LOCALE, source: "default" };
  }

  const locale = canonicalLocale(raw, LOCALE_ENV_VAR);
  if (locale === DEFAULT_LOCALE) {
    // Asked for the default explicitly: nothing changed, nothing to announce.
    return { locale, source: "env" };
  }

  return {
    locale,
    source: "env",
    notice:
      `[lane] browser locale overridden to ${locale} via ${LOCALE_ENV_VAR} — ` +
      `every English-string assertion in this run executes under it, and the ` +
      `Langflow UI stays English regardless (its language comes from ` +
      `localStorage.languagePreference, not the browser locale). ` +
      `Unset ${LOCALE_ENV_VAR} to restore ${DEFAULT_LOCALE}.`,
  };
}
