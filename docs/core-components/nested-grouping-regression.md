# Nested / Grouping — Group and Ungroup Round-Trip

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the two `Nested / Grouping` behaviors listed in QA-CHECKLIST section 3.7:

1. **Nested component** — when two connected non-IO components are box-selected on the canvas and the SelectionMenu "Group" button is clicked, the two source nodes are replaced by a single `title-Group` node on the outer canvas. The original component titles must be gone, proving the components were nested inside the Group rather than renamed.

2. **Enter and exit grouped component** — right-clicking a `title-Group` node and triggering "Ungroup" must restore the original components and the edge that connected them on the outer canvas. Modern Langflow does not expose a separate nested-canvas view; "enter/exit grouped component" maps to the Group / Ungroup round-trip via `expandGroupNode` in `reactflowUtils.ts`, and the round-trip itself is what guarantees the data fidelity.

If either test fails, grouping/ungrouping is broken in the product: selections cannot be collapsed into reusable subflows, or ungrouping loses the encapsulated wiring.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@components` `@workspace`

---

## Step by step *(required)*

**Test 1 — box-selecting two connected non-IO components and clicking Group collapses them into a single Group node**
1. Create a flow via `POST /api/v1/flows/` using the `two-non-io-connected.json` asset (Prompt Template → Language Model, no IO nodes, no sticky notes)
2. Navigate to "/" and click the flow card matching the randomized flow name (avoids the deep-link cache race that hits `/flow/{id}` directly after API creation)
3. Wait for `canvas_controls_dropdown`, `title-Prompt Template`, `title-Language Model`; call `adjustScreenView`
4. Click the empty React Flow pane to clear any selection; wait for `.react-flow__node.selected` count to drop to 0
5. Shift+drag a box across both nodes' bounding boxes (with 40px padding); wait for `.react-flow__node.selected` count to reach 2 and `getByTestId("group-node")` to be visible
6. Click the Group button (forced click, the button lives inside `@xyflow/react`'s `NodeToolbar` portal)
7. Wait for the Group button to disappear (confirms the mutation committed)
8. Assert `.react-flow__node` count is 1; `title-Group` is visible; `title-Prompt Template` and `title-Language Model` have count 0

**Test 2 — ungrouping a Group node restores the original components and the edge between them**
1. Repeat the setup and grouping steps from Test 1
2. Confirm the Group node is on the canvas (`title-Group` visible, node count 1)
3. Right-click the Group title to open the node toolbar dropdown
4. Click `group-button-modal` (the Ungroup entry — only rendered for Group-typed nodes per `isGroup && <SelectItem value="ungroup">` in `nodeToolbarComponent/index.tsx`)
5. Assert `.react-flow__node` count is back to 2; `.react-flow__edge` count is 1; `title-Group` is gone; `title-Prompt Template` and `title-Language Model` are visible again

---

## Validation criterion *(required)*

- After grouping: exactly 1 node on the outer canvas, titled `Group`, with the two original component titles absent
- After ungrouping: exactly 2 nodes on the outer canvas, both original titles visible, exactly 1 edge connecting them, and `Group` title absent
- The Group button (`group-node` testid) gates on `validateSelection` from `reactflowUtils.ts` — the asset is intentionally a 2-node non-IO subset of the Basic Prompting starter so the selection passes validation as a single action

---

## External dependencies *(required)*

- `src/frontend/src/utils/reactflowUtils.ts` — hosts `validateSelection` (rejects IO nodes and sticky-note overlaps) and `expandGroupNode` (the ungroup mutation); changes here can silently disable the Group button or break the ungroup round-trip
- `src/frontend/src/pages/FlowPage/components/PageComponent/index.tsx` — owns the `lastSelection` state and the `handleGroupNode` useCallback wired to the SelectionMenu's Group button; the click-registration timing is sensitive to changes in the `onSelectionChange` / `selectionMenuVisible` lifecycle here
- `src/frontend/src/pages/FlowPage/components/SelectionMenuComponent/` — renders the Group button; the `data-testid="group-node"` selector and the visibility transition (50ms `isTransitioning` toggle) live here
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/index.tsx` — renders the right-click toolbar that exposes Ungroup as `group-button-modal`; the `isGroup &&` conditional must remain for Test 2 to pass
- `tests/assets/flows/two-non-io-connected.json` — committed flow asset (Prompt Template → Language Model, positions explicitly set); rebuild via Langflow UI if upstream schema changes break the POST `/api/v1/flows/` body validation

---

## What this test does not cover *(optional)*

- Grouping selections that include IO nodes (ChatInput/ChatOutput) — explicitly rejected by `validateSelection` and out of scope
- Grouping selections that overlap sticky notes — also rejected by `validateSelection`
- Multi-step nesting (grouping a Group node inside another Group)
- Editing nodes *inside* the Group after collapsing (Langflow exposes this only via Ungroup → edit → re-group, not via a separate nested-canvas view)
- Grouping more than 2 nodes — the round-trip property is the same and adding more nodes does not exercise additional code paths

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key required (no LLM execution; the test only manipulates the canvas)
- Auth via the standard token helper; the flow is deleted in `afterEach` regardless of outcome

---

## When to review this test *(optional)*

- If `validateSelection` adds new rejection paths (e.g. limits on selection size or new component classes)
- If the SelectionMenu Group button is renamed, gated behind a feature flag, or moved out of the `NodeToolbar` portal
- If the right-click node toolbar dropdown is replaced by a different UI pattern (e.g. a modal) — `group-button-modal` selector would break

---

## Notes *(optional)*

- Earlier (pre-1.10) versions of Langflow had a closure-rebind race in `SelectionMenuComponent` where the Group button's `onClick` could capture a stale `lastSelection` and silently no-op. PR #229 originally shipped with a 5-attempt retry loop around the Group click to mitigate this. On Langflow 1.10.x the race was no longer observed across 15 consecutive runs (10 with the retry loop, 5 without), so the helper was simplified to a single click + `toBeHidden` assertion. If flakiness returns on a future Langflow version, restore the retry approach documented in PR #229's history
- The asset deliberately avoids the Basic Prompting starter template: that template includes ChatInput/ChatOutput (rejected by `validateSelection`) and sticky notes (overlap rejection), which would leave the Group button disabled
- The flow is created via the REST API rather than the canvas drag-and-drop because chaining two sidebar adds stacks the components on the same default position (documented behavior); API creation with explicit `position` values is the only deterministic path
