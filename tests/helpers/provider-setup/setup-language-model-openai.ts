import { type Locator, type Page, expect } from "@playwright/test";
import { enumerateModelOptions } from "./model-option";
import { waitForProviderRow } from "./provider-list-state";

// Cheap, fast chat models in priority order. `gpt-4o-mini` is kept first so older
// Langflow builds still match; the `gpt-5.x` entries cover newer builds (1.11.0+)
// where `gpt-4o-mini` was dropped from the OpenAI bundle. Reasoning-/image-/audio-heavy
// models are deliberately excluded so the memory test stays fast and deterministic
// (a slow model would reintroduce the 120s-response timeout flake from issue #354).
const PREFERRED_CHAT_MODELS = [
  "gpt-4o-mini",
  "gpt-5.4-nano",
  "gpt-5-nano",
  "gpt-5.4-mini",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-5.4",
  "gpt-5.5",
];

// Substrings marking a non-chat model (image, embeddings, audio, …) — never select these.
const NON_CHAT_MODEL = /image|embedding|audio|tts|realtime|whisper|dall-?e|moderation|transcribe/i;

// Chat-capable but too slow/expensive for a fast regression run: reasoning "pro"
// tiers, the o-series reasoning models, codex, deep-research and search-preview
// variants. Never auto-selected — the OpenAI dropdown lists `gpt-5.5-pro` first, so
// without this guard the fallback (or a silently-failed selection) lands on it and a
// slow/empty reasoning response reintroduces the 120s timeout and masks assertions.
const AVOID_MODEL = /(^|[-\s])(pro|o1|o3|o4)([-\s]|$)|codex|deep-research|search-preview/i;

// Selects a usable OpenAI chat model from the already-open `model_model` dropdown.
// Resolution order: MODEL_TEST_ID env override → first available preferred model →
// first option that is neither a non-chat nor an avoided (pro/reasoning) model.
// Throws with the observed options if none fit. After selecting, verifies the trigger
// actually reflects the choice — a silently-intercepted click (the api_key popover can
// steal the click) would otherwise leave the node on its default (`gpt-5.5-pro`).
async function selectPreferredChatModel(page: Page): Promise<void> {
  // Read the options by IDENTITY (data-value / data-testid), not by their rendered
  // text: since 1.12.0.dev26 each option carries a `sr-only` "N of M" counter, so
  // `allInnerTexts()` returned "claude-opus-5\n1 of 69" and the anchored click below
  // could never resolve — the 20s timeout of `memory-history-regression.spec.ts` on
  // the 2026-08-14 daily (#1459).
  const entries = await enumerateModelOptions(page, 15000);
  const labels = entries
    .map((option) => (option.model ?? option.visibleLabel).trim())
    .filter(Boolean);

  const envModel = process.env.MODEL_TEST_ID?.trim();
  const chosen =
    (envModel && labels.find((label) => label === envModel)) ||
    PREFERRED_CHAT_MODELS.find((model) => labels.includes(model)) ||
    // Prefer any OpenAI (`gpt-*`) chat option before the provider-agnostic
    // last-resort fallback below: the 1.11+ unified ModelInput dropdown mixes
    // providers and lists the Anthropic default (`claude-sonnet-5`) first, so
    // that fallback used to hand back a non-OpenAI model from a helper named
    // `...OpenAI` whenever PREFERRED_CHAT_MODELS drifted behind the build's
    // curated list (issue #961).
    // A deprecated model is not what a regression run wants: it used to be excluded
    // by rejecting a multi-line label (the badge renders inside the option), a test
    // that dev26's counter made true for EVERY option. The badge is now read from
    // the DOM instead, so the exclusion states what it means.
    labels.find(
      (label, index) =>
        !entries[index].deprecated &&
        /^gpt-/i.test(label) &&
        !NON_CHAT_MODEL.test(label) &&
        !AVOID_MODEL.test(label),
    ) ||
    labels.find((label) => !NON_CHAT_MODEL.test(label) && !AVOID_MODEL.test(label));

  if (!chosen) {
    await page.keyboard.press("Escape");
    throw new Error(
      `No usable OpenAI chat model found in the model dropdown. ` +
        `${entries.length} option(s) enumerated: ${labels.join(", ") || "(none)"}`,
    );
  }

  const chosenEntry = entries.find(
    (option, index) => labels[index] === chosen && Boolean(option.testId),
  );
  if (!chosenEntry) {
    await page.keyboard.press("Escape");
    throw new Error(
      `MODEL_PICKER_DEFECT: "${chosen}" was ranked from the picker's own options but no ` +
        `option carries a usable testid to click. Reported as a FAILURE so a picker the ` +
        `suite cannot drive never resolves into a silent default (#1461).`,
    );
  }
  await page.getByTestId(chosenEntry.testId).click();

  await expect(page.getByTestId("model_model")).toContainText(chosen, { timeout: 10000 });
}

// Enables a single chat model toggle inside the provider modal so the model
// dropdown has at least one option. Resolution mirrors selectPreferredChatModel:
// MODEL_TEST_ID (env) → first available preferred cheap model → first toggle.
// scrollIntoViewIfNeeded handles the long, scrollable model list (issue #569).
async function enablePreferredModelToggle(page: Page): Promise<void> {
  const toggles = page.locator('[data-testid^="llm-toggle-"]');
  await toggles.first().waitFor({ state: "attached", timeout: 15000 }).catch(() => {});

  const envModel = process.env.MODEL_TEST_ID?.trim();
  const candidates = [envModel, ...PREFERRED_CHAT_MODELS].filter(Boolean) as string[];

  for (const model of candidates) {
    const toggle = page.getByTestId(`llm-toggle-${model}`);
    if ((await toggle.count()) === 0) continue;
    await toggle.scrollIntoViewIfNeeded();
    if (!(await toggle.isChecked())) {
      await toggle.click();
    }
    return;
  }

  // Fallback: no preferred model is offered by this build — enable the first
  // offered model that is neither a non-chat nor an avoided (pro/reasoning) model,
  // so the dropdown resolves to a cheap chat model rather than `gpt-5.5-pro`.
  const ids = await toggles.evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-testid") || ""),
  );
  for (const id of ids) {
    const model = id.replace(/^llm-toggle-/, "");
    if (!model || NON_CHAT_MODEL.test(model) || AVOID_MODEL.test(model)) continue;
    const toggle = page.getByTestId(id);
    await toggle.scrollIntoViewIfNeeded();
    if (!(await toggle.isChecked())) {
      await toggle.click();
    }
    return;
  }
}

// Requires the Language Model node to be clicked before calling so its fields are in the viewport.
export async function setupLanguageModelOpenAI(page: Page): Promise<void> {
  const modelDropdown = page.getByTestId("model_model");
  const hasModelDropdown = await modelDropdown.isVisible({ timeout: 5000 }).catch(() => false);

  if (!hasModelDropdown) {
    // "Setup Provider" opens the provider modal (no data-testid on this button).
    // Open it with a dispatched click, not a hit-tested .click(): selecting the
    // node opens the InspectionPanel (a 320px pointer-events-auto card pinned
    // top-right) which, at the template's node layout, renders on top of the
    // Setup Provider button and intercepts the click (issue #580). dispatchEvent
    // targets the button directly and bypasses that interception.
    await page.getByRole("button", { name: "Setup Provider" }).dispatchEvent("click");
    // Through waitForProviderRow (#1648) so a list that never settles reports
    // PROVIDER_LIST_STALLED instead of an anonymous locator timeout. Budget
    // unchanged at the 10 s this call site already used.
    await (await waitForProviderRow(page, "provider-item-OpenAI", 10000)).click();

    const apiKeyInput = page.getByPlaceholder("sk-...");
    // Wait for the form panel to animate in before checking visibility
    await apiKeyInput.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});

    const apiKey = process.env.OPENAI_API_KEY ?? "";
    if ((await apiKeyInput.count()) > 0 && apiKey) {
      await apiKeyInput.click();
      await apiKeyInput.pressSequentially(apiKey, { delay: 0 });

      const saveBtn = page.getByRole("button", { name: "Save", exact: true });
      const replaceBtn = page.getByRole("button", { name: "Replace", exact: true });

      if ((await saveBtn.count()) > 0) {
        await saveBtn.click();
      } else if ((await replaceBtn.count()) > 0) {
        await replaceBtn.click();
      }

      // After save the button becomes "Replace" — wait for that to confirm save completed
      await replaceBtn.waitFor({ state: "visible", timeout: 30000 });
      // Wait for model toggles to load
      await page.locator('[data-testid^="llm-toggle"]').first()
        .waitFor({ state: "visible", timeout: 15000 })
        .catch(() => {});
    }

    // Enable exactly one preferred chat model. Enabling every toggle is fragile:
    // the OpenAI bundle now lists 45+ models and the trailing toggles render off
    // the scroll viewport, so clicking each one eventually times out on a
    // non-visible element (issue #569). One enabled model is all the dropdown needs.
    await enablePreferredModelToggle(page);

    // Escape closes the Dialog and triggers refreshAllModelInputs on the node
    await page.keyboard.press("Escape");
    await modelDropdown.waitFor({ state: "visible", timeout: 30000 });
  }

  // Open the dropdown with a dispatched click, not a hit-tested .click(): at
  // zoomed-out scale the node's bound `api_key` popover (anchor-popover-anchor-input-
  // api_key) renders on top of the ~10px-tall model_model trigger and intercepts
  // pointer events, timing the click out (issue #580). dispatchEvent bypasses
  // hit-testing and still opens the dropdown.
  await modelDropdown.dispatchEvent("click");

  // The unified ModelInput dropdown lists models only from ENABLED providers, and
  // the node renders this dropdown (instead of the "Setup Provider" button above)
  // as soon as ANY provider is enabled. So on an instance where another provider
  // is enabled but OpenAI is not — collect-models recording OpenAI `inactive`
  // after a key/quota outage, or a run that configured only Anthropic/Google —
  // no OpenAI option is offered and selectPreferredChatModel would fall through
  // to another provider's model, silently running a non-OpenAI model from a
  // helper named `...OpenAI` (issue #961). Configure OpenAI from `OPENAI_API_KEY`
  // through the dropdown's "Manage Model Providers" panel so the helper is
  // self-sufficient, then reopen the dropdown. Skipped when OpenAI is already
  // offered (daily-stable configures it via collect-models; a prior local run
  // persisted the credential).
  if (!(await isOpenAIOffered(page))) {
    await configureOpenAIProviderFromDropdown(page);

    // Gate on an OpenAI OPTION appearing — never on a single sample of the list.
    // Closing the panel refreshes every ModelInput *asynchronously*
    // (`refreshAllModelInputs`, fired after the pending model toggles flush), so
    // the reopened dropdown can still be rendering the pre-refresh list; sampling
    // it once reports "no OpenAI model" for a provider that was just configured
    // fine. The second dispatch covers the opposite state: if the panel left the
    // popover open, the first dispatch toggled it shut instead of opening it.
    const openAIOption = page.getByTestId(/^openai-.+-option$/i).first();
    await modelDropdown.dispatchEvent("click");
    let offered = await optionAppeared(openAIOption);
    if (!offered) {
      await modelDropdown.dispatchEvent("click");
      offered = await optionAppeared(openAIOption);
    }

    if (!offered) {
      await page.keyboard.press("Escape");
      throw new Error(
        "setupLanguageModelOpenAI: the model dropdown still offers no OpenAI model after " +
          "configuring the provider from OPENAI_API_KEY. Check that the key is valid " +
          "(Langflow validates it on save) and that the OpenAI provider is enabled.",
      );
    }
  }

  await selectPreferredChatModel(page);
}

// Resolves true when the option becomes visible within the wait, false on timeout.
async function optionAppeared(option: Locator): Promise<boolean> {
  return option
    .waitFor({ state: "visible", timeout: 15000 })
    .then(() => true)
    .catch(() => false);
}

// True when the open ModelInput dropdown offers at least one OpenAI model.
// Each option carries `data-testid="${provider}-${model}-option"` (frontend
// `ModelList.getModelOptionTestId`), so the provider is authoritative straight
// from the DOM; the `gpt-*` label check is a fallback for builds whose option
// testid is not provider-prefixed. Returns false on the empty dropdown ("No
// Models Enabled"), which is what an unconfigured instance renders.
// The initial wait matches selectPreferredChatModel's own 15s budget for the same
// list: a saturated runner that takes >5s to populate it must be waited out, not
// mistaken for "OpenAI is missing" (which would trigger a pointless panel detour).
async function isOpenAIOffered(page: Page): Promise<boolean> {
  const entries = await enumerateModelOptions(page, 15000);
  if (entries.some((option) => /^openai$/i.test(option.provider ?? ""))) return true;
  if (entries.some((option) => /^openai-/i.test(option.testId))) return true;

  // Label fallback, read from the option's identity rather than its text: the
  // rendered text carries the dev26 position counter (#1459).
  return entries.some((option) => /^gpt-/i.test((option.model ?? option.visibleLabel).trim()));
}

// Opens the model dropdown's "Manage Model Providers" panel, configures the
// OpenAI credential from `OPENAI_API_KEY`, enables one preferred chat model and
// closes the panel — so the dropdown then offers OpenAI options. Assumes the
// dropdown is already open. Idempotent: when the credential is already stored
// the button reads "Replace" and the re-save is skipped (re-saving 400s on
// PATCH /variables and would trip the backend-error monitor, issue #751).
// Restores the self-sufficiency the pre-ModelInput node had via its own
// "Setup Provider" form.
async function configureOpenAIProviderFromDropdown(page: Page): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    await page.keyboard.press("Escape");
    throw new Error(
      "setupLanguageModelOpenAI: the model dropdown offers no OpenAI model and " +
        "OPENAI_API_KEY is not set, so the provider cannot be configured.",
    );
  }

  await page.getByTestId("manage-model-providers").click();
  // The provider list is fetched when the modal mounts (`provider-list-loading`)
  // — waitForProviderRow reads that state and names it when the row does not
  // arrive, rather than leaving the reader with a bare locator timeout (#1648).
  // Budget unchanged at the 15 s this call site already used.
  await (await waitForProviderRow(page, "provider-item-OpenAI", 15000)).click();

  const apiKeyInput = page.getByPlaceholder("sk-...");
  await apiKeyInput.waitFor({ state: "visible", timeout: 10000 });

  // The form's single submit button carries the state: "Save" (unconfigured),
  // "Replace" (credential already stored) or "Retry Save" (key rejected on a
  // previous save). Wait for it and branch on the label it actually renders —
  // `isVisible({ timeout })` would NOT wait (the option is documented as ignored),
  // and a premature "not configured" reading re-saves a stored credential, which
  // 400s on PATCH /variables and trips the backend-error monitor (issue #751).
  // Scoped to the dialog so a same-named button elsewhere on the canvas cannot match.
  const submitBtn = page
    .getByRole("dialog")
    .getByRole("button", { name: /^(Save|Replace|Retry Save)$/ })
    .first();
  await submitBtn.waitFor({ state: "visible", timeout: 10000 });
  const alreadyConfigured = /^Replace$/i.test((await submitBtn.innerText()).trim());

  if (!alreadyConfigured) {
    await apiKeyInput.click();
    await apiKeyInput.pressSequentially(apiKey, { delay: 0 });
    await submitBtn.click();

    // Saving validates the key against the provider and loads its model list.
    // Failing hard here (instead of swallowing the timeout) is the point: with no
    // toggle there is no model to enable, and closing the panel anyway would let
    // the dropdown hand back another provider's model — the silent mis-run this
    // whole branch exists to prevent. The submit button's label is reported as-is
    // (it carries the save outcome) so the failure is diagnosable.
    try {
      await page
        .locator('[data-testid^="llm-toggle-"]')
        .first()
        .waitFor({ state: "visible", timeout: 30000 });
    } catch {
      const label = (await submitBtn.innerText().catch(() => "<unreadable>")).trim();
      throw new Error(
        "setupLanguageModelOpenAI: saving OPENAI_API_KEY in the Model Providers panel did " +
          `not load any OpenAI model (submit button reads "${label}"). Check that ` +
          "OPENAI_API_KEY is valid and the account can list models.",
      );
    }
  }

  // One enabled model is all the dropdown needs (issue #569).
  await enablePreferredModelToggle(page);

  // Closing flushes the pending model toggles and refreshes every ModelInput.
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

// Cheap, non-reasoning OpenAI chat models, in priority order. Unlike the gpt-5.x
// nano/mini tier — which the current nightly bundle classifies as *reasoning* models
// (see `isReasoningOption` below) — these are plain chat models with bounded latency.
// `gpt-4o-mini` leads: it is the cheapest, is present on the account catalog, and is
// the deterministic fallback synthesized when the Agent still carries the curated
// reasoning-only default option list (issue #569).
const NON_REASONING_CHAT_MODELS = [
  "gpt-4o-mini",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-5.3-chat-latest",
  "gpt-5.2-chat-latest",
  "gpt-5.1-chat-latest",
];

// The backend tags every *reasoning* model by self-listing its own name in
// `metadata.reasoning_models`; plain chat models omit the field. This is the
// authoritative, build-agnostic signal — the hardcoded name lists drift as the
// OpenAI bundle changes (the gpt-5.x nano/mini tier is now reasoning, so the old
// PREFERRED list picked `gpt-5.4-nano`, whose variable latency intermittently blew
// the 120s response budget — the reopened #569 flake).
function isReasoningOption(o: any): boolean {
  const rm = o?.metadata?.reasoning_models;
  return Array.isArray(rm) && rm.length > 0;
}

function isOpenAIOption(o: any): boolean {
  return String(o?.provider ?? "").toLowerCase() === "openai";
}

// Forces the Agent node's *executable* model to a cheap, **non-reasoning** OpenAI
// chat model via the flows API. Two problems this guards against, both root causes of
// the #569 flake:
//   1. The Agent template ships `model` defaulting to `gpt-5.5-pro` — a restricted,
//      expensive reasoning model (rejected by keys without access). The in-canvas
//      widget does not reliably persist a UI selection to the executed graph, so a
//      plain UI click leaves the flow running gpt-5.5-pro.
//   2. The Agent's `model.options` list refreshes to the full OpenAI catalog only
//      *after* the provider is configured; before that it carries a curated default
//      where **every** OpenAI option is a reasoning model (gpt-5.x). Reading that
//      window pins a reasoning model (`gpt-5.4-nano`), whose latency variance
//      occasionally exceeds the 120s response budget → the reopened flake.
// Resolution: MODEL_TEST_ID (env, if non-reasoning) → first available non-reasoning
// OpenAI chat option → synthesize `gpt-4o-mini` by name from any OpenAI option's shape
// (the backend executes `model.value[0].name` directly, so the name is authoritative
// even when the stale options list lacks it). Returns the chosen name. Caller must
// reload the flow afterwards so the playground build uses the patched model.
export async function setAgentModelViaApi(page: Page, flowId: string): Promise<string> {
  const flow = await (await page.request.get(`/api/v1/flows/${flowId}`)).json();
  const nodes = flow?.data?.nodes ?? [];
  const agent = nodes.find((n: any) => n?.data?.type === "Agent");
  if (!agent) {
    throw new Error("setAgentModelViaApi: Agent node not found in the flow");
  }

  const modelField = agent.data.node.template.model;
  const options = (modelField?.options ?? []) as any[];
  const nameOf = (o: any) => (typeof o === "string" ? o : o?.name);

  // Usable = OpenAI, non-reasoning, and neither a non-chat nor an avoided variant.
  const usable = options.filter(
    (o) =>
      isOpenAIOption(o) &&
      !isReasoningOption(o) &&
      !NON_CHAT_MODEL.test(nameOf(o) ?? "") &&
      !AVOID_MODEL.test(nameOf(o) ?? ""),
  );

  const envModel = process.env.MODEL_TEST_ID?.trim();
  const preferred = [envModel, ...NON_REASONING_CHAT_MODELS].filter(Boolean) as string[];

  let chosenOption =
    preferred.map((m) => usable.find((o) => nameOf(o) === m)).find(Boolean) ??
    usable[0];

  // Curated-default window: the Agent still carries only reasoning OpenAI options, so
  // there is no non-reasoning option to pick. Synthesize `gpt-4o-mini` from any OpenAI
  // option's shape (metadata is provider-level: model_class, model_name_param, …) and
  // strip the reasoning tag. The executed model is `model.value[0].name`, so this runs
  // a real non-reasoning model regardless of what the options list happens to show.
  if (!chosenOption) {
    const template = options.find(isOpenAIOption);
    if (!template) {
      throw new Error(
        `setAgentModelViaApi: no OpenAI model in Agent options: ${options.map(nameOf).join(", ")}`,
      );
    }
    chosenOption = JSON.parse(JSON.stringify(template));
    chosenOption.name = NON_REASONING_CHAT_MODELS[0];
    if (chosenOption.metadata) delete chosenOption.metadata.reasoning_models;
  }

  modelField.value = [chosenOption];

  const res = await page.request.patch(`/api/v1/flows/${flowId}`, {
    data: { name: flow.name, data: flow.data },
  });
  if (!res.ok()) {
    throw new Error(`setAgentModelViaApi: PATCH failed (${res.status()}): ${await res.text()}`);
  }

  return nameOf(chosenOption);
}
