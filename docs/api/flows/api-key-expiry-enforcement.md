# API Key Expiry Enforcement

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Companion to the PR #13471 timezone-display regression. That fix established the displayed timestamps were a *rendering* problem; this spec asserts the other half — that API key **expiry enforcement** is correct and is **not** shifted by the same timezone offset.

`POST /api/v1/run/{id}` authenticates with `x-api-key`. The test confirms:

- An **expired** key is rejected with `403`; a **valid** key is accepted with `200`.
- The expiry boundary is evaluated in **UTC**, not shifted by a viewer offset. A key expiring 30 min in the future / past (UTC) sits well inside the ±3h `America/Sao_Paulo` window, so if the backend compared a naive-UTC `expires_at` against a local "now" (or vice-versa), exactly one of the two boundary keys would flip its verdict.

This guards `services/database/models/api_key/crud.py::_is_expired()`, which normalizes naive `expires_at` to UTC before comparing — the same defensive pattern as the display fix. The test proves the enforcement path stays correct independently of the serializer.

If this test fails, either expired keys are being honored (a security regression) or the expiry comparison has become timezone-sensitive.

---

## Tags *(required)*
`@stable` `@regression` `@api` `@settings`

---

## Step by step *(required)*

`mode: "serial"` — `beforeAll` authenticates and creates one empty flow to run against; `afterAll` deletes every minted key and the flow. Keys are minted via `POST /api/v1/api_key/` with an explicit UTC `expires_at`; runs use the returned plaintext key as `x-api-key`.

**Test 1 — expired rejected, valid accepted**
1. Create a key with `expires_at = 2020-01-01T00:00:00+00:00` (long expired).
2. Create a key with `expires_at = 2099-12-31T23:59:59+00:00` (long valid).
3. `POST /api/v1/run/{flow}` with the expired key → assert `403`.
4. `POST /api/v1/run/{flow}` with the valid key → assert `200`.

**Test 2 — boundary evaluated in UTC**
1. Create a key expiring `now + 30 min` (UTC, via `toISOString()`).
2. Create a key expiring `now − 30 min` (UTC).
3. Run with the near-future key → assert `200` (still valid).
4. Run with the recently-expired key → assert `403` (expired).

---

## Validation criterion *(required)*

- Expired keys (`2020`, and `now − 30 min`) are refused with `403`.
- Valid keys (`2099`, and `now + 30 min`) are accepted with `200`.
- The 30-minute margins are inside the ±3h offset window, so both boundary verdicts being correct proves the comparison is genuinely UTC-based, not offset-shifted.

---

## External dependencies *(required)*

- `src/backend/base/langflow/services/database/models/api_key/crud.py` — `_is_expired()` (naive→UTC normalization + `now(utc) > expires_at`) and `check_key()` / `_check_key_from_db()`. If `_is_expired` drops its naive→UTC guard or the comparison direction changes, the boundary test catches it.
- `src/backend/base/langflow/api/v1/endpoints.py` — the `POST /api/v1/run/{id}` handler and its `x-api-key` dependency that calls `check_key`; the surface that returns `403 "Invalid or missing API key"` on an expired key.
- `src/backend/base/langflow/services/database/models/api_key/model.py` — the `expires_at` column (`DateTime(timezone=True)`). A change to how the value is persisted/read affects what `_is_expired` receives.

---

## What this test does not cover *(optional)*

- The **display** of timestamps in the Settings table — covered by `ui-ux/api-keys-timezone-display.spec.ts`.
- `is_active = false` deactivation as a rejection path (distinct from expiry).
- Env-var API keys (`_check_key_from_env`) — only DB-backed keys are exercised.
- Expiry enforcement on non-`/run` endpoints that also accept `x-api-key`.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Auth available via auto_login, or `LF_TEST_USERNAME` / `LF_TEST_PASSWORD` set for form login.

---

## Notes *(optional)*

- An empty flow is sufficient: an expired key is rejected at the auth layer (`403`) before any graph executes, and a valid key returns `200` with empty `outputs` — matching the convention in `api-run-flow.spec.ts`.
- 30-minute margins (rather than a few minutes) keep the boundary robust against test latency and clock skew while staying inside the 3-hour offset window that would expose a timezone bug.
