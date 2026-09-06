# API Monitor Messages

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates the read contract of `/api/v1/monitor/messages` — the endpoint that backs the Playground chat history panel and the Logs page in the Langflow UI. Every flow execution that produces messages writes through this endpoint's storage layer, and every UI surface that displays chat history reads through it.

A regression here silently breaks message visibility for every running flow: the Playground stops showing prior turns, the Logs page goes blank, and any external API consumer that pages through message history loses its data source.

If any of these tests fail against `langflowai/langflow-nightly:latest`, the message storage router or its query parameters have regressed and the next release is at risk.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

---

## Step by step *(required)*

The spec runs **6 independent tests** against `GET /api/v1/monitor/messages` via Playwright's `request` fixture. Each test obtains a Bearer token through `getAuthToken()` (auto-login) and asserts the endpoint contract against the instance's current state — no flow creation, no DB seeding.

---

**Test 1 — `returns 200 with array`**
1. `GET /api/v1/monitor/messages` with `Authorization` header
2. Assert HTTP status is `200`
3. Assert response body is an array (may be empty)

**Test 2 — `without auth returns 401 or 403`**
1. `GET /api/v1/monitor/messages` with no `Authorization` header
2. Assert HTTP status is `401` or `403`

**Test 3 — `filtered by session_id returns only matching messages`**
1. `GET /api/v1/monitor/messages?session_id=<unique>` with a `Date.now()`-suffixed session ID
2. Assert HTTP status is `200`
3. Assert response is an array
4. Assert every returned message has `session_id` equal to the requested value (loop holds vacuously for empty results, which is the common case for a unique session)

**Test 4 — `filtered by flow_id returns only matching messages`**
1. `GET /api/v1/monitor/messages?flow_id=00000000-0000-0000-0000-000000000001`
2. Assert HTTP status is `200`
3. Assert response is an array
4. Assert every returned message has `flow_id` equal to the requested value

**Test 5 — `combined session_id and flow_id filters return 200`**
1. `GET /api/v1/monitor/messages?flow_id=<UUID>&session_id=<unique>` with both filters
2. Assert HTTP status is `200`
3. Assert response is an array
4. Assert every returned message matches both filters

**Test 6 — `messages contain required fields when not empty`**
1. `GET /api/v1/monitor/messages`
2. Assert HTTP status is `200`
3. If response is non-empty, assert the first message exposes `id`, `session_id`, `timestamp`, `sender`, `text`

---

## Validation criterion *(required)*
- All 6 tests pass 5× in a row against `langflowai/langflow-nightly:latest` with `--retries=0`.
- Status codes match: `200` on authenticated GET; `401` or `403` on unauthenticated GET.
- `session_id` and `flow_id` filters return only matching messages (vacuously true for empty results, strictly checked when results are present).
- Message objects expose the documented required fields when results are present.
- No `🚨 Backend Error` lines in the run output.

---

## What this test does not cover *(optional)*
- Real DELETE of messages by `message_ids` — would require seeding messages first (separate test if needed).
- POST/write endpoints on `/api/v1/monitor/messages` — out of scope.
- Pagination / limit parameters — not exercised by the UI consumers this spec guards.
- End-to-end "run a flow → assert message appears here" — belongs in a Playground or flow-execution spec, not this contract test.

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`).
- Auto-login enabled (the default in nightly) so `getAuthToken()` can mint a Bearer token.

---

## External dependencies *(required)*
<!-- Files from the Langflow repository that, if changed, could break this test. -->

- `src/backend/base/langflow/api/v1/monitor.py` — router exposing `GET /api/v1/monitor/messages`; any signature, status code, or filter-param change breaks the spec.
- `src/backend/base/langflow/services/database/models/message/model.py` — message schema (`id`, `session_id`, `flow_id`, `timestamp`, `sender`, `text`); renaming/removing a field breaks the required-fields assertion.
- `src/backend/base/langflow/services/auth/utils.py` — provides `get_current_active_user` used by the monitor router; changes here can shift the unauthenticated 401/403 boundary.
- `src/backend/base/langflow/api/utils/__init__.py` — exposes `DbSession` and `custom_params` consumed by the monitor router; query-param parsing changes can affect filter behavior.

---

## Coverage declarations (#1700)

Since the API coverage gauge landed (#1692, `docs/api/api-surface-coverage-gauge.md`),
every test in this spec **declares** `GET /api/v1/monitor/messages` through the
`apiCoverage` fixture — including the unauthenticated one, which issues the call and
asserts the refusal. No assertion changed. A declaration the test never issues fails
it, so the declaration cannot be wrong silently, and the operation now counts in
`npm run api:coverage`, where it counted for nothing despite six tests driving it as a
contract since the spec was written. The rest of the family — the write surface,
sessions, builds, transactions, traces and the `shared/*` twins — lives in
`docs/api/monitor/`.
