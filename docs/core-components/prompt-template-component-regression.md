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
6. **Modal persistence** — text entered in the prompt modal and saved via `genericModalBtnSave` is still present (in the sanitized preview and in the textarea after re-entering edit mode) when the modal is reopened.

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
2. Waits for the `[role="dialog"]` modal
3. If the sanitized preview `edit-prompt-sanitized` is visible (post-save state), clicks it to re-enter edit mode
4. Selects all in the modal textarea (`Ctrl+A`) and fills `value`
5. Clicks `genericModalBtnSave`, waits for the dialog to hide, and waits 1.5 s for the canvas to re-render

### 1. `renders on canvas with output handle`
- Asserts `title-Prompt Template` is visible.
- Asserts the right-side `handle-prompt template-shownode-prompt-right` handle is visible.
- Asserts exactly one node on the canvas (`react-flow__node` count === 1).

### 2. `variables in curly braces generate dynamic input handles`
- Records the initial count of `handle-prompt template` testids.
- Calls `setPromptTemplate` with `Hello {name}, your job is {profession}.`.
- Asserts the new handle count is strictly greater than the initial count.
- Asserts both `handle-prompt template-shownode-name-left` and `handle-prompt template-shownode-profession-left` are visible.

### 3. `removing a variable removes its input handle`
- Sets the template to `Hello {name}!` and asserts the `name` handle is visible.
- Records the current handle count.
- Sets the template to `Hello world!` and asserts the `name` handle has zero matches.
- Asserts the new handle count is strictly less than the recorded count.

### 4. `replacing a variable updates handles accordingly`
- Sets the template to `Hello {name}, you are {role}.` and asserts both `name` and `role` handles are visible.
- Sets the template to `Hello {name}, you are {title}.`.
- Asserts `name` is still visible, `role` has zero matches, and `title` is visible.

### 5. `clearing the template removes all dynamic handles`
- Sets the template to `{a} and {b} and {c}` and asserts the count of left-side dynamic handles is > 0.
- Sets the template to `No variables here.`.
- Asserts the count of left-side dynamic handles equals 0.

### 6. `modal edits persist after closing and reopening`
- Sets the template to `Persisted prompt text {topic}.` via `setPromptTemplate`.
- Asserts `handle-prompt template-shownode-topic-left` is visible (confirms save succeeded).
- Reopens the modal via `button_open_prompt_modal`.
- Asserts `edit-prompt-sanitized` is visible and contains both `Persisted prompt text` and `topic`.
- Clicks the preview to re-enter edit mode.
- Asserts the textarea has the exact saved value via `toHaveValue`.

---

## Validation criterion *(required)*

- `title-Prompt Template` is visible after adding the component to a blank flow
- The right-side output handle `handle-prompt template-shownode-prompt-right` is visible
- For each `{variable}` saved in the template, a corresponding left-side handle `handle-prompt template-shownode-{variable}-left` is rendered
- Removing a `{variable}` from the template removes the corresponding handle
- Replacing one variable with another removes the old handle and creates a new one
- Saving a template via `genericModalBtnSave` makes the value retrievable on the next modal open — both in the sanitized preview and in the textarea after re-entering edit mode

---

## External dependencies *(required)*

- `src/frontend/src/modals/promptModal/` — `genericModalBtnSave` button, `edit-prompt-sanitized` preview, and the textarea that holds the editable template; changes here break tests 2–6
- `src/frontend/src/CustomNodes/GenericNode/components/parameterRenderComponent/components/promptAreaComponent/` — `button_open_prompt_modal` trigger on the node inspector; breaks tests 2–6
- `src/backend/base/langflow/base/prompts/api_utils.py` — `extract_input_variables_from_prompt()` regex that derives the variable list from the template string; breaks tests 2–5
- `src/frontend/src/CustomNodes/GenericNode/` — dynamic handle rendering for `handle-{component}-shownode-{var}-left`; breaks tests 1–5
- `src/backend/base/langflow/base/prompts/` — `PromptComponent` template-to-input-fields synchronization; breaks tests 2–5

---

## What this test does not cover *(optional)*

- Prompt rendering/execution behind an LLM (covered by `llm-agents` specs such as `memory-history-regression.spec.ts`)
- Tool Mode interaction (covered by `tool-mode.spec.ts`)
- Cross-component data flow (covered by `flow-functionality/` specs)
- Variable name validation (e.g., reserved keywords, special characters)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key required — the Prompt Template component is a pure templating layer with no LLM calls
- The 1.5 s wait after `genericModalBtnSave` in `setPromptTemplate` accommodates the canvas re-render that follows handle creation/removal; environments with very slow rendering may need a longer wait

---

## When to review this test *(optional)*

- If the `button_open_prompt_modal`, `genericModalBtnSave`, or `edit-prompt-sanitized` testids are renamed in the prompt modal frontend
- If the dynamic handle testid pattern (`handle-prompt template-shownode-{var}-left`) changes — e.g., if `"prompt template"` (with space) is replaced by `"prompt-template"` (with dash) or a different node-type slug
- If the `{variable}` extraction regex in `extract_input_variables_from_prompt` changes its handling of escape sequences, whitespace, or nested braces

---

## Notes *(optional)*

- Test 6 (modal persistence) asserts persistence at two layers: the sanitized preview (`edit-prompt-sanitized`, which is the post-save render) and the textarea value reached by clicking back into edit mode. Both must match the saved string for the test to pass.
- The `setPromptTemplate` helper deliberately handles the post-save "preview" state by detecting `edit-prompt-sanitized` and clicking through it. This is what makes the helper safe to call multiple times in a row (tests 3, 4, 5 all rely on this).
- All assertions use the literal node-type slug `"prompt template"` (with space) in the testid, matching how the frontend renders the type. The leading space inside `handle-prompt template-...` is intentional and not a typo.
