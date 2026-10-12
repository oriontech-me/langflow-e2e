import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "../../../../fixtures/fixtures";
import { createProjectViaApi } from "../../../../helpers/flows/create-project-via-api";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  authzCheck,
  builtinRoleIds,
  getSharedRbacSubject,
  inheritedAccessPath,
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
 * role, and is revocable. The other half is whether the surfaces which DESCRIBE
 * access agree with the one that ENFORCES it, because a client renders from them.
 *
 * They do — in the project's DOMAIN. `check` and `me/permissions` both take a
 * `domain` that defaults to `*`, the global question; a project-scoped grant
 * answers only in `project:<pid>`, which is what the product's own client sends.
 * The 1.12 version asked without it, read the global answer (`false` / `[]`) as a
 * disagreement and pinned it as expected red (#1532). It was the domain-shaped
 * twin of the `flow:*` trap `deny-matrix-and-decision-api` documents, and the
 * parameter existed then too. Both questions are asserted now, so the trap is
 * visible rather than re-discovered (#2259).
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
    // `slug` became required on the 2026-08-27 build. Without it FastAPI answers
    // `422` before authorization runs — for the superuser too — so the request
    // never reached the verdict this helper exists to observe (#1635).
    // No `environment`: since 1.13 environments are registered (EE PR 457), and
    // `production` on an instance that registered none answers `404 Unknown
    // environment` — which read as "not refused" and kept the admin step green
    // for the wrong reason. Omitted, the default environment is used.
    data: { project_id: projectId, slug: `authz-probe-${Date.now()}` },
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
    await resetSubjectGrants(request, superuserAuth, granted, subject?.id);
  });

  test.afterAll(async ({ request }) => {
    await resetSubjectGrants(request, superuserAuth, granted, subject?.id);
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
        await resetSubjectGrants(request, superuserAuth, granted, subject?.id);
        await grantOnProject(request, "developer");
        expect(await probe(request, subject, flowId)).toEqual({
          read: 200,
          patch: 200,
        });
      });

      await test.step("revoking the assignment returns the flow to absent", async () => {
        await resetSubjectGrants(request, superuserAuth, granted, subject?.id);
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

      // Membership, never length: anything else the container carries is in
      // this list too.
      expect(mine, "the subject's inherited grant is listed").toBeTruthy();
      expect(mine!.domain_type).toBe("project");
      expect(mine!.domain_id).toBe(projectId);
      expect(mine!.role_name).toBe("developer");
      // The resolved actions, which is what makes this endpoint an answer rather
      // than a dump of assignments.
      expect(mine!.actions).toEqual(
        expect.arrayContaining(["read", "write"]),
      );

      const asSubject = await request.get(inheritedAccessPath(flowId), {
        headers: { Authorization: subject.auth },
      });
      // It refuses the way the rest of the model does: absent rather than
      // forbidden, so it cannot be used to confirm a flow exists to the very
      // user it describes. By DETAIL, not only status: a removed route also
      // answers 404 (`Not Found`), and the 1.12 route was removed with no alias —
      // a status-only assertion passed against a route that no longer existed.
      expect(asSubject.status()).toBe(404);
      expect(((await asSubject.json()) as { detail: string }).detail).toBe(
        "Resource not found",
      );
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
        await resetSubjectGrants(request, superuserAuth, granted, subject?.id);
        await grantOnProject(request, "admin");
        const response = await attemptDeploy(request, subject.auth, projectId);
        // NOT asserted as a specific status. With no control plane configured
        // this instance answers 503 "Control Plane deployment is not
        // configured", and asserting that would pin the absence of a control
        // plane rather than the authorization verdict — and would redden the day
        // one is configured. What matters is that authorization did not refuse,
        // and that no other 4xx stood in for it: an unregistered environment's
        // 404 satisfied `not 403` on 1.13 without authorization being asked.
        const status = response.status();
        expect(status, await response.text()).not.toBe(403);
        expect(status >= 400 && status < 500, `a 4xx is not "not refused": ${status}`).toBe(
          false,
        );
      });

      // `developer` is deliberately absent from this test. It reaches the same
      // 503 as `admin` while `inherited-access` does not list `deploy` among its
      // actions, and a 503 cannot distinguish "authorized" from "authorized here,
      // re-checked per flow by a configured plane". Asserting either reading
      // would pin whichever is convenient. Recorded in #1532 instead.
    },
  );

  test(
    "the decision APIs agree with enforcement about an inherited grant, in the project's domain",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      await grantOnProject(request, "developer");

      // Ground truth first, so a failure below cannot be read as "the grant did
      // not apply".
      expect(await probe(request, subject, flowId)).toEqual({
        read: 200,
        patch: 200,
      });

      const domain = `project:${projectId}`;

      await test.step("check, asked about this flow in the project's domain, agrees and names the grant", async () => {
        const onFlow = await authzCheck(
          request,
          superuserAuth,
          subject.id,
          `flow:${flowId}`,
          "read",
          domain,
        );
        expect(onFlow.allowed).toBe(true);
        expect(onFlow.matched_policy).toEqual(
          expect.arrayContaining(["role:developer"]),
        );
      });

      await test.step("me/permissions, in the project's domain, reports read and write", async () => {
        // The route takes no casbin pattern — a resource type and a list of ids
        // plus a domain, which is exactly how the product's client asks.
        const permissions = await mePermissions(
          request,
          subject.auth,
          "flow",
          [flowId],
          domain,
        );
        expect(permissions[flowId]).toEqual(
          expect.arrayContaining(["read", "write"]),
        );
      });

      await test.step("the same two questions in the global domain correctly say no", async () => {
        // Not a disagreement: a project-scoped grant does not cover the whole
        // instance. Asserted because this is the answer #1532 misread, and a
        // client that drops the domain would hide an editable flow.
        const global = await authzCheck(
          request,
          superuserAuth,
          subject.id,
          `flow:${flowId}`,
          "read",
        );
        expect(global.allowed).toBe(false);
        const permissions = await mePermissions(request, subject.auth, "flow", [
          flowId,
        ]);
        expect(permissions[flowId]).toEqual([]);
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

      // `deploy` is a FLOW action. Asked about a flow in the project's domain,
      // the decision API grants it — the same answer `inherited-access` gives.
      const onFlow = await authzCheck(
        request,
        superuserAuth,
        subject.id,
        `flow:${flowId}`,
        "deploy",
        `project:${projectId}`,
      );
      expect(onFlow.allowed).toBe(true);
      expect(onFlow.matched_policy).toEqual(
        expect.arrayContaining(["role:admin", "deploy"]),
      );

      // Asked about the PROJECT it answers no, because no role grants `deploy`
      // on a project object. This is the cell #1532 read as a contradiction;
      // asserted so nobody re-files it.
      const onProject = await authzCheck(
        request,
        superuserAuth,
        subject.id,
        `project:${projectId}`,
        "deploy",
      );
      expect(onProject.allowed).toBe(false);
    },
  );
});
