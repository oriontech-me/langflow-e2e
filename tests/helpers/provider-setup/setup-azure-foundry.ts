import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import { openModelPickerAfterPanelClose, selectPinnedModelOption } from "./model-option";
import { azureFoundryDeclaration, ensureAzureFoundryConfigured } from "./azure-foundry";
import { langflowProviderName } from "./provider-config";

/**
 * Select an Azure AI Foundry deployment on the Agent node of the open flow (#2281).
 *
 * Unlike the keyed setups, this never opens the provider panel: the provider is
 * configured over the API (`ensureAzureFoundryConfigured`), which `globalSetup` has
 * normally already done before any worker started. Calling it again here is the
 * fallback for a run whose pre-configuration did not happen, and costs one
 * variables read plus one enable when it did.
 *
 * When that fallback had to CREATE a variable, the page loaded before the provider
 * existed and its model options are stale, so the page is reloaded before the picker
 * is opened. And when the picker still does not offer the deployment — another worker
 * may have made the write this page loaded before — it reloads once more before
 * calling it absent, because an absence becomes a SKIP in the callers.
 *
 * The deployment is chosen in the picker — never written into the flow by name —
 * because the picker's options carry the live listing's metadata, and that metadata
 * is what keeps `temperature` out of a `gpt-5*` call (see `azure-foundry.ts`).
 */
export async function setupAzureFoundry(page: Page, modelTestId?: string): Promise<void> {
  const modelDropdown = page.getByTestId("model_model");
  const setupProviderBtn = page.getByRole("button", { name: "Setup Provider" });
  if ((await modelDropdown.count()) === 0 && (await setupProviderBtn.count()) === 0) {
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

  const result = await ensureAzureFoundryConfigured(page.request);
  if (!result.configured) {
    throw new Error(
      `AZURE_FOUNDRY_NOT_CONFIGURED: Azure AI Foundry could not be configured in ` +
        `Langflow — ${result.detail}. The provider was validated against Azure by ` +
        `collect-models, so a failure here is Langflow's side of the configuration.`,
    );
  }
  if (result.wrote) {
    await page.reload();
    await modelDropdown.waitFor({ state: "visible", timeout: 60000 });
  }

  const providerLabel = langflowProviderName("azure-ai-foundry");
  const requested = modelTestId ?? declaration.deployment;
  await hideInspectorPanel(page);
  await openModelPickerAfterPanelClose(page, { providerLabel });
  const first = await selectPinnedModelOption(page, {
    requested,
    providerLabel,
    absentBehavior: "return",
  });
  if (first.status === "selected") return;

  // `wrote` is false when ANOTHER worker created the variables (a duplicate 400), so a
  // page loaded before that write can still hold the pre-configuration option list.
  // One reload before calling the deployment absent: an `absent` verdict carries the
  // MODEL_NOT_AVAILABLE prefix that callers turn into a SKIP, and a stale cache must
  // not become one.
  await page.reload();
  await modelDropdown.waitFor({ state: "visible", timeout: 60000 });
  await hideInspectorPanel(page);
  await openModelPickerAfterPanelClose(page, { providerLabel });
  await selectPinnedModelOption(page, { requested, providerLabel, absentBehavior: "throw" });
}
