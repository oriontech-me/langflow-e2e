import * as dotenv from "dotenv";
import path from "path";
import { test } from "./fixtures/fixtures";
import { collectAll } from "./helpers/provider-setup/collect-models";

if (!process.env.CI) {
  dotenv.config({ path: path.resolve(__dirname, "../.env") });
}

test("collect providers status and models from UI", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', { timeout: 30000 });

  await collectAll(page);
});
