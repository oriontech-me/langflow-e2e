# Graph Execution on the Canvas — cycle refusal and partial-failure feedback

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev14`)

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

2. **A partial failure is mis-reported on the canvas** (**declared failing**) —
   when a run has one component fail while independent branches complete, the
   canvas should flag the failed node and show the completed branches as built.
   It does neither: the AG-UI run stream emits `RUN_ERROR` mid-run (the moment the
   component raises), the frontend treats that as terminal and tears the
   subscription down, so the failed node is never flagged and the branches the
   backend finished never render. The test asserts the correct contract and
   `test.fail()` expects today's breach.

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
upstream fixes it (the failed node is flagged / completed branches render) it
reports *"expected to fail, but passed"* — then drop `test.fail()` and this note,
keep `@stable`, and flip the §12.6 canvas bullet. Test 1 is the attribution
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

**Test 2 (declared failing) — a partial failure is flagged on the canvas**
1. Build `Root → Raiser(raise) → Join.left`; `Root → Slow(sleep) → Tail → Join.right`.
2. Open the flow, click `button_run_join`.
3. Wait for the run to settle (the `Flow build failed` banner appears, and
   `node_duration_root` renders — the run reached the backend).
4. Assert the correct contract: the failed node is flagged
   (`node_status_icon_raiser_error` visible) **or** a completed branch shows as
   built (`node_duration_tail` visible). Measured on `1.13.0.dev14`: neither
   appears — no `node_status_icon_*` renders at all and only `node_duration_root`
   shows — so the assertion fails and `test.fail()` expects that.
   `page.allowFlowErrors()` is set (the run provokes a component failure).

---

## Validation criterion *(required)*

- Each test creates its flow(s) and deletes them by id; no orphans remain.
- Test 1 is green: 1 edge after the first connect, still 1 after the cycle
  attempt, 2 after the non-cycle connect.
- Test 2 fails as expected while #1896 is live: after running the join, neither
  the failed node's error status nor a completed branch's duration renders,
  though the banner confirms the run happened.
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
  (`translate("error")` → `RunErrorEvent`), and
  `src/frontend/src/controllers/API/agui/run-flow-bridge.ts` (`handleAGUIEvent`
  treats `RUN_ERROR` as terminal).
- **Helpers** — `build-custom-component-graph.ts`, `open-flow-by-id.ts`
  (assistant-onboarding seed, #1220).
- **Custom components** — `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (#668/#746).
- **No external network, no provider account.**
