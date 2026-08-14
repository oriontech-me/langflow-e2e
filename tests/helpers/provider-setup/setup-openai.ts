import type { Page } from "@playwright/test";
import { hideInspectorPanel } from "../ui/hide-inspector-panel";
import {
  clickModelOption,
  enumerateEnabledModels,
  enumerateModelOptions,
  selectPinnedModelOption,
} from "./model-option";

export async function setupOpenAI(
  page: Page,
  modelTestId?: string,
  opts?: {
    // When the requested model is not in the live dropdown, fall through to
    // the UI preference-ranking below instead of throwing MODEL_NOT_AVAILABLE.
    // Used by initialGPTsetup (#606): its pin comes from models.json, which
    // can be stale — its consumers must degrade, not fail. The in-dropdown
    // fallback matters: closing (Escape) and re-opening the dropdown for a
    // retry races the providers refetch and clicks a detached option.
    fallbackToRanking?: boolean;
  },
): Promise<void> {
  // Step 1: Find the entry point into the provider management panel.
  // "model_model" exists only when a provider is already configured.
  // When no provider is configured yet, the field renders a plain "Setup Provider"
  // button (no data-testid) that opens the management modal directly.
  const modelDropdown = page.getByTestId("model_model");
  const setupProviderBtn = page.getByRole("button", { name: "Setup Provider" });

  const hasModelDropdown = (await modelDropdown.count()) > 0;
  const hasSetupButton = (await setupProviderBtn.count()) > 0;

  if (!hasModelDropdown && !hasSetupButton) {
    console.log("No Agent node found on canvas — skipping OpenAI setup.");
    return;
  }

  // Step 2: Open the model provider management panel
  if (hasModelDropdown) {
    // A selected node opens a right-side Inspector Panel that overlaps the
    // model dropdown on 1.11.x+ — close it so the click is not intercepted.
    await hideInspectorPanel(page);
    await modelDropdown.click();
    await page.getByTestId("manage-model-providers").click();
  } else {
    await setupProviderBtn.click();
  }

  // Step 3: Select the OpenAI provider
  await page.getByTestId("provider-item-OpenAI").click();

  // Step 4: Save the API key if the config panel is visible.
  // The config panel animates in (300ms) and requires a backend fetch after the provider
  // is selected — use waitFor (retries) instead of isVisible (immediate snapshot).
  // The save button was renamed from "Save Configuration" to "Save" / "Replace" / "Retry".
  const apiKeyInput = page.getByPlaceholder("sk-...");
  const apiKeyInputVisible = await apiKeyInput
    .waitFor({ state: "visible", timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  if (apiKeyInputVisible) {
    // Configure the key only when the provider is NOT already set up. A fresh
    // instance (CI) shows a "Save" button; an already-configured provider (a
    // persisted credential from a prior local run or the instance boot env)
    // shows "Replace". Clicking "Replace" re-saves the credential, which returns
    // 400 Bad Request on PATCH /api/v1/variables/{id} — harmless (the existing
    // valid key is reused) but it trips the fixture's backend-error monitor and
    // fails the determinism gate on repeat local runs (#751). Skip the re-save
    // when the provider is already configured.
    const alreadyConfigured = await page
      .getByRole("button", { name: /^Replace$/i })
      .isVisible({ timeout: 2000 })
      .catch(() => false);
    if (!alreadyConfigured) {
      await apiKeyInput.fill(process.env.OPENAI_API_KEY ?? "");
      await page.getByRole("button", { name: /^(Save|Retry)$/i }).click();
    }
  }

  // Step 5: Enable all available OpenAI models.
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

  // Step 7: Select model — uses modelTestId if provided, otherwise selects the first available.
  // Closing the management panel (Step 6) puts the model dropdown into a
  // post-close refresh state where the `model_model` trigger is briefly
  // replaced by a (testid-less) "Loading models…" button while providers and
  // enabled models refetch. Wait for the trigger to be VISIBLE — not merely
  // attached — so the click does not race that loading swap.
  await hideInspectorPanel(page);
  const modelTrigger = page.getByTestId("model_model");
  await modelTrigger.waitFor({ state: "visible", timeout: 15000 });
  await modelTrigger.click();
  let pickByRanking = !modelTestId;
  if (modelTestId) {
    // Resolved by option IDENTITY (data-value / data-testid), never by the option's
    // text: 1.12.0.dev26 renders a `sr-only` "N of M" counter inside each option, so
    // the anchored `^model$` text matcher this used to run matched nothing (#1459).
    //
    // `fallbackToRanking` degrades on an ESTABLISHED absence only — a stale pin from
    // models.json is what #606 asked it to survive. A picker that is empty, or that
    // offers the model without letting the suite select it, throws through this call:
    // degrading there would hide a suite defect behind a healthy-looking run (#1461).
    const selection = await selectPinnedModelOption(page, {
      requested: modelTestId,
      enabledModels,
      providerLabel: "OpenAI",
      absentBehavior: opts?.fallbackToRanking ? "return" : "throw",
    });
    if (selection.status === "absent") {
      console.log(
        `pinned model "${modelTestId}" is not offered by the live dropdown — falling back to ` +
          `UI preference-ranking (#606). ${selection.message}`,
      );
      pickByRanking = true;
      // The Escape that reported the absence closed the dropdown; reopen it for the
      // ranking pass below.
      await modelTrigger.waitFor({ state: "visible", timeout: 15000 });
      await modelTrigger.click();
    }
  }
  if (pickByRanking) {
    // No explicit model requested — pick a fast, general-purpose model from the
    // enabled dropdown. Hardcoding a single name (previously "gpt-4o-mini")
    // breaks whenever that model leaves the lineup on gpt-5.x nightlies. Instead
    // we rank the available options by a preference list and only fall back to
    // the first available if none match. This keeps the default cheap and
    // vision-capable — callers like the agent image test rely on that — while
    // surviving model-family churn and skipping the slow/expensive
    // "pro"/reasoning models that tend to top the dropdown.
    // Ranked over the option IDENTITY, not its rendered text: since dev26 the text
    // carries a `sr-only` "N of M" counter, so `textContent` is no longer the model
    // name (#1459). Lower-cased so matching survives display casing.
    const optionEntries = await enumerateModelOptions(page);
    if (optionEntries.length === 0) {
      await page.keyboard.press("Escape");
      throw new Error(
        "MODEL_PICKER_DEFECT: the model picker rendered ZERO options after configuring " +
          "OpenAI, so no model could be ranked. An empty picker means the credential was " +
          "not saved (a rejected or drained key) or the list never loaded — reported as a " +
          "FAILURE, not a silent default (#1461).",
      );
    }
    const labels = optionEntries.map((option) =>
      (option.model ?? option.visibleLabel).trim().toLowerCase(),
    );

    // Reject families that are NOT general-purpose vision chat models: reasoning
    // (o1/o3/o4…), audio/realtime/tts/transcribe, search-preview and nano
    // variants. Substring "gpt-4o-mini" alone would otherwise match e.g.
    // "gpt-4o-mini-tts" or rank a text-only "o3-mini" as a fallback, breaking
    // callers like the agent image test that need real vision output.
    const nonChat = /\bo\d|audio|realtime|tts|transcribe|search|nano/;

    // Ordered most- to least-preferred. All target small multimodal chat models;
    // anything not matched (pro, reasoning, codex) is only reached via the
    // first-available fallback.
    const preferences: Array<(m: string) => boolean> = [
      (m) => m.includes("gpt-4o-mini") && !nonChat.test(m),
      (m) => m.includes("-mini") && !nonChat.test(m),
      (m) => m.includes("gpt-4o") && !nonChat.test(m),
      (m) => m.includes("gpt-4.1") && !nonChat.test(m),
    ];

    let chosenIndex = -1;
    for (const matches of preferences) {
      const idx = labels.findIndex(matches);
      if (idx !== -1) {
        chosenIndex = idx;
        break;
      }
    }
    if (chosenIndex === -1) chosenIndex = 0; // no preferred match — first available

    await clickModelOption(page, optionEntries[chosenIndex]);
  }
}
