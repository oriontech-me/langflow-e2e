# OpenAI Provider — configure key, select GPT, execute

**Last validated:** Langflow 1.12.x

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

`@stable` was removed from **Test 2** by the OpenAI-quota quarantine #772 /
PR #775 — the key had no quota, not the test — and **restored in #992** once
the quota was confirmed back (live HTTP 200 completion on `gpt-4o-mini`) and
the test ran clean at `--retries=0`.

**Test 1** was quarantined at triage of daily #1417 (PR #1425 — `@stable`
removed **and** `test.fixme` added) for the recurrent 400 on the persist call,
and **restored in #1424** once both causes behind that one assert were measured
and the create-over-existing race was fixed (see Notes).

It was auto-removed a **second** time on the 2026-08-06 daily (commit `cb3082d`,
run 31093877484) for the same underlying reason — the account had no credits —
and **restored in #1333**, again on a live HTTP 200 completion plus 5 clean
`--retries=0` runs. The recurrence is what motivated the provider-health gate
below: without it, a dead-but-present key produces a hard failure that reads
like a product regression and costs the tag every time the account drains.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` set in `.env` (both tests self-skip without it).
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`. **Test 2 additionally gates
  on the health `collect-models` recorded there** — see the gate note below. A
  local run with no `providers.json` fails OPEN (nothing skips); a stale
  `inactive` record is bypassed with `IGNORE_PROVIDER_HEALTH=1`.
- Run with `--workers=1` (Test 2 loads a named template via
  `SimpleAgentTemplatePage`; agent-family convention). File is serial.

---

## Step by step *(required)*

---

**Test 1 — configure the OpenAI API key in Settings → Model Providers** (§7.2.1)

0. **No provider-health pre-gate, on purpose** — see the note below. The write
   *does* authenticate the key live (step 5), but a **credit-less** key still
   saves (the quota error carries no `401`/`authentication`/`api key` token, so
   `validate_model_provider_key` falls through its lenient branch), so pre-gating
   on `providers.json` would skip a test that passes. What #1424 needs is handled
   at the moment of the refusal instead (step 6).
1. Read the instance's current global variables over the API and record whether
   `OPENAI_API_KEY` is **already stored**. This is the expected create-vs-update
   branch for step 5, established before the browser touches the panel.
2. `SettingsPage.navigate()` → click `sidebar-nav-Model Providers`; wait for
   `settings_menu_header` to read "Model Providers"; click `provider-item-OpenAI`.
3. **Settle the panel before typing anything** (`awaitProviderPanelSettled`).
   The panel has ONE submit control, `provider-save-button`, whose label is
   picked at render time from `isAlreadyConfigured` — which is derived from the
   credential variables, so it reads **`Save` until `GET /api/v1/variables/`
   resolves** while the key input is already rendered (#1431). Clicking inside
   that window makes the frontend take the **create** branch for a name that
   already exists, and the backend answers **400
   `{"detail":"Variable name already exists"}`** — measured twice on the
   2026-08-11 daily and reproduced on demand by delaying that one request
   (#1424). The gate is therefore: button visible, **not** `aria-busy`, and its
   accessible name equal to `Replace` when step 1 found the key stored, `Save`
   when it did not.
4. Fill `provider-variable-input-OPENAI_API_KEY` with `OPENAI_API_KEY`, arm the
   two response waiters, then click `provider-save-button` (**by testid** — the
   label is state-dependent, so role+name matched nothing during that window).
5. **Validation (causal — no pre-existing-state false positive):** the save click
   must produce **both** a `POST /api/v1/models/validate-provider` → **200 with
   `valid: true` in the body** (the endpoint answers 200 for a credential it
   rejected, so the status alone proves nothing) **and** a persist to
   `/api/v1/variables/` → **2xx**. Three asserts hang off that persist:
   - **the verb matches the branch step 1 established** — `PATCH` when the global
     key exists, `POST` when it does not. This is the contract the #1424 flake
     violated, so it is asserted rather than tolerated: a panel that creates over
     an existing credential fails here, naming both verbs.
   - **the response is 2xx**, with the failure message carrying the method, URL,
     status and **body** — the write validates the credential live
     (`api/v1/variable.py` → `validate_model_provider_key`, a real
     `llm.invoke("test")`), so its refusal reason is the only thing that explains
     the status, and a future occurrence must not need artifact archaeology.
   - **the key is readable back** — `GET /api/v1/variables/` lists
     `OPENAI_API_KEY` afterwards. This is what the step is really there to prove;
     the response status alone would still pass if a 2xx wrote nothing.
6. **Refusals that are not Langflow's fault are skipped, loudly, never
   tolerated silently.** A 400 whose body says the credential did not
   authenticate (`Invalid API key for OpenAI`) or that the provider could not be
   reached is retried **once** through the panel's own `Retry Save` and, if
   refused again, ends the test as a `test.skip` **quoting the backend's exact
   `detail`** (#980's trade — a drained key must not cost a scheduled day, and
   #1012's rule — the reason is printed, never swallowed). Everything else,
   including `Variable name already exists`, stays a **hard failure**: that one is
   ours, and muting it is how the timing bug this test now guards would rot.

---

**Test 2 — configured OpenAI is selectable in the Agent and executes** (§7.2.2 + §7.2.3)

0. **Provider-health gate** — `providerSkipGate("openai")` skips the test when
   `collect-models` recorded OpenAI `inactive` (drained balance, revoked key,
   spend cap), quoting the collected reason. This test makes a live completion
   call, so a dead key cannot produce a verdict about Langflow — see the gate
   note below.
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

- **Configure:** clicking Save on the OpenAI key produces a
  `validate-provider` **200 with `valid: true`** and a **2xx** persist to
  `/variables/` whose **verb matches the instance's state** — `PATCH` when the
  global key already exists, `POST` when it does not (#636/#1424) — and
  `OPENAI_API_KEY` is **readable back** from `GET /api/v1/variables/` afterwards.
  The pass is caused by this save, not by a pre-existing configured state.
- **Select + execute:** the Agent's model dropdown shows a GPT model, and running
  the flow returns the per-run sentinel in the AI response.

## Guarding against false positives *(how)*

- **Test 1** asserts the *save requests succeed* (`validate-provider` 200 with
  `valid: true` + `POST`/`PATCH /variables` 2xx) **and** the key is readable back,
  not a UI state that pre-exists from an earlier test's global key — so a no-op
  save cannot pass. The **verb** assert closes the remaining hole: a 2xx obtained
  by creating a second credential for a name that already exists is not a
  successful save, and a `POST` on a configured instance now fails by name.
- **Test 1's skip path cannot hide a Langflow defect:** only two refusal shapes
  skip — the backend saying the credential did not authenticate, and the backend
  saying it could not reach the provider — and both are printed with the exact
  `detail`. `Variable name already exists`, `Variable value cannot be empty` and
  anything unrecognised stay hard failures.
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
- `src/backend/base/langflow/api/v1/variable.py` + provider-config storage — the
  global `OPENAI_API_KEY` provider variable the key is saved into.
- `src/lfx/src/lfx/components/models_and_agents/` — Agent execution with the
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
- **Provider-health gate on Test 2 only (#1333, mechanism from #1029):** the two
  tests gate differently on purpose. Both require `OPENAI_API_KEY` to be *set*;
  only Test 2 also requires the provider to be *usable*. `hasProviderEnvKeys`
  measures presence, never health — so on the 2026-08-06 daily, where the account
  had no credits (`collect-models` recorded `openai inactive — You have no
  credits remaining`, and 6 of that run's 9 skips quoted it), Test 2 ran anyway:
  the Agent's run never completed, the Stop button stayed visible past the 120 s
  wait, no `div-chat-message` ever rendered, all three attempts hard-failed and
  the workflow auto-removed `@stable` (`cb3082d`). A red that says nothing about
  Langflow, for the second time (cf. #772/#775). `providerSkipGate("openai")`
  reads the same `providers.json` the provider-**parametrized** specs already
  honour, so a dead key now yields a skip quoting the measured reason.
  **Test 1 is deliberately NOT gated:** it makes no completion call, and
  `POST /api/v1/models/validate-provider` answers 2xx on a credit-less key
  (OpenAI authenticates the key without checking balance — `GET /v1/models`
  behaves the same, which is why the probe cannot see a drained account and only
  the real call returns 429 `no credits remaining`). Test 1 therefore still
  passes and still covers the Settings save path on a day the account is dry;
  gating it would trade real coverage for nothing. **This is a resilience fix,
  not a root-cause fix** — the account still has to be funded for §7.2.3 to be
  exercised at all. The general remedy (probe candidate keys and resolve a live
  one before the suite, fail loud when every candidate is dead) is tracked at
  **#976**; this gate only stops the outage from being reported as a product
  regression in the meantime. The same gap exists in `anthropic-provider.spec.ts`
  and `google-provider.spec.ts`, tracked at **#1415**. **#1424 did not change
  that decision, and the measurement is why:** the credential write *does*
  authenticate live, but only an error whose text carries `401`,
  `authentication` or `api key` becomes a 400 — a quota/credit failure falls
  through `validate_model_provider_key`'s lenient branch and the variable is
  stored normally (measured on 1.12.0.dev24: `PATCH` with the funded key → 200
  after a 3.7 s live call; with a garbage key → 400 `Invalid API key for
  OpenAI`). Pre-gating Test 1 on `providers.json` would therefore skip it on
  exactly the drained-account days it still passes, so the refusal is classified
  **when it happens** instead (step 6).
- **#1424 — the persist call answered 400 while `validate-provider` succeeded
  (recurrent: dailies 2026-07-13 and 2026-08-11).** Both `ok()` asserts emit the
  same generic signature, so the first job was telling them apart. Settled from
  the 07-13 JSON artifact: attempts 1-2 were the (already fixed) #636 PATCH-only
  waiter timeout, and attempt 3 failed on **`persistResp`** —
  `PATCH … → 400 {"detail":"Invalid API key for OpenAI"}`. On 08-11 the shard log
  carries **two** `POST /api/v1/variables/ → 400
  {"detail":"Variable name already exists"}` with `OPENAI_API_KEY` already in the
  preflight's configured list. So one issue, **two** causes behind one assert:
  - **the create-over-existing race (ours).** The write endpoint refuses a
    duplicate name instantly (0.07 s, no live call), and the panel only knows the
    name exists after `GET /api/v1/variables/` resolves — the #1431 window.
    Reproduced on demand by delaying that single request: label `Save`,
    `POST → 400`, toast *"Error Saving Configuration — Variable name already
    exists"*, button relabelled `Retry Save`. Fixed by settling the panel and now
    **asserted as a contract** (verb must match the state), so it stays visible.
  - **the credential the backend rejected (not ours).** Retried once through
    `Retry Save`, then skipped quoting the backend `detail`.
- **Why `provider-save-button` by testid (#1431):** there is no distinct
  "Replace" button — one control, three labels (`Save`, `Replace`, `Retry Save`),
  chosen at render time. A `role=button, name=/Save|Replace/` locator matched
  nothing during the pre-load window and reported "element(s) not found" instead
  of the label it did find.
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
