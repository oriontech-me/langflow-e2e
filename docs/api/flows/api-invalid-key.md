# API Invalid Key Handling

**Last validated:** Langflow 1.13.x (`1.13.0.dev12`)

---

## What this test validates *(required)*
Validates that Langflow rejects unauthenticated and badly-authenticated REST API requests on the routes that change or read flow state. The endpoints under test must return `401`, `403`, or — for malformed bodies on flow creation — `422`. The test also confirms that a rejected `PATCH` does **not** mutate the underlying flow, which is the behavior callers depend on when integrating against Langflow.

If any of these tests fail, the auth boundary on the public REST API has regressed and Langflow leaks write/read access to anyone with network reach to the backend.

---

## The defect Test 6 caught — `LE-2598` (#1807), fixed in `1.13.0.dev14`

Test 6's step 4 is the one assertion in this file that is **not** about the auth
boundary: it reads the flow back with a valid token to prove the rejected `PATCH` did
not mutate it. That read can answer `404 {"detail":"Flow not found"}` for a flow the
`POST` in step 1 has just created, and on a loaded instance it does. The cause is not
this route and not the auth path: **every write route taking `DbSession` answers its 2xx
before the transaction commits**, so a read issued with the id the write just returned
can correctly find nothing. The mechanism, the five links and the causal proof are
documented once in `docs/api/flows/api-flows-versions.md`.

It fired on the 2026-09-10 daily ([run 34478166565](https://github.com/oriontech-me/langflow-e2e/actions/runs/34478166565), triage #1806 → #1807): attempts 0 and 1
failed at `12:47:13.262` and `12:47:14.435`, and attempt 2 passed 1.7 s later — one of
four tests across three routes inside the same 16 s window on shard 3.

**This file is where the window is most misleading, which is the reason to instrument
it.** A bare `Expected: 200 / Received: 404` on the step that checks *"the wrong-token
`PATCH` did not change the flow"* reads as a **security** finding — a rejected write that
destroyed the row — in a spec whose whole subject is the auth boundary. It is not: the
`PATCH` is rejected before it touches anything, and the flow is simply not visible yet.
Attribution turns the most alarming possible misreading into a named, transient shape.

**`@stable` stays on** across all six tests. Test 6 recovered on attempt 2, so the
daily's auto-removal never took the tag, and this file is `@release` besides — removing
it by hand would have dropped the auth boundary out of both the daily and the deploy
gate over a defect that is neither in the auth path nor ours.

**The fix, verified rather than assumed.** `langflow#15078` scopes the session
dependency to the function (`Depends(injectable_session_scope, scope="function")`) —
including the five auth dependencies in `services/auth/utils.py`, which is the half that
touches this file — so the commit precedes the response; it back-merged into the 1.13
line between `1.13.0.dev12` and `1.13.0.dev14`. A green run is not the evidence: the same
gated 300 ms delay between `session_scope`'s `yield` and its `commit` takes Test 6's
sequence from **0/10 on `dev12`** to **10/10 on `dev14`**, with the `POST` latency going
from 11-20 ms to 338-366 ms — the delay moved from after the response to inside it. The
instrumentation stays as a regression detector, not as a workaround.

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
5. Assert GET status is `200` and `body.name` equals the original name (no mutation).
   The `200` is asserted unconditionally. On a non-`200` the step builds a diagnosis
   into the assertion's message from two reads — the failing response's own `detail`
   (`describeResponseDetail`) and a second by-id read of the same route
   (`describeFlowReadback`, the #1759 helper). Neither throws, both run only on the
   failing branch, and the assertion is unchanged.

   | `detail` | second read | shape |
   |---|---|---|
   | `"Flow not found"` | `200` — the row EXISTS | `LE-2598`'s window: the `201` in step 1 preceded its commit and the row landed between the two reads. **Transient, and not a security finding.** |
   | `"Flow not found"` | `404` — still absent | the row is genuinely gone. Only *then* is "the rejected `PATCH` destroyed the flow" on the table — and a cross-worker wipe is still the likelier half. |
   | `"Not Found"` | either | FastAPI's unmatched-route 404 — `GET /api/v1/flows/{flow_id}` stopped resolving. |

   A read that cannot answer is `UNDECIDED` and claims neither (#1012). The second read
   must never become the asserted one: `expect` runs on the status captured from the
   **first** read, so a row that lands a moment later still fails the test.
6. `finally`: delete the created flow

---

## Validation criterion *(required)*
- Every "rejected status" assertion across the 6 tests returns one of the documented codes (`401`, `403`, or `422` for malformed-create).
- The `PATCH` rejection in Test 6 leaves the flow's `name` field unchanged when read back.
- All created flows are cleaned up; no leaked test fixtures remain after the run.
- For the `LE-2598` instrumentation: forcing Test 6's read-back to a non-`200` produces a
  failure message naming the `detail` string **and** the second read's verdict, and the
  step still **fails**. An instrumented assertion that stops failing is the defect this
  suite exists to catch, inverted. Neither diagnostic read is declared through
  `apiCoverage` — they run on the failing branch only.

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
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_new_flow`, which flushes without committing (`LE-2598`; it is what makes Test 6's read-back racy)
- `src/backend/base/langflow/api/utils/core.py` — `DbSession`, the auto-commit-at-teardown session dependency
- `src/lfx/src/lfx/services/deps.py` — `session_scope`, where the commit actually happens
