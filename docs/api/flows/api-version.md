# API Version

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*
Validates that Langflow's `/api/v1/version` endpoint is available and returns a stable version contract. The endpoint is the canonical way clients, tooling, and this test suite discover which Langflow release is running, so its contract — status code, response body keys, content type, and latency — must remain stable across releases.

If any of these tests fail, version-gated logic (feature detection, release reporting, upgrade checks) breaks silently.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

---

## Step by step *(required)*

The spec runs **5 independent tests**, each issuing a single request to `/api/v1/version` via Playwright's `request` fixture. No authentication is needed — the endpoint is public.

---

**Test 1 — `GET /api/v1/version` returns 200 with a non-empty `version` string**
1. `GET /api/v1/version`
2. Assert HTTP status is `200`
3. Assert response body has property `version`
4. Assert `version` is a non-empty string matching `^\d+\.\d+` (semantic-version shape)

**Test 2 — `GET /api/v1/version` reports the Langflow package and `main_version`**
1. `GET /api/v1/version`
2. Assert HTTP status is `200`
3. Assert `main_version` is a non-empty string
4. Assert `package` is a string containing `langflow` (case-insensitive — accepts both `Langflow` and `Langflow Base`)

**Test 3 — `GET /api/v1/version` response has `content-type: application/json`**
1. `GET /api/v1/version`
2. Assert HTTP status is `200`
3. Assert `content-type` header contains `application/json`

**Test 4 — `GET /api/v1/version` responds within 5 seconds**
1. Capture `start = Date.now()`
2. `GET /api/v1/version`
3. Capture elapsed = `Date.now() - start`
4. Assert HTTP status is `200`
5. Assert `elapsed < 5000`

**Test 5 — `POST /api/v1/version` returns 405 Method Not Allowed**
1. `POST /api/v1/version`
2. Assert HTTP status is `405` (the route is read-only)

---

## Validation criterion *(required)*
- All assertions must succeed against a freshly started Langflow instance.
- The endpoint path is `/api/v1/version` — **not** `/api/v1/health` (which does not exist) and **not** `/health_check` (the uptime probe, covered by `api-health-check.spec.ts`).
- The exact version value is not asserted (it changes per release); only its shape and the `package` identifier (which must contain `langflow`) are checked.

---

## What this test does not cover *(optional)*
- The specific version number returned (intentionally — it changes every release)
- The `/api/v1/config` endpoint (feature flags, upload limits) — would be a separate spec
- Authenticated variants — the endpoint is public and takes no credentials

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`)
- No authentication, API key, or environment variables required

---

## External dependencies *(required)*
- The Langflow backend route serving `/api/v1/version` — if the path or response keys (`version`, `main_version`, `package`) change, the spec breaks
- The Langflow process serving the route — the test does not start it
