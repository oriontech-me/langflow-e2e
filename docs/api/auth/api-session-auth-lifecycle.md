# API Auth — session, auto-login, login, logout and refresh

**File:** `tests/tests-automations/regression/api/auth/api-session-auth-lifecycle.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev2`)

Owning issue: #1710 (Wave 7 — OSS API coverage). Gauge, definitions and denominator:
`docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The five operations of the session and token lifecycle. `GET /api/v1/auto_login` and
`POST /api/v1/login` are driven by half the suite and by every enterprise auth spec but
**declared nowhere**, and `GET /api/v1/session`, `POST /api/v1/logout` and
`POST /api/v1/refresh` are driven by nothing at all.

**Two findings, and the first one is the reason this file exists.**

1. **`POST /api/v1/logout` does not invalidate the access token.** Measured on
   `1.13.0.dev2`: the call answers `200 {"message": …}` and the *same* bearer then
   answers `200` on `GET /api/v1/all`. Logout clears the cookies; the token keeps
   working until it expires. Nothing in this repo said so, and a reader assumes the
   opposite — which is exactly the kind of premise a spec should hold still. (It is
   consistent with the enterprise finding that only a **forced** rotation invalidates.)
2. **`POST /api/v1/refresh` is cookie-driven, and *which context issues the call*
   decides the answer.** `GET /api/v1/auto_login` sets three cookies —
   `access_token_lf`, `refresh_token_lf`, `apikey_tkn_lflw` — and refresh reads
   `refresh_token_lf`: a caller holding it gets `200` with a fresh
   `{access_token, refresh_token, token_type}` pair, while a caller carrying only the
   bearer gets `401`. The first version of this spec asserted the `401` from the
   Playwright fixture context and **failed against a healthy instance**, because that
   context keeps the cookie jar — which is how the real mechanism surfaced. Worth
   pinning before someone "fixes" a helper by passing the wrong credential.

Measured contracts:

| Operation | Answer |
|---|---|
| `GET /api/v1/auto_login` | `200 {access_token, refresh_token, token_type}` (on a lane with `LANGFLOW_AUTO_LOGIN=true`) |
| `GET /api/v1/session` **without** a credential | **`200`** `{authenticated, store_api_key, user}` — the anonymous answer is a contract of its own |
| `GET /api/v1/session` with a token | `200`, the same keys, a populated `user` |
| `POST /api/v1/login`, **form-encoded** `username` + `password` | `200 {access_token, refresh_token, token_type}` |
| `POST /api/v1/login` with no body | `422` |
| `POST /api/v1/logout` with a valid bearer | `200 {"message": …}`, **and the token still works afterwards** |
| `POST /api/v1/refresh` from a context holding `refresh_token_lf` | `200 {access_token, refresh_token, token_type}` |
| `POST /api/v1/refresh` with only a bearer and no cookie | `401` |

---

## Tags *(required)*

`@api` `@auth` `@stable`

`@stable`: keyless and deterministic. The one shared resource it touches is the **login
rate limit**, handled below.

---

## Step by step *(required)*

Three tests over the `request` fixture, declaring through `apiCoverage`.

**The login budget is the design constraint.** OSS rate-limits `POST /api/v1/login` at
**5/min per IP on a fixed window**, so this file issues **exactly one successful login**
(with the lane's superuser credentials) plus one malformed call, and every other token
it needs comes from `auto_login`. It does **not** pin `workers: 1`: one login per file
is inside the budget even with the enterprise lane's pattern in mind, and the
assertions do not depend on the window.

**Every destructive-looking call runs on a throwaway token.** `logout` and `refresh`
are issued with a token obtained from `auto_login` for that test alone, never with the
shared fixture token, so no other spec's session is involved.

**Test 1 — `the session probe answers anonymous and authenticated alike`**
1. `GET /api/v1/session` from a context with **no** `Authorization` → `200`, keys
   `{authenticated, store_api_key, user}`.
2. The same with a token → `200`, the same key set, and the two answers **differ**
   (the authenticated one names a user).

**Test 2 — `login takes a form body, and refuses an empty one`**
1. `POST /api/v1/login` with `form: {username, password}` from the lane's env → `200`
   with the three token fields; the `access_token` works on `GET /api/v1/session`.
2. `POST /api/v1/login` with no body → `422`.

**Test 3 — `logout leaves the access token working, and refresh is cookie-driven`**
1. `GET /api/v1/auto_login` → a throwaway token; it works on `GET /api/v1/all`.
2. `POST /api/v1/refresh` from the fixture context (which holds `refresh_token_lf`) →
   `200` with a fresh token triple; the **same** call from the cookie-less context,
   carrying only the bearer → `401`. The declared operation is credited by the first
   call; the second is the negative half and is issued from the anonymous context on
   purpose.
3. `POST /api/v1/logout` with it → `200`, a `message`.
4. **The same token still answers `200`** on `GET /api/v1/all` — the finding, asserted
   as the current contract with the reasoning in the spec header so that a future
   version which *does* invalidate fails here and gets read, not silently accepted.

---

## Validation criterion *(required)*

The three tests pass three consecutive times at `--retries=0 --workers=1`, with the
anonymous `session` call issued from a context carrying no token, **one** successful
login in the whole file, `logout`/`refresh` driven on a throwaway `auto_login` token,
the post-logout `200` asserted explicitly (not implied), and the declared coverage —
the five operations — matching what the fixture recorded. No session belonging to
another spec is logged out, and no user or row is created.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL` with `LANGFLOW_AUTO_LOGIN=true`
  (every OSS lane) and the superuser credentials in `LANGFLOW_SUPERUSER` /
  `LANGFLOW_SUPERUSER_PASSWORD`.
- `src/backend/base/langflow/api/v1/login.py` — `login`, `auto_login`, `refresh`, `logout`.
- `src/backend/base/langflow/api/v1/endpoints.py` — `GET /api/v1/all`, used as the
  "does this token still work" probe.
- No provider key, no model, no network egress.
