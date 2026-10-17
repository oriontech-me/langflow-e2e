import type { Page } from "@playwright/test";
import { azureFoundryDeclaration, ensureAzureFoundryConfigured } from "./azure-foundry";
import { hasAgentModelControl, selectOnDemandModel } from "./on-demand-provider";
import { langflowProviderName } from "./provider-config";

/**
 * Select an Azure AI Foundry deployment on the Agent node of the open flow (#2281).
 *
 * Unlike the keyed setups, this never opens the provider panel: the provider is
 * configured over the API (`ensureAzureFoundryConfigured`), which `globalSetup` has
 * normally already done before any worker started — see `selectOnDemandModel` for the
 * fallback and its recovery ladder. A MODEL_TEST_ID that names no real deployment fails
 * there as AZURE_FOUNDRY_ENABLE_LOST or AZURE_FOUNDRY_NOT_CONFIGURED, never as a skip.
 *
 * The deployment is chosen in the picker — never written into the flow by name —
 * because the picker's options carry the live listing's metadata, and that metadata
 * is what keeps `temperature` out of a `gpt-5*` call (see `azure-foundry.ts`).
 */
export async function setupAzureFoundry(page: Page, modelTestId?: string): Promise<void> {
  if (!(await hasAgentModelControl(page))) {
    console.log("No Agent node found on canvas — skipping Azure AI Foundry setup.");
    return;
  }

  const declaration = azureFoundryDeclaration();
  if (!declaration.declared) {
    throw new Error(
      `AZURE_FOUNDRY_NOT_DECLARED: ${declaration.missing.join(", ")} not set — the ` +
        `deployment to run cannot be inferred.`,
    );
  }

  const requested = modelTestId ?? declaration.deployment;
  await selectOnDemandModel(page, {
    providerLabel: langflowProviderName("azure-ai-foundry"),
    requested,
    modelNoun: "deployment",
    code: "AZURE_FOUNDRY",
    validatedBy: "Azure",
    configure: (fresh) =>
      ensureAzureFoundryConfigured(page.request, process.env, fresh ? new Set() : undefined, requested),
  });
}
