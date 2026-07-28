// @ts-check
const tseslint = require("typescript-eslint");
const playwright = require("eslint-plugin-playwright");

module.exports = tseslint.config(
  {
    ignores: ["dist/", "playwright-report/", "test-results/"],
  },
  ...tseslint.configs.recommended,
  {
    ...playwright.configs["flat/recommended"],
    files: ["tests/**/*.ts"],
    // `*.test.ts` under tests/ are `node --test` unit tests for the helpers
    // (issue #1017), not Playwright specs — they assert with `node:assert`, so
    // every Playwright rule that looks for `expect()` misfires on them.
    ignores: ["tests/**/*.test.ts"],
  },
  {
    // Pragmatic overrides for the PLAYWRIGHT rules: style/pattern rules stay as
    // warnings and get tightened progressively (phases 1.1 to 1.5); only rules
    // that affect test CORRECTNESS are errors.
    //
    // Must carry the same `ignores` as the block above: referencing a
    // `playwright/*` rule for a file the plugin is not registered for is a hard
    // ESLint config error, not a no-op.
    files: ["tests/**/*.ts"],
    ignores: ["tests/**/*.test.ts"],
    rules: {
      // Phase 1.1 — modern assertions
      "playwright/prefer-web-first-assertions": "warn",
      "playwright/no-useless-not": "warn",
      "playwright/prefer-to-have-count": "warn",
      "playwright/prefer-to-have-length": "warn",

      "playwright/no-unused-locators": "warn",

      // Phase 1.3 — migration to the locators API
      "playwright/no-networkidle": "warn",

      // Phase 1.5 — test structure
      "playwright/no-conditional-in-test": "warn",
      "playwright/no-conditional-expect": "warn",
    },
  },
  {
    // Phase 1.2 — TypeScript hygiene. Kept in its own block WITHOUT the
    // `*.test.ts` exclusion: these come from tseslint's recommended set at
    // `error`, so leaving unit tests out of the downgrade made `any` a
    // PR-blocking error in `tests/**/*.test.ts` while the identical code in a
    // neighbouring spec only warned (`lint:ci` runs `--quiet`, so warnings are
    // invisible and errors are fatal). Same severity for every file under
    // tests/, unit test or spec.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  }
);
