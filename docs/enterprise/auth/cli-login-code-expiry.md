# Enterprise — An Expired CLI Authorization Code, and Why It Looks Like an Unknown One

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`cli-login-pkce` covers the binding of an authorization code to its verifier, its state, its
redirect, and its single use. The one property it left open was **expiry**: the code has a TTL
and nothing advanced past it.

Measured, the TTL is **120 seconds** by default (`_DEFAULT_TTL_SECONDS` in the EE
`auth/cli_login.py`, capped at 300, overridable through
`LANGFLOW_CLI_LOGIN_CODE_TTL_SECONDS` with a floor of 1 second and a fallback-with-warning for
an out-of-range value). So this is testable without any special container — it costs about two
minutes of waiting, which is the whole reason it stayed uncovered.

### The property is indistinguishability, not the word "expired"

The § 22.3 line this closes said the refusal "names expiry". It does — as one of **three**
possibilities. Measured, all of these answer `400` with the byte-identical body:

| Code | Answer |
|---|---|
| freshly minted, correct verifier/state/redirect | `200` with an `access_token` |
| a value that was never issued | `400 {"detail": "Invalid, expired, or already used CLI authorization code"}` |
| a real code, exchanged after the TTL | `400`, **the same body** |

That is the correct design and the stronger thing to pin: an attacker holding a candidate code
learns nothing about *why* it failed, so the endpoint is not an oracle for distinguishing
"never existed" from "existed and lapsed" from "already spent". A future change that split
these into distinct messages — the sort of thing that looks like better developer experience —
would hand out exactly that oracle, and no other test would notice.

So the spec asserts the refusal **and** that it is identical to the unknown-code refusal, in
the same test, because either one alone is satisfied by the wrong behaviour.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@auth`

No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

One test, and it is deliberately slow.

1. Mint a code and exchange it immediately → `200`. This is the control: without it, a `400`
   in step 4 could mean the flow never worked on this instance.
2. Exchange a code value that was never issued → `400`, and keep the body.
3. Mint a second code and **wait out the TTL** (the configured value, or 120 s, plus a small
   margin).
4. Exchange it → `400`, and the body is **equal** to step 2's.

`test.setTimeout` is raised to accommodate the wait; the suite's default is five minutes and
the wait alone is over two.

## Validation criterion *(required)*

Fails when an expired code is still accepted — the security property — and equally when the
refusal becomes distinguishable from an unknown code's, which would turn the endpoint into an
oracle. It also fails if the control exchange in step 1 does not succeed, because then the
whole test is measuring a broken flow rather than expiry.

## External dependencies *(required)*

- Any Enterprise instance with CLI login enabled; the default variant is enough. No
  authorization state is touched, so it does not gate on `authz_enabled`.
- **Zero logins** — it reuses the lane's cached superuser token. The CLI consent step requires
  an Editor session, which that token is.
- **~2 minutes of wall clock.** Set `LANGFLOW_CLI_LOGIN_CODE_TTL_SECONDS` on the instance to
  shorten it: the spec reads the same variable and waits accordingly, so a container started
  with `=5` makes this test finish in seconds. It is *not* required — the point of the default
  path is that the property holds on a stock instance.
- No LLM provider, no network egress.

## Notes

The wait is `page`-free and clock-based, and there is nothing to poll: the code does not
change state, its lapse is defined by wall time. An `expect.poll` here would mean "keep asking
whether it is refused yet", which passes the moment the *first* exchange fails — including a
failure for any other reason.

A second, more specific expiry message exists in the source —
`CLI authorization code contains an expired Editor token` — for the case where the code's
embedded session has itself lapsed. It is not exercised here: reaching it means holding a code
whose Editor token expired while the code did not, which needs a token TTL shorter than the
code TTL and is a different property.
