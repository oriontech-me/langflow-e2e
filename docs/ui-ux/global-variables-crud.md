# Global Variables — CRUD via Component

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the Global Variables modal that opens from an OpenAI component's Globe icon, covering create and delete operations and the secrecy guarantee of Credential-typed variables:

1. **Create Generic variable** — a Generic-type global variable can be created via "Add New Variable" and appears in the variable list.
2. **Delete variable removes it from list** — after creating a variable, deleting it with the Trash2 icon removes it from the list entirely.
3. **Credential variable value is hidden from the variable list** — after saving a Credential-typed variable, the entered value must not appear anywhere as visible text on the page (list, toast, preview); only the variable name is rendered.

If these break, users cannot manage global variables (API keys, shared values) that are reused across components, or worse, secrets entered as Credential variables become visible in the UI.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression`

---

## Step by step *(required)*

**All three tests share the same setup:**
1. Set viewport to 1920×1080 (modal can overflow on smaller screens)
2. Bootstrap app, create blank flow, add OpenAI component
3. Click the OpenAI component header, then click the Globe icon
4. Wait for Global Variables modal to open

**Test 1 — create Generic variable**

1. Run setup
2. Click "Add New Variable" via JS evaluate (button may be off-screen)
3. Fill variable name with `test-generic-{timestamp}`
4. Assert "Generic" type label is visible
5. Fill value with `generic-value-123`
6. Click "Save Variable"
7. Assert variable name appears in the list
8. Cleanup: delete the variable in `finally` block if visible

**Test 2 — delete variable removes it from list**

1. Run setup
2. Click "Add New Variable" via JS evaluate
3. Fill name `delete-me-{timestamp}`, fill value `to-be-deleted`
4. Click "Save Variable", assert variable is visible
5. Click Trash2 icon, confirm "Delete"
6. Assert variable name has `count() === 0` in the list
7. Cleanup: delete in `finally` if `varCreated` flag is still true

**Test 3 — Credential variable value is hidden from the variable list**

1. Run setup
2. Click "Add New Variable" via JS evaluate
3. Fill name `credential-{timestamp}`
4. Click `credential-tab` — the modal opens on the Generic tab by default; this switches it to Credential before save
5. Fill value with a distinctive sentinel `SECRET-SENTINEL-{timestamp}`
6. Click "Save Variable"
7. Sanity: assert variable name is visible in the list
8. Critical: assert `getByText(sentinelValue)` (substring match, no `exact`) has `count() === 0` — the value must not surface anywhere as rendered text, including embedded inside a toast, label, or preview
9. Cleanup: delete in `finally` if `varCreated` flag is still true

---

## Validation criterion *(required)*

- Variable name appears in list after creation (Test 1)
- Variable name has count 0 after deletion (Test 2)
- Credential value (sentinel) has substring-text count 0 anywhere on the page after save (Test 3) — `getByText(sentinelValue)` without `exact: true`, so embedded occurrences inside longer messages also fail the test

---

## External dependencies *(required)*

- `src/frontend/src/components/core/parameterRenderComponent/` — Globe icon triggering the global variables modal
- `src/backend/base/langflow/api/v1/variable.py` — CRUD endpoints
- `data-testid="icon-Globe"` — Globe icon on OpenAI component
- `data-testid="icon-Trash2"` — delete button in the variables list

---

## What this test does not cover *(optional)*

- Using a global variable inside a component (auto-fill behavior)
- Editing an existing variable's value (covered in `global-variable-edit.spec.ts`)
- Deletion via the Settings page (covered in `global-variable-remove.spec.ts`)
- The Credential test does not interact with the eye/show-value toggle or assert that the input field is rendered with `type="password"` — it only verifies that the saved value never surfaces as visible text. Browser-level masking and toggle UX are out of scope.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- OpenAI component must be available in the sidebar
- No API key required — component is added but never run

---

## Notes *(optional)*

- `page.evaluate()` is used to click "Add New Variable" because the modal can render outside the viewport on smaller screens. The JS click bypasses the viewport boundary.
- `try/finally` cleanup ensures variables are deleted even when assertions fail mid-test — preventing test pollution between runs.
