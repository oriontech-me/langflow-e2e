# Auth — auto-login

**Last validated:** Langflow 1.12.x (validated on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

The suite's own ground state: under `LANGFLOW_AUTO_LOGIN=true` the app signs
the superuser in with no form, and the auth-adjacent routes do not break that.

1. **should sign in automatically** — `/` reaches the workspace
   (`mainpage_title`, `new-project-btn`) and the templates modal opens; no
   login form is ever shown.
2. **should keep working across the auth routes** — visiting `/login`, `/admin`
   and `/admin/login` under auto-login, the app returns to a working workspace
   each time (each visit re-proven by opening the templates modal, not just by
   the absence of an error).

---

## Tags *(required)*

`@stable` `@release` `@api` `@database` `@auth`

`@stable` after the full-directory validation runs. This is the assumption the
other ~230 specs stand on — every one of them enters through auto-login — so
its failure mode is "everything is red"; having it named keeps that day's
triage a one-liner.

---

## Validation criterion *(required)*

- **"Signed in" is proven by doing, not by URL**: the templates modal opening
  requires the authenticated workspace to be interactive, which a stuck
  spinner or a half-rendered shell would fail.
- **The `/admin` visit doubles as a fall-through check** since upstream removed
  the OSS Admin Page (`langflow-ai/langflow#14276`): no admin route registers,
  so the SPA lands back on the workspace. The dedicated absence assertions
  (menu item, the old page's own marker) live in
  `admin-user-management.spec.ts`.

---

## External dependencies *(required)*

- A running Langflow instance with `LANGFLOW_AUTO_LOGIN=true` (the start
  scripts' and CI's default).
- `GET /api/v1/auto_login` — the endpoint the app bootstraps its session from.

---

## Cleanup *(required)*

Nothing is created. `awaitBootstrapTest` may create a starter flow on a
completely empty workspace (shared bootstrap behaviour, not this spec's own
state); the templates modal is only opened, never submitted.

---

## What this test does not cover *(optional)*

- The password-first path (auto-login off) — `auto-login-off.spec.ts`.
- Session expiry and token validity — `session-expired.spec.ts`.
