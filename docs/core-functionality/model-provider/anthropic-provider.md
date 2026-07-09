# Anthropic Provider — configure key, select Claude, switch models

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Anthropic (Claude) provider path (QA-CHECKLIST §7.3), as a **provider-centric
journey** distinct from agent-behavior specs:

1. **Configure the Anthropic API key** in `Settings → Model Providers` (in 1.11
   the key is a global provider variable `ANTHROPIC_API_KEY`, set from this page).
2. **Select a Claude model** in the Agent (the configured key makes Claude models
   available in the Agent's model dropdown) and **execute the flow** to prove the
   selection is genuinely usable, not merely picked in the UI.
3. **Switch between Claude models** across families (Haiku → Sonnet → Opus): the
   Agent's model dropdown re-selects across model families and the newly selected
   model executes.

If this fails, Anthropic can no longer be configured and its Claude models
selected/switched in an Agent.

Completes the provider-centric family: `openai-provider.spec.ts` (§7.2),
`google-provider.spec.ts` (§7.4), `ollama-provider.spec.ts` (§7.6).

---

## Tags *(required)*

`@stable` `@model-provider` `@settings` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@model-provider` (area) · `@settings` (Test 1 navigates Settings) ·
`@agents` + `@playground` (Tests 2–3 select models and execute).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `ANTHROPIC_API_KEY` set in `.env` with a **funded** account (all tests
  self-skip without the env var; a zero-credit key configures fine but fails
  execution with a billing error — see Notes).
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts` (Anthropic must be `active`).
- Run with `--workers=1` (Tests 2–3 load a named template via
  `SimpleAgentTemplatePage`; agent-family convention). File is serial.

---

## Step by step *(required)*

---

**Test 1 — configure the Anthropic API key in Settings → Model Providers** (§7.3.1)

1. `SettingsPage.navigate()` → click `sidebar-nav-Model Providers`; wait for
   `settings_menu_header` to read "Model Providers".
2. Click `provider-item-Anthropic` to open its config panel.
3. Fill `provider-variable-input-ANTHROPIC_API_KEY` with `ANTHROPIC_API_KEY`.
4. Arm two response waiters, then click the save button (`Save` when
   unconfigured, `Replace` when a key is already stored — match `/Save|Replace/`).
5. **Validation (causal — no pre-existing-state false positive):** the save click
   must produce **both** a `POST /api/v1/models/validate-provider` → **2xx** (the
   key authenticates against Anthropic live) **and** a `POST|PATCH
   /api/v1/variables/…` → **2xx** (the key is persisted — `POST` on first
   configure, `PATCH` on re-save). Asserting the request outcomes — not the
   "Disconnect"/"Replace" state, which pre-exists when the global key was already
   configured — ties the pass to *this* save. Idempotent: re-saving the same
   valid key is a success; the shared global key is deliberately not wiped.

---

**Test 2 — configured Anthropic selects a Claude model in the Agent and executes** (§7.3.2)

1. `SimpleAgentTemplatePage.load({ provider: "anthropic", model })` — with the
   key configured, this selects a **Claude** model in the Agent's `model_model`
   dropdown. `model` resolves from `models.json`, preferring a current **Haiku**
   (fast/cheap; e.g. `claude-haiku-4-5`).
2. **Assert the selection is a Claude model** — `value-dropdown-model_model`
   text matches `/claude/i`. Ties §7.3.2 to a concrete observable.
3. **Remove the Web Search + URL tool nodes** — select each via its node
   **title** (`title-Web Search`, `title-URL`) then press `Delete`, then wait
   for the debounced autosave to settle (`waitForFlowSaveSettled`) so the
   Playground builds the persisted tool-free flow (single deterministic LLM
   call — same rationale as the OpenAI/Google siblings).
4. Open the Playground (`playground-btn-flow-io`); wait for
   `input-chat-playground`.
5. Send `Repeat this token exactly and nothing else: ANTHROPIC-<sentinel>`;
   wait for the agent to finish (`waitForAgentToFinish`).
6. **Validation:** the last `div-chat-message` (AI bubble) is **non-empty**
   (hard — proves the configured Claude model executed and returned output).
   The per-run sentinel echo is **logged, not asserted** — family convention
   (Gemini disobeys ~1/6; Claude is more obedient, but the hard non-empty
   check plus the `/claude/i` selection assert already pin execution to
   Anthropic, and keeping the family contract identical keeps the specs
   comparable).

---

**Test 3 — switch between Claude model families (Haiku → Sonnet → Opus)** (§7.3.3)

1. `SimpleAgentTemplatePage.load({ provider: "anthropic", model: <haiku> })` —
   starting point, Haiku selected (asserted via `value-dropdown-model_model`).
2. Remove the tool nodes (same as Test 2) and settle the autosave.
3. **Switch Haiku → Sonnet:** click `model_model`, click the Sonnet option
   (`[data-testid$="-option"]` with the exact model name from `models.json`);
   assert `value-dropdown-model_model` now shows the Sonnet model; settle the
   autosave.
4. **Execute after the switch:** run the Playground with a fresh per-run
   sentinel; assert the last AI bubble is **non-empty** — the switched-to
   Sonnet model is genuinely usable, not just displayed.
5. **Switch Sonnet → Opus (selection only):** click `model_model`, click the
   Opus option; assert `value-dropdown-model_model` shows the Opus model.
   No execution — see Notes (cost); the switch *mechanism* across all three
   §7.3 families is proven, execution-after-switch is proven once in step 4.

---

## Validation criterion *(required)*

- **Configure:** clicking Save on the Anthropic key produces a 2xx
  `validate-provider` (key authenticates against Anthropic) and a 2xx
  `POST|PATCH /variables` (key persisted) — the pass is caused by this save,
  not a pre-existing configured state.
- **Select + execute:** the Agent's model dropdown shows a Claude model, and
  running the flow returns a non-empty AI response.
- **Switch:** the dropdown value provably changes Haiku → Sonnet → Opus (three
  distinct `value-dropdown-model_model` states within one test), and the
  post-switch Sonnet execution returns a non-empty AI response.

## Guarding against false positives *(how)*

- **Test 1** asserts the *save requests succeed* (`validate-provider` +
  `POST|PATCH /variables` both 2xx), not a UI state that pre-exists from an
  earlier configuration — so a no-op save cannot pass.
- **Test 2** asserts a **Claude** model is selected
  (`value-dropdown-model_model` ~ `/claude/i`, causal) and that execution
  returns a non-empty response.
- **Test 3** asserts the dropdown value **changes** to the exact target model
  name after each switch (a stale dropdown fails the assert), and that the
  post-switch execution produces output — a switch that silently keeps the old
  model selected cannot pass step 3's exact-name assert.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY: each
  assertion is broken on purpose once to confirm it fails, before `@stable`
  is added.

---

## What this test does not cover *(optional)*

- Removing / rotating the key (see `remove-provider-api-key.spec.ts`).
- Invalid Anthropic key error (covered: §7.3 bullet 4 →
  `provider-invalid-auth-error.spec.ts`).
- Model enable/disable toggles (see `model-provider-model-toggle.spec.ts`).
- Opus **execution** (selection only — cost; see Notes).
- Agent behaviors — streaming, reasoning, tools (see
  `agent-component-regression.spec.ts`).
- Other providers (OpenAI §7.2, Google §7.4, Ollama §7.6 — own specs).

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/` (Model Providers page) — renders
  `provider-item-Anthropic`, `provider-variable-input-ANTHROPIC_API_KEY`,
  the Save/Replace button; a rename breaks Test 1.
- Provider-config storage — the global `ANTHROPIC_API_KEY` provider variable.
- `src/backend/base/langflow/components/agents/` — Agent execution with the
  selected Claude model (Tests 2–3).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O.
- Anthropic API — Test 1 validates the key live; Tests 2–3 make real calls.
  A live, **funded** `ANTHROPIC_API_KEY` is required.

---

## When to review this test *(optional)*

- If the Model Providers settings page restructures (provider items, the
  `provider-variable-input-*` inputs, or the Save/Replace button).
- If the Agent's model dropdown (`model_model` / `value-dropdown-model_model` /
  `*-option` items) or the Simple Agent template changes.
- If Anthropic key storage moves off the global provider-variable model.
- If the Claude model catalog renames families (Haiku/Sonnet/Opus regexes).

---

## Notes *(optional)*

- **Dedicated spec (issue #503 delegated the choice):** the issue names
  `llm-agents/model-provider-api-key.spec.ts` as the spec file, but its Notes
  delegate "dedicated spec vs promotion of existing coverage" to the author.
  The existing file only proves Anthropic is *listed*; the three §7.3 bullets
  need configure + select + switch. A dedicated `anthropic-provider.spec.ts`
  under `model-provider/` follows the family precedent (§7.2/§7.4/§7.6 all
  chose dedicated specs) and gives §7.3 a provider-centric home.
- **Model resolution from `models.json`:** Haiku/Sonnet/Opus are resolved by
  family regex from the collected catalog (preferring current, non-deprecated
  names, e.g. `claude-haiku-4-5`, `claude-sonnet-5`, `claude-opus-4-8`), so
  catalog updates don't break the spec. A family missing from the catalog
  skips with a reason.
- **Why Opus is selection-only:** executing all three families triples LLM
  cost per run (and Opus is the most expensive tier) for no extra mechanism
  coverage — the switch mechanism is identical per family and
  execution-after-switch is already proven on Sonnet.
- **Zero-credit trap (found live during #503):** a valid-but-unfunded key
  passes Langflow's configure/validate and lists all 12 Claude models, but
  every real inference fails with "credit balance is too low". The spec
  requires an *active* provider (`providers.json`), which collect-models
  verifies with a real 1-token inference — that gate, not the configure step,
  is what catches an unfunded key before the agent tests burn retries.
- **Flow cleanup (id-scoped):** Tests 2–3 create a flow via
  `SimpleAgentTemplatePage.load()`, which does NO cleanup (post-#553 contract —
  the id is discarded by the POM). The spec tracks every
  `POST /api/v1/flows` → 201 id fired during load and deletes them by id in
  `test.afterEach` (transient ids 404 harmlessly — `deleteFlow` treats 404 as
  done). Never a name-based or delete-all cleanup (cross-worker wiper class,
  #553/#520).
- **Per-run sentinel** proves *this* execution produced the output; echo is
  logged, not asserted (family convention — see Test 2 step 6).
- **Shared global key:** the Anthropic key is global and persists across runs.
  Test 1 is idempotent — it re-saves and asserts the request outcomes, not a
  fresh start.
