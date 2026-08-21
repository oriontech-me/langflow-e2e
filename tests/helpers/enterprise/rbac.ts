import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";

/**
 * Helpers for the Enterprise RBAC instance variant.
 *
 * The variant is a SECOND container — `LANGFLOW_EE_RBAC=1
 * ./scripts/start-langflow-enterprise.sh`, on its own port with its own
 * Postgres — rather than a mode switch on the default Enterprise one. RBAC is a
 * property of the database as much as of the process: the bootstrap writes role
 * assignments at startup and there is no way back to an unenforced instance.
 */

export interface AuthzStatus {
  authz_enabled?: boolean;
  superuser_bypass?: boolean;
  policy_rule_count?: number;
  assignment_count?: number;
  builtin_roles?: string[];
}

export interface RbacUser {
  id: string;
  username: string;
  password: string;
  /** A bearer header for this user, ready to pass as `Authorization`. */
  auth: string;
}

/** Accounts this helper creates. Long enough to satisfy the EE minimum. */
const TEST_USER_PASSWORD = "RbacProbe123!";

export async function readAuthzStatus(
  request: APIRequestContext,
  auth: string,
): Promise<AuthzStatus> {
  const response = await request.get("/api/v1/authz/status", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as AuthzStatus;
}

/**
 * Skip unless this instance actually enforces authorization.
 *
 * Both halves matter and the second is the one that gets forgotten. An instance
 * can report `authz_enabled: true` and enforce nothing for this lane, because
 * superuser bypass exempts the only account it has — a whole deny matrix would
 * then pass against an instance that never denied anything. So the gate reads
 * both, and skips rather than fails: the default Enterprise container does not
 * satisfy this, and "you pointed me at the other container" is a statement about
 * the environment, not about Langflow.
 */
export async function requireRbacInstance(
  request: APIRequestContext,
  auth: string,
): Promise<AuthzStatus> {
  const status = await readAuthzStatus(request, auth);

  test.skip(
    status.authz_enabled !== true || status.superuser_bypass !== false,
    `This instance reports authz_enabled=${status.authz_enabled}, ` +
      `superuser_bypass=${status.superuser_bypass} — it does not enforce ` +
      `authorization for this lane's account, so every assertion here would ` +
      `pass or fail for a reason unrelated to the product. Start the RBAC ` +
      `variant with: LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh ` +
      `(then point PLAYWRIGHT_BASE_URL at it, default http://localhost:7891)`,
  );

  return status;
}

/**
 * Skip unless this instance is the BYPASS variant.
 *
 * The mirror of `requireRbacInstance`, and the two are deliberately exclusive:
 * no instance can satisfy both, so the A/B they form is two runs rather than one
 * parameterised test. `LANGFLOW_EE_BYPASS=1` differs from the RBAC variant in
 * exactly one knob, which is what lets a difference in the answers be attributed
 * to the knob.
 *
 * Skips rather than fails for the same reason the sibling gate does: "you
 * pointed me at the other container" is a statement about the environment.
 */
export async function requireBypassInstance(
  request: APIRequestContext,
  auth: string,
): Promise<AuthzStatus> {
  const status = await readAuthzStatus(request, auth);

  test.skip(
    status.authz_enabled !== true || status.superuser_bypass !== true,
    `This instance reports authz_enabled=${status.authz_enabled}, ` +
      `superuser_bypass=${status.superuser_bypass} — this test measures what the ` +
      `bypass switches, which only an instance that HAS it on can answer. Start ` +
      `the bypass variant with: LANGFLOW_EE_BYPASS=1 ` +
      `./scripts/start-langflow-enterprise.sh (then point PLAYWRIGHT_BASE_URL at ` +
      `it, default http://localhost:7892). Note it does not fit beside the RBAC ` +
      `container on a small Docker VM — stop that one first.`,
  );

  return status;
}

/**
 * Skip unless this instance can serve the Access Control screen.
 *
 * Deliberately WEAKER than `requireRbacInstance`, and the difference is the
 * point: that gate also demands `superuser_bypass: false`, because a deny matrix
 * measured through an exempt account measures nothing. This screen is an
 * operator surface, not an enforcement one — what it needs is authorization
 * turned on (so roles and assignments exist at all) and a caller the instance
 * considers an RBAC administrator, which is the flag the frontend itself gates
 * the page on (`GET /authz/me/rbac-admin`). Demanding the bypass be off as well
 * would skip the spec on instances that render the screen perfectly well.
 *
 * Reads the flag through the same endpoint the page does, rather than inferring
 * it from `assignment_count` or from the account being a superuser: those agree
 * today and are not the contract.
 */
export async function requireAuthzAdminUi(
  request: APIRequestContext,
  auth: string,
): Promise<AuthzStatus> {
  const status = await readAuthzStatus(request, auth);

  test.skip(
    status.authz_enabled !== true,
    `This instance reports authz_enabled=${status.authz_enabled} — with ` +
      `authorization off there are no roles or assignments for the screen to ` +
      `show, so every assertion here would pass or fail for a reason unrelated ` +
      `to the product. Start the RBAC variant with: LANGFLOW_EE_RBAC=1 ` +
      `./scripts/start-langflow-enterprise.sh (then point PLAYWRIGHT_BASE_URL at ` +
      `it, default http://localhost:7891)`,
  );

  const admin = await isRbacAdmin(request, auth);
  test.skip(
    !admin,
    `GET /authz/me/rbac-admin reports is_rbac_admin=false for this lane's ` +
      `account. The Access Control screen is gated on that flag, so it would ` +
      `render nothing to assert on. Grant the account the global admin role, or ` +
      `use an instance whose bootstrap does.`,
  );

  return status;
}

/**
 * Run one API call, re-dialling ONCE if the request fails at the transport layer.
 *
 * `socket hang up` / `ECONNRESET` is the class this repo's own tooling treats as
 * an environment abort rather than as a verdict (the pipeline records such runs
 * `infra-void` and re-runs them). Observed on this lane against a container that
 * never restarted, never OOM-killed anything (`oom_kill 0` in its cgroup, no
 * memory limit) and logged nothing — so the cause sits below the application and
 * outside what a spec can assert about. It is load-dependent: 10 consecutive
 * local runs never reproduced it while a loaded machine hit it on the first.
 *
 * It matters because `expect.poll` PROPAGATES a throw from its poller. A poll
 * written to tolerate timing cannot tolerate the one error that actually shows
 * up, so the run dies on a dropped connection instead of re-reading a moment
 * later.
 *
 * Deliberately narrow, so nothing here softens an assertion: only a THROWN
 * request is retried, and only once. A response that arrived carrying a non-2xx
 * is a statement about the product and is passed straight through.
 */
export async function retryOnDroppedConnection<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/socket hang up|ECONNRESET|ECONNREFUSED|EPIPE|socket disconnected/i.test(message)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await call();
  }
}

export interface RoleAssignment {
  id: string;
  user_id: string;
  role_id: string;
  domain_type: string;
  domain_id?: string | null;
}

/**
 * The CALLER'S OWN role assignments — not the instance's.
 *
 * The scoping is easy to get wrong and fails silently in the worst direction:
 * granting a role to somebody else and then looking for it here returns an empty
 * result, which reads as "the grant did not land". It also means a cleanup loop
 * built on this listing cannot see what it is meant to revoke — measured, that
 * leaked an assignment for a test subject onto a shared instance. Use
 * `readAllRoleAssignments` for anything about another principal.
 */
export async function readRoleAssignments(
  request: APIRequestContext,
  auth: string,
): Promise<RoleAssignment[]> {
  const response = await request.get("/api/v1/authz/role-assignments", {
    headers: { Authorization: auth },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as RoleAssignment[];
}

/**
 * EVERY role assignment on the instance, from the admin listing.
 *
 * Behind the admin-route guard (`RBAC administrator role required`), unlike the
 * caller-scoped listing above, which any authenticated user may read for itself.
 */
export async function readAllRoleAssignments(
  request: APIRequestContext,
  auth: string,
): Promise<RoleAssignment[]> {
  // Wrapped rather than left bare because this read is what the UI spec polls
  // after driving the screen, and a dropped connection there aborted the poll.
  // The wrapper retries only a THROWN request — the status assertion below is
  // untouched, so a real refusal still fails here as it always did.
  const response = await retryOnDroppedConnection(() =>
    request.get("/api/v1/authz/admin/role-assignments", {
      headers: { Authorization: auth },
    }),
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as RoleAssignment[];
}

/**
 * Re-create assignments that were deleted, and prove the restore landed.
 *
 * Only one spec strips the lane's own principal, and only because "is the
 * superuser subject to policy" cannot be asked of a superuser that holds the
 * global `admin` role. Restoring is therefore not cleanup, it is the difference
 * between one test and every test after it — so it is asserted, not attempted,
 * and it lives here so a second caller cannot re-derive it more loosely.
 */
export async function restoreRoleAssignments(
  request: APIRequestContext,
  auth: string,
  assignments: RoleAssignment[],
): Promise<void> {
  for (const assignment of assignments) {
    const response = await request.post("/api/v1/authz/role-assignments", {
      headers: { Authorization: auth },
      data: {
        user_id: assignment.user_id,
        role_id: assignment.role_id,
        domain_type: assignment.domain_type,
        domain_id: assignment.domain_id ?? null,
      },
    });
    expect(
      response.status(),
      `Restoring role assignment ${assignment.role_id} for ${assignment.user_id} ` +
        `answered ${response.status()}: ${await response.text()}. The instance is ` +
        `now left with a principal that has fewer grants than it started with, ` +
        `which will fail every later authorization test for the wrong reason.`,
    ).toBe(201);
  }
}

/** The built-in roles, by name. Measured: viewer, developer, admin. */
export async function builtinRoleIds(
  request: APIRequestContext,
  auth: string,
): Promise<Record<string, string>> {
  const response = await request.get("/api/v1/authz/roles", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  const roles = (await response.json()) as { id: string; name: string }[];
  return Object.fromEntries(roles.map((role) => [role.name, role.id]));
}

/** A custom role, as this file creates them. */
export interface CustomRole {
  id: string;
  name: string;
}

/**
 * Create a custom role and return it.
 *
 * `permissions` defaults to empty: the callers here need a row of the CUSTOM
 * kind, not a role that grants anything, and an empty permission set keeps the
 * role inert if a failed cleanup ever leaves it behind. A caller that needs
 * grants passes them.
 */
export async function createCustomRole(
  request: APIRequestContext,
  auth: string,
  name: string,
  permissions: string[] = [],
): Promise<CustomRole> {
  const response = await request.post("/api/v1/authz/roles", {
    headers: { Authorization: auth },
    data: { name, description: "Created by the E2E suite.", permissions },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as CustomRole;
  return { id: body.id, name: body.name };
}

/**
 * `PATCH /authz/roles/{id}`, returned RAW.
 *
 * Half of what this route is worth asserting on is its refusal — a system role
 * answers `400 {"detail":"System roles cannot be modified"}` — and a helper that
 * expected 200 could not express that.
 */
export function patchRole(
  request: APIRequestContext,
  auth: string,
  roleId: string,
  data: Record<string, unknown>,
) {
  return request.patch(`/api/v1/authz/roles/${roleId}`, {
    headers: { Authorization: auth },
    data,
  });
}

/** `DELETE /authz/roles/{id}`, returned RAW, for the same reason as `patchRole`. */
export function deleteRoleRaw(request: APIRequestContext, auth: string, roleId: string) {
  return request.delete(`/api/v1/authz/roles/${roleId}`, {
    headers: { Authorization: auth },
  });
}

/** Best-effort role removal for cleanup — a role already gone is not a failure. */
export async function deleteRole(
  request: APIRequestContext,
  auth: string,
  roleId: string,
): Promise<void> {
  await deleteRoleRaw(request, auth, roleId).catch(() => undefined);
}

/**
 * Revoke every assignment `userId` holds, read from the ADMIN listing.
 *
 * The listing matters: the caller-scoped one returns the caller's own grants, so
 * a sweep built on it silently revokes nothing for anybody else — measured, that
 * is how an assignment for a test subject was leaked onto a shared instance.
 *
 * Reading rather than tracking ids is what makes this usable for cleanup after a
 * grant the SCREEN created: the test never learns that id unless it succeeds at
 * reading it back, and the run that dies before then is exactly the one that
 * needs the sweep. Never point it at the lane's own superuser — it holds the
 * global admin role every later test depends on.
 */
export async function revokeAssignmentsFor(
  request: APIRequestContext,
  auth: string,
  userId: string,
): Promise<number> {
  const assignments = await readAllRoleAssignments(request, auth);
  const mine = assignments.filter((assignment) => assignment.user_id === userId);
  for (const assignment of mine) {
    await request
      .delete(`/api/v1/authz/role-assignments/${assignment.id}`, {
        headers: { Authorization: auth },
      })
      .catch(() => undefined);
  }
  return mine.length;
}

/**
 * Create a user and return it already logged in.
 *
 * Accounts created through the users API are NOT subject to the forced rotation
 * EE stamps on the env-bootstrapped superuser, so this is one login and no
 * password-change dance. Each call spends one unit of the per-IP login budget;
 * callers state how many they spend in their spec doc.
 */
export async function createRbacUser(
  request: APIRequestContext,
  auth: string,
  prefix: string,
): Promise<RbacUser> {
  const username = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const created = await request.post("/api/v1/users/", {
    headers: { Authorization: auth },
    data: { username, password: TEST_USER_PASSWORD },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const login = await request.post("/api/v1/login", {
    form: { username, password: TEST_USER_PASSWORD },
  });
  // Named before it is asserted. A 429 here is the per-IP limiter, not the
  // product, and left unlabelled it surfaces as a status mismatch inside
  // whatever step happens to run next — the environment-red wearing product-red
  // clothing this lane is most exposed to. Measured: 5 logins per minute for the
  // whole machine, which is why this spec creates ONE user rather than one per
  // test.
  if (!login.ok()) {
    // Atomic or nothing. The user exists by now, and throwing here would leak
    // it — which is exactly what happened: a 429 on this line left an account
    // behind on every affected run, because the caller's try/finally has not
    // been entered yet. Delete before reporting, so a failure to build the
    // fixture leaves the instance as it was found.
    await request
      .delete(`/api/v1/users/${id}`, { headers: { Authorization: auth } })
      .catch(() => undefined);

    if (login.status() === 429) {
      throw new Error(
        `Login for '${username}' was rate-limited (429). EE allows 5 logins per ` +
          `minute per IP for the whole machine, and it counts EVERY attempt, ` +
          `failed ones included. This lane's cached superuser token plus each ` +
          `created user share that budget. Wait out the window (~60s) and ` +
          `re-run; if it persists, another process is authenticating against ` +
          `the same instance.`,
      );
    }
    throw new Error(
      `Login for the newly created '${username}' answered ${login.status()}: ` +
        `${(await login.text()).slice(0, 200)}`,
    );
  }
  const { access_token } = (await login.json()) as { access_token: string };

  return { id, username, password: TEST_USER_PASSWORD, auth: `Bearer ${access_token}` };
}

/**
 * Where an assignment applies. `global` is the whole instance; `project` grants
 * inside one project and is INHERITED by the flows in it, which is a grant path
 * of its own rather than a weaker global one.
 */
export interface AssignmentScope {
  domain_type: "global" | "project" | "workspace";
  /** Required for anything but `global`; the API takes `null` there. */
  domain_id?: string | null;
}

/**
 * Grant `roleId` to `userId`, globally by default. Returns the assignment id, for
 * cleanup.
 *
 * The scope defaults to global so the callers written before project scope
 * existed read unchanged — and because a scoped grant a caller forgot to scope
 * would silently become instance-wide, which is the wrong direction to fail in.
 */
export async function assignRole(
  request: APIRequestContext,
  auth: string,
  userId: string,
  roleId: string,
  scope: AssignmentScope = { domain_type: "global" },
): Promise<string> {
  const response = await request.post("/api/v1/authz/role-assignments", {
    headers: { Authorization: auth },
    data: {
      user_id: userId,
      role_id: roleId,
      domain_type: scope.domain_type,
      domain_id: scope.domain_id ?? null,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** One assignment that reaches a resource, as `inherited-access` reports it. */
export interface InheritedGrant {
  assignment_id: string;
  user_id: string;
  username: string;
  role_name: string;
  domain_type: string;
  domain_id?: string | null;
  actions: string[];
}

/**
 * Every assignment that reaches `flowId`, whatever scope it came from.
 *
 * Superuser-scoped: asked by the subject it describes, the endpoint answers
 * `404`, so callers pass the superuser's auth. Read by MEMBERSHIP, never by
 * length — the superuser's own global admin grant is always in this list, and so
 * is whatever else the container carries.
 */
export async function readInheritedAccess(
  request: APIRequestContext,
  auth: string,
  flowId: string,
): Promise<InheritedGrant[]> {
  const response = await request.get(
    `/api/v1/authz/flows/${flowId}/inherited-access`,
    { headers: { Authorization: auth } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { items: InheritedGrant[] }).items;
}

/** One entry in the recipient's `shared-with-me` list. */
export interface SharedWithMeItem {
  resource_type: string;
  resource_id: string;
  name?: string;
  owner_username?: string;
  permission_level?: string;
}

/** What has been shared WITH the caller. Envelope: `{total_count, items, truncated}`. */
export async function readSharedWithMe(
  request: APIRequestContext,
  auth: string,
): Promise<SharedWithMeItem[]> {
  const response = await request.get("/api/v1/authz/shared-with-me", {
    headers: { Authorization: auth },
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { items: SharedWithMeItem[] }).items;
}

/**
 * Who may be offered as a share target for one resource.
 *
 * `search` is REQUIRED, with a two-character minimum, and that is a property
 * rather than an inconvenience: there is no call that lists everybody, so the
 * endpoint cannot be used to enumerate the directory. Returned raw so a caller
 * can assert the refusals (`404` for a non-manager, `422` for a short search) as
 * well as the list.
 */
export function shareTargets(
  request: APIRequestContext,
  auth: string,
  resourceType: string,
  resourceId: string,
  search: string,
  scope = "user",
) {
  const query = new URLSearchParams({
    resource_type: resourceType,
    resource_id: resourceId,
    scope,
    search,
  });
  return request.get(`/api/v1/authz/share-targets?${query}`, {
    headers: { Authorization: auth },
  });
}

/** `{can_manage_shares}` — the flag a client renders the share control from. */
export async function shareCapability(
  request: APIRequestContext,
  auth: string,
  resourceType: string,
  resourceId: string,
): Promise<boolean> {
  const query = new URLSearchParams({
    resource_type: resourceType,
    resource_id: resourceId,
  });
  const response = await request.get(
    `/api/v1/authz/share-targets/capability?${query}`,
    { headers: { Authorization: auth } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { can_manage_shares: boolean })
    .can_manage_shares;
}

/** `{is_rbac_admin}` — the flag a client renders the admin screens from. */
export async function isRbacAdmin(
  request: APIRequestContext,
  auth: string,
): Promise<boolean> {
  const response = await request.get("/api/v1/authz/me/rbac-admin", {
    headers: { Authorization: auth },
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { is_rbac_admin: boolean }).is_rbac_admin;
}

/**
 * The second grant path: assign by role NAME rather than by id.
 *
 * Returned raw, because half of what this route is worth testing for is its
 * refusals — a subject calling it for itself is refused by the SUPERUSER guard,
 * not the admin-role one.
 */
export function grantRoleByName(
  request: APIRequestContext,
  auth: string,
  userId: string,
  roleName: string,
  domainType = "global",
) {
  return request.post(`/api/v1/authz/users/${userId}/roles`, {
    headers: { Authorization: auth },
    data: { role_name: roleName, domain_type: domainType },
  });
}

/**
 * Reconcile scoped to named entities.
 *
 * `entityKey` is the CASBIN key (`role:viewer`), NOT the entity's UUID and not its
 * bare name — both of those answer `500` today (#1555), as does any key that
 * matches nothing, with a `message` envelope instead of `detail`. Returned raw so
 * the `500` can be asserted against rather than thrown inside the helper.
 */
export function reconcileEntities(
  request: APIRequestContext,
  auth: string,
  entities: { entity_type: string; entity_key: string }[],
) {
  return request.post("/api/v1/authz/policy/reconcile/entities", {
    headers: { Authorization: auth },
    data: { entities },
  });
}

/** The verdict `policy/reconcile` returns. Counts are per call, not cumulative. */
export interface ReconcileVerdict {
  outcome?: "clean" | "drift" | "repaired";
  repair?: boolean;
  scope?: string;
  revision?: string;
  expected_count?: number;
  actual_count?: number;
  missing_count?: number;
  extra_count?: number;
  inserted_count?: number;
  deleted_count?: number;
  changed_count?: number;
}

/**
 * Diff the derived policy against `casbin_rule`, optionally repairing it.
 *
 * `repair` is a QUERY parameter, and this is the whole reason this helper exists
 * rather than an inline `request.post`. Sent in the BODY it is silently ignored:
 * the response echoes `repair: false`, both write counters stay `0`, and the same
 * drift is reported call after call — which reads exactly like a repair knob that
 * does not work. The first measurement of this endpoint concluded precisely that.
 */
export async function reconcilePolicy(
  request: APIRequestContext,
  auth: string,
  { repair = false }: { repair?: boolean } = {},
): Promise<ReconcileVerdict> {
  const response = await request.post(
    `/api/v1/authz/policy/reconcile${repair ? "?repair=true" : ""}`,
    { headers: { Authorization: auth }, data: {} },
  );
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as ReconcileVerdict;
}

/** Clear and rewrite `casbin_rule` from the derived policy. */
export async function syncPolicy(
  request: APIRequestContext,
  auth: string,
): Promise<{ cleared?: boolean; counts?: Record<string, number> }> {
  const response = await request.post("/api/v1/authz/policy/sync", {
    headers: { Authorization: auth },
    data: {},
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as {
    cleared?: boolean;
    counts?: Record<string, number>;
  };
}

/**
 * What the caller may do with each of `resourceIds`, as the product's own
 * resource-scoped decision API answers it.
 *
 * Unlike `check`, this takes NO casbin pattern — a resource type and a list of
 * ids, which is how a client asks. So an empty answer here cannot be dismissed as
 * a mis-encoded question, which is what makes it usable as ground truth for
 * whether the decision API agrees with enforcement.
 */
export async function mePermissions(
  request: APIRequestContext,
  auth: string,
  resourceType: string,
  resourceIds: string[],
): Promise<Record<string, string[]>> {
  const response = await request.post("/api/v1/authz/me/permissions", {
    headers: { Authorization: auth },
    data: { resource_type: resourceType, resource_ids: resourceIds },
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { permissions: Record<string, string[]> })
    .permissions;
}

export interface AuditEntry {
  actor_id?: string;
  action?: string;
  result?: string;
  resource_type?: string;
}

/** The audit log's newest page. The envelope is `{items, page, pages, size, total}`. */
export async function readAuditLog(
  request: APIRequestContext,
  auth: string,
): Promise<AuditEntry[]> {
  const response = await request.get("/api/v1/authz/audit", {
    headers: { Authorization: auth },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items?: AuditEntry[] };
  return body.items ?? [];
}

/**
 * Best-effort teardown, in dependency order.
 *
 * Never throws: this runs from a `finally` after a test that may already have
 * failed, and a cleanup error there would replace the real failure with a
 * derived one. What it cannot delete it leaves behind on a container that is
 * recreated per run anyway.
 */
export async function cleanupRbacUser(
  request: APIRequestContext,
  auth: string,
  user: RbacUser,
  assignmentIds: string[] = [],
): Promise<void> {
  const headers = { Authorization: auth };
  for (const assignmentId of assignmentIds) {
    await request
      .delete(`/api/v1/authz/role-assignments/${assignmentId}`, { headers })
      .catch(() => undefined);
  }
  await request.delete(`/api/v1/users/${user.id}`, { headers }).catch(() => undefined);
}

export interface ShareGrant {
  id: string;
}

/**
 * Share `resourceId` with one user, at `permissionLevel`.
 *
 * `scope: "user"` targets a single principal; the enum also carries `private`,
 * `team` and `public`. Returns the grant so the caller can revoke it — a grant
 * that cannot be taken back is not a grant, and revocation is half of what the
 * matrix spec measures.
 */
export async function shareWithUser(
  request: APIRequestContext,
  auth: string,
  resourceType: string,
  resourceId: string,
  targetUserId: string,
  permissionLevel: "read" | "write" | "execute" | "admin",
): Promise<ShareGrant> {
  const response = await request.post("/api/v1/authz/shares", {
    headers: { Authorization: auth },
    data: {
      resource_type: resourceType,
      resource_id: resourceId,
      scope: "user",
      target_id: targetUserId,
      permission_level: permissionLevel,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return { id: ((await response.json()) as { id: string }).id };
}

export interface AuthzDecision {
  allowed?: boolean;
  matched_policy?: string[];
}

/**
 * Ask the decision API about one (subject, object, action).
 *
 * `obj` is a casbin OBJECT PATTERN, not a resource type, and which pattern is
 * passed decides which question is asked: `flow:*` is "may you read flows in
 * general", answered from role policy alone, while `flow:<id>` is "may you read
 * THIS flow", which also accounts for shares. Passing the first where the second
 * was meant produces a confident wrong answer that looks exactly like a product
 * defect — it did, twice, while this area was being measured.
 *
 * An unknown pattern is DENIED rather than rejected: `200` with
 * `allowed: false` and an empty `matched_policy`. That empty array is the only
 * signal separating a mis-encoded question from a real refusal.
 */
export async function authzCheck(
  request: APIRequestContext,
  auth: string,
  userId: string,
  obj: string,
  act: string,
): Promise<AuthzDecision> {
  const response = await request.post("/api/v1/authz/check", {
    headers: { Authorization: auth },
    data: { user_id: userId, obj, act },
  });
  expect(response.status()).toBe(200);
  return (await response.json()) as AuthzDecision;
}

/** Effective permissions for one resource, as the subject sees them. */
export async function effectivePermissions(
  request: APIRequestContext,
  subjectAuth: string,
  resourceType: string,
  resourceId: string,
): Promise<string[]> {
  const response = await request.post("/api/v1/authz/me/permissions", {
    headers: { Authorization: subjectAuth },
    data: { resource_type: resourceType, resource_ids: [resourceId] },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    permissions?: Record<string, string[]>;
  };
  return body.permissions?.[resourceId] ?? [];
}

/**
 * Share a resource with a whole team.
 *
 * The sibling of {@link shareWithUser}, and worth its own entry point because
 * the revocation surface differs: a team grant can be taken away by deleting
 * the share OR by removing the subject's membership, and an operator has both
 * levers.
 */
export async function shareWithTeam(
  request: APIRequestContext,
  auth: string,
  resourceType: string,
  resourceId: string,
  teamId: string,
  permissionLevel: "read" | "write" | "execute" | "admin",
): Promise<ShareGrant> {
  const response = await request.post("/api/v1/authz/shares", {
    headers: { Authorization: auth },
    data: {
      resource_type: resourceType,
      resource_id: resourceId,
      scope: "team",
      target_id: teamId,
      permission_level: permissionLevel,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return { id: ((await response.json()) as { id: string }).id };
}

/** Create a team. `adom_name` is the administrative domain it lives in. */
export async function createTeam(
  request: APIRequestContext,
  auth: string,
  prefix: string,
  adomName = "default",
): Promise<{ id: string; name: string }> {
  const name = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const response = await request.post("/api/v1/authz/teams", {
    headers: { Authorization: auth },
    data: { team_name: name, adom_name: adomName },
  });
  expect(response.status(), await response.text()).toBe(201);
  return { id: ((await response.json()) as { id: string }).id, name };
}

export async function addTeamMember(
  request: APIRequestContext,
  auth: string,
  teamId: string,
  userId: string,
): Promise<void> {
  const response = await request.post(`/api/v1/authz/teams/${teamId}/members`, {
    headers: { Authorization: auth },
    data: { user_id: userId },
  });
  expect(response.status(), await response.text()).toBe(201);
}

export async function removeTeamMember(
  request: APIRequestContext,
  auth: string,
  teamId: string,
  userId: string,
): Promise<void> {
  const response = await request.delete(
    `/api/v1/authz/teams/${teamId}/members/${userId}`,
    { headers: { Authorization: auth } },
  );
  expect(response.ok(), await response.text()).toBe(true);
}

/**
 * Mint an API key for whoever `subjectAuth` belongs to.
 *
 * Returns the secret, which the API reveals exactly once. Creating one requires
 * a container whose `LANGFLOW_SECRET_KEY` is a valid Fernet key — 32 url-safe
 * base64 bytes — and answers `400` naming Fernet otherwise, which is what the
 * lane's containers did until the start script was fixed.
 */
export async function createApiKey(
  request: APIRequestContext,
  subjectAuth: string,
  name: string,
): Promise<{ id: string; secret: string }> {
  const response = await request.post("/api/v1/api_key/", {
    headers: { Authorization: subjectAuth },
    data: { name },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { id: string; api_key: string };
  expect(
    body.api_key,
    "the API responded without a key — a later request would then be anonymous " +
      "rather than key-authenticated, and every 'denied' assertion would pass " +
      "for the wrong reason",
  ).toBeTruthy();
  return { id: body.id, secret: body.api_key };
}

/**
 * A subject shared by every spec in the `authz/` directory, cached across
 * processes.
 *
 * Each spec file creating its own subject costs one login per file, and the
 * directory grew to three — so a single run spent three of the five logins EE
 * allows per minute per IP for the whole machine, and a re-run inside that
 * minute failed on the limiter rather than on anything about Langflow. The cap
 * is on the whole lane, so the cost scales with the number of FILES, which is
 * exactly the wrong thing for it to scale with.
 *
 * So the subject is minted once and reused, the same shape the superuser token
 * already uses. Callers must still reset its grants between tests: what is
 * shared is an identity, and no assertion may depend on what it was last
 * granted.
 *
 * It is deliberately NOT deleted at the end of a run. Deleting it would mean
 * re-creating and re-logging it on the next one, which is the cost this exists
 * to avoid; the RBAC container is recreated per session and holds nothing else.
 */
const SUBJECT_CACHE_DIR = join(tmpdir(), "langflow-e2e-enterprise");

function subjectCachePath(): string {
  const baseUrl = process.env.PLAYWRIGHT_BASE_URL || "http://localhost:7891";
  const key = createHash("sha256").update(baseUrl).digest("hex").slice(0, 16);
  return join(SUBJECT_CACHE_DIR, `rbac-subject-${key}.json`);
}

function readCachedSubject(): RbacUser | undefined {
  try {
    const raw = readFileSync(subjectCachePath(), "utf-8");
    const cached = JSON.parse(raw) as RbacUser;
    return cached.id && cached.auth && cached.username ? cached : undefined;
  } catch {
    return undefined;
  }
}

function writeCachedSubject(subject: RbacUser): void {
  try {
    mkdirSync(SUBJECT_CACHE_DIR, { recursive: true });
    writeFileSync(subjectCachePath(), JSON.stringify(subject), "utf-8");
  } catch {
    // A cache that cannot be written costs a login, not a run.
  }
}

/**
 * Get the shared subject, minting it only if the cached one is unusable.
 *
 * "Unusable" is checked against the instance, not against the clock: the token
 * has to authenticate AND the account has to still exist. A container recreated
 * between runs keeps the same base URL and invalidates every cached token
 * silently, so trusting the file without probing would turn a fresh container
 * into a wall of 401s attributed to the specs.
 */
export async function getSharedRbacSubject(
  request: APIRequestContext,
  auth: string,
): Promise<RbacUser> {
  const cached = readCachedSubject();
  if (cached) {
    const whoami = await request
      .get("/api/v1/users/whoami", { headers: { Authorization: cached.auth } })
      .catch(() => undefined);
    if (whoami?.ok()) {
      const body = (await whoami.json()) as { id?: string };
      if (body.id === cached.id) return cached;
    }

    // The token died; the ACCOUNT usually has not. Minting a replacement here
    // was the first implementation, and it leaks: measured on this instance, an
    // expired cache left the previous account behind together with the Starter
    // Project Langflow seeds for every new user — one orphan pair per token
    // lifetime, forever, on a shared instance. Re-logging in costs the same
    // single unit of the 5-per-minute budget as minting would and leaves
    // nothing behind, so it is tried first.
    const revived = await request
      .post("/api/v1/login", {
        form: { username: cached.username, password: cached.password },
      })
      .catch(() => undefined);

    if (revived?.ok()) {
      const body = (await revived.json()) as { access_token?: string };
      if (body.access_token) {
        const subject = { ...cached, auth: `Bearer ${body.access_token}` };
        writeCachedSubject(subject);
        return subject;
      }
    }

    // A 429 says the machine is over its login budget, not that the account is
    // gone. Minting here would spend another login on a limiter that is already
    // refusing, and leave a second account behind for a problem that clears by
    // itself in a minute.
    if (revived?.status() === 429) {
      throw new Error(
        `Re-authenticating the cached RBAC subject '${cached.username}' was ` +
          `rate-limited (429). EE allows 5 logins per minute per IP for the ` +
          `whole machine and counts failed attempts too. Wait out the window ` +
          `(~60s) and re-run; if it persists, another process is ` +
          `authenticating against the same instance.`,
      );
    }

    // Anything else means the cached account is unusable — deleted, deactivated,
    // or its password rotated. Remove it before replacing it, so the instance
    // ends this call with one subject account rather than two.
    await cleanupRbacUser(request, auth, cached).catch(() => undefined);
  }

  const subject = await createRbacUser(request, auth, "authz-shared");
  writeCachedSubject(subject);
  return subject;
}

/**
 * Return the shared subject to the state every test in this directory assumes:
 * no roles, no shares. Uses the superuser, so it costs no login.
 */
export async function resetSubjectGrants(
  request: APIRequestContext,
  auth: string,
  granted: { assignments: string[]; shares: string[] },
): Promise<void> {
  const headers = { Authorization: auth };
  for (const id of granted.shares.splice(0)) {
    await request
      .delete(`/api/v1/authz/shares/${id}`, { headers })
      .catch(() => undefined);
  }
  for (const id of granted.assignments.splice(0)) {
    await request
      .delete(`/api/v1/authz/role-assignments/${id}`, { headers })
      .catch(() => undefined);
  }
}
