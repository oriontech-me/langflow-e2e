# Enterprise — Credential Lifecycle (forced rotation, status, token invalidation)

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

What Enterprise does to a credential that OSS does not do at all. The superuser
bootstrapped from the environment is created **already required to rotate**, and
until it does, the product is closed to it.

Three properties, measured on the running image and asserted here:

1. **The gate is an allowlist, and its shape is the point.** Identity and
   discovery stay reachable — `users/whoami`, `account/password-status`,
   `auth/methods`, `config`, `version` — because a client that cannot discover
   the requirement cannot satisfy it. Everything else is refused `403` with
   `must_change_password`: flows, projects, variables, the component catalog, all
   three policy surfaces, `sso/settings`, `authz`, and **`api_key/`**. That last
   one is the security property: an account under a forced rotation cannot mint
   an API key and walk around the gate.
2. **`account/password-status` agrees with enforcement**, before and after. It is
   what a client reads to decide whether to show the change-password screen at
   all, so a status that disagrees with the gate is worse than either alone.
3. **The rotation invalidates tokens minted before it.** The token that performed
   the rotation is rejected (`401`) immediately afterwards, and a token obtained
   with the new password works.

## Relationship to the OSS auth specs

`core-functionality/auth/` covers the OSS login surface: an admin changing
another user's password (`admin-password-change`), missing or invalid tokens
(`session-expired`), password-first mode existing (`auto-login-off`). **None of
them covers a forced rotation**, which does not exist in OSS — there is no
`/api/v1/account/*` there at all.

## Tags *(required)*

`@enterprise` `@api` `@auth`

No `@stable`: there is no scheduled Enterprise lane, and `@stable` without one is
a test that silently never runs (#1010).

## Step by step *(required)*

`mode: "serial"` — the three tests are one story told in order, and the state is
consumed as it is told.

**Test 1 — the gate, before rotating**
1. Log in with the bootstrap password; require `password-status` to report the
   rotation is pending, and skip naming the start command otherwise.
2. Assert the allowlisted endpoints answer `200`.
3. Assert the product and admin endpoints answer `403` carrying
   `must_change_password`, `api_key/` among them.

**Test 2 — rotating**
1. A wrong current password is refused.
2. A new password below the minimum length is refused.
3. The correct rotation answers `200`.
4. `password-status` now reports no pending rotation, and an endpoint that was
   refused in test 1 answers `200`.

**Test 3 — the old token**
1. The token minted before the rotation is rejected (`401`).
2. A token obtained with the new password is accepted.

## Validation criterion *(required)*

Fails if the gate lets a blocked surface through (especially `api_key/`), if it
blocks the discovery endpoints a client needs to satisfy it, if the status
disagrees with enforcement in either direction, if a wrong or too-short password
is accepted, or if a token minted before the rotation still works after it.

## External dependencies *(required)*

- A Langflow **Enterprise** instance whose superuser has **not yet rotated**:
  `LANGFLOW_EE_PASSWORD=langflow123 ./scripts/start-langflow-enterprise.sh`
  (matching the bootstrap password makes the script's own rotation a no-op).
- **One-shot per container.** This spec consumes the state it observes: after it
  runs, the rotation is done and it will skip until a fresh container exists.
  That is deliberate — the state is only reachable once, and a spec that
  pretended otherwise would be asserting on a rotated instance.
  The condition is detected **before** the login is spent, from the login's own
  status: on an already-rotated instance the bootstrap password answers `401`,
  and that IS the one-shot signal. Reading it afterwards made the second run
  report "login failed", a red about the environment rather than the product —
  which is the failure mode this gate exists to prevent.
- **Login budget.** Langflow rate-limits `/api/v1/login` per IP, so the spec
  spends exactly two logins (one before the rotation, one after) and reuses the
  tokens for everything else.
- No LLM provider, no network egress.

## Open question, deliberately not asserted

The **self-service** reset (`PATCH /api/v1/users/{id}/reset-password` on one's
own id) does **not** invalidate previously minted tokens — measured: the old
token still answered `200`. Whether that asymmetry with the forced path is
intended is a product question, and it is not asserted here in either direction
until it is answered. Pinning today's behaviour would freeze a possible defect;
asserting the opposite would invent a requirement.
