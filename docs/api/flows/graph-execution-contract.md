# Graph Execution Contract — order, partial failure, skipped branches

**Last validated:** Langflow 1.13.x

---

## What this test validates *(required)*

Validates the **graph-execution engine's contract** as it is observable over the
REST run surface — `POST /api/v1/build/{flow_id}/flow?event_delivery=direct` (the
NDJSON build stream) and `POST /api/v2/workflows` (`mode: "sync"`). It covers the
three `QA-CHECKLIST` §12.6 behaviors that hold today plus the one that does not,
for the engine's own semantics rather than any component:

1. **Execution order respects data dependency** — a node that consumes another's
   output never finishes before its producer, and it receives that producer's
   value.
2. **Partial failure** — when one branch of a multi-branch graph raises, the
   branches that do not depend on it still build to completion, and the failed
   node is the one flagged (`valid: false`), its descendants never built.
3. **A stopped branch is skipped** — a producer that calls `Component.stop()` (the
   mechanism `If-Else` / `ConditionalRouter` use) leaves its downstream unbuilt,
   reported in `inactivated_vertices`.
4. **A regular-port cycle must not report a never-built node as completed**
   (**declared failing**, see Tags) — a graph carrying a cycle through regular
   (non-loop) input ports runs to `status: "completed"` and lists a downstream
   node that never built in `outputs`, which is the defect this spec pins.

Every node is a `CustomComponent` whose Python body fixes its behavior (echo,
optionally after a delay; `raise`; `self.stop()`), so the **graph shape is the
only variable** and no provider key is needed. The flows are built and driven
entirely over REST; the run's outputs carry per-node tags, so "the graph actually
executed in this order" cannot pass on a structurally valid but empty shell.

If this test fails (beyond the declared-failing case), the engine's scheduling
contract has regressed: an independent branch abandoned when a sibling fails, a
consumer built before its producer, or a stopped branch built anyway.

---

## Tags *(required)*

`@api` `@regression` `@playground` `@stable`

Every test carries `@stable`, including the declared-failing one. **Test 4 is
declared failing with `test.fail()`** against a live upstream defect (issue #1896):
`POST /api/v2/workflows` `mode=sync` answers `status: "completed"` for a graph
whose regular-port cycle, and the node downstream of it, never built — and lists
that downstream node in `outputs` as completed with null content. The declaration
is the alarm in both directions: while the defect is live the test passes by
failing as expected; the day upstream fixes it, the run reports *"expected to
fail, but passed"* and the lift is: delete `test.fail()` and this note, keep
`@stable`, flip the §12.6 bullet, and close #1896. An **attribution control**
(Test 4's sibling, not declared failing) builds the *acyclic* equivalent through
the same helpers and asserts the downstream node builds and is reported
`completed` with its real output — so a red Test 4 is the cycle defect, never a
broken harness.

---

## Step by step *(required)*

The spec runs via Playwright's `request` fixture. Each test builds its own graph
over `POST /api/v1/flows/` from the live `CustomComponent` catalog and deletes it
by id in a per-test cleanup. `/build` authenticates with Bearer
(`CurrentActiveUser`), so each flow is created with the same Bearer identity that
builds it.

**Helper — `buildCustomComponentGraph` (`tests/helpers/flows/build-custom-component-graph.ts`)**
A pure builder that turns the live `GET /api/v1/all` catalog plus a node/edge spec
into a `POST /api/v1/flows/` payload. Nodes are `echo` (emits its inputs joined
with its own tag, optionally after a `sleep`), `raise` (`raise ValueError`), or
`stop` (`self.stop("output")`). It fixes the two traps `create-secret-edge-flow-via-api.ts`
records — the output type must be set to `Message` (the stock template says
`JSON`) and each node needs a distinct `display_name` — and is unit-tested.

**Test 1 — execution order follows data dependency (`/build` direct)**
1. Build `Root → A1(0.4 s) → A2 → A3`, and a diamond `Root → L(0.4 s)`, `Root → M`,
   `L,M → Join`.
2. `POST /api/v1/build/{id}/flow?event_delivery=direct`; assert `200`, parse the
   NDJSON, `apiCoverage.declare(["POST /api/v1/build/{flow_id}/flow"])`.
3. Assert each consumer's `end_vertex` follows all its producers' `end_vertex`
   (finish order — the build stream has no per-node start event), and `Join`'s
   output text contains every upstream tag. The delays make a scheduling
   regression observable rather than incidental.

**Test 2 — partial failure keeps independent branches building (`/build` direct)**
1. Build `Root → X(raise) → X2`; `Root → S(0.4 s) → T`.
2. Build the flow; assert `200`, parse.
3. Assert `S` and `T` finish `valid: true` after the failure, `X` is `valid:
   false` carrying its error message, and `X2` never appears — the failure is
   contained to its own branch.

**Test 3 — `stop()` skips the downstream branch (`/build` direct)**
1. Build `Root → Stopper(stop) → D1 → D2`; `Root → K`.
2. Build; assert `200`, parse.
3. Assert `D1` and `D2` never build and appear in the union of
   `inactivated_vertices`; `K` (the sibling branch) builds `valid: true`.

**Test 4 (attribution control) — an acyclic graph reports its terminal completed (`/workflows` sync)**
1. Build the acyclic `Root → Mid → Leaf` (`Leaf` downstream, no cycle).
2. `POST /api/v2/workflows` `{mode:"sync"}`;
   `apiCoverage.declare(["POST /api/v2/workflows"])`.
3. Assert `status: "completed"`, `errors: []`, and `Leaf` present in `outputs`
   with non-null content — the harness reads a completed terminal correctly.

**Test 4 (declared failing, `test.fail()`) — a regular-port cycle must not report a never-built node completed (`/workflows` sync)**
1. Build `Root → Alpha`, `Alpha → Beta`, `Beta → Alpha` (regular `loopback`
   port — a cycle), `Beta → Sink`; `Root` is the external root and no node id
   matches the `"webhook"/"chat"` start heuristic, so the cycle never runs and the
   call returns fast (measured; the pure-cycle runaway variant is out of scope,
   see below).
2. `POST /api/v2/workflows` `{mode:"sync"}`.
3. Assert the correct contract — `Sink` (downstream of the cycle, never built) is
   **not** reported in `outputs` as `completed`. Today it is, so the assertion
   fails and `test.fail()` expects that.

---

## Validation criterion *(required)*

- Each test creates its own flow(s) and deletes them by id; no orphan flows remain
  (verified via `GET /api/v1/flows/`).
- Tests 1–3 are green: order holds, the independent branch completes past a
  sibling failure with the failed node flagged, and the stopped branch is skipped.
- Test 4's attribution control is green (acyclic terminal reported `completed`
  with output).
- Test 4 (declared) fails as expected while #1896 is live: `Sink` is reported
  `completed` though it never built.
- `apiCoverage` declares `POST /api/v1/build/{flow_id}/flow` and
  `POST /api/v2/workflows`, each issued by the test that declares it.
- No `🚨 Backend Error` is logged — the runs answer HTTP 200; the deliberate
  component failures surface as flow errors, so the failure-provoking tests call
  `page.allowFlowErrors()`… (N/A: this spec is REST-only via `request`, so there
  is no page; the deliberate failures never reach the HTTP-error monitor because
  `/build` and `/workflows` answer 200).

---

## What this test does not cover *(optional)*

- **The AG-UI / canvas surface.** `mode=stream, stream_protocol=agui` (what the
  Playground sends) mis-handles a partial failure — RUN_ERROR mid-run freezes the
  canvas — and the canvas refuses to *draw* a cycle edge. Both are the sibling
  **canvas** spec's subject (issue #1896).
- **The pure-cycle runaway.** A regular-port cycle with **no external root** whose
  node id matches the `"webhook"/"chat"` start heuristic *does* run, unbounded,
  because the `/build` walker enforces no `max_iterations`. It is deliberately not
  automated here — it would hang the worker. Documented in #1896.
- **Sync all-or-nothing.** `mode=sync` abandons an independent branch when any
  layer raises (`Graph._execute_tasks` re-raises the first exception). This is a
  known engine limit recorded in #1896, not asserted here, pending an upstream
  decision.
- **A producer returning `None`.** The consumer runs and fails with a pydantic
  `MessageTextInput` error attributed to the consumer; a separate question, left
  to #1896's decision.
- The component-level contracts already covered elsewhere: `If-Else` inactive
  branches (`core-components/if-else-component-regression.spec.ts`), the direct vs
  job_id delivery shapes (`api/flows/api-build-direct-response.spec.ts`).

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` — the nightly image defaults it to
  `false`, which makes `POST /api/v1/custom_component` answer `403` and omits
  `CustomComponent` from `GET /api/v1/all`; the CI service containers and
  `scripts/start-langflow-docker.sh` set it (#668/#746). The helper throws naming
  this when the component is absent.
- Default superuser credentials (`getAuthToken`).
- No provider key, no external network.

---

## External dependencies *(required)*

- **Langflow API** — `POST /api/v1/flows/`, `GET /api/v1/all`,
  `POST /api/v1/build/{flow_id}/flow?event_delivery=direct`,
  `POST /api/v2/workflows`, `DELETE /api/v1/flows/{id}`.
- **Upstream source** — `src/lfx/src/lfx/graph/graph/base.py` (`process`,
  `_execute_tasks`, `get_next_runnable_vertices`, `_build_graph` registering
  cycle vertices), `src/lfx/src/lfx/graph/graph/runnable_vertices_manager.py`
  (`are_all_predecessors_fulfilled` — the non-loop cycle vertex is never runnable
  unless the sort seeds it), `src/lfx/src/lfx/graph/graph/utils.py`
  (`find_start_component_id` / `layered_topological_sort`, the `"webhook"/"chat"`
  start heuristic), and `src/backend/base/langflow/api/build.py` (the
  `build_vertices` driver, which stops only the failed vertex's successors and
  passes no `max_iterations`).
- **Custom components** — the graphs are built from `CustomComponent`, so
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` is required (#668/#746).
- **No external network, no provider account.**
