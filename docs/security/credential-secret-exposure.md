# Credential Secret Exposure

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that the **value of a Credential-type global variable, once resolved into a component at run time, never reaches an observable surface** — the trace detail, the exported flow JSON, or the API response of the run. This is the boundary reported upstream in `langflow-ai/langflow#7313` ("Security issue with TracingService exposing secrets"): `_cleanup_inputs()` obfuscated only inputs whose key contained `api_key`, so any `SecretStrInput` with a different field name was sent to the tracing provider in plaintext.

The fix is **type-driven, not name-driven** — `Component._get_trace_value()` returns `"**********"` for any input declaring `password=True` before the value reaches `get_trace_as_inputs()`. That distinction is what this spec pins, and it is why the flow carries **two** credential-consuming nodes with deliberately different field names:

- **`secret_token`** — a name that also matches the transaction sanitizer's independent, name-based pattern (`SENSITIVE_KEYS_PATTERN` in `transactions/model.py`), so it is masked on two paths at once;
- **`gateway_pin`** — a name that matches **no** sensitive-key pattern anywhere. It is masked in the trace **only** because the input declares `password=True`. This is the exact case `#7313` reported, and the one that regresses silently if the type check is ever replaced by a name check again.

Asserting only "the secret is absent" would pass just as well on a run where the credential never resolved, on an empty span, or on a flow that never executed. Every test therefore pairs the absence with a **control that proves the secret really did reach the component**: each node returns `resolved_len=<n>`, where `n` is the length of its sentinel. The secret's *length* is the strongest observable that is not the secret itself — the run cannot produce it without having resolved the credential, and it discloses nothing.

If these tests fail, a Credential global variable — the mechanism Langflow offers precisely so that a secret is *not* stored in the flow — is readable by anyone who can open a trace, export the flow, or call the run endpoint.

---

## Tags *(required)*

`@stable` `@api` `@regression`

No **functional** tag applies: the tag table has no security area, and the sibling `security/tweaks-injection.spec.ts` also carries only cross-cutting tags. `@regression` is what issue #1393 asks for; `@api` marks the layer. `@observability` is deliberately **not** applied even though Test 1 reads `/api/v1/monitor/traces/{id}`: the tag drives lane selection and area ownership, and this file's subject is the secret boundary, not the trace payload's shape (which `core-functionality/observability-monitoring/traces-detail*.spec.ts` already owns).

`@stable` ships with the first delivery, mirroring the sibling security spec: the file is pure API (no browser, no LLM, no provider key, ~10 s for all three tests), so it costs the daily almost nothing and cannot fail for a provider-outage reason. It is **not** `@destructive` — it creates and deletes only its own flow, its own two global variables and its own API key.

**Test 2 currently runs without `@stable`** — quarantined via `test.fixme` against the upstream export regression tracked by issue #1546 (see the note on Test 2 below). Tests 1 and 3 keep `@stable`.

The three `QA-CHECKLIST.md` §17.3 bullets therefore become `[x]`.

---

## Step by step *(required)*

The spec runs **3 tests** in a serial describe via Playwright's `request` fixture. No browser, no LLM, no provider key. One flow, two global variables and one API key are created in `beforeAll` and deleted in `afterAll`; the flow is run **once** there and all three tests read that same run.

**Setup (`beforeAll`)**

1. `getAuthToken(request)` → Bearer for the variables/flows/monitor endpoints.
2. `POST /api/v1/api_key/` → temporary key (asserts `200`); `POST /api/v1/run/{id}` authenticates with `x-api-key`, not Bearer.
3. `POST /api/v1/variables/` **twice**, each `{ type: "Credential", value: <unique sentinel> }` — one per node. The sentinels are unique per run and of **different lengths**, so a `resolved_len` assertion cannot be satisfied by the wrong credential.
4. `createCredentialConsumerFlowViaApi(request, headers, { fields })` (new helper): reads the **live** catalog (`GET /api/v1/all`), takes the `CustomComponent` template, and builds one node per requested field name. Each node's `code` declares `SecretStrInput(name=<field>)` and returns `Message(text=f"resolved_len={len(value)}")`; each node's template carries that field with `password: true`, `load_from_db: true` and `value: <variable name>` — the exact shape the UI writes when a Credential variable is bound to a secret field. The two nodes are independent roots of the same graph, so a single run executes both (measured on 1.12.0.dev23: both vertices appear in the `debug` response).
   Building the node from the running instance rather than a committed fixture is what makes an upstream change to the `SecretStrInput` contract surface as a failure instead of a stale fixture quietly testing nothing.
5. `POST /api/v1/run/{flowId}` with `x-api-key` and `{ input_type: "text", output_type: "debug" }` — `debug` returns every vertex, not just a terminal one. The response body is kept for Test 3.

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

**Test 2 — the export carries the binding, never the secret** *(`@api @regression`)*

> **Quarantined (`test.fixme`, `@stable` removed) — upstream regression, tracked by issue #1546.**
> Since upstream PR `langflow-ai/langflow#14639` (merged 2026-08-19 into `release-1.12.0`),
> `POST /api/v1/flows/download/` nulls **every** `password=True` field — including a
> `load_from_db` binding, whose `value` is the global-variable *name*, not the secret.
> The exported flow comes back `{"load_from_db": true, "value": null}` and the variable
> name is absent from the whole payload, so step 2 below fails deterministically
> (5/5 on `1.12.0.dev33`) while `GET /api/v1/flows/{id}` keeps the binding.
> This spec's expectation is **unchanged**: the export contract this doc pins is the
> round-trippable one (binding preserved), and the scrubber itself has a
> binding-preserving mode (`variable_references`, used by deployment packaging) that
> the export call site does not use. Full analysis and reproduction:
> `docs/upstream-bugs/UPSTREAM-BUG-flow-export-drops-credential-binding.md`.
> Lifting the quarantine (remove `test.fixme`, restore `@stable`) is a deliverable of
> #1546, due when the upstream fix lands in `langflowai/langflow-nightly:latest`.

1. `POST /api/v1/flows/download/` with `[flowId]` — the endpoint behind the UI's Export/Download action — and assert `200`.
2. Assert the exported payload contains **both variable names**. The export must keep the *binding* — a flow exported without it would import as a broken flow, so this is the control that step 3 is not passing because the field vanished. The check is textual here because a multi-id export answers with an archive rather than a flow object, and the variable name is the binding's observable in both shapes.
3. Assert neither sentinel appears in the raw exported payload.
4. `GET /api/v1/flows/{flowId}` — the read path the editor and every API client use, and the one an operator is most likely to pipe into a file. Assert the same absence, and assert the binding **structurally** on the stored flow: for each node, `template.<field>.value` is the variable name, `load_from_db` is `true` and `password` is `true`.

**Test 3 — the run response resolves the credential without echoing it** *(`@api @regression`)*

1. Assert the run captured in `beforeAll` answered `200`.
2. For each node, assert its vertex output text equals `resolved_len=<sentinel.length>` — the credential was fetched from the variable service and handed to the component, and the two lengths differ, so neither can stand in for the other.
3. Assert neither sentinel appears in the raw run response body.
4. Assert the same on `GET /api/v1/monitor/builds?flow_id={flowId}` — the vertex-build record the node inspector renders; it carries the component's params and is the surface a leak would surface on next.

---

## Validation criterion *(required)*

- **Test 1:** the trace detail contains one span per credential-consuming node; `spans[].inputs.secret_token` and `spans[].inputs.gateway_pin` are both exactly `**********`; neither sentinel string occurs in the trace-detail body nor in the transactions body.
- **Test 2:** `POST /api/v1/flows/download/` answers `200`; the payload carries both variable names with `"load_from_db": true`; neither sentinel occurs in it, nor in `GET /api/v1/flows/{id}`.
- **Test 3:** the run answered `200`; each vertex output reads `resolved_len=<n>` with `n` equal to that node's sentinel length; neither sentinel occurs in the run body nor in the vertex-build records.
- Across all three: the pairing is what carries the verdict — **the secret provably reached the component (`resolved_len`) and provably reached none of the three surfaces.**
- Teardown leaves nothing behind: the flow, both variables and the API key are deleted, and `GET /api/v1/flows/` returns the same count before and after the file runs.

---

## What this test does not cover *(optional)*

- **The external tracing providers** (`#7313`'s literal reproduction was Phoenix/Arize over OpenTelemetry). Asserting there would need a collector in CI. The spec asserts on Langflow's **own** trace store, which is fed by the same `Component.get_trace_as_inputs()` → `_get_trace_value()` path — the code the upstream report is about — so a regression in that masking fails here too.
- **The Playground / Traces UI rendering.** The check is on the payload the panel renders from; whether the React component then prints it is a separate surface.
- **Generic (non-Credential) global variables.** They are not secrets by declaration, and Langflow deliberately shows their values.
- **A secret typed directly into a component field** (no global variable). That path never involves the variable service, and the checklist bullets are scoped to Credential variables.
- **The `/logs` and `/logs-stream` endpoints and container stdout.** A leak into server logs is a real class of defect, but asserting on it would couple the spec to the deployment shape (`docker logs`), and it is not one of the §17.3 bullets.
- **Whether the *frontend* ever requests the variable's plaintext.** `GET /api/v1/variables/` is covered by `ui-ux/global-variables-crud.spec.ts`, which owns the secrecy-in-the-list guarantee.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Superuser credentials (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) for `getAuthToken`.
- The instance allows API-key creation via `POST /api/v1/api_key/`.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`. With it `false`, `POST /api/v1/custom_component` and custom code execution are refused and the flow cannot run at all — the failure is loud (the `beforeAll` run assertion), never a vacuous pass. Every CI lane and both start scripts set it (#668/#746).
- **Tracing enabled (`LANGFLOW_DEACTIVATE_TRACING=false`) — Test 1 only.** `daily-stable.yml`, `weekly-stable.yml` and `manual.yml` already set it; `pr-validation.yml` and `adaptive-impacted.yml` enable it only when the selected specs include `observability-monitoring`, so this spec's path must be added to those two conditions or Test 1 has no trace to read on the PR lane. **`scripts/start-langflow-docker.sh` sets it to `true` by decision** (local traces would pollute the token recorder — see the comment in the script), so a local run of Test 1 needs a second container:
  ```bash
  docker run -d --name langflow-trace-probe -p 7861:7860 \
    -e LANGFLOW_AUTO_LOGIN=true -e LANGFLOW_SUPERUSER=langflow \
    -e LANGFLOW_SUPERUSER_PASSWORD=langflow123 \
    -e LANGFLOW_DEACTIVATE_TRACING=false -e LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true \
    -e LANGFLOW_WORKERS=1 langflowai/langflow-nightly:latest
  ```
  Tests 2 and 3 are independent of the flag.

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
- `src/backend/base/langflow/api/v1/flows.py` — `GET /api/v1/flows/{id}` and `POST /api/v1/flows/download/`: Test 2's two export surfaces.
- `src/backend/base/langflow/api/v1/variable.py` — `POST /api/v1/variables/` with `type: "Credential"`, and the variable service that resolves a `load_from_db` field at build time.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run/{flow_id}`: the `SimplifiedAPIRequest` schema, `output_type: "debug"`, and the `RunResponse` shape Test 3 reads.
- Upstream reference: `langflow-ai/langflow#7313` — the defect that defines the boundary.
