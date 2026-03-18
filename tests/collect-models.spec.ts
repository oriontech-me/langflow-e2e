import * as dotenv from "dotenv";
import path from "path";
import { test } from "./fixtures/fixtures";
import { collectAndSaveModels } from "./helpers/provider-setup/collect-models";

test("collect and save all provider models to database", async ({ page }) => {
  if (!process.env.CI) {
    dotenv.config({ path: path.resolve(__dirname, "../.env") });
  }

  // Step 1: Navigate to Langflow home
  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });

  // Step 2: Collect all provider models via Settings and save to SQLite
  await collectAndSaveModels(page);
});
