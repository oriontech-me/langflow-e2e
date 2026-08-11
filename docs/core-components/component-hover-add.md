# Spec: Component Hover-to-Add — Plus Icon Affordance

**Test file:** `tests/tests-automations/regression/core-components/componentHoverAdd.spec.ts`

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev23`)

---

## What this test validates

Confirms the sidebar's hover-to-reveal affordance for the **Plus icon** that adds a component to the canvas with a single click. The Plus icon is intentionally hidden (`opacity-0`) on `sm+` viewports until the user hovers the corresponding sidebar row, at which point Tailwind's `group-hover/draggable:opacity-100` brings the icon into view. Clicking it appends the component to the flow without requiring drag-and-drop.

The test covers three contracts in one flow:

1. **Initial-state contract** — without hover, the Plus icon is rendered with computed `opacity: 0`, asserting the affordance is not visible to the user by default.
2. **Hover-reveal contract** — after hovering the component row, the Plus icon's computed `opacity` reaches `1`. This proves the `group-hover/draggable:opacity-100` class is wired up — without this assertion, a regression that removes the hover class would still pass because Playwright can click an `opacity: 0` element that receives pointer events.
3. **Click contract** — clicking the revealed Plus icon adds a `.react-flow__node` to the canvas.

### Which element is the hover group, and which one holds the "+" — #1384

The affordance spans **two sibling elements**, and the spec addresses each by the
role it plays. Upstream's a11y pass (`langflow-ai/langflow#14250`, commit
`46d25720c2`, on the `release-1.12.0` line the nightly is cut from) split the
sidebar row in two:

| Element | testid | Role in this spec |
|---|---|---|
| Hover group (`group/draggable`) | `input_output_chat input_draggable` | The parent whose `:hover` drives `group-hover/draggable:opacity-100` — and the **only** ancestor the "+" button is inside. |
| Label row (`role="button"`, `tabIndex={0}`) | `input_outputChat Input` | Icon + display name. What the user points at; the hover target this spec moves the mouse to. |
| Add button (`tabIndex={-1}`) | `add-component-button-chat-input` → `icon-Plus` | Lives in a `flex shrink-0` container that is a **sibling** of the label row, not a descendant. |

Before that commit the "+" was *inside* `input_outputChat Input`, so the spec
chained `getByTestId("input_outputChat Input").getByTestId("icon-Plus")` and it
resolved. After it, that chain matches nothing while the row testid itself stays
visible — which is exactly how the failure read on the 2026-08-10 daily
(`toBeAttached()` failed, one line after the row was asserted visible). The
affordance itself never broke: the reveal classes still live on the Plus icon and
still key off `group-hover/draggable`.

The spec keeps hovering the **label row** rather than the group, on purpose: the
label row does not contain the "+", so a reveal observed from there proves the
*group* hover is what wires it, not the pointer happening to sit on the button.

Mid-transition opacity values are intentionally not asserted. The hover-reveal contract uses Playwright's auto-waiting `expect(...).toHaveCSS("opacity", "1", { timeout: 3000 })`, which retries until the Tailwind transition has settled on the final value. The hover itself is dispatched via `page.mouse.move()` to the row's bounding-box centre (called twice — once to land, once to lock) instead of `locator.hover()`; the locator-based hover proved flaky here because the cursor effectively left the `group/draggable` parent between polls and the transition unwound back to `opacity: 0`. The earlier attempt with `expect.poll` had the same root cause and was removed.

---

## Tags

`@release` `@stable` `@components` `@workspace`

---

## Step by step

1. Bootstrap and open a blank flow.
2. Wait for the sidebar search input to be visible.
3. Type `chat input` into the search input.
4. Wait for the `input_output_chat input_draggable` hover group and its `input_outputChat Input` label row to be visible in the sidebar.
5. Assert the Plus icon (`icon-Plus` inside the hover group) is attached to the DOM and has computed `opacity: "0"`.
6. Read the bounding box of the **label row** and dispatch `page.mouse.move()` to its centre twice (lands and locks the hover position) — the pointer is deliberately parked away from the "+" button.
7. Assert the Plus icon's computed `opacity` reaches `"1"` (`toHaveCSS` with a 3 s timeout — auto-waits for the Tailwind transition to settle on the revealed state).
8. Click the Plus icon.
9. Assert at least one `.react-flow__node` is visible on the canvas.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After search `chat input` | `input_output_chat input_draggable` group and its `input_outputChat Input` label row are visible within 10 s |
| Before hover | `icon-Plus` (inside the group) computed `opacity === "0"` |
| After hovering the LABEL row (before click) | `icon-Plus` computed `opacity === "1"` within 3 s |
| After hover + click | At least one `.react-flow__node` is visible within 10 s |

---

## External dependencies

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx` — owns the `group/draggable` parent, the row/button split described above, and the `sm:opacity-0 group-hover/draggable:opacity-100` classes on the Plus icon. Any change to these classes (e.g., removing the `sm:` breakpoint or the `group-hover` modifier) breaks the affordance under test; moving the "+" button to another ancestor breaks the locator instead (#1384).
- `src/frontend/src/components/common/genericIconComponent/index.tsx` — renders the `icon-Plus` test ID consumed by the spec.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/index.tsx` — sidebar search routing; renaming the `sidebar-search-input` test ID breaks step 2.

---

## What this test does not cover

- The animated opacity transition itself (mid-transition values). The CSS uses `transition-all`, but the test asserts only the boundary states — initial `opacity: 0`, settled `opacity: 1` after hover, and a successful click that produces a node.
- Keyboard-driven adding (`Enter` / `Space` on the focused row) — covered by `ui-ux/keyboardComponentSearch.spec.ts`. This spec makes no accessibility assertions.
- The **focus-within** reveal (`group-focus-within/draggable:opacity-100`, added by the same #14250 pass) — the icon is also revealed when something inside the group takes focus. Only the hover path is asserted here.
- Drag-and-drop from the sidebar, and double-click on the sidebar card (both covered by `ui-ux/sidebar-add-component.spec.ts` — `flow-functionality/dragAndDrop.spec.ts`, despite its name, imports a flow **file** dropped on the home page and never touches the sidebar).
- Below-`sm` viewports where `sm:opacity-0` does not apply and the Plus icon is permanently visible.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- Default Playwright Desktop Chrome viewport (1280×720) — wide enough to apply `sm:opacity-0`.
- No model provider credentials required.

---

## Notes

- Refactored from `waitForSelector` + `toBeGreaterThanOrEqual(0)` (which always passed for any non-negative number) to a three-assertion contract (initial opacity 0, post-hover opacity 1, click produces a node).
- The post-hover assertion uses `expect(plusIcon).toHaveCSS("opacity", "1", { timeout: 3000 })` paired with a double `page.mouse.move()` to the row's bounding-box centre. The mouse-based hover (instead of `locator.hover()`) keeps the cursor parked over the `group/draggable` parent for the duration of the `toHaveCSS` poll; without that, `componentLocator.hover()` proved 50/50 flaky here because the cursor left the group between polls and the transition unwound back to `opacity: 0`.
- **Flow cleanup (added in #1384).** The spec bootstraps through the UI, so the flow it works on is created by the app; nothing deleted it and the local instance had accumulated **14** `New Flow` orphans. `trackCreatedFlows` now captures every `POST /api/v1/flows` → 201 the page makes and `afterEach` deletes those ids (shared helper, #1108). Verified behaviourally: with the tracker the instance's flow count is unchanged across a run (15 → 15); with it disabled the same run leaks one (15 → 16).
- Force-fail probes on the final `.react-flow__node` visibility assertion confirm the test catches real regressions.
- Validated with `--retries=0` and `--trace=on`, zero backend errors and zero flow errors.
