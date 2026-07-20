# Global Variables — CRUD via the Settings page

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev49`)

---

## What this test validates *(required)*

Validates create/delete of global variables and the secrecy guarantee of
Credential-typed variables, all on the dedicated **Settings → Global Variables**
page (`/settings/global-variables`):

1. **Create Generic variable** — a Generic-type global variable created via
   "Add New" appears in the data table.
2. **Delete variable removes it from the list** — after creating a variable,
   selecting its row and clicking the bulk "Delete selected items" button
   removes it from the table.
3. **Credential variable value is hidden from the list** — after saving a
   Credential-typed variable, the entered value must not appear anywhere as
   visible text on the page; the table renders the value masked as `*****`.

If these break, users cannot manage global variables (API keys, shared values)
reused across components, or worse, secrets entered as Credential variables
become visible in the UI.

### dev49 — why the Settings page (not a component's Globe picker)

The earlier version created variables through an OpenAI node's `input_value`
global-variable picker (opened via the node's Globe icon). On dev49 that path
broke in two ways, so the tests were moved to the canonical Settings CRUD page:

- The picker **auto-applies** the created variable to `input_value`, so the
  name renders in **two** places (the field anchor
  `anchor-popover-anchor-input-input_value` and a `disabled-option-<name>`),
  breaking `getByText(name, { exact: true })` with a strict-mode violation.
- A **Credential** variable applied to `input_value` returns HTTP 400
  (`Cannot use a Credential-typed global variable in 'input_value'`), which the
  fixture's backend-error monitor fails on — the secrecy test could not run.
  A leaked Credential variable (from a failed UI teardown) also bound to the
  next test's node and cascaded 400s into setup timeouts — the real driver of
  the recurring #810 flake.

The Settings page has none of these hazards: a single-render data table
(`treegrid`), no node binding, no 400, and stable testids.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression`

---

## Step by step *(required)*

**Shared setup:** `page.goto("/settings/global-variables")`, then wait for the
always-present **"Add New"** button (`api-key-button-store`). The `treegrid`
does NOT render on an empty variable list, so it is not used as a readiness
gate.

**Shared create helper (`createVariable`):**
1. Click "Add New" (`api-key-button-store`).
2. Select the type tab (`generic-tab` / `credential-tab`) BEFORE filling.
3. Fill name (`Enter a name for the variable...`) and value
   (`Enter a value for the variable...`).
4. Click `save-variable-btn` and **wait for `POST /api/v1/variables/`** (the
   deterministic completion signal — no fixed timeout). Capture the created id
   from the response for API teardown.

**Test 1 — create Generic variable**
1. Setup → `createVariable({ type: "generic" })`.
2. Assert the name is visible in the `treegrid`.

**Test 2 — delete variable removes it from the list**
1. Setup → `createVariable({ type: "generic" })`, assert visible.
2. Delete is a bulk action: click the row's selection checkbox
   (`.ag-selection-checkbox`), then click `delete-row-button` ("Delete selected
   items", disabled until a row is selected).
3. Assert the name has `count() === 0` in the `treegrid`.

**Test 3 — Credential variable value is hidden from the list**
1. Setup → `createVariable({ type: "credential", value: SECRET-SENTINEL-… })`.
2. Sanity: assert the name is visible in the `treegrid`.
3. Critical: assert `getByText(sentinelValue)` (substring, no `exact`) has
   `count() === 0` — the value must not surface as rendered text anywhere
   (the table shows it masked as `*****`).

---

## Validation criterion *(required)*

- Variable name appears in the table after creation (Test 1).
- Variable name has count 0 after deletion (Test 2).
- Credential sentinel value has substring-text count 0 anywhere on the page
  after save (Test 3).

## Guarding against false positives *(how)*

- **Per-run unique names/sentinels** (`${Date.now()}`) — no cross-run residue
  can satisfy an assert.
- **Deterministic save** (`waitForResponse` on the create POST) — the list
  assertion never races an in-flight save.
- **API-id teardown in `afterEach`** — variables are deleted by the id captured
  at creation, never a UI trash click; this stops a failed teardown from
  leaking a variable that would poison later tests.
- **Force-failure checks** (CONTRIBUTING §2): create → assert a bogus name ⇒
  fails; delete → skip the delete click ⇒ count-0 assert fails; credential →
  expect the sentinel count 1 ⇒ fails (it is masked).

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/GlobalVariablesPage/` — the
  Settings Global Variables table and Add New dialog.
- `src/backend/base/langflow/api/v1/variable.py` — CRUD endpoints
  (`GET/POST/DELETE /api/v1/variables/`).
- `data-testid="api-key-button-store"` — "Add New" button.
- `data-testid="save-variable-btn"` — save button in the Add New dialog.
- `data-testid="delete-row-button"` — bulk "Delete selected items" button.

---

## What this test does not cover *(optional)*

- Creating/selecting a global variable from within a component field
  (the Globe picker) — a separate surface.
- Editing an existing variable's value (covered in `global-variable-edit.spec.ts`).
- The Credential test does not interact with the eye/show-value toggle or
  assert `type="password"` on the input — it only verifies the saved value
  never surfaces as visible text. Browser-level masking is out of scope.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No API key required — no component is added or run.
- Run with a single Langflow backend — under multi-container CPU saturation the
  Settings page setup can time out (cf. #833); this is environmental, not a
  test defect.

---

## Notes *(optional)*

- **#810 flake verdict (test-side, not a product regression):** the product
  correctly masks Credential values (verified: the table Value cell shows
  `*****`, the sentinel never renders). The recurring failure was the old
  component-picker approach leaking Credential variables on teardown failure,
  which 400'd subsequent setups. Moving to the Settings page + API-id teardown
  removes both the leak and the 400 cascade. No assert was weakened; `@stable`
  stays.
