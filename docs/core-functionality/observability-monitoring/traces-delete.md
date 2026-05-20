# Bulk Delete Traces API — `DELETE /api/v1/monitor/traces?flow_id=...` contract

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

The `DELETE /api/v1/monitor/traces?flow_id=...` endpoint is the wire behind the **Clear All** button in the Flow Activity panel — it removes every trace row for a flow in a single statement (`sa.delete(TraceTable).where(flow_id == ...)` avoids an N+1 cascade). Before this spec the route had zero coverage; a regression that returned 500, dropped the ownership check, or silently retained rows would have shipped unnoticed.

This spec pins two paths:

1. **Negative path** — `DELETE /api/v1/monitor/traces?flow_id=<unknown-uuid>` returns **404**. This pins the unknown-flow 404 contract only — the cross-user authorization path is **not** exercised here (see "What this test does not cover").
2. **Happy path** — with a seeded flow + run + emitted trace, the test pins three things in sequence:
   - **Anchor:** the seeded flow has `traces.total > 0` before DELETE (asserted via the stable-count from `beforeAll`). Without this anchor a post-DELETE empty envelope could come from a degraded GET (the handler swallows DB errors and returns `traces=[]`, `total=0` at `traces.py:91-96`) and the assertion would pass for the wrong reason.
   - **Wire contract:** `DELETE` returns **204** with **empty body** (asserted exactly, not as a permissive 2xx range).
   - **Post-condition:** subsequent `GET /monitor/traces?flow_id=<flowId>` returns the empty envelope (`traces.length === 0`, `total === 0`).
   - **Idempotency + ownership probe:** a second `DELETE` on the same now-empty owned flow also returns **204** with empty body. This second DELETE is the only path that distinguishes "ownership enforced" from "id-only check" without seeding a second user — the ownership lookup passes, `sa.delete` deletes zero rows, the handler still returns 204.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

Both tests (negative and happy path) carry the same tag set.

---

## Step by step *(required)*

**Test 1 — `DELETE /api/v1/monitor/traces returns 404 for an unknown flow_id`** *(standalone)*
1. Get a bearer token via `getAuthToken(request)`
2. `DELETE /api/v1/monitor/traces?flow_id=00000000-0000-0000-0000-000000000001` with Bearer auth
3. Assert HTTP 404

**`describe("Bulk delete traces — seeded flow")` — `beforeAll` (shared setup)**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/` with Bearer auth, name `traces-delete-test-<timestamp>`); capture `api_key` + `id`
3. Create a flow (`POST /api/v1/flows/` with `x-api-key` auth) from `tests/assets/flows/basic-prompting-trace-fixture.json`, name suffixed with the timestamp; expect HTTP 201; capture `flowId`
4. Run the flow once (`POST /api/v1/run/{flowId}` with `x-api-key` auth, `input_value: "delete-traces-probe"`, `input_type: "chat"`, `output_type: "chat"`). The fixture has no provider configured, so the LanguageModelComponent fails — the failure is **intentional**: the trace still lands. Accept HTTP 200 or 500
5. **Stable-count poll** `GET /api/v1/monitor/traces?flow_id=<flowId>` (Bearer auth) with intervals `[500, 500, 1000, 1000, 2000]` ms up to 30 s. A single `length > 0` poll could fire DELETE while additional rows are still being inserted asynchronously, so the poll keeps reading until the count is the same across two consecutive reads (`stableConfirms >= 1`). Capture the final stable count as `initialTraceCount`

**`afterAll`** — delete the flow and the API key, both with the bearer token. Flow delete intentionally does **not** use the api_key so the two deletes can run concurrently without racing: if the api_key delete won the race, an `x-api-key` flow delete would 401 and the seeded flow would leak. `Promise.allSettled` keeps each delete independent.

**Test 2 — `DELETE /api/v1/monitor/traces?flow_id=... clears all traces, and a second DELETE on the empty owned flow still returns 204`**
1. Anchor: `expect(initialTraceCount).toBeGreaterThan(0)` — confirms the pre-DELETE state. A degraded GET that returns `traces=[], total=0` cannot satisfy this.
2. `DELETE /api/v1/monitor/traces?flow_id=<flowId>` with Bearer auth
3. Assert HTTP **204** **and** empty body (`(await res.body()).length === 0`). FastAPI returns no body on `status_code=204` by contract; a handler change to 204-with-body would be silently absorbed without the body length check.
4. `GET /api/v1/monitor/traces?flow_id=<flowId>` with Bearer auth → HTTP 200, `traces.length === 0`, `total === 0`
5. Second `DELETE /api/v1/monitor/traces?flow_id=<flowId>` with Bearer auth → HTTP 204 + empty body. The handler still has to pass the ownership lookup (`select(Flow).where(id == flow_id).where(user_id == current_user.id)`) before issuing `sa.delete` that deletes zero rows. A 404 here would mean the ownership check now rejects empty-trace flows; a non-204 success would mean the contract drifted

---

## Validation criterion *(required)*

- **Test 1** — Pins the unknown-flow 404 contract for the bulk DELETE endpoint. A regression that returned 500, 403, or 204-no-op against a non-existent flow_id would surface here. **Out of scope here:** the cross-user authorization path (foreign-owned flow). Although the handler joins flow → user, this single-user test cannot distinguish "ownership enforced and id unknown" from "no ownership check, just id unknown" — both produce 404. Test 2 supplies the missing ownership signal indirectly through its second DELETE (see below); a full cross-user 404 is documented as a gap.
- **Test 2** — Four assertions chained, each pinning a distinct contract:
  - The `initialTraceCount > 0` anchor blocks the "post-DELETE empty for the wrong reason" failure mode (handler GET swallows `TimeoutError`/`OperationalError`/`ProgrammingError` and returns the empty envelope, `traces.py:91-96`).
  - The exact `204` + empty-body check pins the wire contract; a permissive 2xx range or a handler emitting 204-with-body would slip through.
  - The post-DELETE `traces.length === 0` / `total === 0` pins the row-removal side effect.
  - The **second DELETE on the now-empty owned flow** pins that the ownership lookup passes for owned-but-empty flows (otherwise the handler would 404 once the rows are gone). This is the only assertion that exercises the ownership branch with a *real* owned flow — Test 1 cannot.
  - Combined: a partial-failure DELETE that left rows behind, a status drift, a contract change that 404s on empty owned flows, or a degraded GET masking the row-removal — all surface on this test.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/traces.py` — `delete_traces_by_flow` handler; `status_code=204`; ownership enforced via `select(Flow).where(id == flow_id).where(user_id == current_user.id)`; the actual delete is a single `sa.delete(TraceTable).where(flow_id == ...)` statement. Also `get_traces` (same file) for the swallow-errors-and-return-empty behavior the anchor assertion guards against.
- `src/backend/base/langflow/services/database/models/traces/model.py` — `TraceTable` model; `TraceListResponse` envelope (`traces`, `total`, `pages`) consumed by the post-delete GET
- `src/frontend/src/pages/FlowPage/components/TraceComponent/FlowInsightsContent.tsx` — `useDeleteTracesMutation` call site behind the **Clear All** button
- `src/frontend/src/controllers/API/queries/traces/` — React Query hooks that invalidate the traces list after the mutation succeeds

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — minimal Basic Prompting flow with no provider configured; runs to a LanguageModelComponent error that still emits a trace
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/tests-automations/regression/core-functionality/observability-monitoring/traces-detail-single.spec.ts` — companion spec; the seeding pattern (key + flow + run + poll) is intentionally identical so both specs share the same well-understood failure mode of the trace fixture

---

## What this test does not cover *(optional)*

- **Cross-user 404** — DELETE against a flow_id owned by a different user. The handler joins flow → user, so the response is 404 in that case too, but a single-user test cannot prove the join is actually doing the user filter. The second-DELETE assertion in Test 2 covers the *positive* side of ownership (owned-but-empty flow still passes the check); the *negative* side (foreign-owned flow) would require a second user fixture, which is not yet supported by the helpers.
- **`DELETE /api/v1/monitor/traces/{trace_id}`** — the per-trace delete handler defined on the same router is exercised by no spec. Distinct contract (path param vs query param, single row vs bulk) — would deserve its own spec rather than an extension here.
- **`flow_id` query param missing** — the handler requires `flow_id` and FastAPI returns 422 if it is omitted; no test pins that today.
- **UI surface** — the **Clear All** button in `FlowInsightsContent.tsx`, its confirmation dialog, and the post-mutation grid refresh are not exercised by this spec. Adding a UI counterpart would belong alongside `traces-latency-tokens.spec.ts` test 2.
- **Negative auth path** (401/403 on missing/bad token) — no test pins this for the bulk DELETE endpoint.
- **UUID `00000000-0000-0000-0000-000000000001` collision** — astronomically unlikely under UUIDv4, but Test 1 would silently start asserting the wrong contract if Langflow ever migrated `Flow.id` away from UUIDv4 and a flow was created with that exact id. Considered acceptable.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required — the fixture is intentionally unconfigured

---

## Notes *(optional)*

- The negative test runs standalone (no setup) because it only needs a valid token. Keeping it outside the `describe` block avoids paying the seeding cost for a test that does not need it and matches the layout of `traces-detail-single.spec.ts` and `traces-detail.spec.ts`.
- The happy-path test runs inside a `describe` block with `mode: "serial"` and a shared `beforeAll`. The seeding pattern (key + flow + run + poll) is identical to `traces-detail-single.spec.ts` so both specs can rely on the same well-understood failure mode of the trace fixture.
- The exact `204` + empty-body assertion (rather than a permissive `[200, 204]` range with no body check) is deliberate. The issue acceptance criteria allow either status, but the handler today declares `204` — pinning both the status and the body catches an unintended change to `200` or a handler emitting a body that downstream API consumers might choke on.
- The stable-count poll in `beforeAll` adds ~500 ms over a single-shot `length > 0` poll in the common case but eliminates a real flake vector: async trace inserts landing post-DELETE would otherwise survive the bulk delete and break the post-condition assertion in Test 2.
