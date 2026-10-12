# Enterprise — The Self-Service Password Reset, Beside the Forced One

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

`credential-lifecycle` covers the **forced** rotation: the gate that holds a bootstrapped
superuser until it changes its password, the minimum it enforces, and the token it invalidates
on the way out. There is a second path — `PATCH /api/v1/users/{user_id}/reset-password`, which
a user calls for themselves — and nothing covered it. This spec covers what **that** path
claims, and only what it claims.

The route is OSS (`langflow/api/v1/users.py`). On 1.12 Enterprise did not touch it; since the
1.13 line it can refuse in more ways, none of which a **local-password account on a lane with
no SSO** can reach, so they are recorded here and not asserted (read from the source at
`bbbec5fb` / `1e829663`, not measured):

- `403 local_auth_disabled` when an operator has made sign-in SSO-only, and `403
  sso_password_change_disabled` for an SSO-linked account (EE `local_login_gate`).
- `403 interactive_login_required` when the caller authenticates with an API key, and `429`
  after five attempts per user per minute (langflow-ai/langflow#15470). The spec spends three.
- `409 external_credentials_managed` when directory sync manages the credential.

The three refusals a local-password account **can** reach are unchanged, and all three are
asserted here:

- **Proof of possession**: a wrong `current_password` answers `400 Current password is
  incorrect`.
- **Re-use is refused**: passing the account's current password as the new one answers
  `400 You can't use your current password` — the only content rule the route has, and the one
  that was uncovered until #1558's re-measurement.
- **Cross-user reset is refused and complete**: user A resetting user B answers
  `404 You can't change another user's password` — absent rather than forbidden, the
  convention this instance uses everywhere — and B's original password still authenticates,
  so nothing was half-applied.

### The absent minimum is a product decision, recorded and asserted in neither direction

`PasswordResetRequest` declares `{current_password: str, password: str}` with **no minimum**,
so a **one-character** password is accepted with `200`. That was filed as a defect (#1558) on
the reading that a minimum had been added to one model and not the other. The product's own
source refutes that reading — `IBM-Langflow@release-1.12.0`, `src/api/account_linking.py`:

```python
class ForcePasswordChangeRequest(BaseModel):
    # No password-strength policy exists anywhere else in this codebase today
    # (confirmed: OSS's own reset-password endpoint validates nothing beyond
    # "differs from the current password") — this minimum is a deliberate
    # floor for a security-critical admin/break-glass recovery flow, not
    # inherited from an existing convention.
    current_password: str
    new_password: str = Field(min_length=8)
```

So the asymmetry is declared deliberate, and `min_length=8` on that one model is the **only**
password minimum anywhere in the Enterprise codebase. Two further measurements place it:

- `src/auth/password_policy.py`, despite its name, holds only the **forced-rotation flag**
  (`set_must_change_password` / `must_change_password` / `clear_must_change_password`). There
  is no strength policy to be inconsistent with.
- There is a **third** password-setting path, and it has no floor either: the CLI
  `langflow admin reset-password` refuses only an **empty** password
  (`Password must not be empty.`, `src/cli.py`), so a one-character password is accepted
  there too.

Asserting the minimum on this route would therefore be this repo deciding a product question
by assertion — the same reason the token-lifetime asymmetry below is left alone. What is worth
putting to the product, and is recorded rather than asserted: the declared rationale scopes the
floor to "a security-critical admin/break-glass recovery flow", yet the CLI **is** the
break-glass recovery path and has no floor, so the stated justification does not hold across
the paths it names.

### The token-lifetime asymmetry, also deliberately unasserted

The forced rotation invalidates the token that performed it (`401` afterwards, asserted by
`credential-lifecycle`). The self-service reset does not: the same token still answers
`users/whoami` with `200`.

That may be deliberate — keeping the current session alive while revoking others is a common
choice. It is asserted in **neither** direction, because pinning today's answer would settle a
product question by assertion, and asserting the opposite would fail a build that never claimed
otherwise. Recorded in #1558 so the product states which of the two it means: an operator
reading "rotation invalidates tokens" from the forced path will assume it holds for both.

### Measured

| Call | Answer |
|---|---|
| `PATCH /users/{self}/reset-password`, wrong `current_password` | `400 Current password is incorrect` |
| the same, `password` equal to the current one | `400 You can't use your current password` |
| the same with the correct pair and a new password | `200`, and the performing token still authenticates |
| the same with a one-character `password` | `200` — measured, asserted in neither direction |
| `PATCH /users/{other}/reset-password`, valid body | `404 You can't change another user's password` |
| the victim's original password afterwards | still authenticates (`200` on `/login`) |

Password minimums across the three paths that set one, measured on the same build:

| Path | Minimum |
|---|---|
| `POST /api/v1/account/force-password-change` (EE) | `min_length=8`, enforced |
| `PATCH /api/v1/users/{id}/reset-password` (OSS) | none — one character accepted |
| `langflow admin reset-password` (EE CLI) | non-empty only — one character accepted |

## Tags *(required)*

`@enterprise` `@api` `@regression` `@auth`

No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

Two users are created by the superuser in `beforeAll`; **one** of them logs in, which is the
spec's whole login cost. The second exists only to be a reset target, so nothing here touches
the lane's own principal or the shared RBAC subject.

1. Wrong `current_password` → `400`, message asserted.
2. The account's **current** password offered as the new one → `400 You can't use your current
   password`, message asserted. Ordered before the successful change so the password it re-uses
   is the one the account actually has.
3. Correct pair with a new password → `200`; the performing token still answers `whoami`,
   recorded as the measured behaviour rather than asserted as correct.
4. User A resets user B with a valid body → `404`, message asserted; then B's original
   password still authenticates, which is what makes the refusal complete rather than
   partially applied.

## Validation criterion *(required)*

Fails when any of the route's three refusals stops holding: proof of possession no longer
required, the current password accepted as the new one, a user able to change another user's
password, or such a refusal leaving the victim's credential altered. Nothing here fails by
design — the absent length minimum is measured and recorded above, not asserted.

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

Both users are deleted in `afterAll`. Since langflow-ai/langflow#15470,
`DELETE /api/v1/users/{id}` answers **`202`** and erases the account in the background, so the
user may still be listed for a moment; nothing here reads it back.

On 1.13 the user creation in `beforeAll` is tier-gated: without a licence it answers `503
Enterprise license validation is unavailable`, which is why the lane's start script sets
`LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true` (#2259).
