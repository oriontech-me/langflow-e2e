// Unit tests for the browser-locale parameterisation (#1400).
// Run with: npm run test:units
//
// The whole point of extracting this from `playwright.config.ts` is that these
// branches are answerable without launching a browser: what a run resolves to,
// what it announces, and what it refuses. The wiring half — that the config
// actually puts this value in `use.locale` and prints the notice off stdout —
// lives in `playwright.config.test.ts`, because only a real config import can
// prove it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCALE,
  LANGFLOW_UI_LANGUAGES,
  LOCALE_ENV_VAR,
  canonicalLocale,
  resolveRunLocale,
  withLocale,
} from "./locale";

test("an unset, empty or whitespace PW_LOCALE resolves to the default", () => {
  // Empty is the shell's idea of "not set" (`export PW_LOCALE=`), and must not be
  // read as a request for an invalid locale.
  for (const env of [{}, { [LOCALE_ENV_VAR]: "" }, { [LOCALE_ENV_VAR]: "  " }]) {
    const resolved = resolveRunLocale(env);
    assert.equal(resolved.locale, DEFAULT_LOCALE);
    assert.equal(resolved.source, "default");
    assert.equal(
      resolved.notice,
      undefined,
      "a default run must announce nothing — the notice marks a changed run",
    );
  }
});

test("the default is en-US", () => {
  // Pinned as its own assertion: every English-string assertion in the suite
  // depends on it, so a change here has to be a deliberate edit to this test too.
  assert.equal(DEFAULT_LOCALE, "en-US");
  assert.equal(resolveRunLocale({}).locale, "en-US");
});

test("PW_LOCALE overrides the run and is canonicalised", () => {
  const resolved = resolveRunLocale({ [LOCALE_ENV_VAR]: "pt-br" });
  assert.equal(resolved.locale, "pt-BR");
  assert.equal(resolved.source, "env");
});

test("an override announces what it changed, and how to undo it", () => {
  // #1010's rule: a run whose meaning changed must say so. The three facts a
  // reader needs are the locale, that English assertions now run under it, and
  // that this does NOT translate the Langflow UI — the misreading this whole
  // mechanism exists to prevent.
  const notice = resolveRunLocale({ [LOCALE_ENV_VAR]: "pt-BR" }).notice ?? "";
  assert.match(notice, /pt-BR/);
  assert.match(notice, new RegExp(LOCALE_ENV_VAR));
  assert.match(notice, /English-string assertion/);
  assert.match(notice, /languagePreference/);
  assert.match(notice, /en-US/, "the notice must name the way back");
});

test("asking for the default explicitly changes nothing and announces nothing", () => {
  const resolved = resolveRunLocale({ [LOCALE_ENV_VAR]: "en-US" });
  assert.equal(resolved.locale, DEFAULT_LOCALE);
  assert.equal(resolved.source, "env");
  assert.equal(resolved.notice, undefined);
});

test("an unusable PW_LOCALE throws instead of falling back to English", () => {
  // Fail-closed (#1012): the alternative is a full suite running in en-US under a
  // command line that asked for something else, with nothing in the log saying so.
  for (const bad of ["pt_BR", "en-US-", "!", "en US"]) {
    assert.throws(
      () => resolveRunLocale({ [LOCALE_ENV_VAR]: bad }),
      (err: Error) =>
        err.message.includes(LOCALE_ENV_VAR) &&
        err.message.includes(JSON.stringify(bad)),
      `${bad} must be rejected, naming the variable and the value`,
    );
  }
});

test("the POSIX spelling is called out by name", () => {
  // The one slip this is actually likely to see, and the one whose fix is not
  // obvious from a RangeError.
  assert.throws(
    () => resolveRunLocale({ [LOCALE_ENV_VAR]: "pt_BR" }),
    /pt_BR/,
  );
});

test("withLocale returns a canonicalised, test.use-shaped object", () => {
  assert.deepEqual(withLocale("pt-br"), { locale: "pt-BR" });
  assert.deepEqual(withLocale("  ja  "), { locale: "ja" });
});

test("withLocale sets ONLY locale", () => {
  // Load-bearing, not cosmetic. Measured on 1.12.0.dev20: the frontend pins
  // `Accept-Language: i18n.language` on every /api/** call, so adding
  // `extraHTTPHeaders` here would override it and leave the app announcing one
  // language to the backend while rendering another — a state no product build
  // can reach, and therefore a test asserting nothing real.
  assert.deepEqual(Object.keys(withLocale("de-DE")), ["locale"]);
});

test("withLocale names itself when the tag is unusable", () => {
  assert.throws(() => withLocale("pt_BR"), /withLocale\(\)/);
  assert.throws(() => withLocale(""), /withLocale\(\)/);
});

test("the browser locale is not validated against Langflow's UI bundles", () => {
  // The two are independent axes (see locale.ts). A locale with no bundle is a
  // legitimate ask — it changes Intl formatting — and one WITH a bundle still
  // does not translate the UI, so validating against this list would be wrong in
  // both directions.
  assert.deepEqual(withLocale("it-IT"), { locale: "it-IT" });
  assert.ok(!LANGFLOW_UI_LANGUAGES.includes("it" as never));
  assert.ok(LANGFLOW_UI_LANGUAGES.includes("pt"));
});

test("canonicalLocale reports the source it was given", () => {
  assert.throws(() => canonicalLocale("nope_NOPE", "some caller"), /some caller/);
});
