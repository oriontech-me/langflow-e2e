import type { Page } from "@playwright/test";
import { ensureOpenRouterConfigured, OPENROUTER_PREFERRED_MODELS, openRouterKey } from "./openrouter";
import { hasAgentModelControl, selectOnDemandModel } from "./on-demand-provider";
import { langflowProviderName } from "./provider-config";

/**
 * Select an OpenRouter model on the Agent node of the open flow (#2292).
 *
 * Never opens the provider panel: OpenRouter is configured over the API
 * (`ensureOpenRouterConfigured`), which `globalSetup` has normally already done before
 * any worker started — see `selectOnDemandModel` for the fallback and its recovery
 * ladder. The panel stays unconfigured for the specs that need it so (`openrouter.ts`).
 *
 * With no `modelTestId` it runs the first preferred model: a caller that names none is
 * asking for "OpenRouter", and the preference list is what collect-models validated.
 */
export async function setupOpenRouter(page: Page, modelTestId?: string): Promise<void> {
  if (!(await hasAgentModelControl(page))) {
    console.log("No Agent node found on canvas — skipping OpenRouter setup.");
    return;
  }
  if (!openRouterKey()) {
    throw new Error("OPENROUTER_NOT_DECLARED: OPENROUTER_API_KEY not set — OpenRouter cannot be configured.");
  }

  const requested = modelTestId ?? OPENROUTER_PREFERRED_MODELS[0];
  await selectOnDemandModel(page, {
    providerLabel: langflowProviderName("openrouter"),
    requested,
    modelNoun: "model",
    code: "OPENROUTER",
    validatedBy: "OpenRouter",
    configure: (fresh) =>
      ensureOpenRouterConfigured(page.request, requested, process.env, fresh ? new Set() : undefined),
  });
}
