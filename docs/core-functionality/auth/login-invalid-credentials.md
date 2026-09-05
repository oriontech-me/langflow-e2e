# Auth — login with invalid credentials

**Last validated:** Langflow 1.13.x (validated on nightly `1.13.0.dev2`)

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

- A running Langflow instance (server-side auto-login state irrelevant — the
  mock forces the form).
- `POST /api/v1/login` — one deliberately failing call.

---

## Cleanup *(required)*

Nothing is created; the browser context and its mock are discarded with the
test.

---

## Notes *(optional)*

- **Why the login wait is attributed (#1713).** This test flaked in the
  2026-08-26 and 2026-09-04 dailies under a byte-identical signature
  (`page.waitForResponse: Timeout 30000ms`, `infra_signature: null` on both
  rows), and the 2026-09-04 attempt's own error context settles what the string
  could not: the form still held `wronguser`/`wrongpassword`, an inline `Too
  many requests` alert showed the first submit had been refused `429`, and a
  blocking `Connection timed out` dialog was open over the page. That dialog is
  the frontend's health-check overlay — `GET /health_check` raced against a 10 s
  timer — so the page itself had already observed the backend as unreachable,
  independently of the run's liveness recorder (shard 2: 29.1 % of its span
  down, the failing attempt entirely inside a 96 s outage). The nightly's bundle
  configures no client-side request timeout, so the login POST is never aborted
  by the app: once issued it waits for the backend, and a `waitForResponse`
  shorter than the outage is guaranteed to expire. The fix therefore attributes
  the wait instead of extending it — the flake is wedge collateral, and the
  defect the suite owned was that its own error message could not say so.
- **`page.waitForResponse: Timeout` must NOT be added to
  `scripts/lib/infra-signature-patterns.json`.** It is ambiguous by
  construction — a frontend that stops issuing a request produces it too — which
  is the same argument `helpers/other/page-entry-barrier.ts` records for
  `locator.waitFor: Timeout`. Attribution belongs at the call site, where the
  probe can tell the two states apart.

---

## What this test does not cover *(optional)*

- The rate-limited refusal (`429`) — `login-rate-limit.spec.ts`
  (`@destructive`: the budget is instance-global).
- Valid-credential journeys — `auto-login-off.spec.ts`, `logout-flow.spec.ts`.
- The inactive-user refusals (`400 "Waiting for approval"` /
  `401 "Inactive user"`) — `admin-user-management.spec.ts`.
