# Credential Secret Exposure

**Last validated:** Langflow 1.13.x (`1.13.0.dev21`)

---

## What this test validates *(required)*

Validates that the **value of a Credential-type global variable, once resolved into a component at run time, never reaches an observable surface** — the trace detail, the exported flow JSON, or the API response of the run. This is the boundary reported upstream in `langflow-ai/langflow#7313` ("Security issue with TracingService exposing secrets"): `_cleanup_inputs()` obfuscated only inputs whose key contained `api_key`, so any `SecretStrInput` with a different field name was sent to the tracing provider in plaintext.

The fix is **type-driven, not name-driven** — `Component._get_trace_value()` returns `"**********"` for any input declaring `password=True` before the value reaches `get_trace_as_inputs()`. That distinction is what this spec pins, and it is why the flow carries **two** credential-consuming nodes with deliberately different field names:

- **`secret_token`** — a name that also matches the transaction sanitizer's independent, name-based pattern (`SENSITIVE_KEYS_PATTERN` in `transactions/model.py`), so it is masked on two paths at once;
- **`gateway_pin`** — a name that matches **no** sensitive-key pattern anywhere. It is masked in the trace **only** because the input declares `password=True`. This is the exact case `#7313` reported, and the one that regresses silently if the type check is ever replaced by a name check again.

Asserting only "the secret is absent" would pass just as well on a run where the credential never resolved, on an empty span, or on a flow that never executed. Every test therefore pairs the absence with a **control that proves the secret really did reach the component**: each node returns `resolved_len=<n>`, where `n` is the length of its sentinel. The secret's *length* is the strongest observable that is not the secret itself — the run cannot produce it without having resolved the credential, and it discloses nothing.

If these tests fail, a Credential global variable — the mechanism Langflow offers precisely so that a secret is *not* stored in the flow — is readable by anyone who can open a trace, export the flow, or call the run endpoint.

The export carries **two** contracts, and they are pinned by two separate tests because for a month only one of them held:

- **The secret never leaves** (Test 3). This is the contract upstream PR `langflow-ai/langflow#14639` (LE-2240, *incomplete secret sanitization in flow and project export*) hardened, and it holds on the nightly.
- **The binding survives** (Test 4). A bound field stores the global variable's **name**, not the secret, and that name is what an import needs to re-resolve the credential — an export that drops it imports as a flow whose secret fields are silently unbound. Langflow documents this contract (*Import and export flows* → *Save with my API keys*): non-API-key variables are exported regardless of that setting, and an importing instance needs global variables **with the same names**. The same PR broke it as collateral: the export call site used the scrubber's default mode, which nulls `load_from_db` bindings together with literal secrets (issue #1546, `docs/upstream-bugs/UPSTREAM-BUG-flow-export-drops-credential-binding.md`). Test 4 was **declared failing** (`test.fail()`) from #1546 until the upstream fix landed — `langflow-ai/langflow#15143` (*keep global-variable bindings in flow and project exports*), which reached the 1.13 line with the `release-1.13.0` merge of 2026-09-22 and first shipped in `1.13.0.dev21`. The declaration raised the alarm it was written for (#2008) and was lifted — see its note below.

What the double check of 2026-09-16 settled, so the claim is not read wider than it is. **The field names matter:** on this endpoint an API-key-shaped field (`api_key`, `openai_api_key` …) already lost its binding before #14639 — the legacy `remove_api_keys` nulled it with no `load_from_db` exemption — while `secret_token` and `gateway_pin` kept theirs until that PR (measured on `1.11.4` against `1.13.0.dev14`, for one id and for a ZIP alike). Both fields here are not API-key-shaped, so the spec measures the regression itself. **The reach is the backend export:** the documented single-flow API export, the Projects page's *Download selected* with two or more flows, and the project *Download*. The UI's single-flow *Download selected* and *Share → Export* build the file in the browser and never call this endpoint.

Until #1546 split them, both contracts lived in one test, with the binding assertion first. While the binding was broken the secret assertion never executed, and quarantining that test (`test.fixme`, 2026-08-21) took the export's secret boundary out of every lane along with it — the one contract that still held was the one nothing checked.

---

## Tags *(required)*

`@stable` `@api` `@regression`

No **functional** tag applies: the tag table has no security area, and the sibling `security/tweaks-injection.spec.ts` also carries only cross-cutting tags. `@regression` is what issue #1393 asks for; `@api` marks the layer. `@observability` is deliberately **not** applied even though Test 1 reads `/api/v1/monitor/traces/{id}`: the tag drives lane selection and area ownership, and this file's subject is the secret boundary, not the trace payload's shape (which `core-functionality/observability-monitoring/traces-detail*.spec.ts` already owns).

`@stable` ships with the first delivery, mirroring the sibling security spec: the file is pure API (no browser, no LLM, no provider key, ~10 s for all four tests), so it costs the daily almost nothing and cannot fail for a provider-outage reason. It is **not** `@destructive` — it creates and deletes only its own flow, its own two global variables and its own API key.

**All four tests carry `@stable`.** Test 4 was **declared failing** (`test.fail()`) against the upstream defect tracked by #1546 / LE-2649, and it sat in the daily **because the daily was what detected the fix**: on `1.13.0.dev21` its body passed 3/3 on both lanes, Playwright reported it *expected to fail but passed*, and the run went red naming it (#2008). The declaration was then lifted exactly as prescribed — `test.fail()` and its comment removed, `@stable` restored (the daily's auto-removal had stripped it, as predicted: a declared test that passes is `status: "unexpected"`), the §17.3 binding bullet flipped to `[x]`, LE-2649's `REGRESSIONS.md` row marked `Fixed`, #1546 closed. Same shape as `api/flows/workflows-v2-job-lifecycle.spec.ts`'s Test 4 (#1797).

Test 3 remains the attribution control: it issues the same `POST /api/v1/flows/download/` and `GET /api/v1/flows/{id}` and stays deliberately silent about the export's binding, so a broken export or a dead instance reddens Test 3 whatever Test 4 asserts. Test 4 still runs **last** in the serial describe.

`QA-CHECKLIST.md` §17.3: the trace, export-secret, export-binding and run bullets are all `[x]`.

---

## Step by step *(required)*

The spec runs **4 tests** in a serial describe via Playwright's `request` fixture. No browser, no LLM, no provider key. One flow, two global variables and one API key are created in `beforeAll` and deleted in `afterAll`; the flow is run **once** there, and Tests 1 and 2 read that same run (its trace and its response). Tests 3 and 4 read the flow itself, through the export and the flow read.

**Setup (`beforeAll`)**

1. `getAuthToken(request)` → Bearer for the variables/flows/monitor endpoints.
2. `POST /api/v1/api_key/` → temporary key (asserts `200`); `POST /api/v1/run/{id}` authenticates with `x-api-key`, not Bearer.
3. `POST /api/v1/variables/` **twice**, each `{ type: "Credential", value: <unique sentinel> }` — one per node. The sentinels are unique per run and of **different lengths**, so a `resolved_len` assertion cannot be satisfied by the wrong credential.
4. `createCredentialConsumerFlowViaApi(request, headers, { fields })` (new helper): reads the **live** catalog (`GET /api/v1/all`), takes the `CustomComponent` template, and builds one node per requested field name. Each node's `code` declares `SecretStrInput(name=<field>)` and returns `Message(text=f"resolved_len={len(value)}")`; each node's template carries that field with `password: true`, `load_from_db: true` and `value: <variable name>` — the exact shape the UI writes when a Credential variable is bound to a secret field. The two nodes are independent roots of the same graph, so a single run executes both (measured on 1.12.0.dev23: both vertices appear in the `debug` response).
   Building the node from the running instance rather than a committed fixture is what makes an upstream change to the `SecretStrInput` contract surface as a failure instead of a stale fixture quietly testing nothing.
5. `POST /api/v1/run/{flowId}` with `x-api-key` and `{ input_type: "text", output_type: "debug" }` — `debug` returns every vertex, not just a terminal one. The response body is kept for Test 2.

**Teardown (`afterAll`)**

1. `DELETE /api/v1/flows/{flowId}` — id-scoped, with the `afterAll`'s own `request`.
2. `DELETE /api/v1/variables/{id}` for both variables.
3. `DELETE /api/v1/api_key/{apiKeyId}`.
   Each step is wrapped so a failing one cannot skip the rest; no orphan flow, variable or key survives the file.

---

**Test 1 — the trace detail masks both credentials, whatever the field is called** *(`@api @regression`)*

1. Poll `GET /api/v1/monitor/traces?flow_id={flowId}` (30 s) until `traces.length > 0`. Trace writes are asynchronous — the run answers before the trace lands. If the list stays empty, fail **naming `LANGFLOW_DEACTIVATE_TRACING`** as the cause: an instance with tracing off writes no traces at all, and an unattributed "expected 0 to be greater than 0" would read as a product defect (see Preconditions).
2. `GET /api/v1/monitor/traces/{trace.id}` → flatten `spans[]` (children included).
3. Assert both credential-consuming spans are present and that each carries an `inputs` object **containing its field key** — `secret_token` and `gateway_pin` respectively. This is what makes step 4 evidence: the key is there, so the value was traced, and "the sentinel is absent" is not the absence of the whole span.
4. Assert each of those values is exactly `**********` — `Component._get_trace_value()`'s mask for a `password=True` input.
5. Assert neither sentinel appears anywhere in the raw response body of the trace detail.
6. Assert the same on `GET /api/v1/monitor/transactions?flow_id={flowId}` — the per-vertex record the same Traces panel renders alongside the spans. Neither sentinel appears there either. The masking on that path is name-based and therefore *different* (`secret_token` reads `***R...D***`; `gateway_pin` shows the unresolved variable **name**), so the assertion is on the sentinel's absence, not on a mask shape that would drift.

**Test 2 — the run response resolves the credential without echoing it** *(`@api @regression`)*

1. Assert the run captured in `beforeAll` answered `200`.
2. For each node, assert its vertex output text equals `resolved_len=<sentinel.length>` — the credential was fetched from the variable service and handed to the component, and the two lengths differ, so neither can stand in for the other.
3. Assert neither sentinel appears in the raw run response body.
4. Assert the same on `GET /api/v1/monitor/builds?flow_id={flowId}` — the vertex-build record the node inspector renders; it carries the component's params and is the surface a leak would surface on next.

**Test 3 — the exported flow never carries the secret value** *(`@api @regression`)*

Not declared failing, and deliberately silent about the binding's value: this test must stay green whichever way #1546 goes, because it is both the export's secret boundary and the attribution control for Test 4.

1. `POST /api/v1/flows/download/` with `[flowId]` — the documented API export for one flow, and the endpoint the UI's *Download selected* uses for two or more flows — and assert `200`. A single id answers the exported flow **object** (`application/json`); only a multi-id export answers a ZIP (`_build_flows_download_response`), so the body is parsed as a flow. The scrub is the same either way (measured on `1.11.4` and `1.13.0.dev14`).
2. For each credential node, assert it is present in the export's `data.nodes` and that its template carries the field with `password: true`. This is what makes step 3 evidence: the field was exported, so "the sentinel is absent" is not the absence of the field. Nothing is asserted about the field's `value` — that is Test 4's contract.
3. Assert neither sentinel appears anywhere in the raw export body.
4. `GET /api/v1/flows/{flowId}` — the read path the editor and every API client use, and the one an operator is most likely to pipe into a file — answers `200`. Assert the binding **structurally** on the stored flow: for each node, `template.<field>.value` is the variable name, `load_from_db` is `true` and `password` is `true`. This proves the flow the export was built from really is bound, so the export had a credential to leak.
5. Assert neither sentinel appears anywhere in the raw flow-read body.

**Test 4 — the exported flow carries the credential binding, never the secret** *(`@stable @api @regression`)*

> **Upstream regression LE-2649 (#1546), fixed and lifted (#2008).** From upstream PR
> `langflow-ai/langflow#14639` (merged 2026-08-19 into `release-1.12.0`) until `1.13.0.dev19`,
> `POST /api/v1/flows/download/` scrubbed with the scrubber's default mode, which nulled
> **every** `password=True` field — a `load_from_db` binding included — so the export read
> `{"load_from_db": true, "password": true, "value": null}` while `GET /api/v1/flows/{id}`
> kept the binding (5/5 on `1.12.0.dev33` and `1.13.0.dev14`). `langflow-ai/langflow#15143`
> (`0d8b0be173`, merged 2026-09-17 into `release-1.12.3`, carried into `release-1.13.0` by the
> merge of 2026-09-22) passes the owner's global-variable names to `strip_flow_secrets`, so a
> bound value that names one of them is kept and anything else is still nulled. On
> `1.13.0.dev21` this body passed 3/3 on both daily lanes under the declaration, and the
> multi-id ZIP and the project *Download* keep both bindings too (measured by hand for #2008).
> The test was declared failing for that month (`test.fail()`), so its red on the fix day was
> the alarm. Analysis: `docs/upstream-bugs/UPSTREAM-BUG-flow-export-drops-credential-binding.md`.

Runs **last** in the serial describe, after Test 3, which issues the same two requests undeclared.

1. `POST /api/v1/flows/download/` with `[flowId]` and assert `200`.
2. `GET /api/v1/flows/{flowId}` and assert `200`.
3. Assert the binding structurally on the stored flow, as in Test 3 step 4.
4. Assert the binding **structurally on the export**: for each node, the exported `template.<field>.value` is the variable name and `load_from_db` is `true` — the values an import re-resolves the credential from. **This is the step that failed while LE-2649 was live**, and its message names the field and the value found. #1546 added it. Before, the test's only binding check was the textual one in step 5, justified by *"a multi-id export answers with an archive"*. But this test exports a single id, which answers a flow object (measured), and a textual match passes on any other occurrence of the name in the body — a flow named after its variable is enough (measured) — which would read as the fix having landed.
5. For each surface (the export and the flow read), assert the payload contains **both variable names** and **neither sentinel**. The textual form stays: it is the observable a multi-id export shares.

---

## Validation criterion *(required)*

- **Test 1:** the trace detail contains one span per credential-consuming node; `spans[].inputs.secret_token` and `spans[].inputs.gateway_pin` are both exactly `**********`; neither sentinel string occurs in the trace-detail body nor in the transactions body.
- **Test 2:** the run answered `200`; each vertex output reads `resolved_len=<n>` with `n` equal to that node's sentinel length; neither sentinel occurs in the run body nor in the vertex-build records.
- **Test 3:** `POST /api/v1/flows/download/` answers `200` with a flow object whose two credential nodes each carry their field with `password: true`; neither sentinel occurs anywhere in that body, nor in `GET /api/v1/flows/{id}`, whose stored template keeps `value = <variable name>`, `load_from_db: true` and `password: true` for both fields.
- **Test 4:** the export's `template.<field>.value` equals the variable name with `load_from_db: true` and `password: true` for both fields, and both surfaces carry both names and neither sentinel. A failure at step 4 on `value: null` is LE-2649 returning.
- Across all four: the pairing is what carries the verdict — **the secret provably reached the component (`resolved_len`) and provably reached none of the surfaces**: the trace, the transactions, the run response, the vertex builds, the export and the flow read.
- Teardown leaves nothing behind: the flow, both variables and the API key are deleted, and `GET /api/v1/flows/` returns the same count before and after the file runs.

---

## What this test does not cover *(optional)*

- **The external tracing providers** (`#7313`'s literal reproduction was Phoenix/Arize over OpenTelemetry). Asserting there would need a collector in CI. The spec asserts on Langflow's **own** trace store, which is fed by the same `Component.get_trace_as_inputs()` → `_get_trace_value()` path — the code the upstream report is about — so a regression in that masking fails here too.
- **The Playground / Traces UI rendering.** The check is on the payload the panel renders from; whether the React component then prints it is a separate surface.
- **Generic (non-Credential) global variables.** They are not secrets by declaration, and Langflow deliberately shows their values.
- **A secret typed directly into a component field** (no global variable). That path never involves the variable service, and the checklist bullets are scoped to Credential variables.
- **The `/logs` and `/logs-stream` endpoints and container stdout.** A leak into server logs is a real class of defect, but asserting on it would couple the spec to the deployment shape (`docker logs`), and it is not one of the §17.3 bullets.
- **Whether the *frontend* ever requests the variable's plaintext.** `GET /api/v1/variables/` is covered by `ui-ux/global-variables-crud.spec.ts`, which owns the secrecy-in-the-list guarantee.
- **The export's sibling surfaces** — the project ZIP (`GET /api/v1/projects/download/{project_id}`) and a multi-id export (a ZIP). Both go through the scrub `langflow-ai/langflow#15143` fixed, and both keep the binding on `1.13.0.dev21` (measured by hand for #2008); they are not asserted here — this spec exports one flow, which answers a flow object.
- **The flow-version reads** (`strip_version_data`). #14639 moved them onto the same scrubber, and #15143 did **not** change them: on `1.13.0.dev21` they still call `strip_secret_field_values` in its default mode, which nulls a bound value. A version snapshot is not an export and was never part of LE-2649's reach, so this is recorded, not asserted.
- **API-key-shaped fields on the export.** They already lost their binding here before #14639 — the same defect class, but not the regression this file pins, so the spec binds fields whose names are not API-key-shaped.
- **The exports the browser builds** — *Share → Export* and the single-flow *Download selected*. Neither calls this endpoint, so neither is part of this contract here.
- **Re-import of the exported flow.** Test 4 pins the value an import needs; whether an import then re-resolves it is the flow-import specs' concern.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Superuser credentials (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) for `getAuthToken`.
- The instance allows API-key creation via `POST /api/v1/api_key/`.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`. With it `false`, `POST /api/v1/custom_component` and custom code execution are refused and the flow cannot run at all — the failure is loud (the `beforeAll` run assertion), never a vacuous pass. Every CI lane and both start scripts set it (#668/#746).
- **Tracing enabled (`LANGFLOW_DEACTIVATE_TRACING=false`) — Test 1 only.** `daily-stable.yml`, `weekly-stable.yml` and `manual.yml` set it unconditionally; `pr-validation.yml` and `adaptive-impacted.yml` enable it by substring match over the selected spec paths, and `credential-secret-exposure` is one of the matched substrings — a renamed file would lose it and run Test 1 against a tracing-off instance on those two lanes only. `nightly.yml` runs with tracing **off**. **`scripts/start-langflow-docker.sh` sets it to `true` by decision** (local traces would pollute the token recorder — see the comment in the script), so a local run of Test 1 needs a second container:
  ```bash
  docker run -d --name langflow-trace-probe -p 7861:7860 \
    -e LANGFLOW_AUTO_LOGIN=true -e LANGFLOW_SUPERUSER=langflow \
    -e LANGFLOW_SUPERUSER_PASSWORD=langflow123 \
    -e LANGFLOW_DEACTIVATE_TRACING=false -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true \
    -e LANGFLOW_WORKERS=1 langflowai/langflow-nightly:latest
  ```
  Tests 2–4 are independent of the flag — but the describe is serial, so a red Test 1 skips them; run them alone with `--grep` on a tracing-off instance.

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — Bearer via `/api/v1/auto_login`; a contract change breaks `beforeAll`.
- `tests/helpers/flows/create-credential-consumer-flow-via-api.ts` (new) — builds the two-node flow from the live catalog; owns the `SecretStrInput` code template and the `password`/`load_from_db` field shape.
- `tests/helpers/flows/delete-flow.ts` — id-scoped teardown.
- `src/lfx/src/lfx/custom/custom_component/component.py` — `_get_trace_value()` (the `"**********"` mask for `password=True`), `_mask_secret_value()`, `get_trace_as_inputs()` and `_build_with_tracing()`. This is the code path `#7313` is about and the one Test 1 pins.
- `src/lfx/src/lfx/inputs/inputs.py` — `SecretStrInput` (`password=True`), the declaration that drives the mask.
- `src/backend/base/langflow/services/database/models/transactions/model.py` — `SENSITIVE_KEYS_PATTERN`, `_mask_sensitive_value()`, `sanitize_data()`: the **independent, name-based** sanitizer behind `/api/v1/monitor/transactions`. Test 1 step 6 deliberately asserts absence rather than the mask shape, because this path masks differently per field name.
- `src/backend/base/langflow/api/v1/monitor.py` — `GET /api/v1/monitor/traces`, `/traces/{trace_id}`, `/transactions`, `/builds`: the surfaces Tests 1 and 3 read.
- `src/backend/base/langflow/services/tracing/formatting.py` — builds the span payload (`inputs`, `outputs`) the trace detail returns.
- `src/backend/base/langflow/api/v1/flows.py` — `GET /api/v1/flows/{id}` and the `POST /api/v1/flows/download/` route: the two surfaces Tests 3 and 4 read.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_build_flows_download_response`: a single id answers the flow object and several answer a ZIP; since `langflow-ai/langflow#15143` it passes the owner's variable names (`known_variable_names`) to `strip_flow_secrets`; before, it passed none, which was LE-2649. The call site Test 4 pins.
- `src/backend/base/langflow/utils/flow_secrets.py` — `strip_flow_secrets` and `strip_secret_field_values_in_place`: every `password=True` value is nulled, except a `load_from_db` value that names one of `known_variable_names` (the owner's global variables), which keeps the name. Test 3 pins the first half, Test 4 the second.
- `src/backend/base/langflow/api/utils/core.py` — `normalize_flow_for_export`, applied after the scrub; it keeps `data.nodes[].data.node.template`, the structure Tests 3 and 4 read from the export.
- `src/backend/base/langflow/api/v1/variable.py` — `POST /api/v1/variables/` with `type: "Credential"`, and the variable service that resolves a `load_from_db` field at build time.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run/{flow_id}`: the `SimplifiedAPIRequest` schema, `output_type: "debug"`, and the `RunResponse` shape Test 3 reads.
- Upstream reference: `langflow-ai/langflow#7313` — the defect that defines the boundary.
