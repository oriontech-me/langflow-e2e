import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  builtinRoleIds,
  getSharedRbacSubject,
  grantRoleByName,
  isRbacAdmin,
  readAllRoleAssignments,
  requireRbacInstance,
  resetSubjectGrants,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * The signal a client renders the admin screens from, and the second way to grant
 * a role.
 *
 * `GET /authz/me/rbac-admin` is what a UI asks before showing the RBAC admin
 * screens. Nothing tests it, and both directions of being wrong are invisible to
 * a test that only exercises the routes: a false `true` shows a user screens whose
 * every call answers `403`, a false `false` hides screens an administrator is
 * entitled to.
 *
 * Roles can also be assigned by NAME through `POST /authz/users/{id}/roles`, beside
 * the id-keyed `role-assignments` every other spec here uses. Two writers onto one
 * model is how they drift — one honouring a scope the other ignores, or one
 * bypassing the guard the other enforces. Measured, they converge on a single
 * assignment, and the name-keyed one refuses self-escalation through the SUPERUSER
 * guard rather than the admin-role one.
 *
 * That last distinction is why test 3 asserts MESSAGES and not statuses: the admin
 * twins of covered routes sit behind `RBAC administrator role required` while the
 * policy and SIEM routes sit behind `Superuser required for authz admin
 * endpoints`. Adjacent routes, different gates, all answering `403` — the status
 * alone cannot tell them apart, and #1531 established that the difference is real.
 */

const ADMIN_ROUTE_GUARD = "RBAC administrator role required";
const SUPERUSER_GUARD = "Superuser required for authz admin endpoints";

test.describe("Enterprise — the admin signal, and the second grant path", () => {
  let superuserAuth: string;
  let subject: RbacUser;
  const granted: { assignments: string[]; shares: string[] } = {
    assignments: [],
    shares: [],
  };

  test.beforeAll(async ({ request }) => {
    superuserAuth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, superuserAuth);
    subject = await getSharedRbacSubject(request, superuserAuth);
  });

  test.beforeEach(async ({ request }) => {
    await resetSubjectGrants(request, superuserAuth, granted);
  });

  test.afterAll(async ({ request }) => {
    await resetSubjectGrants(request, superuserAuth, granted);
  });

  test(
    "me/rbac-admin tracks the admin route, in both directions",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const adminRoute = () =>
        request.get("/api/v1/authz/admin/users", {
          headers: { Authorization: subject.auth },
        });

      await test.step("with no role, the signal is false and the route refuses", async () => {
        expect(await isRbacAdmin(request, subject.auth)).toBe(false);
        expect((await adminRoute()).status()).toBe(403);
      });

      await test.step("with global admin, the signal is true and the route answers", async () => {
        const roles = await builtinRoleIds(request, superuserAuth);
        granted.assignments.push(
          await assignRole(request, superuserAuth, subject.id, roles.admin),
        );
        expect(await isRbacAdmin(request, subject.auth)).toBe(true);
        expect((await adminRoute()).status()).toBe(200);
      });

      await test.step("after revoking, both go back", async () => {
        await resetSubjectGrants(request, superuserAuth, granted);
        // The half a grant-then-check test misses: a signal that only ever
        // latches true would pass the step above and leave a revoked user
        // looking at admin screens.
        expect(await isRbacAdmin(request, subject.auth)).toBe(false);
        expect((await adminRoute()).status()).toBe(403);
      });
    },
  );

  test(
    "the name-keyed grant path converges on one assignment and cannot escalate",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const created = await grantRoleByName(
        request,
        superuserAuth,
        subject.id,
        "viewer",
      );
      expect(created.status(), await created.text()).toBe(201);
      const body = (await created.json()) as {
        assignment_id: string;
        role_name: string;
        domain_type: string;
      };
      expect(body.role_name).toBe("viewer");
      expect(body.domain_type).toBe("global");
      granted.assignments.push(body.assignment_id);

      // One model, two writers: the id-keyed listing has to know about the
      // assignment the name-keyed route just made, or the two can drift apart
      // with each looking correct on its own.
      //
      // Read from the ADMIN listing, and the distinction is load-bearing:
      // `GET /authz/role-assignments` is scoped to the CALLER's own assignments,
      // so asking it about another principal's grant returns an empty result that
      // reads as "the grant did not land". The first version of this test asserted
      // against it and failed on a working product — and the same misreading, in a
      // cleanup loop, leaked an assignment onto the shared instance.
      const assignments = await readAllRoleAssignments(request, superuserAuth);
      expect(assignments.map((assignment) => assignment.id)).toContain(
        body.assignment_id,
      );

      // The other half of the convergence claim: the assignment the name-keyed
      // route created is addressable through the id-keyed route, which is what
      // makes it one object rather than two records that happen to agree.
      const revoked = await request.delete(
        `/api/v1/authz/role-assignments/${body.assignment_id}`,
        { headers: { Authorization: superuserAuth } },
      );
      expect(revoked.status()).toBe(204);
      granted.assignments.length = 0;

      const escalation = await grantRoleByName(
        request,
        subject.auth,
        subject.id,
        "admin",
      );
      expect(escalation.status()).toBe(403);
      // The SUPERUSER guard, not the admin-role one. A second grant path that
      // sat behind the weaker gate would be an escalation route around the whole
      // model, reachable by any user holding `admin`.
      expect(((await escalation.json()) as { detail: string }).detail).toBe(
        SUPERUSER_GUARD,
      );
    },
  );

  test(
    "the admin twins and the operator routes sit behind different guards",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const headers = { Authorization: subject.auth };
      const cases: { route: string; guard: string }[] = [
        { route: "/api/v1/authz/admin/role-assignments", guard: ADMIN_ROUTE_GUARD },
        { route: "/api/v1/authz/admin/assignment-scopes", guard: ADMIN_ROUTE_GUARD },
        { route: "/api/v1/authz/siem/status", guard: SUPERUSER_GUARD },
      ];

      for (const { route, guard } of cases) {
        const response = await request.get(route, { headers });
        expect(response.status(), route).toBe(403);
        // Asserted by message, because all three answer 403 and WHICH refusal
        // each gives is the entire content of this test.
        expect(((await response.json()) as { detail: string }).detail, route).toBe(
          guard,
        );
      }
    },
  );
});
