# Spec: Canvas Pan by Dragging the Empty Pane

**Test file:** `tests/tests-automations/regression/flow-functionality/canvas-pan-drag.spec.ts`

**Last validated:** Langflow 1.13.x

---

## What this test validates

Dragging an **empty area of the canvas pane** pans the viewport: the React Flow
translate moves, and the zoom does not. This is the one canvas-viewport gesture
the suite does not cover anywhere else, and it is the surviving deliverable of
the Wave 9 T2 triage of the canvas viewport cluster (#1910).

**Why this file exists at all, and why it is one test rather than three.** It
replaces `flow-functionality/canvas-scroll-navigation.spec.ts`, whose other two
tests each have a named `@stable` replacement in
`ui-ux/canvas-zoom-navigation.spec.ts`:

| Retired test | Replaced by (all `@stable`) |
|---|---|
| `canvas viewport changes after mouse wheel scroll` | `wheel scroll navigates the canvas anchored at the pointer` |
| `canvas viewport resets to fit view after adjustScreenView` | `Fit View centers every node inside the canvas viewport` |
| `panning canvas by dragging empty area moves viewport` | **nothing — this spec** |

The third had no replacement because it never tested what it was named: it
implemented **Shift + vertical wheel**, not a drag, and asserted only that the
transform string differed afterwards. Shift+drag is React Flow's **marquee**
gesture here (`flow-functionality/canvas-multiselect.spec.ts` uses it for box
selection), so the retired test's own comment — "ReactFlow treats this as
horizontal pan" — described a behavior the build does not have.

The sibling spec routes this behavior here by name:
`ui-ux/canvas-zoom-navigation.spec.ts` declares *"Not covered here
(deliberately): pane drag/pan and node movement (§15.4)"*. That is why the
checklist bullet lands under §15.4 rather than §15.5, where a reader might look
for it first — following an existing documented decision rather than relitigating
it.

## The observable, and why the assertion is causal rather than "it changed"

Every assertion reads the React Flow viewport transform
(`.react-flow__viewport` → `transform: translate(<x>px, <y>px) scale(<z>)`).

Measured live on `1.13.0.dev19`, dragging the pane from `(780, 384)` to
`(930, 500)` — a cursor delta of `(+150, +116)`:

| | transform |
|---|---|
| before | `translate(0px, 0px) scale(1)` |
| after | `translate(150px, 116px) scale(1)` |

The translate delta **equals the cursor delta** and the scale is untouched. So
the spec asserts the equality, not merely that the string differs. The weaker
"it changed" form is what the retired test used, and it passes on any viewport
movement at all — including a wheel event that zoomed instead of panning, which
is the one confusion this gesture is worth testing for.

**The equality is scale-independent, and that is what keeps this spec small.**
React Flow pans in *screen* space, so the translate moves by the cursor delta at
any zoom — not only at `scale(1)`, where screen and flow pixels happen to
coincide. Measured on `1.13.0.dev19` at a non-unit scale, dragging `(+120, +80)`:

| | translate | scale |
|---|---|---|
| before | `210.648px, 141.556px` | `0.578704` |
| after | `330.648px, 221.556px` | `0.578704` |

So the spec does **not** normalize the viewport, does not click `fit_view`, and
never opens the canvas-controls menu. It reads whatever the entry viewport is,
requires only that it has settled, and asserts a *delta*. That sidesteps #1645
by construction rather than by compensating for it: **the entry state is a
product decision no test may depend on** (measured twice on the sibling spec —
clamped at `scale(2)` on `1.12.0.dev6`, fitted on `1.12.0.dev44`), and a spec
that only reads deltas has nothing to depend on.

It also lets the zoom assertion be **byte-identical string equality** on the
`scale(...)` component rather than a float comparison with a tolerance.

## The negative control, and what it is for

The same drag repeated with **Shift held** must leave the transform
**byte-identical**. Measured live on `1.13.0.dev19`: `translate(150px, 116px)
scale(1)` before and after.

Its job is not to test the marquee — it is to give the pan assertion bite. A
test that passed on "the mouse moved across the pane" would pass here too, and
this is the cheapest available proof that it does not. It runs **before** the
pan so the baseline it compares against is the untouched entry viewport.

## Choosing the drag origin — asserted, never assumed

The gesture is only a pan when it starts on empty pane. Starting it on a node
drags the node (§15.4 `canvas-move-node.spec.ts`), and starting it on the
canvas-controls toolbar hits a control. The origin is therefore **verified**
before use, not picked by eye:

- it lies inside the `.react-flow__pane` rect;
- `document.elementFromPoint(x, y)` resolves to `.react-flow__pane` itself.

The `elementFromPoint` check is the load-bearing one: it covers the node boxes,
the controls toolbar, and anything a future build floats over the canvas, in one
condition that cannot silently go stale the way a hardcoded corner would. If no
such point exists the spec **fails naming that**, rather than dragging somewhere
arbitrary and reporting a viewport result about a gesture it never performed.

## Tags

`@stable` `@workspace` `@ui-ux`

`@stable` from the outset: the spec enters `@stable` in the PR that adds it, on
the strength of its VALIDATE burst and its force-fail, not after a seasoning
period.

## Validation criterion

| Step | Criterion |
|---|---|
| Canvas ready | `canvas_controls_dropdown` visible and `title-Chat Input` visible — the canvas-mounted gate used across the suite, never a sidebar element |
| Viewport settled | two consecutive reads of the `transform` are equal before the baseline is taken; the entry transform is applied on hydration and is not animated on this path |
| Origin valid | the chosen point is inside the pane rect **and** `document.elementFromPoint` returns `.react-flow__pane`; no such point ⇒ the test fails naming it |
| Negative control | after Shift+drag along the drag path, the `transform` string is **byte-identical** to the baseline |
| Pan translate | after the plain drag, `translate` moved by the cursor delta on both axes (± 2 px, absorbing React Flow's sub-pixel rounding — both live measurements were exact) |
| Pan zoom | the `scale(...)` component of the transform is **byte-identical** to the baseline's — a pan that changes zoom is the failure this distinguishes, and the equality is exact because React Flow pans in screen space |
| Cleanup | the flow created for the test no longer exists after `afterEach` |

Non-criterion (deliberate): no assertion on the **absolute** translate values, or
on where any node lands on screen. Those depend on the fixture's coordinates and
on the 1000×672 pane of the default 1280×720 viewport, so asserting them would
redden the spec on a viewport-size change that broke nothing — the same
non-criterion the sibling spec states.

## External dependencies

- React Flow (`@xyflow/react`) pane behavior: `panOnDrag` on the left button, and
  Shift+drag reserved for selection. `.react-flow__pane` and
  `.react-flow__viewport` are React Flow's own class names, not Langflow testids,
  and are the only selectors here that upstream React Flow owns.
- `src/frontend/src/components/core/canvasControlsComponent/` —
  `canvas_controls_dropdown`, used only as the canvas-ready gate.
- `tests/assets/flows/chat-io-ok-trace-fixture.json` via
  `createRunnableChatFlowViaApi` — a repo-owned Chat Input → Chat Output graph.
  No starter template, no provider key, no LLM call and no flow build: the spec
  is pure viewport geometry. Reused from `ui-ux/canvas-zoom-navigation.spec.ts`
  rather than re-entering through `awaitBootstrapTest` + `blank-flow` + a sidebar
  add, which is the path the retired spec used and the path that produced its
  `waitForSelector` timeouts and its leaked flows.

Flow cleanup: the flow is created through the API, its id is held by the spec and
deleted in `afterEach` (id-scoped, never a wipe), after the editor is unmounted
so its `GET /flows/{id}/events` poll cannot 404 into the fixture's backend-error
monitor.

## Scenarios

### 15.4.1 Dragging the empty pane pans the canvas without changing the zoom [-]

- **File:** `tests/tests-automations/regression/flow-functionality/canvas-pan-drag.spec.ts`
- **Objective:** prove that a left-button drag starting on empty canvas moves the
  viewport by the cursor delta and leaves the zoom untouched, and that the
  assertion distinguishes that from any other drag on the pane.
- **Precondition:** running instance; flow created via API from the Chat I/O
  fixture; editor open at `/flow/{id}`. No particular entry zoom is required —
  the spec asserts a delta, so any settled viewport will do (#1645).
- **Step by step:**
  1. Wait for `canvas_controls_dropdown` and `title-Chat Input`, then wait for
     the viewport transform to settle (two equal consecutive reads).
  2. Read the baseline `{ x, y, scale }` from `.react-flow__viewport`.
  3. Resolve a drag origin on empty pane and assert both origin conditions
     above; fail naming the condition if none holds.
  4. **Negative control:** press Shift, drag origin → target in steps, release;
     assert the `transform` string is byte-identical to the baseline.
  5. Drag origin → target again with no modifier, in the same steps.
  6. Read the transform and assert the translate delta equals the cursor delta
     (± 2 px) and the scale is unchanged.
- **Validation:** the viewport `translate` moved by exactly the drag delta while
  `scale` held, and the same drag with Shift moved nothing.

## Notes

- **Do not reach for `page.mouse.wheel` here.** Wheel on this canvas *zooms*
  anchored at the pointer (covered by `wheel scroll navigates the canvas anchored
  at the pointer`), and Shift+wheel does not pan on this build — the retired spec
  assumed it did.
- **The drag is delivered in intermediate steps, not one jump.** React Flow's
  drag handler needs `pointermove` events between press and release; a single
  move to the target can be delivered as one event and land as a click.
