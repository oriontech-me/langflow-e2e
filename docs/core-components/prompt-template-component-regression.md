# Prompt Template Component — Regression

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the **Prompt Template** component end-to-end via 6 scenarios:

1. **Canvas rendering** — the node renders on a blank flow with the correct `prompt` output handle.
2. **Dynamic input handles from `{variable}` placeholders** — typing `{name}` and `{profession}` in the template creates one input handle per placeholder, named after the variable.
3. **Removing a variable removes its handle** — replacing `Hello {name}!` with `Hello world!` drops the `name` handle and decreases the total handle count.
4. **Replacing a variable updates handles in place** — switching `{role}` for `{title}` while keeping `{name}` causes the old handle to disappear and the new one to appear.
5. **Clearing all variables removes every dynamic handle** — replacing `{a} and {b} and {c}` with a variable-free string drops the dynamic handle count to zero.
6. **Modal persistence (UI + backend)** — text entered in the prompt modal and saved via `genericModalBtnSave` is still present (in the sanitized preview and in the textarea after re-entering edit mode) when the modal is reopened, **and** the autosaved flow at `GET /api/v1/flows/{id}` contains the same string in `node.data.node.template.template.value` for the Prompt Template node.

If any of these tests fails, the Prompt Template component is broken in one of its core contracts: rendering on the canvas, the regex that extracts `{variable}` placeholders from the template, the dynamic handle generation, or the modal's save-and-persist flow.

---

## Tags *(required)*

All 6 tests: `@stable` `@release` `@regression` `@components`

---

## Step by step *(required)*

Every test starts with `addPromptComponent(page)` which:
1. Bootstraps the app (`awaitBootstrapTest`)
2. Clicks `blank-flow`
3. Fills `sidebar-search-input` with `prompt` and waits for `add-component-button-prompt-template`
4. Clicks the add button
5. Calls `adjustScreenView(page)`
6. Asserts exactly one node is on the canvas

Tests 2–6 use the helper `setPromptTemplate(page, value)` which:
1. Clicks `button_open_prompt_modal`
2. If the sanitized preview `edit-prompt-sanitized` is visible (post-save state), clicks it to re-enter edit mode
3. Waits for the textarea `modal-promptarea_prompt_template` (unique to the prompt modal, used as anchor instead of `[role="dialog"]`) to be visible
4. Selects all in the textarea (`Ctrl+A`) and fills `value`
5. Clicks `genericModalBtnSave` and waits for the textarea testid to be hidden — that disappearance is the reliable signal that the modal closed. Downstream assertions then auto-retry on the expected handle state.

### 1. `renders on canvas with output handle`
- Asserts `title-Prompt Template` is visible.
- Asserts the right-side `handle-prompt template-shownode-prompt-right` handle is visible.
- Asserts exactly one node on the canvas (`react-flow__node` count === 1).

### 2. `variables in curly braces generate dynamic input handles`
- Calls `setPromptTemplate` with `Hello {name}, your job is {profession}.`.
- Asserts both `handle-prompt template-shownode-name-left` and `handle-prompt template-shownode-profession-left` are visible.
- Asserts the dynamic-handle locator (`-shownode-*-left` only) has count exactly 2 — sanity check that no extra handles leaked in.

### 3. `removing a variable removes its input handle`
- Sets the template to `Hello {name}!` and asserts the `name` handle is visible and the dynamic-handle count is exactly 1.
- Sets the template to `Hello world!`.
- Asserts the `name` handle has zero matches and the dynamic-handle count is exactly 0.

### 4. `replacing a variable updates handles accordingly`
- Sets the template to `Hello {name}, you are {role}.` and asserts both `name` and `role` handles are visible.
- Sets the template to `Hello {name}, you are {title}.`.
- Asserts `name` is still visible, `role` has zero matches, and `title` is visible.

### 5. `clearing the template removes all dynamic handles`
- Sets the template to `{a} and {b} and {c}` and asserts the dynamic-handle count is exactly 3.
- Sets the template to `No variables here.`.
- Asserts the dynamic-handle count is exactly 0.

### 6. `modal edits persist in UI and in saved flow`
- Sets the template to `Persisted prompt text {topic}.` via `setPromptTemplate`.
- Asserts `handle-prompt template-shownode-topic-left` is visible (confirms save succeeded).
- **UI layer:** reopens the modal, asserts `edit-prompt-sanitized` contains the saved text, clicks the preview to re-enter edit mode, asserts the textarea has the exact saved value via `toHaveValue`.
- **Backend layer:** extracts the flow id from the URL, then polls `GET /api/v1/flows/{id}` via `page.request` (inherits session cookies — the endpoint requires session auth) until the Prompt Template node's `template.template.value` equals the saved string. Catches regressions where the modal shows the value but autosave does not flush it to the database.

---

## Validation criterion *(required)*

- `title-Prompt Template` is visible after adding the component to a blank flow
- The right-side output handle `handle-prompt template-shownode-prompt-right` is visible
- For each `{variable}` saved in the template, a corresponding left-side handle `handle-prompt template-shownode-{variable}-left` is rendered
- Removing a `{variable}` from the template removes the corresponding handle
- Replacing one variable with another removes the old handle and creates a new one
- Saving a template via `genericModalBtnSave` makes the value retrievable on the next modal open — both in the sanitized preview and in the textarea after re-entering edit mode
- The autosaved flow at `GET /api/v1/flows/{id}` contains the saved template string at `node.data.node.template.template.value` for the Prompt Template node

---

## External dependencies *(required)*

- `src/frontend/src/modals/promptModal/` — `genericModalBtnSave` button, `edit-prompt-sanitized` preview, and the textarea that holds the editable template; changes here break tests 2–6
- `src/frontend/src/components/core/parameterRenderComponent/components/promptComponent/` — `button_open_prompt_modal` trigger on the node inspector; breaks tests 2–6
- `src/lfx/src/lfx/interface/utils.py` — `extract_input_variables_from_prompt()`: derives the variable list from the template string using Python's `string.Formatter().parse()` (not a regex); breaks tests 2–5
- `src/lfx/src/lfx/base/prompts/api_utils.py` — `validate_prompt()` and `_check_input_variables()`: validation layer around the extracted variables; breaks tests 2–5
- `src/lfx/src/lfx/components/models_and_agents/prompt.py` — `PromptComponent` definition (`display_name="Prompt Template"`, template field) and `update_build_config()` that synchronizes template ↔ input fields; breaks tests 2–6 and the backend assertion in test 6
- `src/frontend/src/CustomNodes/GenericNode/` — dynamic handle rendering for `handle-{component}-shownode-{var}-left`; breaks tests 1–5
- `GET /api/v1/flows/{id}` — flow read endpoint backing the autosave round-trip; the response shape `data.nodes[].data.node.template.template.value` is what test 6 asserts. A rename of the inner `template.template` nesting, or a change to `node.data.type` away from `"Prompt Template"`, breaks the backend assertion.

---

## What this test does not cover *(optional)*

- Prompt rendering/execution behind an LLM (covered by `llm-agents` specs such as `memory-history-regression.spec.ts`)
- Tool Mode interaction (covered by `tool-mode.spec.ts`)
- Cross-component data flow (covered by `flow-functionality/` specs)
- Invalid-character rejection in variable names (e.g. `{var.attr}`, `{var name}`, `{1var}`), the empty-braces contract, and variable deduplication (covered by `prompt-template-invalid-patterns-regression.spec.ts`)
- The `use_double_brackets` toggle and the mustache-mode parser (covered by `prompt-template-double-brackets-regression.spec.ts`)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key required — the Prompt Template component is a pure templating layer with no LLM calls
- Auto-login mode is assumed: test 6 uses `page.request.get` so the backend call inherits the page's session cookies. In an environment with explicit auth, the test should still work because the page is authenticated via the normal login flow before the assertion runs.

---

## When to review this test *(optional)*

- If the `button_open_prompt_modal`, `genericModalBtnSave`, or `edit-prompt-sanitized` testids are renamed in the prompt modal frontend
- If the dynamic handle testid pattern (`handle-prompt template-shownode-{var}-left`) changes — e.g., if `"prompt template"` (with space) is replaced by `"prompt-template"` (with dash) or a different node-type slug
- If the `{variable}` extraction regex in `extract_input_variables_from_prompt` changes its handling of escape sequences, whitespace, or nested braces

---

## Notes *(optional)*

- Test 6 (modal persistence) asserts persistence at three layers: the sanitized preview (`edit-prompt-sanitized`, which is the post-save render), the textarea value reached by clicking back into edit mode, and the autosaved flow JSON fetched via `GET /api/v1/flows/{id}`. All three must match the saved string for the test to pass.
- The `setPromptTemplate` helper deliberately handles the post-save "preview" state by detecting `edit-prompt-sanitized` and clicking through it. This is what makes the helper safe to call multiple times in a row (tests 3, 4, 5 all rely on this).
- All assertions use the literal node-type slug `"prompt template"` (with space) in the testid, matching how the frontend renders the type. The leading space inside `handle-prompt template-...` is intentional and not a typo.
