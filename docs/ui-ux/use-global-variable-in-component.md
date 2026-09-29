# Use Global Variable in Component (API key)

**Last validated:** Langflow 1.13.x (`1.13.0.dev27`)

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
2. **Persistence** — the binding is saved with the flow and survives a full page
   reload: the rehydrated OpenAI node shows the `api_key` field still bound to the
   same variable name.

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
4. Assert the `api_key` field (`anchor-popover-anchor-input-api_key`) is visible — the
   node renders expanded, so there is nothing to open

**Opening the api_key variable dropdown (state-aware helper):**
The `api_key` field is a secret field (`SecretStrInput`). When a Credential variable
whose `default_fields` include "OpenAI API Key" already exists, Langflow **auto-binds**
it: the field renders a value badge (the variable name) and shows **no** Globe trigger.
The helper therefore: when the field's `icon-Globe` exists (scoped via the
`popover-anchor-input-api_key` input so the non-secret "OpenAI API Base" field's Globe is
never selected), click it; otherwise fire `dispatchEvent("click")` on the bound field's
dropdown trigger (see *Indirect mechanism justified* under Notes).

**Test 1 — bind a Credential variable to the API key field**
1. Run setup
2. Open the `api_key` variable dropdown (helper above) → "Add New Variable"
3. Create a Credential variable `gv-api-key-{timestamp}` with a distinctive secret
   sentinel value `SECRET-SENTINEL-{timestamp}` (switch to the `credential-tab` before save)
4. Wait for the variable to be either bound or listed as `option-gv-api-key-{timestamp}`
   in the still-open dropdown; click the option **only** when the field is not already
   bound (creating it from the field may auto-bind it)
5. Assert the field is bound: the variable **name** is displayed as the field's value badge
   (an `OptionBadge` rendered as `button "gv-api-key-{timestamp}"` inside the field)
6. Assert the secret sentinel value never appears as visible text anywhere on the page
   (`getByText(sentinel)` substring match → `toHaveCount(0)`)
7. Cleanup: delete the variable via `DELETE /api/v1/variables/{id}` in a `finally` block

**Test 2 — binding persists across reload**
1. Run setup, then drain the add-node autosave with a window longer than the
   instance's debounce (`waitForFlowSaveSettled(page, { quietMs: pendingSaveQuietMs() })`),
   so the save armed next cannot be the add-node one carrying pre-bind state
2. Arm `watchFlowSave(page)`, create + bind the Credential variable (same as Test 1),
   then await the save — it **fails** if no `PATCH /api/v1/flows/{id}` is issued
   within one debounce plus slack. The poll below would wait the save out too; the
   watch is kept for attribution, since "no PATCH was issued" names the cause
3. Poll the flow over `GET /api/v1/flows/{id}` until it holds exactly one `api_key`,
   equal to `{ value: <varName>, load_from_db: true }` — the **persistence** half
4. Detach the variable from auto-bind: `PATCH /api/v1/variables/{id}` with
   `default_fields: []`, then read it back as `[]` (see *Auto-bind rescues an unsaved
   binding* below for why the reload proves nothing without this)
5. `page.reload()`; assert the `api_key` field still shows the same variable name as
   its bound value — the **rehydration** half: with auto-bind detached, only the saved
   binding can put it there
6. Cleanup: delete the variable via `DELETE /api/v1/variables/{id}` in a `finally` block

---

## Validation criterion *(required)*

- **Test 1:** after selection, the `api_key` field displays the variable name as its
  bound global-variable value; the secret sentinel has visible-text count 0 on the page.
- **Test 2:** the bind produces a flow save whose stored `api_key` is
  `{ value: <varName>, load_from_db: true }`, and after a full page reload the
  `api_key` field is still bound to the same variable name. The two halves fail
  separately, so a red run says whether the **save** or the **render** broke.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/parameterRenderComponent/components/inputGlobalComponent/`
  — the input that renders global-variable options and performs selection/binding
  (`handleVariableSelect` sets `value=<name>`, `load_from_db=true`)
- `src/frontend/src/components/core/parameterRenderComponent/components/inputComponent/components/popover/index.tsx` — renders the option rows
  (`option-<name>` when selectable, `disabled-option-<name>` for Credential vars in
  non-secret fields) and the selected-value `OptionBadge`
- `src/frontend/src/hooks/flows/use-autosave-flow.ts` — the debounced autosave the
  reload depends on; its delay is `GET /api/v1/config.auto_saving_interval`
  (`src/lfx/src/lfx/services/settings/groups/ui.py` — the default is per release line:
  5000 ms on `release-1.13.0` since upstream #14903, 2000 there before it, and still
  1000 on `main` and `release-1.12.1` as of 2026-09-29)
- `src/backend/base/langflow/api/v1/variable.py` — global variable CRUD endpoints
  (`GET /api/v1/variables/` → `[{id, name, type, default_fields, ...}]`,
  `PATCH /api/v1/variables/{id}` — `include_in_schema=False`, the route the frontend's
  own upsert uses — and `DELETE /api/v1/variables/{id}`)

Confirmed testids (verified against the live DOM):
- `anchor-popover-anchor-input-api_key` — the api_key field wrapper (role=button); the
  bound value badge renders inside it, and the dropdown trigger of a bound field is the
  button in its parent's next sibling
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
- **Auto-bind on load:** a Credential whose `default_fields` names the field binds to it
  when the field is empty. Test 2 detaches the variable from it on purpose (#2098), so
  that behaviour is not asserted anywhere here.
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
assertion and the type readback go red. For test 2 it was, on `dev8`, removing the autosave wait
before the reload: the rehydrated node came back **without** the binding. On
`1.13.0.dev27` that only holds once auto-bind is detached — see the next section, which
also lists the two mutations that discriminate test 2 since #2098.

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

---

## The fixed 2 s wait lost its race with the autosave debounce (#2098) *(optional)*

Test 2 waited `page.waitForTimeout(2000)` for "the flow to autosave" and then
reloaded. On `1.13.0.dev27` it hard-failed 3/3 on the VM daily of 2026-09-29 with
`anchor-popover-anchor-input-api_key` **not found** after the reload — the field
itself absent, not merely unbound. (The daily recorded only that; what the canvas
held is from the local reproduction below.)

**Cause: an intentional upstream change, and a wait that was never a wait.**
Upstream #14903 (*multi-user editing safety*, merged 2026-09-28, first shipped in
`1.13.0.dev27`) raised `auto_saving_interval` from 2000 to **5000 ms** (its ADR-006:
autosave at 5 s with a 15 s ceiling, to cut false edit conflicts). The autosave is a
trailing debounce, so the `PATCH` is issued one interval after the **last** edit.
Reproduced locally on `1.13.0.dev27` (the spec: 1 passed / 1 failed, same error),
then measured against a blank flow with one OpenAI node: a reload 2 s
after the edit found **0 nodes** in the canvas and in `GET /api/v1/flows/{id}`, with
**no** `PATCH` issued; waiting 15 s showed the single `PATCH` go out ~5.0 s after
the edit, and the node survived the reload. Nothing about the binding itself changed
— the flow simply had not been saved yet.

The 2000 ms sleep was equal to the old debounce, so on `dev26` it had no margin to
speak of; why it passed there was not measured. The test now waits for the evidence
instead: `watchFlowSave` derives its deadline from the instance's own interval and
**fails** when no save appears, and the stored `api_key` is polled back before the
reload so a future red says whether the save or the render broke. The drain before
arming is insurance rather than a measured need — a save only *scheduled* at arming
merges into the bind's trailing debounce, and one *issued* before the bind would need
the bind to start more than one interval after the node add (0.6 s measured) — and the
poll covers the remaining case, where a pre-bind save satisfies the watch and the
bind's own save is still one debounce away.

### Auto-bind rescues an unsaved binding on `1.13.0.dev27`

Force-failing the fix exposed it. With **both** the save wait and the saved-flow read
removed — the shape of the original test, minus the 2 s sleep — test 2 still **passes**.
Instrumented on `1.13.0.dev27`: at the reload the stored `api_key` was
`{ value: "", load_from_db: false }` (unbound); after the reload the field rendered the
variable anyway, and ~4.6 s later a `PATCH` wrote the binding. The variable created
from the field carries `default_fields: ["OpenAI API Key"]`, so it is auto-bound when
the node loads; nothing was in `localStorage`, so it is not a restored draft.

So, as the test stood, the reload assertion could not tell "persisted" from
"auto-bound" — and for the same reason it would have stayed green if rehydration
**dropped** a saved binding, since the field's load-time effect
(`inputGlobalComponent/hooks.ts`, `useInitialLoad`) auto-binds a variable whose
`default_fields` names the field whenever the value is empty. The variable's
`default_fields` comes from `GlobalVariableModal`, which sends the referencing field
when the variable is created from it.

The test therefore detaches the variable before reloading (`default_fields: []` over
the API). That is also the stronger evidence for the mechanism: with it cleared, an
unsaved binding renders **unbound** after the reload, which rules out a restored draft
in any browser store. Test 2 no longer exercises auto-bind itself — that is product
behaviour worth its own assertion, not something to leave hiding the rehydration check.

Mutations measured on `1.13.0.dev27`, each isolated and reverted:

| Mutation | Result |
|---|---|
| Undo the binding (`remove-icon-badge`) before the save lands — a save happens, unbound | **red** at the poll (`Timeout 16500ms exceeded`) |
| Reload before the save (no watch, no poll), auto-bind detached | **red** after the reload: the node is there, the variable name is not |
| Not awaiting `watchFlowSave` alone | green — the poll waits out the debounce itself |
| Neither the save wait nor the poll, auto-bind **not** detached | green — the pre-fix shape; this is what the detach step exists to close |

Verdict: **product changed intentionally + test defect**; no upstream ticket.

**Known gap, tracked in #2107:** when `globalSetup` cannot read the interval, the
helpers fall back to `AUTOSAVE_INTERVAL_FALLBACK_MS = 3000`, now **below** the 5000 ms
this build ships, so `watchFlowSave` would fail at 4500 ms on a healthy save.
