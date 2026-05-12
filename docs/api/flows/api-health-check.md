# API Health Check

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates that Langflow's `/health_check` endpoint is available and reports a healthy state. The endpoint is the primary uptime probe used by orchestrators and the project's CI pipelines, so its contract — status code, response body keys, latency, and content type — must remain stable across releases.

If any of these tests fail, monitoring and CI scripts that rely on the health probe break, and outages are detected late.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

---

## Step by step *(required)*

The spec runs **4 independent tests**, each issuing a single `GET /health_check` request via Playwright's `request` fixture. No authentication is needed — the endpoint is public.

---

**Test 1 — `GET /health_check` returns 200 with `status: "ok"`**
1. `GET /health_check`
2. Assert HTTP status is `200`
3. Assert response body has property `status`
4. Assert `body.status === "ok"`

**Test 2 — `GET /health_check` returns `db: "ok"`**
1. `GET /health_check`
2. Assert HTTP status is `200`
3. Assert response body has property `db`
4. Assert `body.db === "ok"`

**Test 3 — `GET /health_check` responds within 5 seconds**
1. Capture `start = Date.now()`
2. `GET /health_check`
3. Capture elapsed = `Date.now() - start`
4. Assert HTTP status is `200`
5. Assert `elapsed < 5000`

**Test 4 — `GET /health_check` response has `content-type: application/json`**
1. `GET /health_check`
2. Assert HTTP status is `200`
3. Assert `content-type` header contains `application/json`

---

## Validation criterion *(required)*
- All four assertions must succeed against a freshly started Langflow instance.
- The endpoint path is `/health_check` at the server root — **not** `/api/v1/health_check`.
- Each test completes in well under 5 seconds; the latency assertion is the upper bound for an unhealthy backend.

---

## What this test does not cover *(optional)*
- The `chat` field of the body (returned but not asserted on)
- The unauthenticated `/api/v1/health` endpoint (uptime/version) — covered by a separate spec when added
- Behavior under degraded states (e.g., DB down) — would require a fixture that intentionally breaks the database

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`)
- No authentication, API key, or environment variables required

---

## External dependencies *(required)*
- `src/backend/base/langflow/api/router.py` (or wherever the `/health_check` route is mounted) — if the path moves, the spec breaks
- The Langflow process serving the route — the test does not start it
