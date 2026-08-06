# Global Variables — CRUD via the Settings page

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev16`)

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

### dev16 — why the row assertion scrolls, and why the list refetch is awaited (#1303)

The table is **ag-grid with row virtualization**, and a newly created variable
is appended at the **end** of the list. Once the list is longer than the
rendered window — measured at **18 rows** on the default 1280×720 viewport CI
also uses — the new row is in the grid's data model but **not in the DOM**, so
`getByRole("treegrid").getByText(name)` never becomes visible. Measured on
`1.12.0.dev16`: creates 1–11 satisfy the assert in ~106 ms each; the 12th (19th
row overall) burns the full 15 s with `rendered=18`, `row-index=[0..17]`,
`scrollHeight=798` against `clientHeight=324`. Scrolling `.ag-body-viewport` to
the bottom renders it (`row-index=[1..18]`, row found). **The test could
therefore fail against a perfectly healthy product**, purely as a function of
how many variables the account happens to hold — which is the shape of the
recurring flake #1303 was filed for (2026-07-15, 07-17, 08-05).

Two consequences, both encoded in the steps below:

- The row assertion **scrolls the grid to the end** before asserting, re-scrolling
  on each poll. This is what a user does; no assertion is weakened by it.
- `getByRole("treegrid")` reports `element(s) not found` for *both* "the row is
  below the fold" and "the grid has no rows at all", which is why the failure
  read as "the variable was never created". The create step now **waits for the
  `GET /api/v1/variables/` that carries the new name**, so the two states are
  separated at the point of failure: a missing refetch fails as a missing
  refetch, and only a row the frontend demonstrably received can fail as a
  rendering problem.

**Open, and deliberately not fixed here:** on the 2026-08-05 daily
(run 30997773754, shard 1) the failure was *not* virtualization. The captured
page snapshot shows ag-grid's `No Data Available` overlay — the grid held **zero**
rows for the full 15 s after a 201 create, with the modal already closed, the
backend measurably healthy across the whole window (liveness probes 2–45 ms;
nearest failed probe one minute earlier) and no HTTP error logged. That state
did not reproduce on `1.12.0.dev16` in 22 attempts (10 normal + 12 under 8×
CPU throttling) with the list forced empty at page load. It remains unexplained;
the awaited refetch above exists so the next occurrence names its own cause
instead of being absorbed into this one. Tracked on #1303.

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
4. Arm two waiters **before** clicking save, so neither can be missed:
   `POST /api/v1/variables/`, and the `GET /api/v1/variables/` **whose payload
   contains the new name** (the list the grid renders from).
5. Click `save-variable-btn`.
6. Assert the POST returned **201** and a non-empty `id`; capture the id for API
   teardown. A non-2xx create fails here, naming the status — it is no longer
   swallowed into a 15 s wait on a row that was never created.
7. Await the list response. If it never arrives the test fails as *"the
   variables list was never refetched with `<name>`"*, which is a different
   verdict from a row that failed to render.

**Shared row helper (`revealVariableRow`)** — scrolls `.ag-body-viewport` to the
bottom (where a newly appended row lives) and re-scrolls on every poll, then
returns the `treegrid` cell locator for the name. Defeats row virtualization
without weakening what is asserted; see the dev16 note above.

**Test 1 — create Generic variable**
1. Setup → `createVariable({ type: "generic" })`.
2. `revealVariableRow` → assert the name is visible in the `treegrid`.

**Test 2 — delete variable removes it from the list**
1. Setup → `createVariable({ type: "generic" })`, reveal + assert visible.
2. Delete is a bulk action: click the row's selection checkbox
   (`.ag-selection-checkbox`), then click `delete-row-button` ("Delete selected
   items", disabled until a row is selected).
3. Wait for the `GET /api/v1/variables/` whose payload **no longer contains**
   the name — the backend-side proof of removal, symmetric with step 1.
4. Assert the name has `count() === 0` in the `treegrid`. On a virtualized grid
   a count of 0 is also what an off-screen row yields, so step 3 is what makes
   this assertion mean "deleted" rather than "not rendered".

**Test 3 — Credential variable value is hidden from the list**
1. Setup → `createVariable({ type: "credential", value: SECRET-SENTINEL-… })`.
2. Sanity: `revealVariableRow` → assert the name is visible in the `treegrid`.
   This gate is load-bearing: the leak assertion in step 3 passes trivially on a
   page that renders no variable at all, so it must not run until the row is
   provably on screen.
3. Critical: assert `getByText(sentinelValue)` (substring, no `exact`) has
   `count() === 0` — the value must not surface as rendered text anywhere
   (the table shows it masked as `*****`).

---

## Validation criterion *(required)*

- The create returns **201** with an `id`, and a subsequent
  `GET /api/v1/variables/` carries the new name (all three tests).
- Variable name appears in the table after creation, with the grid scrolled to
  where the row lives (Test 1).
- A `GET /api/v1/variables/` after the delete no longer carries the name, and
  the name has count 0 in the table (Test 2).
- Credential sentinel value has substring-text count 0 anywhere on the page
  after save, asserted only once the row is provably on screen (Test 3).

## Guarding against false positives *(how)*

- **Per-run unique names/sentinels** (`${Date.now()}`) — no cross-run residue
  can satisfy an assert.
- **Deterministic save** (`waitForResponse` on the create POST) — the list
  assertion never races an in-flight save.
- **A failed create fails as a failed create** — the POST status is asserted
  (201 + `id`) instead of being swallowed by `.catch(() => {})`, so a create
  that never happened cannot be reported as a row that never rendered.
- **The row assert cannot pass or fail on grid geometry** — the grid is scrolled
  to the appended row on every poll, so neither result depends on how many
  variables the account holds (#1303).
- **API-id teardown in `afterEach`** — variables are deleted by the id captured
  at creation, never a UI trash click; this stops a failed teardown from
  leaking a variable that would poison later tests.
- **Force-failure checks** (CONTRIBUTING §2): create → assert a bogus name ⇒
  fails; delete → skip the delete click ⇒ count-0 assert fails; credential →
  expect the sentinel count 1 ⇒ fails (it is masked). For the #1303 mechanisms:
  removing the scroll from `revealVariableRow` ⇒ the row assert fails once the
  account holds more than the rendered window; accepting a non-201 create ⇒ the
  create assert stops firing.

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

- **#1303 flake verdict (test-side for the reproduced mechanism; one CI
  observation still open):** ag-grid row virtualization makes the row assertion
  depend on the account's variable count — reproduced deterministically on
  `1.12.0.dev16` and fixed by scrolling to the appended row. The 2026-08-05
  daily failure is a *different* state (grid with zero rows, healthy backend)
  that does not reproduce and is not explained by this change; the awaited list
  refetch is there so it reports itself distinctly rather than being absorbed.
  `@stable` is restored for the reproduced defect, not for the open one — see
  the dev16 section above and #1303.
- **Relationship to #1235** (same surface, kept separate): #1235 is a row
  *interaction* that does not produce its state (the edit modal never opens, the
  delete button never enables) — rows are present and a click is ignored. #1303
  is one step earlier: no interaction has happened and the row itself is not in
  the DOM. The mechanism found here (virtualization on append) cannot produce
  #1235's symptoms, since those specs act on rows they already located. Kept
  separate; revisit only if #1235's investigation lands on a shared refresh
  mechanism.
- **#810 flake verdict (test-side, not a product regression):** the product
  correctly masks Credential values (verified: the table Value cell shows
  `*****`, the sentinel never renders). The recurring failure was the old
  component-picker approach leaking Credential variables on teardown failure,
  which 400'd subsequent setups. Moving to the Settings page + API-id teardown
  removes both the leak and the 400 cascade. No assert was weakened; `@stable`
  stays.
