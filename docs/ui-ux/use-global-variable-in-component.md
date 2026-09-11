# Use Global Variable in Component (API key)

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev8`)

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

`@stable` `@release` `@workspace` `@regression`

`@stable` was added by #1788, after the validation the tag requires actually ran:
3/3 green in the inherited-spec triage table
(`docs/triage/inherited-spec-triage.md`), then a force-fail run per test and the
id-scoped flow cleanup. The promotion also **fixed a latent strict-mode defect the
table could not see** — see *The `.or()` gate was flaky by construction* below.
No lane selector is present, so the tag cannot silence the spec (#1010).

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
- **The secret-absence assertion is narrower than it reads.** `expect(page.getByText(sentinelValue)).toHaveCount(0)`
  matches **text nodes** only. The sentinel is typed into an `<input>`, and
  `getByText` never reads an input's `value`, so a leak of the resolved credential
  *into a field value* would not fail this. It is kept because it does cover the
  case that matters most here — the secret rendered as visible page text, e.g. in
  the bound-value badge or a tooltip — but "never leaks the secret" is not what it
  proves. Widening it would take a `toHaveValue`/`inputValue` assertion on the
  specific field, which is a separate piece of work.
- **Indirect mechanism justified:** in the auto-bound state the field's dropdown-trigger
  button (the next sibling of the badge wrapper) has its icon fail to render — an upstream
  Langflow gap — leaving it a zero-width/zero-height but fully attached, click-functional
  element. `toBeVisible()`/coordinate-based `click()` can't target a zero-box element, so
  the helper asserts `toBeAttached()` and fires `dispatchEvent("click")` (Playwright's
  documented geometry-independent click). The clean/empty-field path (no pre-existing
  variable, as on fresh CI) uses the normal visible `icon-Globe` + `.click()`.

---

## The `.or()` gate was flaky by construction *(optional)*

`createAndBindCredentialVariable` waits for "the variable is bound **or** it is
listed in the still-open dropdown" before binding. That was written as
`expect(boundValue.or(optionRow)).toBeVisible()`, which asserts more than it means:
`.or()` resolving to two elements is a **strict mode violation**, and the two states
are not mutually exclusive.

Measured on `1.13.0.dev8`, creating the variable from the field's own dropdown does
**both** — it auto-binds the variable *and* leaves the dropdown open listing it — so
the locator resolves to 2 elements and the assertion fails:

```
strict mode violation: ...getByText('gv-api-key-…').or(getByTestId('option-gv-api-key-…'))
resolved to 2 elements
```

2/2 red locally on the spec the triage table recorded 3/3 green: CI happened to poll
in the window where only the option row had rendered. This is a race, not a version
regression, and promoting it unchanged would have imported a flake into the daily.

Two changes fix it. The wait takes `.first()`, so it means "whichever of the two"
rather than "exactly one of the two exists". And the explicit bind is guarded on the
field **not** already showing the variable — clicking the option row of an
already-bound variable is a second toggle on the same value, which is how a passing
bind gets undone. After the fix: 2/2 green, and the real postcondition
(`boundValue` visible) is asserted unconditionally, unchanged.

---

## What the force-fail audit changed *(optional)*

#1788's force-fail run is the reason this spec grew an assertion, and the finding is
worth keeping rather than just the fix.

The test is titled *bind a **Credential** global variable*, and nothing in it verified
the type. Removing the `credential-tab` click — the one line whose comment claimed it
is what stops a **Generic** variable being created — left the test **green**: the
bound value the field renders is the variable **name**, which is identical either way.
A regression that made that tab write the wrong type would have gone unnoticed.

`expectCredentialVariable(request, varName)` now reads the variable back over
`GET /api/v1/variables/` and asserts `type === "Credential"`, because the type is not
rendered anywhere on the canvas once the variable is bound.

**The second half of that measurement corrected the spec's own comment.** With the
type assertion in place, removing the `credential-tab` click *still* passes on
`1.13.0.dev8`: opening "Add New Variable" from a `SecretStrInput`'s own dropdown
already creates a Credential. So the click is belt-and-braces, not the thing that
decides the type — the comment asserting otherwise was wrong, and is now corrected in
the spec.

The force-fail that does discriminate test 1 is creating and binding a
**differently-named** variable than the one the assertions name: both the bound-value
assertion and the type readback go red. For test 2 it is removing the autosave wait
before the reload, which confirms the persistence claim is real — the rehydrated node
comes back **without** the binding, so auto-bind does not silently rescue the
assertion.

---

## Flow cleanup *(optional)*

The `try/finally` deletes the global **variable**, and always did. It never deleted
the **flows**. Measured on 2026-09-10 against a purged instance, one run of this file
left **4** behind: `New Flow` and `Basic Prompting` (created by `awaitBootstrapTest`
→ `addFlowToTestOnEmptyLangflow` when the default project is empty), plus one blank
flow per test.

`trackCreatedFlows(page)` now captures every `POST /api/v1/flows/` → `201` the page
performs, and `afterEach` deletes exactly those ids. The variable deletion stays in
each test's own `finally`, since it is scoped to that test's `varName`.
