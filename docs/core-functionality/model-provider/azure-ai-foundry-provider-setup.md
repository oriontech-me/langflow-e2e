# Azure AI Foundry — unified provider setup (deployment names, not catalog IDs)

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

QA-CHECKLIST §7.8 "Azure AI Foundry in the unified provider setup: configuration
accepts deployment names, provider appears configured" — the 1.11.0 addition to
the unified **Settings → Model Providers** surface (upstream
`langflow-ai/langflow#13912`, `#14023`).

Azure AI Foundry is the first provider in that surface whose model identities are
**operator-defined**: the seed catalog (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`,
`o3-mini`, `Mistral-Large-3` — `lfx/base/models/azure_ai_foundry_constants.py`) is
a suggestion list, and inference actually addresses the **portal deployment name**
the operator typed. Two consequences shape this spec and separate it from every
keyed sibling (`openai-provider.spec.ts`, `google-provider.spec.ts`):

1. **Two required variables, not one** — `AZURE_AI_FOUNDRY_API_KEY` *and*
   `AZURE_AI_FOUNDRY_ENDPOINT` (the OpenAI-compatible endpoint from the Foundry
   portal). Validation is a live `GET <endpoint>/models` with an `api-key` header
   (`request_azure_ai_foundry_model_entries`, `lfx/base/models/model_utils.py`);
   both variables must be present or the backend validator returns without
   checking anything.
2. **Free-text model enablement** — the provider panel renders a Foundry-only
   hint (`custom-deployment-hint`: *"Use your Azure AI Foundry deployment names
   from the portal (not catalog model IDs). Search or type a name to add one."*),
   its search box says *"Search or add a deployment name…"* instead of *"Search
   models…"*, and a name absent from every catalog can be enabled and is stored
   under the typed identity `Azure AI Foundry::llm::<deployment>`.

The six tests split by dependency, deliberately:

| # | Test | Needs Azure credentials |
|---|---|---|
| 1 | Provider surface: listed, searchable, panel opens, Foundry-only deployment hint + placeholder, seed catalog, differential vs OpenRouter | no |
| 2 | Unconfigured provider: two-variable form (both inputs + Save disabled), read-only catalog — no enable toggle, no add-deployment control | no |
| 3 | Bogus endpoint + key are rejected and nothing is persisted (causal negative control) | no |
| 4 | A non-catalog deployment name is accepted, stored under the typed identity, and rendered in the panel | no |
| 5 | Real credentials configure the provider; the add-deployment control appears and enables a portal deployment through the UI | **yes** |
| 6 | The configured deployment executes a real inference through the Language Model component | **yes** |

Tests 1–4 hold the surface without any Azure account — they are what keeps this
coverage alive on every lane, and their bite comes from being **differential and
causal**, not from mere element presence (see *Guarding against false
positives*). Tests 5–6 exercise the operator's real path and probe-gate
themselves out with an explicit reason when the endpoint or key is absent.

If this fails, the 1.11.0 unified-provider addition is broken: Azure AI Foundry
stopped being configurable from Settings, the deployment-name mechanism
regressed to catalog-only identities, or credential validation stopped
validating.

---

## Tags *(required)*

| Test | Tags |
|---|---|
| 1 | `@stable` `@model-provider` `@settings` |
| 2 | `@stable` `@model-provider` `@settings` |
| 3 | `@stable` `@api` `@model-provider` `@settings` |
| 4 | `@stable` `@api` `@model-provider` `@settings` |
| 5 | `@stable` `@model-provider` `@settings` |
| 6 | `@stable` `@model-provider` `@components` `@playground` |

`@stable` is added only after the validation burst in this issue's VALIDATE
phase (3 clean `--retries=0 --workers=1` runs) plus the force-fail proof per
test, per `CONTRIBUTING.md`.

**Test 5** was quarantined at triage of the 2026-08-12 daily (PR #1433 —
`@stable` removed **and** `test.fixme` added) and **restored in #1424**, where
the `400` on the credential write was traced to the write-time live validation
of the Foundry endpoint (see step 3). The other five tests kept `@stable`
throughout: they cover the unconfigured panel and a deployment path that does
not depend on that write.

**Why `@stable` on the credential-gated tests too.** Issue #1194 assumed the
whole spec needed Azure credentials and therefore shipped untagged. The surface
triage disproved the premise for tests 1–4, and the credentials turned out to
exist, so tests 5–6 were validated for real rather than shipped blind. Leaving
the file untagged was the worse option: `nightly.yml` is dormant and
`daily-stable.yml` runs `--grep @stable`, so an untagged spec runs in **no**
recurring workflow at all — the invisible-red pattern from #945/#940.

**All six run in CI.** `AZURE_AI_FOUNDRY_API_KEY` /
`AZURE_AI_FOUNDRY_ENDPOINT` / `AZURE_AI_FOUNDRY_TEST_DEPLOYMENT` are repository
secrets, wired into `daily-stable.yml`'s shard step and `manual.yml`'s Docker job
by #1270 — proven by a dispatch on that branch: `6 passed (48.7s)`, where the
lane had reported `4 passed, 2 skipped` before. Deliberately NOT wired into
`pr-validation.yml` (an unrelated PR must not spend a real Azure inference or
depend on that account's health — #1216) nor into `manual.yml`'s external-URL job
(these two tests STORE the credential pair in the target Langflow, which is not
ours to do on an instance we do not own — #1055); a PR that touches this spec is
covered by a manual dispatch.

Where the credentials are absent — a local run without the `.env` block, or a
lane not listed above — tests 5–6 **skip with the concrete reason**, the same
missing-dependency contract `google-provider.spec.ts` carries for
`GOOGLE_API_KEY`. A skip is never a green: it is reported as a skip.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly; the surface was
  scouted on **1.12.0.dev14** and the whole spec validated on **1.12.0.dev15**).
- `LANGFLOW_A2A_ENABLED`-style feature flag: **none** — Azure AI Foundry needs no
  flag; it is in the stock provider catalog (`GET /api/v1/models/providers`
  returns it on dev14) and the `langchain-azure-ai` package (1.2.3) ships in the
  nightly image. Its absence would surface as a validation error naming the
  package, which test 3 would report verbatim.
- Tests 1–4: no credentials, no external network.
- Tests 5–6 (`.env`, all three or the tests skip):

  ```
  # Azure AI Foundry provider (azure-ai-foundry-provider-setup.spec.ts). Tests 5-6
  # probe GET <endpoint>/models directly and skip with a reason when the key,
  # endpoint or deployment is missing / not served by the resource.
  AZURE_AI_FOUNDRY_API_KEY=
  AZURE_AI_FOUNDRY_ENDPOINT=          # https://<resource>.services.ai.azure.com/openai/v1
  AZURE_AI_FOUNDRY_TEST_DEPLOYMENT=   # portal deployment name, e.g. gpt-4o-mini
  ```

- Serial (`test.describe.configure({ mode: "serial" })`) and run with
  `--workers=1`: every test drives the same account-wide Settings state.
- No `collect-models` run needed — Azure AI Foundry is deliberately **not** added
  to `providerConfigMap` (`tests/helpers/provider-setup/provider-config.ts`).
  That map feeds the `collect-models` sweep and the keyed-provider surfaces; a
  two-variable provider does not fit its `api-key` / `base-url` union, and adding
  it would couple every lane's pre-flight to an Azure resource. The spec keeps
  its env gating local, exactly as `groq-provider.spec.ts` and
  `mistral-provider.spec.ts` do.

---

## Step by step *(required)*

Live-scouted testids (1.12.0.dev14, re-checked on dev15 where the run is green, via `playwright-cli`): `provider-list`,
`provider-search-input`, `provider-item-Azure AI Foundry`,
`provider-variable-input-AZURE_AI_FOUNDRY_API_KEY`,
`provider-variable-input-AZURE_AI_FOUNDRY_ENDPOINT`, `model-provider-selection`,
`custom-deployment-hint`, `model-search-input`, `model-search-empty`,
`llm-models-section`, `llm-tag-tool-<model>`, `llm-toggle-<model>`,
`add-custom-llm-deployment-button` / `add-custom-embeddings-deployment-button`
(both when the panel shows all model types) or `add-custom-deployment-button`
(type-filtered panel), Save by role+name; the Language Model node's model options are `<provider>-<model>-option` (e.g. `Azure AI Foundry-gpt-5-mini-option`). Endpoints:
`POST /api/v1/models/validate-provider`, `GET|POST /api/v1/models/enabled_models`,
`GET|POST|PATCH|DELETE /api/v1/variables/`.

**Test 1 — Azure AI Foundry is offered with a Foundry-only deployment surface**

1. Bootstrap, Settings → Model Providers; assert the header and `provider-list`.
2. Type `azure` in `provider-search-input`; assert the filtered list is exactly
   `provider-item-Azure AI Foundry` (the search path is how the page is used —
   the list renders a subset).
3. Clear the search, click `provider-item-Azure AI Foundry`; assert its
   `model-provider-selection` panel opens.

   > The **two-variable form** (both raw inputs + Save disabled while empty) is
   > asserted in **test 2**, not here: a *configured* provider replaces the raw
   > inputs with a masked value plus **Replace**, so those asserts only hold
   > behind the unconfigured-state gate. This test must run on every lane
   > regardless of what the instance has stored — it went red exactly once for
   > this reason while authoring, on an instance that still held the credentials.

4. **Assert (deployment-name contract):** `custom-deployment-hint` is visible and
   its text contains both `deployment names` and `not catalog model IDs`;
   `model-search-input`'s placeholder is `Search or add a deployment name…`.
5. **Assert (seed catalog):** `llm-models-section` is visible and lists the seed
   entries — `gpt-4o` present, ≥ 3 of the 5 seed names (floor, not exact: a
   catalog addition is not a regression, per the #993 count rule).
6. **Assert (differential):** open `provider-item-OpenRouter`; its
   `provider-variable-input-OPENROUTER_API_KEY` renders,
   `custom-deployment-hint` is **absent** and the search placeholder is
   `Search models…`. This is what proves step 4 measured a Foundry-specific
   surface rather than a page-wide string.

**Test 2 — an unconfigured Azure AI Foundry panel asks for two variables and stays read-only**

1. Open the Foundry panel (no credentials stored — asserted via
   `GET /api/v1/variables/`: no `AZURE_AI_FOUNDRY_*` entry; a configured instance
   skips with that reason).
2. **Assert (two variables):** both
   `provider-variable-input-AZURE_AI_FOUNDRY_API_KEY` and
   `provider-variable-input-AZURE_AI_FOUNDRY_ENDPOINT` are visible, and Save is
   **disabled** while the required pair is empty — Foundry is the first provider
   on this page that needs two.
3. **Assert:** no `llm-toggle-*` / `embeddings-toggle-*` control exists in
   `model-provider-selection` — the seed rows render with their capability tags
   (`llm-tag-tool-gpt-4o`) and nothing to switch.
4. Type an arbitrary name (`e2e-unconfigured-probe`) into `model-search-input`.
5. **Assert:** `model-search-empty` ("No models match your search.") renders and
   **no** `add-custom-*deployment-button` appears — the add-deployment control is
   gated on the provider being configured
   (`isEnabledModel = is_enabled || is_configured`, scouted in the shipped
   bundle). This is the precondition test 5 flips.

**Test 3 — bogus endpoint + key are rejected and nothing is persisted**

1. Assert the pre-state via API: no `AZURE_AI_FOUNDRY_API_KEY` /
   `AZURE_AI_FOUNDRY_ENDPOINT` variable exists.
2. Fill the key with a garbage token and the endpoint with a
   deliberately-unresolvable Foundry-shaped host
   (`https://e2e-invalid-<runId>.services.ai.azure.com/openai/v1`).
3. Arm a waiter on `POST /api/v1/models/validate-provider` **before** clicking
   Save, then Save.
4. **Assert:** the response is HTTP **200** with body `valid === false` and an
   `error` containing `Azure AI Foundry` — the backend took the Foundry branch
   and reported a validation failure (measured: ~4.7 s, `NameResolutionError`).
   The status alone is worthless here: this endpoint answers 200 for a failed
   validation (same trap as `ollama-provider.spec.ts`' corrected M1).
5. **Assert (nothing persisted):** `GET /api/v1/variables/` still has no
   `AZURE_AI_FOUNDRY_*` entry, and the panel still shows no `llm-toggle-*` —
   a rejected credential leaves no state behind.

**Test 4 — a non-catalog deployment name is accepted and rendered (API + UI)**

1. Pre-clean: `POST /api/v1/models/enabled_models` with
   `enabled: false` for the fixed test name, ignoring the result, so a leftover
   from an earlier run cannot pre-satisfy the assert.
2. `POST /api/v1/models/enabled_models` →
   `[{ provider: "Azure AI Foundry", model_id: "<E2E_DEPLOYMENT>", enabled: true,
   model_type: "llm" }]`, where `<E2E_DEPLOYMENT>` is a fixed name that exists in
   **no** catalog (`e2e-azure-foundry-deployment`).
3. **Assert (API):** 200, and the response's `enabled_models` contains
   `Azure AI Foundry::llm::e2e-azure-foundry-deployment` — the deployment name
   survives verbatim under the typed identity, with no catalog membership and
   **no credentials configured** (the backend validator returns early when the
   provider's variables are absent, so enablement is credential-independent by
   design — read in `api/v1/models.py::update_enabled_models`). The read side is
   then asserted to know the identity too, **by key**:
   `GET /api/v1/models/enabled_models` gains the deployment as a key in both
   `enabled_models["Azure AI Foundry"]` and
   `enabled_models_by_type["Azure AI Foundry"].llm`, and loses it on disable —
   causal in both directions. Its **boolean stays `false`** here, and that is
   correct rather than a defect: the value answers *"enabled AND usable"*, so
   every seed entry reads `false` on an unconfigured provider too (measured on
   1.12.0.dev14; the first authored version of this test asserted the boolean and
   failed for exactly this reason). The `true` state belongs to the configured
   path — test 5 reads the row's own toggle.
4. Open Settings → Model Providers → Azure AI Foundry.
5. **Assert (UI):** `llm-models-section` contains the deployment name **in
   addition to** the seed entries — the panel merges free-text enables for this
   provider only (scouted live: the row renders after a reload, with a `tool`
   tag).
6. Cleanup: `POST enabled_models` with `enabled: false`; assert the response's
   `enabled_models` no longer contains the identity.

**Test 5 — real credentials configure the provider and enable a portal deployment through the UI** *(skips without credentials, and on an instance that already has them)*

0. **Ownership gate.** Skip when `GET /api/v1/variables/` already holds an
   `AZURE_AI_FOUNDRY_*` credential. This test stores the pair and **deletes it**
   in teardown, so on a pre-configured instance it would both race that state and
   destroy a credential it does not own. Measured: with a credential left behind
   by hand, the run produced three different intermittent failures across steps
   (a missing `llm-toggle-*`, and a `400 Validation failed for Azure AI Foundry`
   on the enable) — none of them a defect in what the test is about. Test 6
   carries the same gate; test 4 does not need it (it only enables and disables a
   synthetic deployment name).
1. Probe `GET <AZURE_AI_FOUNDRY_ENDPOINT>/models` with the `api-key` header
   straight from the test host; skip with the concrete reason when the key or
   endpoint is missing, the probe is non-200, or the payload has no `data` list.
2. Open the Foundry panel, **settle it** (`awaitProviderPanelSettled` with
   `expectConfigured: false` — the ownership gate in step 0 already established
   that nothing is stored, so `provider-save-button` must read `Save`, not be
   `aria-busy`; clicking before `GET /api/v1/variables/` resolves is what makes
   the openai sibling create over an existing name, #1431/#1424), fill both
   variables, arm waiters on `POST /api/v1/models/validate-provider` **and** on
   the variables write (`POST /api/v1/variables/` or `PATCH
   /api/v1/variables/{id}` — the frontend branches on existence, #636), click
   `provider-save-button`.
3. **Assert (configure):** validate-provider body `valid === true` and the
   variables write is 2xx — armed before the click, so a pre-existing configured
   state cannot pass the test.

   > **The `400` this step used to die on, and why it is now classified (#1424).**
   > The KEY write is validated **live**: `create_variable` calls
   > `validate_model_provider_key`, which for Foundry issues
   > `request_azure_ai_foundry_model_entries(endpoint, key)` with a **10 s read
   > timeout** and turns **any** exception into `400 {"detail": "Could not
   > validate Azure AI Foundry credentials: …"}`. Both the 2026-08-10 and
   > 2026-08-12 dailies carry exactly that, with `HTTPSConnectionPool(…): Read
   > timed out. (read timeout=10.0)` — the resource answered the test host's probe
   > and then took longer than 10 s to answer Langflow. The write is refused, the
   > key is **not** stored, and because the ENDPOINT write is not validated at all
   > (`get_model_provider_variable_mapping()` names only
   > `AZURE_AI_FOUNDRY_API_KEY` as the provider's primary variable — measured on
   > 1.12.0.dev24, where writing the KEY *first* is accepted in 0.86 s with no
   > validation because the endpoint is not yet stored), the pair is left
   > **half-configured with no rollback** — which is what the poll in step 4 then
   > times out on. So the poll was never the problem. A refusal whose body says
   > the provider could not be reached, or that the credential did not
   > authenticate, is retried **once** through the panel's own `Retry Save` and
   > then ends the test as a `test.skip` quoting the backend's exact `detail`
   > (#980's trade, #1012's rule). Any other refusal — including `Variable name
   > already exists` — stays a hard failure.
4. **Assert (provider state):** poll `GET /api/v1/variables/` until **both**
   `AZURE_AI_FOUNDRY_API_KEY` and `AZURE_AI_FOUNDRY_ENDPOINT` are stored, then
   assert the panel renders `llm-toggle-*` controls.

   > **Why a poll and not a read.** A two-variable provider means Save issues
   > **two separate** variables writes, and the waiter armed in step 2 resolves on
   > the FIRST one. Reading the stored state right after it lost the race ~1 run
   > in 3 while authoring: once with only `AZURE_AI_FOUNDRY_ENDPOINT` present, and
   > once as "no `llm-toggle-*` within 30 s" — the same cause wearing a different
   > symptom, since a half-configured provider legitimately renders no toggle.
   > The pair is the backend fact this step is about; how many requests the
   > frontend chose to make is not.
5. Type `AZURE_AI_FOUNDRY_TEST_DEPLOYMENT` into `model-search-input`.
6. **Assert (add-deployment control):** the `add-custom-*deployment-button` for
   language models is now visible — the exact control test 2 proved absent while
   unconfigured. Arm a waiter on `POST /api/v1/models/enabled_models` **before**
   clicking it, and assert that write is 2xx with the identity in its body: the
   row and its toggle render **optimistically**, so the UI alone cannot tell an
   accepted deployment from a write that never landed. Measured while authoring —
   reloading right after the click cancelled the in-flight POST and the
   deployment was gone afterwards while the panel still showed it.
7. **Assert (enabled + persisted):** the deployment row renders a real toggle
   (`llm-toggle-<deployment>`) and the add left it `data-state="checked"` — the
   half test 4 cannot reach, since an unconfigured provider renders no toggle at
   all — and after a page reload `GET /api/v1/models/enabled_models` still carries
   the deployment as a registered Foundry identity.
8. Cleanup (restores the pre-test account state): disable the deployment, then
   `DELETE /api/v1/variables/{id}` for both Foundry variables, asserting each
   delete is 2xx and that `GET /api/v1/variables/` no longer lists them.

**Test 6 — the configured deployment answers a real inference** *(skips without credentials)*

1. Same probe/skip as test 5. Note what the probe cannot check: `<endpoint>/models`
   is the resource's **catalog**, not its deployment list (*"Foundry /models is a
   catalog, not deployments"* — `model_utils.py`), so the deployment's existence
   cannot be pre-verified; the inference in step 6 is what proves it.
2. Configure the provider and enable `AZURE_AI_FOUNDRY_TEST_DEPLOYMENT` via API
   (setup, not the assert — test 5 owns the UI path).
3. Copy the **Basic Prompting** starter over the API (`createFlowFromStarter` +
   `openFlowById`) — it ships Chat Input → Language Model → Chat Output **wired**.
   Two paths were rejected on measurement, both while authoring:
   - adding the three components to a blank canvas leaves them **unconnected**,
     and the run then persists the user turn with **no reply at all** — a symptom
     indistinguishable from a provider failure;
   - clicking the card in the templates modal (`loadTemplateByName`) creates a
     blank `New Flow` placeholder first (#1005), whose id that helper can only
     clean when it manages to read a response body the SPA discards on navigation
     — here a stray `New Flow` **plus** `Basic Prompting` survived one run in two.
     The API copy is id-addressed, leaks nothing and is isolated per worker (#684).
   Open the node's `model_model` dropdown and pick
   `<provider>-<model>-option` — `Azure AI Foundry-<deployment>-option`, scouted
   live on 1.12.0.dev15. The **provider prefix matters**: a Foundry deployment
   can carry the same name as an OpenAI catalog id.
4. **Assert (selection):** `value-dropdown-model_model` shows the deployment name
   exactly — a catalog ID silently substituted for it fails here.
5. Playground: send a per-run sentinel; wait for completion on the deterministic
   `button-stop` hidden **and** `button-send` visible pair.
6. **Assert (execute):** the persisted reply for the session is non-empty and
   echoes the sentinel (monitor API, not the live bubble — the #634 stream race).
   Only a real Foundry inference addressed by deployment name can produce it.
7. Cleanup: delete the created flow id-scoped, disable the deployment, delete
   both variables.

---

## Validation criterion *(required)*

§7.8's two claims are each pinned by an observable that cannot pass by accident:

- *"configuration accepts deployment names (not catalog IDs)"* — test 4 stores a
  name present in no catalog and reads it back verbatim under
  `Azure AI Foundry::llm::<name>`, then finds it rendered in the provider panel
  alongside the seed catalog; test 5 does the same through the UI's
  add-deployment control; test 6 gets a real inference out of it.
- *"provider appears configured"* — test 5 asserts `valid === true` + a 2xx
  variables write from waiters armed before Save, and the resulting state change
  (toggles + `N models`), while test 3 proves the negative: a credential that
  does not validate leaves the provider unconfigured and the store untouched.

Tests 1–2 pin the surface itself (two-variable form, Foundry-only deployment
hint and placeholder, read-only-while-unconfigured), differentially against
OpenRouter so the asserts cannot pass on a page-wide string.

## Guarding against false positives *(how)*

- **Differential, not presence** — the deployment hint and the
  `Search or add a deployment name…` placeholder are asserted for Foundry **and**
  asserted absent for OpenRouter in the same run. A page-wide regression that
  showed the hint everywhere would fail.
- **Absence test before the presence test** — test 2 proves
  `add-custom-*deployment-button` is missing while unconfigured, so test 5's
  "the control appeared" is a real state change, not a control that is always
  there.
- **Body-level validation assert** — `validate-provider` answers HTTP 200 for a
  failed validation, so tests 3 and 5 assert `valid` in the body. An
  `ok()`-only assert would pass on rejection.
- **Waiters armed before Save** — the configure pass is caused by THIS save
  (family pattern from `openai-provider.spec.ts`).
- **No-state proof on rejection** — test 3 asserts the variables API is still
  empty afterwards, so "Save was clicked and nothing broke" cannot read as
  success.
- **A name no catalog contains** — test 4's `e2e-azure-foundry-deployment` cannot
  come from the seed catalog or any live fetch, so the assert can only pass
  through the free-text mechanism.
- **Skip ≠ pass** — tests 5–6 skip with the concrete reason (missing key /
  endpoint / deployment, non-200 probe, or a credential the test would not own),
  never silently green.
- **No unattributed 400** — every non-200 from `POST /api/v1/models/enabled_models`
  is logged with the backend's own `detail` (`Validation failed for
  Azure AI Foundry: …`, which is how a transient failure of the live `/models`
  probe surfaces). A bare "expected 200, received 400" cannot be triaged.
- **Force-fail plan** (CONTRIBUTING §2, executed in the issue's FORCE_FAIL
  phase): T1 — assert the hint on OpenRouter instead of Foundry ⇒ red;
  T2 — assert the add-deployment button IS visible while unconfigured ⇒ red;
  T3 — assert `valid === true` for the bogus endpoint ⇒ red; T4 — read back a
  different deployment name than the one enabled ⇒ red; T5 — fill a garbage key
  with the real endpoint ⇒ `valid === false` ⇒ red; T6 — expect a catalog ID
  (`gpt-4o`) in `value-dropdown-model_model` instead of the deployment ⇒ red.
  Every mutation carries `// FF-MUTATION` and is reverted with `grep -c` = 0.

---

## Cleanup *(required by the repo's flow-cleanup rule)*

- Tests 1–5 create **no flows** — they are Settings-UI and API only. Test 6
  creates one flow (an API copy of the starter, see step 3) and deletes it
  id-scoped in `afterEach` (`deleteFlow` + `getAuthToken`), per the mandatory
  contract. That `afterEach` deliberately carries **no `.catch()`**: `deleteFlow`
  throws on a failed deletion, and swallowing it is exactly how a leak goes
  silent. Verified by diffing the instance's flow-id set around a run — zero new
  ids.
- **Account-wide state:** every test restores what it wrote — credential
  variables are deleted by id, enabled deployments are disabled.
- **Cleanup tolerates the second write.** The credential purge lists-and-deletes
  in up to 3 bounded passes rather than once: a single pass that ran between
  Save's two writes left the second variable behind, and that leftover made the
  NEXT run's unconfigured-state tests (2 and 3) **skip** instead of run — the
  worse half of the failure, because a skip reads as "fine" in the summary.
- **One documented residue:** disabling a model does not erase the identity, it
  moves it into the internal `__disabled_models__` variable, and that variable is
  filtered out of `GET /api/v1/variables/` (`variable.py` skips names wrapped in
  `__`), so there is no id to DELETE. The test therefore uses a **fixed**
  deployment name rather than a per-run one: the residue is bounded to a single
  inert entry naming a deployment that does not exist, instead of growing by one
  per run. It affects nothing else — a disabled entry only hides a model from
  pickers, and no other spec uses Azure AI Foundry.

---

## What this test does not cover *(optional)*

- Azure **OpenAI** (`Azure OpenAI`) — a separate provider, listed by
  `GET /api/v1/models/providers` but not rendered on the Settings page on
  1.12.0.dev14 (a divergence noted as a product observation, not a defect).
- Embeddings deployments (`add-custom-embeddings-deployment-button`) — the same
  mechanism, one type away; language deployments carry the contract.
- The `AZURE_AI_FOUNDRY_*` **environment-variable fallback**
  (`_env_if_allowed` in `instantiation.py`) — configuration via Settings is §7.8's
  subject.
- Deprecated/unsupported-model rejection (`400 Cannot enable … model`) — catalog
  policy, not the Foundry path.
- Tool calling / structured output through a Foundry deployment (covered
  generically by the agent specs, provider-independent).

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/` — Model Providers page:
  `provider-item-*`, `provider-variable-input-*`, `model-provider-selection`,
  `custom-deployment-hint`, `model-search-input`,
  `add-custom-*deployment-button`.
- `src/lfx/src/lfx/base/models/model_metadata.py` — the `Azure AI Foundry` provider entry
  (its two variables, the endpoint description carrying the deployment-name
  rule).
- `src/lfx/src/lfx/base/models/azure_ai_foundry_constants.py` — seed catalog.
- `src/lfx/src/lfx/base/models/model_utils.py` —
  `request_azure_ai_foundry_model_entries` (credential validation) and the
  free-text enable merge.
- `src/lfx/src/lfx/base/models/unified_models/credentials.py` /
  `instantiation.py` — the Foundry validation branch and endpoint injection.
- `src/backend/base/langflow/api/v1/models.py` —
  `validate-provider`, `enabled_models` (typed identities), and their variable
  storage.
- `langchain-azure-ai` present in the image (1.2.3 on 1.12.0.dev14) — absent, the
  validator raises a message naming the package, which test 3 surfaces.
- **Tests 5–6 only:** a live Azure AI Foundry resource — endpoint, key and one
  language-model deployment (real network calls, real inference).

---

## When to review this test *(optional)*

- When the Azure credentials land as CI secrets (tests 5–6 stop skipping there).
- If the Foundry hint / placeholder strings change (`modelProviders.*` i18n keys)
  — the assert is on the substrings `deployment names` and
  `not catalog model IDs`.
- If `enabled_models` changes its identity format
  (`<provider>::<type>::<name>`) — test 4 asserts it directly.
- If the add-deployment control stops being gated on `is_configured` — test 2's
  absence assert is the tripwire.
