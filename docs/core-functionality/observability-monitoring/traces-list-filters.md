# Trace List Filters API — `GET /api/v1/monitor/traces` query params

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

`GET /api/v1/monitor/traces` accepts `status`, `query`, `start_time`, `end_time`, and `session_id` query params (`traces.py:48-55`). Before this spec only the `flow_id` filter was exercised by `traces-latency-tokens.spec.ts`; the other filters had zero coverage.

This spec pins five discriminative scenarios on the wire:

1. **`status=error`** returns only the failing trace; `?status=ok` on the same flow returns 0; `?status=<unknown>` returns **422** (Pydantic enum rejection).
2. **`status=ok`** returns only the successful trace; `?status=error` on the same flow returns 0.
3. **`start_time`** is asserted on both halves of the `>=` comparator: a past cutoff returns 1 (pinning the direction), a future cutoff returns 0 (pinning that the filter is wired).
4. **`query=<substring>`** is asserted three ways: a 36-char UUID probe inside the trace name returns 1; a 60-char probe (longer than the 50-char `sanitize_query_string` cap) whose first 50 chars are still inside the name returns 1 (pinning the cap behavior); a garbage probe returns 0.
5. **`session_id`** is asserted against a session id threaded through the ok run's payload: the exact match returns 1, an unknown session returns 0.

All assertions are scoped by `flow_id` so a concurrent run of another `@observability` test in the same user account cannot contaminate the totals.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

All five tests carry the same tag set.

---

## Step by step *(required)*

**`describe("Trace list filters — status / start_time / query / session_id")` — `beforeAll` (shared setup)**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/` with Bearer auth, name `traces-filters-test-<timestamp>`); capture `api_key` + `id`
3. Create **Flow A — error fixture** (`POST /api/v1/flows/` with `x-api-key`) from `tests/assets/flows/basic-prompting-trace-fixture.json`; expect HTTP 201; capture `errorFlowId`
4. Create **Flow B — ok fixture** (`POST /api/v1/flows/` with `x-api-key`) from `tests/assets/flows/chat-io-ok-trace-fixture.json`; expect HTTP 201; capture `okFlowId`
5. Run Flow A once (`POST /api/v1/run/{errorFlowId}` with `x-api-key`, `input_value: "filters-error-probe"`). The fixture has no provider configured, so the LanguageModelComponent fails — the failure is **intentional**: the trace still lands with `status=error`. Accept HTTP 200 or 500
6. Run Flow B once (`POST /api/v1/run/{okFlowId}` with `x-api-key`, `input_value: "filters-ok-probe"`, `session_id: "filters-ok-session-<timestamp>"`). Threading a unique `session_id` lets the `?session_id=` filter target a deterministic value persisted on `TraceTable.session_id`. Expect HTTP 200
7. Poll `GET /api/v1/monitor/traces?flow_id=<id>` for each flow independently (intervals `[500, 1000, 2000]` ms up to 30 s) until `traces.length > 0`. Polling combined would race against the second insert
8. Capture and assert `errorTraceName` — fetch the error-trace list, capture `traces[0].name`, and `expect(name).toContain(errorFlowId)`. The handler ILIKEs on `{name, id, session_id}`; in this setup the flow UUID is not the trace.id and we did not pass a session_id on the error run, so the `?query=` UUID hit must go through `name`. Asserting the substring here means a future change to the trace-name format surfaces at setup time, not as a confusing 0-hit on the query test

**`afterAll`** — delete both flows (`x-api-key`) and the API key (Bearer). `Promise.allSettled` keeps each delete independent.

**Test 1 — `?status=error returns only the failing trace; rejects unknown values`**
1. `GET ?flow_id=<errorFlowId>&status=error` → 200, `total === 1`, `traces[0].status === "error"`, `flowId === errorFlowId`
2. `GET ?flow_id=<errorFlowId>&status=ok` → 200, `total === 0`
3. `GET ?flow_id=<errorFlowId>&status=failed` → **422** (FastAPI/Pydantic enum rejection; a handler that loosened the enum to plain str would leak through)

**Test 2 — `?status=ok returns only the successful trace`**
1. `GET ?flow_id=<okFlowId>&status=ok` → 200, `total === 1`, `traces[0].status === "ok"`, `flowId === okFlowId`
2. `GET ?flow_id=<okFlowId>&status=error` → 200, `total === 0`

**Test 3 — `?start_time pins the >= lower bound`**
1. `past = now - 1h` → `GET ?flow_id=<errorFlowId>&start_time=<past>` → 200, `total === 1` (pins the comparator direction — a `<=` regression would return 0 here)
2. `future = now + 1h` → `GET ?flow_id=<errorFlowId>&start_time=<future>` → 200, `total === 0` (pins that the filter is wired and not a no-op)

**Test 4 — `?query=<substring> filters by trace name (incl. 50-char sanitize cap)`**
1. `GET ?flow_id=<errorFlowId>&query=<errorFlowId>` → 200, `total === 1`
2. `longProbe = errorTraceName.slice(0, 60)` (asserted `>50` so the sanitizer cap engages) → `GET ?flow_id=<errorFlowId>&query=<longProbe>` → 200, `total === 1`. The sanitizer caps to 50 chars; the truncated string is still inside `errorTraceName`, so the ILIKE must still hit
3. `GET ?flow_id=<errorFlowId>&query=zzz-no-trace-name-matches-this-<timestamp>` → 200, `total === 0`

**Test 5 — `?session_id filters by the session passed at run time`**
1. `GET ?flow_id=<okFlowId>&session_id=<okSessionId>` → 200, `total === 1`, `traces[0].sessionId === okSessionId`
2. `GET ?flow_id=<okFlowId>&session_id=missing-session-<timestamp>` → 200, `total === 0`

---

## Validation criterion *(required)*

- **Tests 1 + 2** — Pin the behavior of `?status=` together: each enum value matches exactly the traces with that status and rejects the others. Test 1 also pins the *type contract* on the query param — a regression that loosened `SpanStatus` to `str` and accepted any value (e.g. `failed` falling through to a `LIKE`) would surface on the 422 assertion.
- **Test 3** — Two-sided. The past-cutoff hit pins the *direction* of the comparator (`>=`, `repository.py:178-179`): a swap to `<=` would return 0 against a past cutoff. The future-cutoff miss pins that the filter is *wired* and not a silent no-op. Either half alone would be insufficient — the past half catches a flipped comparator, the future half catches a dropped filter.
- **Test 4** — Pins the `query` ILIKE behavior on `TraceTable.{name, id, session_id}` (`repository.py:169-177`) *and* the 50-char `sanitize_query_string` cap (`validation.py`). The short-probe hit asserts the filter narrows; the long-probe hit pins that a query longer than the cap is sanitized (not rejected, not used raw — both regressions would surface here); the garbage miss asserts the filter does not silently return all traces.
- **Test 5** — Pins the `?session_id=` exact-match behavior (`TraceTable.session_id == session_id`, `repository.py:165-166`) and confirms that `session_id` passed in the run payload is persisted on the trace row. A regression that dropped session_id from the run-graph plumbing (so the column landed `None`) would surface on the hit assertion.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/traces.py` (lines 45-99) — `GET /monitor/traces` handler; query params declared at lines 48-55; calls `sanitize_query_string` then `fetch_traces`
- `src/backend/base/langflow/services/tracing/repository.py` (lines 134-189) — `fetch_traces` builds the filter expression list; `status` and `session_id` are `==`, `start_time` is `>=`, `end_time` is `<=`, `query` is `ILIKE %x%` across `name | id | session_id`
- `src/backend/base/langflow/services/tracing/validation.py` — `sanitize_query_string` truncates query to 50 chars and strips non-printable ASCII
- `src/backend/base/langflow/services/tracing/native.py` (line 296) — sets `trace_status = SpanStatus.ERROR if (error or has_span_errors) else SpanStatus.OK`; explains why `ChatInput → ChatOutput` resolves to `ok` and `basic-prompting` (with the LM error) resolves to `error`
- `src/backend/base/langflow/services/database/models/traces/model.py` — `SpanStatus` enum (`unset | ok | error`)
- `src/backend/base/langflow/api/v1/endpoints.py` (line 992) — `/api/v1/run/{flow_id}` accepts `session_id` in the request body and threads it through the graph executor

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — error fixture (no provider configured → LanguageModelComponent fails → `status=error`)
- `tests/assets/flows/chat-io-ok-trace-fixture.json` — ok fixture (`ChatInput → ChatOutput`, pure local I/O → `status=ok`); derived programmatically from the basic-prompting fixture to keep the React Flow handle encoding identical
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/tests-automations/regression/core-functionality/observability-monitoring/traces-latency-tokens.spec.ts` — list-endpoint contract for `flow_id`; companion to this spec

---

## What this test does not cover *(optional)*

- **`?status=unset`** — neither fixture emits `unset` (Chat I/O → `ok`, basic-prompting → `error`). Producing `unset` deterministically would require a fixture for which `native.py` exits the run before any span error is raised — not obviously reachable without forking the tracer. Deliberate gap.
- **`?query=` substring of `input_value` / message content** — the handler's `ILIKE` is only on `TraceTable.{name, id, session_id}` (`repository.py:173-175`), not on message body. The handler does not expose that contract; calling it a gap would misrepresent the surface. Filed as a non-gap.
- **`?end_time`** — the upper bound is `TraceTable.start_time <= end_time` (line 180-181). Symmetric to `start_time`; the two-sided test on `start_time` already pins the comparator pattern. Adding `end_time` would mirror those assertions without exercising new code paths.
- **Combined filters** (e.g., `?status=ok&start_time=<past>`) — each filter is asserted standalone. The repository combines filters with `AND` over the `filters: list` (`repository.py:183-185`), so combined behavior is a structural consequence of the per-filter contract — not asserted explicitly.
- **`?page` / `?size` pagination** — out of scope for this spec; would need a fixture that emits enough traces to span pages.
- **Negative auth path** (401/403 on missing/bad token) — no test pins this for the list endpoint.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required — both fixtures run end-to-end without external credentials
- `describe.configure({ mode: "serial" })` is load-bearing: the five tests share a single `beforeAll` that seeds two flows + two runs. A block-level comment above the describe restates this so future refactors don't drop the serial config

---

## Notes *(optional)*

- The two flows are seeded once in `beforeAll` and reused across all five tests in `mode: "serial"`. The session_id is also captured once and reused; a separate session_id per test would multiply the seeding cost without any gain.
- The `query` probes are intentionally rooted in `errorTraceName`, which is captured *and asserted* in `beforeAll` (`expect(errorTraceName).toContain(errorFlowId)`). If a future Langflow release renames the trace or drops the flow_id from the name, the setup fails fast at the assertion rather than the query test silently hitting `total=0`.
- The ok fixture (`chat-io-ok-trace-fixture.json`) was built by deriving a minimal `ChatInput → ChatOutput` slice from `basic-prompting-trace-fixture.json`, preserving the exact React Flow handle encoding (the `œ`-substituted JSON in `sourceHandle` / `targetHandle` / edge id). Hand-editing a brand-new fixture would risk an invalid handle that the importer silently accepts but the executor rejects.
- The `start_time` test uses ±1-hour cutoffs, comfortably above any clock skew between the test client and the Langflow container.
