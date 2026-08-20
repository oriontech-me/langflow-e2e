import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "../../../../fixtures/fixtures";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  authzCheck,
  builtinRoleIds,
  getSharedRbacSubject,
  mePermissions,
  readInheritedAccess,
  requireRbacInstance,
  resetSubjectGrants,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * INHERITED access: a role assignment scoped to a project, and the flows inside
 * it that nobody was ever granted anything on.
 *
 * `deny-matrix-and-decision-api` walked one subject through global roles and a
 * direct share. Project scope is a third grant path with its own revocation
 * lever, and it is the one an operator actually uses — nobody grants `developer`
 * over an entire instance to let somebody work on one project.
 *
 * The enforcement half is green and unremarkable: inheritance works, is graded by
 * role, and is revocable. The interesting half is that the surfaces which
 * DESCRIBE access do not agree with the one that ENFORCES it, and a client renders
 * from the descriptions:
 *
 *   - `inherited-access` names the grant correctly, scope and actions included.
 *   - `check` with `obj: "project:<pid>"` agrees.
 *   - `check` with `obj: "flow:<id>"` answers `allowed: false, matched_policy: []`.
 *   - `me/permissions` for that flow answers `[]` — for a flow the subject can
 *     `PATCH`.
 *
 * The last two are asserted as they SHOULD answer, so those tests are EXPECTED RED
 * on current Enterprise builds (#1532). The empty `matched_policy` in `check` is
 * ordinarily the sign of a mis-encoded pattern — the trap
 * `deny-matrix-and-decision-api` documents, which fabricated two findings while it
 * was written — but `me/permissions` takes no pattern at all, and the deny-matrix
 * spec already pins that it reports a SHARE, which is not ownership either. So
 * "inherited grants are invisible" is a gap, not a wrong question.
 *
 * `deploy` gets one cell deliberately left unasserted; the reason is at test 3.
 */

const MISSING = { read: 404, patch: 404 } as const;

interface Verdicts {
  read: number;
  patch: number;
}

async function probe(
  request: APIRequestContext,
  subject: RbacUser,
  flowId: string,
): Promise<Verdicts> {
  const headers = { Authorization: subject.auth };
  const read = await request.get(`/api/v1/flows/${flowId}`, { headers });
  const patch = await request.patch(`/api/v1/flows/${flowId}`, {
    headers,
    data: { name: `inherited-write-${Date.now()}` },
  });
  return { read: read.status(), patch: patch.status() };
}

/** The deployment route, which is where a `flow:deploy` decision would land. */
async function attemptDeploy(
  request: APIRequestContext,
  auth: string,
  projectId: string,
) {
  return request.post("/api/v1/control-plane/deployments", {
    headers: { Authorization: auth },
    data: { project_id: projectId, environment: "production" },
  });
}

test.describe("Enterprise — inherited access, and the surfaces that describe it", () => {
  let subject: RbacUser;
  let superuserAuth: string;
  let projectId: string;
  let deleteProject: (req?: APIRequestContext) => Promise<void>;
  let flowId: string;
  const granted: { assignments: string[]; shares: string[] } = {
    assignments: [],
    shares: [],
  };

  test.beforeAll(async ({ request }) => {
    superuserAuth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, superuserAuth);
    subject = await getSharedRbacSubject(request, superuserAuth);

    const headers = { Authorization: superuserAuth };
    const project = await createProjectViaApi(request, headers, {
      namePrefix: "authz-inherited",
    });
    projectId = project.projectId;
    deleteProject = project.deleteProject;

    // The flow the subject is never granted anything on directly. Owned by the
    // superuser, inside the project the assignment will be scoped to.
    const flow = await request.post("/api/v1/flows/", {
      headers,
      data: {
        name: `authz-inherited-${Date.now()}`,
        description: "",
        data: { nodes: [], edges: [] },
        folder_id: projectId,
      },
    });
    expect(flow.status(), await flow.text()).toBe(201);
    flowId = ((await flow.json()) as { id: string }).id;
  });

  test.beforeEach(async ({ request }) => {
    await resetSubjectGrants(request, superuserAuth, granted);
  });

  test.afterAll(async ({ request }) => {
    await resetSubjectGrants(request, superuserAuth, granted);
    await request
      .delete(`/api/v1/flows/${flowId}`, {
        headers: { Authorization: superuserAuth },
      })
      .catch(() => undefined);
    await deleteProject?.(request).catch(() => undefined);
  });

  /** Grant `role` scoped to the project under test, tracked for teardown. */
  async function grantOnProject(request: APIRequestContext, role: string) {
    const roles = await builtinRoleIds(request, superuserAuth);
    expect(roles[role], `the built-in ${role} role`).toBeTruthy();
    granted.assignments.push(
      await assignRole(request, superuserAuth, subject.id, roles[role], {
        domain_type: "project",
        domain_id: projectId,
      }),
    );
  }

  test(
    "a project-scoped role reaches the flows inside it, graded by role and revocable",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      await test.step("with no role, the flow is indistinguishable from absent", async () => {
        expect(await probe(request, subject, flowId)).toEqual(MISSING);
      });

      await test.step("viewer scoped to the project reads it and cannot write", async () => {
        await grantOnProject(request, "viewer");
        expect(await probe(request, subject, flowId)).toEqual({
          read: 200,
          patch: 403,
        });
      });

      await test.step("developer scoped to the project writes it too", async () => {
        await resetSubjectGrants(request, superuserAuth, granted);
        await grantOnProject(request, "developer");
        expect(await probe(request, subject, flowId)).toEqual({
          read: 200,
          patch: 200,
        });
      });

      await test.step("revoking the assignment returns the flow to absent", async () => {
        await resetSubjectGrants(request, superuserAuth, granted);
        // A grant that cannot be taken back is not a grant — and inheritance is
        // the path where a stale rule would be easiest to leave behind, since
        // nothing was ever written against the flow itself.
        expect(await probe(request, subject, flowId)).toEqual(MISSING);
      });
    },
  );

  test(
    "inherited-access names the grant and its scope, and does not leak it to the subject",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      await grantOnProject(request, "developer");

      const items = await readInheritedAccess(request, superuserAuth, flowId);
      const mine = items.find((item) => item.user_id === subject.id);

      // Membership, never length: the superuser's own global admin grant is in
      // this list, and so is anything else the container carries.
      expect(mine, "the subject's inherited grant is listed").toBeTruthy();
      expect(mine!.domain_type).toBe("project");
      expect(mine!.domain_id).toBe(projectId);
      expect(mine!.role_name).toBe("developer");
      // The resolved actions, which is what makes this endpoint an answer rather
      // than a dump of assignments.
      expect(mine!.actions).toEqual(
        expect.arrayContaining(["read", "write"]),
      );

      const asSubject = await request.get(
        `/api/v1/authz/flows/${flowId}/inherited-access`,
        { headers: { Authorization: subject.auth } },
      );
      // Superuser-scoped, and it refuses the way the rest of the model does:
      // absent rather than forbidden, so it cannot be used to confirm a flow
      // exists to the very user it describes.
      expect(asSubject.status()).toBe(404);
    },
  );

  test(
    "the deployment gate refuses a viewer and a role-less user, and does not refuse an admin",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      await test.step("role-less is refused by authorization", async () => {
        const response = await attemptDeploy(request, subject.auth, projectId);
        expect(response.status()).toBe(403);
        expect(((await response.json()) as { detail: string }).detail).toBe(
          "Permission denied",
        );
      });

      await test.step("viewer is refused by authorization too", async () => {
        await grantOnProject(request, "viewer");
        const response = await attemptDeploy(request, subject.auth, projectId);
        expect(response.status()).toBe(403);
      });

      await test.step("admin is not refused by authorization", async () => {
        await resetSubjectGrants(request, superuserAuth, granted);
        await grantOnProject(request, "admin");
        const response = await attemptDeploy(request, subject.auth, projectId);
        // NOT asserted as a specific status. With no control plane configured
        // this instance answers 503 "Control Plane deployment is not
        // configured", and asserting that would pin the absence of a control
        // plane rather than the authorization verdict — and would redden the day
        // one is configured. What matters is that authorization did not refuse.
        expect(response.status()).not.toBe(403);
      });

      // `developer` is deliberately absent from this test. It reaches the same
      // 503 as `admin` while `inherited-access` does not list `deploy` among its
      // actions, and a 503 cannot distinguish "authorized" from "authorized here,
      // re-checked per flow by a configured plane". Asserting either reading
      // would pin whichever is convenient. Recorded in #1532 instead.
    },
  );

  test(
    "the decision APIs agree with enforcement about an inherited grant",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      await grantOnProject(request, "developer");

      // Ground truth first, so a failure below cannot be read as "the grant did
      // not apply".
      expect(await probe(request, subject, flowId)).toEqual({
        read: 200,
        patch: 200,
      });

      await test.step("check answers the resource-scoped question", async () => {
        const scoped = await authzCheck(
          request,
          superuserAuth,
          subject.id,
          `project:${projectId}`,
          "read",
        );
        // The project-scoped question is answered correctly, and names the grant
        // — so the pattern vocabulary itself is not the problem.
        expect(scoped.allowed).toBe(true);
        expect(scoped.matched_policy).toEqual(
          expect.arrayContaining(["role:developer"]),
        );

        // EXPECTED RED (#1532). The resource-scoped question about the very flow
        // enforcement just allowed answers `false` with an empty match.
        const onFlow = await authzCheck(
          request,
          superuserAuth,
          subject.id,
          `flow:${flowId}`,
          "read",
        );
        expect(onFlow.allowed).toBe(true);
      });

      await test.step("me/permissions reports what the subject can do", async () => {
        // EXPECTED RED (#1532). This route takes no casbin pattern — a resource
        // type and a list of ids, exactly how a client asks — and answers `[]`
        // for a flow the same subject can read and write. A client rendering
        // from it hides an editable flow.
        const permissions = await mePermissions(request, subject.auth, "flow", [
          flowId,
        ]);
        expect(permissions[flowId]).toEqual(
          expect.arrayContaining(["read", "write"]),
        );
      });
    },
  );

  test(
    "the model does not contradict itself about deploy",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      await grantOnProject(request, "admin");

      const items = await readInheritedAccess(request, superuserAuth, flowId);
      const mine = items.find((item) => item.user_id === subject.id);
      expect(mine!.actions, "admin's resolved actions include deploy").toEqual(
        expect.arrayContaining(["deploy"]),
      );

      // EXPECTED RED (#1532). One surface lists `deploy` among the actions this
      // assignment resolves to; the decision API denies the same action for the
      // same subject and scope. Whichever is right, they cannot both be — and a
      // client asking the decision API would hide a control the model grants.
      const decision = await authzCheck(
        request,
        superuserAuth,
        subject.id,
        `project:${projectId}`,
        "deploy",
      );
      expect(decision.allowed).toBe(true);
    },
  );
});
