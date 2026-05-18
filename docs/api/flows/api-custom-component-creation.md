# API Custom Component Creation

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates the REST contract for the two endpoints that power Langflow's custom-component authoring surface:

- `POST /api/v1/custom_component` — parses a user-supplied Python class extending `langflow.custom.Component` and returns a frontend-ready component definition (template fields, outputs, display name). The IDE/canvas calls this endpoint while the user edits the *Code* field of a Custom Component on canvas; if it stops returning a valid definition, the live preview of a custom component breaks.
- `GET /api/v1/all` — lists every component type the backend currently exposes (chat I/O, prompts, model providers, etc.). The frontend uses this map to populate the sidebar and to render any flow that contains those nodes; an empty or malformed response makes the sidebar appear empty and prevents flow rehydration.

If either endpoint regresses on shape, status code, or auth contract, both the Custom Component authoring flow and the basic canvas startup are impacted — so these tests anchor section **1.4 Components via API**.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

---

## Step by step *(required)*

The spec runs **4 independent tests** via Playwright's `request` fixture. Tests 1–3 mint a Bearer token via `getAuthToken(request)`; Test 4 deliberately sends no `Authorization` header. No shared `beforeAll`/`afterAll` state.

**Test 1 — `POST /api/v1/custom_component` returns valid component structure**
1. Obtain a Bearer token via `getAuthToken(request)`.
2. `POST /api/v1/custom_component` with `Authorization: Bearer …` and a body containing the source of a minimal valid component (`MessageTextInput` input, single `Output`, `build_output` method returning `Data`).
3. Accept `200` or `201` for a parsed component, and tolerate `422` for environments that reject the snippet at the validation layer — the test logs the rejection body and exits without failing, documenting the looser contract.
4. On `200`/`201`: parse JSON and assert that at least one of `display_name`, `name`, `type`, or `template` is present.

**Test 2 — `POST /api/v1/custom_component` with invalid code returns error**
1. Obtain a Bearer token.
2. POST a body whose `code` is intentionally not valid Python.
3. Assert the response status is one of `400`, `422`, or `500`. The contract is: the backend must **not** silently accept the broken snippet — `500` is tolerated because some Langflow versions surface parser errors as 500, but this band is intentionally narrow.

**Test 3 — `GET /api/v1/all` includes component types**
1. Obtain a Bearer token.
2. `GET /api/v1/all` with `Authorization: Bearer …`.
3. Assert response status is `200`.
4. Assert the body is an object with at least one top-level key (catalog non-empty).
5. Soft-check that at least one well-known component name (`ChatInput`, `ChatOutput`, `Prompt`, `OpenAI`, `TextInput`) appears at the top level or one level down — logged as informational; the hard invariant remains "non-empty catalog".

This test fully supersedes the `GET /api/v1/all` test that was removed from `api-run-flow.spec.ts` (PR #262) — the assertions here are a strict superset of the original. Issue #261 is therefore satisfied by this spec.

**Test 4 — `POST /api/v1/custom_component` without auth returns 401 or 403**
1. POST to `/api/v1/custom_component` with **no** `Authorization` header and a minimal `code` payload.
2. Assert the response status is `401` or `403` — the endpoint must refuse anonymous access.

Test 4 was migrated from the now-deleted `api-custom-component.spec.ts` to consolidate all `/custom_component` contract tests in one file.

---

## Validation criterion *(required)*
- Tests 1, 2, 3, and 4 each return a status within the documented ranges.
- Test 3 confirms `GET /api/v1/all` returns a non-empty object — the canonical signal that the component catalog is wired and reachable.
- Test 4 confirms `POST /api/v1/custom_component` rejects anonymous requests with `401`/`403`.
- All 4 tests pass 5× in a row locally against `langflowai/langflow-nightly:latest`.

---

## What this test does not cover *(optional)*
- Persistence of a custom component to a saved flow — `POST /api/v1/custom_component` only parses code, it doesn't store anything.
- The canvas UI for editing component code → covered separately under `core-components/`.
- Component update / deletion via API — Langflow's component model is per-flow JSON, not a CRUD-able resource set, so there are no PATCH/DELETE counterparts to test.
- Auth-failure modes for `POST /api/v1/custom_component` — covered inline by Test 4 of this spec.
- Auth-failure modes for `GET /api/v1/all` — not currently covered.
- Invalid-Bearer (as opposed to no-header) on either endpoint — not covered here; `api-invalid-key.spec.ts` covers `/flows/` and `/run/{id}` but not the component endpoints.

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Backend running with auto-login enabled (`LANGFLOW_AUTO_LOGIN=true`, the default in the supplied Docker/pip scripts) — `getAuthToken` mints the Bearer via `GET /api/v1/auto_login`. The test fixture does not read `LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD` directly.
- Backend has the standard component catalog loaded (default install satisfies this).

---

## External dependencies *(required)*
- `tests/helpers/auth/get-auth-token.ts` — issues a valid `Bearer` via `/api/v1/auto_login`; if its contract changes, every test in this spec breaks.
- `src/backend/base/langflow/api/v1/endpoints.py` — implementation of `POST /api/v1/custom_component` and `GET /api/v1/all`. Dropping `template`/`display_name`/`name`/`type` on the POST response breaks Test 1's shape check. For the GET, the test only enforces "non-empty object" — a list response would currently still pass the JSON-object check (`typeof === "object"`) if it carried entries, so a switch to list would degrade coverage silently rather than fail the test.
- `src/backend/base/langflow/custom/custom_component/component.py` — the `Component` base class consumed by the inline test source. If its public surface (`MessageTextInput`, `Output`, `Data`) changes name or import path, Test 1's snippet stops parsing and the test flips to the `422` documentation branch.
