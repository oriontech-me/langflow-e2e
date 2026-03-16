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
  reporter: process.env.CI ? "blob" : "html",

  use: {
    baseURL: BASE_URL,
    actionTimeout: 20000,
    trace: "on-first-retry",
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
