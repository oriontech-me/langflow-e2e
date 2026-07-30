# MCP v2 Server Registration — HTTP Status Codes

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Pure-API regression guard for the HTTP status codes returned by the MCP v2
server-registration endpoints (`/api/v2/mcp/servers/{name}`). It asserts the
**correct, spec-conformant** behavior:

- `POST` an already-registered server name → **409 Conflict**
- `DELETE` a non-existent server → **404 Not Found**

> **These were known-defect watchdogs (#396, #633, #991) and are not any more.**
> From 1.5.0 until 2026-07-27 `api/v2/mcp.py` returned **500** for both conditions
> ("Server already exists." / "Server not found."), so both tests failed by design
> and `@stable` was auto-removed on 2026-07-10. Upstream fixed it in
> langflow-ai/langflow#14005 (merged 2026-07-27) — verified on Nightly
> **1.12.0.dev10**, source-confirmed in the image. `@stable` is restored and the
> tests are now **forward regression guards**: a failure here is a regression of
> that upstream fix, not the historical red.

Why 409/404 are the correct codes is not just REST theory — it is Langflow's own
convention: 409 for uniqueness conflicts (`flows_helpers.py` "Name must be
unique", `authz_*`, `deployments`, and the sibling project-scoped MCP endpoint
`api/v1/projects_mcp_helpers.py` which already returns 409 for a duplicate server
name), and 404 for missing resources (145+ call sites). The 500s
`api/v2/mcp.py` used to return were the anomaly; it now matches the convention its
own sibling endpoint already followed.

---

## Tags *(required)*

Both tests: `@mcp` `@regression` `@api` `@stable`.

`@stable` is restored as of #991, after the upstream fix landed. Promotion
evidence: 10/10 clean executions (5 bursts x 2 tests, `--workers=1 --retries=0`)
against Nightly 1.12.0.dev10, plus a force-fail of all four assertions (both
status codes and both `detail` matchers) — each mutation failed exactly one test.

Historical note, so a reader does not mistake the record for a defect: between
2026-07-10 and #991 these tests carried no `@stable` and ran in no lane. That is
also why nobody noticed the upstream fix for three days — a watchdog outside the
daily watches nothing.

---

## Step by step *(required)*

**Test 1 — duplicate registration → 409**

1. Get an auth token (`GET /api/v1/auto_login`)
2. Pre-clean: `DELETE /api/v2/mcp/servers/{name}` (remove any leftover)
3. `POST /api/v2/mcp/servers/{name}` with `{ "url": "http://localhost:1/mcp" }` → expect **200**
4. `POST` the same name again → expect **409 Conflict**
5. Cleanup: `DELETE` the server

**Test 2 — delete missing → 404**

1. Get an auth token
2. Guard: `DELETE` the (unique, never-registered) name to ensure absence
3. `DELETE /api/v2/mcp/servers/{name}` → expect **404 Not Found**

---

## Validation criterion *(required)*

- Test 1: the second `POST` of an existing name returns HTTP `409` **and** a
  `detail` matching `/already exists/i`
- Test 2: `DELETE` of a non-existent server returns HTTP `404` **and** a `detail`
  matching `/server not found/i`

Each assertion checks the `detail` in addition to the status so a status that is
correct-by-accident does not pass — e.g. a renamed/removed route returning a bare
`404 "Not Found"` must not masquerade as the resource-level `404`.

(Until upstream is fixed, both fail at the status check with `Expected 409/404,
Received 500` — the intended, self-documenting failure signature. The `detail`
check only runs once the status is correct.)

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v2/mcp.py` — `add_server` (`POST`), `delete_server`
  (`DELETE`), and the shared `update_server` helper that raises the status codes
  under test (lines ~411/418/454 today return 500)
- No frontend, LLM, `npx`, or external network required — pure API against the
  running instance

---

## What this test does not cover *(optional)*

- The `PATCH /servers/{name}` upsert path (idempotent `merge_existing`, already
  returns 200 correctly)
- The 403 auth-guard and 422 name-mismatch branches of the same endpoints
- UI surfacing of the error (covered indirectly by `mcp-client-regression.spec.ts`)

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- Auth via `LANGFLOW_AUTO_LOGIN=true` (the shared `getAuthToken` helper)

---

## Notes *(optional)*

- Uses `page.request` (APIRequestContext) exclusively: it runs outside the
  browser page, so the intentional 5xx does **not** trip the fixture's
  `page.on("response")` backend-error monitor — no `allowFlowErrors()` needed.
- Server names are worker-, timestamp-, and UUID-scoped so neither parallel
  workers nor two independent invocations sharing one backend can collide.
- The empty-token path is guarded up front (`expect(authHeader).toBeTruthy()`) so
  an auth misconfiguration fails with a clear signal rather than a misleading
  status mismatch.
- Split out of the investigation in #396; the passing `mcp-client-regression.spec.ts`
  Test 3 only exercises successful registration (it pre-cleans to avoid the
  duplicate), so it never covered the 409 path — this spec fills that gap.
