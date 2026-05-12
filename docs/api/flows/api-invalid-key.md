# API Invalid Key Handling

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates that Langflow rejects unauthenticated and badly-authenticated REST API requests on the routes that change or read flow state. The endpoints under test must return `401`, `403`, or — for malformed bodies on flow creation — `422`. The test also confirms that a rejected `PATCH` does **not** mutate the underlying flow, which is the behavior callers depend on when integrating against Langflow.

If any of these tests fail, the auth boundary on the public REST API has regressed and Langflow leaks write/read access to anyone with network reach to the backend.

---

## Tags *(required)*
`@stable` `@release` `@api` `@workspace` `@regression`

---

## Step by step *(required)*

The spec runs **6 independent tests** via Playwright's `request` fixture. Tests that need a real flow create one with a valid Bearer token (obtained via `getAuthToken`) and clean it up in a `finally` block.

---

**Test 1 — `POST /api/v1/flows/` with invalid Bearer token**
1. POST a minimal flow with `Authorization: Bearer invalid-token-xyz`
2. Assert response status is in `[401, 403, 422]`

**Test 2 — `GET /api/v1/flows/` without `Authorization` header**
1. GET with empty headers
2. Assert response status is in `[401, 403]`

**Test 3 — `GET /api/v1/flows/{id}` with invalid Bearer token**
1. GET a synthetic UUID with `Authorization: Bearer totally-invalid-token`
2. Assert response status is in `[401, 403]`

**Test 4 — `POST /api/v1/run/{id}` with invalid `x-api-key`**
1. Create a real flow with a valid Bearer token (`expect(createRes.status()).toBe(201)` — guarantees `flowId` exists for cleanup)
2. POST `/api/v1/run/{flowId}` with `x-api-key: invalid-api-key-0000`
3. Assert response status is in `[401, 403]`
4. `finally`: delete the created flow with the valid Bearer token

**Test 5 — `DELETE /api/v1/flows/{id}` without `Authorization` header**
1. DELETE a synthetic UUID with empty headers
2. Assert response status is in `[401, 403]`

**Test 6 — `PATCH /api/v1/flows/{id}` with wrong token does not mutate the flow**
1. Create a real flow with a valid Bearer token (same guarantee as Test 4)
2. PATCH the flow with `Authorization: Bearer wrong-token-here` and a new name
3. Assert PATCH response status is in `[401, 403]`
4. GET the flow with the valid Bearer token
5. Assert GET status is `200` and `body.name` equals the original name (no mutation)
6. `finally`: delete the created flow

---

## Validation criterion *(required)*
- Every "rejected status" assertion across the 6 tests returns one of the documented codes (`401`, `403`, or `422` for malformed-create).
- The `PATCH` rejection in Test 6 leaves the flow's `name` field unchanged when read back.
- All created flows are cleaned up; no leaked test fixtures remain after the run.

---

## What this test does not cover *(optional)*
- Expired or revoked tokens (separate concern from "invalid format")
- Cross-tenant access (a valid token from user A trying to read user B's flows)
- Rate limiting or repeated-failure lockout
- WebSocket / streaming endpoint authentication
- The `/api/v1/run/{id}` happy path with a valid `x-api-key` (covered by `api-run-flow.spec.ts`)

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`
- Default superuser credentials available (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) — used by `getAuthToken` to mint a valid Bearer for setup/cleanup
- No third-party API keys required

---

## External dependencies *(required)*
- `tests/helpers/auth/get-auth-token.ts` — issues a valid `Bearer` via `/api/v1/auto_login`; if its contract changes, Tests 4 and 6 break
- `src/backend/base/langflow/api/v1/flows.py` (or wherever the flows router is mounted) — the spec is bound to the documented status-code semantics; loosening rejection to `200` would silently leak access
- `src/backend/base/langflow/api/v1/endpoints.py` — `/api/v1/run/{id}` auth path; if it switches from `x-api-key` back to Bearer, Test 4 needs adjustment
