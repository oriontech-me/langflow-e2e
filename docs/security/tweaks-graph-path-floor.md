# Tweaks — the protected-field floor on the graph run path

**Last validated:** Langflow 1.14.0.dev32 — the published `langflow==1.14.0.dev32` wheel (the distribution the VM daily installs), served locally with `--workers 1`; re-validated for #2504 after `mode=stream` changed its refusal shape (see **Measured contract**). Previously validated on Langflow 1.12.0.dev38 — manifest list shared by `:latest` and `:1.12.0.dev38` (verified identical), `linux/amd64` `sha256:5082eb1ecb056f94491c4debe25925be48948dabc15db7186eeeb9fe645021d0` (the image every CI lane pulls) / `linux/arm64` `sha256:5813e74988bf09fdfd6c16fd5aad39aae0099469907ec48d5e5625a3f9c66683` (the one this validation ran on, named because the arch is part of the measurement); upstream revision `814fbceeb1dd38d3e52f60ce1e638af6fb725ffe`. First validated on 1.12.0.dev37 (`sha256:b672ab7e…`, revision `50340f2a4322…`); the measured table below is unchanged between the two builds, re-measured for `mode=sync` on dev38.

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

**`@stable` was added in the validation cycle #1572 asked for, not in the first delivery.** PR #1571 shipped the file `@api @regression` only, which the repo's own mechanism turns into *no scheduled lane at all*: `daily-stable.yml` selects `--grep @stable` and `nightly.yml` has been dispatch-only since 2026-03, so the three tests ran only when `pr-validation.yml`'s impacted-specs gate happened to select them. The graph-path half of `langflow-ai/langflow#14538` — the half that closed a real bypass — was therefore watched by nothing, while the sync-endpoint sibling (`security/tweaks-injection.spec.ts`) was watched daily. The lane profile is why promotion needed no design change: pure API, no browser, no LLM, no provider key, no `@destructive` state, three tests in ~3 s on 1.12 (8–9 s on the 1.14.0.dev32 wheel served locally), and no failure mode that depends on a provider key or quota. Validated on the build in **Last validated** above — five consecutive `--workers=1 --retries=0` runs plus one default-parallel run (3 workers, one `beforeAll` per worker), 18/18 tests green, zero orphan flows left behind, and an executed force-fail for every assertion family — attribution, liveness, the sync `2xx` floor, and acceptance, the last of which takes a two-part mutation on the streaming surfaces for a reason recorded under **Validation criterion**.

**Test 1 lost `@stable` on 2026-11-19 and had it restored in the #2504 fix.** The VM daily's hard failure on 1.14.0.dev32 removed it (PR #2497, by hand because that lane's automatic removal was switched off, #2330); the failure was the refusal-shape change recorded under **Measured contract**, not a weakened floor, and the tag came back with the assertion that pins the new shape.

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

### What changed on 1.14.0.dev32 (#2504)

Re-measured on `langflow==1.14.0.dev32`, the build on which the `mode=stream` test went red on the VM daily of 2026-11-19 (3 of 3 attempts, `Expected: 200, Received: 422`; it had passed on dev31 the day before). Two cells of the table above changed, and both for the same reason:

| tweak on the interpreter node | `/api/v2/workflows` `sync` | `/api/v2/workflows` `stream` | `/api/v2/workflows` `background` |
|---|---|---|---|
| `global_imports: ["os"]` (protected) | `422` · `code: TWEAKS_REFUSED` · `fields: ["global_imports"]` | **`422` · `application/json` · `{"detail": {"error": "Refused tweaks", "code": "TWEAKS_REFUSED", "message": "The field is protected and keeps the value set by the flow author.", "fields": ["global_imports"]}}`** — no stream is opened | unchanged: `200` + the error frame on `GET /{job_id}/events` |
| `python_code` (protected) | `422` · `fields: ["python_code"]` | **`422`, same body with `fields: ["python_code"]`** | unchanged |
| `input_value` (benign control, chat flow) | `200`, applied | `200` · `text/event-stream`, applied, no error frame | `200`, applied |

**Cause: upstream `langflow-ai/langflow#16466`** (*"fix(api): stop v2 workflow runs at Human Input"*, merged into `release-1.14.0` on 2026-11-18, `79a10cf2ef`, first in `v1.14.0.dev32`). It adds `_reject_hitl_outside_background()` to `api/v2/workflow_validation.py` and calls it from both `run_sync_with_mapping` and `build_stream_response` **before the response is constructed**. To see whether a tweak adds a Human-in-the-Loop gate, it applies the tweaks to the graph data with `process.process_tweaks(...)` — and that is where the floor now refuses. Its own comment says so: *"A refused tweak raises TweakRefusedError here, as it would at run time"*. The exception therefore reaches the app-level handler in `main.py` while nothing has been sent, which answers the same structured `422` as `POST /api/v1/run`. The hook does not run for `mode=background`, so that surface is unchanged.

**The floor did not move** — the refusal still happens, it happens earlier, and no build runs at all. What changed is how it reaches the caller, and on both surfaces the change is towards the contract this file had been comparing them against: `sync` lost its generic `500` (the defect recorded below, fixed as a side effect), and `stream` now matches `POST /api/v1/run` exactly instead of reporting on an already-committed `200`.

**What this costs in coverage — Test 1 no longer reaches the graph path.** The pre-flight refuses with `process.process_tweaks`, the *payload*-path enforcement `security/tweaks-injection.spec.ts` already pins on `POST /api/v1/run`, and it refuses before the graph is built — so on `mode=stream` the graph-path enforcement `#14538` added (`process_tweaks_on_graph` in `api/build.py`) is now masked and cannot be reached from the API with a protected tweak. If that `build.py` filter regressed to filtering only `code` while the pre-flight stays, Test 1 would stay green. **Test 2 (`mode=background`, which the pre-flight does not touch) is now the only test in this file that exercises the graph-path refusal**; Test 1 pins how the stream surface reports a refusal, and that the floor holds on it end to end, not which layer enforces it.

**Test 1 now pins the up-front `422` and only that.** Accepting both shapes was weighed and declined: the daily runs the 1.14 nightly, where the old shape no longer occurs, and a test accepting either would stay green if the stream silently went back to committing a `200` before validating — a contract change this file exists to record. The `422` arrives through a side effect of a Human-in-the-Loop check rather than through a validation written for tweaks, which makes it easier to lose in a refactor; a red Test 1 is how that would be noticed. Test 3 (`sync`) is **unchanged**: it was written to stay green under both the `500` and the `422`, and it does.

The paragraphs below describe the 1.12 measurement and are kept as the record of why the file was shaped as it is.

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

Since 1.14.0.dev32 (#2504) this surface refuses **before** the stream is opened, so its refusal steps differ from Test 2's; the control step is shared.

1. `POST /api/v2/workflows` with `mode: "stream"` and `tweaks: { <pythonNodeId>: { global_imports: ["os"] } }`; assert `422` — the request is refused before any stream is committed.
2. Assert the JSON body's `detail.code` is `TWEAKS_REFUSED` and `detail.fields` names `global_imports` — the refusal is attributable, the same shape `POST /api/v1/run` returns.
3. Assert `WIDENED:` appears nowhere in the body: the sandbox was not widened. On this shape no build runs, so this is a guard against a future shape that runs and refuses late, not the causal probe it is on Test 2.
4. Repeat 1–3 for `python_code`, asserting `fields` names `python_code` and the caller's sentinel never appears.
5. **Control, same surface:** the benign `input_value` tweak on the chat flow answers `200` with an event stream, produces that value in the `add_message` text and emits **no** error frame. Without this, steps 1–4 pass equally well against an endpoint that refuses everything.

**Test 2 — `mode=background` refuses it too, and says so** *(`@stable @api @regression`)*

1. Submit with `mode: "background"` and the `global_imports` tweak; assert `200` and a `job_id` (the job is queued before the build runs).
2. Read `GET /api/v2/workflows/{job_id}/events` and assert an `event: "error"` frame whose serialized text names both `TweakRefusedError` and the refused key — the refusal is attributable, not a bare failure.
3. Assert `WIDENED:` appears nowhere in the events.
4. Repeat 1–3 for `python_code`, asserting the caller's sentinel never appears.
5. **Control:** the benign tweak produces its value and no error frame. Kept as its own test because `#14538` names both modes and they can regress independently.

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

Force-fail evidence for the #2504 re-validation, each mutation executed against `langflow==1.14.0.dev32` with `--retries=0` and reverted (the file restored byte-for-byte from a copy, then one final green run). Five consecutive `--workers=1 --retries=0` runs were green beforehand (3/3, 8–9 s each), and the instance's flow count was the same before and after.

| mutation | emulates | tests that failed, and on which assertion |
|---|---|---|
| the protected `global_imports` tweak replaced by a benign `sender_name` one | the floor stops refusing | 1 — the `422` assertion, `Received: 200` with an event stream; 2 — *"the refusal must be attributable on this surface"*; 3 — *"a refused global_imports tweak must not answer 2xx"* |
| the expected `fields` → `[field + "-x"]` | the refusal no longer names the key | 1 — *"and it must name the key it refused"* |
| the expected `code` → `TWEAKS_REFUSED_X` | the refusal is unattributable | 1 — *"the refusal must be attributable on this surface"* |
| the up-front `absent` sentinel → `Refused tweaks`, text the body carries | the refused request ran the injected code | 1 — *"the refused request must not have run the widened or injected code"* |
| the expected status `422` → `200` | the stream went back to committing before validating (the shape this file no longer accepts) | 1 — the status assertion, `Received: 422` |
| `CHAT_INPUT_NODE_ID` → an id no node has | the tweaks mechanism is dead | 1, 2 — *"tweaks must be alive on this surface"* |
| `REFUSAL_MARKER` → a string the frame does not carry | the background refusal is unattributable | 2 — *"the refusal must be attributable on this surface"*; Test 1 no longer reads that marker, by design |

On the up-front shape no build runs, so the causal `WIDENED:` probe has nothing to observe on Test 1: its `absent` check is shown to execute by the fourth row — which proves the assertion runs, not that it can detect a real acceptance on a shape that carries no program output — not by the two-part acceptance mutation in the 1.12 table above, which now applies to Test 2 only.

---

## What this test does not cover *(optional)*

- **`POST /api/v1/run/{flow_id}`** — owned by `security/tweaks-injection.spec.ts` and by #1566, which is adapting that file to the `422` contract this build returns. Covering it here would duplicate assertions across two files that must then change together. It is measured in the table above only as the reference the other surfaces are compared against.
- **`LANGFLOW_TWEAKS_POLICY` and the `api_editable` allowlist.** Measured working (above), so this is a lane decision and not a product question: the setting is instance-global, cannot be set from a test, and no lane starts a container with it — so a gated spec would `skip` on every lane the suite runs, which is the failure mode #1010 exists to prevent. It is a *coverable* surface awaiting a lane, and the exact refusal reasons are recorded here so that spec does not have to re-measure them.
- **The exact refusal shape on `mode=sync`** — `422` + `TWEAKS_REFUSED` + `fields`, as `POST /api/v1/run` returns. Measured as a generic `500` on 1.12 and as that `422` on 1.14.0.dev32 (#16466, above), and still deliberately not asserted: the dev32 `422` comes from a pre-flight check, not from the router's `except` ladder, so a flow that slips past the pre-flight would still land in the catch-all `500` — tightening Test 3 to the `422` would pin the side effect rather than the handler. Test 3 keeps passing under both.
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
- `src/lfx/src/lfx/exceptions/tweaks.py` — `TweakRefusedError` itself: its `refused` and `reason` fields are the text the stream-frame assertions match. It exists **only on `release-1.12.0`, not on upstream `main`** — measured 2026-08-25: `404` on `main`, blob `e21fcaf833e7` on `release-1.12.0`, `404` on `release-1.11.5`. `#14538` has not been merged back and the merge-back is sporadic (~1–2 months). Declaring it here is correct rather than risky: the guard resolves this section against `main` **and** the two newest release lines, so a path satisfied by only one side passes and is NAMED in a `::notice::` (#1574). The sibling `tweaks-injection.md` declares the same module for the same reason.
- `src/backend/base/langflow/main.py` — the app-level `TweakRefusedError` handler that produces the structured `422`, i.e. the shape `mode=sync` never reaches. The **path** resolves on every ref while the *handler inside it* is 1.12-only (`TweakRefusedError` appears 3 times on `release-1.12.0`, 0 times on `main`, measured 2026-08-25) — the general rule for this section: a resolved path is evidence that a **file** exists, never that the code is in it.
- `src/backend/base/langflow/api/v2/workflow_execution.py` — `POST /api/v2/workflows`: the `WorkflowRunRequest` schema (`mode`, `tweaks`), the sync response shape, the `except TweakRefusedError` re-raise at the graph-build seam, and where the streaming mode hands tweaks to the v1 build path.
- `src/backend/base/langflow/api/v2/workflow_validation.py` — `_reject_hitl_outside_background()` (#16466): the pre-flight that applies the tweaks with `process.process_tweaks` before a `sync` or `stream` response is built, which is why both surfaces answer the structured `422` on 1.14.0.dev32. The function exists only on `release-1.14.0` (measured 2026-11-19: 0 occurrences on `main` and `release-1.13.0`); the path resolves on all three.
- `src/backend/base/langflow/api/v2/workflow.py` — `run_sync_with_mapping` and `build_stream_response`, the two call sites of that pre-flight.
- `src/backend/base/langflow/api/build.py` — `generate_flow_events` / `build_graph_and_get_order`: the graph-path call site, and the comment recording that a refusal there surfaces as a stream error event on an already-committed `200`.
- Upstream references: `langflow-ai/langflow#14538` (the change under test) and `#9319` (the original defect the floor exists for).
