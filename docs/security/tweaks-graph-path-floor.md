# Tweaks — the protected-field floor on the graph run path

**Last validated:** Langflow 1.12.0.dev38 — manifest list shared by `:latest` and `:1.12.0.dev38` (verified identical), `linux/amd64` `sha256:5082eb1ecb056f94491c4debe25925be48948dabc15db7186eeeb9fe645021d0` (the image every CI lane pulls) / `linux/arm64` `sha256:5813e74988bf09fdfd6c16fd5aad39aae0099469907ec48d5e5625a3f9c66683` (the one this validation ran on, named because the arch is part of the measurement); upstream revision `814fbceeb1dd38d3e52f60ce1e638af6fb725ffe`. First validated on 1.12.0.dev37 (`sha256:b672ab7e…`, revision `50340f2a4322…`); the measured table below is unchanged between the two builds, re-measured for `mode=sync` on dev38.

---

## What this test validates *(required)*

Validates that **the protected-field floor is a property of the tweaks contract, not of one endpoint**, and that **a refusal is attributable on the surface the caller is using**.

`security/tweaks-injection.spec.ts` covers the floor on `POST /api/v1/run/{flow_id}`, where tweaks are applied to the graph *payload* before construction. Langflow has a second, structurally different path: the **streaming** and **background** run modes build the `Graph` first and then push overrides onto built vertices (`process_tweaks_on_graph` / `apply_tweaks_on_vertex`). Upstream `langflow-ai/langflow#14538` (`4f3b9f3772`, 2026-08-21) records that this path *"filtered only the literal key `code` in `api/build.py`, so it accepted tweaks the sync mode refused: a `global_imports` override widening the exec sandbox was applied"*, and adds the enforcement plus `except TweakRefusedError` re-raises at three call sites *"because both call sites previously swallowed the refusal into a 500"*. Nothing in this suite exercises that path.

Two registered protections are asserted (`CODE_EXECUTION_FIELD_NAMES` on a `CODE_EXECUTION_COMPONENT_TYPES` node), and they fail independently:

- **`python_code`** — the Python Interpreter's executable input. A run-time override never passes through the build-time sanitizer that governs whose component source may execute (`prepare_flow_build_for_user`).
- **`global_imports`** — the documented sandbox boundary. `get_globals()` builds the exec namespace from it and `validate_code_safety()` rejects inline `import`, so a module is reachable from the author's code **only** if it is on this list. Widening it is an escalation, not a configuration change.

The floor is asserted in **both** directions on every covered surface, because the two failure modes are opposite and a spec catching one can miss the other:

- **acceptance** — the tweak takes effect. Caught causally: the author's `python_code` branches on whether the widened module is in scope and prints one of two sentinels, so the run itself names which value was in effect.
- **an unattributable refusal** — the value is dropped, or the request fails, without the caller being told which key was refused and why. On a security path that is a reporting failure with teeth: a caller who cannot tell a refused tweak from a server fault retries, and believes a value took effect when it did not.

Every refusal is paired with a **benign** tweak on the same surface and the same request shape, because a spec asserting only "the sentinel is absent" passes just as well when the tweaks mechanism is dead altogether.

---

## Tags *(required)*

`@stable` `@api` `@regression`

No **functional** tag applies: the tag table has no security area, and the sibling `security/` specs (`tweaks-injection`, `code-execution-endpoints`, `ssrf-url-validation`) also carry only cross-cutting tags. `@api` marks the layer; `@regression` is what issue #1567 asks for.

**`@stable` was added in the validation cycle #1572 asked for, not in the first delivery.** PR #1571 shipped the file `@api @regression` only, which the repo's own mechanism turns into *no scheduled lane at all*: `daily-stable.yml` selects `--grep @stable` and `nightly.yml` has been dispatch-only since 2026-03, so the three tests ran only when `pr-validation.yml`'s impacted-specs gate happened to select them. The graph-path half of `langflow-ai/langflow#14538` — the half that closed a real bypass — was therefore watched by nothing, while the sync-endpoint sibling (`security/tweaks-injection.spec.ts`) was watched daily. The lane profile is why promotion needed no design change: pure API, no browser, no LLM, no provider key, no `@destructive` state, three tests in ~3 s, and no failure mode that depends on a provider key or quota. Validated on the build in **Last validated** above — five consecutive `--workers=1 --retries=0` runs plus one default-parallel run (3 workers, one `beforeAll` per worker), 18/18 tests green, zero orphan flows left behind, and an executed force-fail for every assertion family — attribution, liveness, the sync `2xx` floor, and acceptance, the last of which takes a two-part mutation on the streaming surfaces for a reason recorded under **Validation criterion**.

Not `@destructive`, and that is a **precondition of the promotion, not a note**: `@stable` combined with `@destructive` would put the tests back in no scheduled lane, since `daily-stable.yml` has no destructive lane (#1010). The file creates and deletes only its own two flows and sets no instance-wide state.

(A spec for `LANGFLOW_TWEAKS_POLICY` *would* be instance-global — that surface is scoped out below.)

---

## Measured contract — one table, four surfaces *(required reading)*

Measured on 1.12.0.dev37 and re-verified on the dev38 digest above, against the container's **own** published port with the identity asserted (`GET /api/v1/version` → the expected `.devNN` / `Langflow Nightly`) before every run. The `mode=sync` cell was re-measured directly on dev38 for the #1572 promotion and is unchanged. Flow: `Python Interpreter -> Chat Output`, author `global_imports = "math"`, author `python_code` = the two-sentinel probe.

| tweak on the interpreter node | `POST /api/v1/run/{id}` | `/api/v2/workflows` `sync` | `/api/v2/workflows` `stream` | `/api/v2/workflows` `background` |
|---|---|---|---|---|
| `global_imports: ["os"]` (protected) | `422` · `code: TWEAKS_REFUSED` · `fields: ["global_imports"]` | **`500` · `code: INTERNAL_SERVER_ERROR` · `"An unexpected error occurred."`** | `200` + an `event: "error"` frame naming `TweakRefusedError` and the refused key | `200` + the same frame on `GET /{job_id}/events` |
| `python_code` (protected) | `422` · `fields: ["python_code"]` | **`500`, same generic body** | same as above | same as above |
| `sender_name` (benign control) | `200`, applied | `200`, applied | `200`, applied | `200`, applied |
| none (control) | `200`, author value | `200`, author value | `200`, author value | `200`, author value |

**The floor holds on all four surfaces** — no protected tweak was ever applied, on any surface, in any policy state. The graph path enforces it, which is what `#14538` claims and what this spec pins so a regression cannot return it silently.

**`mode=sync` refuses, but reports it as a generic `500`.** The `TWEAKS_REFUSED` code and the refused field names — which the v1 endpoint returns for the identical request, and which the app-level handler exists to produce — are gone, so the caller cannot separate "my request was refused" from "the server failed" and will retry a request that can never succeed. Mechanism: `TweakRefusedError` is deliberately not an `HTTPException` (`lfx/exceptions/tweaks.py` says so — library callers see a plain Python exception), so it lands in the catch-all `except Exception -> 500` arm of `langflow/api/v2/workflow.py`'s inline sync handler and never reaches the app-level handler in `main.py`. The re-raise `#14538` added at `workflow_execution.py:704` is present and correct; it hands the exception to a router that swallows it.

**Test 3 asserts this surface shape-agnostically, and that is a deliberate scope choice rather than a gap.** The property it pins — a refusal must never answer `2xx` — is true under the current `500` and equally true under the `422` the code intends, so the test is green in both worlds while still catching the failure this file exists for: a refusal that answers `200`, whether because the tweak took effect or because it was dropped and the run proceeded anyway. Pinning `422` would ship a red test for a reporting difference; pinning `500` would bless it. The difference between the two statuses is real but it is an API-contract cost, not a security one, and it is recorded here rather than asserted.

The graph path's `200`-plus-error-event is **not** a defect and is deliberately asserted as-is: `langflow/api/build.py`'s own comment records that streaming and background callers run the build in their own task, so a refusal is reported as an error event on an already-committed `200`. Enforcement holds either way. The frame carries the refusal in `content_blocks[0].text` (`Refused tweak keys ['global_imports']: The field is protected and keeps the value set by the flow author.`) and again under `reason` (`**TweakRefusedError**`), which is what makes it attributable rather than a bare failure.

### Two further measurements, recorded because they answer #1567 and cost more to repeat than to keep

- **`LANGFLOW_TWEAKS_POLICY` is enforced, and the floor outranks the flow author's allowlist.** With `off`, *every* tweak is refused — including the benign one — with `message: "This deployment does not accept tweaks."`. With `declared` on a flow that marks fields `api_editable`, a marked **benign** field (`sender_name`) is applied while a marked **protected** field (`global_imports`) is still refused. That is the security-relevant half of the feature: an author cannot opt a code or sandbox field into the API by toggling a flag. One observation, not asserted anywhere: the refusal `message` is chosen by policy rather than by which layer refused, so under `declared` a floor refusal is explained as *"This flow declares which fields the API may set"* even when the field **is** marked editable.
- **An invalid value fails closed.** `LANGFLOW_TWEAKS_POLICY=bogus-typo` raises `ValidationError: … tweaks_policy Input should be 'permissive', 'declared' or 'off'`; the container exits `1` after ~10 s and never serves. The `_resolve_tweak_policy()` fallback to `permissive` is real in code but unreachable through the environment, because pydantic rejects the value first — it applies only to a library caller that sets the setting programmatically. This refutes the premise in #1567 that a typo silently widens the policy.

### A measurement trap this spec was written through, worth carrying

The first pass of this work was measured against `http://localhost:7866`, which on this machine is **not** the container that `docker run -p 7866:7860` published: an SSH tunnel from a parallel session holds `*:7860`, `*:7865`, `*:7866` and `*:7891`, and another process holds `127.0.0.1:7866`, so `localhost` resolved to a different Langflow entirely. Every conclusion from that pass was wrong in the same direction — it reported the floor unenforced on the graph path, the policy inert, and source instrumentation never executing. Three signals said so and were each explained away individually: `GET /api/v1/version` answered `1.12.0` / `package: "Langflow"` where the nightly must answer `.devNN` / `"Langflow Nightly"`; a container that had exited `1` still "answered" on its port; and the instance held flows nobody in this session created. **Check `lsof -iTCP:<port> -sTCP:LISTEN` before publishing, and assert the version endpoint's `package` and `version` before trusting a single measurement** — which is what the probe scripts and this spec's own preflight now do.

---

## Step by step *(required)*

The spec runs **3 tests** via Playwright's `request` fixture. No browser, no LLM, no provider key, no API key (`POST /api/v2/workflows` authenticates with the Bearer). Two flows are created in `beforeAll` and deleted in `afterAll`.

**Setup (`beforeAll`)**

1. `getAuthToken(request)` → Bearer for every call.
2. `createPythonInterpreterFlowViaApi(request, { Authorization: bearer }, { authorCode })` — the existing helper builds `Python Interpreter -> Chat Output` from the **live** catalog (`GET /api/v1/all`). `authorCode` is the causal probe:

   ```python
   try:
       print("WIDENED:" + os.name)
   except NameError:
       print("AUTHOR-<unique>")
   ```

   Inline `import` is rejected by `validate_code_safety()`, so `os` is in scope only if `global_imports` was widened.
3. The stored `global_imports` is read back and asserted **not** to contain `os` — the whole probe is vacuous otherwise, and a template default change upstream must fail here rather than silently.
4. `createRunnableChatFlowViaApi(request, { Authorization: bearer })` — the benign control, whose `ChatInput-b6UCc.input_value` tweak is visible in the produced text on all three v2 modes.

**Teardown (`afterAll`)** — both flows deleted id-scoped with the `afterAll`'s own `request`, in nested `try/finally` so a failure in one cannot skip the other. No orphan survives the file.

---

**Test 1 — `mode=stream` refuses a protected tweak, and says so** *(`@stable @api @regression`)*

1. `POST /api/v2/workflows` with `mode: "stream"` and `tweaks: { <pythonNodeId>: { global_imports: ["os"] } }`; assert `200` (the stream is committed before the build runs).
2. Parse the body with `parseStreamEvents()` and assert an `event: "error"` frame exists whose serialized text names both `TweakRefusedError` and the refused key `global_imports` — the refusal is attributable, not a bare failure.
3. Assert `WIDENED:` appears nowhere in the stream: the sandbox was not widened, in the one place a silent acceptance would show.
4. Repeat 1–3 for `python_code`, asserting the caller's sentinel never appears.
5. **Control, same surface:** the benign `input_value` tweak on the chat flow produces that value in the `add_message` text and emits **no** error frame; the same call with no tweaks produces the flow's stored value. Without this, steps 2–4 pass equally well against a dead mechanism.

**Test 2 — `mode=background` refuses it too, and says so** *(`@stable @api @regression`)*

Same five steps, with the events read from `GET /api/v2/workflows/{job_id}/events` after the submit returns a `job_id`. Kept as its own test because `#14538` names both modes and they can regress independently.

**Test 3 — `mode=sync` refuses a protected tweak without ever answering `2xx`** *(`@stable @api @regression`)*

1. `POST /api/v2/workflows` with `mode: "sync"` and the `global_imports` tweak; assert the status is `>= 400`. A `2xx` here means the tweak either took effect or was dropped without telling the caller, and both are the failures this file exists for. The body's shape is deliberately not pinned — see above.
2. Repeat for `python_code`.
3. **The refusal left nothing behind:** a subsequent run with no tweaks produces the author's sentinel and never `WIDENED:`, so a refused request did not half-apply into the cached graph.
4. **Control:** the benign tweak on the same surface answers `200` and takes effect.

---

## Validation criterion *(required)*

The spec passes only when, on each covered surface, **no protected tweak takes effect**, **the refusal names itself and the key**, and **a benign tweak on that same surface still applies**. A run where the benign control did not apply fails, because it measured nothing; a stream carrying `WIDENED:` fails; an error frame that does not name the refused key fails.

The file fails for the right reason in both directions: relaxing an assertion cannot make it pass while the control must still apply. There is no `.fixme` and no quarantined assertion anywhere in it — the day `mode=sync` returns its `422`, Test 3 stays green **unchanged**, because the property it pins (never `2xx`) is true under both shapes. That is what makes the file safe to run in the daily lane: no assertion in it is waiting on an upstream fix.

Force-fail evidence for the `@stable` promotion (#1572), each mutation executed against 1.12.0.dev38 and reverted:

| mutation | emulates | tests that failed, and on which assertion |
|---|---|---|
| the protected `global_imports` tweak replaced by a benign `sender_name` one | the floor stops refusing, so no refusal is reported at all | 1, 2 — *"the refusal must be attributable on this surface, not a bare failure"*; 3 — *"a refused global_imports tweak must not answer 2xx"* |
| `REFUSAL_MARKER` → a string the frame does not carry | the refusal happens but is unattributable | 1, 2 — *"the refusal must be attributable on this surface, not a bare failure"* |
| `CHAT_INPUT_NODE_ID` → an id no node has | the tweaks mechanism is dead, so the refusals measured nothing | 1, 2, 3 — *"tweaks must be alive on this surface"* |
| `WIDENED_PREFIX` → text the author's own run really prints | the widened branch executed | 3 — *"a refusal must leave nothing behind"* |
| **both together**: the benign `sender_name` tweak **and** `WIDENED_PREFIX` set to text the executed run prints | the graph path *accepts* the protected tweak — the run executes and emits the widened sentinel | 1, 2 — *"the flow author's sandbox must still be in effect — the run reached the widened branch"*; 3 — the `2xx` floor |

**Why the acceptance check on the two streaming surfaces needs that last, two-part mutation, and what that says about it.** On `mode=stream` and `mode=background` a protected tweak is refused *before the build runs*, so the refused request emits no program output whatsoever — measured, not inferred: mutating `sandboxProbe` so that **both** of its branches print the sentinel leaves tests 1 and 2 **green** (only test 3 fails, on its own no-residue step). No test-side edit to the probe or the sentinel alone can make the streaming `WIDENED:` assertion fire. It fires only when the run actually executes while the sentinel matches what it prints, which is exactly the causal shape of a real acceptance — and that is the mutation in the last row. Read the row as what it is: the assertion is proven live, by the one mutation that reproduces the bypass `langflow-ai/langflow#14538` closed, and by nothing cheaper.

---

## What this test does not cover *(optional)*

- **`POST /api/v1/run/{flow_id}`** — owned by `security/tweaks-injection.spec.ts` and by #1566, which is adapting that file to the `422` contract this build returns. Covering it here would duplicate assertions across two files that must then change together. It is measured in the table above only as the reference the other surfaces are compared against.
- **`LANGFLOW_TWEAKS_POLICY` and the `api_editable` allowlist.** Measured working (above), so this is a lane decision and not a product question: the setting is instance-global, cannot be set from a test, and no lane starts a container with it — so a gated spec would `skip` on every lane the suite runs, which is the failure mode #1010 exists to prevent. It is a *coverable* surface awaiting a lane, and the exact refusal reasons are recorded here so that spec does not have to re-measure them.
- **The exact refusal shape on `mode=sync`** — `422` + `TWEAKS_REFUSED` + `fields`, as `POST /api/v1/run` returns. Measured to be a generic `500` (above) and deliberately not asserted: the difference is an API-contract cost, not a security one, and a spec pinning either number would be wrong in one of the two worlds. A one-arm addition to that router's `except` ladder would fix it, at which point Test 3 keeps passing unchanged and this entry can be tightened.
- **The traceback in the stream's error frame.** The frame carries an absolute-path traceback (`/app/.venv/.../langflow/api/build.py`, line 564). Whether that should reach a client is governed by `expose_error_details` and is the same for every component error, so it is a separate question from the tweaks contract and is not asserted either way.
- **Non-owner callers.** `_enforce_owner_only_tweaks` restricts tweaks to the flow's owner, so the boundary covered here is a run-time bypass of the *build-time* code policies, not a cross-tenant one. Asserting the ownership gate is a separate property and a separate spec.
- **Whether the refusal is logged server-side.** Same reason as the sibling: an API caller cannot observe it, and asserting on container logs would couple the spec to the deployment shape.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`, on a build that ships `POST /api/v2/workflows` with `mode` (`sync` / `stream` / `background`) — present on 1.12.x.
- **The URL must actually be that instance.** See the measurement trap above: verify with `lsof -iTCP:<port> -sTCP:LISTEN` and by reading `GET /api/v1/version`.
- Superuser credentials (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) for `getAuthToken`.
- `PythonREPLComponent` present in `GET /api/v1/all` (category `utilities` — a **core** family, so it survives the `lfx-bundles` M4 shim deletion; `docs/component-distribution-policy.md`). The helper fails loudly naming the component when it is absent rather than skipping silently.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`. With it `false`, `run_python_repl()` refuses to execute at all (`ensure_code_execution_enabled`, GHSA-8qpj-27x8-pwpq) and the control's author baseline would never appear — the tests fail on the baseline assertion rather than passing vacuously. Every CI lane and both start scripts set it (#668/#746).
- The instance must **not** be started with `LANGFLOW_TWEAKS_POLICY` set to a strict value: under `off` the benign control is refused too, and the tests would fail for the deployment's reason rather than the contract's. Nothing in the suite sets it, and an invalid value stops the instance from serving at all.

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — Bearer via `/api/v1/auto_login`; a contract change breaks `beforeAll`.
- `tests/helpers/flows/create-python-interpreter-flow-via-api.ts` — the flow under test, built from the live catalog. Its `pythonNodeId` is the tweak key; its `authorCode` option carries the causal probe.
- `tests/helpers/flows/create-runnable-chat-flow-via-api.ts` and `tests/assets/flows/chat-io-ok-trace-fixture.json` — the benign control. Changing the Chat Input's node id or its stored `input_value` breaks the tweak key and the baseline.
- `tests/fixtures/flow-error-policy.ts` — `parseStreamEvents()`, reused to read the SSE bodies. Named here because it is imported for its parser, not for the gate it belongs to.
- `src/lfx/src/lfx/processing/process.py` — `process_tweaks`, `process_tweaks_on_graph`, `apply_tweaks_on_vertex`, `_resolve_tweak_policy`, `_refusal_reason`: the enforcement `#14538` added.
- `src/lfx/src/lfx/utils/flow_validation.py` — `is_protected_tweak_field()`, `is_tweak_refused_by_policy()`, `flow_declares_api_editable()`, `CODE_EXECUTION_COMPONENT_TYPES`, `CODE_EXECUTION_FIELD_NAMES`. The registry the spec pins; `PythonREPLComponent` or `global_imports` leaving it is exactly the regression to catch.
- `src/lfx/src/lfx/components/utilities/python_repl_core.py` — `get_globals()` (the sandbox namespace built from `global_imports`), `validate_code_safety()` (why inline `import` cannot substitute for the allow-list), `ensure_code_execution_enabled()`.
- `src/backend/base/langflow/main.py` — the app-level `TweakRefusedError` handler that produces the structured `422`, i.e. the shape `mode=sync` never reaches. The exception class itself lives in `lfx/exceptions/tweaks.py`, a module `#14538` **added on the `release-1.12.0` line and absent from upstream `main`** — measured: `404` on `main`, blob `e21fcaf833e7` on `release-1.12.0`, and `compare/main...4f3b9f3772` reports `diverged`. It is named in prose rather than cited as a dependency path because the guard resolves paths against `main` (#1298), and a path that is real on the line the nightly is cut from would otherwise fail a check whose purpose is to catch paths that are real nowhere. Its `refused` and `reason` fields are the text the stream-frame assertions match.
- `src/backend/base/langflow/api/v2/workflow_execution.py` — `POST /api/v2/workflows`: the `WorkflowRunRequest` schema (`mode`, `tweaks`), the sync response shape, the `except TweakRefusedError` re-raise at the graph-build seam, and where the streaming mode hands tweaks to the v1 build path.
- `src/backend/base/langflow/api/build.py` — `generate_flow_events` / `build_graph_and_get_order`: the graph-path call site, and the comment recording that a refusal there surfaces as a stream error event on an already-committed `200`.
- Upstream references: `langflow-ai/langflow#14538` (the change under test) and `#9319` (the original defect the floor exists for).
