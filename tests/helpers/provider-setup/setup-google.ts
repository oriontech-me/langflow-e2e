import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import {
  clickModelOption,
  enumerateCheckedModels,
  enumerateEnabledModels,
  enumerateModelOptions,
  openModelPickerAfterPanelClose,
  selectPinnedModelOption,
} from "./model-option";
import { enableAndSettleModelToggles } from "./model-toggle-batch";
import { openProviderPanel } from "./provider-panel-entry";
import { waitForProviderRow } from "./provider-list-state";
import { providerAlreadyConfigured } from "./provider-config-state";

export async function setupGoogle(
  page: Page,
  modelTestId?: string,
): Promise<void> {
  // Steps 1-2: Reach the Model Providers panel from the Agent node.
  // Which control the node renders depends on whether a provider is already
  // configured, and on 1.12.0.dev26 the not-configured one is no longer
  // addressable by role+name — see provider-panel-entry.ts (#1465).
  if ((await openProviderPanel(page, "Google Generative AI")) === "no-agent") return;

  // Step 3: Select the Google Generative AI provider.
  // Through waitForProviderRow (#1648): this exact call site is 8 of the 20
  // provider-row timeouts measured across the 2026-08 dailies, and every one of
  // them reported only "waiting for getByTestId(...)". Budget unchanged.
  await (
    await waitForProviderRow(page, "provider-item-Google Generative AI", 20000)
  ).click();

  // Step 4: Configure the API key — but only if the provider is not already set up.
  // A configured provider shows a "Disconnect" button with the key field masked;
  // re-saving it would append to the masked value or hit a "Variable name already
  // exists" conflict, so in that case skip straight to model selection.
  // The config panel animates in (300ms) and requires a backend fetch after the
  // provider is selected — use waitFor (retries) instead of isVisible.
  const apiKeyInput = page.getByPlaceholder("AIza...");
  await apiKeyInput.waitFor({ state: "visible", timeout: 10000 }).catch(() => {});

  // Whether the provider is ALREADY configured decides whether the key field is
  // written, and getting it wrong is expensive: filling over a configured
  // provider stores a key Langflow cannot use, and the next build fails with
  //
  //   Error calling model 'gemini-flash-latest' (INVALID_ARGUMENT): 400 …
  //   'API key not valid. Please pass a valid API key.' … API_KEY_INVALID
  //
  // which surfaces as the build observable never appearing — the recurrent
  // signature of this file on the 2026-07-09/07-14/07-15 dailies and of the
  // first attempt on 2026-08-04 (#1262). Reproduced locally: 1 failure in 7
  // runs, and the 6 clean ones all observed the provider already configured
  // with the key rendered masked.
  //
  // The old check was a 1s `isVisible` on the Disconnect button — decided while
  // the panel's own backend fetch was still in flight, so a slow fetch read as
  // "not configured". Both signals are now polled to a deadline, and a masked
  // (non-empty) key field counts as configured on its own: Langflow renders a
  // stored credential as `AIza••••…`, so a non-empty value means a credential
  // exists whether or not Disconnect has painted yet.
  const disconnectBtn = page.getByRole("button", {
    name: "Disconnect",
    exact: true,
  });
  const configuredSignal = async () =>
    providerAlreadyConfigured({
      disconnectVisible: await disconnectBtn.isVisible().catch(() => false),
      keyFieldValue: await apiKeyInput.inputValue().catch(() => ""),
    });
  // 5s, not longer: the panel's fetch resolves in well under a second, and an
  // unconfigured provider (a fresh CI container before its first setup) pays
  // this whole window on every call.
  const configuredDeadline = Date.now() + 5000;
  let alreadyConfigured = await configuredSignal();
  while (!alreadyConfigured && Date.now() < configuredDeadline) {
    await page.waitForTimeout(500);
    alreadyConfigured = await configuredSignal();
  }

  if (!alreadyConfigured && (await apiKeyInput.count()) > 0) {
    await apiKeyInput.fill(process.env.GOOGLE_API_KEY ?? "");
    await page.getByRole("button", { name: /Save|Replace|Retry/i }).click();
    // Google provider validation can take ~35s — wait for the configured state
    // (Disconnect button) so the model toggles have rendered before Step 5.
    await disconnectBtn
      .waitFor({ state: "visible", timeout: 60000 })
      .catch(() => {});
  }

  // Step 5: Enable all available models — and let the write settle.
  // Toggles only render after the provider is authenticated — waitFor retries until visible.
  // The `:visible` filter excludes toggles inside the collapsed "deprecated
  // models" section, which are mounted in the DOM but not displayed until the
  // section's "Show N deprecated models" button is clicked. Without the
  // filter, `.click()` on a hidden toggle (e.g. gemini-2.0-flash on 1.11.x)
  // retry-loops to a timeout.
  // Enabling is a TRANSACTION: the toggles are batched behind a 1000 ms debounce,
  // and closing the panel inside that window takes the flush path that never
  // refreshes the model picker (#1649). The helper clicks and then waits for the
  // product's own write to go quiet, so Step 6 below cannot close on top of it.
  // Costs nothing when nothing was clicked, which is the normal CI path.
  // The result is CAPTURED, not discarded: when this batch does not settle it is
  // the only source that can explain the picker read below, and #1651 printed it
  // to a log nothing correlates instead of carrying it forward (#1649).
  const toggleWrite = await enableAndSettleModelToggles(page);

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
  // Opening the picker is shared with the other two provider setups: closing the
  // panel (Step 6) puts the dropdown into a post-close refresh state where
  // `model_model` is briefly replaced by a (testid-less) "Loading models…" button —
  // and when the batch above never settled, that refresh never runs at all, so the
  // trigger can stay unusable for the whole budget. Both 60 s budgets, their
  // measurements, and the attribution of that case live in
  // `openModelPickerAfterPanelClose` (#1649).
  await openModelPickerAfterPanelClose(page, {
    providerLabel: "Google Generative AI",
    toggleWrite,
  });
  if (modelTestId) {
    // Resolved by option IDENTITY (data-value / data-testid), never by the option's
    // text: 1.12.0.dev26 renders a `sr-only` "N of M" counter inside each option, so
    // the anchored `^model$` text matcher this used to run matched nothing — the
    // hard failure of `language-model-regression.spec.ts` on the 2026-08-14 daily,
    // whose trace shows the model present at option 22 of 90 (#1459).
    await selectPinnedModelOption(page, {
      requested: modelTestId,
      listedModels,
      checkedModels,
      providerLabel: "Google Generative AI",
      // The third source: `checkedModels` reads the OPTIMISTIC cache, so a picker
      // miss it contradicts is only a picker defect when the write behind it landed
      // (#1649).
      toggleWrite,
    });
  } else {
    const options = await enumerateModelOptions(page);
    const gemini = options.find((option) => (option.model ?? "").includes("gemini"));
    if (!gemini) {
      await page.keyboard.press("Escape");
      throw new Error(
        `MODEL_NOT_AVAILABLE: the model picker offers no Google model — ` +
          `${options.length} option(s) enumerated: ` +
          `${options.map((option) => option.model ?? option.visibleLabel).join(", ") || "(none)"}.`,
      );
    }
    await clickModelOption(page, gemini);
  }
}
