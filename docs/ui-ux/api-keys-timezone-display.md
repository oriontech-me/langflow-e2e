# API Keys — Timestamp Timezone Display

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Regression coverage for **PR #13471** ("Fix timestamp rendering for `expires_at` in API Key model"). The Settings → API Keys table showed `created_at` / `expires_at` in raw UTC instead of the viewer's local time.

Root cause: the backend serialized the datetime fields as naive UTC instants **without** a timezone offset (e.g. `2026-06-10T23:59:59`). The frontend `DateReader` calls `new Date(str)`, and JavaScript parses an offset-less ISO string as **local** time — so no UTC→local conversion happened and the raw UTC wall clock was displayed.

The fix adds `_as_utc_iso()` on the backend (always emit the `+00:00` offset, strip microseconds) plus dedicated `CreatedAtCellRender` / `LastUsedAtCellRender` cells. This spec asserts both layers:

- **API contract** — `GET /api/v1/api_key/` serializes `created_at` / `expires_at` with a `+00:00` offset and second precision; null `expires_at` / `last_used_at` remain null.
- **UI rendering** — with the browser pinned to `America/Sao_Paulo` (UTC−03:00), a key expiring at `23:59:59` UTC displays as `20:59:59` local; an unused key shows `Never`; a no-expiry key shows `∞`.

If this test fails, either the backend dropped the offset (timestamps render in UTC again) or a cell renderer stopped converting to local time.

---

## Tags *(required)*
`@stable` `@regression` `@api` `@ui-ux` `@settings`

---

## Step by step *(required)*

`mode: "serial"` — a shared `beforeAll` mints two keys (one with `expires_at = 2026-06-10T23:59:59+00:00`, one with no expiry) read by both tests; `afterAll` deletes them. The browser timezone is pinned via `test.use({ timezoneId: "America/Sao_Paulo" })`.

**Test 1 — `@api` serializer contract**
1. Authenticate (auto_login when enabled, otherwise form login).
2. `GET /api/v1/api_key/` and locate both keys.
3. Assert `created_at` (both keys) and `expires_at` (expiring key) match `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$` — offset present, no microseconds.
4. Assert `expires_at` round-trips exactly to `2026-06-10T23:59:59+00:00`.
5. Assert the no-expiry key's `expires_at` and both keys' `last_used_at` are `null`.

**Test 2 — `@ui-ux` local rendering**
1. Read the serialized `created_at` (UTC) via API to derive the raw UTC wall clock the bug used to show.
2. Log in and open `/settings/api-keys`.
3. Assert the expiring key's **expires** cell reads `2026-06-10 20:59:59` (23:59:59 UTC − 03:00).
4. Assert the **created** cell matches `YYYY-MM-DD HH:MM:SS` **and** differs from the raw UTC wall clock (proves the offset was applied).
5. Assert the unused key's **last used** cell reads `Never` and the no-expiry key's **expires** cell reads `∞`.

---

## Validation criterion *(required)*

- The serializer always emits a `+00:00` offset with no microseconds; nulls stay null.
- With the timezone pinned to UTC−03:00, `expires_at` renders exactly `2026-06-10 20:59:59` — the single assertion that distinguishes the fix (`20:59:59`) from the bug (`23:59:59`).
- `created_at` is shown shifted off its raw UTC wall clock; `Never` and `∞` empty-state glyphs render correctly.

---

## External dependencies *(required)*

- `src/backend/base/langflow/services/database/models/api_key/model.py` — `_as_utc_iso()` and the `field_serializer`s on `ApiKeyBase` / `ApiKeyRead`. If the serializers are removed or stop appending the offset, Test 1's regex fails and Test 2's `expires_at` reverts to `23:59:59`.
- `src/frontend/src/components/core/dateReaderComponent/index.tsx` — `DateReader` (`new Date(str)` + local getters). The UTC→local conversion engine; a change here alters the rendered value.
- `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/components/CreatedAtCellRender/index.tsx` — renders `created_at` via `DateReader`.
- `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/components/LastUsedAtCellRender/index.tsx` — renders `last_used_at`; emits `Never` when null.
- `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/components/ExpiryDateCellRender/index.tsx` — renders `expires_at`; emits the `∞` glyph when null.
- `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/helpers/column-defs.ts` — wires the three renderers to their columns.

---

## What this test does not cover *(optional)*

- API key **expiry enforcement** (whether an expired key is actually rejected) — covered by `api/flows/api-key-expiry-enforcement.spec.ts`.
- Timezones other than `America/Sao_Paulo`, and DST transitions (Brazil has no DST since 2019, so the offset is a constant −03:00).
- The "Add new key" creation modal and its expiry presets — keys are minted via API here.
- Offset-less timestamps emitted by *other* endpoints — the fix only touches API key serialization; `DateReader` itself still trusts whatever offset it receives.

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Auth available via auto_login, or `LF_TEST_USERNAME` / `LF_TEST_PASSWORD` set for form login on instances where auto_login is disabled.

---

## Notes *(optional)*

- The UI assertion is intentionally a hard-coded local value rather than a value re-derived from the served timestamp: re-deriving in-browser would also shift with a regressed (offset-less) backend and mask the bug. Pinning the timezone and asserting `20:59:59` keeps the regression guard real.
