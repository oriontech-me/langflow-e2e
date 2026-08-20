# Enterprise — Inherited Access, and the Surfaces That Describe It

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

A role assignment does not have to be global. `domain_type: "project"` with a `domain_id`
grants inside one project, and enforcement honours it for the flows that live there. That is
**inherited access**: the subject was never granted anything on the flow, and can still open
it.

Two questions follow, and the second is where this instance disagrees with itself.

**Does inheritance work, and is it revocable and role-graded?** Measured yes on all three
counts. This is the green half.

**Do the surfaces that DESCRIBE access agree with the one that ENFORCES it?** Three of them
answer the same question three ways. A client renders from the descriptions, so a
description that is confidently wrong is worse than one that is missing.

### Enforcement, measured

Subject is the directory's shared user, walked through states. The flow is owned by the
superuser and lives inside a project the superuser created.

| Subject state | `GET` the flow | `PATCH` the flow |
|---|---|---|
| no role | `404` | `404` |
| `viewer` scoped to the project | `200` | `403` |
| `developer` scoped to the project | `200` | `200` |
| assignment deleted | `404` | `404` |

Same shape as the global matrix in `deny-matrix-and-decision-api`, which is the point:
inheritance is not a weaker grant, it is the same grant reached through the project. And
forbidden stays indistinguishable from absent — both `404`.

### The three descriptions

With the subject holding project-scoped `developer` on that flow:

| Surface | Answer |
|---|---|
| `GET /authz/flows/{id}/inherited-access` | names it: `domain_type: "project"`, `role_name: "developer"`, `actions: ["read","write","execute"]` |
| `POST /authz/check`, `obj: "project:<pid>"` | `allowed: true`, `matched_policy` names `role:developer` |
| `POST /authz/check`, `obj: "flow:<id>"` | `allowed: false`, `matched_policy: []` |
| `POST /authz/me/permissions`, `{resource_type: "flow", resource_ids: [id]}` | `{"<flow-id>": []}` |

The last row is the finding (#1532). `obj` in `check` is a casbin **pattern**, so an empty
`matched_policy` there is ordinarily the signal that the question matched nothing — the trap
`deny-matrix-and-decision-api.md` documents at length, and which fabricated two findings
while that spec was written. `me/permissions` takes **no pattern**: a resource type and a
list of ids, which is exactly how a client asks. It answers `[]` for a flow the same subject
can `PATCH`.

Nor is it "direct grants only" by design — the deny-matrix spec already asserts
`me/permissions` returns `["read"]` for a flow reached through a **share**, which is not
ownership either. Project inheritance is the gap.

### `deploy`, and why one cell is deliberately unasserted

| Role (project scope) | `inherited-access` `actions` | `check` on `project:<pid>` | `POST /control-plane/deployments` |
|---|---|---|---|
| `viewer` | `["read","execute"]` | read | `403` `Permission denied` |
| `developer` | `["read","write","execute"]` | read, write | `503` `Control Plane deployment is not configured` |
| `admin` | `["read","write","execute","delete","deploy"]` | read, write, delete — **`deploy: false`** | `503` |

`inherited-access` grants `execute` to every role and `deploy` to `admin`; `check` denies
`execute` to all three and `deploy` even to `admin`. The route is coarser than either.

**The `developer` cell is not asserted anywhere.** With no control plane configured a `503`
cannot be distinguished from "authorization passed, and a configured plane would re-check
per flow", so asserting it would pin whichever reading happened to be convenient — and
would go red on an upstream tightening that is arguably the fix. What is asserted is the two
ends, where the answer is unambiguous: `viewer` and a role-less user are refused by
authorization, and `admin` is not.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010). The two red tests below could not carry it in any case.

## Step by step *(required)*

All tests gate on an enforcing instance (`authz_enabled` true, `superuser_bypass` false),
skipping and naming the start command otherwise. A project and one flow inside it are
created by the superuser in `beforeAll` and deleted in `afterAll`.

**Test 1 — inheritance is real, graded and revocable.** Probe with no role, then with
project-scoped `viewer`, then `developer`, then with the assignment deleted, asserting the
table above at each step.

**Test 2 — `inherited-access` names the grant, and does not leak it.** With the subject
holding project-scoped `developer`: the endpoint lists an entry for the subject carrying the
scope, the role and the actions, alongside the superuser's own global admin entry. Asked by
the **subject**, the same endpoint answers `404 Resource not found` — the endpoint is
superuser-scoped and does not confirm the flow's existence to the user it describes.

**Test 3 — the deployment gate refuses the two unambiguous ends.** `viewer` and role-less →
`403 Permission denied`; `admin` → not a `403`. The response for `admin` is asserted as
"not refused" rather than as `503`, so a configured control plane would not turn this test
red.

**Test 4 (EXPECTED RED, #1532) — the decision APIs agree with enforcement.** With the
subject holding project-scoped `developer` and enforcement answering `200` to both `GET` and
`PATCH`: `check` with `obj: "flow:<id>"` should be `allowed: true`, and `me/permissions`
should report `read` and `write` for that flow. Both currently answer empty.

**Test 5 (EXPECTED RED, #1532) — the model does not contradict itself.** `check` on the
project should allow `deploy` for `admin`, which `inherited-access` lists among its actions.
It currently answers `false`.

## Validation criterion *(required)*

Tests 1–3 fail when inheritance stops working, stops being graded by role, survives
revocation, when `inherited-access` misreports or leaks the grant, or when the deployment
route stops refusing a viewer.

Tests 4 and 5 fail **today, by design**, and are the assertion of the behaviour #1532 asks
the product to choose. They turn green when a client can trust the decision API about an
inherited grant. If the product decides the decision API answers only non-inherited grants,
this spec changes to assert that — the spec doc changes first.

## External dependencies *(required)*

- The Enterprise RBAC variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`,
  with `PLAYWRIGHT_BASE_URL` pointed at `http://localhost:7891`.
- **Zero or one** login per run — the directory's shared subject and the cached superuser
  token. The five-per-minute per-IP login limit is why the whole matrix is one principal
  walked through states.
- No LLM provider, no network egress. No control plane: the deployment route is expected to
  be unconfigured, and the spec is written so that configuring one would not redden it.

## Notes

`GET /authz/flows/{id}/inherited-access` is asserted by **membership**, never by list
length: the superuser's own global admin assignment is in that list, and so is anything else
the container happens to carry.

Cross-replica convergence — the fourth item in the § 22.6 line this closes — stays `[ ]`.
It needs Redis and a second replica: without one, `invalidation.listener_connected` is
`false` while the policy still resolves `active`, so a single-container assertion would
measure nothing.
