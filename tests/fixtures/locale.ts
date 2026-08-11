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
 * 3. **The backend's locale is reached, but only by leakage — do not rely on it
 *    in either direction.** Langflow's `set_locale` middleware
 *    (`src/backend/base/langflow/main.py`) reads `Accept-Language` and really does
 *    answer in it: `GET /api/v1/flows/basic_examples/` returns "Basic Prompting"
 *    under `en` and "Sugestões básicas" under `pt`. The frontend pins
 *    `Accept-Language: i18n.language` on the calls that go through its axios
 *    interceptors, so most requests send `en` whatever the context locale is —
 *    **17 of the 20 `/api/` requests the home screen makes** under `locale:
 *    "pt-BR"`. The other **3 carry the context locale**: a browser-issued
 *    subresource (`/api/v1/files/profile_pictures/…svg`) never passes through the
 *    interceptor, and neither did two `/api/v9/invites/…` XHRs. A spec whose
 *    subject is the backend's locale must therefore set `Accept-Language`
 *    explicitly via `extraHTTPHeaders` on a direct API request rather than infer
 *    it from the context.
 *
 * That split is why `withLocale()` returns **only** `locale`. Adding
 * `extraHTTPHeaders: { "Accept-Language": … }` would at minimum change those 3
 * leaked requests, and its precedence against the header the axios interceptor
 * assigns per request is **unmeasured** — so the language the backend sees would
 * become a per-request race between two layers, in a helper whose whole job is to
 * make one axis explicit.
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
 * The one well-formed tag Chromium refuses. `Intl.getCanonicalLocales("und")`
 * returns `["und"]` — it is valid BCP-47 for "undetermined" — but
 * `newContext({ locale: "und" })` dies with `Protocol error
 * (Emulation.setLocaleOverride): Invalid locale name`, which is exactly the
 * opaque browser-launch failure this validation exists to prevent. (`"root"` is
 * rejected by `Intl` itself, so it needs no entry here. Both measured against the
 * repo's pinned Chromium.)
 */
const BROWSER_REJECTED_LOCALES = new Set(["und"]);

/**
 * Validate and canonicalise a BCP-47 tag, naming the caller in the failure.
 *
 * Fail-closed on purpose: an unusable value must abort with its cause named
 * rather than fall back to `en-US`, which would run the whole suite in English
 * under a command line that asked for something else (#1012's rule).
 *
 * The check is **syntactic**, with one measured exception (`und`, above). A
 * well-formed tag for a language that does not exist is NOT caught and does not
 * announce itself anywhere: `xx` and `zz-ZZ` both launch, and Chromium silently
 * renders an ISO-ish fallback (`1969-12-31 21:00:00`) instead of erroring. What
 * this does catch is the slip it is actually likely to see — the POSIX spelling
 * `pt_BR`, a `RangeError`.
 */
export function canonicalLocale(value: string, source: string): string {
  const trimmed = value.trim();
  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(trimmed);
  } catch {
    canonical = [];
  }
  if (canonical.length === 1 && BROWSER_REJECTED_LOCALES.has(canonical[0])) {
    throw new Error(
      `${source}: ${JSON.stringify(value)} is a well-formed BCP-47 tag that ` +
        `Chromium refuses ("Invalid locale name"), which would kill every test ` +
        `in the run with a browser-launch error instead of this one. Pick a real ` +
        `language tag such as "pt-BR".`,
    );
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
 * worth keeping for two reasons this helper preserves: the tag is checked at
 * collection time — including `und`, the one well-formed tag that would otherwise
 * kill the run with an opaque `Emulation.setLocaleOverride` error — and every
 * opt-out in the suite is findable with one grep. It cannot vouch for the tag
 * being a real language: see `canonicalLocale`.
 *
 * Returns only `locale` — see the header for the measurement behind that.
 */
export function withLocale(locale: string): { locale: string } {
  return { locale: canonicalLocale(locale, "withLocale()") };
}

export interface RunLocale {
  /** The value `playwright.config.ts` puts in `use.locale`. */
  locale: string;
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
    return { locale: DEFAULT_LOCALE };
  }

  const locale = canonicalLocale(raw, LOCALE_ENV_VAR);
  if (locale === DEFAULT_LOCALE) {
    // Asked for the default explicitly: nothing changed, nothing to announce.
    return { locale };
  }

  return {
    locale,
    notice:
      `[lane] browser locale overridden to ${locale} via ${LOCALE_ENV_VAR} — ` +
      `every English-string assertion in this run executes under it, and the ` +
      `Langflow UI stays English regardless (its language comes from ` +
      `localStorage.languagePreference, not the browser locale). ` +
      `Unset ${LOCALE_ENV_VAR} to restore ${DEFAULT_LOCALE}.`,
  };
}
