# Global Variable Edit (Settings page)

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev23`)

---

## What this test validates *(required)*

Validates the Global Variables management surface accessed via the Settings page (`/settings/global-variables`):

1. **Create a Generic global variable from Settings page** — a new Generic-type variable can be created via the "Add New" modal on the Settings page and appears in the ag-grid table. Distinct from `global-variables-crud.spec.ts`, which exercises the same creation flow via the Globe icon inside a canvas component. The Settings page is the discoverability path users follow when they want to manage variables independently of any flow.

2. **Edit existing global variable by clicking its row** — clicking a variable row in the ag-grid table opens the "Update Variable" modal; saving a new value shows the "updated successfully" toast. This is the only test covering the edit lifecycle (`PATCH /api/v1/variables/{id}`) — `global-variables-crud.spec.ts` covers create and delete only.

If these break, users either lose the Settings-page entry point to global variables (Test 1) or cannot update the value of a variable that already exists (Test 2 — they would have to delete and recreate it, which is destructive for credentials shared across flows).

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression`

### Flake history — #1235 (quarantine lifted, `@stable` restored 2026-08-11)

Test 2 failed the dailies of **2026-07-27** and **2026-08-03**: the row click never
opened the Update Variable modal, so the `Update Variable` heading assertion timed
out. Quarantined in PR #1236 (`test.fixme` + `@stable` removed).

**Root cause — PRODUCT defect, filed as [LE-2123](https://datastax.jira.com/browse/LE-2123).**
The RBAC foundations that landed on `release-1.12.0` (langflow#14215, `2e677bf843`)
wrap this page in a `PermissionsProvider`, and `canMutateVariable()` returns
`false` while `POST /api/v1/authz/me/permissions` is still loading — so
`onRowClicked` returns early and the click is **silently dropped**, with no
spinner, no disabled styling and no feedback of any kind. Normally a 1–2 s window;
one failed first call stretches it to ~31 s through the shared request wrapper's
5× exponential-backoff ladder, which is why it read as a flake. Evidence and the
503-injection repro: `docs/upstream-bugs/UPSTREAM-BUG-global-variables-permission-gate-dead-window.md`.

**Fixed upstream by langflow#14404** (*show Global Variables permission loading
state*, merged into `release-1.12.0` on 2026-08-05), which hides the table behind
a loading state instead of rendering rows that only look interactive.
Re-validated on `1.12.0.dev23`: 3 consecutive runs at `--workers=1 --retries=0`,
green, plus a force-fail of the heading assertion.

**Not this bug:** the recorded flake of `remove-provider-api-key.spec.ts:17` was
grouped into #1235 at triage and later shown to be a *test* defect (it reproduces
at ~75 % on a healthy build with the gate open). That half was fixed and restored
separately in #1276; only this spec traces to LE-2123.

---

## Step by step *(required)*

**Test 1 — create a Generic global variable from Settings page**

1. Navigate to `/settings/global-variables` (after `awaitBootstrapTest`)
2. Wait for `settings_menu_header` to be visible
3. Click `api-key-button-store` (the "Add New" button on this page)
4. Wait for `generic-tab` to be visible, then click it
5. Fill name placeholder with `test_create_var_{Date.now()}`
6. Fill value placeholder with `original_value`
7. Click `save-variable-btn`
8. Assert that a `.ag-cell-value` element containing the variable name (exact match) is visible within 10s
9. `afterEach` deletes the variable via `DELETE /api/v1/variables/{id}` to prevent state leakage across tests

**Test 2 — edit existing global variable by clicking its row**

1. Repeat Test 1 setup steps 1–8 to create a fresh variable
2. Click the variable row's `.ag-cell-value` element (exact name match)
3. Assert that the "Update Variable" heading is visible within 5s
4. Fill the value placeholder with `updated_value` (replaces the existing value)
5. Click `save-variable-btn`
6. Assert that text matching `/updated successfully/` is visible within 5s — this toast only renders when the `PATCH /api/v1/variables/{id}` returns 200 and the ag-grid table re-renders
7. `afterEach` deletes the variable via API

---

## Validation criterion *(required)*

- Test 1: the variable name appears as an exact match inside `.ag-cell-value` after save — proves both the `POST /api/v1/variables/` returned 200 AND the ag-grid table received the new row
- Test 2: the "Update Variable" heading is visible after the row click (proves the modal loads in update mode, not create mode), AND the "updated successfully" toast fires after save (proves the `PATCH /api/v1/variables/{id}` succeeded — the toast is only emitted on a 200 response, not on generic save attempts)
- Both tests rely on the modal save button having the `save-variable-btn` testid, which is the same testid used for both create and update (the modal heading is the only differentiator)
- All UI waits use `expect(...).toBeVisible({ timeout })` rather than `waitForTimeout` — no arbitrary sleeps remain

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/GlobalVariablesPage/` — global variables listing page and the Add New / Update modal; renames or layout changes here break the testids below
- `src/backend/base/langflow/api/v1/variable.py` — CRUD endpoints (`POST/PATCH/DELETE /api/v1/variables/{id}`); the success toast in Test 2 fires only when `PATCH` returns 200
- `data-testid="settings_menu_header"` — anchor used to confirm the Settings page loaded
- `data-testid="api-key-button-store"` — "Add New" button on the Global Variables Settings page (the testid name reflects the shared component originally built for API Keys)
- `data-testid="generic-tab"` — type selector inside the create modal; tests pin the Generic tab to keep them deterministic
- `data-testid="save-variable-btn"` — save button in both create and update modes
- `.ag-cell-value` — ag-grid cell selector used to locate the variable row; if the table is replaced by a different list component, both tests need rewriting

---

## What this test does not cover *(optional)*

- Creating a Credential-type variable via Settings — Test 1 deliberately pins the Generic tab; Credential creation + value hiding is covered by `global-variables-crud.spec.ts`'s third test (via the Globe icon path)
- Creating a variable via the Globe icon inside a component — covered by `global-variables-crud.spec.ts`
- Deleting a variable via the Settings page UI — `global-variables-crud.spec.ts` covers delete via the Globe icon. The Settings page delete affordance is not asserted here because the same backend `DELETE /api/v1/variables/{id}` is exercised in the `afterEach` cleanup of both tests, so the endpoint is exercised regardless
- Editing the variable name (not just the value) — out of scope; updates typically target values (e.g. rotating an API key)
- Using a global variable inside a component flow at runtime — out of scope (would require an LLM call)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key or LLM required (the tests only manipulate variables, never resolve them)
- Auth via the standard `getAuthToken` helper; cleanup runs even if the assertion fails

---

## When to review this test *(optional)*

- If the Add New / Update modal layout changes (new tabs, renamed buttons)
- If ag-grid is replaced by a different table component
- If `PATCH /api/v1/variables/{id}` stops emitting the "updated successfully" toast (a UI message rename also requires updating the regex in Test 2)

---

## Notes *(optional)*

- `afterEach` cleans up via `DELETE /api/v1/variables/{id}` (lookup by name through `GET /api/v1/variables/`). This is more reliable than UI-based cleanup because it survives mid-test failures (e.g. the modal failing to open leaves no variable to delete, and listing returns empty for that name)
- `Date.now()`-based naming guarantees no collision between parallel workers, which is important since this is a singleton Settings page (no per-flow scoping)
- The earlier `globalVariables.spec.ts` and `global-variable-remove.spec.ts` files were removed in this branch — both either duplicated `global-variables-crud.spec.ts` (Credential value hiding test, delete test) with worse selectors (`.isVisible()` without `expect`, `not.toBeNull()` on locators that are never null) or contained auto-skip patterns (`if (!hasBtn) return;`) that allowed the test to pass without exercising the behavior under test. The two unique behaviors they nominally covered (Settings-page create, edit) are now consolidated here with stable selectors and strict assertions
