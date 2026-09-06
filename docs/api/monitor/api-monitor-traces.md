# API Monitor — traces (`/api/v1/monitor/traces`)

**File:** `tests/tests-automations/regression/api/monitor/api-monitor-traces.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev1`, tracing enabled)

Owning issue: #1700 (Wave 7 — OSS API coverage, `monitor` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The four trace operations as a contract over traces the test itself emits, with an
LLM-free run (Chat Input → Chat Output fixture, `POST /api/v1/run/{flow_id}` with an
API key). The `observability-monitoring/traces-*` specs already read these endpoints
around a UI assertion; none declares them and none asserts the closed contract (the
`404`s, the required `flow_id` on the bulk delete, the list shape). This file does,
and declares, so the four count.

**Premise, stated because it decides where the file can run:** traces exist only when
tracing is on. Both long-lived local containers of this repo run with
`LANGFLOW_DEACTIVATE_TRACING=true`, where `GET /api/v1/monitor/traces?flow_id=`
answers `{"traces":[],"total":0,"pages":0}` **after** a successful run — a `200` that
means "unevaluated", not "no traces". CI runs with tracing on (the `traces-*` specs
are `@stable` in the daily). The spec therefore **fails, never skips**, when a run
emits no trace, naming the tracing flag as the likely cause: a skip here would read
green on a container that measures nothing (#1012). Measured on a tracing-enabled
container (`1.13.0.dev1`):

| Operation | Answer |
|---|---|
| `GET /api/v1/monitor/traces?flow_id=` | `200 {"traces": [...], "total": N, "pages": P}`; each trace `{id, name, status: "ok", startTime, totalLatencyMs, totalTokens: 0, flowId, sessionId, input: {input_value}, output: {message}}` |
| `…?flow_id=&session_id=` | only that session's traces; `…&status=ok` keeps them |
| `GET /api/v1/monitor/traces/{trace_id}` | `200`, the trace **plus** `endTime` and its span tree (~7 KB for the two-node fixture) |
| `GET …/traces/{unknown}` | `404 {"detail":"Trace not found"}` |
| `DELETE /api/v1/monitor/traces/{trace_id}` | `204`; the id then answers `404` |
| `DELETE …/traces/{unknown}` | `404 {"detail":"Trace not found"}` |
| `DELETE /api/v1/monitor/traces` (no `flow_id`) | `422`, `detail[0].loc === ["query","flow_id"]` — **scoped by construction, not a wipe** (correcting #1700's premise) |
| `DELETE /api/v1/monitor/traces?flow_id=` | `204`; the flow's list reads `{"traces":[],"total":0,"pages":0}` afterwards |

---

## Tags *(required)*

`@api` `@observability` `@stable`

`@stable`: the daily runs with tracing on, and the file fails loudly rather than skips
where it is off, so a green daily means the contract was actually measured.

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`. `beforeAll`
creates an API key and the fixture flow; `afterAll` deletes both (and
`DELETE traces?flow_id=` as belt and braces, since traces are not part of the flow
row).

**Test 1 — `a run emits a trace that can be listed, filtered, read and deleted by id`**
1. Run once on session S with `input_value: "trace-hello"`.
2. Poll `GET traces?flow_id=` until `total >= 1` (bounded, 20 s); on timeout **fail**
   with a message naming `LANGFLOW_DEACTIVATE_TRACING` — never skip.
3. The trace has `status === "ok"`, `flowId === flow id`, `sessionId === S`,
   `input.input_value === "trace-hello"`, `totalTokens === 0`, `totalLatencyMs` a
   non-negative number.
4. `GET traces?flow_id=&session_id=S` → the same trace; `…&status=ok` → still present.
5. `GET traces/{id}` → `200`, same `id`, plus `endTime` (a string) and a non-empty span
   collection.
6. `DELETE traces/{id}` → `204`; `GET traces/{id}` → `404 "Trace not found"`.
7. `GET traces/{random uuid}` → `404 "Trace not found"`; `DELETE` of the same → `404`.

**Test 2 — `the bulk delete is scoped to a flow`**
1. Run twice (two sessions); poll until `total >= 2`.
2. `DELETE traces` with **no** `flow_id` → `422`, `detail[0].loc` deep-equals
   `["query","flow_id"]`; the flow's traces are **still there** (`total >= 2`).
3. `DELETE traces?flow_id=` → `204`; `GET traces?flow_id=` → deep-equals
   `{"traces": [], "total": 0, "pages": 0}`.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1` **against an
instance with tracing enabled**, with the no-trace state asserted as a **failure**
naming the flag (not a skip), the bulk delete asserted on both the refusal and the
survival of the rows, and the declared coverage — `GET /api/v1/monitor/traces`,
`GET /api/v1/monitor/traces/{trace_id}`, `DELETE /api/v1/monitor/traces/{trace_id}`,
`DELETE /api/v1/monitor/traces` — matching what the fixture recorded. Zero flows or
keys left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL` **with tracing enabled**
  (`LANGFLOW_DEACTIVATE_TRACING` unset or `false`) — the CI containers; locally a
  dedicated container, since the shared ones disable it.
- Repo asset: `tests/assets/flows/chat-io-ok-trace-fixture.json`.
- `src/backend/base/langflow/api/v1/traces.py` — the traces router (mounted under
  `/api/v1/monitor/traces` by `src/backend/base/langflow/api/v1/monitor.py`).
- No provider key, no model, no network egress.
