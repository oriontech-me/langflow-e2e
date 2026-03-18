import * as dotenv from "dotenv";
import path from "path";
import { test } from "./fixtures/fixtures";
import { adjustScreenView } from "./helpers/ui/adjust-screen-view";
import { collectAndSaveModels } from "./helpers/provider-setup/collect-models";

test("collect and save all provider models to database", async ({ page }) => {
  if (!process.env.CI) {
    dotenv.config({ path: path.resolve(__dirname, "../.env") });
  }

  // Navigate to Langflow home
  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });

  // Delete all existing flows to avoid naming conflicts
  const emptyPageDescription = page.getByTestId("empty_page_description");
  while ((await emptyPageDescription.count()) === 0) {
    const dropdown = page.getByTestId("home-dropdown-menu").first();
    if (!(await dropdown.isVisible({ timeout: 2000 }).catch(() => false)))
      break;
    await dropdown.click();
    await page.getByTestId("btn_delete_dropdown_menu").first().click();
    await page
      .getByTestId("btn_delete_delete_confirmation_modal")
      .first()
      .click();
    await page.waitForTimeout(500);
  }

  // Create a new Simple Agent flow (needed to access the model dropdown)
  const newProjectBtn = page.getByTestId("new-project-btn");
  const emptyBtn = page.getByTestId("new_project_btn_empty_page");

  if (await newProjectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await newProjectBtn.click();
  } else {
    await emptyBtn.click();
  }

  await page.waitForSelector('[data-testid="modal-title"]', { timeout: 10000 });
  await page.getByTestId("side_nav_options_all-templates").click();
  await page.getByRole("heading", { name: "Simple Agent" }).first().click();

  await page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
    timeout: 30000,
  });

  await adjustScreenView(page);

  // Collect models from all providers and persist to SQLite
  await collectAndSaveModels(page);
});
