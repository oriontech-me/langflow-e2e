# Connections — the rate limits, asserted rather than avoided

**File:** `tests/tests-automations/regression/api/connections/api-connections-rate-limits.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2302 (Dedicated Integrations, batch 2).

---

## What this test validates *(required)*

Two of the upstream security review's HIGH findings were rate limits on the connection routes:
- INT-14-01: there was no limit at all;
- INT-14-04: the limit was login-sized, and it cut off the 2 s consent poll after about 10 s.

Batch 1 measured the buckets so its specs could **avoid** them (`api-connections-lifecycle.md`, *The write budget*).
Nothing asserted them, so a regression back to a login-sized read bucket would break the consent poll with every
spec green. This file asserts the four limits a user meets on `/api/v1/connections`, each under a **throwaway user
of its own**: a fresh user starts with every bucket empty, so the counts are exact.

Measured on `1.14.0.dev32`, `rate_limit_enabled` at its default (on), no setting overridden. The code read is
`release-1.14.0`.

### The read bucket is sized for the consent poll, not for login

- `GET /api/v1/connections` accepts **60** requests in a minute. The 61st answers `429`.
- That is `connection_metadata_rate_limit_per_minute` (default 60). The setting's own docstring explains the size:
  the UI polls the listing every two seconds while an OAuth consent is pending.
- A login-sized bucket (5) would refuse the 6th poll, about 10 s into a consent, which was INT-14-04.
- The test asserts the **exact** size. Asserting "at least 30" would let the bucket shrink by half unnoticed, and
  the default is what every lane runs.
- The bucket is one limiter **scope** (`connections-read`), and three routes check it: the listing,
  `GET …/oauth/registrations` and `GET …/oauth/registrations/saved`. Measured: with the listing's 60 spent,
  `GET …/oauth/registrations` answers `429` too. The reverse was also measured, outside the spec: 60 registration
  reads then a listing gives `429`. So the consent wizard, which reads the registrations and polls the listing,
  spends **one** budget, not two.
- `GET /api/v1/integrations` (the manifest) checks the same 60/min **limit** under a scope of its own
  (`integrations`), and answers `200` with the listing's bucket spent.

### The write bucket holds 30, shared by every kind of write

- One create plus 29 renames are accepted (`201`, then `200` 29 times). The **31st** write answers `429`.
- The issue placed the refusal at the 30th write. That premise was refuted on measurement. The 30 accepted writes
  agree with `api-connections-ownership.md` (*"the 30th write is still accepted, and the 31st answers `429`"*) and
  with `connection_write_rate_limit_per_minute = 30`.
- Creates, updates, revokes and deletes share this one bucket (the setting's docstring, and the lifecycle doc's
  measurement). So do the credential-replacement `POST …/token` and the saved-registration `PUT`/`DELETE`
  (`connections.py`). This file spends it with renames only and does not re-measure the sharing.
- The ownership spec already proves that the bucket is keyed per **user**: B's write from the same client is
  accepted. It bounds the size only from above, because its user has already spent writes, and its doc leaves the
  exact size to this issue.

### The buckets are independent

- With the write bucket spent:
  - a list read answers `200`;
  - `POST …/test` answers `200` (it is not a write).
- With `/test` and `/health` spent, a rename and a list read still answer `200`.

### `/test` and `/health` have one bucket each, of 5

- `POST /api/v1/connections/{id}/test` accepts 5 calls, and the 6th answers `429`.
- `POST /api/v1/connections/{id}/health`, called **after** `/test` was spent, still accepts 5, and its 6th answers
  `429`. So spending `/test` does not spend `/health`.
- Neither route sets a size of its own: both fall back to `rate_limit_per_minute`, the **login** budget (5). That is
  deliberate upstream (*"credential tests, health checks, and the OAuth endpoints stay on the tighter per-endpoint
  buckets"*). It also means a change to the login budget moves these two, and the test would name that.
- The planted token never leaves the instance: both calls answer `200` with `health: "unknown"`
  (`api-connections-health.md`).

### Every `429` has one shape

Every refusal above is the same:
- `429`;
- `content-type: application/json`;
- `Retry-After: 60`;
- the body `{"detail": "Too many requests. Please try again later.", "retry_after": "60"}`.

The two browser-facing OAuth routes answer an HTML `429` instead. Their refusal belongs to
`api-connections-oauth-callback.md` and is not repeated here.

### Out of scope, recorded

- The window resetting after 60 s. Asserting it costs a minute of wall clock per test, and `Retry-After: 60` is
  what a client acts on.
- The size of the manifest's own bucket (`integrations`, shared with `GET …/policy/effective`). It is not on the
  consent poll's path; only its independence from the listing is asserted.
- The per-IP login limit itself.

---

## Tags *(required)*

`@api` `@integrations` `@stable`.

---

## Step by step *(required)*

**`describe.configure({ mode: "serial" })`.** Each test spends whole buckets. That is fine under its own user, but
two tests must never run in the same minute under the **same** user. Serial keeps the file in one worker, and a
user per test keeps the tests apart from each other.

**Per test.** `beforeEach` makes a throwaway user with `createConnectionsOwner`. Every call carries that user's
token on the **test's own** `request`, so `apiCoverage` records it. `afterEach` disposes the user, which also
removes every row it owns.

**Why the counts cannot drift with the clock.** The limiter is fixed-window (slowapi's default strategy, with
`memory://` storage), and a window starts at the key's **first hit**, not at a clock-minute boundary. A fresh user
starts fresh keys, so a test cannot straddle a boundary and get extra calls through. Only a test that ran for more
than 60 s could see a window reset, and that turns a refusal into a `200`: a red, never a false green. Each owner costs one `POST /api/v1/login`, against the per-IP limit of 5/minute. The helper waits out
a refused window, so three tests in a row may pay up to a minute of setup when a sibling file logs in at the same
moment. That cost is recorded rather than avoided.

**Test 1: the read bucket survives the consent poll.**
1. 60 × `GET /api/v1/connections`: every one answers `200`.
2. The 61st answers the `429` above.
3. `GET …/oauth/registrations` answers the `429` too: it shares the bucket.
4. `GET /api/v1/integrations` answers `200`: its bucket is its own.
5. A create from the same user answers `201`, so a spent read bucket does not refuse a write.

**Test 2: the write bucket holds 30, and spending it leaves reads and `/test` alone.**
1. A raw create answers `201`. It is the first write.
2. 29 renames of it each answer `200`. That makes 30 writes.
3. The 30th rename (the 31st write) answers the `429` above.
4. A list read answers `200`, and `POST …/test` answers `200`.

**Test 3: `/test` and `/health` are 5 each, and independent.**
1. A create of the row.
2. 5 × `POST …/test` answer `200`, and the 6th answers the `429` above.
3. 5 × `POST …/health` answer `200`, and the 6th answers the `429` above.
4. A rename answers `200`, and a list read answers `200`.

No call under test is retried. The seeding is raw in test 2 too, because the create is the first write that is
counted.

---

## Validation criterion *(required)*

All three tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev32`, and once at
`--workers=2`. On every run:
- every accepted call carries its exact status;
- every refusal carries the exact shape above;
- no throwaway user is left behind.

Each count has a force-fail mutation executed against it: one more accepted call, and one fewer.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance at `PLAYWRIGHT_BASE_URL`, auto-login (the superuser) with user creation
  through `POST /api/v1/users/`, and rate limiting at its defaults (`rate_limit_enabled` on, no
  `LANGFLOW_*RATE_LIMIT*` override; the lanes set none).
- **One Langflow worker, or a shared counter store.** With `memory://` storage each worker process keeps its own
  counters, so with several workers the over-limit call can land on a worker that counted fewer and be accepted.
  The daily, the PR lane and every start script pin `LANGFLOW_WORKERS=1`. `manual.yml` does not, so a dispatch
  there can go red here for a reason that is not a Langflow regression; `LANGFLOW_RATE_LIMIT_STORAGE_URI` pointing
  at a shared store removes the assumption.
- No provider key, no OAuth registration, no network egress.
- `src/backend/base/langflow/api/v1/connections.py`: the routes, and which limit and limiter scope each one
  checks.
- `src/backend/base/langflow/api/v1/integrations.py`: the manifest's own scope.
- `src/backend/base/langflow/services/rate_limit/service.py`: the per-user key and the fallback to the login
  budget.
- `src/lfx/src/lfx/services/settings/groups/security.py`: `connection_metadata_rate_limit_per_minute` (60),
  `connection_write_rate_limit_per_minute` (30) and `rate_limit_per_minute` (5), with the reasons for each size.
- `tests/helpers/integrations/connections-owner.ts`: the throwaway owner each test spends.
