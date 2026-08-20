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
