# Spec: If-Else Component — Routing Regression

**Test file:** `tests/tests-automations/regression/core-components/if-else-component-regression.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

Covers the routing contract of the **If-Else** (ConditionalRouter) component across the operator surface: every text operator (equals, contains, regex), the `case_sensitive` toggle (default ON / explicit OFF), and all four numeric operators (`greater than`, `less than`, `less than or equal`, `greater than or equal`) — which share the same `float(...)` cast in `evaluate_condition`. Each scenario is a separate `test()` so a failure pinpoints the exact behavior that regressed.

The two "or equal" numeric scenarios deliberately use **equal operands** (`5` vs `5`): that boundary is the distinctive case that separates `<=`/`>=` from their strict counterparts (`5 < 5` and `5 > 5` are both `False`), so a regression that swaps an inclusive operator for a strict one flips the routed branch and fails the assertion. The `less than` scenario uses a decimal operand (`2.5`) to exercise the `float(...)` parse on a non-integer, distinct from `greater than`'s integer inputs (scenario 8).

For every scenario except the regex side-effect test, the assertion surface is the canvas node status: `node_duration_<name>` testid for the branch that built (active) and `node_status_icon_<name>_inactive` testid for the branch that was skipped. This is the same surface used by `flow-functionality/general-bugs-reset-flow-run.spec.ts` and is more reliable than message-content assertions because the component returns an empty Message on the inactive branch (so message presence alone cannot distinguish the routes).

> **Branch sinks use Chat Output (not the legacy Text Output).** Langflow marked Text Input/Output `legacy: true` and the sidebar hides legacy components by default, so the two terminal sinks were migrated to **Chat Output**. Chat Output is added minimized — the build helper expands each one (`expandFocusedNode`) so the run button and the `shownode` input handle are present in the DOM. See #362.

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
| 9 | `less than` (numeric, decimal) match | less than | 2.5 | 10 | default | True | False |
| 10 | `less than or equal` equality boundary | less than or equal | 5 | 5 | default | True | False |
| 11 | `greater than or equal` equality boundary | greater than or equal | 5 | 5 | default | True | False |

All eleven scenarios are introduced in this spec; there is no pre-existing implementation elsewhere. Scenarios 9–11 were added under issue #822 (Wave 3 coverage) to close the "other numeric operators" gap in `QA-CHECKLIST.md` §3.8.

---

## Shared setup helper

`buildIfElseRoutingFlow(page)` (defined in the spec):

1. Bootstrap and open a blank flow, **capturing the created flow id** from the `POST /api/v1/flows` 201 response (not the transient canvas-URL id) so each test's flow can be deleted id-scoped in `afterEach`.
2. Add the **If-Else** component from the sidebar.
3. Zoom out so two more components fit.
4. Drop two **Chat Output** components onto the canvas (positions: `{100, 100}` and `{200, 400}`), expanding each one after it is added (Chat Output is added minimized).
5. Rename the second Chat Output to `chatoutputfalse` so its testid suffix is stable.
6. Wire `handle-conditionalrouter-shownode-true-right` → first Chat Output's `inputs-left` handle.
7. Wire `handle-conditionalrouter-shownode-false-right` → `chatoutputfalse`'s `inputs-left` handle.

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
| 1 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | — |
| 2 | `node_duration_chatoutputfalse` | `node_status_icon_chat output_inactive` | — |
| 3 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | — |
| 4 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | — |
| 5 | — | — | After switching to `regex`, opening edit-fields shows `toHaveCount(0)` for `showcase_sensitive`. With `equals`, count is `1`. |
| 6 | `node_duration_chatoutputfalse` | `node_status_icon_chat output_inactive` | — |
| 7 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | — |
| 8 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | — |
| 9 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | `2.5 < 10` → True branch builds |
| 10 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | `5 <= 5` → True branch builds (strict `<` would route False) |
| 11 | `node_duration_chat output` | `node_status_icon_chatoutputfalse_inactive` | `5 >= 5` → True branch builds (strict `>` would route False) |

---

## External dependencies

- `src/lfx/src/lfx/components/flow_controls/conditional_router.py` — owns the routing logic; `evaluate_condition`, `update_build_config`, and `iterate_and_stop_once` together implement the active/inactive branch behavior, case-sensitivity, and the regex hides-`case_sensitive` side-effect the spec asserts.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeStatus/index.tsx` (or equivalent) — emits the `node_duration_*` and `node_status_icon_*_inactive` test IDs consumed by the assertions.
- `src/frontend/src/components/core/parameterRenderComponent/components/dropdownComponent/index.tsx` — owns the `value-dropdown-dropdown_str_*` trigger and the Radix Select `role="option"` options used by `selectOperator`.
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions`/`closeAdvancedOptions` (clicks `edit-fields-button`). Used by `exposeCaseSensitive` and by the regex side-effect assertion.
- `tests/helpers/ui/zoom-out.ts` and `tests/helpers/ui/adjust-screen-view.ts` — used to fit all three nodes in the visible canvas before wiring.

---

## What this test does not cover

- Operators `not equals`, `starts with`, `ends with`. These text operators all share the `evaluate_condition` plumbing already covered by tests 1–4 + 6–7. (The numeric operators `less than`, `less than or equal`, `greater than or equal` ARE now covered — scenarios 9–11.)
- Non-numeric input to a numeric operator (the Python `ValueError` fallback returning `False`). Documented in the source but not exposed in the public docs; tracked as `[ ]` in QA-CHECKLIST.md §3.8.
- `max_iterations` and `default_route` cycle-break behavior. This lives on the **If-Else** component (`conditional_router.py`: `max_iterations`, `default_route`, `iterate_and_stop_once`) and only fires when the router sits inside a **graph cycle**. **Not implementable as a standalone If-Else feedback loop** — confirmed live on nightly `1.12.0.dev3` under `#891` (follow-up of `#822`):
  - A feedback edge `ConditionalRouter.true_result → TypeConverter.input_data → ConditionalRouter.match_text` **can** be created in the UI and **persists** in the flow JSON (verified: `PATCH` a hand-encoded `xy-edge__` edge → `GET` returns the `TypeConverter → ConditionalRouter` edge).
  - But the persisted feedback edge **does not make the graph iterate**: on build the run schedules only the terminal vertex, the router builds **once** with empty output, and no `"You must specify a max_iterations if the graph is cyclic"` guard fires (`is_cyclic` stays false). Same result #822 saw across `POST /api/v1/build/{id}/flow`, `/api/v2/workflows`, and `/api/v1/run`.
  - Root cause (source, `lfx/graph/edge/base.py`): Langflow forms a graph **cycle** only through a **loop-aware target handle** (`target_handle.type is None`, built via `from_loop_target_handle`), which `LoopComponent`'s ports (e.g. `item`) provide. The router's `match_text` is a regular `MessageTextInput` field-input (`type: "str"`), so a feedback edge into it is a normal edge, never a loop edge — the SCC is not registered and the router never re-runs. `conditional_router.py`'s cycle-break logic therefore only activates when the router already sits inside a **Loop-component-created cycle**, not as a standalone router feedback loop.
  - Filed upstream as a product/design clarification (see `#891` for the ticket link). If a Loop-hosted topology is later shown to iterate the router and trigger the break, this can be revisited as a dedicated spec.
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
- The two Chat Output components are dragged via `dragTo` to avoid the default-stack issue noted in the project memory (two sidebar `+` clicks land in the same position).
- Operator dropdown options are selected via `getByRole("option", { name: operatorName, exact: true })` — the dropdown is Radix Select, which exposes stable accessible names. Selecting by `role` instead of testid avoids depending on the option's index suffix in the DOM, which historically drifts as new operators are added.
- The `case_sensitive` BoolInput uses testid `toggle_bool_case_sensitive` with `role="switch"`; toggling once flips from ON to OFF.

### Flow cleanup (added under #822)

Every test builds a flow on a blank canvas, which Langflow autosaves. The spec now captures each flow's id from its creation `POST /api/v1/flows` 201 response and deletes ONLY that id in an `afterEach` (scoped teardown), navigating to `/` first and passing an explicit `Authorization` header via `getAuthToken(page.request)` — `page.request` is unauthenticated under AUTO_LOGIN and would 401 otherwise. Never `cleanAllFlows` / name-scoped / diff-based wipes: they kill flows other parallel workers are actively driving (#553). Reference implementation: `loop-component-regression.spec.ts`.

### Reliability decisions (independent review, @stable promotion)

- **Routing is proven by a dual assertion, not a single-sided one.** Every routing scenario asserts both that the *expected-active* branch built (`node_duration_<name>`) **and** that the *expected-inactive* branch was skipped (`node_status_icon_<name>_inactive`). An inverted or mis-wired connection therefore fails the named assertion — it cannot pass green. This is why the `.first()`/`.last()` handle selection in the build helper, while DOM-order-dependent, cannot silently route to the wrong branch undetected.
- **Result assertions carry an explicit `timeout: 30000`** instead of relying on the 5 s default `expect` timeout or fixed `waitForTimeout` sleeps. The `node_duration_*` testid renders only after the per-node `validationStatus.duration` lands, which can trail the "built successfully" toast; the generous web-first timeout absorbs that gap without sleeping.
- **The build helper waits for `sidebar-search-input` to be visible** after the blank-flow transition before interacting — clicking immediately could resolve a node that is then detached mid-render (observed once under 5-worker parallelism).
- **`/api/v1/flows/` 500s under parallelism are logged but non-fatal** by the fixture (only flow-execution errors fail a test). They reflect SQLite contention on concurrent flow creation, not an If-Else regression; the routing assertions still run against the created flow.
