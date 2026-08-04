# OpenAI Compatible — unified provider setup (base URL + optional key, live-only catalog)

**Last validated:** Langflow 1.12.x
**Spec file:** `tests/tests-automations/regression/core-functionality/model-provider/openai-compatible-provider-setup.spec.ts`
**Issue:** #1193 (Wave 5 — 1.11.0 feature coverage, QA-CHECKLIST §7.8)
**Upstream:** langflow-ai/langflow#13940, #14199

---

## What this test validates *(required)*

Langflow 1.11.0 promotes **OpenAI Compatible** to a first-class unified model
provider: any endpoint that speaks the OpenAI HTTP API shape (OpenRouter,
Together, a self-hosted vLLM/TGI/LM Studio, or OpenAI itself) is configured from
**Settings → Model Providers** with a **base URL** plus an **optional API key**,
and the models it serves become selectable by a flow.

Two properties make this provider different from every provider already covered
by §7.2–§7.6 and by the Azure AI Foundry sibling (§7.8), and they are where this
spec's assertions live:

1. **It is a live-only provider.** It is contributed by an extension bundle
   (`lfx_openai_compatible`, registered through `extension.json` →
   `provider_registry`) and ships **no static catalog rows at all**
   (`get_live_only_providers()` in
   `lfx/base/models/unified_models/provider_queries.py`). While unconfigured it
   is listed with an **empty** model list purely so its configuration form can be
   offered (`langflow/api/v1/models.py :: list_models`); every model it ever
   offers comes from a live `GET <base_url>/v1/models` against the operator's
   endpoint. Contrast Azure AI Foundry, which seeds five suggestion models with
   no endpoint configured. This is the one provider where the model list *is* the
   connectivity proof — the playbook's live-catalog rule is satisfied here in a
   way it is not for Groq or Mistral.
2. **Its API key is optional, but it is still the provider's *primary*
   variable.** `OPENAI_COMPATIBLE_BASE_URL` is required and non-secret;
   `OPENAI_COMPATIBLE_API_KEY` is optional and secret (a local server may need
   no auth). `get_model_provider_variable_mapping()` picks the provider's
   *secret* as primary, so it is the **API key** write that the backend
   validates, and that validation needs the **base URL** — a coupling this spec
   exercises directly (see the finding below).

The suite covers the surface (both variables, live-only catalog, rejected
endpoints) with **no credentials of any kind**, and covers the operator's real
path (both variables saved, models discovered, model runs in a flow) using the
`OPENAI_API_KEY` the lanes already carry, pointed at `https://api.openai.com/v1`
— the issue's own "including OpenAI itself". **No new CI secret is required**,
unlike the Foundry sibling.

### Finding this spec encodes (measured, not assumed)

On **1.12.0.dev15**, saving base URL + API key from Settings → Model Providers
**silently persists only the base URL**. Measured 3 out of 3 UI saves:

| Request | Result |
|---|---|
| `POST /api/v1/models/validate-provider` | `200` · `{"valid": true}` |
| `POST /api/v1/variables/` (`OPENAI_COMPATIBLE_BASE_URL`) | `201` |
| `POST /api/v1/variables/` (`OPENAI_COMPATIBLE_API_KEY`) | **`400`** · `{"detail":"Invalid OpenAI-compatible base URL"}` |

The frontend issues the two variable writes **concurrently** (its own console
logs `Duplicate request: /api/v1/variables/`). The API-key write is the
**primary**-variable write, so `create_variable` validates it via
`validate_model_provider_key(provider, {**get_all_variables_for_provider(...),
name: value})`; the base URL created by the sibling request is not visible yet,
so the OpenAI-Compatible validator raises `Invalid OpenAI-compatible base URL`
and the key is dropped. **No error is surfaced in the UI**: no toast, no
model-count suffix, no `provider-disconnect-button` — the panel looks like the
save simply did nothing.

The mechanism was isolated against the API, same instance, same payloads:

| Ordering | Base URL | API key |
|---|---|---|
| sequential (await the first, then POST the second) | `201` | `201` |
| concurrent (both in flight) | `201` | **`400`** |

Consequence for a user: **an authenticated OpenAI-compatible endpoint cannot be
configured through the Settings UI at all** — discovery then runs keyless, the
endpoint answers `401`, and the provider reports `is_configured: true` with
**0 models**.

**Test 6 asserts the correct behaviour and is `test.fixme`** — the repo's
live-defect convention (`api-folders-crud.spec.ts` #965/LE-2020,
`mcp-server.spec.ts` #1266): the assertions stay strict and untouched, the test
carries no `@stable`, and **lifting the quarantine (remove `test.fixme`, add
`@stable`) is a deliverable of [LE-2124](https://datastax.jira.com/browse/LE-2124)**,
filed from this evidence. It is declared **last** in the file because `mode: "serial"` skips the rest of a
describe after a failure — in its narrative position (4th) its red cost the
discovery and execution tests their run, measured. Tests 4 and 5 configure the
pair **via the API, sequentially**, so the discovery and execution coverage does
not depend on the broken UI path.

---

## Tags *(required)*

Declaration order in the file, which is also execution order (`mode: "serial"`):

| Test | Tags |
|---|---|
| 1 — provider offered with a live-only, empty catalog | `@model-provider`, `@settings`, `@api` |
| 2 — unreachable base URL rejected, nothing persisted | `@model-provider`, `@settings` |
| 3 — bogus key on a real endpoint rejected with the auth message | `@model-provider`, `@settings` |
| 4 — live discovery mirrors the endpoint's `/v1/models` | `@model-provider`, `@settings`, `@api` |
| 5 — a discovered model runs in a flow | `@model-provider`, `@components`, `@playground` |
| 6 — Settings Save persists BOTH variables — **`test.fixme`** | `@model-provider`, `@settings`, `@regression` |

Cross-cutting: `@api` / `@regression` / `@components` as above. Functional:
`@model-provider` on all six, plus `@settings` for the Settings-page tests and
`@playground` for the execution test.

**`@stable` is deliberately withheld from test 6**, which is quarantined
(`test.fixme`) against a confirmed live product defect: it must not enter
`daily-stable.yml`, which opens a `daily-failure` issue per red, and it must not
redden `pr-validation.yml` — the import graph selects this file for any PR
touching the model-provider area. Tests 1–5 carry `@stable` once the validation
burst is clean — decided at VERIFY, recorded in the PR.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on `1.12.0.dev15`).
- Tests 1–3 need **no credentials**. Test 3 needs egress from the Langflow
  container to `https://api.openai.com` (the lanes already have it — every
  OpenAI spec depends on it); it uses a deliberately invalid key.
- Tests 4–6 need a reachable OpenAI-compatible endpoint plus a working bearer:
  - `OPENAI_COMPATIBLE_TEST_BASE_URL` — defaults to `https://api.openai.com/v1`.
  - `OPENAI_COMPATIBLE_TEST_API_KEY` — defaults to `OPENAI_API_KEY`.
  - `OPENAI_COMPATIBLE_TEST_MODEL` — defaults to `gpt-4o-mini`; must be one of
    the ids the endpoint's `/v1/models` returns (the probe checks it).
  Each of these skips **with an explicit reason** when the probe cannot reach the
  endpoint, never silently.
- Every test that writes `OPENAI_COMPATIBLE_*` **skips** when the instance
  already has either variable stored: it would overwrite and then delete a
  credential it does not own (the Foundry sibling's guard, same reason).
- The provider is not part of `collect-models.spec.ts`, so no model-collection
  step is required.

---

## Step by step *(required)*

Live-scouted testids (1.12.0.dev15): `provider-search-input`, `provider-list`,
`provider-item-OpenAI Compatible`,
`provider-variable-input-OPENAI_COMPATIBLE_BASE_URL` (`type=text`),
`provider-variable-input-OPENAI_COMPATIBLE_API_KEY`, the **Save** button (by
role/name — it has no testid and is `disabled` while the required base URL is
empty), `provider-disconnect-button`, `model-provider-selection`,
`model-search-input`, `llm-models-section`, `llm-toggle-<model-id>`; on the
canvas `model_model`, `value-dropdown-model_model`, the option testid
`OpenAI Compatible-<model-id>-option` (provider-qualified, so an id served by
both OpenAI and OpenAI Compatible is unambiguous); playground
`playground-btn-flow-io`, `input-chat-playground`, `button-send`, `button-stop`.

**Test 1 — OpenAI Compatible is offered with a live-only, empty catalog**
1. Settings → Model Providers; search `compatible` → `provider-item-OpenAI Compatible`
   is the match (`provider-search-input`, cleared afterwards).
2. Open its detail: **both** `provider-variable-input-OPENAI_COMPATIBLE_BASE_URL`
   and `provider-variable-input-OPENAI_COMPATIBLE_API_KEY` render, and **Save is
   disabled** with the form empty.
3. `GET /api/v1/models?provider=OpenAI Compatible` returns the provider with
   `num_models === 0`, `is_configured === false`, `models: []`.
4. **Differential, so a page-wide or catalog-wide regression cannot pass it:**
   the same query for `Azure AI Foundry` returns a **non-empty** seed catalog on
   the same instance. Empty-here / non-empty-there is the live-only property.

**Test 2 — an unreachable base URL is rejected and nothing is persisted**
1. Fill the base URL with `https://e2e-openai-compatible-does-not-exist.invalid/v1`
   (an RFC-6761 `.invalid` host — never resolvable, no live dependency).
2. Arm the `POST /api/v1/models/validate-provider` waiter **before** clicking
   Save, then click.
3. The response is HTTP **200** — read the **body**: `valid === false` and
   `error` matching `/DNS resolution failed|Could not connect/`. (The endpoint
   answers 200 for a rejected credential; asserting only the status is the trap
   `ollama-provider.spec.ts` M1 and the Foundry sibling both call out.)
4. `GET /api/v1/variables/` contains **no** `OPENAI_COMPATIBLE_*` entry, and the
   provider is still `is_configured: false`.

**Test 3 — a bogus key on a real endpoint is rejected with the auth message**
1. Base URL `https://api.openai.com/v1`, API key `sk-e2e-bogus-openai-compatible-key`.
2. Save with the validate waiter armed: `valid === false` and `error` containing
   `Authentication failed for the OpenAI-compatible endpoint`.
3. Nothing is persisted (same assertion as test 2). This proves the key is
   actually **used** for the probe — the message is unreachable unless the
   endpoint saw the bearer and answered 401/403.

**Test 4 — live discovery mirrors the endpoint's `/v1/models`** *(setup via API, sequentially)*
1. Create the two variables through `POST /api/v1/variables/`, **awaiting the
   base URL write before the key write** (the ordering the UI gets wrong).
2. The test fetches the endpoint's own `GET <base>/v1/models` and computes the id
   set.
3. `GET /api/v1/models?provider=OpenAI Compatible`: the `llm`-typed
   `model_name` set **equals** that id set. Nothing static can satisfy this —
   the ids exist only at the operator's endpoint.
4. `num_models === 2 × ids.length`: `/v1/models` does not distinguish chat from
   embedding, so every served model is registered once per type (documented in
   `lfx_openai_compatible/discovery.py`).
5. UI: the panel renders `llm-toggle-<id>` for the first five ids alphabetically
   — the default-enabled set (`default: i < MIN_DEFAULT_MODELS`).

**Test 5 — a discovered model runs in a flow** *(setup via API, sequentially)*
1. Create a **Basic Prompting** flow from the starter via
   `createFlowFromStarter` (id-addressed, worker-isolated) and open it by id.
2. Wait for the flow's **mount** autosave to settle *before* touching the model
   selector. Opening a flow fits the viewport and schedules its own debounced
   `PATCH /api/v1/flows/{id}`; the endpoint has no version check and the frontend
   applies whichever response lands **last**, so a selection made while that PATCH
   is in flight is silently reverted. Measured here 2/2 while authoring: the run
   then executed **`chat-latest`** — the provider's first default-enabled id, the
   fallback for an empty selection — which rejects the Basic Prompting template's
   `temperature: 0.1` (`Unsupported value: 'temperature' … Only the default (1)
   value is supported`, confirmed directly against the endpoint for `chat-latest`
   and *not* for `gpt-4o-mini`), while the widget still read `gpt-4o-mini`.
3. `model_model` → choose `OpenAI Compatible-<model>-option`;
   `value-dropdown-model_model` then reads the model id.
4. Gate on the **persisted** binding, not the widget: poll
   `GET /api/v1/flows/{id}` until the Language Model node's
   `template.model.value` is `[{name: <model>}]` **and** `template.api_key.value`
   is `OPENAI_COMPATIBLE_API_KEY`. The run builds the persisted flow, and the two
   disagreed on every failing run above — the widget is not the contract.
5. Playground: send a sentinel (`OC-<runId>`) with an instruction to echo it
   verbatim; assert `button-stop` hides, then assert the **persisted** reply from
   `GET /api/v1/monitor/messages` for the same `session_id` contains the sentinel
   (the live bubble renders an empty placeholder mid-stream — #634). The
   provider-qualified option testid is what proves the run went through
   **OpenAI Compatible** and not through the OpenAI provider that may serve the
   same id.
6. Delete the flow by id and both variables.

**Test 6 — Settings Save persists BOTH variables** *(the #1193 core; `test.fixme` against the confirmed defect — see the finding)*
1. Fill base URL + a working key; arm waiters for `validate-provider` **and** for
   `POST|PATCH /api/v1/variables/`; click Save.
2. `validate-provider` answers `valid: true`.
3. Poll `GET /api/v1/variables/` for the **pair**
   `[OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_BASE_URL]` (the backend fact
   "this provider is configured", independent of how many requests the frontend
   chose to make — the Foundry sibling proved a single-response wait is a race).
   **This is the step the defect fails.**
4. The panel then reflects the configured state: the provider item shows a
   `/\d+ models/` suffix and `provider-disconnect-button` renders.

---

## Validation criterion *(required)*

The spec passes when, on a Langflow with **no** OpenAI-Compatible credential
stored:

- the provider is offered in Settings with **two** inputs — a required base URL
  and an optional API key — and contributes **zero** models while unconfigured,
  on an instance where Azure AI Foundry contributes a non-empty seed catalog
  (live-only property, no credential needed);
- an unresolvable base URL and a valid-URL/invalid-key pair are both rejected via
  `validate-provider` **body** (`valid: false`, with the DNS and the
  `Authentication failed for the OpenAI-compatible endpoint` messages
  respectively) and **nothing** is persisted;
- with the pair stored, `GET /api/v1/models?provider=OpenAI Compatible` returns
  exactly the id set served by `GET <base_url>/v1/models`, twice over (once per
  model type), and the panel renders the default-enabled toggles;
- one of those discovered ids, **persisted** on a Language Model node (selected
  through the `OpenAI Compatible-<id>-option` entry, then confirmed on
  `GET /api/v1/flows/{id}`), returns the run's sentinel in the Playground.

**Test 6 is quarantined, not passing**: saving both variables from the Settings UI
must leave both stored. It currently leaves only the base URL, silently. The test
is correct; the product is not. `test.fixme` keeps the suite honest without
reddening every lane that selects this file; when the upstream race is fixed, the
quarantine lifts (remove `test.fixme`, add `@stable`) and this note goes with it.
Measured on 1.12.0.dev15: 5 passed, 1 quarantined per run.

---

## Guarding against false positives *(how)*

- **Every "it appeared" assertion has a matching "it was absent"**: the empty
  live-only catalog is asserted against Foundry's non-empty one on the same
  instance and in the same run; the configured-state markers
  (`provider-disconnect-button`, the `N models` suffix, `llm-toggle-*`) are
  asserted **absent** while unconfigured, so their later presence is a real state
  change.
- **`validate-provider` bodies, never statuses**: the endpoint answers HTTP 200
  for a credential it rejected.
- **Waiters armed before the click**: a pass can only be caused by the save under
  test, never by pre-existing state.
- **The pair, not the first write**: the configured assertion polls for both
  variable names, because a two-variable provider issues two writes and waiting
  on one loses ~1 run in 3 (measured on the Foundry sibling).
- **Sentinel per run** for the execution test: a cached or stale chat message
  cannot satisfy it. The sentinel is logged, never used to assert model
  intelligence.
- **Provider-qualified option testid** for the model selection: the same model id
  may be served by both `OpenAI` and `OpenAI Compatible`; an unqualified locator
  would pass while exercising the wrong provider.
- **Skip guards are explicit**: `test.skip(!probe.usable, reason)` and
  `test.skip(alreadyConfigured, reason)` — never a silent pass. (#570/#1012.)

---

## Cleanup *(required by the repo's flow-cleanup rule)*

- `afterEach` deletes every `OPENAI_COMPATIBLE_*` variable this file created
  (`GET /api/v1/variables/` → `DELETE /api/v1/variables/{id}`), so a failed run
  cannot leave the provider half-configured for the next spec.
- Test 6 deletes its flow **by id** in a `finally`, so a mid-test failure still
  cleans up. No spec in this file uses the shared template-card path.
- Nothing global is touched: no other provider's variables, no other user's
  flows.

---

## What this test does not cover *(optional)*

- **Embedding discovery from a custom endpoint** (upstream #14199) beyond
  asserting that every discovered id is registered for both model types: no
  embedding flow is executed. Would need an embeddings-capable endpoint plus a
  vector-store flow — a separate §7.8 bullet if the team wants it.
- **A keyless local endpoint** (the "optional API key" half of the contract in
  its purest form): it needs an OpenAI-compatible server reachable *from the
  Langflow container*, which on the runner means a service container plus
  `LANGFLOW_SSRF_ALLOWED_HOSTS` (the SSRF constraint documented for
  `go-httpbin`/Ollama). The `manual.yml` Ollama lane could host it; not wired
  here.
- **`/v1/models` payload variants**: `discovery.py` also accepts a bare list
  instead of `{"data": [...]}`. Not exercised — no real endpoint we can reach
  serves that shape.
- The provider's **component-level** fields (`openai_compatible_base_url` on the
  node, advanced) — this spec covers the unified Settings surface, as §7.8 asks.

---

## External dependencies *(required)*

- **A running Langflow** at `PLAYWRIGHT_BASE_URL` with the
  `lfx_openai_compatible` extension bundle installed (it ships with the nightly
  image; the provider's absence from `GET /api/v1/models/providers` would fail
  test 1 loudly rather than skip).
- **`https://api.openai.com`** reachable from the Langflow container — used as
  the OpenAI-compatible endpoint under test (test 3 with an invalid key, tests
  4–6 with `OPENAI_API_KEY`). Overridable via `OPENAI_COMPATIBLE_TEST_BASE_URL`
  for a lane that prefers a different endpoint.
- **`OPENAI_API_KEY`** (or `OPENAI_COMPATIBLE_TEST_API_KEY`) with access to
  `OPENAI_COMPATIBLE_TEST_MODEL` (default `gpt-4o-mini`) — one short completion
  per run. Already present on `daily-stable.yml` and `pr-validation.yml`; **no
  new secret is required.**
- `e2e-openai-compatible-does-not-exist.invalid` — a deliberately unresolvable
  `.invalid` host (RFC 6761). No dependency; it must never resolve.

---

## When to review this test *(optional)*

- When upstream fixes the concurrent variable-write race: lift test 6's
  quarantine (remove `test.fixme`, add `@stable`) and drop the finding note.
- When the flow-editor autosave stops reverting a model selection made right
  after mount: test 5's persisted-binding gate documents the current behaviour and
  is the place to re-measure it.
- When the bundle changes its variable keys, its `/v1/models` URL derivation, or
  the `MIN_DEFAULT_MODELS` default-enable rule
  (`lfx_openai_compatible/extension.json`, `discovery.py`).
- When `get_live_only_providers()` gains a static catalog for this provider —
  test 1's empty-catalog assertion is the tripwire.
