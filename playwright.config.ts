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
  // File-level sharding for the daily's sharded run keeps every test() of a spec
  // file in one shard (so @database state-sharing holds). The sharded job sets
  // PW_SHARD_FILE_LEVEL=1; local dev / nightly / manual keep test-level parallelism.
  fullyParallel: process.env.PW_SHARD_FILE_LEVEL ? false : true,
  forbidOnly: !!process.env.CI,
  // PLAYWRIGHT_RETRIES overrides the retry count when set (e.g. a manual
  // validation dispatch passing 0 for a fast, unamplified signal); empty/unset
  // falls back to the default (2 in CI, 3 locally).
  retries:
    process.env.PLAYWRIGHT_RETRIES !== undefined &&
    process.env.PLAYWRIGHT_RETRIES !== ""
      ? Number(process.env.PLAYWRIGHT_RETRIES)
      : process.env.CI
        ? 2
        : 3,
  // 2 workers in CI (sharded or not). The #817 contention was 2 workers hitting
  // ONE langflow that served the whole 353-test suite; with a dedicated langflow
  // per shard (~90 tests each) the 2nd worker is a net win — benchmarked at ~28min
  // (workers=2) vs ~39min (workers=1) at N=4, correctness identical. See
  // ISSUE-833-SHARDING-DESIGN.md §"workers per shard".
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

  globalSetup: require.resolve("./tests/globalSetup.ts"),
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
