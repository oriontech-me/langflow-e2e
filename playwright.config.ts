import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Base URL of the Langflow instance to test against.
 * Override via env var:
 *   PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test
 */
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7860";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 3,
  workers: process.env.CI ? 2 : undefined,
  timeout: 5 * 60 * 1000, // 5 minutes per test
  // Reporters run side by side: the standard Playwright HTML report (kept as
  // the CI artifact / local view) PLUS the Flakiness.io reporter, which uploads
  // to the dashboard. In CI we also keep `github` (annotations) and `json`
  // (results.json — consumed by the QA Platform payload and run history). The
  // Flakiness.io reporter MUST live here, not on the CLI `--reporter` flag,
  // because its `flakinessProject` option (required for GitHub OIDC upload)
  // cannot be passed via the command line.
  reporter: process.env.CI
    ? [
        ["html"],
        ["github"],
        ["json"],
        ["@flakiness/playwright", { flakinessProject: "Orion/langflow-e2e" }],
      ]
    : [
        ["html"],
        ["@flakiness/playwright", { flakinessProject: "Orion/langflow-e2e" }],
      ],

  use: {
    baseURL: BASE_URL,
    // Pin the browser context locale (and Accept-Language header) so the
    // English-string assertions throughout the suite stay stable regardless
    // of host machine settings or future i18n locale detection. See issue #225.
    locale: "en-US",
    actionTimeout: 20000,
    trace: "on-first-retry",
    screenshot: process.env.CI ? "only-on-failure" : "off",
    video: process.env.CI ? "on-first-retry" : "off",
  },

  globalTeardown: require.resolve("./tests/globalTeardown.ts"),

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        contextOptions: {
          permissions: ["clipboard-read", "clipboard-write"],
        },
      },
    },
  ],
});
