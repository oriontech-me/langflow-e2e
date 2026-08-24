# Tweaks Injection

**Last validated:** Langflow 1.12.x (measured on `1.12.0.dev37`)

---

## What this test validates *(required)*

Validates that a **tweak value sent to `POST /api/v1/run/{flow_id}` cannot reach a template field as executable input** — the security boundary restored upstream after `langflow-ai/langflow#9319` ("Potential security issue in tweaks", closed as fixed on 2025-09-15) and deliberately *not* widened by the request in `#8672` (tweaks interpolated into component parameters).

`tweaks` is the documented way for an API caller to reconfigure a flow per request. Every Langflow component also carries its own Python source in the `code` template field, and several components carry executable code (or the sandbox boundary that constrains it) in *plain-text* fields — `python_code`, `function_code`, `global_imports`, `tool_code`, `filter_instruction`, `allow_dangerous_code`. Without a refusal, an authenticated run caller could rewrite what a flow *is* at run time instead of merely reconfiguring it: `#9319` demonstrated replacing `ChatInput`'s whole class body through `tweaks.<node>.code`, and the follow-up comment confirmed the same reaches the build endpoints.

### The refusal is LOUD since 1.12 — and that changes what this spec asserts

Until `langflow-ai/langflow#14538` (`4f3b9f3772`, 2026-08-21, on `release-1.12.0` — the line the nightly is cut from) the refusal was **silent by design**: `apply_tweaks()` consulted `is_protected_tweak_field()` and, on a protected field, logged a warning and `continue`d, so the run still answered `200` with the flow author's value. There was no error to assert on, and this spec's original design paired every refusal with a benign tweak **inside the same request** — without that control, a spec asserting only "the sentinel is absent" passes just as well when the tweaks mechanism is dead altogether.

That contract is gone, and its replacement is stronger on both halves:

- **A refused tweak raises.** `TweakRefusedError` is mapped by an app-level handler to **`422`** carrying `{"detail": {"error": "Refused tweaks", "code": "TWEAKS_REFUSED", "message": <reason>, "fields": [<refused keys, sorted>]}}`. The refusal is now directly observable, so the spec asserts the *mechanism* rather than inferring it from an absence.
- **The refusal is request-scoped, not field-scoped.** `process_tweaks()` decides before it mutates — *"Decide first, mutate second. A refusal must leave the payload untouched"* — so a request carrying one protected field is refused **whole**: nothing runs, and a benign tweak sent alongside it does **not** apply. The old paired-benign control is therefore impossible inside a refused request and has moved to a **second request** (Test 2 for Flow A, Test 3 step 2 for Flow B). That is not a weaker control: it is the same control, plus a new assertion that the refusal left the flow untouched.

Measured on `1.12.0.dev37` (issue #1566, spun out of daily-failure triage #1565):

| Request | Result |
|---|---|
| `tweaks: { <chatInput>: { code } }` (node id **or** display name) | `422`, `fields: ["code"]` |
| `tweaks: { <python>: { python_code, global_imports }, <chatOutput>: { sender_name } }` | `422`, `fields: ["global_imports", "python_code"]` — `sender_name` is **not** in `fields` and did **not** apply |
| `tweaks: { <python>: { python_code } }` / `{ global_imports }` alone | `422`, `fields: ["python_code"]` / `["global_imports"]` |
| `tweaks: { <chatInput>: { input_value } }` / `{ <chatOutput>: { sender_name } }` alone | `200`, applied |
| a field the node's template does **not** declare | `200` — **skipped, not refused** |

`detail.code` and `detail.fields` are what the spec pins. `detail.message` is deliberately **not** asserted verbatim: `_refusal_reason()` returns a different string per `LANGFLOW_TWEAKS_POLICY` (`permissive` — the default and what CI runs — vs `declared` vs `off`), so pinning it would make the spec fail on a correctly-behaving instance that is merely configured differently, while `code` and `fields` are stable across all three.

Two protection routes exist and fail independently, so both are covered:

- **by field type / field name** — `field_type == "code"` or `field_name == "code"` (Test 1).
- **by component + field name** — a code-execution component (`CODE_EXECUTION_COMPONENT_TYPES`) whose executable field serializes as a plain `str` and is therefore invisible to the type check (Test 3). This is the exact bypass that made the first, name-only fix insufficient — the upstream comment in `apply_tweaks()` names it.

If these tests fail, an API caller holding only run permission on a flow can execute code of their choosing inside the Langflow process.

---

## Tags *(required)*

`@stable` `@api` `@regression`

No **functional** tag applies: the tag table has no security area, and the closest siblings (`api/flows/api-run-with-tweaks.spec.ts`, `api/flows/api-run-flow.spec.ts`) also carry only cross-cutting tags. `@regression` is what issue #1394 asks for; `@api` marks the layer.

`@stable` ships with the first delivery by the maintainer's decision, so this security boundary is watched by `daily-stable.yml` from day one rather than after a validation cycle. The lane profile fits: the file is pure API (no browser, no LLM, no provider key, ~3 s for all three tests), so it costs the daily almost nothing and cannot fail for a provider-outage reason. It is **not** `@destructive` — it creates and deletes only its own two flows and its own API key, so it is safe in the daily's normal lane (`@stable` + `@destructive` would silently never run, #1010). The checklist bullet is therefore `[x]`.

`@stable` was auto-removed from Tests 1 and 3 by `daily-stable.yml` on 2026-08-24 (commit `12bfd89`) when the loud-refusal contract landed, and is restored by the PR that adapts them (#1566).

---

## Step by step *(required)*

The spec runs **3 independent tests** via Playwright's `request` fixture. No browser, no LLM, no provider key. Two flows are created in `beforeAll` and deleted in `afterAll`.

The `422`s asserted below are **provoked on purpose**, and no escape hatch is needed for them: the fixture's HTTP-error monitor attaches to the `page` fixture's responses, and this file requests only `request` — so a `page` is never instantiated and these deliberate refusals never reach the advisory `🚨 Backend Error` log (`CLAUDE.md` → test infrastructure). Measured: the run that recorded the contract above printed no backend-error line. `page.allowHttpErrors()` would be the hatch the day this file also drives a browser.

**Setup (`beforeAll`)**

1. `getAuthToken(request)` → Bearer for the flow/catalog/API-key endpoints.
2. `POST /api/v1/api_key/` → temporary key (asserts `200`); `POST /api/v1/run/{id}` authenticates with `x-api-key`, not Bearer.
3. **Flow A** — `createRunnableChatFlowViaApi(request, { Authorization: bearer })`: the `Chat Input -> Chat Output` passthrough fixture, whose `Chat Input` (node id `ChatInput-b6UCc`, display name `Chat Input`) stores `input_value = "Hello"`.
4. **Flow B** — `createPythonInterpreterFlowViaApi(request, headers, { authorCode })`: reads the **live** catalog (`GET /api/v1/all`), takes the `PythonREPLComponent` template, sets `python_code` to `print("AUTHOR-<unique>")`, wires it into a `Python Interpreter -> Chat Output` flow, and creates it via `POST /api/v1/flows/`. Building the node from the running instance rather than a frozen asset means a template change upstream surfaces as a real failure instead of a stale fixture silently testing nothing.

**Teardown (`afterAll`)**

1. `DELETE /api/v1/flows/{flowA}` and `DELETE /api/v1/flows/{flowB}` — id-scoped, with the `afterAll`'s own `request` (a `beforeAll` request cannot be reused).
2. `DELETE /api/v1/api_key/{apiKeyId}`.
   Each step is wrapped so a failing one cannot skip the rest; no orphan flow and no orphan key survives the file.

---

**Test 1 — a `code` tweak is refused with a `422` naming the field, and the flow is left untouched** *(`@stable @api @regression`)*

1. Build `MALICIOUS_CHAT_INPUT_CODE`: a syntactically valid `ChatInput` class whose `message_response()` returns a unique sentinel `PWNED-<unique>`, ignoring `input_value`. If the tweak were honoured, that string — and only that string — is what `Chat Output` would echo.
2. `POST /api/v1/run/{flowA}` with `x-api-key` and `{ input_type: "chat", output_type: "chat", tweaks: { "ChatInput-b6UCc": { code: MALICIOUS_CHAT_INPUT_CODE } } }` (keyed by **node id**). Assert `422`; `detail.code === "TWEAKS_REFUSED"`; `detail.fields` is exactly `["code"]`; the sentinel appears nowhere in the response.
3. Repeat step 2 keyed by **display name** (`"Chat Input"`) — the other addressing mode `apply_tweaks` accepts — and assert the same four things. A refusal that only fires for one addressing mode is the bypass shape this step exists to catch.
4. **The refusal left nothing behind.** `POST /api/v1/run/{flowA}` again with **no `tweaks` at all**; assert `200` and that the echoed output is exactly the fixture default `"Hello"`. This is the direct assertion of `process_tweaks()`'s *"a refusal must leave the payload untouched"* — and it doubles as the control the old design put inside the refused request: a run that answers `200` with the author's value proves the endpoint is healthy and the two `422`s above were the refusal, not a broken request.
5. `GET /api/v1/flows/{flowA}` with the Bearer; assert the stored `ChatInput-b6UCc.data.node.template.code.value` still does not contain the sentinel, i.e. the refused tweak left no persisted trace either.

**Test 2 — the refusal is field-scoped: an unprotected field on the same node still applies** *(`@stable @api @regression`)*

1. `POST /api/v1/run/{flowA}` with `tweaks: { "ChatInput-b6UCc": { input_value: "BENIGN-<unique>" } }`.
2. Assert `200` and that the echoed output equals that benign value — not `"Hello"`.
3. Repeat keyed by display name `"Chat Input"` with a second unique value; assert the same.
4. This is what makes Test 1 evidence rather than a tautology at the level of the *field*: the two tests differ **only** in which field the tweak targets — same flow, same node, same addressing modes, same request shape — so the `422` in Test 1 is attributable to `code` being protected and to nothing else.
5. A tweak naming a field the node's template does **not** declare is `200` and is silently **skipped, not refused** (`fields` is not in play at all): asserted with `tweaks: { "ChatInput-b6UCc": { <undeclared field>: "…" } }` returning `200` with the author's `"Hello"`. This is the boundary between *ignored* and *refused* that #14538 introduced, and it is what stops a caller from reading every `200` as "my tweak applied".

**Test 3 — a protected field on a code-execution component refuses the whole request, and the benign tweak sent with it does not land** *(`@stable @api @regression`)*

1. `POST /api/v1/run/{flowB}` with `output_type: "debug"` (so the response carries every vertex, not just `Chat Output`) and a **single** `tweaks` object carrying three overrides at once:
   - `{ <pythonNodeId>: { python_code: "print(\"PWNED-<unique>\")" } }` — executable code in a `str`-typed field (protected by name on a `CODE_EXECUTION_COMPONENT_TYPES` node);
   - `{ <pythonNodeId>: { global_imports: "math,os" } }` — the documented sandbox boundary; widening it via tweaks must be refused;
   - `{ <chatOutputNodeId>: { sender_name: "BENIGN-<unique>" } }` — an unprotected field, in the same request.
2. Assert `422`; `detail.code === "TWEAKS_REFUSED"`; `detail.fields` is exactly `["global_imports", "python_code"]` — **both** protected fields named (a refusal that reports only the first would hide the second from a caller trying to fix its request), `sender_name` **absent** from the list, and the sentinel absent from the response. That `sender_name` is neither refused nor applied is the request-scope property: it was collateral to a refusal, not itself protected.
3. **Nothing ran and nothing was mutated.** `POST /api/v1/run/{flowB}` again with only the benign tweak: `{ <chatOutputNodeId>: { sender_name: "BENIGN2-<unique>" } }`. Assert `200`, and on that one response:
   - the Python Interpreter vertex's result equals the author's `AUTHOR-<unique>` and the sentinel appears nowhere — `python_code` was refused *and* the refusal persisted nothing into the flow;
   - that vertex's build log still reads `Successfully imported modules: ['math']` — `global_imports` was refused, so `os` never entered the exec namespace;
   - the `Chat Output` message's `sender_name` equals `BENIGN2-<unique>` — the unprotected field **is** tweakable on this flow, which is what rules out "tweaks were ignored wholesale" as the explanation for step 2 and for the benign field not landing there.

---

## Validation criterion *(required)*

- **Test 1:** two `422`s (node id, display name), each with `detail.code === "TWEAKS_REFUSED"` and `detail.fields` exactly `["code"]`; the sentinel in neither response, nor in the stored flow's `code` field afterwards; and a subsequent tweak-free run answering `200` with exactly `"Hello"`.
- **Test 2:** status `200`; output text equals the benign tweak value for **both** the node-id and the display-name key; an undeclared field name answers `200` with the author's `"Hello"`. The contrast with Test 1 — same flow, same addressing modes, same request shape, different field — is the evidence that the refusal is targeted at executable fields rather than at tweaks in general.
- **Test 3:** one `422` whose `detail.fields` is exactly `["global_imports", "python_code"]` and which does not name `sender_name`; then, in **one** follow-up `200` response, the interpreter result is the author's `AUTHOR-…`, the import log lists `['math']` only, and `sender_name` is the second benign value. The two requests are what the request-scoped refusal forces; each individual claim still rests on a single response, so no timing or ordering explanation is available.
- Teardown leaves no flow and no API key behind: `GET /api/v1/flows/?remove_example_flows=true&header_flows=true` returns the same count before and after the file runs.

---

## What this test does not cover *(optional)*

- **`LANGFLOW_TWEAKS_POLICY` (`permissive` / `declared` / `off`) and the per-flow `api_editable` allowlist**, both introduced by `#14538`. The spec runs on the default `permissive` and asserts only the **protected-field floor**, which the upstream commit states no policy relaxes. The two strict modes, the allowlist, and the `"This deployment does not accept component-targeted inputs."` refusal for `off` are a separate operator-facing surface and belong in their own spec — they need an instance-global env change, which makes them `@destructive` in this suite's lane model.
- **The graph-level run path** (`/api/v1/build/...`, `/api/v2/workflows`) which `#14538` reports previously accepted a `global_imports` override the sync path refused, and which now enforces the same floor through `apply_tweaks_on_vertex`. This spec is scoped to the endpoint named in the checklist bullet (`POST /api/v1/run/{flow_id}`); covering the streaming/background path is tracked separately.
- The other protected fields in the same registry: `function_code` (Python Function), `tool_code`, `filter_instruction` (Smart Transform), `allow_dangerous_code` (CSVAgent), and `SQLComponent.database_url` / `query`. They share one code path (`is_protected_tweak_field`) with `python_code`, which Test 3 exercises; a per-field sweep belongs in a follow-up if the registry stops being shared.
- The unauthenticated public-flow path (`/api/v1/build_public_tmp/{flow_id}/flow`) and the `block_code_interpreter_components` opt-in gate — separate enforcement points on the same component set.
- The exact `detail.message` text, which varies by deployment policy (see *What this test validates*). Only `code` and `fields` are pinned.
- Whether the refusal is *also* logged server-side. Asserting on container logs would couple the spec to the deployment shape, and the `422` is now the caller-observable evidence that made the log the only signal before `#14538`.
- `#8672`'s requested feature (referencing `{{ input.tweaks.* }}` inside a component parameter). It was never implemented; nothing here asserts the absence of a feature.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Superuser credentials (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) for `getAuthToken`.
- The instance allows API-key creation via `POST /api/v1/api_key/`.
- `LANGFLOW_TWEAKS_POLICY` unset or `permissive` (the product default, and what every CI lane runs). Under `declared` or `off` the refusal *reason* changes and Test 2's benign tweaks would themselves be refused, so the file's `200` expectations belong to the default policy — see *What this test does not cover*.
- `PythonREPLComponent` present in `GET /api/v1/all` (category `utilities` — a **core** family, so it survives the `lfx-bundles` M4 shim deletion; `docs/component-distribution-policy.md`). The helper fails loudly naming the component when it is absent, rather than skipping silently.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` on the instance. With it `false`, `run_python_repl()` refuses to execute at all (`ensure_code_execution_enabled`, GHSA-8qpj-27x8-pwpq) and Test 3's *author* baseline would never appear — the test would fail on the baseline assertion, not pass vacuously. Every CI lane and both start scripts set it (#668/#746).

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — Bearer via `/api/v1/auto_login`; a contract change breaks `beforeAll`.
- `tests/helpers/flows/create-runnable-chat-flow-via-api.ts` and `tests/assets/flows/chat-io-ok-trace-fixture.json` — Flow A. Renaming the `Chat Input` display name, changing its node id, or changing the stored `input_value` default breaks the tweak keys and the `"Hello"` baseline.
- `tests/helpers/flows/create-python-interpreter-flow-via-api.ts` — Flow B, built from the live catalog.
- `src/lfx/src/lfx/processing/process.py` — `process_tweaks()` (decides before it mutates, and raises with the collected keys), `apply_tweaks()`, `apply_tweaks_on_vertex()` (the graph-path floor), `_refusal_reason()` (the policy-dependent `message`) and `_resolve_tweak_policy()`.
- The `TweakRefusedError` module itself is **deliberately absent from this list**, and its absence is a fact about the change rather than an omission: it exists only on `release-1.12.0`, not on upstream `main`, because `#14538` has not been merged back (measured 2026-08-24; the merge-back is sporadic, ~1–2 months). `pr-validation.yml`'s dependency-path guard resolves this section against upstream **`origin/main`**, so listing it would fail the PR for a path that is genuinely correct for the image this suite tests. It lives at `lfx/exceptions/tweaks.py` on the release line, carries `refused` and `reason`, and is the contract the `422` body is rendered from — the handler entry above is where that body is actually shaped, and it resolves on both refs.
- `src/backend/base/langflow/main.py` — the `TweakRefusedError` app-level exception handler: the source of the `422` and of the exact `{error, code, message, fields}` shape the spec reads. A change here changes every assertion in Tests 1 and 3.
- `src/lfx/src/lfx/utils/flow_validation.py` — `is_protected_tweak_field()`, `CODE_EXECUTION_COMPONENT_TYPES`, `CODE_EXECUTION_FIELD_NAMES`, `PROTECTED_TWEAK_FIELDS_BY_COMPONENT`, `TWEAK_POLICIES` and `flow_declares_api_editable()`. This is the registry the spec pins; a component or field leaving it is exactly the regression to catch.
- `src/lfx/src/lfx/components/utilities/python_repl_core.py` — `PythonREPLComponent`: the `python_code` / `global_imports` field names, the `Successfully imported modules: [...]` log line asserted in Test 3, and the `ensure_code_execution_enabled()` precondition.
- `src/lfx/src/lfx/components/input_output/chat.py` and `chat_output.py` — `ChatInput.message_response()` (the method the malicious class overrides) and `ChatOutput.sender_name` (Test 3's control field).
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run/{flow_id}`: the `SimplifiedAPIRequest` schema, `output_type: "debug"`, the `RunResponse` shape the assertions read, and the `except TweakRefusedError` re-raise that lets the refusal reach the app-level handler instead of becoming a 500.
- `src/backend/base/langflow/api/v1/api_key.py` — temporary API-key lifecycle.
- Upstream references: `langflow-ai/langflow#9319` (the original defect, fixed), `#8672` (the interpolation request that defines the boundary's other side), and `#14538` (the loud-refusal + deployment-policy change this spec was adapted to — see issue #1566).
