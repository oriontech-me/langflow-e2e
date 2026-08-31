import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import {
  clickModelOption,
  enumerateEnabledModels,
  enumerateModelOptions,
  selectPinnedModelOption,
} from "./model-option";
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

  // Step 5: Enable all available Anthropic models.
  // Toggles only render after the provider is authenticated — waitFor retries until visible.
  // The `:visible` filter excludes toggles inside the collapsed "deprecated
  // models" section, which are mounted in the DOM but not displayed until the
  // section's "Show N deprecated models" button is clicked. Without the
  // filter, `.click()` on a hidden toggle retry-loops to a timeout.
  const toggles = page.locator('[data-testid^="llm-toggle"]:visible');
  await toggles.first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  const toggleCount = await toggles.count();

  for (let i = 0; i < toggleCount; i++) {
    const toggle = toggles.nth(i);
    const isChecked = (await toggle.getAttribute("aria-checked")) === "true";
    if (!isChecked) {
      await toggle.click();
    }
  }

  // Read the panel's toggles BEFORE closing it: they are the second, independent
  // source for "this model exists and is enabled", and a picker miss that this
  // list contradicts is not an absence (#1461).
  const enabledModels = await enumerateEnabledModels(page);

  // Step 6: Close the provider management panel
  await page.getByRole("button", { name: "Close" }).click();

  // Step 7: Select model — uses modelTestId if provided, otherwise selects the first available
  await hideInspectorPanel(page);
  await page.getByTestId("model_model").click();
  if (modelTestId) {
    // Resolved by option IDENTITY (data-value / data-testid), never by the option's
    // text: 1.12.0.dev26 renders a `sr-only` "N of M" counter inside each option, so
    // the anchored `^model$` text matcher this used to run matched nothing and the
    // helper reported a model it could not match as one that does not exist (#1459).
    await selectPinnedModelOption(page, {
      requested: modelTestId,
      enabledModels,
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
