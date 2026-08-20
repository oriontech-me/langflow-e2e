# Enterprise — The Deny Matrix, and the Decision API That Must Agree With It

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

Two questions that only make sense together.

**What does each subject actually get?** `rbac-instance-baseline` proved the instance
enforces at all, using one deny and one grant. This spec is the matrix: what a role-less
user, a viewer, a developer, an admin, a user holding a direct share, and a user whose
access was revoked each receive from the same routes.

**Does the decision API agree?** `POST /api/v1/authz/check` is what a client asks when it
wants to render or hide something. A decision API that drifts from enforcement is worse
than none: it is confidently wrong, and every client inherits the error.

### The verdict table, measured

Subject is one user walked through states. The resource is a flow owned by the superuser.

| Subject state | `GET` other's flow | `GET` missing id | `PATCH` other's flow | flow in its listing |
|---|---|---|---|---|
| no role | `404` | `404` | `404` | no |
| viewer | `200` | `404` | `403` | yes |
| developer | `200` | `404` | `200` | yes |
| admin | `200` | `404` | `200` | yes |
| no role + direct share (`read`) | `200` | `404` | `403` | yes |
| revoked (roles removed, share deleted) | `404` | `404` | `404` | no |

Three things this table says that a narrower test would miss:

- **Forbidden and absent are indistinguishable.** A flow the subject may not see and a flow
  that does not exist both answer `404`. That is the correct behaviour and the one worth
  pinning: a `403` here would confirm the resource exists to somebody who may not know it,
  which is an existence leak that costs nothing to introduce and nothing to notice.
- **`viewer` is not `developer`.** They are identical on *creation* — both refused — and
  differ on modifying an existing resource, `403` against `200`. A matrix built only from
  create calls would report the two roles as the same thing.
- **Revocation is real, in both flavours.** Removing the role assignments and deleting the
  share each return the subject to the no-access row. A grant that cannot be taken back is
  not a grant.

### The object pattern chooses the question

`check` takes `{user_id, obj, act}`, and `obj` is a **casbin object pattern**, not a
resource type. That distinction is the whole reason this spec exists in the form it does,
because getting it wrong produces a confident, plausible, entirely fabricated finding —
which happened twice while measuring this, and both times looked like a product defect:

| `obj` | Answers | For a role-less subject holding a read share |
|---|---|---|
| `flow` | nothing — no pattern matches | `allowed: false`, `matched_policy: []` |
| `flow:*` | may you read flows *in general* (role policy) | `allowed: false` — correct |
| `flow:<id>` | may you read *this* flow (roles **and** shares) | `allowed: true`, matched `['user:<uid>', '*', 'flow:<id>', 'read']` |

So `check` **does** agree with enforcement — when asked the resource-scoped question. The
`flow:*` answer is not a disagreement, it is a different question with a correct answer,
and a client that asks the general question about a specific resource will hide things its
user can open.

**An unknown pattern is denied, not rejected.** `obj: "banana:*"` answers `200` with
`allowed: false` and an empty `matched_policy`. Failing closed on a typo is right; the cost
is that a client with a malformed pattern is told "denied" rather than "you asked wrong",
so the empty `matched_policy` is the only signal that the question never matched anything.
The spec asserts that distinction, because it is what separates a real deny from a
mis-encoded one.

`POST /api/v1/authz/me/permissions` is the other decision route and answers the
resource-scoped question by design, returning `{"<flow-id>": ["read"]}` for the shared case.
It is asserted alongside `check` so the two cannot drift apart unnoticed.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would
silently never run (#1010).

## Step by step *(required)*

Both tests gate on an instance that enforces (`authz_enabled` true, `superuser_bypass`
false), skipping and naming the start command otherwise.

**The matrix.** The shared subject, walked through states with `test.step`:

1. Superuser creates the flow the subject will not own.
2. No role → the four probes above.
3. Assign `viewer`, then `developer`, then `admin`, re-probing after each.
4. Remove every assignment → back to the no-access row.
5. Superuser shares the flow with `scope: "user"`, `permission_level: "read"` → readable but
   not writable.
6. Delete the share → back to the no-access row.
7. Cleanup: share and flow here; the subject is reset by `beforeEach` and deleted once in
   `afterAll`.

**The decision API.** The same subject, reset to no role, holding only a read share:

1. `GET` the shared flow → `200`, the ground truth.
2. `check` with `obj: "flow:<id>"` → `allowed: true`, and `matched_policy` names the share.
3. `check` with `obj: "flow:*"` → `allowed: false` — the general question, correctly answered.
4. `check` with an unknown pattern → `allowed: false` **and** an empty `matched_policy`,
   which is what distinguishes a mis-encoded question from a real refusal.
5. `me/permissions` for that flow → `["read"]`.

## Validation criterion *(required)*

The matrix fails when a subject receives more or less than its row, when a forbidden
resource becomes distinguishable from an absent one, or when a revoked grant survives.

The decision API fails when it disagrees with what the endpoints enforce for the same
resource-scoped question, or when a mis-encoded pattern stops being distinguishable from a
genuine refusal.

## External dependencies *(required)*

- The Enterprise RBAC variant:
  `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`, with
  `PLAYWRIGHT_BASE_URL` pointed at `http://localhost:7891`.
- **Zero or one** login per run for the whole `authz/` directory. The matrix rows are states
  of the same principal rather than different principals, so walking one subject costs one
  login instead of six — and that subject is shared across every spec in the directory and
  cached between processes, so the cost no longer scales with the number of files.

  The budget is five logins per minute **per IP for the whole machine**, and it counts every
  attempt including failed ones — a detail that matters while debugging, since a polling loop
  probing with bad credentials consumes it just as fast as real work.
- No LLM provider and no network egress.

## Notes

Every resource is created by the spec and deleted by it, in dependency order, from a
`finally` that never throws — a cleanup error after a failed assertion would replace the
real failure with a derived one.

One assertion is deliberately a membership test rather than a count: whether the flow under
test appears in the subject's listing, not how long that listing is. The first version
asserted the size and broke the moment the instance carried another flow, which meant it
was measuring how much unrelated state the container held rather than what the subject may
see.
