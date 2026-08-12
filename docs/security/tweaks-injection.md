# Tweaks Injection

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that a **tweak value sent to `POST /api/v1/run/{flow_id}` cannot reach a template field as executable input** — the security boundary restored upstream after `langflow-ai/langflow#9319` ("Potential security issue in tweaks", closed as fixed on 2025-09-15) and deliberately *not* widened by the request in `#8672` (tweaks interpolated into component parameters).

`tweaks` is the documented way for an API caller to reconfigure a flow per request. Every Langflow component also carries its own Python source in the `code` template field, and several components carry executable code (or the sandbox boundary that constrains it) in *plain-text* fields — `python_code`, `function_code`, `global_imports`, `tool_code`, `filter_instruction`, `allow_dangerous_code`. Without a refusal, an authenticated run caller could rewrite what a flow *is* at run time instead of merely reconfiguring it: `#9319` demonstrated replacing `ChatInput`'s whole class body through `tweaks.<node>.code`, and the follow-up comment confirmed the same reaches the build endpoints.

The backend refusal is **silent by design** — `apply_tweaks()` consults `is_protected_tweak_field()` and, on a protected field, logs a warning and `continue`s; the run still answers `200` with the flow author's value. There is therefore **no error to assert on**: the only trustworthy evidence is *behavioral* — the flow keeps producing the author's output while a benign tweak sent the same way, in the same shape, still takes effect. Every test below pairs the refusal with that control, because a spec that only asserts "the sentinel is absent" passes just as well if the tweaks mechanism is dead altogether.

Two protection routes exist and fail independently, so both are covered:

- **by field type / field name** — `field_type == "code"` or `field_name == "code"` (Test 1).
- **by component + field name** — a code-execution component (`CODE_EXECUTION_COMPONENT_TYPES`) whose executable field serializes as a plain `str` and is therefore invisible to the type check (Test 3). This is the exact bypass that made the first, name-only fix insufficient — the upstream comment in `apply_tweaks()` names it.

If these tests fail, an API caller holding only run permission on a flow can execute code of their choosing inside the Langflow process.

---

## Tags *(required)*

`@api` `@regression`

No **functional** tag applies: the tag table has no security area, and the closest siblings (`api/flows/api-run-with-tweaks.spec.ts`, `api/flows/api-run-flow.spec.ts`) also carry only cross-cutting tags. `@regression` is what issue #1394 asks for; `@api` marks the layer.

`@stable` is intentionally absent on first delivery — it is added only after team validation (`CONTRIBUTING.md`). The checklist bullet ships as `[-]`.

---

## Step by step *(required)*

The spec runs **3 independent tests** via Playwright's `request` fixture. No browser, no LLM, no provider key. Two flows are created in `beforeAll` and deleted in `afterAll`.

**Setup (`beforeAll`)**

1. `getAuthToken(request)` → Bearer for the flow/catalog/API-key endpoints.
2. `POST /api/v1/api_key/` → temporary key (asserts `200`); `POST /api/v1/run/{id}` authenticates with `x-api-key`, not Bearer.
3. **Flow A** — `createRunnableChatFlowViaApi(request, { Authorization: bearer })`: the `Chat Input -> Chat Output` passthrough fixture, whose `Chat Input` (node id `ChatInput-b6UCc`, display name `Chat Input`) stores `input_value = "Hello"`.
4. **Flow B** — `createPythonInterpreterFlowViaApi(request, headers, { authorCode })` (new helper): reads the **live** catalog (`GET /api/v1/all`), takes the `PythonREPLComponent` template, sets `python_code` to `print("AUTHOR-<unique>")`, wires it into a `Python Interpreter -> Chat Output` flow, and creates it via `POST /api/v1/flows/`. Building the node from the running instance rather than a frozen asset means a template change upstream surfaces as a real failure instead of a stale fixture silently testing nothing.

**Teardown (`afterAll`)**

1. `DELETE /api/v1/flows/{flowA}` and `DELETE /api/v1/flows/{flowB}` — id-scoped, with the `afterAll`'s own `request` (a `beforeAll` request cannot be reused).
2. `DELETE /api/v1/api_key/{apiKeyId}`.
   Each step is wrapped so a failing one cannot skip the rest; no orphan flow and no orphan key survives the file.

---

**Test 1 — a `code` tweak cannot replace a component's implementation** *(`@api @regression`)*

1. Build `MALICIOUS_CHAT_INPUT_CODE`: a syntactically valid `ChatInput` class whose `message_response()` returns a unique sentinel `PWNED-<unique>`, ignoring `input_value`. If the tweak were honoured, that string — and only that string — is what `Chat Output` would echo.
2. `POST /api/v1/run/{flowA}` with `x-api-key` and `{ input_type: "chat", output_type: "chat", tweaks: { "ChatInput-b6UCc": { code: MALICIOUS_CHAT_INPUT_CODE } } }` (keyed by **node id**).
3. Assert `200`, and that the echoed output text equals the fixture default `"Hello"` and does **not** contain the sentinel.
4. Repeat step 2 keyed by **display name** (`"Chat Input"`) — the other addressing mode `apply_tweaks` accepts — and assert the same two things.
5. `GET /api/v1/flows/{flowA}` with the Bearer; assert the stored `ChatInput-b6UCc.data.node.template.code.value` still does not contain the sentinel, i.e. the refused tweak left no persisted trace of the run.

**Test 2 — the refusal is field-scoped: a benign tweak on the same node, in both addressing modes, still applies** *(`@api @regression`)*

1. `POST /api/v1/run/{flowA}` with `tweaks: { "ChatInput-b6UCc": { input_value: "BENIGN-<unique>" } }`.
2. Assert `200` and that the echoed output equals that benign value — not `"Hello"`.
3. Repeat keyed by display name `"Chat Input"` with a second unique value; assert the same.
4. This is the control that makes Test 1 evidence rather than a tautology: the two tests differ **only** in which field the tweak targets, and both addressing modes used in Test 1 are shown live here.

**Test 3 — a plain-text executable field on a code-execution component is refused, in a request whose other tweak lands** *(`@api @regression`)*

1. `POST /api/v1/run/{flowB}` with `output_type: "debug"` (so the response carries every vertex, not just `Chat Output`) and a **single** `tweaks` object carrying three overrides at once:
   - `{ <pythonNodeId>: { python_code: "print(\"PWNED-<unique>\")" } }` — executable code in a `str`-typed field (protected by name on a `CODE_EXECUTION_COMPONENT_TYPES` node);
   - `{ <pythonNodeId>: { global_imports: "math,os" } }` — the documented sandbox boundary; widening it via tweaks must be refused;
   - `{ <chatOutputNodeId>: { sender_name: "BENIGN-<unique>" } }` — an unprotected field on the same run.
2. Assert `200`.
3. Assert the Python Interpreter vertex's result equals the author's `AUTHOR-<unique>` and does not contain the sentinel — `python_code` was refused.
4. Assert that vertex's build log still reads `Successfully imported modules: ['math']` — `global_imports` was refused, so `os` never entered the exec namespace.
5. Assert the `Chat Output` message's `sender_name` equals the benign value — the same request's unprotected tweak **did** apply, so steps 3–4 cannot be explained by "tweaks were ignored".

---

## Validation criterion *(required)*

- **Test 1:** status `200`; output text is exactly `"Hello"`; the sentinel appears in neither the response nor the stored flow's `code` field afterwards.
- **Test 2:** status `200`; output text equals the benign tweak value for **both** the node-id and the display-name key. The contrast with Test 1 — same flow, same addressing modes, same request shape, different field — is the evidence that the refusal is targeted at executable fields rather than at tweaks in general.
- **Test 3:** status `200`; the interpreter result is the author's `AUTHOR-…`; the import log lists `['math']` only; `sender_name` is the benign value. All four observations come from **one** response, so no timing or ordering explanation is available.
- Teardown leaves no flow and no API key behind: `GET /api/v1/flows/?remove_example_flows=true&header_flows=true` returns the same count before and after the file runs.

---

## What this test does not cover *(optional)*

- The other protected fields in the same registry: `function_code` (Python Function), `tool_code`, `filter_instruction` (Smart Transform), `allow_dangerous_code` (CSVAgent), and `SQLComponent.database_url` / `query`. They share one code path (`is_protected_tweak_field`) with `python_code`, which Test 3 exercises; a per-field sweep belongs in a follow-up if the registry stops being shared.
- The `/api/v1/build/...` and `/api/v2/workflows` entry points, which the `#9319` follow-up comment reports as reachable with the same payload. This spec is scoped to the endpoint named in the checklist bullet (`POST /api/v1/run/{flow_id}`).
- The unauthenticated public-flow path (`/api/v1/build_public_tmp/{flow_id}/flow`) and the `block_code_interpreter_components` opt-in gate — separate enforcement points on the same component set.
- Whether the refusal is *logged* server-side. It is (`logger.warning`), but the API caller cannot observe it, and asserting on container logs would couple the spec to the deployment shape.
- `#8672`'s requested feature (referencing `{{ input.tweaks.* }}` inside a component parameter). It was never implemented; nothing here asserts the absence of a feature.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Superuser credentials (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) for `getAuthToken`.
- The instance allows API-key creation via `POST /api/v1/api_key/`.
- `PythonREPLComponent` present in `GET /api/v1/all` (category `utilities` — a **core** family, so it survives the `lfx-bundles` M4 shim deletion; `docs/component-distribution-policy.md`). The helper fails loudly naming the component when it is absent, rather than skipping silently.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` on the instance. With it `false`, `run_python_repl()` refuses to execute at all (`ensure_code_execution_enabled`, GHSA-8qpj-27x8-pwpq) and Test 3's *author* baseline would never appear — the test would fail on the baseline assertion, not pass vacuously. Every CI lane and both start scripts set it (#668/#746).

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — Bearer via `/api/v1/auto_login`; a contract change breaks `beforeAll`.
- `tests/helpers/flows/create-runnable-chat-flow-via-api.ts` and `tests/assets/flows/chat-io-ok-trace-fixture.json` — Flow A. Renaming the `Chat Input` display name, changing its node id, or changing the stored `input_value` default breaks the tweak keys and the `"Hello"` baseline.
- `tests/helpers/flows/create-python-interpreter-flow-via-api.ts` (new) — Flow B, built from the live catalog.
- `src/lfx/src/lfx/processing/process.py` — `apply_tweaks()`: where the protection is consulted and where a refused tweak is skipped without erroring.
- `src/lfx/src/lfx/utils/flow_validation.py` — `is_protected_tweak_field()`, `CODE_EXECUTION_COMPONENT_TYPES`, `CODE_EXECUTION_FIELD_NAMES`, `PROTECTED_TWEAK_FIELDS_BY_COMPONENT`. This is the registry the spec pins; a component or field leaving it is exactly the regression to catch.
- `src/lfx/src/lfx/components/utilities/python_repl_core.py` — `PythonREPLComponent`: the `python_code` / `global_imports` field names, the `Successfully imported modules: [...]` log line asserted in Test 3, and the `ensure_code_execution_enabled()` precondition.
- `src/lfx/src/lfx/components/input_output/chat.py` and `chat_output.py` — `ChatInput.message_response()` (the method the malicious class overrides) and `ChatOutput.sender_name` (Test 3's control field).
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run/{flow_id}`: the `SimplifiedAPIRequest` schema, `output_type: "debug"`, and the `RunResponse` shape the assertions read.
- `src/backend/base/langflow/api/v1/api_key.py` — temporary API-key lifecycle.
- Upstream references: `langflow-ai/langflow#9319` (the defect, fixed) and `#8672` (the interpolation request that defines the boundary's other side).
