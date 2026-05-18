# Spec: If-Else Component — Routing Regression

**Test file:** `tests/tests-automations/regression/core-components/if-else-component-regression.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

Covers the foundational routing contract of the **If-Else** (ConditionalRouter) component for `operator=equals`:

1. **Match → True branch:** when `input_text` exactly equals `match_text`, the True output's downstream node builds successfully and the False output's downstream node is marked **inactive** (skipped).
2. **No-match → False branch:** when `input_text` differs from `match_text`, the False output's downstream node builds and the True output's downstream node is **inactive**.

This contract is the load-bearing behavior of If-Else — every other operator (`contains`, `regex`, numeric comparisons) builds on the same active/inactive routing model. If `equals` routing breaks, the rest of the operator surface breaks with it. The two tests in this spec are scoped to that foundational case; future scenarios (`contains`, `regex`, `case_sensitive`, numeric, `max_iterations`) are listed as unchecked items under QA-CHECKLIST.md §3.8.

The assertion surface is the canvas node status — `node_duration_<name>` testid for the branch that built and `node_status_icon_<name>_inactive` testid for the branch that was skipped. This is the same surface used by `flow-functionality/general-bugs-reset-flow-run.spec.ts` and is more reliable than message-content assertions because the component returns an empty Message on the inactive branch (so message presence alone cannot distinguish the routes).

---

## Tags

`@regression` `@components`

> Not `@stable` initially — the spec is new; promote to `@stable` after a few weekly runs prove it stable.

---

## Step by step (per test)

Both tests share the same setup, parameterized only by `input_text`:

1. Bootstrap and open a blank flow.
2. Add the **If-Else** component from the sidebar.
3. Zoom out so two more components fit.
4. Drop two **Text Output** components onto the canvas (positions: `{100, 100}` and `{200, 400}`).
5. Rename the second Text Output to `textoutputfalse` (so its testid suffix is stable).
6. Wire `handle-conditionalrouter-shownode-true-right` → first Text Output's `inputs-left` handle.
7. Wire `handle-conditionalrouter-shownode-false-right` → `textoutputfalse`'s `inputs-left` handle.
8. Fill `popover-anchor-input-input_text` and `popover-anchor-input-match_text` with the scenario values (`hello`/`hello` for match, `world`/`hello` for no-match).
9. Click the run button on the branch that should activate (`button_run_text output` for True, `button_run_textoutputfalse` for False).
10. Wait for the **built successfully** notification.
11. Assert that the active branch's `node_duration_*` testid has count 1 and the inactive branch's `node_status_icon_*_inactive` testid has count 1.

---

## Validation criterion

| Scenario | Active branch (`toHaveCount(1)`) | Inactive branch (`toHaveCount(1)`) |
|---|---|---|
| `input_text=hello`, `match_text=hello` | `node_duration_text output` | `node_status_icon_textoutputfalse_inactive` |
| `input_text=world`, `match_text=hello` | `node_duration_textoutputfalse` | `node_status_icon_text output_inactive` |

---

## External dependencies

- `src/lfx/src/lfx/components/flow_controls/conditional_router.py` — owns the routing logic; `evaluate_condition` and `iterate_and_stop_once` together implement the active/inactive branch behavior the spec asserts.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeStatus/index.tsx` (or equivalent) — emits the `node_duration_*` and `node_status_icon_*_inactive` test IDs consumed by the assertions.
- `helpers/ui/zoom-out.ts` and `helpers/ui/adjust-screen-view.ts` — used to fit all three nodes in the visible canvas before wiring.

---

## What this test does not cover

- All operators except `equals`. The other 9 operators (`not equals`, `contains`, `starts with`, `ends with`, `regex`, `less than`, `less than or equal`, `greater than`, `greater than or equal`) are exercised only via the underlying `evaluate_condition` Python logic, not via UI regression.
- The `case_sensitive` toggle behavior on text operators.
- The `regex` operator's hide-`case_sensitive` side effect (`update_build_config` real-time refresh).
- The cycle-handling code path (`max_iterations`, `default_route`, `iterate_and_stop_once`).
- The advanced fields `true_case_message` and `false_case_message` — left default (empty Message) for both tests since the assertion surface is node-status, not message content.
- Numeric operators are documented as undocumented (the public docs list 6 operators; the Python source has 10). The numeric branch is therefore not covered until either the docs are updated or the team confirms the numeric surface is intentional.
- Playground end-to-end interaction. The test uses direct `popover-anchor-input-*` fills instead of `ChatInput → Playground` because the routing assertion does not depend on which input source feeds `input_text`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required — If-Else is pure text comparison.

---

## Notes

- Stability: 3 / 3 PASS across consecutive runs (~16–23 s for 2 tests).
- Force-fail probe on the True-branch `node_duration_text output` `toHaveCount(1)` assertion (changed to `99`) failed at the expected line; reverted, re-passed.
- The two ChatInput-positioned Text Output components are dragged via `dragTo` to avoid the default-stack issue noted in the project memory (two sidebar `+` clicks land in the same position).
