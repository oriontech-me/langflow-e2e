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
- **The refusal is request-scoped, not field-scoped.** `process_tweaks()` decides before it mutates — *"Decide first, mutate second. A refusal must leave the payload untouched"* — so a request carrying one protected field is refused **whole**: nothing runs, and a benign tweak sent alongside it does **not** apply. The old paired-benign control is therefore impossible inside a refused request and has moved to a **separate request** (Test 2 for Flow A, Test 3 **step 4** for Flow B). That is not a weaker control: it is the same control, plus new assertions that the refusal left the flow untouched at run time (step 2) and in the database (step 3) — and those come **before** the control, because a control that re-tweaks the field first would hide exactly the regression they exist to catch.

Measured on `1.12.0.dev37` (issue #1566, spun out of daily-failure triage #1565):

| Request | Result |
|---|---|
| `tweaks: { <chatInput>: { code } }` (node id **or** display name) | `422`, `fields: ["code"]` |
| `tweaks: { <python>: { python_code, global_imports }, <chatOutput>: { sender_name } }` | `422`, `fields: ["global_imports", "python_code"]` — `sender_name` is **not** in `fields` and did **not** apply |
| `tweaks: { <python>: { python_code } }` / `{ global_imports }` alone | `422`, `fields: ["python_code"]` / `["global_imports"]` |
| `tweaks: { <chatInput>: { input_value } }` / `{ <chatOutput>: { sender_name } }` alone | `200`, applied |
| a field the node's template does **not** declare | `200` — **skipped, not refused** |

`detail.code` and `detail.fields` are what the spec pins. `detail.message` is deliberately **not** asserted verbatim: `_refusal_reason()` returns a different string under `LANGFLOW_TWEAKS_POLICY=off` (`"This deployment does not accept tweaks."`), so pinning it would make the spec fail on a correctly-behaving instance that is merely configured differently, while `code` and `fields` are stable in every mode.

The narrower claim matters, and an earlier version of this doc got it wrong in the safe-sounding direction: **`declared` changes nothing here.** `is_tweak_refused_by_policy()` only bites under `declared` when `flow_declares_api_editable(nodes)` is true, and neither fixture flow marks any field `api_editable` (measured: every template field of `ChatInput`, `ChatOutput` and `PythonREPLComponent` reads `api_editable: false`, and `chat-io-ok-trace-fixture.json` contains no such key at all) — so under `declared` this file's behaviour *and* the refusal reason are byte-identical to `permissive`. Upstream says the same in `settings/groups/security.py`: *"A flow where the author has marked nothing keeps permissive behavior."* Only `off` is a real divergence.

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
4. **The flow is still runnable and still the author's.** `POST /api/v1/run/{flowA}` again with **no `tweaks` at all**; assert `200` and that the echoed output is exactly the fixture default `"Hello"`. Deliberately **not** described as an assertion of `process_tweaks()`'s *"decide first, mutate second"*: a tweak-free run never reaches `process_tweaks` at all (`simple_run_flow` skips it and may serve a pre-built graph), so it cannot exercise that ordering. What it does establish is the control the old design put inside the refused request — a run answering `200` with the author's value proves the endpoint is healthy and the two `422`s above were the refusal, not a broken request.
5. `GET /api/v1/flows/{flowA}` with the Bearer; assert the stored `ChatInput-b6UCc.data.node.template.code.value` still does not contain the sentinel, i.e. the refused tweak left no persisted trace either.

**Test 2 — the refusal is field-scoped: an unprotected field on the same node still applies** *(`@stable @api @regression`)*

1. `POST /api/v1/run/{flowA}` with `tweaks: { "ChatInput-b6UCc": { input_value: "BENIGN-<unique>" } }`.
2. Assert `200` and that the echoed output equals that benign value — not `"Hello"`.
3. Repeat keyed by display name `"Chat Input"` with a second unique value; assert the same.
4. This is what makes Test 1 evidence rather than a tautology at the level of the *field*: the two tests differ **only** in which field the tweak targets — same flow, same node, same addressing modes, same request shape — so the `422` in Test 1 is attributable to `code` being protected and to nothing else.
5. A tweak naming a field the node's template does **not** declare is `200` and is silently **skipped, not refused** (`fields` is not in play at all): asserted with `tweaks: { "ChatInput-b6UCc": { <undeclared field>: "…" } }` returning `200` with the author's `"Hello"`. This is the boundary between *ignored* and *refused* that #14538 introduced, and it is what stops a caller from reading every `200` as "my tweak applied".

**Test 3 — a protected field on a code-execution component refuses the whole request, and the benign tweak sent with it does not land** *(`@stable @api @regression`)*

1. `POST /api/v1/run/{flowB}` with `output_type: "debug"` and a **single** `tweaks` object carrying three overrides at once:
   - `{ <pythonNodeId>: { python_code: "print(\"PWNED-<unique>\")" } }` — executable code in a `str`-typed field (protected by name on a `CODE_EXECUTION_COMPONENT_TYPES` node);
   - `{ <pythonNodeId>: { global_imports: "math,os" } }` — the documented sandbox boundary; widening it via tweaks must be refused;
   - `{ <chatOutputNodeId>: { sender_name: "BENIGN-<unique>" } }` — an unprotected field, in the same request.
   Assert `422`; `detail.code === "TWEAKS_REFUSED"`; `detail.fields` **exactly** `["global_imports", "python_code"]` — both protected fields named (a refusal reporting only the first would hide the second from a caller trying to fix its request) and `sender_name` **absent**, which the one `toEqual` already establishes.

**The order of the next three steps is load-bearing**, and it is the correction a review earned: the benign field's *non-landing* must be asserted **before** anything re-tweaks it. `_refused_tweak_names()` exists upstream because *"applying as we go and raising at the end leaves the accepted half written, and the graph the run paths hand us is cached and reused, so that half survives into later runs that send no tweaks at all"*. A version of this test whose second request re-tweaked `sender_name` stayed **green** when that accepted half was persisted by hand — measured, not argued.

2. **Nothing ran and nothing was mutated, at run time.** `POST /api/v1/run/{flowB}` with `output_type: "debug"` and **no `tweaks` at all**. On that one `200`:
   - the Python Interpreter vertex's result equals the author's `AUTHOR-<unique>` and the sentinel appears nowhere;
   - the build log reads `Successfully imported modules: ['math']`. On *this* request that is a **non-persistence** claim, not a refusal claim — nothing asked for `os` here; the refusal itself is evidenced by `fields` in step 1;
   - the Chat Output message's `sender_name` is **not** the refused `BENIGN-<unique>`. Compared against the refused value rather than the author's literal default (`"AI"`), so a template-default change cannot satisfy it silently.
3. **Nothing was mutated in the database either.** `GET /api/v1/flows/{flowB}`: the Python Interpreter's stored `python_code.value` is still `print("AUTHOR-<unique>")`, its `global_imports.value` does not contain `os`, and the Chat Output's `sender_name.value` is not the refused value. The run-time check above may read a cached graph; this one reads what was persisted, and both have to hold. Every node lookup is asserted **present** before its value is compared — a miss must fail, not pass through a fallback.
4. **The same benign field is tweakable when sent on its own.** `POST /api/v1/run/{flowB}` with only `{ <chatOutputNodeId>: { sender_name: "BENIGN2-<unique>" } }` → `200` and that value on the message. This is the control that rules out "tweaks were ignored wholesale"; it runs **last** because it writes the field steps 2 and 3 had to read untouched.

---

## Validation criterion *(required)*

- **Test 1:** two `422`s (node id, display name), each with `detail.code === "TWEAKS_REFUSED"` and `detail.fields` exactly `["code"]`; a subsequent tweak-free run answering `200` with exactly `"Hello"` and no sentinel; and the stored flow's `code` field — asserted to exist first — carrying no sentinel. The sentinel is **not** asserted on the `422` bodies themselves: once the status holds, such a body is handler constants plus refused key names, so that check could never fail and is not counted as evidence.
- **Test 2:** status `200`; output text equals the benign tweak value for **both** the node-id and the display-name key; an undeclared field name answers `200` with the author's `"Hello"`. The contrast with Test 1 — same flow, same addressing modes, same request shape, different field — is the evidence that the refusal is targeted at executable fields rather than at tweaks in general.
- **Test 3:** one `422` whose `detail.fields` is exactly `["global_imports", "python_code"]`; then a **tweak-free** `200` in which the interpreter result is the author's `AUTHOR-…`, the import log lists `['math']` only, and `sender_name` is **not** the refused value; then the stored flow carrying the author's `python_code`, no `os` in `global_imports`, and not the refused `sender_name`; and only then a `200` proving the same field is tweakable on its own. Three requests are what the request-scoped refusal forces, and the order is part of the criterion — asserting non-landing after re-tweaking the field is what a review measured as green against a persisted accepted half.
- Teardown leaves no flow and no API key behind: `GET /api/v1/flows/?remove_example_flows=true&header_flows=true` returns the same count before and after the file runs.

---

## What this test does not cover *(optional)*

- **`LANGFLOW_TWEAKS_POLICY` (`permissive` / `declared` / `off`) and the per-flow `api_editable` allowlist**, both introduced by `#14538`. The spec runs on the default `permissive` and asserts only the **protected-field floor**, which the upstream commit states no policy relaxes. `declared`, the allowlist, and the `"This deployment does not accept tweaks."` / `"…does not accept component-targeted inputs."` refusals under `off` are a separate operator-facing surface and belong in their own spec — they need an instance-global env change, which makes them `@destructive` in this suite's lane model. Note what is therefore untested: that `declared` **cannot** expose a `code` field, which is the security-relevant half of that policy.
- **The graph-level run path** (`/api/v1/build/...`, `/api/v2/workflows`) which `#14538` reports previously accepted a `global_imports` override the sync path refused, and which now enforces the same floor through `apply_tweaks_on_vertex`. This spec stays scoped to the endpoint named in the checklist bullet (`POST /api/v1/run/{flow_id}`) — **but that is no longer a gap in the suite**: the sibling `security/tweaks-graph-path-floor.spec.ts` covers it (#1567, PR #1571, merged 2026-08-24). Read the two together; this file alone could pass while the graph path applied a protected tweak.
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
- `LANGFLOW_TWEAKS_POLICY` unset, `permissive` **or `declared`** (the product default is `permissive`, and that is what every CI lane runs). `declared` is equivalent here because neither fixture flow declares an `api_editable` field — see *What this test validates*. Under **`off`** every tweak is refused, so Test 2's `200` expectations and Test 3's last step would fail on a correctly-behaving instance.
- `LANGFLOW_SANDBOX_BACKEND` unset or `none` (the product default). Test 3 asserts the interpreter's `Successfully imported modules: ['math']` log line, which `run_python_repl()` emits **only on the in-process path**; with a sandbox backend configured it returns from `_run_in_sandbox()` and logs `Successfully imported modules` nowhere — the test would fail on an instance that is behaving correctly. Documented rather than guarded for the same reason as `LANGFLOW_ALLOW_CUSTOM_COMPONENTS` below: the failure is loud and names the missing log, not silent.
- The `['math']` in that assertion is the `PythonREPLComponent` catalog **default** for `global_imports` (verified live on `1.12.0.dev37`). A template-default change upstream reddens this security spec for a non-security reason; that is accepted as drift detection, and this line is where to look when it happens.
- `PythonREPLComponent` present in `GET /api/v1/all` (category `utilities` — a **core** family, so it survives the `lfx-bundles` M4 shim deletion; `docs/component-distribution-policy.md`). The helper fails loudly naming the component when it is absent, rather than skipping silently.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` on the instance. With it `false`, `run_python_repl()` refuses to execute at all (`ensure_code_execution_enabled`, GHSA-8qpj-27x8-pwpq) and Test 3's *author* baseline would never appear — the test would fail on the baseline assertion, not pass vacuously. Every CI lane and both start scripts set it (#668/#746).

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — Bearer via `/api/v1/auto_login`; a contract change breaks `beforeAll`.
- `tests/helpers/flows/create-runnable-chat-flow-via-api.ts` and `tests/assets/flows/chat-io-ok-trace-fixture.json` — Flow A. Renaming the `Chat Input` display name, changing its node id, or changing the stored `input_value` default breaks the tweak keys and the `"Hello"` baseline.
- `tests/helpers/flows/create-python-interpreter-flow-via-api.ts` — Flow B, built from the live catalog.
- `src/lfx/src/lfx/processing/process.py` — `process_tweaks()` (decides before it mutates, and raises with the collected keys), `apply_tweaks()`, `apply_tweaks_on_vertex()` (the graph-path floor), `_refusal_reason()` (the policy-dependent `message`) and `_resolve_tweak_policy()`.
- `src/lfx/src/lfx/exceptions/tweaks.py` — `TweakRefusedError` itself: the `refused` / `reason` contract the `422` body is rendered from. It exists **only on `release-1.12.0`, not on upstream `main`** (measured 2026-08-24), because `#14538` has not been merged back and the merge-back is sporadic (~1–2 months). Listing it here used to fail the PR, since the dependency-path guard resolved this section against `main` alone; it now resolves against `main` **and** the two newest release lines, and names every path satisfied by only one side (#1574).
- `src/backend/base/langflow/main.py` — the `TweakRefusedError` app-level exception handler: the source of the `422` and of the exact `{error, code, message, fields}` shape the spec reads. A change here changes every assertion in Tests 1 and 3. The same holds here — the *handler inside it* is 1.12-only — and it is the general rule for this section: a resolved path is evidence that a **file** exists, never that the code is in it.
- `src/lfx/src/lfx/utils/flow_validation.py` — `is_protected_tweak_field()`, `CODE_EXECUTION_COMPONENT_TYPES`, `CODE_EXECUTION_FIELD_NAMES`, `PROTECTED_TWEAK_FIELDS_BY_COMPONENT`, `TWEAK_POLICIES` and `flow_declares_api_editable()`. This is the registry the spec pins; a component or field leaving it is exactly the regression to catch.
- `src/lfx/src/lfx/components/utilities/python_repl_core.py` — `PythonREPLComponent`: the `python_code` / `global_imports` field names, the `Successfully imported modules: [...]` log line asserted in Test 3, and the `ensure_code_execution_enabled()` precondition.
- `src/lfx/src/lfx/components/input_output/chat.py` and `chat_output.py` — `ChatInput.message_response()` (the method the malicious class overrides) and `ChatOutput.sender_name` (Test 3's control field).
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run/{flow_id}`: the `SimplifiedAPIRequest` schema, `output_type: "debug"`, the `RunResponse` shape the assertions read, and the `except TweakRefusedError` re-raise that lets the refusal reach the app-level handler instead of becoming a 500. Same caveat as the `main.py` bullet above: the **path** resolves on both refs while `TweakRefusedError` appears in it 3 times on `release-1.12.0` and 0 times on `main` (measured 2026-08-24).
- `src/backend/base/langflow/api/v1/api_key.py` — temporary API-key lifecycle.
- Upstream references: `langflow-ai/langflow#9319` (the original defect, fixed), `#8672` (the interpolation request that defines the boundary's other side), and `#14538` (the loud-refusal + deployment-policy change this spec was adapted to — see issue #1566).
