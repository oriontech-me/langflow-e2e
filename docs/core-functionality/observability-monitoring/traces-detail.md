# Traces — Transactions API Shape

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Pins the contract of the `GET /api/v1/monitor/transactions` endpoint that the Traces UI consumes: always returns a paginated response shape (`{ items, total, page, size, pages }`), enforces the `flow_id` filter, and emits record fields that downstream observability work depends on. A regression on the wire format would break the Traces grid before any UI test fires.

This file covers the REST surface only; deeper UI flows (Flow Activity columns, Trace Details modal, span tree) live in `traces-latency-tokens.spec.ts`, and the empty-state UI smoke lives in `traces.spec.ts`.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace` `@api` `@observability`

---

## Step by step *(required)*

**Test 1 — `GET /api/v1/monitor/transactions returns 200 with paginated result`**
1. Get a bearer token via `getAuthToken(request)`
2. `GET /api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001` with `Authorization: <token>`
3. Assert HTTP 200; the body is a non-null object; `body.items` is an array; `body.total` is a number

**Test 2 — `GET /api/v1/monitor/transactions filters by flow_id (UUID)`**
1. Get a bearer token
2. `GET /api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001` (a well-formed UUID that maps to no real flow)
3. Assert HTTP 200, `body.items` is an array, `body.items.length === 0`, `body.total === 0`

**Test 3 — `transaction records contain required fields when not empty`**
1. Get a bearer token
2. `GET /api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001` and parse `body.items`
3. If `items.length === 0`, the test returns early (nothing to validate)
4. Otherwise assert the first record is a plain object (not null, not an array) and carries at least one of `timestamp` / `created_at` / `updated_at`

---

## Validation criterion *(required)*

- **Test 1** — The endpoint returns the paginated envelope shape `{ items: [], total, page, size, pages }`. A regression where `total` is missing or `items` is not an array would break the Traces UI (`FlowInsightsContent.tsx` expects this shape) and surface here first.
- **Test 2** — A well-formed `flow_id` that maps to no rows returns `200` with an empty `items` array, not `400` or `404`. This pins the contract that "unknown flow_id" is a normal empty result and not an error condition.
- **Test 3** — When transactions exist, each record exposes a recognizable timestamp field (`timestamp`, `created_at`, or `updated_at`). The Traces UI orders rows by time; removing every recognizable timestamp would break the grid silently.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/monitor.py` — `GET /transactions` handler (line 558); `transform_transaction_table_for_logs`; auth dependency via `get_current_active_user`
- `src/backend/base/langflow/services/database/models/transactions/model.py` — `TransactionLogsResponse`, `TransactionTable`
- `src/frontend/src/pages/FlowPage/components/TraceComponent/FlowInsightsContent.tsx` — consumer of the paginated transactions/traces shape

References in this repository:

- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser

---

## What this test does not cover *(optional)*

- Running a flow and confirming a real transaction is emitted — covered by `traces-latency-tokens.spec.ts`, which seeds a flow via API, runs it, and polls `/api/v1/monitor/traces` for emitted rows.
- UI assertions on the actual Traces grid (latency column, tokens column, Trace Details modal, span tree) — covered by `traces-latency-tokens.spec.ts`.
- The empty-state UI smoke (template loaded, no run, Traces panel shows "No Data Available") — covered by `traces.spec.ts`.
- Pagination behavior beyond the envelope shape (e.g. `page`, `size`, `pages` boundary conditions). The current tests assert the keys exist but not their values across multiple pages.
- Negative auth path — a `GET /api/v1/monitor/transactions` without `Authorization` returning 401/403. The backend enforces it via `Depends(get_current_active_user)`, but no test pins that contract here yet.
- The `/api/v1/monitor/messages` endpoint — covered by `api/flows/api-monitor-messages.spec.ts` and `api/flows/api-monitor-messages-crud.spec.ts`.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required

---

## Notes *(optional)*

- A fourth test (`traces page is accessible from main navigation`) was previously in this file and was removed in the same PR that introduced this doc. It called `page.goto("/logs")` and asserted the app-shell selector `mainpage_title`, on the premise that `/logs` was a frontend route for the traces view. In current Langflow `/logs` is a **backend** endpoint (defined at `src/backend/base/langflow/api/log_router.py`, line 75) that returns `{"detail": "Log retrieval is disabled"}` when log retrieval is off — there is no frontend page at that path. The traces UI is flow-scoped, accessed via the Traces button on the flow toolbar (covered by `traces.spec.ts`) or `sidebar-nav-traces` inside the flow sidebar (covered by `traces-latency-tokens.spec.ts`), so no coverage was lost by removing the broken test.
- All three remaining tests reuse the same well-formed UUID `00000000-0000-0000-0000-000000000001` because the endpoint requires `flow_id` and the suite must not depend on the database having any pre-existing flow.
