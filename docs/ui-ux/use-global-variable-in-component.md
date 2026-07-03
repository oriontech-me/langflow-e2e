# Use Global Variable in Component (API key)

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that a Credential-typed global variable can be **selected and bound** to a
component's secret field (OpenAI `api_key`, a `SecretStrInput`) via the field's Globe
dropdown, and that the binding **persists across a page reload**.

This is the consumption side of global variables — distinct from the CRUD/secrecy
coverage in `global-variables-crud.spec.ts`, whose spec doc explicitly lists "using a
global variable inside a component" as out of scope. Closes QA-CHECKLIST.md §4.3
"Use global variable in component (API key)".

1. **Bind** — after creating a Credential variable, selecting it from the `api_key`
   field's Globe dropdown puts the field into "global variable" mode: the variable
   **name** is shown as the field's bound value, and the secret value entered at
   creation is never rendered as visible text.
2. **Persistence** — the binding survives a full page reload: reopening the OpenAI
   node shows the `api_key` field still bound to the same variable name.

If this breaks, users who store API keys as Credential global variables cannot wire
them into components, or the wiring silently drops on reload — forcing plaintext keys
typed directly into fields.

---

## Tags *(required)*

`@release` `@workspace` `@regression`

> `@stable` intentionally withheld until the full 7-step validation pipeline
> (typecheck, lint, run `--retries=0`, force-fail, `--trace=on`, backend-error audit)
> has been executed and the team has reviewed the spec.

---

## Step by step *(required)*

**Shared setup (both tests):**
1. Set viewport to 1920×1080 (the Globe dropdown/variable modal can overflow smaller screens)
2. Bootstrap app, create blank flow
3. Add the OpenAI component via sidebar hover + `add-component-button-openai`
4. Open the OpenAI node so the `api_key` field (`anchor-popover-anchor-input-api_key`) is visible

**Opening the api_key variable dropdown (state-aware helper):**
The `api_key` field is a secret field (`SecretStrInput`). When a Credential variable
whose `default_fields` include "OpenAI API Key" already exists, Langflow **auto-binds**
it: the field renders a value badge (the variable name) and shows **no** Globe trigger.
Clicking the field anchor switches it back to the editable input, which exposes the
`icon-Globe` trigger. The helper therefore: if the field's Globe is not visible, click
the anchor to reveal the editable input; then click the field's `icon-Globe` (scoped via
the `popover-anchor-input-api_key` input so the non-secret "OpenAI API Base" field's Globe
is never selected).

**Test 1 — bind a Credential variable to the API key field**
1. Run setup
2. Open the `api_key` variable dropdown (helper above) → "Add New Variable"
3. Create a Credential variable `gv-api-key-{timestamp}` with a distinctive secret
   sentinel value `SECRET-SENTINEL-{timestamp}` (switch to the `credential-tab` before save)
4. Back in the still-open dropdown, click `option-gv-api-key-{timestamp}` to **select/bind** it
5. Assert the field is bound: the variable **name** is displayed as the field's value badge
   (an `OptionBadge` rendered as `button "gv-api-key-{timestamp}"` inside the field)
6. Assert the secret sentinel value never appears as visible text anywhere on the page
   (`getByText(sentinel)` substring match → `toHaveCount(0)`)
7. Cleanup: delete the variable via `DELETE /api/v1/variables/{id}` in a `finally` block

**Test 2 — binding persists across reload**
1. Run setup + create + bind the Credential variable (same as Test 1)
2. Wait for autosave, then `page.reload()`
3. Reopen the OpenAI node
4. Assert the `api_key` field still shows the same variable name as its bound value
   (rehydrated from the saved flow — auto-bind never overrides an explicit binding)
5. Cleanup: delete the variable via `DELETE /api/v1/variables/{id}` in a `finally` block

---

## Validation criterion *(required)*

- **Test 1:** after selection, the `api_key` field displays the variable name as its
  bound global-variable value; the secret sentinel has visible-text count 0 on the page.
- **Test 2:** after a full page reload and reopening the node, the `api_key` field is
  still bound to the same variable name.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/parameterRenderComponent/components/inputGlobalComponent/`
  — the input that renders global-variable options and performs selection/binding
  (`handleVariableSelect` sets `value=<name>`, `load_from_db=true`)
- `.../inputComponent/components/popover/index.tsx` — renders the option rows
  (`option-<name>` when selectable, `disabled-option-<name>` for Credential vars in
  non-secret fields) and the selected-value `OptionBadge`
- `src/backend/base/langflow/api/v1/variable.py` — global variable CRUD endpoints
  (`GET /api/v1/variables/` → `[{id, name, type, ...}]`, `DELETE /api/v1/variables/{id}`)

Confirmed testids (verified against the live DOM):
- `anchor-popover-anchor-input-api_key` — the api_key field wrapper (role=button); click
  to switch an auto-bound field back to editable mode
- `popover-anchor-input-api_key` — the editable secret input (only present in edit mode)
- `icon-Globe` — opens the field's global-variable dropdown (scope via the field's input,
  because the non-secret "OpenAI API Base" field also renders an `icon-Globe`)
- `option-<name>` — a selectable variable row in the dropdown; clicking it binds the var
- `credential-tab` — switches the variable-creation modal to Credential type
- `remove-icon-badge` — unbinds the currently bound variable from the field

---

## What this test does not cover *(optional)*

- **Gating:** Credential variables appear disabled (with an explanatory tooltip) in
  non-secret fields — not exercised here.
- **Auto-cleanup:** deleting a bound variable clears the field — not exercised here.
- **Runtime resolution:** actually running the flow so the backend resolves the secret
  value from the variable — out of scope (no real API key, component is never run).
- CRUD and secrecy-in-list guarantees — covered by `global-variables-crud.spec.ts`.
- Editing an existing variable's value — covered by `global-variable-edit.spec.ts`.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- OpenAI component available in the sidebar
- No API key required — the component is added and configured but never executed

---

## Notes *(optional)*

- Selecting a global variable stores the variable **name** in the field (not the secret
  value) plus `load_from_db: true`; the real secret is resolved backend-side only at run
  time. The assertions therefore check for the variable **name** as the bound value and
  confirm the secret sentinel never surfaces as visible text.
- Credential variables are only selectable in secret fields (`SecretStrInput` /
  `MultilineSecretInput`). The OpenAI `api_key` field qualifies, which is why it is the
  chosen target.
- **Auto-bind:** a Credential variable whose `default_fields` include "OpenAI API Key"
  auto-binds to the field on node add (the field starts in badge mode with no Globe). The
  state-aware dropdown helper handles both the auto-bound and the empty (clean CI) states.
  This is also why the test binds to its **own** uniquely-named variable and asserts that
  exact name — it never depends on which variable (if any) the instance auto-bound first.
- `try/finally` cleanup deletes the created variable via the REST API (looked up by name),
  so it runs even when assertions fail mid-test, preventing cross-run pollution. Uses the
  `request` fixture with a Bearer token from `getAuthToken`.
- **Indirect mechanism justified:** in the auto-bound state the field's dropdown-trigger
  button (the next sibling of the badge wrapper) has its icon fail to render — an upstream
  Langflow gap — leaving it a zero-width/zero-height but fully attached, click-functional
  element. `toBeVisible()`/coordinate-based `click()` can't target a zero-box element, so
  the helper asserts `toBeAttached()` and fires `dispatchEvent("click")` (Playwright's
  documented geometry-independent click). The clean/empty-field path (no pre-existing
  variable, as on fresh CI) uses the normal visible `icon-Globe` + `.click()`.
