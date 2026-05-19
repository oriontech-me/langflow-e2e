# Traces — Transactions API Shape

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Pins the contract of the `GET /api/v1/monitor/transactions` endpoint that the Traces UI consumes: always returns a paginated response shape (`{ items, total, page, size, pages }`), enforces the `flow_id` filter, and emits record fields that downstream observability work depends on. A regression on the wire format would break the Traces grid before any UI test fires.

This file covers the REST surface only; deeper UI flows (Flow Activity columns, Trace Details modal, span tree) live in `traces-latency-tokens.spec.ts`, and the empty-state UI smoke lives in `traces.spec.ts`.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

---

## Step by step *(required)*

**Test 1 — `GET /api/v1/monitor/transactions returns 200 with paginated result`**
1. Get a bearer token via `getAuthToken(request)`
2. `GET /api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001` with `Authorization: <token>`
3. Assert HTTP 200; the body is a non-null object; `body.items` is an array; `body.total` is a number; and `body` contains the pagination keys `page`, `size`, `pages`

**Test 2 — `GET /api/v1/monitor/transactions filters by flow_id (UUID)`**
1. Get a bearer token
2. `GET /api/v1/monitor/transactions?flow_id=00000000-0000-0000-0000-000000000001` (a well-formed UUID that maps to no real flow)
3. Assert HTTP 200, `body.items` is an array, `body.items.length === 0`, `body.total === 0`

**Test 3 — `transaction records contain required fields when not empty`** (runs inside a serial `describe` block that seeds a flow run in `beforeAll`)

_Seeding (`beforeAll`)_
1. Get a bearer token and create an API key via `POST /api/v1/api_key/`
2. Import `tests/assets/flows/basic-prompting-trace-fixture.json` via `POST /api/v1/flows/` (using `x-api-key`)
3. Trigger one run via `POST /api/v1/run/<flowId>`; accept HTTP 200 or 500 — the fixture has no provider configured and fails at the LanguageModelComponent, which is intentional and still emits a transaction row
4. Poll `GET /api/v1/monitor/transactions?flow_id=<flowId>` until `items.length > 0` (timeout 30 s)

_Test body_
1. `GET /api/v1/monitor/transactions?flow_id=<flowId>` (the real seeded flow id, not the placeholder UUID)
2. Assert HTTP 200, `body.items` is an array, `body.items.length > 0`
3. Assert the first record is a plain object (not null, not an array) and carries at least one of `timestamp` / `created_at` / `updated_at`

_Cleanup (`afterAll`)_
1. Delete the seeded flow via `DELETE /api/v1/flows/<flowId>`
2. Delete the API key via `DELETE /api/v1/api_key/<apiKeyId>`

---

## Validation criterion *(required)*

- **Test 1** — The endpoint returns the full fastapi-pagination envelope `{ items, total, page, size, pages }`. Every key is asserted to be present so a regression that drops any of them — even silently — would surface here before the Traces UI (`FlowInsightsContent.tsx`) breaks at render time.
- **Test 2** — A well-formed `flow_id` that maps to no rows returns `200` with an empty `items` array, not `400` or `404`. This pins the contract that "unknown flow_id" is a normal empty result and not an error condition.
- **Test 3** — After seeding one transaction by running a real flow, the emitted record exposes a recognizable timestamp field (`timestamp`, `created_at`, or `updated_at`). The Traces UI orders rows by time; removing every recognizable timestamp would break the grid silently. The seed step is mandatory: on a clean Langflow instance no transactions exist for the fixture's flow id, so without it the assertion would never execute.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/monitor.py` — `GET /transactions` handler (line 558); `transform_transaction_table_for_logs`; auth dependency via `get_current_active_user`
- `src/backend/base/langflow/services/database/models/transactions/model.py` — `TransactionLogsResponse`, `TransactionTable`
- `src/frontend/src/pages/FlowPage/components/TraceComponent/FlowInsightsContent.tsx` — consumer of the paginated transactions/traces shape

References in this repository:

- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/assets/flows/basic-prompting-trace-fixture.json` — minimal flow imported by test 3's `beforeAll` to seed one transaction row

---

## What this test does not cover *(optional)*

- UI assertions on the actual Traces grid (latency column, tokens column, Trace Details modal, span tree) — covered by `traces-latency-tokens.spec.ts`.
- The empty-state UI smoke (template loaded, no run, Traces panel shows "No Data Available") — covered by `traces.spec.ts`.
- Pagination behavior beyond the envelope shape (e.g. `page`, `size`, `pages` boundary conditions). The current tests assert the keys exist but not their values across multiple pages.
- Negative auth path — a `GET /api/v1/monitor/transactions` without `Authorization` returning 401/403. The backend enforces it via `Depends(get_current_active_user)`, but no test pins that contract here yet.
- The `/api/v1/monitor/messages` endpoint — covered by `api/flows/api-monitor-messages.spec.ts` and `api/flows/api-monitor-messages-crud.spec.ts`.
- The `/api/v1/monitor/traces` endpoint shape (latency / tokens / span tree) — covered by `traces-latency-tokens.spec.ts`. Test 3 here seeds via the same fixture but polls `/monitor/transactions`, which is a distinct endpoint with a distinct record schema.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required

---

## Notes *(optional)*

- A fourth test (`traces page is accessible from main navigation`) was previously in this file and was removed in the same PR that introduced this doc. It called `page.goto("/logs")` and asserted the app-shell selector `mainpage_title`, on the premise that `/logs` was a frontend route for the traces view. In current Langflow `/logs` is a **backend** endpoint (defined at `src/backend/base/langflow/api/log_router.py`, line 75) that returns `{"detail": "Log retrieval is disabled"}` when log retrieval is off — there is no frontend page at that path. The traces UI is flow-scoped, accessed via the Traces button on the flow toolbar (covered by `traces.spec.ts`) or `sidebar-nav-traces` inside the flow sidebar (covered by `traces-latency-tokens.spec.ts`), so no coverage was lost by removing the broken test.
- Tests 1 and 2 reuse the same well-formed UUID `00000000-0000-0000-0000-000000000001` because the endpoint requires `flow_id` and the envelope-shape and empty-result assertions must not depend on the database having any pre-existing flow. Test 3 cannot use the same UUID — there are no transactions for a fake flow id, so the assertion would never execute on a clean environment — and therefore seeds its own flow + run + cleanup inside a serial `describe` block.
