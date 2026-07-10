# MCP v2 Server Registration — HTTP Status Codes

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Pure-API regression guard for the HTTP status codes returned by the MCP v2
server-registration endpoints (`/api/v2/mcp/servers/{name}`). It asserts the
**correct, spec-conformant** behavior:

- `POST` an already-registered server name → **409 Conflict**
- `DELETE` a non-existent server → **404 Not Found**

> **This test is a known-defect watchdog (issue #396) and is EXPECTED TO FAIL
> against current Langflow builds.** `api/v2/mcp.py` currently returns **500**
> for both conditions ("Server already exists." / "Server not found."). The
> intentional failure is the formal record — captured in `daily-history.jsonl`,
> the QA Platform, and the `[Daily Failure]` issue — that the suite detected the
> defect. On the first daily failure the workflow auto-removes `@stable` from
> these tests (so they stop running); once upstream returns the correct codes,
> restore `@stable` and they become forward regression guards. A reviewer should
> **not** treat the red as a mistake — see the **Tags** section.

Why 409/404 are the correct codes is not just REST theory — it is Langflow's own
convention: 409 for uniqueness conflicts (`flows_helpers.py` "Name must be
unique", `authz_*`, `deployments`, and the sibling project-scoped MCP endpoint
`api/v1/projects_mcp_helpers.py` which already returns 409 for a duplicate server
name), and 404 for missing resources (145+ call sites). The 500s in
`api/v2/mcp.py` are the anomaly.

---

## Tags *(required)*

Both tests: `@mcp` `@regression` `@api` `@stable`.

`@stable` is intentional: these tests must run in the daily workflow so the
defect is formally recorded and the eventual upstream fix is detected. Because
the tests fail by design against the buggy nightly, the daily's
`auto-remove-stable` step will strip `@stable` on the first run — that is the
intended lifecycle, not a regression. Restore `@stable` once Langflow returns
409/404 (tracked in #396).

---

## Step by step *(required)*

**Test 1 — duplicate registration → 409**

1. Get an auth token (`GET /api/v1/auto_login`)
2. Pre-clean: `DELETE /api/v2/mcp/servers/{name}` (remove any leftover)
3. `POST /api/v2/mcp/servers/{name}` with `{ "url": "http://localhost:1/mcp" }` → expect **200**
4. `POST` the same name again → expect **409 Conflict** *(currently 500 — fails by design)*
5. Cleanup: `DELETE` the server

**Test 2 — delete missing → 404**

1. Get an auth token
2. Guard: `DELETE` the (unique, never-registered) name to ensure absence
3. `DELETE /api/v2/mcp/servers/{name}` → expect **404 Not Found** *(currently 500 — fails by design)*

---

## Validation criterion *(required)*

- Test 1: the second `POST` of an existing name returns HTTP `409`
- Test 2: `DELETE` of a non-existent server returns HTTP `404`

(Until upstream is fixed, both fail with `Expected 409/404, Received 500` — the
intended, self-documenting failure signature.)

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
- Server names are worker- and timestamp-scoped to avoid collisions with sibling
  MCP specs running in parallel.
- Split out of the investigation in #396; the passing `mcp-client-regression.spec.ts`
  Test 3 only exercises successful registration (it pre-cleans to avoid the
  duplicate), so it never covered the 409 path — this spec fills that gap.
