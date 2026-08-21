# Auth — admin changes a user's password

**Last validated:** Langflow 1.12.x (validated on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

That a superuser setting another user's password via
`PATCH /api/v1/users/{id}` really moves the credential — proven at the login
endpoint from both sides.

1. **should let the user log in with the new password** — after the PATCH, the
   new password answers `200` with an `access_token` at `POST /api/v1/login`,
   and the same credentials sign in through the real login form to the
   workspace (`new-project-btn`).
2. **should refuse the old password after the change** — the old password is
   proven live *before* the change (`200`, the control assertion) and refused
   *after* it (`401`) — without the control, a login endpoint that refused
   everything would pass.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@auth`

`@stable` after the full-directory validation runs: API-driven with one UI
login, no LLM, no provider, per-test user cleanup by id.

---

## Validation criterion *(required)*

- **Both directions at the login endpoint.** "New works" and "old stops
  working" are separate failures with separate causes; each test owns one,
  and the old-password test carries its before/after control pair.
- **User creation and password change happen via API on purpose** — the OSS
  Admin Page is gone (`langflow-ai/langflow#14276`), and the API was already
  this spec's vehicle before that (the admin UI's search-only-filters-current-
  page pagination bug is noted in the spec's own comments).
- **Logins go through `postLogin` (`tests/helpers/auth/login-request.ts`)**,
  absorbing the endpoint's per-IP 5/min fixed-window budget so a `401` is
  always a credential verdict — this file alone spends five login calls in
  ~30 s, which is exactly the collision profile the helper exists for.
- **The UI login half keeps the client-side auto-login mock**, with the known
  caveat documented in the spec: a failed UI login under the mock resets the
  page before the error toast can be read, so failure paths are asserted at
  the API and only the success path at the UI.

---

## External dependencies *(required)*

- A running Langflow instance; superuser token via
  `helpers/auth/get-auth-token.ts`.
- `POST /api/v1/users/`, `PATCH /api/v1/users/{id}` (password and activation),
  `DELETE /api/v1/users/{id}`.
- `POST /api/v1/login` and its rate limiter — absorbed by
  `helpers/auth/login-request.ts`.

---

## Cleanup *(required)*

Each test deletes its random-named user by id in a `finally` block, pass or
fail. No flows are created.

---

## What this test does not cover *(optional)*

- Self-service password change (Settings → General password form — hidden
  under `LANGFLOW_AUTO_LOGIN=true`).
- Whether a password change invalidates previously minted tokens (measured on
  the Enterprise side: it does not, self-service — see the `enterprise/` auth
  specs).
- Activation/deactivation/rename — `admin-user-management.spec.ts`.
