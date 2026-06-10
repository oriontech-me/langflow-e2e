# Spec: Show Beta Components toggle — sidebar visibility

**Test file:** `tests/tests-automations/regression/core-components/beta-components-toggle-regression.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

The sidebar **Show Beta Components** toggle (`sidebar-beta-switch`, under the
`sidebar-options-trigger` options panel) controls whether beta components are
listed in the components sidebar.

The test uses **Amazon Bedrock Converse** as its target component: `beta = True`,
category `amazon`. Its item testid in the sidebar is `amazonAmazon Bedrock Converse`
(built as `sectionName + display_name` in `sidebarDraggableComponent.tsx`).

Unlike the legacy toggle, the beta toggle **defaults to ON** (`showBeta` is read
from storage with a default of `true` in `flowSidebarComponent/index.tsx`). The
behaviour is therefore proven by an **inverted count transition** (`1 → 0`), in a
single `test()` with four `test.step()`s (state flows across steps — the same
`page`):

1. **Open a blank flow** (Arrange).
2. **Baseline (toggle ON, default):** searching `"Amazon Bedrock"` shows the beta
   component — `getByTestId("amazonAmazon Bedrock Converse")` is `toBeVisible()`.
   No positive control is needed here: a presence assertion is web-first and
   self-waits, so there is no empty-list race to guard against.
3. **Act:** open the options panel, assert the switch is `toBeChecked()` (makes
   the default-ON precondition explicit), flip it OFF, assert `not.toBeChecked()`,
   and close the panel. The search is cleared first, because an active search
   renders a second `sidebar-options-trigger` that would trip Playwright strict
   mode.
4. **Assert (toggle OFF):** the same search now hides the beta component —
   `getByTestId("amazonAmazon Bedrock Converse")` is `toHaveCount(0)`. A
   **positive control** runs first: **Amazon Bedrock Embeddings**
   (`amazonAmazon Bedrock Embeddings`) is neither beta nor legacy, so it always
   matches this search; asserting it `toBeVisible()` proves the list rendered, so
   the `0` means "filtered out by the toggle", not "the list hadn't rendered yet".

The only thing that changes between step 2 and step 4 is the toggle acted on in
step 3, so the `1 → 0` transition is what proves the toggle controls visibility —
the assertion changes result if and only if the behaviour changes.

---

## Tags

`@stable` `@regression` `@components`

---

## Validation criterion

| State | Locator | Expected |
|---|---|---|
| Toggle ON (baseline) | `getByTestId("amazonAmazon Bedrock Converse")` after searching `"Amazon Bedrock"` | `toBeVisible()` |
| Toggle precondition | `getByTestId("sidebar-beta-switch")` (panel open) | `toBeChecked()` before flipping |
| Toggle acted on | `getByTestId("sidebar-beta-switch")` after the click | `not.toBeChecked()` |
| Toggle OFF (positive control) | `getByTestId("amazonAmazon Bedrock Embeddings")` after searching `"Amazon Bedrock"` | `toBeVisible()` (proves the search rendered) |
| Toggle OFF (target) | `getByTestId("amazonAmazon Bedrock Converse")` after searching `"Amazon Bedrock"` | `toHaveCount(0)` |

The test passes only if the count moves from visible (`1`) to absent (`0`) across the toggle action.

---

## External dependencies

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/index.tsx` — reads `showBeta` from storage with a default of `true` (the toggle's default-ON state this spec relies on) and applies `applyBetaFilter` when it is OFF.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx` — emits the per-item testid `sectionName + display_name` (`amazonAmazon Bedrock Converse`) consumed by the assertions.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/featureTogglesComponent.tsx` — owns the `sidebar-beta-switch` toggle (Radix `Switch`, `role="switch"`/`aria-checked`).
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarHeader.tsx` — owns the `sidebar-options-trigger` button that opens the options panel.
- Amazon Bedrock Converse component (`display_name = "Amazon Bedrock Converse"`, `beta = True`, category `amazon`) — the target beta component; its `beta` flag is what the toggle filters on.
- Amazon Bedrock Embeddings component (`display_name = "Amazon Bedrock Embeddings"`, `beta = False`, `legacy = False`, category `amazon`) — the positive-control anchor; it matches an `"Amazon Bedrock"` search regardless of toggle state, so its visibility proves the search rendered.

Flag values (`beta`/`legacy`) and the `amazon` category prefix were confirmed against the running instance's `/api/v1/all` endpoint.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required — the test only filters/searches the sidebar.

---

## Relationship to existing coverage

`tests/tests-automations/regression/ui-ux/filterSidebar.spec.ts` incidentally
toggles `sidebar-beta-switch` while exercising a broader sidebar-filtering flow.
That spec is an inherited, non-`@stable`, undocumented "kitchen-sink" test, and
the beta-toggle assertion there is a side effect rather than its focus. This spec
is the dedicated, isolated, documented, `@stable` home for the beta-toggle
behaviour. The overlap is intentional and not duplicated logic: the two were not
copied from each other, and consolidation of the inherited spec is out of scope
here.

---

## What this test does not cover

- The **Legacy** toggle (`sidebar-legacy-switch`) — covered by its sibling spec `legacy-components-toggle-regression`.
- Round-trip (toggle OFF → ON re-shows the component). The `1 → 0` transition already proves the control; the reverse is a nice-to-have.
- Dragging the beta component onto the canvas / executing it. Out of scope: this spec is about sidebar visibility, not component behaviour.

---

## Notes

- **Force-fail probe (validation step, done):** commenting out the toggle-OFF
  click in the Act made the test fail exactly at the final step ("Amazon Bedrock
  Converse is hidden while the toggle is OFF", `toHaveCount(0)`) with
  `Expected: 0 / Received: 1` — the beta component stays visible when the toggle
  is never flipped. The earlier steps still passed, so the failure isolates to the
  behaviour under test: no false positive. Restoring the Act returns the test to
  green.
- **Blank-flow creation:** the test opens the canvas via the `blank-flow` button
  (the repo's dominant pattern, matching the legacy sibling). Under artificial
  `--repeat-each` stress the UI flow-creation path can emit a transient
  `POST /api/v1/flows/ 500`; the custom fixture classifies this as an `http_error`
  (logged, non-failing) rather than a `flow_error` (failing), and single runs are
  clean. `setupBlankFlow` (API-based creation) would avoid the transient entirely
  but is a minority pattern (one adopter) and would diverge from the sibling spec;
  not adopted here.
- The toggle state assertion uses `expect(...).toBeChecked()` / `not.toBeChecked()`
  (semantic, web-first) rather than the Radix `data-state` attribute.
