import type { Page } from "@playwright/test";
import { adjustScreenView } from "../ui/adjust-screen-view";
import { providerSetupMap, type Provider } from "../provider-setup";

export interface LoadSimpleAgentOptions {
  provider?: Provider;
  model?: string;
}

export async function loadSimpleAgent(
  page: Page,
  options: LoadSimpleAgentOptions = {},
): Promise<void> {
  const { provider = "openai", model } = options;

  await page.goto("/");
  await page.waitForSelector('[data-testid="mainpage_title"]', {
    timeout: 30000,
  });

  // Delete all existing flows to avoid "flow must be unique" 400 error
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

  // Open new project modal (empty page has a different button)
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
  await providerSetupMap[provider](page, model);
}
