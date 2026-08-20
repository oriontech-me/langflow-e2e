import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  builtinRoleIds,
  cleanupRbacUser,
  createRbacUser,
  getSharedRbacSubject,
  readAuthzStatus,
  readRoleAssignments,
  requireBypassInstance,
  requireRbacInstance,
  resetSubjectGrants,
  restoreRoleAssignments,
  type RbacUser,
  type RoleAssignment,
} from "../../../../helpers/enterprise/rbac";

/**
 * The three `403`s are three GUARDS, and what `superuser_bypass` switches.
 *
 * `rbac-instance-baseline` names the three refusal messages and defers them, on
 * the grounds that a foundation test should not answer a question it does not
 * ask. The deferral held for a structural reason too: every spec in this
 * directory is built around ONE subject, and one subject cannot separate three
 * independent guards from three spellings of a single privilege ladder. It takes
 * two, each passing a guard the other fails.
 *
 * Measured, the ladder is NOT monotone:
 *
 *   - resource policy reads casbin policy alone. A superuser stripped of its
 *     role assignment is refused a flow it could create a second earlier.
 *   - the RBAC admin route is satisfied by the `admin` role OR the superuser
 *     flag — so the role-less superuser passes it while being refused below it.
 *   - role administration is satisfied by the flag ONLY. A holder of the global
 *     `admin` role passes the two guards beneath it and is refused here, which
 *     is the containment that makes the role safe to hand out: an admin cannot
 *     grant themselves anything.
 *
 * And the bypass switches exactly one cell — the superuser's resource-policy
 * answer. Everything else, including every non-superuser answer on the same
 * instance, is unchanged. That is narrower than `requireRbacInstance`'s own
 * wording claims, and more useful: the flag is an escape hatch scoped to one
 * principal and one guard, not an authorization off-switch.
 *
 * THE A/B IS TWO RUNS. Tests 1 and 2 need `superuser_bypass: false`
 * (`LANGFLOW_EE_RBAC=1`, port 7891); test 3 needs it `true`
 * (`LANGFLOW_EE_BYPASS=1`, port 7892). No instance satisfies both, so each half
 * gates and skips naming the container it needs, rather than one of them failing
 * against the wrong one.
 */

/** The wording of each guard, asserted exactly — the point is that they differ. */
const RESOURCE_GUARD = "Permission denied";
const ADMIN_ROUTE_GUARD = "RBAC administrator role required";
const ROLE_ADMIN_GUARD = "Superuser required to administer roles.";
/** The same guard on the sibling route, whose message names the route. */
const ASSIGNMENT_ADMIN_GUARD = "Superuser required to administer role assignments.";

interface GuardVerdict {
  status: number;
  detail?: string;
  /** Set when the call was allowed and left something behind to delete. */
  createdId?: string;
}

interface GuardVerdicts {
  resource: GuardVerdict;
  adminRoute: GuardVerdict;
  roleAdmin: GuardVerdict;
}

async function detailOf(response: {
  json: () => Promise<unknown>;
}): Promise<string | undefined> {
  const body = (await response.json().catch(() => undefined)) as
    | { detail?: string }
    | undefined;
  return body?.detail;
}

/**
 * One route per guard, probed as `auth`.
 *
 * The two calls that succeed for a privileged subject create something, so each
 * verdict carries the id it left behind and the caller deletes it. A probe that
 * leaks a flow or a role per run would make the next run's assertions depend on
 * how many times this file has been executed.
 */
async function probeGuards(
  request: APIRequestContext,
  auth: string,
  label: string,
): Promise<GuardVerdicts> {
  const headers = { Authorization: auth };

  const resource = await request.post("/api/v1/flows/", {
    headers,
    data: {
      name: `guard-ladder-${label}-${Date.now()}`,
      description: "",
      data: { nodes: [], edges: [] },
    },
  });
  const adminRoute = await request.get("/api/v1/authz/admin/users", { headers });
  const roleAdmin = await request.post("/api/v1/authz/roles", {
    headers,
    data: { name: `guard-ladder-${label}-${Date.now()}`, description: "probe" },
  });

  return {
    resource: {
      status: resource.status(),
      detail: await detailOf(resource),
      createdId: resource.ok()
        ? ((await resource.json()) as { id: string }).id
        : undefined,
    },
    adminRoute: { status: adminRoute.status(), detail: await detailOf(adminRoute) },
    roleAdmin: {
      status: roleAdmin.status(),
      detail: await detailOf(roleAdmin),
      createdId: roleAdmin.ok()
        ? ((await roleAdmin.json()) as { id: string }).id
        : undefined,
    },
  };
}

/** Delete whatever a probe was allowed to create. Never throws. */
async function discardProbeArtifacts(
  request: APIRequestContext,
  auth: string,
  verdicts: GuardVerdicts,
): Promise<void> {
  const headers = { Authorization: auth };
  if (verdicts.resource.createdId) {
    await request
      .delete(`/api/v1/flows/${verdicts.resource.createdId}`, { headers })
      .catch(() => undefined);
  }
  if (verdicts.roleAdmin.createdId) {
    await request
      .delete(`/api/v1/authz/roles/${verdicts.roleAdmin.createdId}`, { headers })
      .catch(() => undefined);
  }
}

/**
 * Strip every global assignment the superuser holds, and confirm it is gone.
 *
 * This is the only mutation in the area that touches the lane's own principal,
 * and it is unavoidable: "is the superuser subject to resource policy" cannot be
 * asked of a superuser holding the global `admin` role, which is what the RBAC
 * bootstrap grants it — measured, even with `LANGFLOW_RBAC_BOOTSTRAP_ENABLED`
 * unset, so no container configuration withholds it.
 */
async function stripSuperuserAssignments(
  request: APIRequestContext,
  auth: string,
): Promise<RoleAssignment[]> {
  const whoami = await request.get("/api/v1/users/whoami", {
    headers: { Authorization: auth },
  });
  expect(whoami.status(), await whoami.text()).toBe(200);
  const { id } = (await whoami.json()) as { id: string };

  const mine = (await readRoleAssignments(request, auth)).filter(
    (assignment) => assignment.user_id === id,
  );

  for (const assignment of mine) {
    const deleted = await request.delete(
      `/api/v1/authz/role-assignments/${assignment.id}`,
      { headers: { Authorization: auth } },
    );
    expect(deleted.status(), await deleted.text()).toBe(204);
  }

  const status = await readAuthzStatus(request, auth);
  // Zero is what makes the next assertion mean anything: with an assignment
  // still standing, an allowed call could be coming from the role rather than
  // from the flag under test.
  expect(
    status.assignment_count,
    "The superuser still holds a role assignment, so nothing below can " +
      "distinguish a grant from an exemption.",
  ).toBe(0);

  return mine;
}

test.describe("Enterprise — three guards, and what superuser bypass switches", () => {
  test(
    "the three refusals are three guards: an admin passes two and is refused the third",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const subject: RbacUser = await getSharedRbacSubject(request, auth);
      const granted: { assignments: string[]; shares: string[] } = {
        assignments: [],
        shares: [],
      };
      let roleLess: GuardVerdicts | undefined;
      let asAdmin: GuardVerdicts | undefined;

      try {
        await resetSubjectGrants(request, auth, granted);

        await test.step("a role-less subject is refused by all three, with three different messages", async () => {
          roleLess = await probeGuards(request, subject.auth, "roleless");

          expect(roleLess.resource.status).toBe(403);
          expect(roleLess.resource.detail).toBe(RESOURCE_GUARD);
          expect(roleLess.adminRoute.status).toBe(403);
          expect(roleLess.adminRoute.detail).toBe(ADMIN_ROUTE_GUARD);
          expect(roleLess.roleAdmin.status).toBe(403);
          expect(roleLess.roleAdmin.detail).toBe(ROLE_ADMIN_GUARD);

          // Pairwise, not merely non-empty. One message reused across two
          // guards would leave a client unable to tell "ask an admin" from
          // "ask the operator", and would read here as three passing asserts.
          const messages = [
            roleLess.resource.detail,
            roleLess.adminRoute.detail,
            roleLess.roleAdmin.detail,
          ];
          expect(new Set(messages).size).toBe(3);
        });

        await test.step("the global admin role flips the first two and leaves the third refused", async () => {
          const roles = await builtinRoleIds(request, auth);
          expect(roles.admin, "the built-in admin role").toBeTruthy();
          granted.assignments.push(
            await assignRole(request, auth, subject.id, roles.admin),
          );

          asAdmin = await probeGuards(request, subject.auth, "admin");

          expect(asAdmin.resource.status).toBe(201);
          expect(asAdmin.adminRoute.status).toBe(200);
          // The load-bearing one: the subject that may now read the RBAC admin
          // surface still cannot create a role. Role administration is gated on
          // being superuser, not on holding the admin role, so the role cannot
          // escalate itself.
          expect(asAdmin.roleAdmin.status).toBe(403);
          expect(asAdmin.roleAdmin.detail).toBe(ROLE_ADMIN_GUARD);
        });

        await test.step("the same guard refuses role ASSIGNMENT, naming the route", async () => {
          const roles = await builtinRoleIds(request, auth);
          const assignment = await request.post("/api/v1/authz/role-assignments", {
            headers: { Authorization: subject.auth },
            data: {
              user_id: subject.id,
              role_id: roles.developer,
              domain_type: "global",
            },
          });

          // Self-escalation by the other route an admin might reach for.
          expect(assignment.status()).toBe(403);
          expect(await detailOf(assignment)).toBe(ASSIGNMENT_ADMIN_GUARD);
        });
      } finally {
        if (roleLess) await discardProbeArtifacts(request, auth, roleLess);
        if (asAdmin) await discardProbeArtifacts(request, auth, asAdmin);
        await resetSubjectGrants(request, auth, granted);
      }
    },
  );

  test(
    "with bypass off, the superuser is subject to resource policy like anybody else",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      let stripped: RoleAssignment[] = [];
      let verdicts: GuardVerdicts | undefined;

      try {
        stripped = await stripSuperuserAssignments(request, auth);
        expect(
          stripped.length,
          "the superuser held no assignment to strip, so this instance cannot " +
            "answer whether the flag or the role is what allows it",
        ).toBeGreaterThan(0);

        verdicts = await probeGuards(request, auth, "superuser-enforced");

        // This is what `superuser_bypass: false` buys, and the reason every
        // spec in this directory gates on it: the superuser's resource-policy
        // answer comes from policy, not from the flag.
        expect(verdicts.resource.status).toBe(403);
        expect(verdicts.resource.detail).toBe(RESOURCE_GUARD);
        // The other two guards are satisfied by the flag, so they do not move —
        // asserted so a future change that broadens the bypass into them cannot
        // hide behind the assertion above.
        expect(verdicts.adminRoute.status).toBe(200);
        expect(verdicts.roleAdmin.status).toBe(201);
      } finally {
        if (verdicts) await discardProbeArtifacts(request, auth, verdicts);
        // Asserted, not attempted: a superuser left role-less would fail every
        // later test in this directory for a reason none of them is about.
        await restoreRoleAssignments(request, auth, stripped);
        const status = await readAuthzStatus(request, auth);
        expect(status.assignment_count).toBeGreaterThan(0);
      }
    },
  );

  test(
    "with bypass on, the superuser is exempt from resource policy and nobody else is",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireBypassInstance(request, auth);

      let stripped: RoleAssignment[] = [];
      let verdicts: GuardVerdicts | undefined;
      let peer: RbacUser | undefined;
      let peerVerdicts: GuardVerdicts | undefined;

      try {
        stripped = await stripSuperuserAssignments(request, auth);

        await test.step("a role-less superuser is allowed the call policy refuses", async () => {
          verdicts = await probeGuards(request, auth, "superuser-bypass");

          // With `assignment_count` at zero, no role grants this. The flag does.
          expect(verdicts.resource.status).toBe(201);
          expect(verdicts.adminRoute.status).toBe(200);
          expect(verdicts.roleAdmin.status).toBe(201);
        });

        await test.step("a role-less peer on the same instance is still refused by all three", async () => {
          peer = await createRbacUser(request, auth, "bypass-peer");
          peerVerdicts = await probeGuards(request, peer.auth, "peer");

          // The half that separates an escape hatch from an off-switch. If the
          // bypass disabled enforcement, this subject would be allowed too, and
          // the assertions above would pass for the wrong reason.
          expect(peerVerdicts.resource.status).toBe(403);
          expect(peerVerdicts.resource.detail).toBe(RESOURCE_GUARD);
          expect(peerVerdicts.adminRoute.status).toBe(403);
          expect(peerVerdicts.adminRoute.detail).toBe(ADMIN_ROUTE_GUARD);
          expect(peerVerdicts.roleAdmin.status).toBe(403);
          expect(peerVerdicts.roleAdmin.detail).toBe(ROLE_ADMIN_GUARD);
        });
      } finally {
        if (verdicts) await discardProbeArtifacts(request, auth, verdicts);
        if (peerVerdicts) await discardProbeArtifacts(request, auth, peerVerdicts);
        if (peer) await cleanupRbacUser(request, auth, peer);
        await restoreRoleAssignments(request, auth, stripped);
      }
    },
  );
});
