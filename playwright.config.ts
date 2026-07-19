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
  retries: process.env.CI ? 2 : 3,
  // One worker per shard when sharding: each shard has its OWN dedicated langflow,
  // so a second worker would just reintroduce the 2-workers→1-backend contention
  // #817 diagnosed. Parallelism comes from the shard count, not the worker count.
  // Non-sharded CI keeps 2 workers; local dev stays auto.
  workers: process.env.PW_SHARD_FILE_LEVEL ? 1 : process.env.CI ? 2 : undefined,
  timeout: 5 * 60 * 1000, // 5 minutes per test
  reporter: process.env.CI ? "blob" : "html",

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
