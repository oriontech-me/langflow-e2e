# Enterprise — Login Surface and Break-glass Defaults

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

What the login screen is allowed to offer, and the emergency account behind it.

**Password login must survive a non-working SSO.** This is the golden invariant
of the area: an SSO mistake must never lock an organisation out of its own
instance. It is assertable today without a licence, because an instance with
`LANGFLOW_SSO_ENABLED=true` and no usable connection is exactly the misconfigured
state — measured: `GET /api/v1/auth/methods` answers
`{"show_local_form": true, "sso": {"enabled": false, "providers": []}}`, and the
password login still works. SSO *switched on* is not SSO *available*, and the
login screen must reflect the second, not the first.

**Break-glass is off by default and its use is recorded.** `GET /api/v1/sso/settings`
reports `break_glass_enabled: false` with `break_glass_last_used_at: null` on a
fresh instance. An emergency account that ships enabled, or whose use leaves no
trace, is the kind of default nobody notices until it matters.

## Tags *(required)*

`@enterprise` `@api` `@auth` `@sso`

`@sso` because the surface is the SSO admin's, even though no SSO connection
exists here. No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

**Test 1 — the login screen still offers the local form**
`auth/methods` reports `show_local_form: true`, and `sso.enabled` is false while
no connection is usable. Then authenticate with the password and assert the token
works — the assertion that makes the first half mean something.

**Test 2 — break-glass defaults**
`sso/settings` reports `break_glass_enabled: false` and
`break_glass_last_used_at: null`, and names a `break_glass_user_id`.

**Test 3 — enabling it is an explicit, reversible admin act**
`PATCH sso/settings {break_glass_enabled: true}` answers `200` and the read
reflects it; enabling alone does **not** stamp `break_glass_last_used_at`, which
must only record actual use. Restore to `false` afterwards.

## Validation criterion *(required)*

Fails if the local form disappears while SSO is merely switched on (the lock-out
scenario), if password login stops working in that state, if break-glass ships
enabled, if enabling it silently marks it as used, or if the settings read does
not reflect a write.

## External dependencies *(required)*

- A Langflow **Enterprise** instance: `./scripts/start-langflow-enterprise.sh`
  (the script already sets `LANGFLOW_SSO_ENABLED=true`, which is the state under
  test).
- **Test 3 mutates instance settings** and restores them. It is the only write
  here; a failure between write and restore leaves break-glass enabled, which the
  spec reports rather than hides.

## Out of scope, and why

Creating an SSO **connection** is entitlement-gated and answers `503` without a
licence, so "a connection is disabled by default", plan limits and secret masking
cannot be asserted here. They are tracked in the issue, not silently dropped.
