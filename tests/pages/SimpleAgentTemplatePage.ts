import type { Page } from "@playwright/test";
import { BasePage } from "./BasePage";
import { adjustScreenView } from "../helpers/ui/adjust-screen-view";
import { loadTemplateByName } from "../helpers/flows/load-template-by-name";
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

  /**
   * Loads the Simple Agent template and configures the provider. Returns the
   * created flow's id (from `loadTemplateByName`) so callers can delete only
   * that flow in their teardown — never a global `cleanAllFlows`, which races
   * concurrent tests in the fully-parallel suite (#515).
   */
  async load(options: LoadSimpleAgentOptions = {}): Promise<string> {
    const { provider = "openai", model } = options;

    if (!hasProviderEnvKeys(provider)) {
      throw new Error(
        `Missing env vars for provider "${provider}": ${missingProviderEnvKeys(provider).join(", ")}`,
      );
    }

    // Load the Simple Agent template onto the canvas (opens the templates modal,
    // handles the 1.10.0 welcome overlay). Deliberately does NOT clear existing
    // flows — the cross-worker wipe was removed in #553.
    const flowId = await loadTemplateByName(this.page, "Simple Agent");

    // Adjust canvas view and configure the provider.
    // JSON stores model names (e.g. "claude-opus-4-6") — passed directly to setup for hasText matching
    await adjustScreenView(this.page);
    await providerSetupMap[provider](this.page, model);

    return flowId;
  }
}
