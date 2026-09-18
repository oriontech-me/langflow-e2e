# Spec: Check & Save of component code whose `import` cannot be resolved is refused, and the Code Modal names the missing module

**Test file:** `tests/tests-automations/regression/flow-functionality/generalBugs-shard-6.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

When a user saves component code through the node's **Code** editor, the frontend
posts it to `POST /api/v1/custom_component`, which builds the component on the
server. Before the class body is evaluated, `prepare_global_scope` resolves every
`import` in the code with `importlib.import_module`. An import naming a module the
server does not have must make the build fail, and that failure must reach the user
**before** the code is accepted:

1. the build is refused — `POST /api/v1/custom_component` answers **400**, and its
   `detail.error` names the missing module (`No module named '<module>'`);
2. the Code Modal renders that error in `title_error_code_modal`, so the user is told
   *which* module is missing;
3. the code is not accepted — the editor stays open (`checkAndSaveBtn` still
   visible), because the modal only closes on a successful build;
4. the canvas is unaffected — still exactly one node, still titled `Custom Component`.

**Premise, measured on `1.13.0.dev16`:** the refusal comes from
`lfx/custom/validate.py` → `prepare_global_scope` → `importlib.import_module` →
`ModuleNotFoundError`, wrapped as
`ValueError: Error creating class. ModuleNotFoundError(No module named '<module>')`,
and returned as `{"detail": {"error": "Error building Component: Error creating
class. ModuleNotFoundError(No module named '<module>').", "traceback": "…"}}`.

**Why this is not the same test as the code-execution one.**
`security/code-execution-endpoints.spec.ts` → *"the build endpoint refuses the same
payload and leaves no partial component"* asserts the same modal surface, but for a
`ZeroDivisionError` raised while the class body is **evaluated**. This test reaches a
different branch — **import resolution**, which runs before evaluation and whose
behaviour is platform-dependent upstream: on Windows, `prepare_global_scope` silently
skips missing C-extension modules so built-in components with platform-specific deps
can still render, and upstream's copy of this test skips on `win32` for that reason.
A regression that let that leniency apply on the server's platform would accept code
that can only fail later, at run time — and no other `@stable` test submits an import
that does not resolve.

---

## Tags

`@stable` `@release` `@regression` `@components` `@ui-ux`

`@regression` because it pins a general-bugs guard imported from upstream's own
suite; `@components` because it is component configuration on the canvas; `@ui-ux`
is the functional area (the Code Modal's error surface).

---

## Step by step

1. Create a blank flow over the API (`createFlow`) and open it by id
   (`openFlowById`); the id is deleted in `afterEach`, after leaving the editor
   with `unmountEditorForCleanup`.
2. Add a Custom Component with `addCustomComponent` (the sidebar's dedicated
   `sidebar-custom-component-button`, behind `ensureCustomComponentButton`); assert
   `title-Custom Component` is visible and the canvas holds exactly one node.
3. Open the node's code editor (`code-button-modal`) and wait for `checkAndSaveBtn`.
4. Replace the editor content with a complete, otherwise-valid component (the
   scaffold's own `lfx` imports) whose first line imports a module that exists in no
   image — a per-run name `e2e_missing_module_<unique>`, so the error can only be
   about this import and can be matched exactly.
5. Click **Check & Save** (`checkAndSaveBtn`), capturing the
   `POST /api/v1/custom_component` response.
6. Assert the validation criterion below.

The 400 is provoked on purpose, so the test declares it with `page.allowHttpErrors()`
and the fixture's advisory log stays trustworthy for every other spec (#1084).

---

## Validation criterion

| Claim | Observable |
|---|---|
| The build was refused | `POST /api/v1/custom_component` → **400** |
| The refusal is the missing import | its body contains `No module named '<module>'` for this run's module |
| The user is told which module | `title_error_code_modal` is visible and contains `<module>` |
| The code was not accepted | `checkAndSaveBtn` is still visible (the modal only closes on success) |
| The canvas is unaffected | exactly one `.react-flow__node`; `title-Custom Component` visible |

The test fails if an unresolvable import is accepted (the build answers 2xx and the
editor closes), if the refusal is about something other than the import (a mangled
paste reads as a `SyntaxError` instead), or if the modal shows no error or an error
that does not name the module.

---

## External dependencies

- `src/frontend/src/modals/codeAreaModal/index.tsx` — the Code Modal: posts the code
  (`validateComponentCode`), renders `error.detail.error` in `title_error_code_modal`,
  and closes only on success
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/custom_component`,
  which answers 400 with `{detail: {error, traceback}}` when the build raises
- `src/lfx/src/lfx/custom/validate.py` — `prepare_global_scope`, the import-resolution
  branch, and `create_class`, which wraps its failure as `Error creating class. …`
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` — with the image default (`false`) the
  sidebar button is not rendered and `POST /api/v1/custom_component` answers 403

---

## What this test does not cover

- A component whose code fails while the class body is **evaluated** — covered by
  `security/code-execution-endpoints.spec.ts` → *"the build endpoint refuses the same
  payload and leaves no partial component"*, which also asserts the persisted code is
  byte-identical after the refusal.
- The Windows leniency itself — the lanes run Linux containers.
- A module that is installed but fails while importing (an `ImportError` raised by the
  module's own code).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`
  (set by `scripts/start-langflow-docker.sh` and every CI lane). No provider key.

---

## Notes

- **Wave 9 T2 triage, issue #1908 — outcome PROMOTE.** Imported from upstream's own
  suite (`src/frontend/tests/extended/regression/`) with no doc and no cleanup;
  measured 3/3 green (`docs/triage/inherited-spec-triage.md`, T2 row for this file).
  DELETE was not available: no `@stable` test submits an import that does not resolve
  (see *Why this is not the same test* above).
- **The table's "3 backend errors" are one per run, not three per run.**
  `scripts/build-triage-table.mjs` sums the errors across the three measurement runs.
  Measured on `1.13.0.dev16`, each run logs exactly one: `POST
  /api/v1/custom_component?flow_id=…` → 400 carrying `ModuleNotFoundError(No module
  named 'pytorch')` — the error the test provokes on purpose. The promoted test now
  declares it with `page.allowHttpErrors()` instead of leaving it in the daily's
  advisory log.
- Hardening for the promotion: (a) the file went through `awaitBootstrapTest` +
  `blank-flow` and deleted nothing — **3 flows leaked per run** on an empty project
  (`New Flow`, `New Flow (2)`, `Basic Prompting`), read by diffing
  `GET /api/v1/flows/` around one run; it now creates exactly one flow over the API
  and deletes that id; (b) the bare `sidebar-custom-component-button` click became
  `addCustomComponent`, the shared swallowed-add repair (#1304); (c) the only
  assertion was `error.length > 20`, which any error at all satisfies — including a
  `SyntaxError` from a mangled paste — so the test could not tell *why* the build
  failed. It now asserts the 400, that the error names this run's module, and that
  the code was not accepted; (d) the code imported `langflow.custom` / `langflow.io`
  / `langflow.schema` alongside `pytorch`, so the day those aliases stop resolving
  the test would have kept passing on the wrong import. It now uses the scaffold's
  `lfx` paths and a per-run module name that no image can contain.
