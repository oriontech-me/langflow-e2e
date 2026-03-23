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
  },
  {
    // Overrides pragmáticos: regras de estilo/padrão ficam como warning
    // e serão apertadas progressivamente nas fases 1.1 a 1.5.
    // Apenas regras que afetam CORREÇÃO dos testes ficam como error.
    files: ["tests/**/*.ts"],
    rules: {
      // Fase 1.1 — assertions modernas
      "playwright/prefer-web-first-assertions": "warn",
      "playwright/no-useless-not": "warn",
      "playwright/prefer-to-have-count": "warn",
      "playwright/prefer-to-have-length": "warn",

      // Fase 1.2 — higiene TypeScript
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "playwright/no-unused-locators": "warn",

      // Fase 1.3 — migração para API de locators
      "playwright/no-networkidle": "warn",

      // Fase 1.5 — estrutura de testes
      "playwright/no-conditional-in-test": "warn",
      "playwright/no-conditional-expect": "warn",
    },
  }
);
