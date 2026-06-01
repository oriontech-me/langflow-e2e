# Spec: If-Else Component — Routing Regression

**Test file:** `tests/tests-automations/regression/core-components/if-else-component-regression.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

Covers the routing contract of the **If-Else** (ConditionalRouter) component across the operator surface: every text operator (equals, contains, regex), the `case_sensitive` toggle (default ON / explicit OFF), and one representative numeric operator (`greater than`). Each scenario is a separate `test()` so a failure pinpoints the exact behavior that regressed.

For every scenario except the regex side-effect test, the assertion surface is the canvas node status: `node_duration_<name>` testid for the branch that built (active) and `node_status_icon_<name>_inactive` testid for the branch that was skipped. This is the same surface used by `flow-functionality/general-bugs-reset-flow-run.spec.ts` and is more reliable than message-content assertions because the component returns an empty Message on the inactive branch (so message presence alone cannot distinguish the routes).

The one exception is the regex side-effect test: when `operator=regex`, the component's `update_build_config` removes the `case_sensitive` field from the build config. The assertion there is that opening the edit-fields modal shows `toHaveCount(0)` for the `showcase_sensitive` testid (it is normally `1`).

---

## Tags

`@stable` `@regression` `@components`

> Promoted to `@stable` after validation against Langflow 1.10.0: 8/8 pass across three runs (2× clean at `--workers=2`; one run at default 5 workers showed a single setup-race flake that recovered on retry). The 500s observed on `/api/v1/flows/` are concurrent-flow-creation SQLite contention under parallelism — logged but non-fatal by the fixture (HTTP errors do not fail tests; only flow-execution errors do) and not specific to this spec.

---

## Scenarios (one `test()` per row)

| # | Scenario | operator | input_text | match_text | case_sensitive | Active branch | Inactive branch |
|---|---|---|---|---|---|---|---|
| 1 | `equals` match | equals | hello | hello | default | True | False |
| 2 | `equals` no-match | equals | world | hello | default | False | True |
| 3 | `contains` substring match | contains | langflow | lang | default | True | False |
| 4 | `regex` valid pattern match | regex | abc123 | `^abc\d+$` | (N/A — regex ignores) | True | False |
| 5 | `regex` hides `case_sensitive` field | regex | — | — | — | — (DOM check) | — |
| 6 | `case_sensitive` ON (default) → no-match on mixed case | equals | HELLO | hello | ON (default) | False | True |
| 7 | `case_sensitive` OFF → match on mixed case | equals | HELLO | hello | OFF (toggled) | True | False |
| 8 | `greater than` (numeric) match | greater than | 10 | 5 | default | True | False |

All eight scenarios are introduced in this spec; there is no pre-existing implementation elsewhere.

---

## Shared setup helper

`buildIfElseRoutingFlow(page)` (defined in the spec):

1. Bootstrap and open a blank flow.
2. Add the **If-Else** component from the sidebar.
3. Zoom out so two more components fit.
4. Drop two **Text Output** components onto the canvas (positions: `{100, 100}` and `{200, 400}`).
5. Rename the second Text Output to `textoutputfalse` so its testid suffix is stable.
6. Wire `handle-conditionalrouter-shownode-true-right` → first Text Output's `inputs-left` handle.
7. Wire `handle-conditionalrouter-shownode-false-right` → `textoutputfalse`'s `inputs-left` handle.

Each test calls this helper and then applies the scenario-specific configuration before running.

---

## New local helpers

| Helper | Signature | Behaviour |
|---|---|---|
| `selectOperator` | `(page: Page, operatorName: string)` | Clicks the `value-dropdown-dropdown_str_operator` trigger, picks the option by `getByRole("option", { name: operatorName, exact: true })`, and asserts the trigger text reflects the new value. The option click uses `dispatchEvent("click")` because numeric options at the bottom of the list overlap `main_canvas_controls`, which intercepts ordinary pointer events. |
| `exposeCaseSensitive` | `(page: Page)` | Opens advanced options, clicks `showcase_sensitive` to surface the BoolInput on the node body, then closes advanced options. |

Test #7 (case_sensitive OFF) does not use a dedicated helper to flip the switch — it clicks `getByTestId("toggle_bool_case_sensitive")` (BUTTON `role="switch"`) inline after calling `exposeCaseSensitive`.

---

## Validation criterion (per scenario)

| # | Active branch (`toHaveCount(1)`) | Inactive branch (`toHaveCount(1)`) | Additional |
|---|---|---|---|
| 1 | `node_duration_text output` | `node_status_icon_textoutputfalse_inactive` | — |
| 2 | `node_duration_textoutputfalse` | `node_status_icon_text output_inactive` | — |
| 3 | `node_duration_text output` | `node_status_icon_textoutputfalse_inactive` | — |
| 4 | `node_duration_text output` | `node_status_icon_textoutputfalse_inactive` | — |
| 5 | — | — | After switching to `regex`, opening edit-fields shows `toHaveCount(0)` for `showcase_sensitive`. With `equals`, count is `1`. |
| 6 | `node_duration_textoutputfalse` | `node_status_icon_text output_inactive` | — |
| 7 | `node_duration_text output` | `node_status_icon_textoutputfalse_inactive` | — |
| 8 | `node_duration_text output` | `node_status_icon_textoutputfalse_inactive` | — |

---

## External dependencies

- `src/lfx/src/lfx/components/flow_controls/conditional_router.py` — owns the routing logic; `evaluate_condition`, `update_build_config`, and `iterate_and_stop_once` together implement the active/inactive branch behavior, case-sensitivity, and the regex hides-`case_sensitive` side-effect the spec asserts.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeStatus/index.tsx` (or equivalent) — emits the `node_duration_*` and `node_status_icon_*_inactive` test IDs consumed by the assertions.
- `src/frontend/src/components/core/parameterRenderComponent/components/dropdownComponent/index.tsx` — owns the `value-dropdown-dropdown_str_*` trigger and the Radix Select `role="option"` options used by `selectOperator`.
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions`/`closeAdvancedOptions` (clicks `edit-fields-button`). Used by `exposeCaseSensitive` and by the regex side-effect assertion.
- `tests/helpers/ui/zoom-out.ts` and `tests/helpers/ui/adjust-screen-view.ts` — used to fit all three nodes in the visible canvas before wiring.

---

## What this test does not cover

- Operators `not equals`, `starts with`, `ends with`, `less than`, `less than or equal`, `greater than or equal`. The text operators all share `evaluate_condition` plumbing covered by tests 1–4 + 6–7; the remaining numeric operators are skipped because they all use the same `float(...)` cast covered by test 8.
- Non-numeric input to a numeric operator (the Python `ValueError` fallback returning `False`). Documented in the source but not exposed in the public docs; tracked as `[ ]` in QA-CHECKLIST.md §3.8.
- `max_iterations` and `default_route` cycle-handling behavior. Requires a flow with a cycle which is out of scope for a single-step regression.
- Playground end-to-end (`ChatInput → If-Else → ChatOutput`). The routing assertion does not depend on which input source feeds `input_text`, and tests 1–8 already prove the routing logic.
- Advanced field `true_case_message` / `false_case_message`: left empty for every scenario. Their custom-message routing is a separate behavior tested elsewhere.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required — If-Else is pure text comparison.

---

## Notes

- Stability: 3 / 3 PASS for the original 2 tests (~16–23 s). New scenarios will be re-validated with the same pipeline (typecheck + lint + stability + force-fail + trace + backend audit) before commit.
- Force-fail probe pattern: temporarily change the active-branch `node_duration_*` `toHaveCount(1)` to `toHaveCount(99)` for one representative scenario per setup variant (default, exposed case_sensitive, switched operator). Confirm failure at the expected line, revert, re-pass.
- The two Text Output components are dragged via `dragTo` to avoid the default-stack issue noted in the project memory (two sidebar `+` clicks land in the same position).
- Operator dropdown options are selected via `getByRole("option", { name: operatorName, exact: true })` — the dropdown is Radix Select, which exposes stable accessible names. Selecting by `role` instead of testid avoids depending on the option's index suffix in the DOM, which historically drifts as new operators are added.
- The `case_sensitive` BoolInput uses testid `toggle_bool_case_sensitive` with `role="switch"`; toggling once flips from ON to OFF.

### Reliability decisions (independent review, @stable promotion)

- **Routing is proven by a dual assertion, not a single-sided one.** Every routing scenario asserts both that the *expected-active* branch built (`node_duration_<name>`) **and** that the *expected-inactive* branch was skipped (`node_status_icon_<name>_inactive`). An inverted or mis-wired connection therefore fails the named assertion — it cannot pass green. This is why the `.first()`/`.last()` handle selection in the build helper, while DOM-order-dependent, cannot silently route to the wrong branch undetected.
- **Result assertions carry an explicit `timeout: 30000`** instead of relying on the 5 s default `expect` timeout or fixed `waitForTimeout` sleeps. The `node_duration_*` testid renders only after the per-node `validationStatus.duration` lands, which can trail the "built successfully" toast; the generous web-first timeout absorbs that gap without sleeping.
- **The build helper waits for `sidebar-search-input` to be visible** after the blank-flow transition before interacting — clicking immediately could resolve a node that is then detached mid-render (observed once under 5-worker parallelism).
- **`/api/v1/flows/` 500s under parallelism are logged but non-fatal** by the fixture (only flow-execution errors fail a test). They reflect SQLite contention on concurrent flow creation, not an If-Else regression; the routing assertions still run against the created flow.
