import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import {
  clickModelOption,
  enumerateCheckedModels,
  enumerateEnabledModels,
  enumerateModelOptions,
  selectPinnedModelOption,
} from "./model-option";
import { enableAndSettleModelToggles } from "./model-toggle-batch";
import { openProviderPanel } from "./provider-panel-entry";
import { waitForProviderRow } from "./provider-list-state";

export async function setupAnthropic(
  page: Page,
  modelTestId?: string,
): Promise<void> {
  // Steps 1-2: Reach the Model Providers panel from the Agent node.
  // Which control the node renders depends on whether a provider is already
  // configured, and on 1.12.0.dev26 the not-configured one is no longer
  // addressable by role+name — see provider-panel-entry.ts (#1465).
  if ((await openProviderPanel(page, "Anthropic")) === "no-agent") return;

  // Step 3: Select the Anthropic provider.
  // Through waitForProviderRow (#1648) — same reason as the OpenAI and Google
  // helpers; Anthropic carries 3 of the 20 measured occurrences. Budget unchanged.
  await (await waitForProviderRow(page, "provider-item-Anthropic", 20000)).click();

  // Step 4: Configure the API key — but only if the provider is not already set up.
  // A configured provider shows a "Disconnect" button with the key field masked;
  // re-saving it would append to the masked value or hit a "Variable name already
  // exists" conflict, so in that case skip straight to model selection.
  // The config panel animates in (300ms) and requires a backend fetch after the
  // provider is selected — use waitFor (retries) instead of isVisible.
  const apiKeyInput = page.getByPlaceholder("sk-ant-...");
  await apiKeyInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  const alreadyConfigured = await page
    .getByRole("button", { name: "Disconnect", exact: true })
    .isVisible({ timeout: 1000 })
    .catch(() => false);

  if (!alreadyConfigured && (await apiKeyInput.count()) > 0) {
    await apiKeyInput.fill(process.env.ANTHROPIC_API_KEY ?? "");
    await page.getByRole("button", { name: /Save|Replace|Retry/i }).click();
    // Provider validation can take tens of seconds — wait for the configured
    // state (Disconnect button) so the model toggles have rendered before Step 5.
    await page
      .getByRole("button", { name: "Disconnect", exact: true })
      .waitFor({ state: "visible", timeout: 60000 })
      .catch(() => {});
  }

  // Step 5: Enable all available models — and let the write settle.
  // Toggles only render after the provider is authenticated — waitFor retries until visible.
  // Enabling is a TRANSACTION: the toggles are batched behind a 1000 ms debounce,
  // and closing the panel inside that window takes the flush path that never
  // refreshes the model picker (#1649). The helper clicks and then waits for the
  // product's own write to go quiet, so Step 6 below cannot close on top of it.
  // Costs nothing when nothing was clicked, which is the normal CI path.
  await enableAndSettleModelToggles(page);

  // Read the panel's toggles BEFORE closing it: they are the second, independent
  // source the picker can be contradicted by, and a picker miss that they
  // contradict is not an absence (#1461). BOTH are read, because "the panel lists
  // it" and "its toggle is on" are different facts and only the second one may be
  // reported as ENABLED (#1649).
  const listedModels = await enumerateEnabledModels(page);
  const checkedModels = await enumerateCheckedModels(page);

  // Step 6: Close the provider management panel
  await page.getByRole("button", { name: "Close" }).click();

  // Step 7: Select model — uses modelTestId if provided, otherwise selects the first available
  await hideInspectorPanel(page);
  // Closing the panel (Step 6) puts the model dropdown into a post-close refresh
  // state where the `model_model` trigger is briefly replaced by a (testid-less)
  // "Loading models…" button while providers and enabled models refetch. Both
  // budgets below are 60 s, and NOT to make a stall pass: taking the correct
  // flush path in Step 5 means the product genuinely re-fetches, measured at
  // 30 020 ms and 29 640 ms against the 4 327 ms the broken path returned in.
  // The click carries its own budget because it otherwise falls back to the 20 s
  // `actionTimeout` and the trigger can re-enter the loading state between
  // "visible" and the click — measured failing exactly there
  // (`locator.click: Timeout 20000ms exceeded ... getByTestId('model_model')`)
  // on the cold path with the provider on its MIN_DEFAULT_MODELS default (#1649).
  const modelTrigger = page.getByTestId("model_model");
  await modelTrigger.waitFor({ state: "visible", timeout: 60000 });
  await modelTrigger.click({ timeout: 60000 });
  if (modelTestId) {
    // Resolved by option IDENTITY (data-value / data-testid), never by the option's
    // text: 1.12.0.dev26 renders a `sr-only` "N of M" counter inside each option, so
    // the anchored `^model$` text matcher this used to run matched nothing and the
    // helper reported a model it could not match as one that does not exist (#1459).
    await selectPinnedModelOption(page, {
      requested: modelTestId,
      listedModels,
      checkedModels,
      providerLabel: "Anthropic",
    });
  } else {
    const options = await enumerateModelOptions(page);
    const claude = options.find((option) => (option.model ?? "").includes("claude"));
    if (!claude) {
      await page.keyboard.press("Escape");
      throw new Error(
        `MODEL_NOT_AVAILABLE: the model picker offers no Anthropic model — ` +
          `${options.length} option(s) enumerated: ` +
          `${options.map((option) => option.model ?? option.visibleLabel).join(", ") || "(none)"}.`,
      );
    }
    await clickModelOption(page, claude);
  }
}
