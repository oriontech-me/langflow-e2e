# Enterprise — Ownership, Team Membership and API Keys as Access Paths

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

`deny-matrix-and-decision-api` covered the subjects a role or a direct share produces. Three
grant paths remain, and each answers a question the role matrix cannot.

### Ownership is an axis of its own, and it outlives the role

Measured: a user granted `developer` creates a flow, then the assignment is removed. They
still read it (`200`), still modify it (`200`), and it is still in their listing.

That is almost certainly intended — people keep what they made — but it is a governance fact
an operator has to know, and nothing stated it before this spec: **revoking a role does not
revoke access to what was created under it.** An administrator who removes `developer` from a
departing user has not removed that user's access to their existing flows. Whatever the right
product answer is, the suite should fail the day it changes silently, in either direction.

### A team share is a real grant, with two independent revocation paths

A share with `scope: "team"` behaves exactly like a direct one — read granted, write still
refused at `403` — and it can be taken away in two ways that are genuinely different:

| Removing | Effect |
|---|---|
| the share | subject returns to `404` |
| the subject's **membership**, share intact | subject returns to `404` |
| re-adding the membership | access returns, `200` |

Both matter because an operator has both levers, and a grant that survives either one is a
grant that cannot be taken back through the path the operator happened to use.

### An API key is a credential, not a privilege

This is the security-relevant one. A key minted by a subject holding **no role** carries
exactly that subject's permissions and no more:

| Through the key | Result |
|---|---|
| read a flow the subject owns | `200` |
| read a flow it does not own | `404` |
| create a flow | `403` |
| an RBAC admin route | `403` |

A key that answered otherwise would be an escalation path around the whole authorization
model, reachable by any user who can press "create key" — and it would be invisible to every
test that only ever authenticates with a bearer token.

## The infrastructure bug this uncovered

API keys could not be created **at all** on either Enterprise container. `LANGFLOW_SECRET_KEY`
was a base64-encoded sentence, 35 bytes decoded, and Langflow encrypts API keys with Fernet,
which requires exactly 32 url-safe base64 bytes. Every creation answered `400 Fernet key must
be 32 url-safe base64-encoded bytes`.

It survived because it read as a per-request failure rather than as a container that could not
mint a key at all, and because nothing in this lane created one until an API key was needed as
a matrix subject. The start script now derives a valid key deterministically, so it stays
stable across restarts — the property the original literal was chosen for — without being a
magic value nobody can regenerate.

## Note — the owner override (#1635)

Since the 2026-08-27 Enterprise build, `flow:create` is allowed by an **owner override** when
the destination project belongs to the caller, and a bare `POST /api/v1/flows/` canonicalises
to exactly that project. Any probe here that means "this subject is refused" therefore names a
destination the subject does **not** own, via `attemptFlowCreate(…, folderId)`.

The full reasoning, and the test that pins the override as a scoped rule rather than a hole,
live in `rbac-instance-baseline.md`.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010).

## Step by step *(required)*

All three gate on an instance that enforces (`authz_enabled` true, `superuser_bypass` false).
They use the subject shared by the whole `authz/` directory, reset before each test through
the superuser, which costs no login.

1. **Ownership.** Grant `developer`; the subject creates a flow and can read and modify it.
   Remove every assignment. Re-probe: read, modify and listing membership all unchanged.
2. **Team.** Superuser creates a flow, a team, and adds the subject. Baseline `404`. Share to
   the team with `read` → `200` read, `403` write. Remove the membership with the share intact
   → `404`. Re-add → `200`. Delete the share → `404`.
3. **API key.** With no role and one owned flow, the subject mints a key and exercises the four
   probes above through `x-api-key`, with no bearer token present.

## Validation criterion *(required)*

Fails when ownership stops behaving as an independent axis (either by evaporating with the
role or by granting more than the owner had), when a team grant survives a revocation path an
operator would reasonably use, or when an API key answers anything its owner's own token would
not.

## External dependencies *(required)*

- The Enterprise RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`, with `PLAYWRIGHT_BASE_URL`
  pointed at `http://localhost:7891`.
- **Zero or one** login per run for the whole `authz/` directory. The subject is shared
  across every spec in it and cached between processes, minted only when the cached one no
  longer authenticates — the same shape the superuser token already uses.

  A subject per file cost one login per file, so the directory's cost scaled with the number
  of FILES against a cap of five per minute per IP for the **whole machine**, which is
  exactly the wrong thing for it to scale with: three files meant a re-run inside the minute
  failed on the limiter rather than on anything about Langflow. The limiter counts every
  attempt, failed ones included — a polling loop probing with bad credentials spends it as
  fast as real work.

  The shared subject is reset before every test and deliberately **not deleted** at the end
  of a run; deleting it would cost a fresh login on the next one, which is the cost sharing
  it exists to avoid.
- No LLM provider and no network egress.

## Notes

The API key test authenticates with **no** `Authorization` header at all. Sending both would
let a passing result mean the bearer token did the work, which is the assertion inverted.
