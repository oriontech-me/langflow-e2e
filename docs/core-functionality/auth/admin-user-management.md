# Auth — admin user management

**Last validated:** Langflow 1.12.x (measured on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

The admin's user-management surface — which in OSS is the **API**,
`/api/v1/users/`, since upstream removed the Admin Page
(`langflow-ai/langflow#14276`, 2026-08-05). Every lifecycle state is proven at
the observable that matters: whether the managed user can log in.

1. **should create a user inactive by default — the inactive user cannot log
   in** — `POST /api/v1/users/` answers `201` with `is_active: false`, and the
   new user's correct credentials are refused `400 "Waiting for approval"` (the
   product's dedicated never-logged-in branch).
2. **should flip the same credentials between refused and accepted via
   activation** — `PATCH {is_active: true}` makes the identical login succeed
   (`200` + `access_token`); `PATCH {is_active: false}` refuses it again, now
   `401 "Inactive user"` (the deactivated-after-use branch — a different branch
   from test 1's, deliberately).
3. **should move the login to the new username on rename** — after
   `PATCH {username}`, the new name logs in with the unchanged password and the
   old name is refused `401` (gone, not aliased).
4. **should offer no Admin Page in the OSS build — menu and route both** — the
   user menu renders no `Admin Page` item, and `/admin` falls through to the
   workspace with the old page's own marker (the `Search Username` field)
   absent.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@auth` (+ `@ui-ux` on test 4, the
one that drives the browser)

`@stable` after the full-directory validation runs: API-driven, no LLM, no
provider, each test creates and deletes its own user.

---

## Validation criterion *(required)*

- **Login is the observable, never the user record.** `is_active: false` read
  back from `GET /users` is what the admin *wrote*; the refused login is what
  it *means*. Every state transition here ends at `POST /api/v1/login`.
- **The two refusal branches are pinned separately because the product ships
  two.** `authenticate_user` (read from the shipped source inside the running
  container) refuses a never-logged-in inactive user with
  `400 "Waiting for approval"` and a previously-logged-in one with
  `401 "Inactive user"`. Test 1 lands in the first branch, test 2's
  deactivation half in the second — asserting one blanket 401 would have been
  wrong on dev33 (it was: the first run of this rewrite failed exactly there).
- **Activation is asserted as a pair** — refused, then accepted, then refused
  again. A lone success is equivocal: a login endpoint that ignored
  `is_active` entirely would pass the activation half alone.
- **Creation asserts `is_active: false` in the 201 body**, so the "inactive
  cannot log in" test cannot pass by accident against an API that started
  activating on create.
- **Every login goes through `postLogin`
  (`tests/helpers/auth/login-request.ts`)**, which absorbs the endpoint's
  per-IP rate limit (5/min, fixed window, every attempt counts — measured for
  `login-rate-limit.spec.ts`). A `401` in these tests is therefore always a
  credential verdict, never the suite's own traffic. The helper never hides a
  verdict: only `429` is retried, after waiting out the window the server
  names in `retry_after` (a string, not a number — the helper converts).
- **Test 4 opens the menu before asserting the absence** — an unopened menu
  also contains no Admin Page. The route half asserts the old page's own
  marker (`Search Username`) absent rather than where the fall-through lands,
  so a redirect-target rename cannot fake a pass.

---

## External dependencies *(required)*

- A running Langflow instance; the superuser token via
  `helpers/auth/get-auth-token.ts` (auto-login endpoint — spends no login-form
  budget).
- `POST/PATCH/DELETE /api/v1/users/` — the admin API that replaced the OSS
  Admin Page.
- `POST /api/v1/login` and its rate limiter (5/min per client IP, fixed
  window) — absorbed by `helpers/auth/login-request.ts`.
- `src/backend/base/langflow/services/auth/` (upstream) — `authenticate_user`
  and its two inactive branches; the `#510` legacy-password refusal this
  rewrite also buried (the old spec logged in with the hardcoded legacy
  password `"langflow"`, refused since nightly `1.11.0.dev29` —
  `helpers/auth/credentials.ts` exists for exactly that).
- `src/frontend/src/routes.tsx` (upstream) — after #14276,
  `pages/AdminPage/` holds only the `/login/admin` LoginPage; no admin route
  registers, which is what test 4 pins.

---

## Cleanup *(required)*

Each test creates its own user with a random name and deletes it by id in
`afterEach` (`DELETE /api/v1/users/{id}`), pass or fail. No flows are created.
Never name-based, never delete-all.

---

## What this test does not cover *(optional)*

- Password change and old-password invalidation —
  `admin-password-change.spec.ts`.
- Per-user flow isolation — `auto-login-off.spec.ts` (§4.2's isolation bullet).
- The login rate limiter itself — `login-rate-limit.spec.ts` (`@destructive`).
- The Enterprise admin UI, which is where the removed page went
  (`enterprise/` specs, `@enterprise` lane).

---

## Notes *(optional)*

- **History.** Until this rewrite the spec drove the OSS Admin Page UI and
  carried two stacked defects: the hardcoded legacy password (#510) made every
  admin login fail on any current nightly, and even with that fixed, the
  `Admin Page` menu click had nothing to click after #14276. Baseline on
  `1.12.0.dev33`: 0/3.
- **Why test 4 earns its place**: the Admin Page moved behind the
  Enterprise/OSS build split. An EE surface leaking back into the OSS bundle
  is a regression a human would only notice by diffing menus — this pins it to
  a named upstream decision instead.
