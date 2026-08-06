# API Flows CRUD

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates the full CRUD contract of `/api/v1/flows/` — the endpoint family that backs every flow created in the UI, every flow exported by the MCP server, every integration code snippet (curl/Python) generated from the Publish dropdown, and every external API consumer that programmatically manages flows.

A regression in any of these endpoints silently breaks the editor (saved flows disappear), the MCP integration (server cannot enumerate flows), and the API access modal (codegen targets a broken URL). The spec catches that class of regression by exercising create, read, list, update, delete, and the negative paths around missing/non-existent IDs.

If any of these tests fail against `langflowai/langflow-nightly:latest`, the flow persistence layer or its router has regressed and the next release is at risk.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

---

## Step by step *(required)*

The spec runs **9 independent tests** against `/api/v1/flows/` via Playwright's `request` fixture. Each test obtains a Bearer token through `getAuthToken()` (auto-login), creates its own ephemeral flow with a `Date.now()`-suffixed name to avoid collisions, and cleans up via `DELETE` at the end. No global setup/teardown.

---

**Test 1 — `POST creates flow and returns ID`**
1. `POST /api/v1/flows/` with `{ name, description, data, is_component }`
2. Assert HTTP status is `201`
3. Assert response body has a non-empty string `id` and matching `name`
4. Cleanup via `DELETE`

**Test 2 — `GET lists flows and includes the created one`**
1. Create a flow via `POST`
2. `GET /api/v1/flows/`
3. Assert HTTP status is `200` and the response is iterable (array or `{ flows: [...] }`)
4. Assert the freshly created `id` is present in the list with the correct name
5. Cleanup

**Test 3 — `GET by ID returns correct flow`**
1. Create a flow via `POST`
2. `GET /api/v1/flows/{id}`
3. Assert HTTP status is `200`
4. Assert `body.id` and `body.name` match the created flow
5. Cleanup

**Test 4 — `PATCH updates flow name and description`**
1. Create a flow via `POST`
2. `PATCH /api/v1/flows/{id}` with `{ name, description }`
3. Assert HTTP status is `200` and the PATCH response reflects both fields
4. `GET /api/v1/flows/{id}` and assert persistence of both fields
5. Cleanup

**Test 5 — `DELETE removes flow and returns 200`**
1. Create a flow via `POST`
2. `DELETE /api/v1/flows/{id}`
3. Assert HTTP status is `200`

**Test 6 — `GET after DELETE returns 404`**
1. Create a flow via `POST`
2. `DELETE /api/v1/flows/{id}`
3. `GET /api/v1/flows/{id}`
4. Assert HTTP status is `404`

**Test 7 — `GET non-existent flow returns 404`**
1. `GET /api/v1/flows/{fakeUUID}` using `00000000-0000-0000-0000-000000000000`
2. Assert HTTP status is `404`

**Test 8 — `POST with missing name returns 422`**
1. `POST /api/v1/flows/` with a body missing the `name` field
2. Assert HTTP status is one of `400` or `422` (FastAPI returns 422 for missing required fields; tolerating 400 keeps the spec robust to backend stack changes)

**Test 9 — `deleted flow does not appear in flows listing`**
1. Create a flow via `POST`
2. `DELETE /api/v1/flows/{id}`
3. `GET /api/v1/flows/`
4. Assert HTTP status is `200` and the deleted `id` is absent from the list

---

## Validation criterion *(required)*
- All 9 tests pass 5× in a row against `langflowai/langflow-nightly:latest`.
- Status codes match: `POST` returns `201`; `GET`/`PATCH`/`DELETE` on existing flows return `200`; operations against unknown IDs return `404`; missing required fields return `400` or `422`.
- PATCH changes are durable: a subsequent `GET` reflects the new values.
- Deleted flows disappear from both `GET /api/v1/flows/{id}` and the list endpoint.
- Each test cleans up after itself — no orphan flows remain in the database after the suite completes.

---

## What this test does not cover *(optional)*
- Flow **execution** via `POST /api/v1/run/{flow_id}` — covered by `api-run-flow.spec.ts` and `api-run-with-tweaks.spec.ts`.
- Authentication failure modes (invalid API key, missing token) — covered by `api-invalid-key.spec.ts`.
- Multi-user isolation (one user's flows not visible to another) — out of scope; would require seeding a second user.
- Pagination, ordering, and filter parameters on `GET /api/v1/flows/` — the spec only asserts the unfiltered list contract.
- Flow `data` field validation (nodes/edges schema) — the spec uses an empty data graph.

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`).
- Auto-login enabled (the default in nightly) so `getAuthToken()` can mint a Bearer token. If auth is reconfigured, the helper at `tests/helpers/auth/get-auth-token.ts` must be updated first.

---

## External dependencies *(required)*
<!-- Files from the Langflow repository that, if changed, could break this test. -->

- `src/backend/base/langflow/api/v1/flows.py` — router that exposes `POST/GET/PATCH/DELETE /api/v1/flows/`; any signature, status code, or response shape change here directly affects the spec.
- `src/backend/base/langflow/services/database/models/flow/model.py` — flow schema (name, description, data, is_component); renaming or removing a field breaks the POST payload and the PATCH/GET assertions.
- `src/backend/base/langflow/api/utils/` — shared API helpers used by the flows router (validation, current-user resolution); changes here can shift 422 vs 400 boundaries.
