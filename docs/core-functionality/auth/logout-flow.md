# Logout flow

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev2`)

---

## What this test validates *(required)*

That logging out clears the authenticated session and returns the user to the
login page, and that the session cannot be silently resumed afterwards. Three
tests cover the complete logout contract:

1. Logout from the user menu redirects to the login page and the main page is no
   longer visible.
2. After logout, navigating directly to `/` does not bypass authentication — the
   login page is shown.
3. After logout, reloading the page keeps the user on the login page.

If this fails, either logout does not revoke the session (a security regression)
or the post-login navigation is broken (users can authenticate but never reach
the app).

The suite forces a manual-login environment by mocking `/api/v1/auto_login`
(→ 500) so the login form is shown even when the instance runs with
`LANGFLOW_AUTO_LOGIN=true`. It then signs in with the configured superuser
credentials.

---

## Tags *(required)*

`@release` `@api` `@regression` `@auth` `@stable`

---

## Step by step *(required)*

1. Mock `/api/v1/auto_login` to fail so the login form is presented.
2. Fill the superuser credentials (from the shared credentials module) and click
   **Sign In**.
3. Wait for `mainpage_title` to confirm the authenticated main page loaded.
4. Open the user menu and click **Logout**.
5. Assert the login page is shown again and the main page is hidden.
6. (Tests 2 & 3) Attempt to reach the app via direct navigation to `/` or a page
   reload and assert the login page still holds.

---

## Validation criterion *(required)*

- Manual **Sign In** with the configured superuser credentials reaches the main
  page (`mainpage_title` visible).
- After **Logout**, the login form (`sign in to langflow`) is visible and
  `mainpage_title` is hidden.
- Direct navigation to `/` and a reload after logout both stay on the login page.
- **The `POST /api/v1/login` wait is ATTRIBUTED, not bare** (#1713). The 30 s
  budget is unchanged — only the failure path is. A bare `waitForResponse` fails
  as `TimeoutError: page.waitForResponse: Timeout 30000ms exceeded while waiting
  for event "response"`, a string that cannot tell apart the only two states that
  produce it: a backend that accepted the POST and never answered, or a login
  form that stopped issuing it. On timeout the helper probes `/api/v1/version`
  and reports which state it observed — the contract
  `helpers/other/page-entry-barrier.ts` already applies to entry selectors
  (#1262/#1265): an unreachable or non-2xx backend carries
  `[backend-unreachable]` and embeds the probe's own transport error, which the
  existing `api-request-timeout` signature matches with **no new entry added**; a
  **healthy** probe deliberately gets no prefix, so a frontend that stops sending
  the POST still costs the tag; a probe that could not run reads UNKNOWN, never
  clean (#1012).

---

## External dependencies *(required)*

- `src/frontend/src/pages/LoginPage/**` — the login form (Username/Password
  fields, **Sign In** button). A markup change breaks the credential fill.
- `tests/helpers/auth/sign-in-through-form.ts` — every form login here goes
  through the 429-absorbing helper: `POST /api/v1/login` is limited to 5/min
  per client IP (fixed window, counted before authentication), and this
  file's three logins used to be the ones that met a window exhausted by
  the auth specs running before it. Since #1713 the same helper also
  ATTRIBUTES the response wait — see Notes.
- `src/frontend/src/pages/MainPage/components/header/**` — renders
  `data-testid="mainpage_title"`, the post-login landing assertion.
- `src/backend/base/langflow/api/v1/login.py` — `/api/v1/login` and
  `/api/v1/auto_login`. Auth-policy changes here directly affect this flow (see
  Notes).
- `src/backend/base/langflow/services/utils.py` — `setup_superuser`: governs
  which superuser password is accepted (see Notes).

---

## Preconditions *(optional)*

- The instance must be reachable and configured with a superuser whose password
  is **not** the legacy default `langflow` (see Notes). CI and the start scripts
  set `LANGFLOW_SUPERUSER_PASSWORD=langflow123`; the tests read the same value
  via `tests/helpers/auth/credentials.ts`.

---

## Notes *(optional)*

- **The shared login wait is attributed (#1713).** The first test in this file
  flaked in the 2026-09-04 daily under the same signature as
  `login-invalid-credentials.spec.ts` — the same `waitForResponse`, in the same
  helper, inside a measured 92 s shard-1 outage. It is not separately
  quarantined and needs no change of its own: the attribution lands in
  `tests/helpers/auth/sign-in-through-form.ts`, the single call site all three
  logins in this file go through.
- **Legacy default password (issue #510).** Since nightly `1.11.0.dev29`, a
  superuser password equal to the legacy default `langflow` is rejected under
  `LANGFLOW_AUTO_LOGIN=true` (a random bootstrap password is generated instead, so a
  manual Sign In returns `401`). This produced the daily hard failure tracked in
  #477: the manual Sign In never authenticated, so `mainpage_title` never mounted
  and the test timed out after 30s — a login rejection, not a slow first paint.
  The fix moves the superuser password off the legacy default and centralizes it
  in `tests/helpers/auth/credentials.ts`, so the instance and the tests always
  agree on the same non-legacy value.
