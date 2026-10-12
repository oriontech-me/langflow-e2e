# Enterprise — Inherited Access, and the Surfaces That Describe It

**Last validated:** Langflow Enterprise 1.13.0 (image built from `IBM-Langflow@bbbec5fb`, OSS `1e829663`)

---

## What this test validates *(required)*

A role assignment does not have to be global. `domain_type: "project"` with a `domain_id`
grants inside one project, and enforcement honours it for the flows that live there. That is
**inherited access**: the subject was never granted anything on the flow, and can still open
it.

Two questions follow. The 1.12 version of this spec concluded the second one exposed a
disagreement (#1532); measured on 1.13 it does not — the disagreement came from asking the
decision APIs in the wrong **domain**, and this spec now pins the question a client really asks.

**Does inheritance work, and is it revocable and role-graded?** Measured yes on all three
counts. This is the green half.

**Do the surfaces that DESCRIBE access agree with the one that ENFORCES it?** A client
renders from the descriptions, so a description that is confidently wrong is worse than one
that is missing. Asked in the project's domain, they agree.

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

### The descriptions, and the domain that decides them

With the subject holding project-scoped `developer` on that flow (measured on `bbbec5fb`):

| Surface | Answer |
|---|---|
| `GET /authz/resources/flow/{id}/inherited-access` | names it: `domain_type: "project"`, `role_name: "developer"`, `actions: ["read","write","execute"]` |
| `POST /authz/check`, `obj: "flow:<id>"`, `domain: "project:<pid>"` | `allowed: true`, `matched_policy: ["role:developer","*","flow:*","read"]` |
| `POST /authz/me/permissions`, `{resource_type: "flow", resource_ids: [id], domain: "project:<pid>"}` | `{"<flow-id>": ["read","write","execute","create"]}` |
| the same two **without** `domain` (it defaults to `*`) | `allowed: false`, `matched_policy: []` / `{"<flow-id>": []}` |

Both decision routes take a `domain`, documented as "typically `project:{folder_id}`", and the
product's own client sends exactly that (`PermissionsProvider`, `permissionsContext.tsx`).
Without it they answer the **global-domain** question — "does a grant over the whole instance
cover this?" — which for a project-scoped grant is correctly *no*. That is what #1532
measured: the parameter existed on 1.12 too, so this was never a disagreement, it was the
domain-shaped twin of the `flow:*`-versus-`flow:<id>` trap `deny-matrix-and-decision-api.md`
documents. This spec now asks both questions and pins both answers, so the trap is visible
rather than re-discovered.

### `deploy`, and why one cell is deliberately unasserted

| Role (project scope) | `inherited-access` `actions` | `POST /control-plane/deployments` |
|---|---|---|
| `viewer` | `["read","execute"]` | `403` `Permission denied` |
| `developer` | `["read","write","execute"]` | `503` `Control Plane deployment is not configured` |
| `admin` | `["read","write","execute","delete","deploy"]` | `503` |

`deploy` is a **flow** action. Asked about the project (`obj: "project:<pid>"`) it is denied
even to `admin`, which is what #1532 read as a contradiction; asked about a flow in the
project's domain (`obj: "flow:<id>"`, `domain: "project:<pid>"`) it is allowed, matching
`role:admin`, `flow:*`, `deploy` — the same answer `inherited-access` gives.

The deployment payload carries no `environment`. Since the 1.13 line environments are
registered (EE PR 457), and `environment: "production"` on an instance that has not registered
one answers `404 Unknown environment 'production'` — which still read as "not refused" and kept
the admin step green for the wrong reason. Without it the default environment is used and the
answer is the documented `503`.

**The `developer` cell is not asserted anywhere.** With no control plane configured a `503`
cannot be distinguished from "authorization passed, and a configured plane would re-check
per flow", so asserting it would pin whichever reading happened to be convenient — and
would go red on an upstream tightening that is arguably the fix. What is asserted is the two
ends, where the answer is unambiguous: `viewer` and a role-less user are refused by
authorization, and `admin` is not.

## Note — the deployment payload gained `slug` (#1635)

On the 2026-08-27 Enterprise build `POST /api/v1/control-plane/deployments` requires a `slug`
(still true on 1.13).
Without it FastAPI answers **`422` before authorization runs** — for the superuser too — so the
request never reaches the verdict this spec exists to observe, and the gate test failed for a
payload reason wearing an authorization failure's clothes. With `slug` present the measured
answers are unchanged: role-less `403 Permission denied`, superuser `503 Control Plane
deployment is not configured`.

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: there is no scheduled Enterprise lane, so a `@stable` test here would silently
never run (#1010).

## Step by step *(required)*

All tests gate on an enforcing instance (`authz_enabled` true, `superuser_bypass` false),
skipping and naming the start command otherwise. A project and one flow inside it are
created by the superuser in `beforeAll` and deleted in `afterAll`.

**Test 1 — inheritance is real, graded and revocable.** Probe with no role, then with
project-scoped `viewer`, then `developer`, then with the assignment deleted, asserting the
table above at each step.

**Test 2 — `inherited-access` names the grant, and does not leak it.** With the subject
holding project-scoped `developer`: `GET /authz/resources/flow/{id}/inherited-access` lists an
entry for the subject carrying the scope, the role and the actions. Asked by the **subject**,
the same route answers `404` with `detail` **`Resource not found`** — asserted by detail, not
only by status: the 1.12 route `/authz/flows/{id}/inherited-access` was removed with no alias
(EE PR 355), and a removed route also answers `404` (`Not Found`), so a status-only assertion
passed against a route that no longer existed. Since 1.13 the resource's **owner** is
excluded from the list (ownership is not a role-derived grant), so the superuser no longer
appears in it.

**Test 3 — the deployment gate refuses the two unambiguous ends.** `viewer` and role-less →
`403 Permission denied`; `admin` → not a `403`, and not a `4xx` naming the payload either (an
unregistered environment's `404` would otherwise pass as "not refused"). The response for
`admin` is asserted as "not refused by authorization" rather than as `503`, so a configured
control plane would not turn this test red.

**Test 4 — the decision APIs agree with enforcement, in the project's domain.** With the
subject holding project-scoped `developer` and enforcement answering `200` to both `GET` and
`PATCH`: `check` with `obj: "flow:<id>"`, `domain: "project:<pid>"` → `allowed: true` and
`matched_policy` names `role:developer`; `me/permissions` with the same `domain` reports `read`
and `write`. The same two questions in the global domain answer `false` / `[]` — asserted,
because that is the correct answer to the question a mis-encoded client would be asking, and
the pair is what makes the trap visible.

**Test 5 — the model does not contradict itself about deploy.** With project-scoped `admin`,
`inherited-access` lists `deploy`; `check` with `obj: "flow:<id>"`, `act: "deploy"`, `domain:
"project:<pid>"` → `allowed: true`. And `check` on `obj: "project:<pid>"` → `allowed: false`,
because `deploy` is a flow action — asserted so a reader does not re-file it as a contradiction.

## Validation criterion *(required)*

Tests 1–3 fail when inheritance stops working, stops being graded by role, survives
revocation, when `inherited-access` misreports or leaks the grant (or its route moves again),
or when the deployment route stops refusing a viewer.

Tests 4 and 5 fail when a decision API stops agreeing with enforcement about an inherited
grant in the project's domain, or when the global-domain answer changes meaning — either way a
client rendering from it would show the wrong controls.

## External dependencies *(required)*

- The Enterprise RBAC variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`,
  with `PLAYWRIGHT_BASE_URL` pointed at `http://localhost:7891`. On the 1.13 line the script
  sets `LANGFLOW_ENTERPRISE_ALLOW_UNLICENSED_TIER_GATES=true` — project, user and
  control-plane routes answer `503` without a licence (#2259).
- **Zero or one** login per run — the directory's shared subject and the cached superuser
  token. The five-per-minute per-IP login limit is why the whole matrix is one principal
  walked through states.
- No LLM provider, no network egress. No control plane: the deployment route is expected to
  be unconfigured, and the spec is written so that configuring one would not redden it.

## Notes

`inherited-access` is asserted by **membership**, never by list length: anything else the
container happens to carry is in that list too.

Cross-replica convergence — the fourth item in the § 22.6 line this closes — stays `[ ]`.
It needs Redis and a second replica: without one, `invalidation.listener_connected` is
`false` while the policy still resolves `active`, so a single-container assertion would
measure nothing.
