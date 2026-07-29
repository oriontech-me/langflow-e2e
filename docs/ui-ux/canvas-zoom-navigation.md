# Spec: Canvas Zoom and Navigation

**Test file:** `tests/tests-automations/regression/ui-ux/canvas-zoom-navigation.spec.ts`

## What this test validates

Covers the canvas viewport controls — the `§15.5 Canvas Zoom and Navigation`
checklist items *Zoom in / Zoom out*, *Fit View centers nodes*, *Fit View button
in toolbar* and *Scroll to navigate canvas*. Minimap (`[~]`, feature-flag-gated)
is out of scope: on `1.12.0.dev6` no minimap element is rendered at all.

Every assertion reads the **React Flow viewport transform**
(`.react-flow__viewport` → `transform: translate(<x>px, <y>px) scale(<z>)`) and
the on-screen geometry of `.react-flow__node` against `.react-flow__pane`. That
is the only observable that proves the canvas actually moved: a control that
renders, is enabled and is clickable but no longer wired to the viewport passes a
"button is visible" check and fails these.

**Entry-state note (measured live, 1.12.0.dev6).** The editor does **not** open on
the flow's persisted viewport: it opens clamped at the maximum zoom
(`scale(2)`, `zoom_in` already `disabled`, the graph overflowing the pane),
reproducibly across reloads, while `GET /api/v1/flows/{id}` still reports
`viewport.zoom = 0.896`. That is why every test that measures *relative* zoom
first normalizes the viewport with one `fit_view` click (`normalizeViewport`) —
on a clamped viewport "zoom in raises the scale" is untestable. The tests assert
the behavior of the controls, not this entry state; test 3 is the one that uses
it, as a free "displaced viewport" to prove Fit View acts.

**Wait strategy — why a plain "the transform stopped changing" poll is not enough
(#1094).** React Flow commits a viewport change in one frame (measured: the
transform still holds its pre-click value at `t+0` after the `fit_view` click and
carries the fitted value by `t+100ms`), and Playwright's `expect.poll` runs its
callback immediately. A settle poll seeded with a transform read *before* the
action therefore compares the pre-action value against itself on its first tick,
reports "settled" and hands back the **stale** viewport — which is how this spec
read `scale(2)` out of a Fit View that had already fitted to `0.880331`. Whether
the commit landed before that first read depends on CDP round-trip timing, so the
same code passed in CI and failed locally. So `waitForViewportSettled` takes an
optional predicate: every step whose action *must* move the viewport waits for a
transform that both **differs from the pre-action one** and then holds, and
`normalizeViewport` waits on its real postcondition (the nodes contained in the
pane) rather than on "something changed". Only the two steps where no change is
expected — editor hydration and the second, idempotent `fit_view` click — use the
bare settle.

Four independent tests:

1. **Zoom in / Zoom out** — `zoom_in` multiplies the viewport scale by `1.2` per
   click and `zoom_out` divides it back to the original value; clicking
   `zoom_out` to exhaustion clamps at exactly `0.25` and disables the button
   (with `zoom_in` still enabled), clicking `zoom_in` to exhaustion clamps at
   exactly `2` and disables it. The `0.25`/`2` bounds are React Flow's
   `minZoom`/`maxZoom` as configured by Langflow — a silent change to either
   bound, or a step factor change, reddens this test.
2. **Fit View centers nodes** — from a deliberately displaced viewport (zoomed to
   the `2` clamp, where the graph overflows the pane — asserted as a
   precondition, so the test cannot pass on an already-fitted canvas), clicking
   `fit_view` brings **every** node fully inside the pane and centers the nodes'
   union bounding box on the pane center (≤ 4 px on each axis; measured 1 px /
   0 px live). A second `fit_view` click is a no-op (identical transform string),
   which is the idempotence contract other specs' `adjustScreenView` helper
   relies on.
3. **Fit View button in toolbar** — the toolbar surface contract:
   `main_canvas_controls` is visible on flow entry while `fit_view`, `zoom_in`,
   `zoom_out` and `reset_zoom` are **absent** from the DOM; clicking
   `canvas_controls_dropdown` renders all four visible (`fit_view` and
   `reset_zoom` enabled — `zoom_in` is legitimately disabled at the entry clamp);
   clicking `fit_view` from the toolbar on that displaced entry viewport changes
   the transform, brings every node inside the pane and re-enables both zoom
   buttons — proving the toolbar entry is wired, not decorative. Collapsing the
   dropdown removes all four from the DOM again and it can be re-expanded. The
   collapse click is `force: true`: while open, the Radix popover overlay covers
   the trigger and a normal click fails Playwright's hit-test (the same forced
   click `closeCanvasControls` issues in `helpers/ui/canvas-controls.ts`).
4. **Scroll to navigate canvas** — a mouse wheel over the pane navigates the
   canvas by zooming **anchored at the pointer**: `deltaY > 0` strictly decreases
   the scale, `deltaY < 0` restores it, and in both directions the flow-space
   point under the cursor is preserved (≤ 2 px), measured at two different pane
   positions so a fixed-center zoom would fail. On `1.12.0.dev6` the wheel is
   bound to zoom, not to panning (`deltaX` alone does not move the viewport) —
   the test asserts the zoom-anchored semantics that ship today and would fail if
   scroll stopped affecting the viewport.

Non-goals (covered elsewhere or deliberately excluded): pane drag/pan and node
movement (`§15.4`), `reset_zoom` (no `§15.5` bullet — its value is only used as
part of test 3's enabled-controls assertion), and the minimap.

## Tags

`@stable` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Zoom in | scale after click ÷ scale before = `1.2` (± 0.01) and strictly greater |
| Zoom out | scale returns to the pre-zoom-in value (± 0.001) |
| Zoom-out clamp | `zoom_out` becomes `disabled` with scale exactly `0.25`; `zoom_in` still enabled |
| Zoom-in clamp | `zoom_in` becomes `disabled` with scale exactly `2`; `zoom_out` still enabled |
| Fit View precondition | at scale `2` the nodes' union box is NOT contained in the pane rect |
| Fit View scale | the fitted scale is strictly below `maxZoom` (`2`). Sound for this fixture, not an accident of the pane: the two nodes span `1090 × 315` flow px, so the unclamped fit is `min(1000/1090, 672/315) ≈ 0.92` — measured `0.880331` live, a factor of 2.3 away from the bound (#1094) |
| Fit View centering | union box inside the pane rect (1 px tolerance) AND \|union center − pane center\| ≤ 4 px on both axes AND both node titles visible |
| Fit View idempotence | second `fit_view` click leaves the `transform` string byte-identical |
| Toolbar collapsed | `main_canvas_controls` visible; `fit_view`/`zoom_in`/`zoom_out`/`reset_zoom` `count() === 0` |
| Toolbar expanded | all four controls visible after clicking `canvas_controls_dropdown`; `fit_view` and `reset_zoom` enabled |
| Toolbar Fit View wired | nodes NOT contained before the click; after it the transform differs, every node is inside the pane, and `zoom_in`/`zoom_out` are both enabled |
| Toolbar re-collapse | `count() === 0` for all four after a forced trigger click; all four visible again after re-expanding |
| Scroll out | after `wheel(0, +300)` scale is strictly smaller AND the flow-space point under the cursor is unchanged (≤ 2 px) |
| Scroll in | after `wheel(0, −300)` scale is strictly larger, back to the pre-scroll value (± 0.001), anchor preserved (≤ 2 px) |
| Scroll anchoring | repeating the wheel-out at a second, different pane position also preserves its own pointer anchor (≤ 2 px) |

Non-criterion (deliberate): no assertion on the absolute `translate` values
produced by `fit_view` (they depend on the fixture's node coordinates and on the
1000×672 pane of the default 1280×720 viewport) — only relative centering and
containment, so a viewport-size change does not redden the spec.

## External dependencies

- `src/frontend/src/CustomNodes/../CanvasControls` — `main_canvas_controls`,
  `canvas_controls_dropdown`, `zoom_in`, `zoom_out`, `reset_zoom`, `fit_view`
  testids and the collapsed-by-default dropdown.
- React Flow (`@xyflow/react`) viewport: the `.react-flow__viewport` transform,
  `minZoom` `0.25` / `maxZoom` `2`, the `1.2` zoom step, and `zoomOnScroll` with
  pointer anchoring.
- `tests/assets/flows/chat-io-ok-trace-fixture.json` via
  `createRunnableChatFlowViaApi` — a repo-owned Chat Input → Chat Output graph.
  No starter template, no provider key, no LLM call, no flow build: the spec is
  pure viewport geometry.

Flow cleanup: the flow is created through the API, its id is held by the spec and
deleted in `afterEach` (id-scoped, never a wipe), after `page.goto("/")` unmounts
the editor's event poll.

## Scenarios

### 15.5.1 Zoom in / Zoom out step and clamp the viewport scale [-]

- **File:** `tests/tests-automations/regression/ui-ux/canvas-zoom-navigation.spec.ts`
- **Objective:** prove the toolbar zoom buttons change the canvas scale by the
  documented step and stop at React Flow's configured bounds.
- **Precondition:** running instance; flow created via API from the Chat I/O
  fixture; editor open at `/flow/{id}`.
- **Step by step:**
  1. Wait for `canvas_controls_dropdown`, normalize the viewport (one `fit_view`
     click) and expand the controls; both zoom buttons must be enabled.
  2. Read the baseline scale from `.react-flow__viewport`.
  3. Click `zoom_in`; read the scale.
  4. Click `zoom_out`; read the scale.
  5. Click `zoom_out` until it reports `disabled` (bounded loop); read the scale
     and both buttons' enabled state.
  6. Click `zoom_in` until it reports `disabled` (bounded loop); read the scale
     and both buttons' enabled state.
- **Validation:** step 3 scale = baseline × 1.2 (± 0.01); step 4 scale = baseline
  (± 0.001); step 5 scale = `0.25` with `zoom_out` disabled and `zoom_in`
  enabled; step 6 scale = `2` with `zoom_in` disabled and `zoom_out` enabled.

### 15.5.2 Fit View centers every node inside the canvas [-]

- **File:** same
- **Objective:** prove `fit_view` reframes the graph — all nodes visible and the
  graph centered — and that it is idempotent.
- **Precondition:** as above.
- **Step by step:**
  1. Normalize the viewport, expand the controls, click `zoom_in` until disabled
     (scale `2`, at least one click landed).
  2. Measure the union box of `.react-flow__node` against the
     `.react-flow__pane` rect — assert it overflows (precondition).
  3. Record the transform, click `fit_view`, and wait for a transform that
     differs from the recorded one and then holds (see *Wait strategy*).
  4. Re-measure the union box and the pane rect; read `title-Chat Input` and
     `title-Chat Output` visibility; read the transform string.
  5. Click `fit_view` again; read the transform string.
- **Validation:** after step 3 the fitted scale is strictly below `2`, the union
  box is inside the pane (1 px tolerance), its center is within 4 px of the pane
  center on both axes, both titles are visible, and the step-5 transform is
  identical to the step-4 one.

### 15.5.3 Fit View is reachable from the canvas controls toolbar [-]

- **File:** same
- **Objective:** prove the canvas-controls toolbar exposes Fit View (and its
  sibling zoom controls) behind the collapsible dropdown, and that the exposed
  Fit View acts on the viewport.
- **Precondition:** as above; controls NOT yet expanded and the viewport NOT
  normalized (this test uses the displaced entry viewport on purpose).
- **Step by step:**
  1. Assert `main_canvas_controls` is visible and each of `fit_view`, `zoom_in`,
     `zoom_out`, `reset_zoom` has `count() === 0`.
  2. Click `canvas_controls_dropdown`; assert the four controls are visible and
     that `fit_view` / `reset_zoom` are enabled.
  3. Record the transform, assert the nodes are not contained, click `fit_view`.
  4. Read the transform and the node/pane geometry; read both zoom buttons'
     enabled state.
  5. Click `canvas_controls_dropdown` (forced) and assert `count() === 0` for all
     four; click it once more and assert all four are visible again.
- **Validation:** the step-4 transform differs from the step-3 one, every node is
  inside the pane rect, `zoom_in` and `zoom_out` are both enabled, and the
  collapse/expand transitions hold exactly as asserted in steps 1, 2 and 5.

### 15.5.4 Wheel scroll navigates the canvas anchored at the pointer [-]

- **File:** same
- **Objective:** prove wheel input over the canvas moves the viewport, anchored
  at the cursor position (the navigation semantics shipped on 1.12).
- **Precondition:** as above; viewport normalized (a clamped viewport cannot zoom
  in) and the controls dropdown **closed** (its popover swallows wheel events).
- **Step by step:**
  1. Read the baseline transform and the pane rect.
  2. Move the mouse to a point `P` at one third of the pane width; `wheel(0, +300)`.
  3. Read the transform; compute the flow-space coordinate under `P` before and
     after.
  4. `wheel(0, −300)` at the same point; read the transform and recompute the
     anchor.
  5. Move to a point `Q` at two thirds of the pane width; `wheel(0, +300)`; read
     the transform and compute the anchor under `Q` before/after.
- **Validation:** step 3 scale strictly smaller than baseline with the `P` anchor
  preserved (≤ 2 px on both axes); step 4 scale back to baseline (± 0.001) with
  the anchor preserved; step 5 scale strictly smaller with the `Q` anchor
  preserved (≤ 2 px) — a zoom pinned to the pane center instead of the pointer
  fails steps 3 and 5.

## Last validated

1.12.x (nightly `1.12.0.dev9`; originally authored against `1.12.0.dev6`)
