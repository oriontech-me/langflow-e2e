# Bulk Delete Traces API — `DELETE /api/v1/monitor/traces?flow_id=...` contract

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

The `DELETE /api/v1/monitor/traces?flow_id=...` endpoint is the wire behind the **Clear All** button in the Flow Activity panel — it removes every trace row for a flow in a single statement (`sa.delete(TraceTable).where(flow_id == ...)` avoids an N+1 cascade). Before this spec the route had zero coverage; a regression that returned 500, dropped the ownership check, or silently retained rows would have shipped unnoticed.

This spec pins two paths:

1. **Negative path** — `DELETE /api/v1/monitor/traces?flow_id=<unknown-uuid>` returns **404**. The handler joins `flow → user`, so an unknown flow and a flow owned by a different user both collapse to the same response — one test covers both cases.
2. **Happy path** — with a seeded flow + run + emitted trace, `DELETE /api/v1/monitor/traces?flow_id=<flowId>` returns **204** (the handler is declared `status_code=204` — asserted exactly, not as a permissive 2xx). A subsequent `GET /monitor/traces?flow_id=<flowId>` returns the empty envelope (`traces.length === 0`, `total === 0`), pinning the post-conditions the UI relies on after the **Clear All** action.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

Both tests (negative and happy path) carry the same tag set.

---

## Step by step *(required)*

**Test 1 — `DELETE /api/v1/monitor/traces returns 404 for an unknown but well-formed flow_id`** *(standalone)*
1. Get a bearer token via `getAuthToken(request)`
2. `DELETE /api/v1/monitor/traces?flow_id=00000000-0000-0000-0000-000000000001` with Bearer auth
3. Assert HTTP 404

**`describe("Bulk delete traces — seeded flow")` — `beforeAll` (shared setup)**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/` with Bearer auth, name `traces-delete-test-<timestamp>`); capture `api_key` + `id`
3. Create a flow (`POST /api/v1/flows/` with `x-api-key` auth) from `tests/assets/flows/basic-prompting-trace-fixture.json`, name suffixed with the timestamp; expect HTTP 201; capture `flowId`
4. Run the flow once (`POST /api/v1/run/{flowId}` with `x-api-key` auth, `input_value: "delete-traces-probe"`, `input_type: "chat"`, `output_type: "chat"`). The fixture has no provider configured, so the LanguageModelComponent fails — the failure is **intentional**: the trace still lands. Accept HTTP 200 or 500
5. Poll `GET /api/v1/monitor/traces?flow_id=<flowId>` (Bearer auth) with intervals `[500, 1000, 2000]` ms up to 30 s until `body.traces.length > 0` — trace writes are asynchronous

**`afterAll`** — delete the flow (`x-api-key`) and the API key (Bearer). The DELETE under test only removes trace rows; the flow itself remains and must still be cleaned up. `Promise.allSettled` keeps each delete independent so one failure does not skip the other.

**Test 2 — `DELETE /api/v1/monitor/traces?flow_id=... clears all traces for the flow`**
1. `DELETE /api/v1/monitor/traces?flow_id=<flowId>` with Bearer auth
2. Assert HTTP **204** (exact match — the handler is declared `status_code=204`)
3. `GET /api/v1/monitor/traces?flow_id=<flowId>` with Bearer auth
4. Assert HTTP 200, `traces` is an empty array, and `total === 0`

---

## Validation criterion *(required)*

- **Test 1** — Pins the only documented failure path for the bulk DELETE endpoint: a 404 when no flow with that id belongs to the caller. A regression that returned 500, 403, or 204-no-op would surface here. Because the handler enforces ownership via the SQL join, this test also implicitly covers the "flow owned by a different user" case without needing a second user fixture.
- **Test 2** — Pins both the wire contract (exact `204 No Content` status) and the post-condition the UI relies on after the **Clear All** action (the list endpoint returns an empty envelope, `traces.length === 0` and `total === 0`). A handler that changed status to 200, that left rows behind on a partial failure, or that started returning `null` instead of `[]` for `traces` would surface here. The exact `204` assertion is intentional: a permissive 2xx range would mask a status drift that the frontend mutation handler would silently absorb but downstream API consumers might not.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/traces.py` (lines 170-196) — `DELETE /monitor/traces` handler; `status_code=204`; ownership enforced via `select(Flow).where(id == flow_id).where(user_id == current_user.id)`; the actual delete is a single `sa.delete(TraceTable).where(flow_id == ...)` statement
- `src/backend/base/langflow/services/database/models/traces/model.py` — `TraceTable` model; `TraceListResponse` envelope (`traces`, `total`, `pages`) consumed by the post-delete GET
- `src/frontend/src/pages/FlowPage/components/TraceComponent/FlowInsightsContent.tsx` (lines 78-96) — `useDeleteTracesMutation` call site behind the **Clear All** button
- `src/frontend/src/controllers/API/queries/traces/` — React Query hooks that invalidate the traces list after the mutation succeeds

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — minimal Basic Prompting flow with no provider configured; runs to a LanguageModelComponent error that still emits a trace
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/tests-automations/regression/core-functionality/observability-monitoring/traces-detail-single.spec.ts` — companion spec; the seeding pattern (key + flow + run + poll) is intentionally identical so both specs share the same well-understood failure mode of the trace fixture

---

## What this test does not cover *(optional)*

- **`DELETE /api/v1/monitor/traces/{trace_id}`** — the per-trace delete handler defined on the same router (`traces.py:138`) is exercised by no spec. Distinct contract (path param vs query param, single row vs bulk) — would deserve its own spec rather than an extension here.
- **`flow_id` query param missing** — the handler requires `flow_id` and FastAPI returns 422 if it is omitted; no test pins that today.
- **Idempotency of repeated DELETE on the same flow** — the SQL `DELETE` is naturally idempotent and the handler still returns 204 if zero rows match an owned flow (the ownership check passes; the delete is a no-op). Not asserted here because the second DELETE adds nothing the first DELETE did not already pin.
- **UI surface** — the **Clear All** button in `FlowInsightsContent.tsx`, its confirmation dialog, and the post-mutation grid refresh are not exercised by this spec. Adding a UI counterpart would belong alongside `traces-latency-tokens.spec.ts` test 2.
- **Negative auth path** (401/403 on missing/bad token) — no test pins this for the bulk DELETE endpoint.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required — the fixture is intentionally unconfigured

---

## Notes *(optional)*

- The negative test runs standalone (no setup) because it only needs a valid token. Keeping it outside the `describe` block avoids paying the seeding cost for a test that does not need it and matches the layout of `traces-detail-single.spec.ts` and `traces-detail.spec.ts`.
- The happy-path test runs inside a `describe` block with `mode: "serial"` and a shared `beforeAll`. The seeding pattern (key + flow + run + poll) is identical to `traces-detail-single.spec.ts` so both specs can rely on the same well-understood failure mode of the trace fixture.
- The exact `204` assertion (rather than a permissive `[200, 204]` range) is deliberate. The issue acceptance criteria allow either, but the handler today declares `204` — pinning the actual value catches an unintended change to `200` that a downstream caller might depend on for `Content-Length: 0` semantics.
