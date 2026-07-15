# OpenAI Provider — configure key, select GPT, execute

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The OpenAI provider happy path (QA-CHECKLIST §7.2), as a **provider-centric
journey** distinct from agent-behavior specs:

1. **Configure the OpenAI API key** in `Settings → Model Providers` (in 1.11 the
   key is a global provider variable `OPENAI_API_KEY`, set from this page — not
   the legacy Variables screen).
2. **Select a GPT model** in the Agent (the configured key makes GPT models
   available in the Agent's model dropdown).
3. **Execute a flow with OpenAI** and get a real response.

A per-run sentinel is round-tripped through the executed agent, so the "execute"
assertion proves the configured OpenAI provider actually produced the output —
not a cached or coincidental value.

If this fails, OpenAI can no longer be configured and used end-to-end — the most
common provider setup in Langflow.

---

## Tags *(required)*

`@stable` `@model-provider` `@settings` `@agents` `@playground`

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly. `@model-provider` (area, all tests) · `@settings` (Test 1 navigates
Settings) · `@agents` + `@playground` (Test 2 executes an agent).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` set in `.env` (both tests self-skip without it).
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- Run with `--workers=1` (Test 2 loads a named template via
  `SimpleAgentTemplatePage`; agent-family convention). File is serial.

---

## Step by step *(required)*

---

**Test 1 — configure the OpenAI API key in Settings → Model Providers** (§7.2.1)

1. `SettingsPage.navigate()` → click `sidebar-nav-Model Providers`; wait for
   `settings_menu_header` to read "Model Providers".
2. Click `provider-item-OpenAI` to open its config panel.
3. Fill `provider-variable-input-OPENAI_API_KEY` with `OPENAI_API_KEY`.
4. Arm two response waiters, then click the save button (`Save` when
   unconfigured, `Replace` when a key is already stored — match `/Save|Replace/`).
5. **Validation (causal — no pre-existing-state false positive):** the save click
   must produce **both** a `POST /api/v1/models/validate-provider` → **2xx** (the
   key authenticates against OpenAI live) **and** a persist to
   `/api/v1/variables/` → **2xx**. The persist is a **`POST` (create, 201)** when
   the `OPENAI_API_KEY` global variable does not yet exist and a **`PATCH`
   (update, 200)** when it does — the frontend branches on existence — so the
   waiter matches **either method** (#636). Asserting the request outcomes — not
   the "Replace" button, which is already present when the global key was
   configured by an earlier test — ties the pass to *this* save action.
   Idempotent across states: the first save on a fresh instance creates, later
   saves update.

---

**Test 2 — configured OpenAI is selectable in the Agent and executes** (§7.2.2 + §7.2.3)

1. `SimpleAgentTemplatePage.load({ provider: "openai", model })` — with the key
   configured, this selects a **GPT** model in the Agent's `model_model`
   dropdown (bullet §7.2.2). `model` resolves from `models.json` (a GPT chat
   model; `setup-openai` prefers `gpt-4o-mini`/`gpt-4o`/`gpt-4.1`).
2. **Assert the selection is a GPT model** — `value-dropdown-model_model` text
   matches `/gpt/i`. Ties §7.2.2 to a concrete observable instead of leaving it
   implicit, and closes the "some other provider answered" gap in step 5.
3. **Remove the Web Search + URL tool nodes** — select each via its node **title**
   (`title-Web Search`, `title-URL`) then press `Delete` (a body click doesn't
   select URLComponent — its center is interactive), then wait for the debounced
   autosave to settle (`waitForFlowSaveSettled`) so the Playground build runs the
   persisted tool-free flow. The agent then executes as a **plain LLM
   completion** — see Notes for why.
4. Open the Playground (`playground-btn-flow-io`); wait for
   `input-chat-playground`.
5. Send `Repeat this token exactly and nothing else: OPENAI-<sentinel>`; wait for
   the agent to finish (`waitForAgentToFinish`).
6. **Validation (two-stage):** first gate on the **persisted** reply (monitor
   API — the token is unique per run and appears in both the user prompt and the
   echoed reply, so it keys the session lookup and is the content assert)
   **containing** `OPENAI-<sentinel>` — a race-free completion signal, because
   the live bubble shows the empty placeholder ("Message empty.") while the model
   streams and `waitForAgentToFinish` can return before the final text lands (the
   #634 flaky symptom). **Then**, with the run confirmed complete, re-assert the
   live bubble also echoes the token — keeping end-to-end UI coverage (a bubble
   stuck on "Message empty." while the reply persisted is a real frontend bug and
   must still fail) without the stream race. This proves the configured OpenAI
   provider, on a selected GPT model, executed the flow to produce this run's
   token (bullet §7.2.3).

---

## Validation criterion *(required)*

- **Configure:** clicking Save on the OpenAI key produces a 2xx
  `validate-provider` (key authenticates against OpenAI) and a 2xx persist to
  `/variables/` (key persisted) — `POST` create or `PATCH` update depending on
  whether the global key already exists (#636) — the pass is caused by this save,
  not a pre-existing configured state.
- **Select + execute:** the Agent's model dropdown shows a GPT model, and running
  the flow returns the per-run sentinel in the AI response.

## Guarding against false positives *(how)*

- **Test 1** asserts the *save requests succeed* (`validate-provider` +
  `POST`/`PATCH /variables` both 2xx), not a UI state that pre-exists from an
  earlier test's global key — so a no-op save cannot pass.
- **Test 2** asserts a **GPT** model is selected (`value-dropdown-model_model`
  ~ `/gpt/i`) and round-trips a **per-run sentinel**, so the response can't be
  stale, cached, or produced by a different provider.
- **Force-failure check** (CONTRIBUTING §2) is run during VERIFY: each assertion
  is broken on purpose once to confirm it fails, before `@stable` is added.

---

## What this test does not cover *(optional)*

- Removing / rotating the key (see `remove-provider-api-key.spec.ts`).
- The provider-listing / modal-open UI (see `model-provider-api-key.spec.ts`,
  `model-provider-modal-actions.spec.ts`).
- Model enable/disable toggles (see `model-provider-model-toggle.spec.ts`).
- Agent behaviors — streaming, reasoning, duration, multi-message (see
  `agent-component-regression.spec.ts`). This spec's execution step is a
  provider-config end-to-end check, not an agent-behavior check.
- Other providers (Anthropic → #503, Google → #504).

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/` (Model Providers page) — renders
  `provider-item-OpenAI`, `provider-variable-input-OPENAI_API_KEY`, and the
  Save/Replace button; a rename breaks Test 1.
- `src/backend/base/langflow/api/.../variables` + provider-config storage — the
  global `OPENAI_API_KEY` provider variable the key is saved into.
- `src/backend/base/langflow/components/agents/` — Agent execution with the
  selected GPT model (Test 2).
- `src/frontend/src/components/core/playgroundComponent/` — Playground I/O used
  by Test 2.
- OpenAI API — Test 2 makes a real call; a live `OPENAI_API_KEY` is required.

---

## When to review this test *(optional)*

- If the Model Providers settings page restructures (provider items, the
  `provider-variable-input-*` inputs, or the Save/Replace button).
- If the Agent's model dropdown or the Simple Agent template changes.
- If OpenAI key storage moves off the global provider-variable model.

---

## Notes *(optional)*

- **Why a dedicated spec (issue #502 delegated the choice):** the §7.2 happy path
  is exercised implicitly by `agent-component-regression`, but only as a
  precondition inside `SimpleAgentTemplatePage`. This spec gives §7.2 a named,
  provider-centric home that asserts the **Settings-page key configuration**
  explicitly (Test 1) and proves the configured provider **executes** (Test 2).
- **Stale bullet wording:** the checklist said "Configure OpenAI API key via
  GlobalVariables". In 1.11 the key is configured on `Settings → Model Providers`
  (stored as the `OPENAI_API_KEY` provider variable), so the bullet is reworded
  to match the current build.
- **Shared global key:** the OpenAI key is global and persists across tests /
  runs (not deleted by `cleanAllFlows`). Test 1 is therefore idempotent — it
  re-saves the same key and asserts the configured state rather than assuming a
  fresh, unconfigured start.
- **#636 flake (fixed 2026-07-14):** the persist waiter matched `PATCH` only, but
  the frontend fires `POST /variables/` (create, 201) when the key does not yet
  exist and `PATCH /variables/{id}` (update, 200) when it does. On a fresh CI
  container — or a run where no earlier test configured the provider first — the
  save takes the create path, so the PATCH-only waiter timed out on a request that
  never fired (intermittent because prior test order decides which path runs;
  openai flaked 07-09/07-10). Network repro (deleted-var, live): `validate-provider`
  → **200**, persist → **POST 201**, PATCH-only waiter → timeout. Backend healthy:
  a **test defect**, not a product bug. Fix: match `POST` **or** `PATCH`. Same fix
  in `google-provider.spec.ts`.
- **Per-run sentinel** over a generic non-empty check: proves *this* execution
  produced the output, so the "execute with OpenAI" bullet can't pass on stale
  text.
- **Flow cleanup (id-scoped, issue #605):** Test 2 creates a flow via
  `SimpleAgentTemplatePage.load()`, which does NO cleanup (post-#553 contract).
  The spec tracks every `POST /api/v1/flows` → 201 id fired during load and
  deletes them by id in `test.afterEach` (transient ids 404 harmlessly —
  `deleteFlow` treats 404 as done). Never a name-based or delete-all cleanup
  (cross-worker wiper class, #553/#520). Same pattern as
  `anthropic-provider.spec.ts`.
- **Why the tools are removed before executing (root-caused during validation):**
  the Simple Agent template ships with Web Search + URL tools. Executing it with
  those tools on `gpt-4o-mini` failed ~1 in 5 runs (even spaced ~60s apart) with a
  backend `ComponentBuildError` in the agent's tool / structured-output
  orchestration — a transient that has nothing to do with the provider-config
  contract §7.2 asks about. Deleting the tool nodes makes the agent a single-call
  plain LLM completion, which validates "execute with OpenAI" deterministically.
  Agent execution **with** tools is already covered by
  `agent-component-regression.spec.ts`; this spec deliberately trades that
  incidental coverage for a stable provider-config signal.
- **Autosave before Playground execution:** the Playground build runs the
  *persisted* flow, so the tool-node deletion must be saved first
  (`waitForFlowSaveSettled`) — otherwise the build still includes the tools.
