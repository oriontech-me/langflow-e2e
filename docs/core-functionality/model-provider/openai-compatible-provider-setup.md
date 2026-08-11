# OpenAI Compatible — unified provider setup (base URL + optional key, live-only catalog)

**Last validated:** Langflow 1.12.x (1.12.0.dev23)
**Spec file:** `tests/tests-automations/regression/core-functionality/model-provider/openai-compatible-provider-setup.spec.ts`
**Issue:** #1193 (Wave 5 — 1.11.0 feature coverage, QA-CHECKLIST §7.8); #1334 (test 5's binding assertion); #1364 (test 4's quarantine, lifted — the partial-catalog finding below)
**Upstream:** langflow-ai/langflow#13940, #14199, #14311

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

### Finding this spec encoded — the Settings save dropped the key (LE-2124, FIXED on 1.12.0.dev19)

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

**Test 6 asserted the correct behaviour and was `test.fixme`** against that defect —
the repo's live-defect convention (`api-folders-crud.spec.ts` #965/LE-2020,
`mcp-server.spec.ts` #1266): the assertions stayed strict and untouched and the test
carried no `@stable`, with the lift as [LE-2124](https://datastax.jira.com/browse/LE-2124)'s
own deliverable.

**Lifted on 1.12.0.dev19.** Re-measured while working #1334: concurrent
`POST /api/v1/variables/` writes now answer **201/201, 3/3**, and test 6 passes **3/3**
through the Settings UI with its assertions unchanged. `test.fixme` is removed and
`@stable` added. It stays declared **last** in the file because `mode: "serial"` skips
the rest of a describe after a failure — in its narrative position (4th) its red cost
the discovery and execution tests their run, measured. Tests 4 and 5 still configure the
pair **via the API, sequentially**: their subject is discovery and execution, not the
save.

### Finding this spec encoded — a live catalog read is only as reliable as one endpoint call (#1364)

The daily of 2026-08-07 red test 4 on `num_models` reading **124** where the contract is
`2 × ids.length` = 248, and triage quarantined it on the reading that **embedding
registration had been dropped** upstream. Measured on 1.12.0.dev23, that reading is
**refuted**, and so is the successor reading (a *registration window* that converges):

| What was measured | Result |
|---|---|
| 30 consecutive `GET /api/v1/models?provider=OpenAI Compatible`, taken **60 s after** configuring | 22× `248 {llm:124, embeddings:124}`, 6× `124 {llm:124}`, 1× `124 {embeddings:124}`, 1× `0 {}` |
| 20 authenticated `GET https://api.openai.com/v1/models` **from inside the container** | 16 at 0.6–1.1 s, 3 at ~20 s, 1 past a 30 s cap |
| 20 **unfiltered** `GET /api/v1/models` — the request the Settings page makes — with the pair stored | p50 **5.0 s**, p90 **8.9 s**, max **14.6 s**; 2 of the 20 reported `num_models` 124 |

Two things follow. **Both halves are registered** — the missing half is sometimes the
`llm` one and sometimes the `embeddings` one, which no "second registration stopped
happening" explanation survives. And the partial read is **not** a warm-up state: it
still occurs minutes in, at roughly the rate the endpoint stalls.

The mechanism is in the bundle, and it is by design:
`lfx_openai_compatible/discovery.py :: fetch_live_openai_compatible_models` is called
**once per model type on every request**, each call a fresh
`GET <base>/v1/models` with `_TIMEOUT_SECONDS = 5`, and its docstring states the
degrade — *"Returns an empty list (never raises) … so a missing or broken endpoint
simply contributes no models"*. A stall longer than 5 s therefore costs exactly one
half of the catalog, and two stalls cost all of it, with **nothing in the 200 response
distinguishing that from a provider that genuinely serves fewer models**.

Consequences recorded here rather than re-derived:

- **For the spec:** every catalog read is polled on the shape it must terminate at
  (#1369 already did this for the API read; #1364 extends it to the panel, which makes
  its own uncached request and does not refetch). The assertion itself is unchanged —
  a real removal of the second registration cannot reach `2 × ids` and reds with the
  full expected-vs-received shape.
- **For the panel's own waits:** the same latency is *inside* the Settings page load, so
  `openProviderPanel` waits `PANEL_TIMEOUT_MS` (45 s) rather than the suite's usual 15 s.
  That 15 s sat **on** the observed maximum and red run 5 of this issue's validation
  burst — `provider-list` not found after 15 s, against a provider the step above had
  just proved complete.
- **For the product:** this is the user-facing form of the same thing — a Settings
  visit landing on a stalled call shows a half-populated (or empty) model list for a
  correctly configured provider, with no error. Not filed upstream; noted on #1364 as
  a candidate, since the tight 5 s timeout plus the silent `[]` is a resilience choice
  rather than a broken code path.
- **For triage:** it also explains the two neighbours held next to #1364 — the
  `Connection to the OpenAI-compatible endpoint … timed out` 400s seen on the PR lane
  and on the 2026-08-07 daily's test 3 are the *same* stall reaching a path that
  reports it, and the 2026-08-06 `toEqual` red on this same line was the `llm` half
  missing rather than a different defect.

### What test 5 gates on, and why it is NOT the stored credential (#1334)

Test 5 gates the run on the **persisted** node rather than on the widget, and the axis
it reads changed with **upstream #14311** (*"stop automatic provider field binding"*,
`646bdd6b`, forward-ported to `release-1.12.0` on 2026-08-04). That change deleted the
block that pre-populated a provider field's `value` with the credential **variable
name**, so `template.api_key.value` is now `""` on every read — from mount onward, before
any selection is made. The spec asserted that removed binding inline and could never
settle: the daily's failure reads `models: ["gpt-4o-mini"]` **correct** and
`credential: ""` against an expected `"OPENAI_COMPATIBLE_API_KEY"`, on 2/2 attempts of
run [31093877484](https://github.com/oriontech-me/langflow-e2e/actions/runs/31093877484)
and on **5/5** pre-fix repro runs.

Measured on **1.12.0.dev18**, and the differential is what settles it — the same node,
instance and session, selecting a **plain OpenAI** model instead:

| Selection | persisted `template.model.value` | persisted `template.api_key` |
|---|---|---|
| `OpenAI Compatible` / `gpt-3.5-turbo` (×4) | `[{name, provider: "OpenAI Compatible", …}]` | `{value: "", load_from_db: false, show: true, required: false}` |
| `OpenAI` / `gpt-5.6` | `[{name, provider: "OpenAI", …}]` | `{value: "", load_from_db: false, …}` |

An empty `api_key` is therefore **build-wide and provider-agnostic**, not an
OpenAI-Compatible persistence failure — which is the hypothesis this had to rule out
before adopting the upstream lead. The backend source in the running image says the same:
`apply_provider_variable_config_to_build_config` is documented *"Apply the current
provider's metadata **without changing explicit field values**"* and writes only
`show` / `required` / `advanced` / `info`. The `models` half persisting while the
credential does not has one explanation under this reading: **different writers** —
`model.value` is the user's selection carried by the editor's autosave, while
`api_key.value` was written *only* by the block #14311 deleted, so nothing writes it now.

**The credential is no longer stored, but it is still DETERMINED — by the provider of the
selected model**, so the assertion moves onto that axis (the same migration #1274 applied
to the shared helper `tests/helpers/flows/agent-credential-settle.ts`, which this spec
did not receive because it asserted the shape inline). `instantiation.py` takes
`provider = model.get("provider")` off the selected entry and calls
`get_api_key_for_provider(user_id, provider, api_key)`; with `api_key` empty that resolves
`get_provider_secret_variable_key(provider)`. Proved causally, not assumed: with the pair
configured the run answers and the message carries `properties.source: "gpt-3.5-turbo"`;
deleting **only** `OPENAI_COMPATIBLE_API_KEY` while a valid `OPENAI_API_KEY` stays
configured account-wide leaves the persisted binding unchanged and turns the run into
`401 - Incorrect API key provided: EMPTY`. The run resolves **this** provider's key and
does not borrow the OpenAI provider's — which is exactly what the old assertion existed
to protect, and the provider axis is **stronger** here than the variable name, because
`api.openai.com` serves ids the plain OpenAI provider also serves.

`api_key` is **read and printed** in the poll's failure diagnostic but asserted in neither
direction. Requiring it empty would swap one dated premise for another and break a
`manual.yml` dispatch at a pre-#14311 build; the field is simply no longer evidence about
anything (#1274's rule).

### Why test 5 enables its model explicitly (#1334)

`gpt-4o-mini` carries **`default: false`** in this provider's live catalog — only five ids
are `default: true` (`babbage-002`, `chat-latest`, `chatgpt-image-latest`, `davinci-002`,
`gpt-3.5-turbo`, the first five alphabetically, `default: i < MIN_DEFAULT_MODELS`). The
node's model dropdown is built from the **default-enabled or explicitly enabled** ids
only (`lfx/base/models/unified_models/model_catalog.py`), so on an instance where nothing
else enabled it, `OpenAI Compatible-gpt-4o-mini-option` **never renders** — measured 2/2
as a `TimeoutError` on the click, well before the binding assertion is reached.

It passed in CI only because the daily's shared instance carries model-status written by
other specs (`model-provider-model-toggle.spec.ts` and the provider-setup helper enable a
provider's models account-wide, and `model_status_contains` matches a **bare** legacy
entry for *any* provider). That is ambient state the spec never declared, and depending on
it is how a spec passes on one instance and dies on a clean one. Test 5 therefore enables
`TEST_MODEL` for this provider itself, through
`POST /api/v1/models/enabled_models` — the endpoint the **Azure AI Foundry sibling in this
same folder already uses** — and disables it again in cleanup.

### The persisted binding cannot predict the executed model — do not strengthen it (#1372, LE-2156)

Test 5's pre-send re-read of `GET /api/v1/flows/{id}` is **attribution, never repair**, and
the reason is structural rather than a matter of tuning. `POST /api/v2/workflows` — the run
the Playground issues — carries a `data` field that `WorkflowRunRequest` declares as an
*"Optional live-canvas override of the flow's nodes/edges; **takes priority over the saved
flow data**"*, and a capture of a **healthy** run confirms the frontend always sends it.
The backend therefore builds the canvas, not the row. `GET /api/v1/flows/{id}` is not a
weak observable here; it is the **wrong object**, and no amount of polling it harder can
close the gap.

Measured consequence: on 2 of 12 full-file runs the run answered
`404 … This is not a chat model` while the persisted read at the last influenceable
instant — after the Playground modal opened, immediately before `button-send` — returned
`{models: ["gpt-4o-mini"], providers: ["OpenAI Compatible"]}` and the widget agreed. A
re-selection repair loop was written, measured against exactly that, and **removed**:
re-selecting cannot fix a state that is already correct.

The mechanism is upstream (`LE-2156`, full report in
`docs/upstream-bugs/UPSTREAM-BUG-model-input-cross-provider-default-fill.md`): an **empty**
`ModelInput` value is filled with `options[0]`, and `options` is a **flat list across every
enabled provider**, so the fill need not even be this provider — an OpenAI-Compatible node
came back `claude-opus-5` / **Anthropic**. It fails loudly here only because this
provider's endpoint-derived default set starts with completions-only ids; on 6 of the 8
providers measured, `options[0]` is a working chat model and the same substitution runs
**green** against a model nobody selected.

So the only observable that predicts the executed model is the `data` payload of the run
request. Two things follow for anyone editing this spec: the pre-send read stays as an
attribution line and must not grow into a gate that pretends to prevent this, and a future
guard that genuinely covers it belongs on the run request, not on the flow row.

---

## Tags *(required)*

Declaration order in the file, which is also execution order (`mode: "serial"`):

| Test | Tags |
|---|---|
| 1 — provider offered with a live-only, empty catalog | `@stable`, `@model-provider`, `@settings`, `@api` |
| 2 — unreachable base URL rejected, nothing persisted | `@stable`, `@model-provider`, `@settings` |
| 3 — bogus key on a real endpoint rejected with the auth message | `@stable`, `@model-provider`, `@settings` |
| 4 — live discovery mirrors the endpoint's `/v1/models` | `@stable`, `@model-provider`, `@settings`, `@api` |
| 5 — a discovered model runs in a flow | `@stable`, `@model-provider`, `@components`, `@playground` |
| 6 — Settings Save persists BOTH variables | `@stable`, `@model-provider`, `@settings`, `@regression` |

Cross-cutting: `@api` / `@regression` / `@components` as above. Functional:
`@model-provider` on all six, plus `@settings` for the Settings-page tests and
`@playground` for the execution test.

**Test 4 carried no `@stable` and a `test.fixme` between 2026-08-07 and #1364's
verdict** — the 2026-08-07 triage quarantined it against a suspected upstream removal
of embedding discovery. Both are lifted: the removal is refuted, the red is the
endpoint stalling past discovery's 5 s timeout (see the finding above), and the read is
polled on its terminal shape. **All six tests carry `@stable`.**

**Test 6 carried no `@stable` while it was quarantined** (`test.fixme`) against a
confirmed live product defect: it must not enter `daily-stable.yml`, which opens a
`daily-failure` issue per red, nor redden `pr-validation.yml` — the import graph selects
this file for any PR touching the model-provider area. With LE-2124 fixed on
1.12.0.dev19 and the test green 3/3, both come off.

**Test 5's `@stable` was auto-removed by `daily-stable.yml` (commit `cb3082d`)** when it
failed the 2026-08-05 and 2026-08-06 dailies on the credential assertion. #1334 restores
it: the assertion moved onto the axis the runtime actually uses, and the ambient
model-status dependency that made the selection work on one instance and not another is
now declared by the test itself.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on `1.12.0.dev15`, re-validated
  on `1.12.0.dev18` for #1334).
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
- **No model-status precondition.** Test 5 does not require `OPENAI_COMPATIBLE_TEST_MODEL`
  to be enabled for the provider beforehand — it enables it itself and disables it again
  (see *Why test 5 enables its model explicitly*). A model that is `default: false` is
  invisible to the node's dropdown otherwise.
- Test 5 **skips with the reason** when the endpoint's account has no credits: the
  probe cannot see that (`GET /v1/models` answers `200` for a drained key), so it is read
  off the run's own error message instead.
- Tests 4-5 **skip with the reason** when the endpoint is unreachable while their setup
  stores the key (retried once first) — an environment abort must not read as a spec
  failure, and this is the same explicit-skip discipline `probeEndpoint` applies.
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
   `Authentication failed for the OpenAI-compatible endpoint`. A bearer can only be
   judged if the endpoint was **reached**: when the validator answers its transport
   message instead (`timed out` / `DNS resolution failed` / `Could not connect`), the
   test **skips with the reason** rather than asserting the auth text, which would be
   measuring the network. `valid === false` is asserted either way — a bogus key must
   never validate, reachable or not.
3. Nothing is persisted (same assertion as test 2). This proves the key is
   actually **used** for the probe — the message is unreachable unless the
   endpoint saw the bearer and answered 401/403.

**Test 4 — live discovery mirrors the endpoint's `/v1/models`** *(setup via API, sequentially)*
1. Create the two variables through `POST /api/v1/variables/`, **awaiting the
   base URL write before the key write** (the ordering the UI gets wrong). The backend
   validates the key by *calling* the endpoint, so a stalled network answers `400
   Connection to the OpenAI-compatible endpoint … timed out`; that shape is retried once
   and then **skips with the reason**, because setup that fails on transport is an
   environment abort, not a spec verdict. A `400 Invalid OpenAI-compatible base URL` —
   the LE-2124 class — still fails loudly: the two are never conflated.
2. The test fetches the endpoint's own `GET <base>/v1/models` and computes the id
   set.
3. `GET /api/v1/models?provider=OpenAI Compatible`, polled on its **terminal shape**:
   the `llm`-typed `model_name` set **equals** that id set, `num_models === 2 ×
   ids.length` and `is_configured` is `true`, all in one comparison. Nothing static can
   satisfy the id set — the ids exist only at the operator's endpoint; and `/v1/models`
   does not distinguish chat from embedding, so every served model is registered once
   per type (documented in `lfx_openai_compatible/discovery.py`).
4. **Why the terminal shape and not `num_models > 0`:** the catalog is recomputed on
   every request, so a single read can be missing either half — 8 of 30 reads a full
   minute after configuring, at the rate the endpoint stalls past discovery's 5 s
   timeout (the #1364 finding above). A partial read must count as "the endpoint
   stalled on this request", never as a wrong catalog.
5. UI: the panel renders `llm-toggle-<id>` for the first five ids alphabetically
   — the default-enabled set (`default: i < MIN_DEFAULT_MODELS`). The panel makes its
   **own** catalog request and never refetches, so it is **reopened** up to 3 times
   (each logged) rather than waited on: a page that loaded on an embeddings-only read
   renders no `llm-toggle-*` at all, and a bare `toBeVisible` would burn its timeout
   against a provider step 3 just proved complete. The assertion after the loop is
   unconditional.

**Test 5 — a discovered model runs in a flow** *(setup via API, sequentially)*
0. Wait for live discovery to list `OPENAI_COMPATIBLE_TEST_MODEL`
   (`GET /api/v1/models?provider=OpenAI Compatible`), then enable it for this provider
   through `POST /api/v1/models/enabled_models`
   (`[{provider, model_id, enabled: true, model_type: "llm"}]`, the Foundry sibling's
   call), then wait for `GET /api/v1/models/enabled_models` to report it enabled.
   Without the enable, the id is offered only when it happens to be `default: true` or
   was enabled by unrelated ambient state, and the option never renders; without the two
   waits, the write can land before discovery has run — a `200` that changes nothing,
   measured once in 8 validation runs as the option still absent after 20 s.
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
   `value-dropdown-model_model` then reads the model id. The option list comes from the
   component's **cached** build config, which can predate step 0's enable even though
   the catalog and the enabled-models map already agree — measured once in 7 runs as a
   20 s click timeout on an id the API reported discovered *and* enabled. The dropdown
   ships its own repair (**Refresh List**), used up to 3 times and logged; after that
   the click's own timeout reds the test.
4. Gate on the **persisted** binding, not the widget: poll
   `GET /api/v1/flows/{id}` until the Language Model node's `template.model.value`
   carries exactly `[{name: <model>, provider: "OpenAI Compatible"}]`. The run builds
   the persisted flow, and the two disagreed on every failing run above — the widget is
   not the contract. `template.api_key.value` is **read and printed** in the poll's
   diagnostic and asserted in **neither** direction: since #14311 it is `""` on every
   build, and the provider on the selected entry is what the runtime derives the
   credential from (#1334).
5. **Re-read the binding at the last moment the run can still be influenced** — right
   after the Playground opens, before sending — so a failure in step 6 is attributed.
   This is evidence, not a repair: measured **twice in 12 runs** on 1.12.0.dev19, the
   run died on `404 … This is not a chat model … Did you mean to use v1/completions?`,
   the signature of an **empty** model field falling back to the provider's first
   default-enabled id (`babbage-002`), *while this read still returned* `gpt-4o-mini` /
   `OpenAI Compatible`. The substitution is therefore **not** a persistence reversion
   and re-selecting cannot fix it — the `POST /api/v2/workflows` run did not build what
   the database holds. Tracked separately; see *What this test does not cover*.
6. **A drained account skips, it does not red.** After the run completes, read the
   provider's own message off the page: `You have no credits remaining` /
   `exceeded your current quota` / `insufficient_quota` / `billing_not_active` skips with
   that text. This is invisible to `probeEndpoint` — `GET /v1/models` answers `200` for a
   key with no credit (measured) — and left unattributed it surfaces 90 s later as
   *"AI reply for the session not persisted yet"*, which reads like a product failure;
   that is exactly how it presented on a 2.2 min red. Deliberately narrow: a `429`
   saying `rate_limit_exceeded` still **fails**, because that one the suite should see.
7. Playground: send a sentinel (`OC-<runId>`) with an instruction to echo it
   verbatim; assert `button-stop` hides, then assert the **persisted** reply from
   `GET /api/v1/monitor/messages` for the same `session_id` contains the sentinel
   (the live bubble renders an empty placeholder mid-stream — #634). The
   provider-qualified option testid is what proves the run went through
   **OpenAI Compatible** and not through the OpenAI provider that may serve the
   same id.
8. Delete the flow by id, disable the model again, and delete both variables.

**Test 6 — Settings Save persists BOTH variables** *(the #1193 core; was `test.fixme` against LE-2124, lifted on 1.12.0.dev19 — see the finding)*
1. Fill base URL + a working key; arm waiters for `validate-provider` **and** for
   `POST|PATCH /api/v1/variables/`; click Save.
2. `validate-provider` answers `valid: true`.
3. Poll `GET /api/v1/variables/` for the **pair**
   `[OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_BASE_URL]` (the backend fact
   "this provider is configured", independent of how many requests the frontend
   chose to make — the Foundry sibling proved a single-response wait is a race).
   **This is the step the defect failed**, until 1.12.0.dev19.
4. **The red has to mean the defect, so the rejection bodies are captured.** Every
   `POST|PATCH /api/v1/variables/` answering ≥ 400 during the Save is recorded with its
   body. Two different causes leave the *identical* end state — only the base URL
   stored: LE-2124's concurrency race answers `400 Invalid OpenAI-compatible base URL`,
   while an endpoint unreachable at that moment answers `400 … timed out` /
   `DNS resolution failed`, because the backend validates the key by **calling** the
   endpoint. The transport case **skips with the body**; anything else **fails**, and
   the failure message carries every rejection observed.
5. The panel then reflects the configured state: the provider item shows a
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
- one of those discovered ids — enabled for the provider by the test itself, then
  selected through the `OpenAI Compatible-<id>-option` entry — is **persisted** on the
  Language Model node as `[{name: <id>, provider: "OpenAI Compatible"}]` on
  `GET /api/v1/flows/{id}`, and returns the run's sentinel in the Playground. The
  provider on that entry, not a stored credential name, is what proves the run resolves
  **this** provider's key: dropping only `OPENAI_COMPATIBLE_API_KEY` while a valid
  `OPENAI_API_KEY` stays configured turns the same run into
  `401 - Incorrect API key provided: EMPTY` (#1334).

- saving both variables from the Settings UI leaves **both** stored, the provider item
  shows a `/\d+ models/` suffix and `provider-disconnect-button` renders. This was
  quarantined against LE-2124 and is asserted again from 1.12.0.dev19, with the
  assertions unchanged from the day they were written.

Measured on 1.12.0.dev15: 5 passed, 1 quarantined per run. On 1.12.0.dev19 after #1334:
**6 passed**, none quarantined.

On **1.12.0.dev23** after #1364, 8 runs at `--workers=1 --retries=0`: **zero failures**.
Test 4 — the one this issue quarantined — is 7 passed / 1 skipped, against 5 passed /
1 **failed** over the 6 runs taken before the panel budget was resized. The skips are
all the endpoint stalling (`OpenAI-compatible endpoint not usable`, `Connection to …
timed out`), each with its reason printed, and they are the file's pre-existing
environment-abort design rather than anything this issue changed: tests 3 and 6 take
5/8 and 5/8 here on a host measured at 4 stalled calls in 20. On a lane whose egress is
healthy they run.

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
- **The persisted binding is asserted on the PROVIDER, not on a stored credential
  name** (#1334): the widget and the database disagreed on every failing run while this
  spec was authored, and 1 selection in 5 still lands on the editor's mount default
  (`claude-opus-5` / Anthropic) instead of the pick. The provider axis catches that state
  exactly as the credential axis used to — and, unlike it, still exists after #14311.
- **The model is enabled by the test, not assumed enabled**: a `default: false` id is
  absent from the node's dropdown, so relying on ambient model-status is how this spec
  passed in CI and failed 2/2 on a clean instance.
- **Skip guards are explicit**: `test.skip(!probe.usable, reason)` and
  `test.skip(alreadyConfigured, reason)` — never a silent pass. (#570/#1012.)

---

## Cleanup *(required by the repo's flow-cleanup rule)*

- `afterEach` deletes every `OPENAI_COMPATIBLE_*` variable this file created
  (`GET /api/v1/variables/` → `DELETE /api/v1/variables/{id}`), so a failed run
  cannot leave the provider half-configured for the next spec.
- `afterEach` also **disables again** any model test 5 enabled for this provider
  (`POST /api/v1/models/enabled_models` with `enabled: false`). Model status is
  account-wide and `model_status_contains` matches a bare entry for *any* provider, so a
  leftover enable is exactly the ambient state #1334 was about.
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
- **Why a run can execute a model the persisted flow does not name.** Measured twice in
  12 runs on 1.12.0.dev19 (see step 5): the database and the widget both read
  `gpt-4o-mini` / `OpenAI Compatible` at send time, and the run still failed with
  `404 … This is not a chat model`, which only the provider's first default-enabled id
  produces. The spec attributes the state but does not diagnose it — it is a separate
  question from #1334's binding axis, filed on its own.

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

- ~~When upstream fixes the concurrent variable-write race: lift test 6's quarantine.~~
  **Done on 1.12.0.dev19** (#1334's validation). If test 6 reds again, the race is back:
  compare sequential vs concurrent `POST /api/v1/variables/` against the API before
  suspecting the test.
- When the flow-editor autosave stops reverting a model selection made right
  after mount: test 5's persisted-binding gate documents the current behaviour and
  is the place to re-measure it.
- When upstream restores any automatic binding of a provider field's `value` (the
  inverse of #14311): test 5 asserts `api_key` in neither direction on purpose, so it
  would stay green — the place to re-measure is
  `tests/helpers/flows/agent-credential-settle.ts`, which made the same call (#1274).
- When `MIN_DEFAULT_MODELS` or the live-discovery default-enable rule changes: test 5's
  explicit `enabled_models` write becomes redundant or, worse, insufficient.
- When the bundle changes its variable keys, its `/v1/models` URL derivation, or
  the `MIN_DEFAULT_MODELS` default-enable rule
  (`lfx_openai_compatible/extension.json`, `discovery.py`).
- When `get_live_only_providers()` gains a static catalog for this provider —
  test 1's empty-catalog assertion is the tripwire.
