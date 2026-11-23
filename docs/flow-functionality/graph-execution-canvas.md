# Graph Execution on the Canvas — cycle refusal and partial-failure feedback

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev35`, `sha256:a2f75e01…`) — Test 2 re-scoped there for upstream #16492; Test 1 unchanged since `1.13.0.dev14`

---

## What this test validates *(required)*

The **canvas half** of the §12.6 graph-execution contract (issue #1896), the
sibling of the REST spec `api/flows/graph-execution-contract.spec.ts`. Two
surfaces the API cannot see:

1. **The canvas refuses to draw a cycle** (green) — a connection that would close
   a cycle through regular (non-loop) input ports is rejected, while a connection
   to the **same** target port from a node **outside** the cycle is accepted. This
   is `isValidConnection`'s cycle guard, and it is why a regular-port cycle only
   ever reaches the engine through import or the API (where the REST spec pins the
   engine's mishandling of it).

2. **The failed node is not flagged on the canvas** (**declared failing**). When
   one component of a run fails, the canvas should mark that node as failed. It
   does not: no `node_status_icon_*` renders and only the nodes built before the
   failure show a duration. The test asserts the flag and `test.fail()` expects
   today's breach.

   **Where the defect lives (measured on `1.14.0.dev35`, 3 of 3 runs).** The AG-UI
   stream the canvas receives is
   `RUN_STARTED → STATE_SNAPSHOT ×2 → STEP_FINISHED(Root) → STATE_DELTA(Root=success) → CUSTOM langflow.event(error, source=Raiser) → RUN_ERROR`,
   and it ends there. The failed node's own state change (`STATE_DELTA` with
   `status: "error"`) never arrives. The frontend can render the flag: with that
   delta injected before `RUN_ERROR`, `node_status_icon_raiser_error` appears. So
   the fix belongs in the backend translator, which must report the failed node's
   state before the terminal event.

   **What changed with upstream #16492** ("end AG-UI streams at RUN_ERROR", on
   `release-1.14.0`, merged 2026-11-18, present in `1.14.0.dev35`). Until then the
   stream sent `RUN_ERROR` mid-run and kept going, ending with `RUN_FINISHED`, which
   breaks the AG-UI rule that `RUN_ERROR` is terminal. That violation was the
   backend target #1896 recorded, and #16492 fixes it: after `RUN_ERROR` the
   translator drops every later event. The consequence for this test: **the
   branches that finish after the failure can no longer be shown on the canvas by
   design** (the backend still builds them; their events are dropped). Test 2 used
   to assert exactly that (`node_duration_tail`), which turned it into an alarm
   that could never fire, and it is now asserted over REST by the contract spec as
   the terminal-`RUN_ERROR` rule instead.

Graphs are built from `CustomComponent` nodes over the API (the canvas cannot
*draw* a cycle, which is precisely surface 1), then opened in the editor. No
provider key.

If surface 1 regresses, the canvas would let a user draw a non-loop cycle (or
refuse a legitimate connection). Surface 2 is the user-facing cost of the engine
defect: a run that half-succeeded looks like a total failure.

---

## Tags *(required)*

Test 1: `@workspace` `@ui-ux` `@regression` `@stable`
Test 2: `@workspace` `@ui-ux` `@playground` `@regression` `@stable`

**Test 2 is declared failing with `test.fail()`** against the live AG-UI defect
(#1896). While the defect is live it passes by failing as expected; the day
upstream fixes it (the failed node is flagged) it reports *"expected to fail, but
passed"* — then drop `test.fail()` and this note,
restore `@stable` if the daily already removed it (the daily treats the unexpected
pass as a hard failure), and flip the §12.6 canvas bullet. Test 1 is the attribution
control's role here: a green Test 1 proves the harness drives the canvas, so a red
Test 2 is the product defect, not a broken scout.

---

## Step by step *(required)*

Both tests build their graph over `POST /api/v1/flows/` with
`createCustomComponentGraphFlow` (`tests/helpers/flows/build-custom-component-graph.ts`,
the same builder the REST spec uses) and open it with `openFlowById`, which seeds
the assistant-onboarding flag (#1220) and waits for the canvas. Each flow is
deleted by id in cleanup.

**Test 1 — the canvas refuses a cycle-closing connection, accepts a non-cycle one**
1. Build `Alpha` (inputs `incoming`, `loopback`), `Beta` (input `incoming`),
   `Gamma` (no inputs) — **no edges**; the connections are drawn in the canvas.
2. Open the flow. Assert `.react-flow__edge` count is 0.
3. Connect `Alpha` output → `Beta.incoming` (click the source handle, then the
   target handle, located by `data-nodeid` + the handle testid). Assert 1 edge.
4. Attempt `Beta` output → `Alpha.loopback` — this closes an `Alpha → Beta → Alpha`
   cycle through regular ports. Assert the edge count **stays 1** (refused).
5. Connect `Gamma` output → `Alpha.loopback` — the **same** target port, from a
   node outside the cycle. Assert 2 edges (accepted). This is the control that
   makes step 4's zero a cycle refusal rather than a dead handle.

**Test 2 (declared failing) — a partial failure flags the failed node on the canvas**
1. Build `Root → Raiser(raise) → Join.left`; `Root → Slow(sleep) → Tail → Join.right`.
   The `Slow → Tail` branch keeps the run a *partial* failure (an independent
   branch is still building when `Raiser` fails), which is the case under test.
2. Open the flow, click `button_run_join`.
3. Wait for the run to settle (the `Flow build failed` banner appears, and
   `node_duration_root` renders — the run reached the backend). These two anchor
   the declared failure: it is not a run that never fired.
4. Assert the correct contract: the failed node is flagged —
   `node_status_icon_raiser_error` is visible. Measured on `1.14.0.dev35`: it is
   not (no `node_status_icon_*` renders at all), so the assertion fails and
   `test.fail()` expects that. `page.allowFlowErrors()` is set (the run provokes
   a component failure).

The title changed with the re-scope (it used to add *"and shows the completed
branches on the canvas"*), because that half is no longer a contract the canvas
can meet; see *What this test validates*.

---

## Validation criterion *(required)*

- Each test creates its flow(s) and deletes them by id; no orphans remain.
- Test 1 is green: 1 edge after the first connect, still 1 after the cycle
  attempt, 2 after the non-cycle connect.
- Test 2 fails as expected while #1896 is live: after running the join, the
  failed node's error status does not render, though the banner and
  `node_duration_root` confirm the run happened.
- Test 2's declaration can flip. Force-failed by fulfilling the canvas's run
  stream with the failed node's `STATE_DELTA` (`status: "error"`) inserted before
  `RUN_ERROR`, which is what a backend fix would send: the flag renders and the
  test reports *expected to fail, but passed*.
- No `🚨 Backend Error` is logged (the runs answer 200; the deliberate component
  failure is a flow error, hatched with `allowFlowErrors()`).

---

## What this test does not cover *(optional)*

- The **engine** semantics behind the cycle and the partial failure — order,
  the sync `completed`-with-unbuilt-node defect, `stop()` skipping — all pinned
  over REST in `api/flows/graph-execution-contract.spec.ts`.
- The **pure-cycle runaway** (a regular-port cycle with no external root whose
  node id matches the `"webhook"/"chat"` start heuristic runs unbounded): it
  would hang the run, so it is documented in #1896, not automated.
- Whether an imported cycle's run reports "Flow built successfully" on the canvas
  — the toast is timing-sensitive; the sync `completed` claim is asserted in the
  REST spec instead.
- **Branches that finish after a failure, shown as built.** Since upstream #16492
  the AG-UI stream ends at `RUN_ERROR` and drops every later event, so the canvas
  cannot show them by design. The backend still builds them; the REST spec covers
  both halves (the `/build` stream builds them, and the AG-UI stream ends at
  `RUN_ERROR`).

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` — the nightly defaults it to `false`,
  which hides `CustomComponent` (#668/#746); the builder throws naming this.
- Default superuser credentials.
- No provider key, no external network.

---

## External dependencies *(required)*

- **Langflow API** — `POST /api/v1/flows/`, `GET /api/v1/all`, `DELETE /api/v1/flows/{id}`.
- **Langflow UI** — the flow editor canvas: `.react-flow__handle`
  (`data-nodeid` + `handle-customcomponent-shownode-<field>-<left|right>`),
  `.react-flow__edge`, `button_run_<node>`, `node_status_icon_<node>_<status>`,
  `node_duration_<node>`, `canvas_controls_dropdown`.
- **Upstream source** — `src/frontend/src/utils/reactflowUtils.ts`
  (`isValidConnection`'s cycle guard), `src/lfx/src/lfx/workflow/agui_translator.py`
  (`translate("error")` → `RunErrorEvent`; since upstream #16492 it drops every
  event after `RUN_ERROR`), and
  `src/frontend/src/controllers/API/agui/run-flow-bridge.ts` (`handleAGUIEvent`
  treats `RUN_ERROR` as terminal).
- **Helpers** — `build-custom-component-graph.ts`, `open-flow-by-id.ts`
  (assistant-onboarding seed, #1220).
- **Custom components** — `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (#668/#746).
- **No external network, no provider account.**
