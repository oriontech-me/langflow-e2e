# Auth — login screen and per-user flow isolation

**Last validated:** Langflow 1.12.x (measured on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

One journey, two guarantees: when auto-login cannot establish a session the
**login form** is what the user gets, and two users signing in through it each
see **only their own flows**.

1. **should show the login screen when auto-login is off** — with
   `/api/v1/auto_login` refused client-side, `/` renders `Sign in to Langflow`.
2. **should isolate flows per user, both directions** — the superuser signs in
   and creates a named flow; a second (API-provisioned) user signs in and sees
   neither that flow nor anything else of the superuser's; the second user
   creates their own named flow; back as the superuser, the second user's flow
   is invisible and the superuser's own is still there. Both names are exact
   and random per run, so a prefix collision cannot fake either verdict.

---

## Tags *(required)*

`@stable` `@release` `@api` `@database` `@mainpage` `@auth`

`@stable` after the full-directory validation runs. The test is one journey on
purpose — the isolation claim is only meaningful across the same two accounts
in the same run.

---

## Validation criterion *(required)*

- **The auto-login kill switch is client-side** (`page.route` on
  `/api/v1/auto_login` → 500): the server keeps `LANGFLOW_AUTO_LOGIN=true`,
  which is exactly what lets the standalone `request` fixture keep
  authenticating — the second user is provisioned through
  `POST /api/v1/users/` + activation while the browser sees a password-first
  instance. (The OSS Admin Page this test used to drive for that is gone —
  `langflow-ai/langflow#14276`; the CRUD coverage lives in
  `admin-user-management.spec.ts`.)
- **Isolation is asserted in both directions with exact random names.** One
  direction alone would also pass on a workspace that simply shows nothing; the
  superuser's return visit must still SEE their own flow while NOT seeing the
  other user's, which pins "filtered by owner" rather than "empty".
- **Form logins go through `signInThroughForm`
  (`tests/helpers/auth/sign-in-through-form.ts`)**, the browser side of the
  429-absorbing login helper: the endpoint budget is 5/min per client IP,
  fixed window, and this one test spends three form logins — the measured
  collision that used to fail the NEXT file in the run (`logout-flow`, timing
  out on `mainpage_title` through no fault of its own). The helper captures
  the `POST /api/v1/login` response registered before the click, waits out a
  `429`'s `retry_after`, and resubmits; any other status is returned for the
  caller to assert.
- **Flow creation returns the id from the editor URL**, which is what makes
  the cleanup id-scoped instead of name-based.

---

## External dependencies *(required)*

- A running Langflow instance under `LANGFLOW_AUTO_LOGIN=true` (the suite's
  standard state) — the mock only affects the browser context.
- Superuser credentials from `helpers/auth/credentials.ts`
  (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) — the legacy default
  password `"langflow"` is refused since `1.11.0.dev29` (#510).
- `POST /api/v1/users/` + `PATCH` (provision/activate the second user),
  `DELETE /api/v1/users/{id}` and `DELETE /api/v1/flows/{id}` (cleanup).
- The Basic Prompting starter template (flow creation vehicle) and
  `helpers/flows/rename-flow.ts`.
- `POST /api/v1/login` and its per-IP rate limiter — absorbed by
  `helpers/auth/sign-in-through-form.ts`.

---

## Cleanup *(required)*

A `finally` block deletes, with the superuser token: both created flows by the
ids captured at creation (the superuser can delete any user's flow), then the
second user by id. The old version leaked its user and both flows on every
run; this one leaves nothing. Never name-based, never delete-all.

---

## What this test does not cover *(optional)*

- User lifecycle (create/activate/deactivate/rename) —
  `admin-user-management.spec.ts`.
- Logout mechanics and session cleanup — `logout-flow.spec.ts`.
- Invalid and empty credentials — `login-invalid-credentials.spec.ts`.
- API-level enforcement of flow ownership (a user A token reading user B's
  flow by id) — a worthwhile future `@api` spec; this test pins the UI listing.

---

## Notes *(optional)*

- **History.** The previous version carried an Admin-Page-driven user CRUD
  section between the two halves; it died at the `Admin Page` menu click after
  upstream removed the page (#14276) and, before that, leaked one user and two
  flows per run. The surgery moved provisioning to the API, added the missing
  cleanup, and kept the two guarantees that were always this file's subject.
- The empty-workspace state a brand-new user lands on renders
  `mainpage_title` too — the isolation asserts do not depend on the second
  user having any flows yet.
