# Spec: Show Legacy Components toggle — sidebar visibility

**Test file:** `tests/tests-automations/regression/core-components/legacy-components-toggle-regression.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

The sidebar **Show Legacy Components** toggle (`sidebar-legacy-switch`, under the
`sidebar-options-trigger` options panel) controls whether legacy components are
listed in the components sidebar.

The test uses **Python REPL** as its target component because it is a clean
legacy case: `legacy = True`, category `tools`, and — crucially — its non-legacy
substitute has a different display name (**Python Interpreter**, category
`utilities`), so searching for `"Python REPL"` cannot accidentally match the
replacement. The component's item testid in the sidebar is `toolsPython REPL`
(built as `sectionName + display_name` in `sidebarDraggableComponent.tsx`).

The behaviour is proven by a **count transition**, in a single `test()` with four
`test.step()`s (state flows across steps — the same `page`):

1. **Open a blank flow** (Arrange).
2. **Baseline (toggle OFF):** searching `"Python REPL"` yields `toHaveCount(0)` —
   the legacy component is not rendered. A **positive control** runs first: the
   non-legacy substitute **Python Interpreter** (`utilitiesPython Interpreter`)
   always matches this search — its internal name is `PythonREPLComponent`, so
   the sidebar surfaces it even when searching `"Python REPL"` — and asserting it
   `toBeVisible()` proves the list actually rendered before the `0` is asserted.
   Without it, `toHaveCount(0)` could resolve against a momentarily empty list
   (filter not yet applied) and pass for the wrong reason. The search narrows the
   list so the `0` is a strong statement ("asked for it by name, absent"), not a
   side effect of list virtualization.
3. **Act:** enable the toggle via the `addLegacyComponents(page)` helper (the
   search is cleared first, because an active search renders a second
   `sidebar-options-trigger` that would trip Playwright strict mode).
4. **Assert (toggle ON):** the same search now yields `toHaveCount(1)`.

The only thing that changes between step 2 and step 4 is the toggle acted on in
step 3, so the `0 → 1` transition is what proves the toggle controls visibility —
the assertion changes result if and only if the behaviour changes.

---

## Tags

`@stable` `@regression` `@components`

---

## Validation criterion

| State | Locator | Expected |
|---|---|---|
| Toggle OFF (positive control) | `getByTestId("utilitiesPython Interpreter")` after searching `"Python REPL"` | `toBeVisible()` (proves the search rendered) |
| Toggle OFF (baseline) | `getByTestId("toolsPython REPL")` after searching `"Python REPL"` | `toHaveCount(0)` |
| Toggle acted on | `getByTestId("sidebar-legacy-switch")` | `toBeChecked()` (asserted inside `addLegacyComponents`) |
| Toggle ON | `getByTestId("toolsPython REPL")` after searching `"Python REPL"` | `toHaveCount(1)` |

The test passes only if the count moves from `0` to `1` across the toggle action.

---

## External dependencies

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx` — emits the per-item testid `sectionName + display_name` (`toolsPython REPL`) consumed by the count assertions.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/featureTogglesComponent.tsx` — owns the `sidebar-legacy-switch` toggle (Radix `Switch`, `role="switch"`/`aria-checked`).
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarHeader.tsx` — owns the `sidebar-options-trigger` button that opens the options panel.
- Python REPL component (`display_name = "Python REPL"`, `legacy = True`, category `tools`) — the target legacy component; its `legacy` flag is what the toggle filters on.
- Python Interpreter component (`display_name = "Python Interpreter"`, internal name `PythonREPLComponent`, `legacy = False`, category `utilities`) — the positive-control anchor; it matches a `"Python REPL"` search (via its internal name) regardless of toggle state, so its visibility proves the search rendered.
- `tests/helpers/flows/add-legacy-components.ts` — `addLegacyComponents(page)`, the shared helper that opens the options panel, flips the legacy switch, asserts `toBeChecked()`, and closes the panel.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required — the test only filters/searches the sidebar.

---

## What this test does not cover

- The **Beta** toggle (`sidebar-beta-switch`) — a sibling toggle with the same mechanics; candidate for its own spec.
- Round-trip (toggle ON → OFF re-hides the component). The `0 → 1` transition already proves the control; the reverse is a nice-to-have, not required for this checklist item.
- Dragging the legacy component onto the canvas / executing it. Out of scope: this spec is about sidebar visibility, not component behaviour.

---

## Notes

- **Force-fail probe (validation step, done):** commenting out the
  `addLegacyComponents(page)` Act made the test fail exactly at the final step
  ("Python REPL is visible while the toggle is ON", `toHaveCount(1)`) with
  `Expected: 1 / Received: 0` — the legacy component stays hidden when the toggle
  is never flipped. The first three steps still passed, so the failure isolates
  to the behaviour under test: no false positive. Restoring the Act returns the
  test to green.
- The helper asserts the switch state via `expect(...).toBeChecked()` (semantic,
  web-first) rather than the Radix `data-state` attribute.
