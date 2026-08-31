# Enterprise — The RBAC Instance Enforces, and a Role Is What Changes the Answer

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

This is the foundation spec for the RBAC area: it proves the **instance variant** is what
it claims to be, so that every later authorization test is measuring the product rather
than a misconfigured container.

That is not a formality. An instance can report `authz_enabled: true` and still enforce
nothing — if superuser bypass is left on, the only account this lane has is exempt from
every check, and a whole deny matrix would pass against an instance that never denied
anything. The opposite miss is just as easy: with the RBAC bootstrap disabled, the instance
enforces against an empty assignment table, denies everything including the superuser, and
reads as a broken image rather than a missing flag.

So the spec asserts four things, in an order where each one makes the next meaningful:

1. **The instance is configured to enforce.** `authz_enabled` true, `superuser_bypass`
   **false**, a non-zero policy rule count, and the three built-in roles present. A rule
   count of zero would deny everything for a reason that has nothing to do with the test.
2. **A user with no role is denied a write** — and denied *before any side effect*. A `403`
   that still created the resource is not an authorization control, and nothing else in the
   suite would catch it, because the caller sees the same status either way.
3. **Assigning a role flips the same call to allowed.** This is the load-bearing pair: on
   its own, step 2 is equally consistent with "authorization works" and "this instance is
   broken". Only the flip separates them, and it separates them using the product's own
   mechanism rather than a second observation.
4. **The audit log records both outcomes**, with actor, action and result. An enforcement
   decision nobody can review afterwards is not auditable, and the deny is the entry an
   operator actually needs.

## The container variant

`LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh` starts it — a second container
on its own port with its own Postgres, not a mode switch on the existing one. RBAC is a
property of the database as much as of the process: the bootstrap writes role assignments
at startup, and there is no way back to an unenforced instance.

Two things the design notes for this area assumed, both **wrong** as measured on 1.12.0,
and both recorded here because they change how expensive this area is:

- **Redis is not required.** Policy invalidation resolves its URL to `None` when none is
  configured and stays `active` regardless; only multi-replica convergence needs one. The
  notes listed `LANGFLOW_AUTHZ_REDIS_URL` as part of the setup.
- **Three variables the notes omitted are load-bearing:**
  `LANGFLOW_AUTHZ_AUDIT_ENABLED`, `LANGFLOW_RBAC_BOOTSTRAP_ENABLED` and
  `LANGFLOW_RBAC_BOOTSTRAP_ADMIN_USERNAME`. The set the script uses is the product's own,
  taken from its air-gap certification harness rather than guessed.

## What was measured but is NOT asserted here

Deliberately left to the deny-matrix spec this one unblocks, so that a foundation test does
not fail for a reason belonging to a different question:

- **`viewer` and no-role are indistinguishable** for flow and project creation — both `403`.
  Only `developer` flips them.
- **Three distinct refusal messages**, which is a useful diagnostic and a separate axis:
  `Permission denied` (the RBAC resource check), `RBAC administrator role required` (the
  admin-route guard), and `Superuser required to administer roles.` — that last one means
  role administration is gated on *superuser*, not on the admin role.

## The owner override, and why every probe here names its destination

**Measured on the 2026-08-27 Enterprise build (#1635).** `flow:create` carries an **owner
override**: creating a flow in a project you own is allowed regardless of role, and the audit
log records the verdict as **`owner_override`** — a third value alongside `allow` and `deny`,
which the admin console's audit filter has always offered.

The consequence for this suite is larger than it sounds. Every spec in this directory probed
the resource guard with a bare `POST /api/v1/flows/`, and an omitted `folder_id`
**canonicalises to the caller's own project**. So on this build that call is answered by the
override for anybody, and four specs that read as "is this subject refused?" were measuring
something else entirely. They did not fail quietly — they failed loudly, which is the only
reason this was found.

Two corrections came out of it, and both make the coverage stronger than it was:

- **The probe names a destination.** `attemptFlowCreate` takes `folderId` as a **required**
  argument precisely so a caller cannot fall back to the override path by omission, the way
  every pre-#1635 call site did. Which project is "foreign" depends on who is being probed:
  the shared subject is probed against a project owned by the **superuser**, and the superuser
  against one owned by the **subject**. Getting that backwards is not hypothetical — the first
  version of the helper returned only the superuser's project, and the superuser's own probe
  then measured the override on itself.
- **The override is now asserted, not merely avoided.** A new test pins it as a *scoped rule*:
  the same subject, the same action, two destinations, two verdicts. Without that boundary,
  "a role-less user can create flows" is indistinguishable from "authorization is off", and a
  build that widened the override would look like a suite that had always passed.

The audit half of that test keys each verdict on `details.domain` — the project the decision
was reached in — rather than collecting results for the actor. The looser version **passed a
mutation that swapped `owner_override` for `allow`**, because a sibling test in the same file
produces an `allow` for the same actor and `arrayContaining` found it.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

`@authz` is new, and is the one case where the Enterprise plan's rule calls for a new
functional tag rather than reusing an OSS one: the OSS authorization service is
pass-through, so there is no OSS area for this to reuse.

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would
silently never run (#1010).

## Step by step *(required)*

Every test first requires an instance whose `authz/status` reports enforcement with bypass
off, skipping and naming the start command otherwise — the default Enterprise container
does **not** satisfy this, and running these assertions against it would report an
unenforced instance as a product defect.

1. **Configuration.** `GET /api/v1/authz/status` → `authz_enabled` true,
   `superuser_bypass` false, `policy_rule_count` > 0, built-in roles present.
2. **Deny with no side effect.** Create a user, log in as them, `POST /api/v1/flows/` →
   `403`; then read the flow list as the superuser and confirm nothing by that name exists.
3. **The flip.** Assign `developer` to the same user, repeat the identical call → `201`.
   Delete the flow it created.
4. **Audit.** `GET /api/v1/authz/audit` contains a `deny` and an `allow` for
   `flow:create` attributed to that user's id.
5. **Cleanup**, in reverse order: flow, role assignment, user.

## Validation criterion *(required)*

Fails when the RBAC instance does not enforce (bypass left on, no policy rules), when a
refusal is not a refusal (the resource exists anyway), when a granted role does not change
the outcome, or when the decision is not recorded.

## External dependencies *(required)*

- A Langflow **Enterprise** RBAC instance:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`, then point
  `PLAYWRIGHT_BASE_URL` at `http://localhost:7891`.
- Postgres, started by that script. The variant will not come up on SQLite, and the script
  fails rather than falling back.
- No LLM provider and no network egress.
- **One** login per test user created — a handful, well inside the per-IP budget, and the
  superuser token is the shared cached one.

## Notes

Test users are created and deleted by the spec. They log in without a forced rotation:
`must_change_password` is stamped on the env-bootstrapped superuser only, not on accounts
created through the users API.
