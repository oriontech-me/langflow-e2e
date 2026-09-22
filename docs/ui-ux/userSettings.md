# Spec: User settings — renaming a global variable, creating a Langflow API key, the shortcut catalog by name, and returning to the flow from Settings

**Test file:** `tests/tests-automations/regression/ui-ux/userSettings.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates *(required)*

Four independent tests, each a user journey through **Settings** that no other
`@stable` spec covers end to end. Every one asserts the product's own record of
what happened (the request it sent, the value it wrote), not only what the page
happens to show.

1. **should interact with global variables** — a Generic global variable created
   from *Settings → Global Variables* with an **Apply To Fields** choice, then
   **renamed twice** from the *Update Variable* modal, then deleted from its row:
   - the create saves the chosen field (`default_fields`) and the table shows it
     in the *Apply To Fields* column;
   - each rename is a `PATCH` of the **same** variable id: the table shows the
     new name and no longer shows the old one;
   - deleting that row sends exactly **one** `DELETE`, for that id, and the row
     leaves the table.

   Renaming is the part nothing else covers: `global-variable-edit.spec.ts`
   edits a variable's *value*, and a rename that silently created a second
   variable, or left the old name behind, passes there.
2. **should see shortcuts** — *Settings → Shortcuts* lists every documented
   shortcut **by name**. `settings-navigation.spec.ts` asserts the catalog's
   size (≥ 27 rows) and that each row has a key binding; a shortcut renamed or
   swapped for another keeps that count and passes there, and fails here.
3. **should interact with API Keys** — a Langflow API key created from
   *Settings → Langflow API Keys*: the secret shown once is copied **verbatim**
   to the clipboard (it equals the `api_key` the create request returned), and
   the key is then listed under its name. `api-keys-timezone-display.spec.ts`
   creates its keys over the API; this is the only test of the UI creation path.
4. **should navigate back to flow from global variables** — opening Settings from
   a flow, moving to *Global Variables*, and pressing the page's back button
   returns to **that same flow**. The back button is `navigate(-1)`, so this
   holds only while moving between Settings sections *replaces* the history entry
   instead of pushing one; a push would send the user back to the previous
   Settings section.

---

## Tags *(required)*

| Test | Tags |
|---|---|
| should interact with global variables | `@stable` `@release` `@workspace` `@api` `@settings` |
| should see shortcuts | `@stable` `@release` `@settings` |
| should interact with API Keys | `@stable` `@release` `@api` `@settings` |
| should navigate back to flow from global variables | `@stable` `@release` `@workspace` `@settings` |

`@settings` is the functional area for all four. `@api` marks the two tests whose
verdict reads the REST requests the page sent; `@workspace` the two that manage
account-wide objects (a variable, a flow).

---

## Step by step

Tests 1–3 enter Settings from the home page through the profile menu
(`user-profile-settings` → `menu_settings_button`) and the Settings sidebar link,
after `page.goto("/")` and the attributed page-entry barrier on `mainpage_title`.
They deliberately do **not** use `awaitBootstrapTest`: on an empty project it
creates two flows (`New Flow`, `Basic Prompting`) that nothing here would delete.

### 1. should interact with global variables

1. Open *Settings → Global Variables*; the header `settings_menu_header` reads
   `Global Variables`.
2. *Add New* (`api-key-button-store`) → `generic-tab`; fill a unique name and a
   value; open *Apply To Fields* (`popover-anchor-apply-to-fields`) and pick the
   first field offered from `HCD Password`, `Wallet Password`,
   `SSL Certificate Password`, `AWS Session Token`. The list is deliberate: a
   variable's *Apply To Fields* is auto-applied to any component with that field
   placed while it exists, so it must name fields of components no other spec
   places (DataStax HCD, Oracle, IBM Db2, Amazon Bedrock — four distributions, so
   one packaging change cannot empty it). The inherited list started with three
   fields the 1.13 nightly no longer offers (`AgentQL API Key`, `AI/ML API Key`,
   `Apify Token`) and so landed on `Anthropic API Key`. The options arrive
   asynchronously — until the component catalog (`GET /api/v1/all`) loads, the
   modal offers a placeholder list (`System`, `System Message`, `System Prompt`) —
   so the choice waits for the real list, and a failure prints what was offered.
3. Save (`save-variable-btn`). The `POST /api/v1/variables/` answers `201`; its
   body carries the name and `default_fields: [<chosen field>]`. The id is
   recorded for cleanup.
4. The row renders (the grid is scrolled to it — ag-grid only renders the rows in
   its window, #1303) and its *Apply To Fields* cell reads the chosen field.
5. Twice: click the row → the *Update Variable* modal opens → enter a new unique
   name → `save-variable-btn`. The `PATCH /api/v1/variables/<id>` answers `200`
   with the new name and the **same** id; the table shows the new name and none
   of the previous one.
6. Tick that row's selection checkbox (never the header's) → `delete-row-button`.
   Exactly one `DELETE` is sent, to `/api/v1/variables/<id>`, and the row leaves
   the table.

### 2. should see shortcuts

1. Open *Settings → Shortcuts*; the header reads `Shortcuts`.
2. Read the grid's *Functionality* column (`.ag-row [col-id="display_name"]` —
   `.ag-row` keeps the header cell out) and compare it with the documented
   catalog, the 27 names the 1.13 nightly lists: `Parameters`,
   `Search Components on Sidebar`, `Minimize`, `Code`, `Copy`, `Duplicate`, `Docs`,
   `Changes Save`, `Save Component`, `Delete`, `Open Playground`, `Undo`, `Redo`,
   `Redo (alternative)`, `Group`, `Cut`, `Paste`, `API`, `Download`, `Update`,
   `Freeze`, `Flow Share`, `Play`, `Output Inspection`, `Tool Mode`,
   `Toggle Sidebar`, `AI Assistant`. Every one must be present; a shortcut added
   upstream does not fail the test, one removed or renamed does.

### 3. should interact with API Keys

1. Open *Settings → Langflow API Keys*; the header reads `Langflow API Keys`.
2. *Add New* (`api-key-button-store` — the same testid as the variables page) →
   fill the key name (`My API Key` placeholder) with a unique value → *Generate
   API Key* (`secret_key_modal_submit_button`). The `POST /api/v1/api_key/`
   answers `200` with an `id` (recorded for cleanup) and the secret `api_key`.
3. The generated-key field (`api-key-input`) holds exactly that `api_key` — the
   readiness gate for the copy, see *Notes* — then `btn-copy-api-key`: the
   `API Key copied!` toast, and `navigator.clipboard.readText()` equals the
   `api_key`.
4. Close the modal (`secret_key_modal_submit_button`, now *Done*); a
   `.ag-row [col-id="name"]` cell reads the key's name.

### 4. should navigate back to flow from global variables

1. Copy the `Basic Prompting` starter into a flow of this test's own over the API
   (`createFlowFromStarter`) and open it by id (`openFlowById`); the id is
   recorded for cleanup.
2. Profile menu → Settings; then the sidebar link *Global Variables*; the header
   reads `Global Variables`.
3. Press `back_page_button`: the URL is `/flow/<that id>` and the flow editor is
   mounted (`sidebar-search-input` visible).

---

## Validation criterion *(required)*

| Test | Claim | Observable |
|---|---|---|
| 1 | the create saved the field choice | `POST /api/v1/variables/` → `201`, body `name` = the entered name, `default_fields` = `[<chosen field>]` |
| 1 | the table reflects it | the row's name cell visible and its `default_fields` cell reads the chosen field |
| 1 | a rename renames, it does not create | each `PATCH /api/v1/variables/<id>` → `200`, body `id` unchanged and `name` = the new name; the new name visible in the grid, the old name count `0` |
| 1 | a row delete deletes that row only | the `DELETE` requests sent by the click are exactly `[/api/v1/variables/<id>]`; the last name's count in the grid `0` |
| 2 | the catalog is listed by name | every documented display name is among the `display_name` cells (missing names are listed in the failure) |
| 3 | the generated key is the one shown | `api-key-input` value = the `api_key` of the `POST /api/v1/api_key/` → `200` |
| 3 | the secret is copied verbatim | the `API Key copied!` toast, and clipboard text = that `api_key` |
| 3 | the key is listed | a `.ag-row [col-id="name"]` cell reads the entered name after the modal closes |
| 4 | back returns to the flow the user left | URL pathname = `/flow/<created id>` after `back_page_button`, and `sidebar-search-input` visible |

A test fails if a rename leaves the old name or creates a second variable, if the
field choice is not saved, if a row delete sends more than its own `DELETE`, if a
documented shortcut disappears or is renamed, if the copy button copies anything
but the generated key, or if the back button lands anywhere but the flow the user
came from.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/appHeaderComponent/components/AccountMenu/index.tsx`
  — `user-profile-settings`, `menu_settings_button`
- `src/frontend/src/pages/SettingsPage/index.tsx` — the Settings sidebar items and
  their routes; `PageLayout backTo={-1}`
- `src/frontend/src/components/core/sidebarComponent/index.tsx` — Settings sidebar
  links navigate with `replace`, which is what makes `navigate(-1)` leave Settings
- `src/frontend/src/components/common/pageLayout/index.tsx` — `back_page_button`
  calls `navigate(backTo)`
- `src/frontend/src/pages/SettingsPage/pages/GlobalVariablesPage/index.tsx` — the
  variables grid (`settings_menu_header`, `api-key-button-store`, row click opens
  *Update Variable*, `removeVariables` sends one `DELETE` per selected row)
- `src/frontend/src/components/core/GlobalVariableModal/GlobalVariableModal.tsx` —
  create is an upsert (`POST`), update is `PATCH` by id; `save-variable-btn`,
  `generic-tab`, *Apply To Fields* (`apply-to-fields`) options exclude fields
  another variable already holds
- `src/frontend/src/components/core/parameterRenderComponent/components/tableComponent/index.tsx`
  — the header checkbox selects **every** row (`headerCheckboxSelectionFilteredOnly`)
- `src/frontend/src/components/core/parameterRenderComponent/components/tableComponent/components/TableOptions/index.tsx`
  — `delete-row-button`
- `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/index.tsx` — the API keys
  grid (`[col-id="name"]`); its *Add New* lives in
  `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/components/ApiKeyHeader/index.tsx`
  (`api-key-button-store`)
- `src/frontend/src/modals/secretKeyModal/index.tsx` — key creation
  (`secret_key_modal_submit_button`; the save-it-now view renders before the
  create request answers, and `handleCopyClick` copies nothing while the key is
  empty) and
  `src/frontend/src/modals/secretKeyModal/components/content-render.tsx` —
  `api-key-input`, `btn-copy-api-key`
- `src/frontend/src/pages/SettingsPage/pages/ShortcutsPage/index.tsx` — the
  shortcuts grid, `display_name` column rendered through i18n
- `src/frontend/src/customization/constants.ts` — `customDefaultShortcuts`, the
  catalog; `src/frontend/src/locales/en.json` — the English display names
- `src/backend/base/langflow/api/v1/variable.py` — `POST`, `PATCH`, `DELETE`
  `/api/v1/variables/`
- `src/backend/base/langflow/api/v1/api_key.py` — `POST` / `DELETE`
  `/api/v1/api_key/`
- `src/backend/base/langflow/api/v1/login.py` and
  `src/backend/base/langflow/api/utils/mcp/agentic_mcp.py` — every `auto_login`
  re-creates the agentic variables (`AGENTIC_VARIABLES` in
  `src/lfx/src/lfx/services/settings/constants.py`); see *Notes*
- Browser clipboard permissions (`clipboard-read`, `clipboard-write`), granted in
  `playwright.config.ts`

---

## What this test does not cover

- Credential-type variables and their masking — `global-variables-crud.spec.ts`.
- Editing a variable's **value** — `global-variable-edit.spec.ts`.
- That a field chosen in *Apply To Fields* is applied to a component placed later
  — `use-global-variable-in-component.spec.ts`.
- The shortcuts' key bindings and their effect on the canvas —
  `settings-navigation.spec.ts`, `langflowShortcuts.spec.ts`,
  `settings-shortcuts-edit.spec.ts`.
- API key timestamps and expiry — `api-keys-timezone-display.spec.ts`; using a key
  to call the API — `api/flows/api-key-expiry-enforcement.spec.ts`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` with `LANGFLOW_AUTO_LOGIN=true`. No
  provider key; the `Basic Prompting` starter present (it ships with Langflow).

---

## Notes

- **Wave 9 T2 triage, issue #1909.** Inherited from upstream's suite with no doc
  and no cleanup, measured on `manual.yml` (`docs/triage/inherited-spec-triage.md`,
  the five T2 rows for this file): four tests 3/3 green, *should interact with
  global variables* 2/3. Outcomes: the four above **promoted**; *should see general
  profile gradient* **deleted** — its only checks were that the General page shows
  `General` and `Profile Picture`, which
  `settings-general-section.spec.ts` › *"Settings General section loads and shows
  its header"* (`@stable`) asserts with more (the Language group and its
  description). Despite its title it never looked at a gradient.
- **Why *should interact with global variables* was 2/3 — a test defect, not a
  product bug.** It ended by ticking the grid's **header** checkbox and deleting,
  then asserting `No data available`: it deleted **every** variable of the account
  and asserted the account had none. Langflow re-creates four variables on every
  login — `FLOW_ID`, `COMPONENT_ID`, `FIELD_NAME`, `ASTRA_TOKEN`
  (`initialize_agentic_user_variables`, called from `/api/v1/auto_login` and
  `/api/v1/login`) — and every other test's page load is a login. The failing
  measurement run (`34402161273`) shows exactly those four rows in the grid at the
  failure, and the other worker's next test started in the same second as the
  delete. Measured on `1.13.0.dev16`:
  - the untouched test, one worker, no concurrent login: **0/10** red;
  - one `auto_login` after deleting the four brings all four back (new ids);
  - the untouched test with a concurrent `auto_login` every ~0.1 s: **5/5** red
    at the same line with the same message, the grid holding exactly those four
    rows (`1 to 4 of 4`) — the CI failure, on demand;
  - the untouched test, one worker, **green** — and a variable created beforehand
    by someone else was deleted by it.

  The last point is the larger defect: a passing run deletes variables other tests
  are using, including the provider credentials `collect-models` saves as global
  variables (`OPENAI_API_KEY`, `GOOGLE_API_KEY`, …). It did so in the measurement
  itself: `Collect models` had saved the openai and google keys on that instance,
  and the failure snapshot of run `34402161273` lists only the four agentic rows.
  The rewrite deletes only its own row and its cleanup deletes only the ids it
  created. Under the same concurrent-login loop it is **3/3** green, and a variable
  created beforehand by someone else survives every run.
- **Leaks in the inherited file.** Measured on `1.13.0.dev16` by diffing the
  instance's user flows and API keys around two full runs of the file: from an
  **empty** project, **+3 flows** (`New Flow` and `Basic Prompting` from
  `awaitBootstrapTest`'s empty-project branch, `Basic Prompting (1)` from the
  back-navigation test) and **+1 API key**; from a populated project, **+1 flow**
  and **+1 API key** per run. The rewrite creates one flow (test 4, over the API)
  and one API key (test 3) and deletes both by id in `afterEach`, with the
  variable of test 1 — the same audit reads **0** flows and **0** API keys left
  after two runs from an empty project.
- ***should interact with API Keys* was 3/3 green in the measurement and 0/2 in
  those two local runs — a second race of the inherited test, not a product
  change.** *Generate API Key* switches the modal to the save-it-now view, copy
  button included, **before** the create request answers; the key only fills the
  field when it does, and `handleCopyClick` copies nothing — silently, no toast —
  while the key is still empty. The inherited test clicked copy as soon as the
  button was visible and then waited 30 s for a toast that could not come. On the
  failure the dialog shows the key in the field and the copy button focused: the
  click landed first. Waiting for the field to hold the key the request returned
  is what a user does (they cannot copy what they cannot see) and is the gate the
  rewrite uses.
- The inherited file slept 10 s in `beforeAll` and 10 s after every test (60 s per
  run); both sleeps are gone — nothing waited on them.
