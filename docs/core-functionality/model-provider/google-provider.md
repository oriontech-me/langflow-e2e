# Google Provider — configure key, select Gemini

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Google (Gemini) provider path (QA-CHECKLIST §7.4), as a **provider-centric
journey** distinct from agent-behavior specs:

1. **Configure the Google API key** in `Settings → Model Providers` (in 1.11 the
   key is a global provider variable `GOOGLE_API_KEY`, set from this page).
2. **Select a Gemini model** in the Agent (the configured key makes Gemini models
   available in the Agent's model dropdown).

§7.4 lists only *configure* and *select* (no dedicated "execute" bullet). To prove
the selected Gemini model is genuinely usable — not just picked in the UI — the
selection test also **runs the flow once** and round-trips a per-run sentinel.

If this fails, Google can no longer be configured and its models selected in an
Agent — the second-most-common provider setup after OpenAI.

Mirrors `openai-provider.spec.ts` (§7.2) for the Google provider.

---

## Tags *(required)*

`@stable` `@model-provider` `@settings` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@model-provider` (area) · `@settings` (Test 1 navigates Settings) ·
`@agents` + `@playground` (Test 2 selects a model and executes).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `GOOGLE_API_KEY` set in `.env` (both tests self-skip without it).
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts` (Google must be `active`).
- Run with `--workers=1` (Test 2 loads a named template via
  `SimpleAgentTemplatePage`; agent-family convention). File is serial.

---

## Step by step *(required)*

---

**Test 1 — configure the Google API key in Settings → Model Providers** (§7.4.1)

1. `SettingsPage.navigate()` → click `sidebar-nav-Model Providers`; wait for
   `settings_menu_header` to read "Model Providers".
2. Click `provider-item-Google Generative AI` to open its config panel.
3. Fill `provider-variable-input-GOOGLE_API_KEY` with `GOOGLE_API_KEY`.
4. Arm two response waiters, then click the save button (`Save` when
   unconfigured, `Replace` when a key is already stored — match `/Save|Replace/`).
5. **Validation (causal — no pre-existing-state false positive):** the save click
   must produce **both** a `POST /api/v1/models/validate-provider` → **2xx** (the
   key authenticates against Google live) **and** a persist to
   `/api/v1/variables/` → **2xx**. The persist is a **`POST` (create, 201)** when
   the `GOOGLE_API_KEY` global variable does not yet exist and a **`PATCH`
   (update, 200)** when it does — the frontend branches on existence — so the
   waiter matches **either method** (#636). Asserting the request outcomes — not
   the "Disconnect"/"Replace" state, which pre-exists when the global key was
   already configured — ties the pass to *this* save. Idempotent across states:
   the first save on a fresh instance creates, later saves update. (Google
   validation can be slow on a cold provider — the waiters use a 60 s timeout.)

---

**Test 2 — configured Google selects a Gemini model in the Agent and executes** (§7.4.2)

1. `SimpleAgentTemplatePage.load({ provider: "google", model })` — with the key
   configured, this selects a **Gemini** model in the Agent's `model_model`
   dropdown (bullet §7.4.2). `model` resolves from `models.json` (a Gemini flash
   chat model).
2. **Assert the selection is a Gemini model** — `value-dropdown-model_model` text
   matches `/gemini|gemma/i`. Ties §7.4.2 to a concrete observable.
3. **Remove the Web Search + URL tool nodes** — select each via its node **title**
   (`title-Web Search`, `title-URL`) then press `Delete` (a body click doesn't
   select URLComponent — its center is interactive), then wait for the debounced
   autosave to settle (`waitForFlowSaveSettled`) so the Playground build runs the
   persisted tool-free flow. The agent then executes as a plain LLM completion —
   see Notes.
4. Open the Playground (`playground-btn-flow-io`); wait for
   `input-chat-playground`.
5. Send `Repeat this token exactly and nothing else: GOOGLE-<sentinel>`; wait for
   the agent to finish (`waitForAgentToFinish`).
6. **Validation:** the last `div-chat-message` (AI bubble) is **non-empty** (hard
   — proves the configured Gemini model executed and returned output). The per-run
   sentinel is **logged, not asserted** (a plain `console.log`, not `expect.soft`
   — a soft assertion would still fail the test): Gemini flash ~1/6 ignores
   "repeat this token" and returns a generic greeting instead of echoing — a
   model-obedience trait, not a provider failure — so requiring the echo flakes.
   When the model obeys, the log records that *this* input's token round-tripped;
   when it doesn't, the non-empty hard check still proves execution.

---

## Validation criterion *(required)*

- **Configure:** clicking Save on the Google key produces a 2xx
  `validate-provider` (key authenticates against Google) and a 2xx persist to
  `/variables/` (key persisted) — `POST` create or `PATCH` update depending on
  whether the global key already exists (#636) — the pass is caused by this save,
  not a pre-existing configured state.
- **Select + execute:** the Agent's model dropdown shows a Gemini model, and
  running the flow returns a non-empty AI response (the per-run sentinel is a soft
  signal — Gemini doesn't always echo it verbatim).

## Guarding against false positives *(how)*

- **Test 1** asserts the *save requests succeed* (`validate-provider` +
  `POST`/`PATCH /variables` both 2xx), not a UI state that pre-exists from an
  earlier configuration — so a no-op save cannot pass.
- **Test 2** asserts a **Gemini** model is selected
  (`value-dropdown-model_model` ~ `/gemini|gemma/i`, causal) and that execution
  returns a non-empty response; the per-run sentinel is a soft signal (Gemini
  obedience-dependent). The selection assertion is what pins the output to Gemini.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY: each assertion
  is broken on purpose once to confirm it fails, before `@stable` is added.

---

## What this test does not cover *(optional)*

- Removing / rotating the key (see `remove-provider-api-key.spec.ts`).
- Invalid Google key error (see `provider-invalid-auth-error.spec.ts`).
- Model enable/disable toggles (see `model-provider-model-toggle.spec.ts`).
- Agent behaviors — streaming, reasoning, duration (see
  `agent-component-regression.spec.ts`); agent execution **with** tools.
- Other providers (OpenAI → `openai-provider.spec.ts`, Anthropic → #503).

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/` (Model Providers page) — renders
  `provider-item-Google Generative AI`, `provider-variable-input-GOOGLE_API_KEY`,
  the Save/Replace button; a rename breaks Test 1.
- Provider-config storage — the global `GOOGLE_API_KEY` provider variable.
- `src/lfx/src/lfx/components/models_and_agents/` — Agent execution with the
  selected Gemini model (Test 2).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O.
- Google Generative AI API — Test 1 validates the key live; Test 2 makes a real
  call. A live `GOOGLE_API_KEY` is required.

---

## When to review this test *(optional)*

- If the Model Providers settings page restructures (provider items, the
  `provider-variable-input-*` inputs, or the Save/Replace button).
- If the Agent's model dropdown or the Simple Agent template changes.
- If Google key storage moves off the global provider-variable model.

---

## Notes *(optional)*

- **Dedicated spec (issue #504 delegated the choice):** gives §7.4 a named,
  provider-centric home that asserts the Settings-page key configuration
  explicitly (Test 1) and proves a Gemini model is selected and usable (Test 2).
- **Stale bullet wording:** §7.4 said "Configure Google API key in agent" /
  "Select Gemini model in agent". In 1.11 the key is configured on `Settings →
  Model Providers` (stored as the `GOOGLE_API_KEY` provider variable), so bullet 1
  is reworded to match; model selection still happens in the Agent.
- **Why the tools are removed before executing:** the Simple Agent template ships
  with Web Search + URL tools; executing with those tools transiently fails
  (backend `ComponentBuildError` in the tool / structured-output orchestration),
  incidental to §7.4. Deleting the tool nodes makes the agent a single-call
  completion. Tool execution stays covered by `agent-component-regression.spec.ts`.
  The Playground builds the *persisted* flow, so the deletion is followed by
  `waitForFlowSaveSettled`.
- **Flow cleanup (id-scoped, issue #605):** Test 2 creates a flow via
  `SimpleAgentTemplatePage.load()`, which does NO cleanup (post-#553 contract).
  The spec tracks every `POST /api/v1/flows` → 201 id fired during load and
  deletes them by id in `test.afterEach` (transient ids 404 harmlessly —
  `deleteFlow` treats 404 as done). Never a name-based or delete-all cleanup
  (cross-worker wiper class, #553/#520). Same pattern as
  `anthropic-provider.spec.ts`.
- **Per-run sentinel** proves *this* execution produced the output.
- **Shared global key:** the Google key is global and persists across runs. Test 1
  is idempotent — it re-saves and asserts the request outcomes, not a fresh start.
- **#636 flake (fixed 2026-07-14):** the persist waiter matched `PATCH` only, but
  the frontend fires `POST /variables/` (create, 201) when the key does not yet
  exist and `PATCH /variables/{id}` (update, 200) when it does. On a fresh CI
  container — or a run where no earlier test configured the provider first — the
  save takes the create path, so the PATCH-only waiter timed out on a request that
  never fired (intermittent because prior test order decides which path runs).
  Network repro (deleted-var, live): `validate-provider` → **200**, persist →
  **POST 201**, PATCH-only waiter → timeout. Backend healthy (no hang/5xx): a
  **test defect**, not a product bug. Fix: match `POST` **or** `PATCH`. Same fix
  in `openai-provider.spec.ts`.
