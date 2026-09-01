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
  // Steps 1-2: Reach the Model Providers panel from the Agent node.
  // Which control the node renders depends on whether a provider is already
  // configured, and on 1.12.0.dev26 the not-configured one is no longer
  // addressable by role+name — see provider-panel-entry.ts (#1465).
  if ((await openProviderPanel(page, "OpenAI")) === "no-agent") return;

  // Step 3: Select the OpenAI provider.
  // Waited through waitForProviderRow so a row that never arrives names the
  // provider list's own state instead of timing out anonymously (#1648): the
  // 20 s budget below is `actionTimeout`, unchanged — what changes is that a
  // wedged instance says PROVIDER_LIST_STALLED rather than
  // "waiting for getByTestId('provider-item-OpenAI')".
  await (await waitForProviderRow(page, "provider-item-OpenAI", 20000)).click();

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

  // Step 5: Enable all available models — and let the write settle.
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

  // Step 7: Select model — uses modelTestId if provided, otherwise selects the first available.
  // Closing the management panel (Step 6) puts the model dropdown into a
  // post-close refresh state where the `model_model` trigger is briefly
  // replaced by a (testid-less) "Loading models…" button while providers and
  // enabled models refetch. Wait for the trigger to be VISIBLE — not merely
  // attached — so the click does not race that loading swap.
  await hideInspectorPanel(page);
  const modelTrigger = page.getByTestId("model_model");
  // 60 s, not the 15 s this used to allow, and NOT to make a stall pass: taking the
  // correct flush path above means the product genuinely re-fetches, measured at
  // 30 020 ms and 29 640 ms against the 4 327 ms the broken path returned in
  // (#1649). The old budget would turn the fix into a model_model timeout.
  await modelTrigger.waitFor({ state: "visible", timeout: 60000 });
  // The click carries its own 60 s budget for the same measured reason as the
  // waitFor above, and NOT as a retry bolted on to make a red pass: `click()`
  // otherwise falls back to the 20 s `actionTimeout`, and the trigger re-enters the
  // loading state between "visible" and the click while the refresh this helper
  // correctly triggered is still running. Measured failing exactly there —
  // `locator.click: Timeout 20000ms exceeded ... waiting for
  // getByTestId('model_model')` — on the cold path with the provider on its
  // MIN_DEFAULT_MODELS default (#1649). The locator is re-resolved on every
  // actionability retry, so this survives the element being replaced, and nothing
  // about the assertion that follows is weakened.
  await modelTrigger.click({ timeout: 60000 });
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
      listedModels,
      checkedModels,
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
      await modelTrigger.waitFor({ state: "visible", timeout: 60000 });
      await modelTrigger.click({ timeout: 60000 });
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
