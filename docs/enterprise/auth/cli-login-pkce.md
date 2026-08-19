# Enterprise — CLI Sign-in (authorization code + PKCE)

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`auth/cli-login` is a **credential-issuance** endpoint: it mints a full access
token for a client that never sees the user's password. It is an authorization
code flow with PKCE, and every one of its refusals is what keeps a stolen or
guessed code from becoming a session.

Measured on the running image, one **fresh authorization per case**:

| Case | Outcome |
|---|---|
| Wrong `code_verifier` (valid length) | refused `400` |
| `state` different from the one authorized | refused `400` |
| `redirect_uri` different from the one authorized | refused `400` |
| All four correct | `200` with an access token |
| The same code exchanged twice | refused `400` |

The consent step is hardened too, and the spec pins it: the page is served
`no-store` with `default-src 'none'`, `frame-ancestors 'none'` and a
**`form-action` restricted to the requested `redirect_uri`**, and the approval
POST carries a `csrf_token` and is rejected outright when the request's origin
does not match (`403 CLI login confirmation origin is invalid`).

## Tags *(required)*

`@enterprise` `@api` `@auth`

No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

A helper performs one authorization per case: `GET /api/v1/auth/cli-login` with
a fresh `state` and the challenge, scrape `request_id` + `csrf_token`, POST them
to `/approve` with a matching `Origin`, and read the `code` from the `302`
`Location`.

**Test 1 — the happy path issues a real token**
Exchange with the correct code, state, redirect and verifier; assert `200` and an
`access_token` that authenticates a subsequent call.

**Test 2 — each binding is enforced, each on its own code**
Wrong verifier, wrong state, wrong redirect: each refused. One fresh
authorization per case, for the reason in the trap below.

**Test 3 — a code is single-use**
Exchange successfully, then exchange the same code again: refused.

**Test 4 — the consent step resists CSRF and framing**
The page carries the restrictive CSP above; `/approve` with a bad `csrf_token`
is refused, and with a foreign `Origin` is refused.

## Validation criterion *(required)*

Fails if any binding stops being enforced (a code usable with the wrong verifier,
state or redirect), if a code can be spent twice, if the approval accepts a
foreign origin or a bad CSRF token, or if the consent page loses its
`form-action` restriction.

## The trap this spec is built around

**A failed exchange consumes the code.** Measured: after a refused attempt, the
*correct* exchange of the same code is also refused. Good behaviour — it stops a
verifier from being brute-forced against a live code — but it means a spec that
reuses one authorization across cases measures nothing after the first: every
later assertion passes for the wrong reason. Each negative case therefore starts
from its own authorization, and the helper exists to make that the easy path.

**All refusals share one opaque message.** `Invalid, expired, or already used CLI
authorization code` is returned for a wrong verifier, a wrong state, a wrong
redirect and a spent code alike. That is deliberate non-disclosure, so the spec
asserts the refusal and never the reason — asserting distinct messages would pin
an information leak the product avoids on purpose.

## External dependencies *(required)*

- A Langflow **Enterprise** instance: `./scripts/start-langflow-enterprise.sh`.
- One login per run (the lane's cached token), then everything else is bearer-authenticated.
- No LLM provider, no network egress: the `redirect_uri` is never actually
  fetched, only echoed and compared.
