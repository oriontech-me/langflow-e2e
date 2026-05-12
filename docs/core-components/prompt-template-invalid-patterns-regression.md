# Prompt Template — Invalid Patterns Regression

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the **f-string parser contract** of the Prompt Template component when the template string contains patterns that the upstream validator either rejects or treats with specific positive-path semantics. The companion happy-path coverage lives in `prompt-template-component-regression.spec.ts`; this spec focuses on the negative-path and the dedup contract.

The suite has 6 tests covering 4 rejection paths and 2 positive-path defensive assertions:

**Rejection (toast surfaces, no handle created)**

1. **`{var.attr}` (dot notation)** — the dot character is in the upstream `_INVALID_CHARACTERS` set. `_check_input_variables` raises `ValueError("Input variables contain invalid characters or formats. ...")`.
2. **`{var name}` (space inside identifier)** — same path as #1; space is in `_INVALID_CHARACTERS`.
3. **`{var,name}` (comma inside identifier)** — same path; comma is in `_INVALID_CHARACTERS`. Catches the common templating mistake where users write `{a,b}` thinking it declares multiple variables.
4. **`{1var}` (leading digit)** — the upstream `_fix_variable` helper specifically flags identifiers starting with a digit. Anchored on the toast fragment `"Invalid variables: 1"` to confirm the leading-digit branch fired (not just an incidental match on the digit character).

**Positive-path defensive**

5. **`{}` (empty braces)** — Python's `Formatter().parse()` yields `("", "", "", None)` and `extract_input_variables_from_prompt` filters empty `field_name` out. The save succeeds, no error toast, no dynamic handle. This test exists so that if a future change starts rejecting `{}` or extracting it as a real variable, the regression surfaces immediately.
6. **`{name} and {name}` (duplicate)** — `extract_input_variables_from_prompt` tracks seen field names in a `set`, so a repeated `{name}` yields exactly one input variable. Asserts exactly one `name` handle is rendered, not two.

> **Note on scope.** The originally proposed cases `{}` rejection and `{var-name}` rejection (from issue #214) were dropped after probing the live `/api/v1/validate/prompt` endpoint: neither pattern raises today — `{}` is filtered out by the formatter and the hyphen character is **not** in `_INVALID_CHARACTERS`. The replaced rejection cases (`{var name}`, `{var,name}`, `{1var}`) were chosen because they exercise distinct branches of `_check_input_variables`: the `_INVALID_CHARACTERS` set check (space, comma) and the `_fix_variable` leading-digit branch.

If any of these tests fails, one of three contracts has regressed: the rejection of invalid characters in variable names, the dedup behavior of the parser, or the empty-braces / format-positional escape handling.

---

## Tags *(required)*

All 6 tests: `@stable` `@regression` `@components`

None carry `@release` — these are defensive contract assertions, not happy-path flows.

---

## Step by step *(required)*

Every test starts with the same `addPromptComponent(page)` helper used in `prompt-template-component-regression.spec.ts` (blank flow → sidebar search → add → adjust view → assert 1 node).

### Rejection tests (tests 1–4)

The four rejection cases all run the same step sequence via the `runRejectionContract` helper:

1. `addPromptComponent(page)`.
2. Open the prompt modal, fill the textarea with the invalid template, click `genericModalBtnSave` (helper `fillAndSavePromptTemplate`). The helper does **not** wait for modal close — the modal stays open on error.
3. Assert the error toast (`.error-build-message`) is visible within 5 s (the toast auto-dismisses after 5 s — see `src/frontend/src/alerts/error/index.tsx:22`).
4. Assert the toast text contains:
   - The constant title `"There is something wrong with this prompt"` (from i18n `errors.prompt`).
   - The upstream-error fragment `"Input variables contain invalid characters or formats"`.
   - A per-case fragment that anchors the test to the offending pattern — `var.attr`, `var name`, `var,name`, or `"Invalid variables: 1"` for the leading-digit case.
5. Assert the textarea (`modal-promptarea_prompt_template`) is still visible — the frontend sets `isEdit=true` in the `onError` callback so the user can correct without losing input.
6. Press `Escape` to leave the test in a clean state.
7. (Final body-level check) Assert `dynamicHandlesLocator` count is exactly 0 — the rejected save never reached the node.

Note on the fixture: the save deliberately returns HTTP 500, but `tests/fixtures/fixtures.ts` only fails on `flow_error`-type events from `/build/`, `/run/`, or `/events?event_delivery=`. HTTP 500s on `/api/v1/validate/prompt` are logged as `http_error` and do not fail the test, so no `page.allowFlowErrors()` opt-out is needed.

### 5. `{}` is accepted by the parser and creates no handle
- `addPromptComponent(page)`.
- `fillAndSavePromptTemplate(page, "Plain {} text")`.
- Assert the textarea is hidden within 10 s (save succeeded — the modal closed).
- Assert error toast count is 0.
- Assert dynamic-handle count is 0.

### 6. Deduplication: `{name} and {name}` produces one handle
- `addPromptComponent(page)`.
- `fillAndSavePromptTemplate(page, "Hello {name}, goodbye {name}.")`.
- Assert the textarea is hidden within 10 s.
- Assert `handle-prompt template-shownode-name-left` is visible.
- Assert dynamic-handle count is exactly 1.

---

## Validation criterion *(required)*

- For each invalid pattern that hits `_INVALID_CHARACTERS` (dot, space, comma) or `_fix_variable`'s leading-digit branch:
  - The error toast `.error-build-message` is visible and contains the upstream `ValueError` title (`errors.prompt`) plus the message fragment `"Input variables contain invalid characters or formats"`.
  - The toast also includes a per-case fragment anchored on the offending pattern (the variable identifier for set-check failures, or `"Invalid variables: 1"` for the leading-digit branch), confirming the right code path fired.
  - The dynamic handle count on the canvas remains 0 — the rejected save did not propagate to the node.
  - The modal stays open in edit mode (textarea visible) so the user can correct the input.
- For `{}` (empty braces): the save closes the modal, no error toast appears, and no handle is created.
- For `{name} and {name}`: the save closes the modal and exactly one `name` handle is rendered.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/base/prompts/api_utils.py` — `_INVALID_CHARACTERS` set, `_fix_variable` (leading-digit branch), `_check_input_variables`, `_check_for_errors`, `validate_prompt`. Drives the entire rejection contract; tests 1–3 exercise the set-check branch (dot, space, comma), test 4 exercises the leading-digit branch. Any change to the set, the leading-digit logic, or the message format breaks tests 1–4.
- `src/lfx/src/lfx/interface/utils.py` — `extract_input_variables_from_prompt`: the dedup `set` and the empty `field_name` filter back tests 5 and 6.
- `src/backend/base/langflow/api/v1/validate.py` — `POST /validate/prompt`: returns HTTP 500 with `detail=str(ValueError(...))` on rejection. The HTTP status and the `detail` shape are what the frontend's `onError` callback consumes.
- `src/frontend/src/modals/promptModal/index.tsx` — `genericModalBtnSave`, `modal-promptarea_prompt_template`, and the `usePostValidatePrompt` mutation's `onError` callback that maps the API error into the toast (title from `t("errors.prompt")`, detail from `error.response.data.detail`). Also sets `isEdit=true` so the modal stays open on error.
- `src/frontend/src/alerts/error/index.tsx` — `ErrorAlert` component renders with CSS class `.error-build-message`; the 5-second auto-dismiss timeout there defines the maximum window in which the toast assertion must run.
- `src/frontend/src/locales/en.json` — i18n key `errors.prompt` whose value `"There is something wrong with this prompt, please review it"` is asserted as a constant. Localizing this string would break tests 1–3.

---

## What this test does not cover *(optional)*

- Variable extraction from valid templates and dynamic-handle rendering (covered by `prompt-template-component-regression.spec.ts`)
- The `use_double_brackets` toggle and the f-string escape behavior `{{var}}` rendering as a literal (covered by `prompt-template-double-brackets-regression.spec.ts`, where the two parser modes are asserted side by side and the comparison is informative)
- Invalid patterns in **mustache mode** (`{{ var }}`, `{{var.attr}}`, `{{#section}}{{/section}}`, `{{{var}}}`) — tracked as a follow-up issue, to be covered in a dedicated spec because the toggle flips a different code path (`validate_mustache_template`)
- LLM/runtime errors when a flow built on top of the Prompt Template is executed
- Tool Mode interaction (covered by `tool-mode.spec.ts`)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key required — the Prompt Template component is a pure templating layer with no LLM calls
- The fixture from `tests/fixtures/fixtures.ts` is used. The HTTP 500 the rejection cases trigger on `/api/v1/validate/prompt` is logged as `http_error` but does not fail the test (the fixture only fails on `flow_error`-type events from `/build/`, `/run/`, `/events?event_delivery=`).

---

## When to review this test *(optional)*

- If `_INVALID_CHARACTERS` in `src/lfx/src/lfx/base/prompts/api_utils.py` changes (add/remove a character) — the rejection tests are coupled to that set.
- If the error message format in `_check_for_errors` changes — tests 1–4 assert the leading fragment `"Input variables contain invalid characters or formats"`, and test 4 additionally anchors on `"Invalid variables: 1"`.
- If the i18n key `errors.prompt` is renamed or its value localized — tests 1–4 assert the literal English title.
- If the frontend stops calling `setIsEdit(true)` in `onError` — step 5 of the rejection contract asserts the textarea stays visible.
- If the toast component's CSS class changes from `.error-build-message` to something else, or a `data-testid` is added (the spec could then anchor on it instead of the class).

---

## Notes *(optional)*

- The validate endpoint deliberately returns HTTP 500 for the rejection cases, but the fixture only fails on `flow_error`-type events from `/build/`, `/run/`, or `/events?event_delivery=` (see `tests/fixtures/fixtures.ts:230–262`). The 500 from `/api/v1/validate/prompt` is logged as `http_error` and is harmless — no `page.allowFlowErrors()` opt-out is needed here. Other specs (`loop-component-regression.spec.ts`, `api-request-component-regression.spec.ts`) do call `allowFlowErrors()` because they exercise the `/build/` and `/run/` endpoints, which would actually fail the test.
- The error toast auto-dismisses after 5 seconds (`src/frontend/src/alerts/error/index.tsx:22`). The first toast assertion uses a 5-second timeout to match — running additional waits before the toast assertion would race against the dismissal.
- The originally proposed `{var-name}` rejection case was dropped because hyphen is not in `_INVALID_CHARACTERS` upstream — `{var-name}` actually creates a `var-name` handle. Probed against `POST /api/v1/validate/prompt` on Langflow 1.10.x. If Langflow ever adds hyphen to the invalid-chars set, this spec should grow a case for it.
- The originally proposed `{}` rejection case was reframed as a positive-path defensive test for the same reason: Python's `Formatter().parse()` yields an empty `field_name` that the extractor filters out, so the save succeeds silently. The test asserts that contract.
