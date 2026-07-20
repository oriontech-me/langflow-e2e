# Prompt Template — Invalid Mustache Patterns Regression

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev49`)

---

## What this test validates *(required)*

Validates the **mustache parser rejection contract** of the Prompt Template component. The `use_double_brackets` toggle (covered by `prompt-template-double-brackets-regression.spec.ts`) flips the validator from `extract_input_variables_from_prompt` (f-string) to `validate_mustache_template` + `mustache_template_vars` (mustache). This spec asserts that the mustache validator rejects the four forbidden patterns that are out of scope for the simple-variable contract — independently of the f-string sibling spec (`prompt-template-invalid-patterns-regression.spec.ts`), which exercises a different branch upstream.

All 4 tests run with the toggle flipped ON before the rejection contract is exercised.

The suite has 4 tests — one per rejection branch of `validate_mustache_template`:

**SIMPLE_VARIABLE_PATTERN miss (per-pattern match fails)**

1. **`{{ var }}` (spaces inside braces)** — Whitespace inside braces fails `SIMPLE_VARIABLE_PATTERN.match()` because the regex requires no whitespace between the braces and the identifier. The error detail echoes the offending pattern verbatim: `"Invalid mustache variable: {{ var }}. Only simple variable names like {{variable}} are allowed."`.
2. **`{{var.attr}}` (dot notation)** — Same code path as #1. Dot notation is intentionally unsupported because `safe_mustache_render` has no dot-path lookup (variables are resolved via `dict.get`), so the validator rejects the pattern before render. The detail echoes `{{var.attr}}`.

**DANGEROUS_PATTERNS regex hit (forbidden mustache sigil detected)**

3. **`{{#section}}{{/section}}` (section + closing tag)** — Both `{{#` and `{{/` are in the `DANGEROUS_PATTERNS` list; the first one to match short-circuits with the constant message `"Complex mustache syntax is not allowed. Only simple variable substitution like {{variable}} is permitted."`. The offending pattern is *not* echoed back in this branch.
4. **`{{{var}}}` (triple braces)** — Triple braces are the mustache "unescaped HTML" sigil and are blocked by the `{{{` regex in `DANGEROUS_PATTERNS`. Same constant message as #3.

If any of these tests fails, one of three contracts has regressed: (a) the toggle no longer switches the validator over, (b) the mustache validator stopped flagging a forbidden pattern, or (c) the frontend's error-handling path for the mustache modal stopped surfacing the upstream message.

---

## Tags *(required)*

All 4 tests: `@stable` `@regression` `@components`

None carry `@release` — these are defensive contract assertions, not happy-path flows.

---

## Step by step *(required)*

Every test starts with the same `addPromptComponent(page)` helper used in the sibling specs (blank flow → sidebar search → add → adjust view → assert 1 node), followed by `setUseDoubleBrackets(page, true)`. dev49: `use_double_brackets` is an advanced field, so the helper first exposes its `toggle_bool_use_double_brackets` control on the node body via the inspector (`parameters-button` → `inspector-add-use_double_brackets` → close), then clicks the toggle and waits for `button_open_mustache_prompt_modal` to mount (the re-render is the reliable signal that the validator switch has landed).

All four rejection cases then run the same step sequence via the `runMustacheRejectionContract` helper:

1. `addPromptComponent(page)` + `enableMustacheMode(page)`.
2. Open the mustache prompt modal, fill the textarea with the invalid template, click `genericModalBtnSave` (helper `fillAndSaveMustacheTemplate`). The helper does **not** wait for modal close — the modal stays open on error.
3. Assert the error toast (`.error-build-message`) is visible within 5 s (the toast auto-dismisses after 5 s — see `src/frontend/src/alerts/error/index.tsx:22`).
4. Assert the toast text contains:
   - The constant title `"There is something wrong with this prompt"` (from i18n `errors.prompt`).
   - A per-case fragment that anchors the test to the branch of `validate_mustache_template` that fired:
     - Cases 1–2: `"Invalid mustache variable: {{ var }}"` / `"Invalid mustache variable: {{var.attr}}"` — the offending pattern is echoed verbatim.
     - Cases 3–4: `"Complex mustache syntax is not allowed"` — the constant message used by every `DANGEROUS_PATTERNS` hit.
5. Assert the mustache textarea (`modal-mustachepromptarea_mustache_template`) is still visible — the frontend sets `isEdit=true` in the `onError` callback so the user can correct without losing input.
6. Press `Escape` to leave the test in a clean state.
7. (Final body-level check) Assert `dynamicHandlesLocator` count is exactly 0 — the rejected save never reached the node.

Note on the fixture: the save deliberately returns HTTP 500, but `tests/fixtures/fixtures.ts` only fails on `flow_error`-type events from `/build/`, `/run/`, or `/events?event_delivery=`. HTTP 500s on `/api/v1/validate/prompt` are logged as `http_error` and do not fail the test, so no `page.allowFlowErrors()` opt-out is needed (same as the f-string sibling spec).

---

## Validation criterion *(required)*

For each of the four forbidden mustache patterns:

- The error toast `.error-build-message` is visible within 5 s and contains the upstream `ValueError` title from i18n key `errors.prompt`.
- The toast detail carries the upstream message fragment that anchors the test to the specific rejection branch:
  - SIMPLE_VARIABLE_PATTERN miss (`{{ var }}`, `{{var.attr}}`): `"Invalid mustache variable: <pattern>"`.
  - DANGEROUS_PATTERNS hit (`{{#section}}{{/section}}`, `{{{var}}}`): `"Complex mustache syntax is not allowed"`.
- The dynamic handle count on the canvas remains 0 — the rejected save did not propagate to the node.
- The mustache modal stays open in edit mode (textarea visible) so the user can correct the input.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/utils/mustache_security.py` — `validate_mustache_template`, `DANGEROUS_PATTERNS`, `SIMPLE_VARIABLE_PATTERN`. Drives the entire rejection contract. Tests 1–2 exercise the `SIMPLE_VARIABLE_PATTERN.match()` miss branch; tests 3–4 exercise the `DANGEROUS_PATTERNS` regex-hit branch. Any change to the regex list, the simple-variable pattern, or either message string breaks the corresponding tests.
- `src/lfx/src/lfx/base/prompts/api_utils.py` — `validate_prompt(..., is_mustache=True)` is the entry point that delegates to `validate_mustache_template` before extracting variables. If the `is_mustache` branch is short-circuited or reordered, the rejection contract no longer fires.
- `src/backend/base/langflow/api/v1/validate.py` — `POST /validate/prompt`: returns HTTP 500 with `detail=str(ValueError(...))` on rejection. The HTTP status and the `detail` shape are what the frontend's `onError` callback consumes.
- `src/frontend/src/modals/mustachePromptModal/index.tsx` — `button_open_mustache_prompt_modal`, `modal-mustachepromptarea_mustache_template`, and the `onError` callback (lines 148–153) that maps the API error into the toast (title from `t("errors.prompt")`, detail from `error.response.data.detail`). Also sets `isEdit=true` so the modal stays open on error.
- `src/frontend/src/components/core/parameterRenderComponent/components/mustachePromptComponent/index.tsx` — owns the `button_open_mustache_prompt_modal` testid that the helper expects to be visible once mustache mode is enabled.
- `src/frontend/src/alerts/error/index.tsx` — `ErrorAlert` component renders with CSS class `.error-build-message`; the 5-second auto-dismiss timeout there defines the maximum window in which the toast assertion must run.
- `src/frontend/src/locales/en.json` — i18n key `errors.prompt` whose value `"There is something wrong with this prompt, please review it"` is the source for the toast title. All four tests assert via `toContainText("There is something wrong with this prompt")` — a substring check, not a full-string equality. Localizing this prefix (or shortening it past the asserted substring) would break the suite.

---

## What this test does not cover *(optional)*

- F-string mode invalid patterns (covered by `prompt-template-invalid-patterns-regression.spec.ts`).
- The `use_double_brackets` toggle behavior itself — exposure, default state, mode-switching semantics, backend persistence (covered by `prompt-template-double-brackets-regression.spec.ts`).
- Variable extraction from valid mustache templates and dynamic-handle rendering (covered by `prompt-template-double-brackets-regression.spec.ts`, where the two parser modes are asserted side by side).
- Other mustache sigils listed in `DANGEROUS_PATTERNS` but not in the issue scope: inverted sections `{{^...}}`, unescaped variables `{{&...}}`, partials `{{>...}}`, comments `{{!...}}`, current-context `{{.}}`. These all share the same constant `"Complex mustache syntax is not allowed"` message as cases 3–4 — extend this spec if a regression in those branches needs explicit coverage.
- LLM/runtime errors when a flow built on top of the Prompt Template is executed.
- Tool Mode interaction (covered by `tool-mode.spec.ts`).

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No API key required — the Prompt Template component is a pure templating layer with no LLM calls.
- The fixture from `tests/fixtures/fixtures.ts` is used. The HTTP 500 the rejection cases trigger on `/api/v1/validate/prompt` is logged as `http_error` but does not fail the test (the fixture only fails on `flow_error`-type events from `/build/`, `/run/`, `/events?event_delivery=`).

---

## When to review this test *(optional)*

- If `DANGEROUS_PATTERNS` or `SIMPLE_VARIABLE_PATTERN` in `src/lfx/src/lfx/utils/mustache_security.py` changes — the rejection branches and the message strings are coupled to that file.
- If the two error messages (`"Complex mustache syntax is not allowed"`, `"Invalid mustache variable: <pattern>"`) are reworded or merged — the per-case fragment assertions are anchored on them.
- If `validate_prompt` in `src/lfx/src/lfx/base/prompts/api_utils.py` reorders or short-circuits the `is_mustache` branch — `validate_mustache_template` may no longer fire before `mustache_template_vars`, and the cryptic mustache-parser fallback message (line 141) would surface instead.
- If the i18n key `errors.prompt` is renamed or its English value shortened past the asserted prefix `"There is something wrong with this prompt"` — all four tests assert that substring.
- If the frontend stops calling `setIsEdit(true)` in the mustache modal's `onError` (lines 148–153) — step 5 of the rejection contract asserts the textarea stays visible.
- If the toast component's CSS class changes from `.error-build-message` to something else, or a `data-testid` is added (the spec could then anchor on it instead of the class).

---

## Notes *(optional)*

- Each of the four patterns was probed against `POST /api/v1/validate/prompt` with `"mustache": true` on Langflow 1.10.x before the spec was written — all four return HTTP 500 today, with the exact two message strings the spec asserts. The probe is the safety valve for this kind of "issue says X errors" claim, because the f-string sibling spec surfaced two cases (`{}` and `{var-name}`) that did *not* error in practice. No such gap was found here.
- The error toast auto-dismisses after 5 seconds (`src/frontend/src/alerts/error/index.tsx:22`). The first toast assertion uses a 5-second timeout to match — running additional waits before the toast assertion would race against the dismissal.
- Cases 3 and 4 share the same constant message because every `DANGEROUS_PATTERNS` hit returns the same string. They are kept as separate `test()` declarations (not parameterised) so the auto-generated `Phase 0 — Validated` block in `QA-CHECKLIST.md` surfaces one bullet per case — `scripts/stable-tests.ts` renders `${expr}` template placeholders as `<expr>` and would otherwise collapse the runtime tests into a single, vague bullet.
- The mustache modal uses a different open-button testid (`button_open_mustache_prompt_modal`) and textarea testid (`modal-mustachepromptarea_mustache_template`) than the f-string modal — the spec's helpers (`fillAndSaveMustacheTemplate`, `runMustacheRejectionContract`) keep those testids local rather than parameterising the f-string sibling's helpers, to keep each spec independently readable.
