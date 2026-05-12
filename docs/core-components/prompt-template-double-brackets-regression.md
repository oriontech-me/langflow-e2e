# Prompt Template Component — `use_double_brackets` Toggle Regression

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the **Prompt Template** component's `use_double_brackets` toggle and the mustache code path it activates, end-to-end via 5 scenarios:

1. **Toggle is exposed in the InspectionPanel with its upstream display name** — the upstream field carries `advanced=True`, which only filters it from the on-canvas node body; the right-hand InspectionPanel still renders the bool control directly (`toggle_bool_use_double_brackets`) along with the literal display name "Use Double Brackets", confirming the upstream `BoolInput(display_name=...)` wiring is intact. (The `info` string is rendered as a hover-tooltip icon when the panel is narrow, so it is not asserted directly.)
2. **Default toggle state is `False` (f-string mode)** — saving `Hello {single} and {{double}}!` extracts only `single` and treats `{{double}}` as a literal `{double}` per f-string escape semantics; exactly one dynamic handle is rendered.
3. **Enabling the toggle switches the parser to mustache mode** — after flipping the toggle ON, saving `Hello {single} and {{double}}!` extracts only `double`; `{single}` is ignored by the mustache parser.
4. **Disabling the toggle reverts to f-string mode and variables are re-extracted under the new parser** — a template saved in mustache mode (`Hello {{name}}!`) keeps its `name` handle past the toggle alone (the rendered handle set is only fully reconciled after the next save), but re-saving the same template after switching back to f-string drops the now-literal `{{name}}` handle, and a fresh `{var}` template then recreates a handle.
5. **`use_double_brackets` value persists in the saved flow** — `GET /api/v1/flows/{id}` returns `template.use_double_brackets.value === true` after the toggle is flipped and autosave runs.

If any of these tests fails, the toggle is broken in one of its core contracts: the InspectionPanel rendering of the bool field, the f-string ↔ mustache parser switch in `update_build_config`, the re-extraction of variables when the template is saved under the active mode, or the autosave round-trip of the boolean value.

This spec complements `prompt-template-component-regression.spec.ts`, which covers only the default (f-string) mode.

---

## Tags *(required)*

All 5 tests: `@stable` `@regression` `@components`

Tests 2 and 3 may also adopt `@release` once they prove stable in the first weekly cycle (per the issue's tag guidance).

---

## Step by step *(required)*

Every test starts with `addPromptComponent(page)` which:
1. Bootstraps the app (`awaitBootstrapTest`)
2. Clicks `blank-flow`
3. Fills `sidebar-search-input` with `prompt` and waits for `add-component-button-prompt-template`
4. Clicks the add button
5. Calls `adjustScreenView(page)`
6. Asserts exactly one node is on the canvas

Tests 3–5 use the helper `flipDoubleBrackets(page, expectMustache)` which:
1. Clicks `toggle_bool_use_double_brackets` in the InspectionPanel
2. Waits for `button_open_mustache_prompt_modal` (when `expectMustache=true`) or `button_open_prompt_modal` (when `expectMustache=false`) — the type swap in `update_build_config` re-renders the modal-open button under the matching testid, which is a reliable signal that the field-type switch has landed

Tests 2–4 use the helper `setPromptTemplate(page, value, mode)` which is parameterised on `mode`:
- `"fstring"` → opens `button_open_prompt_modal` and fills `modal-promptarea_prompt_template`
- `"mustache"` → opens `button_open_mustache_prompt_modal` and fills `modal-mustachepromptarea_mustache_template`

Both modes share the post-save preview (`edit-prompt-sanitized`) and the save button (`genericModalBtnSave`). The helper detects the preview state and re-enters edit mode automatically, so it is safe to call multiple times in a row.

### 1. `toggle is exposed in the InspectionPanel with its upstream display name`
- Asserts `toggle_bool_use_double_brackets` is visible after the node is added to the canvas — the InspectionPanel renders advanced fields directly (`isCanvasVisible()` only filters the canvas node body, not the side panel).
- Asserts the display name `"Use Double Brackets"` is visible — this string is the upstream `BoolInput(display_name=...)` value, so the assertion catches an accidental rename at the source. The `info` string ("Use `{{variable}}` syntax instead of `{variable}`.") is rendered as a hover-tooltip icon when the panel is narrow, so the visible rendering depends on layout state and is intentionally not asserted.

### 2. `default toggle state is OFF; f-string mode extracts {var} and treats {{var}} as literal`
- Saves `Hello {single} and {{double}}!` without touching the toggle.
- Asserts `handle-prompt template-shownode-single-left` is visible.
- Asserts `handle-prompt template-shownode-double-left` has count 0.
- Asserts the dynamic-handle locator has count exactly 1 — sanity check that no extra handles leaked in.

### 3. `enabling toggle switches parser to mustache mode`
- Calls `flipDoubleBrackets(page, true)` to enable mustache mode.
- Saves `Hello {single} and {{double}}!` via the mustache modal.
- Asserts `handle-prompt template-shownode-double-left` is visible.
- Asserts `handle-prompt template-shownode-single-left` has count 0.
- Asserts the dynamic-handle locator has count exactly 1.

### 4. `disabling toggle reverts to f-string mode and variables are re-extracted under the new parser`
- Calls `flipDoubleBrackets(page, true)`, then saves `Hello {{name}}!` via the mustache modal. Asserts the `name` handle is visible.
- Calls `flipDoubleBrackets(page, false)` and explicitly asserts `button_open_prompt_modal` is visible and `button_open_mustache_prompt_modal` has count 0 — the swap-back is surfaced as a test-level `expect()` so the HTML report carries a real assertion, not just the helper's internal wait. The rendered `name` handle may still persist past the toggle alone: the upstream cleanup-and-re-extraction inside `update_build_config` runs, but the rendered handle set is only fully reconciled after the next save.
- Re-saves the same template `Hello {{name}}!` via the f-string modal. Asserts the `name` handle disappears and the dynamic-handle count is 0 — `{{name}}` is a literal `{name}` under f-string semantics.
- Saves `Just one {var} here.` via the f-string modal. Asserts the `var` handle is visible and the dynamic-handle count is 1.

### 5. `use_double_brackets value persists in the autosaved flow`
- Extracts the flow id from the URL.
- **Baseline:** polls `GET /api/v1/flows/{id}` via `page.request` (inherits session cookies) until the Prompt Template node's `template.use_double_brackets.value` equals `false` — proves the field starts in the default OFF state before any interaction.
- Calls `flipDoubleBrackets(page, true)`.
- Polls the same endpoint until the value equals `true` — proves the toggle drove the round-trip change, not just that the final state happens to be `true`.

---

## Validation criterion *(required)*

- `toggle_bool_use_double_brackets` is visible in the InspectionPanel after the Prompt Template is added to a blank flow, alongside the display name "Use Double Brackets"
- In default (OFF) state, `{var}` produces a dynamic handle and `{{var}}` is treated as a literal escape
- In ON state, `{{var}}` produces a dynamic handle and `{var}` is ignored by the parser
- Flipping the toggle swaps the modal-open button (and underlying parser) between the f-string and mustache variants; saving the template under the new mode reconciles the rendered handle set to the new parser's output
- The autosaved flow at `GET /api/v1/flows/{id}` contains `template.use_double_brackets.value === true` after the toggle is flipped ON

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/models_and_agents/prompt.py` — `BoolInput(name="use_double_brackets", ..., real_time_refresh=True)` and `update_build_config()` which switches `template.type` between `FieldTypes.PROMPT` and `FieldTypes.MUSTACHE_PROMPT` and re-runs variable extraction; breaks tests 1–5
- `src/lfx/src/lfx/base/prompts/api_utils.py` — `validate_prompt()` branches on `is_mustache` to pick the parser; breaks tests 2–4
- `src/lfx/src/lfx/utils/mustache_security.py` — `validate_mustache_template()` runs before mustache extraction; breaks tests 3 and 4
- `src/lfx/src/lfx/interface/utils.py` — `extract_input_variables_from_prompt()` (f-string parsing via `string.Formatter().parse()`); breaks tests 2 and 4
- `src/frontend/src/components/core/parameterRenderComponent/index.tsx` — renders the prompt area as `promptarea_*` or `mustachepromptarea_*` based on the field type; renaming either id breaks tests 2–4
- `src/frontend/src/components/core/parameterRenderComponent/components/accordionPromptComponent/` — owns the `button_open_prompt_modal` / `button_open_mustache_prompt_modal` testids on the node inspector; breaks tests 2–4
- `src/frontend/src/components/core/parameterRenderComponent/components/mustachePromptComponent/` — owns the mustache modal-open button in edit mode; breaks tests 3 and 4
- `src/frontend/src/modals/promptModal/` — shared modal layer (`genericModalBtnSave`, `edit-prompt-sanitized`, textarea id pattern); breaks tests 2–4
- `GET /api/v1/flows/{id}` — flow read endpoint backing the autosave round-trip; the response shape `data.nodes[].data.node.template.use_double_brackets.value` is what test 5 asserts. A rename of the inner `template.use_double_brackets` field or a change to `node.data.type` away from `"Prompt Template"` breaks the backend assertion.

---

## What this test does not cover *(optional)*

- Validation of invalid mustache patterns (e.g., `{{ var }}`, `{{var.attr}}`, `{{#section}}{{/section}}`, `{{{var}}}`) — covered by `prompt-template-invalid-mustache-patterns-regression.spec.ts`, which exercises the `validate_mustache_template` rejection contract with the toggle flipped ON
- The `tool_placeholder` advanced input on the same component (covered by `tool-mode.spec.ts`)
- Prompt rendering/execution behind an LLM (covered by `llm-agents` specs)
- The single-bracket happy path and modal persistence in f-string mode (covered by `prompt-template-component-regression.spec.ts`)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key required — the Prompt Template component is a pure templating layer with no LLM calls
- Auto-login mode is assumed: test 5 uses `page.request.get` so the backend call inherits the page's session cookies. In an environment with explicit auth, the test should still work because the page is authenticated via the normal login flow before the assertion runs

---

## When to review this test *(optional)*

- If `BoolInput(name="use_double_brackets", ...)` is renamed, removed, or loses `advanced=True` / `real_time_refresh=True` on the upstream component
- If the testid pair `button_open_prompt_modal` / `button_open_mustache_prompt_modal` changes — e.g., unified into a single button that switches its label
- If the textarea id pattern changes — `modal-promptarea_prompt_template` (f-string) or `modal-mustachepromptarea_mustache_template` (mustache). Note: the suffix tracks `templateData.type`, which the upstream component flips between `"prompt"` and `"mustache"` when the toggle changes, so the testids encode the active mode
- If `update_build_config` stops swapping `template.type` between PROMPT and MUSTACHE_PROMPT on mode change — `flipDoubleBrackets` watches the modal-open testid swap as the signal that this swap landed
- If the `template.use_double_brackets.value` path in the saved-flow JSON is restructured

---

## Notes *(optional)*

- The InspectionPanel renders advanced fields directly: although `use_double_brackets` is `advanced=True`, the toggle is interactable without first opening any "show advanced options" UI. The upstream `isCanvasVisible()` filter only hides the field from the on-canvas node body, not from the side panel.
- `flipDoubleBrackets` waits for the modal-open button to re-render under the testid that matches the target mode (`button_open_prompt_modal` ↔ `button_open_mustache_prompt_modal`). This is more robust than waiting for an arbitrary timeout — the testid swap is driven by `template.type` flipping between PROMPT and MUSTACHE_PROMPT in `update_build_config`, which is exactly the contract we want to verify is wired through.
- Test 4 verifies the parser-switch contract end-to-end: toggling OFF swaps the modal-open button (proving the field-type change landed) and the subsequent f-string save reconciles the rendered handle set. We do **not** assert that handles disappear from the toggle alone, because empirically the rendered handle set lingers past `update_build_config` until the next save in the active mode.
- All assertions use the literal node-type slug `"prompt template"` (with space) in the testid, matching how the frontend renders the type. The leading space inside `handle-prompt template-...` is intentional and not a typo.
