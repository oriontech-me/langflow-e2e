# Spec: Component Hover-to-Add — Plus Icon Affordance

**Test file:** `tests/tests-automations/regression/core-components/componentHoverAdd.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

Confirms the sidebar's hover-to-reveal affordance for the **Plus icon** that adds a component to the canvas with a single click. The Plus icon is intentionally hidden (`opacity-0`) on `sm+` viewports until the user hovers the corresponding sidebar row, at which point Tailwind's `group-hover/draggable:opacity-100` brings the icon into view. Clicking it appends the component to the flow without requiring drag-and-drop.

The test covers two contracts in one flow:

1. **Initial-state contract** — without hover, the Plus icon is rendered with computed `opacity: 0`, asserting the affordance is not visible to the user by default.
2. **Click contract** — after hovering the component row and clicking the Plus icon, a `.react-flow__node` appears on the canvas.

The hover-to-reveal CSS transition itself (opacity going from `0` to `1`) is not asserted because Playwright's `expect.poll` interleaves with the running transition in a way that yields false negatives; the initial `opacity: 0` assertion plus the successful click are sufficient to prove the feature works end-to-end.

---

## Tags

`@release` `@stable` `@components` `@workspace`

---

## Step by step

1. Bootstrap and open a blank flow.
2. Wait for the sidebar search input to be visible.
3. Type `chat input` into the search input.
4. Wait for the `input_outputChat Input` row to be visible in the sidebar.
5. Assert the Plus icon (`icon-Plus` inside that row) is attached to the DOM and has computed `opacity: "0"`.
6. Hover the component row.
7. Click the Plus icon.
8. Assert at least one `.react-flow__node` is visible on the canvas.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After search `chat input` | `input_outputChat Input` row is visible within 10 s |
| Before hover | `icon-Plus` computed `opacity === "0"` |
| After hover + click | At least one `.react-flow__node` is visible within 10 s |

---

## External dependencies

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx` — owns the `group/draggable` parent and the `sm:opacity-0 group-hover/draggable:opacity-100` classes on the Plus icon. Any change to these classes (e.g., removing the `sm:` breakpoint or the `group-hover` modifier) breaks the affordance under test.
- `src/frontend/src/components/common/genericIconComponent/index.tsx` — renders the `icon-Plus` test ID consumed by the spec.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/index.tsx` — sidebar search routing; renaming the `sidebar-search-input` test ID breaks step 2.

---

## What this test does not cover

- The animated opacity transition itself (mid-transition values). The CSS uses `transition-all`, but the test asserts only the boundary states (initial `0` + functional click).
- Keyboard-driven activation of the Plus button (`Enter` / `Space` while focused). Step 5's `awaitBootstrapTest` and the `data-testid` lookup are the only accessibility coverage.
- Drag-and-drop from the sidebar (covered by `dragAndDrop.spec.ts`).
- Below-`sm` viewports where `sm:opacity-0` does not apply and the Plus icon is permanently visible.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- Default Playwright Desktop Chrome viewport (1280×720) — wide enough to apply `sm:opacity-0`.
- No model provider credentials required.

---

## Notes

- Refactored from `waitForSelector` + `toBeGreaterThanOrEqual(0)` (which always passed for any non-negative number) to a deterministic two-assertion contract.
- Force-fail probe on the final `.react-flow__node` visibility assertion confirms the test catches real regressions.
- Validated with `--retries=0` and `--trace=on`, zero backend errors and zero flow errors.
