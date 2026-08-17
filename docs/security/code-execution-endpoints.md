# Code Execution Endpoints — crafted payloads are validated, never executed

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates the two boundaries that keep **user-submitted Python from running on the code paths
that only claim to *inspect* it**:

- `POST /api/v1/validate/code` **statically** validates code — it parses and compiles, and never
  executes. This is the fix for `langflow-ai/langflow#13336` (GHSA-2wcq-pvw2-xh7v, landed in
  upstream #13696), which is the *same* defect first reported in 2023 as `#696`: `validate_code()`
  compiled **and `exec()`'d** every module-level `ast.FunctionDef`, and Python evaluates default
  argument expressions at definition time — so `def f(x=<anything>)` achieved arbitrary code
  execution during "validation", without the function ever being called.
- `POST /api/v1/custom_component` — which *does* execute posted code by design, that being the
  custom-component feature — is reachable only by an authenticated caller. This is the fix for
  `#7900` (GHSA-4xph-gxg8-rp48), where the route was unauthenticated and gave anonymous RCE.

The same endpoint being reported in **2023 and again in 2026** is the strongest recurrence signal
in the bug corpus, and it is the reason this spec exists: the 2026 report reproduced the 2023 PoC
almost verbatim.

### "Rejects" here means "refuses to execute", not "answers 4xx"

The checklist bullet says the endpoint *rejects* the payload. Measured on the nightly, the crafted
payload is **accepted and answered `200`** — with empty error lists, in milliseconds. That is the
fixed behaviour: static validation of syntactically valid code succeeds, and the security property
is the **absence of the side effect**, not a status code. A spec asserting `4xx` on
`validate/code` would fail on a healthy instance and pass on the vulnerable one (`#696`'s PoC is
explicit that the exploit returns `{"imports": {"errors": []}, "function": {"errors": []}}`).

So the payload is crafted to make execution *observable in the response itself*:

```python
def python_function(_probe=__import__("time").sleep(8) or 1 / 0) -> str:
    return "<sentinel>"
```

`sleep()` returns `None`, so the `or` always evaluates `1 / 0`. Evaluating that default argument
therefore costs 8 seconds **and** raises `ZeroDivisionError`. Two independent discriminators come
out of one request:

| | pre-fix (`exec`) | fixed (`compile` only) |
|---|---|---|
| `function.errors` | `["division by zero"]` — the old code caught the exec exception and appended it | `[]` |
| response time | ≥ 8 s | milliseconds |

The error list is the primary discriminator; the timing is what still catches a regression that
re-introduces `exec` but swallows the exception. `1 / 0` is **not** constant-folded at compile time
(measured: `compile()` succeeds and the endpoint answers with no errors), and it cannot be produced
by the imports checker, so `"division by zero"` in the response can only mean the expression ran.

### The control: the same string, three destinations

A clean, fast validation is only evidence if the payload is genuinely live code on this instance.
It is proven live by sending **the same string** to the endpoint that is *supposed* to execute it.
Measured on `1.12.0.dev30` (sleep 4 s in this table, 8 s in the spec):

| request | credentials | status | time | body |
|---|---|---|---|---|
| `POST /api/v1/validate/code` — crafted | Bearer | `200` | 0.05 s | `{"imports":{"errors":[]},"function":{"errors":[]}}` |
| `POST /api/v1/validate/code` — `def broken(:` | Bearer | `200` | 0.01 s | `function.errors: ["invalid syntax (<unknown>, line 1)"]` |
| `POST /api/v1/custom_component` — crafted | Bearer | **`400`** | **4.04 s** | `Error building Component: Error creating class. ZeroDivisionError(division by zero).` |
| `POST /api/v1/custom_component` — crafted | *none* | **`403`** | 0.01 s | `{"detail":"No authentication credentials provided"}` |
| `POST /api/v1/validate/code` — benign | *none* | **`403`** | 0.01 s | `{"detail":"No authentication credentials provided"}` |

Row 3 is the control: the identical string, sent to the build path, sleeps its full budget and
raises. Row 1's clean, instant answer therefore cannot be explained by an inert payload, by a
dead endpoint (row 2 still reports real syntax errors), or by the request never arriving.

### Where the UI actually calls each endpoint

Issue #1392 asks for the assertions to be anchored on "the custom-component code editor" as the UI
surface that calls `validate/code`. **It is not** — measured on `1.12.0.dev30` by reading the
frontend bundle and confirming live. The code-editor modal has two save paths and dispatches on
whether it is editing a **component's own source** or a **`CodeInput` field**:

- a node's source editor (`code-button-modal`) — on the **Custom Component** *and* on a built-in
  node such as Chat Input — posts to `POST /api/v1/custom_component`;
- a `CodeInput`-typed field's editor posts to `POST /api/v1/validate/code`.

The whole component catalog has exactly **one** `CodeInput` field: **Python Function**'s
`function_code` (`prototypes`, `legacy: true`, so it needs the sidebar Legacy toggle). That editor
is therefore the only UI surface in the product that reaches `validate/code`, and it is where
Test 1 is anchored. Anchoring Test 1 on the custom-component editor would have produced a spec
that never touches the endpoint named in the bullet — the `#1092` failure mode, one layer up.

This is also where the 4xx the issue predicts comes from, and why `page.allowHttpErrors()` is
required: the *build* endpoint answers `400` for the crafted payload (Test 2), driven from the UI.

If these tests fail: either the validation endpoint executes submitted code again (a remote code
execution reachable by any authenticated user, `#696` / `#13336`), or the build endpoint stopped
requiring credentials (`#7900`, anonymous RCE).

---

## Tags *(required)*

`@api` `@regression` `@components`

No **functional** tag applies: the tag table has no security area, and all three sibling specs
under `regression/security/` carry cross-cutting tags only (`credential-secret-exposure`,
`ssrf-url-validation`, `tweaks-injection`). `@api` marks the layer the verdict is read from (the
two endpoints' responses); `@components` marks the surface driven to get there (the node code
editor and the parameters-panel `CodeInput` editor), mirroring `ssrf-url-validation.spec.ts`'s
UI test. `@regression` is what the recurrence asks for.

**`@stable` is deliberately absent on the first delivery**, decided with the maintainer at SPECIFY.
The three sibling security specs shipped `@stable` on day one, but they are pure API (no browser,
~3 s); this one is UI-driven and adds two sidebar adds — the surface Langflow measurably drops
clicks on (#1301/#1304) — plus ~16 s of deliberate `sleep` budget that the control spends proving
the payload is live, for ~90 s total. It therefore takes a validation cycle in the normal lane
before being watched by `daily-stable.yml`; the checklist bullets ship as `[-]` (automated, needs
validation) and the promotion is a follow-up, not a spec-doc change. It is **not** `@destructive`:
every test creates its own flow via the API and deletes it id-scoped in `afterEach`.

---

## Step by step *(required)*

Three independent tests. Each creates its own flow through `POST /api/v1/flows/` (parallel-safe
unique name), drives the UI at `/flow/{id}`, and deletes that id in `afterEach`. No LLM, no
provider key.

**Shared payload** — one module-level function whose default argument both sleeps and raises,
built once with a per-run sentinel so a match can never be coincidental:

```python
def python_function(_probe=__import__("time").sleep(8) or 1 / 0) -> str:
    return "E2E-CODEEXEC-<unique>"
```

---

**Test 1 — the code editor's validation pass does not execute a crafted default-argument payload**
*(`@api @regression @components`)*

1. Create a flow via the API, `page.goto('/flow/{id}')`, wait for `sidebar-search-input`.
2. Enable the sidebar Legacy toggle (`addLegacyComponents`) — Python Function is `legacy: true` and
   is hidden from the sidebar without it.
3. `addComponentFromSidebar(page, "Python Function", "add-component-button-python-function")` — the
   shared primitive that repairs Langflow's swallowed sidebar add (#1301/#1304) — then wait for
   `title-Python Function`.
4. Click `codearea_code_function_code`, wait for `checkAndSaveBtn` and `.ace_editor`. Replace the
   scaffold through ACE's own API (`window.ace.edit(...).setValue(code, -1)`; `fill()` does not
   reach ACE) with the crafted payload.
5. Click `checkAndSaveBtn` and capture `POST /api/v1/validate/code`.
6. Assert on the response: status `200`; `function.errors` and `imports.errors` are both empty
   — the `ZeroDivisionError` never happened; and the response arrived in under 4 s — the 8 s
   `sleep` never ran either.
7. Assert on the UI: the modal closed (`checkAndSaveBtn` hidden) — the editor treated the code as
   valid, which is exactly what the pre-fix backend could not do, since it would have surfaced
   `division by zero` in an error toast and kept the modal open.
8. Assert the value persisted: poll `GET /api/v1/flows/{id}` until
   `template.function_code.value` contains the run's sentinel. This is the control that the click
   did something at all — a swallowed click would leave the stored code untouched and steps 6–7
   would be vacuous.

**Test 2 — the build endpoint refuses the same payload, surfaces the error, and leaves no partial
component** *(`@api @regression @components`)*

1. `page.allowHttpErrors()` — the build POST is driven into a `400` on purpose.
2. Create a flow via the API and open it; `addCustomComponent(page)` (the shared primitive with the
   swallowed-add repair). Wait for `title-Custom Component`.
3. Poll `GET /api/v1/flows/{id}` until the node is persisted, and record the stored
   `template.code.value` — the untouched scaffold.
4. Open `code-button-modal`, replace the scaffold through ACE with **the scaffold plus the same
   canary function**, and click Check & Save.
5. Capture `POST /api/v1/custom_component`; assert status `400`, that the response detail names
   `ZeroDivisionError` / `division by zero`, and that it took at least ~8 s. This is the control
   for Test 1: the identical expression, on the endpoint that is *meant* to execute posted code,
   both sleeps and raises.
6. Assert the failure is **visible to the user**: the modal stayed open and the error text is
   rendered in it — not a silent no-op.
7. Assert **no partial component was created**: the canvas still holds exactly one node, still
   titled `Custom Component`; and `GET /api/v1/flows/{id}` still returns the scaffold recorded in
   step 3, with the sentinel absent from `template.code.value`.

**Test 3 — both endpoints refuse an unauthenticated caller before executing anything**
*(`@api @regression`)*

Pure API, through Playwright's `request` fixture with no `Authorization` header (these calls do not
go through the page, so they are outside the fixture's HTTP monitor and need no
`allowHttpErrors()`).

1. `POST /api/v1/validate/code` with the crafted payload and no credentials → assert `401`/`403`,
   that the detail names the missing credentials, and that it answered in under 4 s.
2. `POST /api/v1/custom_component` with the same payload and no credentials → the same three
   assertions. This is `#7900`'s boundary: the payload is refused **before** the code is reached,
   which the timing is what proves.
3. Control, with the Bearer: `POST /api/v1/custom_component` with the **untouched scaffold** →
   `200`. Without it, step 2's `403` is ambiguous — an instance with
   `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` refuses *every* caller on that route with the same
   status (`"Custom component creation is disabled"`), which is why the detail string is asserted
   as well as the code.

---

## Validation criterion *(required)*

- **Test 1:** `POST /api/v1/validate/code` answers `200` with `imports.errors == []` and
  `function.errors == []`, in under 4 s; the editor modal closes; and the sentinel is readable in
  the saved flow's `template.function_code.value`. Any of `division by zero` in the response, an
  error toast, or a response slower than 4 s means the default argument was evaluated.
- **Test 2:** `POST /api/v1/custom_component` answers `400` naming `ZeroDivisionError`, after at
  least ~8 s; the modal stays open with the error rendered; the canvas still holds exactly one
  `Custom Component` node; and the flow's stored `template.code.value` is byte-identical to the
  scaffold recorded before the attempt, with the sentinel absent.
- **Test 3:** both unauthenticated calls answer `401`/`403` with a credentials-related detail, in
  under 4 s each, while the authenticated scaffold build answers `200`.
- Teardown leaves no flow behind:
  `GET /api/v1/flows/?remove_example_flows=true&header_flows=true` returns the same count before
  and after the file runs.

---

## What this test does not cover *(optional)*

- **`POST /api/v1/validate/prompt`** — the sibling route on the same router. It never compiled or
  executed anything, so it is not part of this defect class.
- **The `custom_component/update` route** (editing an already-built custom component). It shares
  `resolve_component_code_for_action` and `Component(_code=...)` with `custom_component`, and
  executes by the same design; the checklist bullet names the create route.
- **Whether executing posted code on the *build* path is itself acceptable.** It is the
  custom-component feature, gated by `LANGFLOW_ALLOW_CUSTOM_COMPONENTS` and by the catalog policy
  (`resolve_component_code_for_action`, which can restrict it to administrators). This spec asserts
  that path stays behind authentication, not that it stops executing.
- **The catalog-policy gates themselves** (`disabled` / `admin_only`): both answer `403` on the
  same routes, so a lane with custom components disabled would see Test 3's refusals for the wrong
  reason — which is why Test 3's control and detail-string assertions exist, and why the
  precondition below is explicit.
- **A file-write or network canary.** The payload proves execution by time and exception, both
  readable in the HTTP response. A file-write canary would have to be read back through
  `docker exec`, coupling the spec to the deployment shape (the same call
  `tweaks-injection.spec.ts` made about container logs).
- **Every other `exec` site in Langflow** — `eval_function`, `execute_function`,
  `prepare_global_scope` — reached from the run/build paths, which are covered by
  `security/tweaks-injection.spec.ts` for the tweaks entry point.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Superuser credentials (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) for `getAuthToken`.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` on the instance. With it `false`, both routes answer
  `403` for *every* caller, `sidebar-custom-component-button` is not rendered, and Test 2 could not
  run at all. Every CI lane and both start scripts set it (#668/#746).
- The **Python Function** component present in `GET /api/v1/all` (category `prototypes`,
  `legacy: true`). It is the only `CodeInput` field in the catalog and therefore the only UI caller
  of `validate/code`; the test fails naming it if it disappears, rather than skipping silently.
- No provider key and no model resolution — nothing here runs a flow.

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — Bearer for the flow API and Test 3's control.
- `tests/helpers/flows/create-flow.ts` / `delete-flow.ts` — per-test flow lifecycle (id-scoped
  cleanup).
- `tests/helpers/flows/add-component-from-sidebar.ts` — Test 1's add, including the swallowed-click
  repair (#1301/#1304).
- `tests/helpers/flows/add-custom-component.ts` — Test 2's add, same repair via
  `addCustomComponentFromSidebar`.
- `tests/helpers/flows/add-legacy-components.ts` — the sidebar Legacy toggle Python Function needs.
- `tests/fixtures/fixtures.ts` — `page.allowHttpErrors()` for Test 2's deliberate `400`.
- `src/lfx/src/lfx/custom/validate.py` — `validate_code()`: the compile-only loop that is the fix
  being pinned, and `create_class`/`prepare_global_scope`, the `exec` the build path still uses
  (the source of Test 2's `ZeroDivisionError`).
- `src/backend/base/langflow/api/v1/validate.py` — `POST /validate/code`: `CurrentActiveUser`
  (Test 3's boundary), `resolve_component_code_for_action` (the policy gate), and the
  `CodeValidationResponse` shape (`imports` / `function`) the assertions read.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /custom_component`: `CurrentActiveUser`,
  the `Component(_code=...)` build, and the `400` detail shape (`detail.error`, `detail.traceback`).
- `src/lfx/src/lfx/components/prototypes/python_function.py` — the Python Function component and
  its `function_code` `CodeInput`, the only UI caller of `validate/code`.
- Upstream references: `langflow-ai/langflow#696` (2023), `#13336` + fix `#13696`
  (GHSA-2wcq-pvw2-xh7v, 2026), `#7900` (GHSA-4xph-gxg8-rp48).
