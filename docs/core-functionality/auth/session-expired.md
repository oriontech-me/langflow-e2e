# Auth — expired and absent sessions

**Last validated:** Langflow 1.12.x (validated on nightly `1.12.0.dev33`)

---

## What this test validates *(required)*

That a request without a live session is refused at the API and recoverable at
the UI — four small tests, one boundary each.

1. **should refuse an invalid token** — `GET /api/v1/flows/` with a garbage
   bearer answers `401`/`403`.
2. **should refuse the absence of a token** — the same call with no
   `Authorization` header is refused the same way.
3. **should fall back to the login screen when a session cannot be
   established** — with `/api/v1/auto_login` answering 500 (client-side mock:
   auth backend down, or an expired session that cannot re-establish), the UI
   renders the login form with both fields and the submit button — a
   recoverable state, not a blank page.
4. **should accept a valid token** — the control assertion: the same protected
   route answers `200` with a real token, so tests 1–2 cannot pass against an
   API that refuses everything.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@auth`

`@stable` after the full-directory validation runs: no LLM, no provider,
nothing created, no login-form attempts (the token comes from
`get-auth-token`, which uses the auto-login endpoint).

---

## Validation criterion *(required)*

- **The refusal pair plus the acceptance control.** Refusals alone are
  equivocal (a dead API also refuses); the valid-token `200` is what makes
  them evidence of *auth*, specifically.
- **`401`/`403` are both accepted** for the refusals: which one the backend
  picks has moved between versions and is not this spec's subject — the
  boundary existing is.
- **Test 3's mock is client-side**, so it simulates the *browser's* view of an
  expired/unavailable session without touching the shared instance.

---

## External dependencies *(required)*

- A running Langflow instance; `helpers/auth/get-auth-token.ts` for the valid
  token.
- `GET /api/v1/flows/` as the protected route under test.

---

## Cleanup *(required)*

Nothing is created.

---

## What this test does not cover *(optional)*

- Real token expiry by clock (no spec advances a clock past a JWT's `exp`).
- Logout-driven session teardown — `logout-flow.spec.ts`.
- Re-authentication through the form after the fallback —
  `auto-login-off.spec.ts`.
