# Enterprise — Without a Licence, the Entitled Surface Fails Closed

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

An Enterprise instance that cannot validate a licence has to be **unavailable**, not
**open**. Those two words describe the same HTTP outcome to a casual reader and opposite
outcomes to an operator: one means the entitled feature cannot be used, the other means it
is being served without the check that governs it.

Most of the SSO surface is blocked on entitlement validation, which is why the rest of
session 5 of the Enterprise plan is unreachable without a licence key. The half that *is*
reachable is the one that matters most, because it is the difference above — and nothing
covers it.

Four properties, measured on an instance with no licence:

1. **The gated routes refuse, with one stable message.** `GET /api/v1/sso/entitlements`
   and `POST /api/v1/sso/connections` both answer `503` with the identical body
   `{"detail":"Enterprise license validation is unavailable"}`.
2. **The refusal is total.** The creation route is refused, so no connection can come into
   existence — `GET /api/v1/sso/connections` stays empty, and there is no half-created
   connection for a later request to trip over.
3. **Authentication runs first.** An anonymous caller gets `403 No authentication
   credentials provided`, not the `503`. The licence gate never answers before the auth
   gate, so it cannot be used to enumerate which Enterprise surfaces a deployment has.
4. **The blast radius is bounded.** Flows, the component catalog, projects and identity all
   answer `200`. An unlicensed Enterprise is a product missing its entitled features, not a
   product that stopped working.

### What the message must not become

The failure text is asserted **exactly**, not with a loose `toContain`. A licence failure is
a natural place for a stack trace, an internal hostname, a signing-key identifier or a
vendor URL to escape into a response body an unauthenticated-adjacent caller can read — and
each of those would be a leak that no other test in this suite would notice. Measured today
the body is 57 bytes and carries a `detail` and nothing else.

Pinning the string has a cost worth naming: a product decision to reword it fails this
test. That is the intended trade. The reword is a one-line update here, while a silently
widened message is exactly what an exact assertion exists to catch.

## Relationship to the neighbouring specs

`login-surface.spec.ts` already covers the other half of the fail-closed story — that
password login survives SSO being switched on but unusable, and that break-glass ships
disabled. This spec does not repeat it; between them, "SSO is unavailable" is proven to
mean the organisation is neither locked out nor let in.

## Tags *(required)*

`@enterprise` `@api` `@auth` `@sso`

Reuses the pairing `login-surface.spec.ts` established rather than introducing licensing
vocabulary: the licence is what gates this surface, but the surface is SSO, and a reader
filtering for `@sso` wants this test.

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would
silently never run (#1010).

## Step by step *(required)*

Every test first requires the instance to have **no** licence — `GET /api/v1/sso/entitlements`
answering `503`. A licensed instance skips, naming why, because every assertion below
describes the unlicensed state and would otherwise report a correctly licensed deployment
as a defect.

1. **The gated read and the gated write refuse identically.** Both answer `503`; the two
   bodies are compared to each other, not just to a literal, so a per-route message
   divergence is caught.
2. **The body carries a `detail` and nothing else** — no traceback, no path, no host, no
   key identifier.
3. **No connection exists.** `GET /api/v1/sso/connections` returns an empty list after the
   refused creation attempt.
4. **An anonymous call is refused by authentication**, not by entitlement: `403`, and the
   body does not mention the licence.
5. **The rest of the product answers `200`:** `flows/`, `all`, `projects/`,
   `users/whoami`.

## Validation criterion *(required)*

Fails when an unlicensed instance is permissive rather than unavailable — a gated route
that answers anything but `503`, a connection that comes into existence, a licence refusal
reaching an unauthenticated caller, or a message that grows beyond its single `detail`.
Also fails when the blast radius widens: a core product endpoint that stops working because
a licence is absent.

## External dependencies *(required)*

- A Langflow **Enterprise** instance with no licence configured:
  `./scripts/start-langflow-enterprise.sh` (the default — the script configures none).
- No LLM provider and no network egress.
- **One** unauthenticated request, which spends nothing from the login budget. This spec
  performs no password login of its own beyond the cached lane token.

## Notes

The creation attempt is a real `POST`, not a dry run, because the property being tested is
that it is refused. On an instance that ever does carry a licence the gate skips the whole
file before the attempt is made, so the destructive reading of this test never occurs.
