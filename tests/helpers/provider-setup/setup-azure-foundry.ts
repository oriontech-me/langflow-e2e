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
 * fallback for a run whose pre-configuration did not happen. When it did, the first
 * call in a worker costs one variables read plus one enable — which Langflow turns
 * into a blocking validation call to Azure — and every later call the read alone.
 *
 * When that fallback had to CREATE a variable, the page loaded before the provider
 * existed and its model options are stale, so the page is reloaded before the picker
 * is opened. And when the picker still does not offer the deployment — another worker
 * may have made the write this page loaded before, or a concurrent enable for another
 * provider may have dropped it — it re-enables it and reloads once more before calling
 * it absent, because an absence becomes a SKIP in the callers.
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

  const providerLabel = langflowProviderName("azure-ai-foundry");
  const requested = modelTestId ?? declaration.deployment;
  const result = await ensureAzureFoundryConfigured(page.request, process.env, undefined, requested);
  if (!result.configured) {
    throw new Error(
      `AZURE_FOUNDRY_NOT_CONFIGURED: Azure AI Foundry could not be configured in ` +
        `Langflow — ${result.detail}. The provider was validated against Azure by ` +
        `collect-models, so a failure here is Langflow's side of the configuration.`,
    );
  }
  if (result.wrote) await reloadToAgent(page);

  const pick = async (): Promise<boolean> => {
    await hideInspectorPanel(page);
    await openModelPickerAfterPanelClose(page, { providerLabel });
    const outcome = await selectPinnedModelOption(page, {
      requested,
      providerLabel,
      providerStrict: true,
      absentBehavior: "return",
    });
    return outcome.status === "selected";
  };
  if (await pick()) return;

  // 1. A stale page. `wrote` is false when ANOTHER worker created the variables (a
  //    duplicate 400), so a page loaded before that write can still hold the
  //    pre-configuration option list. A reload alone settles it, with no call to Azure.
  await reloadToAgent(page);
  if (await pick()) return;

  // 2. A lost enable. The enabled set is one per-user variable that every
  //    `enabled_models` POST reads, validates for seconds and rewrites whole, so a
  //    concurrent enable for another provider can save a list without the deployment,
  //    and the per-worker memo would never send it again. Re-enable for real (a fresh
  //    memo), then look once more.
  const again = await ensureAzureFoundryConfigured(page.request, process.env, new Set(), requested);
  if (!again.configured) {
    throw new Error(
      `AZURE_FOUNDRY_NOT_CONFIGURED: the picker did not offer deployment "${requested}", ` +
        `and re-enabling it failed — ${again.detail}. The provider was validated against ` +
        `Azure by collect-models, so a failure here is Langflow's side of the configuration.`,
    );
  }
  await reloadToAgent(page);
  if (await pick()) return;

  // Never a skip: the server has just echoed the deployment as enabled, so its absence
  // from the picker is not an absent model. A MODEL_NOT_AVAILABLE here would let the
  // callers skip the test on exactly the lane this provider exists for.
  throw new Error(
    `AZURE_FOUNDRY_ENABLE_LOST: deployment "${requested}" was enabled (the server echoed ` +
      `it) but the Agent's model picker still does not offer it for ${providerLabel} after ` +
      `a reload — the enabled set was rewritten again by a concurrent request, or the ` +
      `picker does not read it. Reported as a FAILURE, not a skip (#1012).`,
  );
}

async function reloadToAgent(page: Page): Promise<void> {
  await page.reload();
  await page.getByTestId("model_model").waitFor({ state: "visible", timeout: 60000 });
}
