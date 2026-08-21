# Auth — login with invalid credentials

**Last validated:** Langflow 1.12.x (validated on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

The login form's refusal path: bad input is told apart from a broken form.

1. **should show an error and stay on the login page for wrong credentials** —
   a nonexistent username/password pair produces the `Error signing in`
   alert, no navigation to the workspace, and the form still present for a
   retry.
2. **should not navigate on an empty submit** — submitting with both fields
   empty leaves the login page in place (client-side validation; no workspace,
   form still visible).

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@auth`

`@stable` after the full-directory validation runs: no LLM, no provider,
nothing created.

---

## Validation criterion *(required)*

- **Three assertions per refusal, because each fails differently**: the error
  surface appears (a silent refusal is itself a defect), the workspace is NOT
  reached (`mainpage_title` absent — the security half), and the form remains
  usable (a dead-end refusal is a UX defect).
- **The wrong-credentials attempt spends one unit of the login endpoint's
  per-IP budget** (5/min fixed window — the limiter counts before
  authentication). One attempt per test keeps this file's footprint minimal;
  the budget-collision absorption for the specs that log in successfully lives
  in `helpers/auth/sign-in-through-form.ts` / `login-request.ts`.
- **The auto-login kill switch is client-side** (`page.route` → 500 on
  `/api/v1/auto_login`), the directory's shared pattern — the server is
  untouched.

---

## External dependencies *(required)*

- A running Langflow instance (server-side auto-login state irrelevant — the
  mock forces the form).
- `POST /api/v1/login` — one deliberately failing call.

---

## Cleanup *(required)*

Nothing is created; the browser context and its mock are discarded with the
test.

---

## What this test does not cover *(optional)*

- The rate-limited refusal (`429`) — `login-rate-limit.spec.ts`
  (`@destructive`: the budget is instance-global).
- Valid-credential journeys — `auto-login-off.spec.ts`, `logout-flow.spec.ts`.
- The inactive-user refusals (`400 "Waiting for approval"` /
  `401 "Inactive user"`) — `admin-user-management.spec.ts`.
