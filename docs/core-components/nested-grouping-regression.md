# Nested / Grouping — Group, Ungroup and Collapse/Expand

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates the `Nested / Grouping` behaviors listed in QA-CHECKLIST section 3.7 **and the three §15.6 Grouping items** (#942), which are the same product surface reached from the canvas:

1. **Nested component / Create component group** — when two connected non-IO components are box-selected on the canvas and the SelectionMenu "Group" button is clicked, the two source nodes are replaced by a single `title-Group` node on the outer canvas. The original component titles must be gone, proving the components were nested inside the Group rather than renamed.

2. **Enter and exit grouped component / Ungroup components** — right-clicking a `title-Group` node and triggering "Ungroup" must restore the original components and the edge that connected them on the outer canvas. Modern Langflow does not expose a separate nested-canvas view; "enter/exit grouped component" maps to the Group / Ungroup round-trip via `expandGroupNode` in `reactflowUtils.ts`, and the round-trip itself is what guarantees the data fidelity.

3. **Expand/collapse group** — a Group node collapses and expands from its own right-click toolbar, and the state survives autosave. Collapsed, the node keeps only its `Group` title, its field rows disappear, and every handle carries `.no-show`; expanded, the field rows and live handles come back. The toolbar entry is state-dependent: `minimize-button-modal` ("Minimize") while expanded, `expand-button-modal` ("Expand") while collapsed. Both directions are asserted on the DOM **and** on the persisted `data.showNode` read back from `GET /api/v1/flows/{id}`.

If any of these fails, grouping is broken in the product: selections cannot be collapsed into reusable subflows, ungrouping loses the encapsulated wiring, or a collapsed group silently reopens (or fails to reopen) after a reload.

### The product's grouping contract (measured, 1.12.0.dev8)

The Group button is **disabled** unless the selection satisfies all four rules in `validateSelection`. Verbatim from the shipped bundle:

| Condition | Message shown on the disabled button |
|---|---|
| fewer than 2 nodes selected | `Please select more than one component` |
| any selected node is an input or output component | `Select non-input/output components only` |
| more than one selected node has a free output | `Select only one component with free outputs` |
| any selected node has neither an incoming nor an outgoing edge | `Select only connected components` |

Rule 2 is why the fixture is Prompt Template → Language Model: **Chat Input and Chat Output can never be grouped.** When the selection is invalid the button renders as `error-group-node` and is `disabled`; when valid it renders as `group-node` and is enabled. The three inherited specs deleted by #942 all attempted to group Chat Input + Chat Output — a product-forbidden selection — and passed anyway through fallback branches.

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

**Test 3 — a Group node collapses and expands, and the state is persisted**
1. Repeat the setup and grouping steps from Test 1
2. Poll `GET /api/v1/flows/{id}` until the grouped shape has landed (canvas autosave is debounced — an immediate read still returns the two ungrouped nodes): exactly one node, `data.type === "GroupNode"`, `data.node.flow` non-null, and `data.showNode` **absent**. Record the expanded node's height
3. Right-click the Group title; assert the toolbar shows `minimize-button-modal` and **not** `expand-button-modal`; click it
4. Assert the collapsed DOM: the node's height shrank, `title-input` and `title-language model` have count 0, `title-Group` is still visible, and every `.react-flow__handle` carries `.no-show`
5. Poll the persisted flow until `data.showNode === false`
6. Right-click the Group title again; assert the toolbar now shows `expand-button-modal` and **not** `minimize-button-modal`; click it
7. Assert the expanded DOM: height back above the collapsed height, `title-input` and `title-language model` visible again, zero `.react-flow__handle.no-show`
8. Poll the persisted flow until `data.showNode === true`

---

## Validation criterion *(required)*

- After grouping: exactly 1 node on the outer canvas, titled `Group`, with the two original component titles absent; persisted `data.type === "GroupNode"` with a non-null `data.node.flow`
- After ungrouping: exactly 2 nodes on the outer canvas, both original titles visible, exactly 1 edge connecting them, and `Group` title absent
- After collapsing: the Group node's field rows (`title-input`, `title-language model`) are gone, its height shrank, every handle carries `.no-show`, and the persisted `data.showNode` is `false`. After expanding, all four observations invert and `data.showNode` is `true`
- The persisted `showNode` walks `absent → false → true`, and the test asserts all three states. A **new Group node carries no `showNode` key at all** — `reactflowUtils` builds it as `{ data: { id, type: "GroupNode", node: { display_name: "Group", …, flow } }, id, position, type: "genericNode" }`, so "expanded" is the implicit default and the first collapse is what writes the flag. The helper normalises the missing key to `null` rather than `undefined`, because `toEqual` silently ignores undefined properties and the assertion would otherwise be vacuous
- The toolbar entry is mutually exclusive per state — `minimize-button-modal` XOR `expand-button-modal` — which is what distinguishes a real state change from a re-render
- The Group button (`group-node` testid) gates on `validateSelection` from `reactflowUtils.ts` — the asset is intentionally a 2-node non-IO subset of the Basic Prompting starter so the selection passes validation as a single action

---

## External dependencies *(required)*

- `src/frontend/src/utils/reactflowUtils.ts` — hosts `validateSelection` (rejects IO nodes and sticky-note overlaps) and `expandGroupNode` (the ungroup mutation); changes here can silently disable the Group button or break the ungroup round-trip
- `src/frontend/src/pages/FlowPage/components/PageComponent/index.tsx` — owns the `lastSelection` state and the `handleGroupNode` useCallback wired to the SelectionMenu's Group button; the click-registration timing is sensitive to changes in the `onSelectionChange` / `selectionMenuVisible` lifecycle here
- `src/frontend/src/pages/FlowPage/components/SelectionMenuComponent/` — renders the Group button; the `data-testid="group-node"` selector and the visibility transition (50ms `isTransitioning` toggle) live here
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/index.tsx` — renders the right-click toolbar that exposes Ungroup as `group-button-modal`; the `isGroup &&` conditional must remain for Test 2 to pass. The same toolbar owns the collapse/expand entries (`minimize-button-modal` / `expand-button-modal`) that Test 3 drives. On a Group node the toolbar contract is `Save · Duplicate · Copy · Docs · Minimize|Expand · Ungroup · Download · Delete` — it swaps **Freeze** (present on a normal component, see `docs/ui-ux/right-click-dropdown.md`) for **Ungroup**
- `tests/assets/flows/two-non-io-connected.json` — committed flow asset (Prompt Template → Language Model, positions explicitly set); rebuild via Langflow UI if upstream schema changes break the POST `/api/v1/flows/` body validation

---

## What this test does not cover *(optional)*

- Grouping selections that include IO nodes (ChatInput/ChatOutput) — explicitly rejected by `validateSelection` and out of scope
- Grouping selections that overlap sticky notes — also rejected by `validateSelection`
- Multi-step nesting (grouping a Group node inside another Group)
- Editing nodes *inside* the Group after collapsing (Langflow exposes this only via Ungroup → edit → re-group, not via a separate nested-canvas view)
- Grouping more than 2 nodes — the round-trip property is the same and adding more nodes does not exercise additional code paths
- **The cosmetic error toast raised by the grouping mutation.** Grouping pops *"Error while updating the Component — An unexpected error occurred while updating the Component"* while the operation fully succeeds: measured on 1.12.0.dev8, the `PATCH /api/v1/flows/{id}` that persists the grouped shape returns **200 OK**, the console logs zero errors, and no request fails. The toast is a user-visible lie about a successful action. It is filed upstream and recorded under `docs/upstream-bugs/`; these tests deliberately do **not** assert its absence, which would hold §15.6 red on a purely cosmetic defect. Revisit once the upstream fix lands
- The disabled-button messages themselves. The four `validateSelection` rules are documented above and exercised implicitly (the fixture is built to satisfy them), but no test drives an invalid selection to assert the exact wording

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
- **Three inherited specs were deleted by #942** in favour of consolidating §15.6 here. Per-test disposition, so the removal is auditable:

  | Deleted test | Why |
  |---|---|
  | `flow-functionality/group.spec.ts` → *group and ungroup updating values* | 100% `test.skip` with a `// TODO: fix this test`; its only "assertions" were un-awaited `isVisible()` calls whose results were discarded |
  | `group-expand-collapse.spec.ts` → *selecting multiple nodes … shows Group button* | asserted `hasGroupBtn \|\| selectedCount >= 1`, which passes whenever any node is selected |
  | `group-expand-collapse.spec.ts` → *group node is created after grouping* | `if (!hasGroupBtn) { assert 2 nodes still exist; return }` — grouping being broken made it pass |
  | `group-expand-collapse.spec.ts` → *group node can be ungrouped* | same escape branch, asserting only that the first node is visible |
  | `group-enter-exit.spec.ts` → *Two components can be selected and grouped* | both branches end at `expect(firstNode).toBeVisible()`; the grouped case is never required |
  | `group-enter-exit.spec.ts` → *Grouped component can be expanded (entered)* | logs `"Group functionality not available in this mode, skipping"` and `return`s green |
  | `group-enter-exit.spec.ts` → *Group can be ungrouped back to individual components* | can finish with zero assertions executed via two nested `return`s |

  All six used Chat Input + Chat Output — a selection `validateSelection` **forbids** (rule 2) — so none of them ever grouped anything. A baseline run on 1.12.0.dev8 was 6/6 green while leaking 6 flows (no cleanup, no `@stable`, so the daily never surfaced it). Coverage removed: none. Coverage added: Test 3
