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
  if (login.status() === 429) {
    throw new Error(
      `Login for '${username}' was rate-limited (429). EE allows 5 logins per ` +
        `minute per IP for the whole machine, and this lane's cached superuser ` +
        `token plus each created user share that budget. Wait out the window ` +
        `(~60s) and re-run; if it persists, another process is authenticating ` +
        `against the same instance.`,
    );
  }
  expect(login.status(), await login.text()).toBe(200);
  const { access_token } = (await login.json()) as { access_token: string };

  return { id, username, password: TEST_USER_PASSWORD, auth: `Bearer ${access_token}` };
}

/** Grant `roleId` to `userId` globally. Returns the assignment id, for cleanup. */
export async function assignRole(
  request: APIRequestContext,
  auth: string,
  userId: string,
  roleId: string,
): Promise<string> {
  const response = await request.post("/api/v1/authz/role-assignments", {
    headers: { Authorization: auth },
    data: { user_id: userId, role_id: roleId, domain_type: "global" },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
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
