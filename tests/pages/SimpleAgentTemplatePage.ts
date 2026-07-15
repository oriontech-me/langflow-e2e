import { expect, type Page } from "@playwright/test";
import { BasePage } from "./BasePage";
import { adjustScreenView } from "../helpers/ui/adjust-screen-view";
import { loadTemplateByName } from "../helpers/flows/load-template-by-name";
import { getAuthToken } from "../helpers/auth/get-auth-token";
import {
  providerConfigMap,
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

    // #751: on the 1.11 unified model selector, opening the Agent model dropdown
    // auto-binds the node's `api_key` to the DEFAULT credential (e.g.
    // ANTHROPIC_API_KEY); picking the target provider's model rebinds it to that
    // provider's credential ASYNCHRONOUSLY. A caller that opens the Playground
    // and sends a message before the rebind settles builds the selected model
    // with the wrong provider's key — surfacing as
    // "Flow build failed: Incorrect API key provided" and a `div-chat-message`
    // that never renders (the daily-#744 signature). Block until the PERSISTED
    // api_key matches the provider's credential so every caller starts settled.
    await this.waitForAgentCredentialSettled(
      flowId,
      providerConfigMap[provider].envKeys[0],
    );

    return flowId;
  }

  /**
   * Poll the persisted flow until the Agent node's `api_key` references the
   * given provider credential (e.g. `OPENAI_API_KEY`). The model-selection
   * rebind persists via a debounced autosave PATCH, so the persisted value is a
   * conservative "everything settled" signal — the in-memory canvas graph the
   * Playground build sends is updated before that PATCH lands. #751.
   */
  private async waitForAgentCredentialSettled(
    flowId: string,
    expectedCredential: string,
  ): Promise<void> {
    const auth = await getAuthToken(this.page.request);
    const headers = auth ? { Authorization: auth } : undefined;
    await expect(async () => {
      const res = await this.page.request.get(`/api/v1/flows/${flowId}`, {
        headers,
      });
      expect(res.ok()).toBe(true);
      const flow = await res.json();
      const agent = (flow?.data?.nodes ?? []).find(
        (n: { data?: { type?: string } }) => n?.data?.type === "Agent",
      );
      expect(agent?.data?.node?.template?.api_key?.value).toBe(
        expectedCredential,
      );
    }).toPass({ timeout: 20000, intervals: [500, 1000, 2000] });
  }
}
