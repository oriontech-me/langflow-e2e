# Enterprise — The Self-Service Password Reset, Beside the Forced One

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`credential-lifecycle` covers the **forced** rotation: the gate that holds a bootstrapped
superuser until it changes its password, the minimum it enforces, and the token it invalidates
on the way out. There is a second path — `PATCH /api/v1/users/{user_id}/reset-password`, which
a user calls for themselves — and nothing covered it. Two paths onto one credential is how a
policy ends up applying to one of them.

Measured, it does. The forced path declares `new_password` with `minLength: 8` and enforces
it; the self-service path declares `password` with **no minimum** and accepts a
**one-character** password with `200` (#1558). Any user can downgrade their own credential
below the policy the product puts every bootstrapped account through.

What the path gets right is asserted alongside, so a fix cannot regress it:

- **Proof of possession**: a wrong `current_password` answers `400 Current password is
  incorrect`.
- **Cross-user reset is refused and complete**: user A resetting user B answers
  `404 You can't change another user's password` — absent rather than forbidden, the
  convention this instance uses everywhere — and B's original password still authenticates,
  so nothing was half-applied.

### The token-lifetime asymmetry, deliberately unasserted

The forced rotation invalidates the token that performed it (`401` afterwards, asserted by
`credential-lifecycle`). The self-service reset does not: the same token still answers
`users/whoami` with `200`.

That may be deliberate — keeping the current session alive while revoking others is a common
choice. It is asserted in **neither** direction, because pinning today's answer would be this
repo settling a product question by assertion, and asserting the opposite would fail a build
that never claimed otherwise. It is recorded in #1558 so the product states which of the two
it means: an operator reading "rotation invalidates tokens" from the forced path will assume
it holds for both.

### Measured

| Call | Answer |
|---|---|
| `PATCH /users/{self}/reset-password`, wrong `current_password` | `400 Current password is incorrect` |
| the same with the correct pair | `200`, and the performing token still authenticates |
| the same with a one-character `password` | **`200`** — the forced path refuses this |
| `PATCH /users/{other}/reset-password`, valid body | `404 You can't change another user's password` |
| the victim's original password afterwards | still authenticates (`200` on `/login`) |

## Tags *(required)*

`@enterprise` `@api` `@regression` `@auth`

No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

Two users are created by the superuser in `beforeAll`; **one** of them logs in, which is the
spec's whole login cost. The second exists only to be a reset target, so nothing here touches
the lane's own principal or the shared RBAC subject.

1. Wrong `current_password` → `400`, message asserted.
2. Correct pair → `200`; the performing token still answers `whoami`, recorded as the
   measured behaviour rather than asserted as correct.
3. **(EXPECTED RED, #1558)** A one-character password is refused, as the forced path refuses
   it. It is accepted today.
4. User A resets user B with a valid body → `404`, message asserted; then B's original
   password still authenticates, which is what makes the refusal complete rather than
   partially applied.

## Validation criterion *(required)*

Fails when proof of possession stops being required, when a user can change another user's
password, or when such a refusal leaves the victim's credential altered. Step 3 fails today by
design and turns green when both paths enforce one policy.

## External dependencies *(required)*

- Any Enterprise instance with password login — the default variant is enough, and the RBAC
  one works too. This spec asserts nothing about authorization, so it does not gate on
  `authz_enabled`.
- **One** login per run: the acting user. The reset target never logs in, and the final check
  that its credential is intact is a `POST /login` that is *expected to succeed* — counted
  against the five-per-minute per-IP budget, which is why the spec spends nothing else.
- No LLM provider, no network egress.

## Notes

The target user is a second throwaway account rather than the superuser. An earlier version of
this measurement pointed the cross-user attempt at the superuser, which would have changed the
lane's own credential had the product allowed it — the answer was `404`, but a test that has to
be right about the product to be safe is the wrong shape.

Both users are deleted in `afterAll`. `DELETE /api/v1/users/{id}` answers `200`.
