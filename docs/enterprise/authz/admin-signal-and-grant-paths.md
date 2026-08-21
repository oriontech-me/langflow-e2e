# Enterprise — The Admin Signal a Client Renders From, and the Second Grant Path

**Last validated:** Langflow Enterprise 1.12.0 (image built from `IBM-Langflow@release-1.12.0`)

---

## What this test validates *(required)*

**Does the signal the UI gates on agree with enforcement?** `GET /authz/me/rbac-admin`
answers `{is_rbac_admin: bool}`, and a client uses it to render or hide the RBAC admin
screens. A false `true` shows a user screens whose every call answers `403`; a false `false`
hides screens an administrator is entitled to. Neither is visible to any test that only
exercises the routes themselves.

**Do the two grant paths converge?** Roles can be assigned through
`POST /authz/role-assignments` (by role **id**) and through `POST /authz/users/{id}/roles`
(by role **name**). Two writers onto one model is how they drift — one honouring a scope the
other ignores, or one bypassing the guard the other enforces.

**Which guard sits on which route?** #1531 established that this instance has distinct
guards with distinct messages. The admin twins of covered routes sit behind the
**admin-role** guard, while the policy and SIEM routes sit behind the **superuser** guard.
Adjacent routes, different gates, and nothing re-checks it on these ones.

### Measured

| Subject state | `me/rbac-admin` | `GET /authz/admin/users` |
|---|---|---|
| no role | `{"is_rbac_admin": false}` | `403 RBAC administrator role required` |
| global `admin` | `{"is_rbac_admin": true}` | `200` |
| assignment revoked | `{"is_rbac_admin": false}` | `403` again |

The signal tracks the route in both directions, including back down — which is the half a
"grant then check" test would miss.

| Grant path | Result |
|---|---|
| `POST /authz/users/{id}/roles` `{role_name: "viewer", domain_type: "global"}` as superuser | `201`, body carries `assignment_id`, `role_name`, `domain_type` |
| that `assignment_id` in `GET /authz/admin/role-assignments` | present — the two paths write one model |
| that `assignment_id` in `GET /authz/role-assignments` | **absent**, and correctly so — see below |
| `DELETE /authz/role-assignments/{assignment_id}` | `204` — one object, addressable through either route |
| the same call by the subject, granting **itself** `admin` | `403 Superuser required for authz admin endpoints` |

### The two listings are scoped differently, and getting it wrong fails silently

`GET /authz/role-assignments` returns the **caller's own** assignments;
`GET /authz/admin/role-assignments` returns **every** assignment on the instance, behind the
admin-route guard. Nothing in the response shape says which one you are holding.

The failure direction is the bad one. Granting a role to somebody else and then looking for
it in the caller-scoped listing returns an empty result, which reads as *the grant did not
land* — the first version of this test asserted exactly that and failed against a working
product. Worse, a cleanup loop built on the same listing cannot see what it is meant to
revoke: measured, that left a test subject's assignment behind on the shared instance, and
nothing reported it. The helper for the caller-scoped listing now says so in its own
docstring, and `readAllRoleAssignments` exists for the other one.

| Route | Guard |
|---|---|
| `GET /authz/admin/role-assignments` | `403 RBAC administrator role required` |
| `GET /authz/admin/assignment-scopes` | `403 RBAC administrator role required` |
| `GET /authz/siem/status` | `403 Superuser required for authz admin endpoints` |

## Tags *(required)*

`@enterprise` `@api` `@regression` `@authz`

No `@stable`: no scheduled Enterprise lane (#1010).

## Step by step *(required)*

Gates on an enforcing instance and uses the directory's shared subject.

**Test 1 — the signal tracks the route.** Read `me/rbac-admin` and the admin route with no
role, then with a global `admin` assignment, then after revoking it. The pair is asserted at
each of the three points, so a signal that is merely *sticky* fails.

**Test 2 — the second grant path converges and cannot escalate.** Grant `viewer` by name as
the superuser; assert the returned `assignment_id` appears in `role-assignments`; then have
the subject attempt to grant itself `admin` through the same route and assert the superuser
guard refuses it, by message.

**Test 3 — the admin twins are behind the admin guard, and the operator routes behind the
superuser guard.** Asserted by message, not only by status: all four answer `403`, and the
whole point is which of the two refusals each one gives.

## Validation criterion *(required)*

Fails when `me/rbac-admin` disagrees with the admin route in either direction, when the two
grant paths stop converging on one assignment, when the name-keyed path lets a subject grant
itself anything, or when a route moves between the admin-role and superuser guards without
that being noticed.

## External dependencies *(required)*

- The Enterprise RBAC variant: `LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`,
  `PLAYWRIGHT_BASE_URL` at `http://localhost:7891`.
- Zero or one login per run — shared subject plus cached superuser token.
- No LLM provider, no network egress.

## Notes

Test 2 cleans up by id: the assignment created through the name-keyed path is deleted through
`role-assignments`, which is also the assertion that the two paths address the same object.

`domain_type` is passed explicitly even though the API defaults it. A grant that silently
became instance-wide because the field was omitted is the failure direction that matters, and
the explicit value makes the test's intent readable next to the project-scoped grants in
`inherited-access-and-deploy`.
