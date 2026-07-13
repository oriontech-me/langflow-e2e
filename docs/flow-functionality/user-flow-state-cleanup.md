# User Flow-State Isolation Between Users — §8.3 User State

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that flow state is **scoped per user**: a flow created by one user is
visible to its owner and **not** to any other user (including the superuser).
This is the backend guarantee behind "user flow state cleanup" — one user's
work never leaks into another user's workspace.

The check is performed at the **REST API** layer (the source of truth the UI
flow list renders from):

1. The superuser creates and activates a second user (User A).
2. User A authenticates and creates a flow.
3. `GET /api/v1/flows/` with the **superuser** token does **not** include User
   A's flow.
4. `GET /api/v1/flows/` with **User A's** token **does** include it.

If this breaks, per-user isolation is compromised — flows leak across accounts,
a data-separation/privacy regression.

---

## Tags *(required)*

`@stable` `@release` `@api` `@database`

`@api` — drives the users/login/flows REST endpoints directly. `@database` —
asserts server-side per-user persistence and isolation.

---

## Step by step *(required)*

All steps run through the Playwright `request` fixture (no browser UI — see
Notes on why the prior UI login was dropped).

1. Obtain the superuser token via `GET /api/v1/auto_login` (the instance runs in
   auto-login mode) — no `POST /login`, so it does not consume the login rate
   budget
2. Create User A (`POST /api/v1/users/`, unique random username) → User A id
3. Activate User A (`PATCH /api/v1/users/{id}` `{ is_active: true }`) — new users
   are created inactive and cannot log in otherwise
4. Log in as User A (`POST /api/v1/login`) → User A token
5. Create a flow as User A (`POST /api/v1/flows/`, unique random name) → flow id
6. Assert `GET /api/v1/flows/?get_all=true` with the **admin** token contains
   **no** flow whose name matches User A's flow
7. Assert `GET /api/v1/flows/?get_all=true` with **User A's** token contains the
   flow
8. Cleanup (`afterEach`): delete the flow with User A's token, delete User A with
   the admin token

---

## Validation criterion *(required)*

- The admin flow list (`GET /api/v1/flows/`) **excludes** User A's flow (isolation
  holds).
- User A's flow list **includes** it (owner sees their own flow).

Both are hard assertions on the parsed API response. Mutating either (asserting
the admin sees it, or User A does not) fails deterministically. There is no UI
timing or mocked-auth race left in the test.

---

## External dependencies *(required)*

- `GET /api/v1/auto_login` — superuser token (auto-login mode).
- `POST /api/v1/login` — token for User A (bounded backoff-retry on HTTP 429,
  Langflow's login rate limit).
- `POST /api/v1/users/` — create User A (superuser only).
- `PATCH /api/v1/users/{id}` — activate User A (`is_active: true`).
- `POST /api/v1/flows/` — create User A's flow (User A token).
- `GET /api/v1/flows/?get_all=true` — per-user flow list (isolation assertion).
- `DELETE /api/v1/flows/{id}` (User A token) / `DELETE /api/v1/users/{id}` (admin
  token) — cleanup.
- Superuser credentials from `helpers/auth/credentials` (env-driven).
- No provider API key — no flow is executed.

---

## What this test does not cover *(optional)*

- The UI flow-list rendering itself (covered indirectly — the list is driven by
  `GET /flows`).
- Session/cookie cleanup on logout in the browser.
- Sharing / explicit cross-user flow grants (not a feature under test here).

---

## Notes *(optional)*

- **Redesigned from a flaky UI test (the reason for the API rewrite).** The
  pre-promotion spec drove the whole scenario through the browser: it mocked
  `/api/v1/auto_login` to `500` and toggled a `testMockAutoLogin` sessionStorage
  flag to force the login page (the instance runs `LANGFLOW_AUTO_LOGIN=true`),
  then logged in/out as admin and User A through the UI. That mocked-auth dance
  is irreducibly racy — a `--retries=0` baseline burst failed **1 of 3** at the
  admin sign-in (`mainpage_title` never appeared). The flake is a **test
  mechanism** defect, not a product regression: the isolation itself always
  held. Because the instance is auto-login, any manual UI login here requires
  the fragile mock, so the browser layer was removed and the same isolation
  contract is asserted at the API layer — deterministic and hermetic. Confirmed
  live on 1.11.0.dev41 (admin list excludes User A's flow; User A list includes
  it).
- **Cleanup.** The created flow and user are deleted in `afterEach`. The flow is
  deleted with **User A's** token — the superuser cannot see or delete another
  user's flow (a `DELETE` via the admin token returns 404, itself a corollary of
  the isolation under test).
- **New users are inactive by default** — the activation `PATCH` is mandatory or
  User A's login returns 401.
- **Login rate limit (HTTP 429).** Langflow rate-limits `POST /api/v1/login`.
  The admin token is taken from `GET /api/v1/auto_login` (a different endpoint)
  to avoid it, and User A's single login rides out a transient 429 with a bounded
  backoff-retry. This is explicit infra backpressure, not a masked product
  failure — the isolation assertions remain hard.
