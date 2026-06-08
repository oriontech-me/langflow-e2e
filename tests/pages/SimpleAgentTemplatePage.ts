import type { Page } from "@playwright/test";
import { BasePage } from "./BasePage";
import { adjustScreenView } from "../helpers/ui/adjust-screen-view";
import { dismissWelcomeOverlayAndWaitForModal } from "../helpers/flows/open-new-flow-templates-modal";
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

export class SimpleAgentTemplatePage extends BasePage {
  constructor(page: Page) {
    super(page);
  }

  async load(options: LoadSimpleAgentOptions = {}): Promise<void> {
    const { provider = "openai", model } = options;

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
    let deletedFlowsCount = 0;
    while ((await emptyPageDescription.count()) === 0) {
      const dropdown = this.page.getByTestId("home-dropdown-menu").first();
      if (!(await dropdown.isVisible({ timeout: 2000 }).catch(() => false)))
        break;
      await dropdown.click();
      await this.page.getByTestId("btn_delete_dropdown_menu").first().waitFor({ state: "visible", timeout: 5000 });
      await this.page.getByTestId("btn_delete_dropdown_menu").first().click();
      await this.page
        .getByTestId("btn_delete_delete_confirmation_modal")
        .first()
        .click();
      await this.page.waitForTimeout(500);
      deletedFlowsCount++;
    }
    if (deletedFlowsCount > 0) {
      console.warn(`[SimpleAgentTemplatePage] ${deletedFlowsCount} flow(s) deletado(s) antes de carregar o template.`);
    }

    // Step 3: Open a new flow via whichever entry point the home page exposes:
    // the header "New Flow" button (when flows exist) or the empty-page CTA
    // (after the deletion loop above). `.or()` + the auto-waiting click absorbs
    // the brief window where the just-closed delete-confirmation modal's
    // backdrop is still fading and would intercept a premature click.
    const newProjectBtn = this.page.getByTestId("new-project-btn");
    const emptyBtn = this.page.getByTestId("new_project_btn_empty_page");
    await newProjectBtn.or(emptyBtn).first().click({ timeout: 15000 });

    // Step 4: Select the Simple Agent template.
    // Clicking "New Flow" on 1.10.0 may navigate to a freshly-created flow and
    // surface the FlowBuilderWelcome overlay instead of the templates modal —
    // reconcile both via the shared helper before reading the modal.
    await dismissWelcomeOverlayAndWaitForModal(this.page);
    await this.page.getByTestId("side_nav_options_all-templates").click();
    await this.page.getByRole("heading", { name: "Simple Agent" }).first().click();

    await this.page.waitForSelector('[data-testid="canvas_controls_dropdown"]', {
      timeout: 30000,
    });

    // Step 5: Adjust canvas view and configure the provider
    // JSON stores model names (e.g. "claude-opus-4-6") — passed directly to setup for hasText matching
    await adjustScreenView(this.page);
    await providerSetupMap[provider](this.page, model);
  }
}
