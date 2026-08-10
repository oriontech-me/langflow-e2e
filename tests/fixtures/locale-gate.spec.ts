// Behavioural gate for the browser-locale parameterisation (#1400).
//
// The pure resolution lives next door in `locale.test.ts`, where
// `npm run test:units` covers it, and `playwright.config.test.ts` pins the
// wiring at config level. What THIS pins is the only half neither can reach:
// that the resolved value actually arrives in a **browser context**, and that
// `withLocale()` overrides it there.
//
// Both sibling policy modules in this directory ship exactly this pairing —
// `http-error-policy.ts` + `http-error-gate.spec.ts`, `flow-error-policy.ts` +
// `flow-error-gate.spec.ts`. Without it the runtime half is provable only by a
// throwaway script somebody runs once by hand, and nothing in CI notices the day
// Playwright renames the option or a project-level `use` starts shadowing it.
//
// It navigates nowhere and needs no Langflow state: `navigator.language` and
// `Intl` are answerable on the blank page every test starts on.
//
// TWO THINGS IT DELIBERATELY DOES NOT ASSERT:
//  - that Langflow's UI stays English under a non-default locale. It does
//    (measured on 1.12.0.dev20, and `CONTRIBUTING.md` records why), but the day
//    upstream adds locale detection that becomes a product change worth a
//    dedicated i18n spec's verdict — not a red in the daily's fixture gate.
//  - the `Accept-Language` the backend ends up seeing. That is a per-request
//    split between the frontend's axios interceptor and the context locale
//    (17 / 3 on the home screen); a spec whose subject is the backend's locale
//    sets the header explicitly. See `locale.ts`, axis 3.
import { expect, test } from "./fixtures";
import { DEFAULT_LOCALE, resolveRunLocale, withLocale } from "./locale";

// Not hardcoded to en-US: under `PW_LOCALE=pt-BR` the whole run legitimately
// moves, and a gate asserting the constant would fail the exact scenario the
// parameterisation exists for. This is also what catches a project-level
// `use.locale`, which would shadow the resolved value while every unit test
// stays green.
const EXPECTED_RUN_LOCALE = resolveRunLocale().locale;

test.describe("browser locale — the resolved default reaches the context", () => {
  test(
    "the run executes under the resolved locale",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      expect(await page.evaluate(() => navigator.language)).toBe(
        EXPECTED_RUN_LOCALE,
      );
    },
  );

  test(
    "an untouched run is en-US",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      // The suite's English-string assertions depend on this, so it is asserted
      // as itself rather than inferred from the test above — but skipped when the
      // operator asked for something else, which is not a failure.
      test.skip(
        EXPECTED_RUN_LOCALE !== DEFAULT_LOCALE,
        `PW_LOCALE moved this run to ${EXPECTED_RUN_LOCALE}`,
      );
      expect(await page.evaluate(() => navigator.language)).toBe("en-US");
    },
  );
});

test.describe("browser locale — withLocale() opts a describe block out", () => {
  test.use(withLocale("pt-BR"));

  test(
    "the opted-in block runs under its own locale, whatever the run's is",
    { tag: ["@stable", "@regression"] },
    async ({ page }) => {
      expect(await page.evaluate(() => navigator.language)).toBe("pt-BR");
      // Asserted through `Intl` as well as `navigator.language`: the option is
      // only worth having because it changes formatting, and a stub that set the
      // navigator property alone would pass the line above.
      expect(await page.evaluate(() => new Date(0).toLocaleString())).toContain(
        "31/12/1969",
      );
    },
  );
});
