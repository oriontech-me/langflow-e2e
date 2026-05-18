# API Run Flow

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates the happy path and the `404` failure mode of `POST /api/v1/run/{flow_id}` — the REST endpoint that external clients use to execute Langflow flows programmatically. The endpoint authenticates with `x-api-key` (not Bearer), accepts a payload with `input_value`, `input_type`, `output_type`, and optionally `session_id`, and returns the flow execution outputs along with the session identifier.

If any of these tests fail, the public flow-execution contract has regressed: integrations that drive Langflow from external systems (chat frontends, agent runtimes, batch jobs) stop receiving expected responses or stop being able to thread a conversation through a stable `session_id`.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

---

## Step by step *(required)*

The spec runs **3 independent tests** via Playwright's `request` fixture, sharing a single flow created in `beforeAll`.

**Setup (`beforeAll`)**
1. Obtain a valid Bearer token via `getAuthToken(request)`.
2. `POST /api/v1/api_key/` with the Bearer token to mint a temporary API key (asserts `200` and that the response body contains `api_key` and `id` — gives an explicit failure if the API key response shape changes).
3. `POST /api/v1/flows/` with the new `x-api-key` to create a minimal empty flow (`nodes: []`, `edges: []`), asserts `201`, and stores `flowId`. The empty-flow + structural-assertion convention is shared with `api-run-with-tweaks.spec.ts`; semantic assertions (non-empty `outputs`, message persistence) are tracked in issue #263.

**Teardown (`afterAll`)**
1. `DELETE /api/v1/flows/{flowId}` with the `x-api-key`.
2. `DELETE /api/v1/api_key/{apiKeyId}` with the Bearer token.

---

**Test 1 — `POST /api/v1/run/{flow_id}` with `input_value`, `input_type: "chat"`, `output_type: "chat"`**
1. POST to `/api/v1/run/{flowId}` with `x-api-key` and payload `{ input_value, input_type: "chat", output_type: "chat" }`.
2. Assert response status is `200`.
3. Assert `body.outputs` exists and is an array.

This test covers the QA-CHECKLIST 1.3 bullets for `input_value` and for `input_type: "chat"` / `output_type: "chat"` in a single call — both parameters are sent explicitly in the request payload.

**Test 2 — `POST /api/v1/run/{flow_id}` with custom `session_id`**
1. Generate a deterministic `session_id` (e.g. `test-session-<timestamp>`).
2. POST with payload including `session_id`.
3. Assert response status is `200`.
4. Assert `body.session_id` equals the value sent in the request.

**Test 3 — `POST /api/v1/run/{non_existent_flow_id}` returns 404**
1. POST to `/api/v1/run/00000000-0000-0000-0000-000000000000` with the valid `x-api-key`.
2. Assert response status is `404` (not `500`, not `422`).

---

## Validation criterion *(required)*
- Setup creates one flow and one API key; teardown removes both. No orphans on the backend after the suite.
- Test 1 receives `200` and a body with an `outputs` array (content may be empty for an empty flow — the contract is structural, not semantic).
- Test 2 receives `200` and the returned `session_id` is byte-identical to the value sent in the request.
- Test 3 receives `404` — confirming the router differentiates missing-flow from auth failure and from input-validation failure.

---

## What this test does not cover *(optional)*
- `tweaks` parameter override → `api-run-with-tweaks.spec.ts` (issue #249)
- Invalid `x-api-key` → `api-invalid-key.spec.ts` (already `@stable`)
- `GET /api/v1/all` (component listing) → `api-custom-component-creation.spec.ts` (issue #250)
- Streaming responses, batch runs, file uploads, multi-turn conversations beyond a single `session_id` echo
- Semantic correctness of `outputs` content (an empty flow produces a structurally valid but functionally empty response) → tracked in issue #263
- Message persistence under the custom `session_id` (would require a runnable flow that actually emits chat messages) → tracked in issue #263

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`
- Default superuser credentials available (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) — used by `getAuthToken` to mint the Bearer used in setup
- Backend allows API key creation via `POST /api/v1/api_key/` for the authenticated user

---

## External dependencies *(required)*
- `tests/helpers/auth/get-auth-token.ts` — issues a valid `Bearer` via `/api/v1/auto_login`; if its contract changes, `beforeAll` breaks
- `src/backend/base/langflow/api/v1/endpoints.py` — implementation of `POST /api/v1/run/{flow_id}`; changing the response shape (e.g. dropping `outputs` or `session_id` from the body) breaks Tests 1 and 2
- `src/backend/base/langflow/api/v1/flows.py` — `POST /api/v1/flows/` used in setup and `DELETE /api/v1/flows/{id}` used in teardown
- `src/backend/base/langflow/api/v1/api_key.py` — `POST /api/v1/api_key/` and `DELETE /api/v1/api_key/{id}` for temporary key lifecycle
