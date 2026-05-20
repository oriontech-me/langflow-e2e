# Trace List Filters API — `GET /api/v1/monitor/traces` query params

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

`GET /api/v1/monitor/traces` accepts `status`, `query`, `start_time`, and `end_time` query params (`traces.py:48-55`). Before this spec only the `flow_id` filter was exercised by `traces-latency-tokens.spec.ts`; the other filters had zero coverage.

This spec pins four discriminative scenarios on the wire:

1. **`status=error`** returns only the failing trace; `?status=ok` on the same flow returns 0.
2. **`status=ok`** returns only the successful trace; `?status=error` on the same flow returns 0.
3. **`start_time=<future>`** returns 0 (every seeded trace precedes the cutoff).
4. **`query=<unique substring of trace name>`** returns exactly 1; `query=<garbage>` returns 0.

All assertions are scoped by `flow_id` so a concurrent run of another `@observability` test in the same user account cannot contaminate the totals.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

All four tests carry the same tag set.

---

## Step by step *(required)*

**`describe("Trace list filters — status / start_time / query")` — `beforeAll` (shared setup)**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/` with Bearer auth, name `traces-filters-test-<timestamp>`); capture `api_key` + `id`
3. Create **Flow A — error fixture** (`POST /api/v1/flows/` with `x-api-key`) from `tests/assets/flows/basic-prompting-trace-fixture.json`; expect HTTP 201; capture `errorFlowId`
4. Create **Flow B — ok fixture** (`POST /api/v1/flows/` with `x-api-key`) from `tests/assets/flows/chat-io-ok-trace-fixture.json`; expect HTTP 201; capture `okFlowId`
5. Run Flow A once (`POST /api/v1/run/{errorFlowId}` with `x-api-key`, `input_value: "filters-error-probe"`). The fixture has no provider configured, so the LanguageModelComponent fails — the failure is **intentional**: the trace still lands with `status=error`. Accept HTTP 200 or 500
6. Run Flow B once (`POST /api/v1/run/{okFlowId}` with `x-api-key`, `input_value: "filters-ok-probe"`). The fixture is pure `ChatInput → ChatOutput` — no LLM, no external dependency, run completes in `status=ok`. Expect HTTP 200
7. Poll `GET /api/v1/monitor/traces?flow_id=<id>` for each flow independently (intervals `[500, 1000, 2000]` ms up to 30 s) until `traces.length > 0`. Polling combined would race against the second insert
8. Capture `errorTraceNameProbe = errorFlowId` for use in the `?query=` test. The trace name has the form `<flow.name> - <flowId>`, and the flow UUID is unique across concurrent test runs

**`afterAll`** — delete both flows (`x-api-key`) and the API key (Bearer). `Promise.allSettled` keeps each delete independent.

**Test 1 — `?status=error returns only the failing trace`**
1. `GET /api/v1/monitor/traces?flow_id=<errorFlowId>&status=error` → 200, `total === 1`, `traces[0].status === "error"`, `traces[0].flowId === errorFlowId`
2. `GET /api/v1/monitor/traces?flow_id=<errorFlowId>&status=ok` → 200, `total === 0`, `traces.length === 0`

**Test 2 — `?status=ok returns only the successful trace`**
1. `GET /api/v1/monitor/traces?flow_id=<okFlowId>&status=ok` → 200, `total === 1`, `traces[0].status === "ok"`, `traces[0].flowId === okFlowId`
2. `GET /api/v1/monitor/traces?flow_id=<okFlowId>&status=error` → 200, `total === 0`, `traces.length === 0`

**Test 3 — `?start_time=<future> returns empty`**
1. Compute `future = new Date(Date.now() + 3600_000).toISOString()`
2. `GET /api/v1/monitor/traces?flow_id=<errorFlowId>&start_time=<future>` → 200, `total === 0`, `traces.length === 0`

**Test 4 — `?query=<substring> filters by trace name/id/session`**
1. `GET /api/v1/monitor/traces?flow_id=<errorFlowId>&query=<errorFlowId>` → 200, `total === 1`, `traces[0].flowId === errorFlowId`
2. `GET /api/v1/monitor/traces?flow_id=<errorFlowId>&query=zzz-no-trace-name-matches-this-<timestamp>` → 200, `total === 0`, `traces.length === 0`

---

## Validation criterion *(required)*

- **Tests 1 + 2** — Pin the only documented behavior of `?status=` together: each value matches exactly the traces with that status and rejects the others. A regression that ignored the filter (returning all traces), inverted it, or accepted an unknown value (`"failed"` instead of `"error"`) would surface on at least one of the four assertions. Splitting into two tests, each owning one flow, keeps a failure narrow enough to point at the exact mismatch.
- **Test 3** — Pins the lower-bound semantics of `?start_time` (`TraceTable.start_time >= start_time`, `repository.py:178-179`). A handler that flipped the comparator, or that parsed the ISO timestamp into a far-past value, would return non-empty here.
- **Test 4** — Pins the `query` ILIKE behavior on `TraceTable.{name, id, session_id}` (`repository.py:169-177`). Both halves matter: the hit asserts the filter actually narrows; the miss asserts it does not silently return all traces when the substring is absent. Using a 36-char UUID as the probe also implicitly exercises the 50-char `sanitize_query_string` cap (`validation.py`) — a regression dropping the cap would still match.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/traces.py` (lines 45-99) — `GET /monitor/traces` handler; query params declared at lines 48-55; calls `sanitize_query_string` then `fetch_traces`
- `src/backend/base/langflow/services/tracing/repository.py` (lines 134-189) — `fetch_traces` builds the filter expression list; `status` is an `==`, `start_time` is `>=`, `query` is `ILIKE %x%` across `name | id | session_id`
- `src/backend/base/langflow/services/tracing/validation.py` — `sanitize_query_string` truncates query to 50 chars and strips non-printable ASCII; relevant to the UUID-as-probe choice
- `src/backend/base/langflow/services/tracing/native.py` (line 296) — sets `trace_status = SpanStatus.ERROR if (error or has_span_errors) else SpanStatus.OK`; explains why `ChatInput → ChatOutput` resolves to `ok` and `basic-prompting` (with the LM error) resolves to `error`
- `src/backend/base/langflow/services/database/models/traces/model.py` — `SpanStatus` enum (`unset | ok | error`)

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — error fixture (no provider configured → LanguageModelComponent fails → `status=error`)
- `tests/assets/flows/chat-io-ok-trace-fixture.json` — ok fixture (`ChatInput → ChatOutput`, pure local I/O → `status=ok`); derived programmatically from the basic-prompting fixture to keep the React Flow handle encoding identical
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/tests-automations/regression/core-functionality/observability-monitoring/traces-latency-tokens.spec.ts` — list-endpoint contract for `flow_id`; companion to this spec

---

## What this test does not cover *(optional)*

- **`?status=unset`** — neither fixture emits `unset` (Chat I/O → `ok`, basic-prompting → `error`). Producing `unset` deterministically would require a fixture for which `native.py` exits the run before any span error is raised — not obviously reachable without forking the tracer. Deliberate gap.
- **`?query=` substring of `input_value` / message content** — the handler's `ILIKE` is only on `TraceTable.{name, id, session_id}` (`repository.py:173-175`), not on message body. A test that filtered by `input_value` would silently fail to narrow. The issue text suggested "substring of input_value" — that contract does not exist on the handler. Filed as a non-gap.
- **`?end_time`** — symmetric to `start_time` (line 180-181). Lower-bound test alone pins the comparator direction; adding the upper bound would not catch a regression the existing test misses.
- **`?session_id=`** — declared in the handler signature but no spec exercises it; the existing fixtures pass no session_id at run time, so the column lands as the auto-generated value. Out of scope here; would warrant its own spec with a session_id explicitly threaded through the run payload.
- **Combined filters** (e.g., `?status=ok&start_time=<past>`) — each filter is asserted standalone. The repository combines filters with `AND` over the `filters: list` (`repository.py:183-185`), so combined behavior is a structural consequence of the per-filter contract — not asserted explicitly.
- **`?page` / `?size` pagination** — out of scope for this spec; would need a fixture that emits enough traces to span pages.
- **Negative auth path** (401/403 on missing/bad token) — no test pins this for the list endpoint.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required — both fixtures run end-to-end without external credentials

---

## Notes *(optional)*

- The two flows are seeded once in `beforeAll` and reused across all four tests in `mode: "serial"`. The describe block runs single-flow on purpose: the four tests share the seeded state and would race each other if Playwright sharded them.
- The `query` probe is the error-flow UUID. It is 36 ASCII characters, well under the 50-char sanitizer cap, and unique to this run — so a concurrent test that happened to land a trace with the same `name` substring would have to share a flow id, which is not possible.
- The ok fixture (`chat-io-ok-trace-fixture.json`) was built by deriving a minimal `ChatInput → ChatOutput` slice from `basic-prompting-trace-fixture.json`, preserving the exact React Flow handle encoding (the `œ`-substituted JSON in `sourceHandle` / `targetHandle` / edge id). Hand-editing a brand-new fixture would risk an invalid handle that the importer silently accepts but the executor rejects.
- The `start_time` test uses a one-hour-future cutoff, comfortably above any clock skew between the test client and the Langflow container.
