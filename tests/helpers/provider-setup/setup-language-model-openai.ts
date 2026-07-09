import { type Page, expect } from "@playwright/test";

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Selects a usable OpenAI chat model from the already-open `model_model` dropdown.
// Resolution order: MODEL_TEST_ID env override → first available preferred model →
// first option that is neither a non-chat nor an avoided (pro/reasoning) model.
// Throws with the observed options if none fit. After selecting, verifies the trigger
// actually reflects the choice — a silently-intercepted click (the api_key popover can
// steal the click) would otherwise leave the node on its default (`gpt-5.5-pro`).
async function selectPreferredChatModel(page: Page): Promise<void> {
  const options = page.locator('[data-testid$="-option"]');
  await options.first().waitFor({ state: "visible", timeout: 15000 });

  const labels = (await options.allInnerTexts())
    .map((label) => label.trim())
    .filter(Boolean);

  const envModel = process.env.MODEL_TEST_ID?.trim();
  const chosen =
    (envModel && labels.find((label) => label === envModel)) ||
    PREFERRED_CHAT_MODELS.find((model) => labels.includes(model)) ||
    labels.find((label) => !NON_CHAT_MODEL.test(label) && !AVOID_MODEL.test(label));

  if (!chosen) {
    await page.keyboard.press("Escape");
    throw new Error(
      `No usable OpenAI chat model found in the model dropdown. Options: ${labels.join(", ")}`,
    );
  }

  await options
    .filter({ hasText: new RegExp(`^${escapeRegExp(chosen)}$`) })
    .first()
    .click();

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
    await page.waitForSelector('[data-testid="provider-item-OpenAI"]', { timeout: 10000 });
    await page.getByTestId("provider-item-OpenAI").click();

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
  await selectPreferredChatModel(page);
}

// Forces the Agent node's *executable* model to a cheap chat model via the flows API.
// The Agent template ships `model` defaulting to `gpt-5.5-pro` — a restricted,
// expensive reasoning model — and its in-canvas model widget does not reliably
// persist a UI selection to the executed graph, so a plain UI click leaves the flow
// running gpt-5.5-pro (rejected by keys without access, and slow/reasoning — the #569
// flake). Resolution mirrors selectPreferredChatModel: MODEL_TEST_ID → first preferred
// → first non-chat/non-avoided option offered by the node. Returns the chosen name.
// Caller must reload the flow afterwards so the playground build uses the patched model.
export async function setAgentModelViaApi(page: Page, flowId: string): Promise<string> {
  const flow = await (await page.request.get(`/api/v1/flows/${flowId}`)).json();
  const nodes = flow?.data?.nodes ?? [];
  const agent = nodes.find((n: any) => n?.data?.type === "Agent");
  if (!agent) {
    throw new Error("setAgentModelViaApi: Agent node not found in the flow");
  }

  const modelField = agent.data.node.template.model;
  const options = (modelField?.options ?? []) as any[];
  const names: string[] = options
    .map((o) => (typeof o === "string" ? o : o?.name))
    .filter(Boolean);

  const envModel = process.env.MODEL_TEST_ID?.trim();
  const chosenName =
    (envModel && names.includes(envModel) && envModel) ||
    PREFERRED_CHAT_MODELS.find((m) => names.includes(m)) ||
    names.find((n) => !NON_CHAT_MODEL.test(n) && !AVOID_MODEL.test(n));

  if (!chosenName) {
    throw new Error(
      `setAgentModelViaApi: no usable cheap chat model in Agent options: ${names.join(", ")}`,
    );
  }

  const chosenOption = options.find((o) => (typeof o === "string" ? o : o?.name) === chosenName);
  modelField.value = [chosenOption];

  const res = await page.request.patch(`/api/v1/flows/${flowId}`, {
    data: { name: flow.name, data: flow.data },
  });
  if (!res.ok()) {
    throw new Error(`setAgentModelViaApi: PATCH failed (${res.status()}): ${await res.text()}`);
  }

  return chosenName;
}
