import type { Page } from "@playwright/test";
import { BasePage } from "./BasePage";
import { adjustScreenView } from "../helpers/ui/adjust-screen-view";
import {
  providerSetupMap,
  hasProviderEnvKeys,
  missingProviderEnvKeys,
  type Provider,
} from "../helpers/provider-setup";

export interface LoadSimpleAgentOptions {
  provider?: Provider;
  model?: string;
}

/**
 * Resolves which provider/model to use based on env vars:
 *
 *   MODEL_TEST_STRATEGY=all      → uses options as-is (caller iterates all DB models)
 *   MODEL_TEST_STRATEGY=provider → overrides provider with MODEL_TEST_PROVIDER
 *   MODEL_TEST_STRATEGY=model    → overrides model with MODEL_TEST_ID
 *
 * Explicit options always take precedence over env vars.
 */
function resolveModelOptions(options: LoadSimpleAgentOptions): LoadSimpleAgentOptions {
  const strategy = process.env.MODEL_TEST_STRATEGY ?? "all";

  if (options.provider || options.model) {
    return options;
  }

  if (strategy === "provider" && process.env.MODEL_TEST_PROVIDER) {
    return { provider: process.env.MODEL_TEST_PROVIDER as Provider };
  }

  if (strategy === "model" && process.env.MODEL_TEST_ID) {
    return { model: process.env.MODEL_TEST_ID };
  }

  return options;
}

export class SimpleAgentTemplatePage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async load(options: LoadSimpleAgentOptions = {}): Promise<void> {
    const resolved = resolveModelOptions(options);
    const { provider = "openai", model } = resolved;

    if (!hasProviderEnvKeys(provider)) {
      throw new Error(
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );
    }

    // Step 1: Navigate to Langflow home
    await this.page.goto("/");
    await this.page.waitForSelector('[data-testid="mainpage_title"]', {
      timeout: 30000,
    });

    // Step 2: Delete all existing flows to avoid "flow must be unique" 400 error
    const emptyPageDescription = this.page.getByTestId("empty_page_description");
    while ((await emptyPageDescription.count()) === 0) {
      const dropdown = this.page.getByTestId("home-dropdown-menu").first();
      if (!(await dropdown.isVisible({ timeout: 2000 }).catch(() => false)))
        break;
      await dropdown.click();
      await this.page.getByTestId("btn_delete_dropdown_menu").first().click();
      await this.page
        .getByTestId("btn_delete_delete_confirmation_modal")
        .first()
        .click();
      await this.page.waitForTimeout(500);
    }

    // Step 3: Open new project modal (empty page has a different button)
    const newProjectBtn = this.page.getByTestId("new-project-btn");
    const emptyBtn = this.page.getByTestId("new_project_btn_empty_page");

    if (await newProjectBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await newProjectBtn.click();
    } else {
      await emptyBtn.click();
    }

    // Step 4: Select the Simple Agent template
    await this.page.waitForSelector('[data-testid="modal-title"]', {
      timeout: 10000,
    });
    await this.page.getByTestId("side_nav_options_all-templates").click();
    await this.page.getByRole("heading", { name: "Simple Agent" }).first().click();

    await this.page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 30000,
    });

    // Step 5: Adjust canvas view and configure the provider
    await adjustScreenView(this.page);
    await providerSetupMap[provider](this.page, model);
  }
}
