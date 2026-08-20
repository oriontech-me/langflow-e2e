import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  authzCheck,
  builtinRoleIds,
  cleanupRbacUser,
  createRbacUser,
  effectivePermissions,
  requireRbacInstance,
  shareWithUser,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * The deny matrix, and the decision API that has to agree with it.
 *
 * `rbac-instance-baseline` proved the instance enforces at all, with one deny
 * and one grant. This is the matrix: what a role-less user, a viewer, a
 * developer, an admin, a holder of a direct share and a revoked subject each
 * receive from the same routes — and whether `POST /authz/check`, which is what
 * a client asks before it renders or hides something, gives the same answer. A
 * decision API that drifts from enforcement is worse than none: it is
 * confidently wrong and every client inherits the error.
 *
 * ONE subject for the whole FILE, created once and reset between tests, not one
 * per row and not one per test. EE rate-limits login to five per minute per IP
 * for the whole machine and every created user costs one, so a subject per test
 * makes the directory spend three per run and fail its own second run inside a
 * minute — measured, not predicted.
 *
 * Independence is kept where it matters: `beforeEach` revokes everything the
 * subject holds, through the superuser and without a login, so each test starts
 * from the same no-access state regardless of how the previous one ended. What
 * is shared is the identity, which no assertion depends on.
 *
 * The trap this file is shaped around: `obj` is a casbin OBJECT PATTERN, not a
 * resource type. `flow:*` asks "may you read flows in general" and is answered
 * from role policy alone; `flow:<id>` asks about that resource and also accounts
 * for shares. Asking the first about a specific resource produces a confident
 * wrong answer that looks exactly like a product defect — it did, twice, while
 * this was being measured.
 */

/** A flow id that is well-formed and belongs to nobody. */
const MISSING_FLOW_ID = "00000000-0000-0000-0000-000000000000";

interface Verdicts {
  readOther: number;
  readMissing: number;
  patchOther: number;
  /**
   * Whether the flow under test appears in the subject's listing.
   *
   * A boolean, not the list SIZE. The first version asserted the size and broke
   * the moment the instance held another flow — it was measuring how much
   * unrelated state the container carried, not what the subject may see.
   */
  listsFlow: boolean;
}

async function probe(
  request: APIRequestContext,
  subject: RbacUser,
  flowId: string,
): Promise<Verdicts> {
  const headers = { Authorization: subject.auth };
  const readOther = await request.get(`/api/v1/flows/${flowId}`, { headers });
  const readMissing = await request.get(`/api/v1/flows/${MISSING_FLOW_ID}`, {
    headers,
  });
  const patchOther = await request.patch(`/api/v1/flows/${flowId}`, {
    headers,
    data: { name: `denied-write-${Date.now()}` },
  });
  const list = await request.get("/api/v1/flows/", { headers });
  const listsFlow = ((await list.json()) as { id: string }[]).some(
    (flow) => flow.id === flowId,
  );

  return {
    readOther: readOther.status(),
    readMissing: readMissing.status(),
    patchOther: patchOther.status(),
    listsFlow,
  };
}

const NO_ACCESS: Verdicts = {
  readOther: 404,
  readMissing: 404,
  patchOther: 404,
  listsFlow: false,
};

test.describe("Enterprise — the deny matrix and the decision API", () => {
  let subject: RbacUser;
  /** Everything granted to `subject` since the last reset, for `beforeEach`. */
  const granted: { assignments: string[]; shares: string[] } = {
    assignments: [],
    shares: [],
  };

  test.beforeAll(async ({ request }) => {
    const auth = await getEnterpriseAuthToken(request);
    subject = await createRbacUser(request, auth, "authz-subject");
  });

  test.beforeEach(async ({ request }) => {
    const auth = await getEnterpriseAuthToken(request);
    const headers = { Authorization: auth };
    for (const id of granted.shares.splice(0)) {
      await request.delete(`/api/v1/authz/shares/${id}`, { headers }).catch(() => undefined);
    }
    for (const id of granted.assignments.splice(0)) {
      await request
        .delete(`/api/v1/authz/role-assignments/${id}`, { headers })
        .catch(() => undefined);
    }
  });

  test.afterAll(async ({ request }) => {
    const auth = await getEnterpriseAuthToken(request);
    await cleanupRbacUser(request, auth, subject, granted.assignments);
  });

  test(
    "each subject state receives exactly its row, and a revoked grant returns it to none",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const headers = { Authorization: auth };
      const roles = await builtinRoleIds(request, auth);
      const created = await request.post("/api/v1/flows/", {
        headers,
        data: {
          name: `matrix-owned-${Date.now()}`,
          description: "",
          data: { nodes: [], edges: [] },
        },
      });
      expect(created.status()).toBe(201);
      const flowId = ((await created.json()) as { id: string }).id;

      const assignments = granted.assignments;
      let shareId: string | undefined;

      try {
        await test.step("with no role, a flow it does not own is indistinguishable from one that does not exist", async () => {
          // The security-relevant half. A 403 here would confirm the resource
          // exists to somebody who may not know it — an existence leak that
          // costs nothing to introduce and nothing to notice.
          expect(await probe(request, subject, flowId)).toEqual(NO_ACCESS);
        });

        await test.step("viewer reads but cannot write", async () => {
          assignments.push(
            await assignRole(request, auth, subject.id, roles.viewer),
          );
          expect(await probe(request, subject, flowId)).toEqual({
            readOther: 200,
            readMissing: 404,
            // The assertion that separates viewer from developer. They are
            // identical on creation — both refused — so a matrix built only
            // from create calls would report the two roles as the same thing.
            patchOther: 403,
            listsFlow: true,
          });
        });

        await test.step("developer reads and writes", async () => {
          assignments.push(
            await assignRole(request, auth, subject.id, roles.developer),
          );
          expect(await probe(request, subject, flowId)).toEqual({
            readOther: 200,
            readMissing: 404,
            patchOther: 200,
            listsFlow: true,
          });
        });

        await test.step("admin is not less than developer", async () => {
          assignments.push(
            await assignRole(request, auth, subject.id, roles.admin),
          );
          expect(await probe(request, subject, flowId)).toEqual({
            readOther: 200,
            readMissing: 404,
            patchOther: 200,
            listsFlow: true,
          });
        });

        await test.step("removing every assignment revokes the access", async () => {
          for (const assignmentId of assignments.splice(0)) {
            const removed = await request.delete(
              `/api/v1/authz/role-assignments/${assignmentId}`,
              { headers },
            );
            expect(removed.ok()).toBe(true);
          }
          // A grant that cannot be taken back is not a grant.
          expect(await probe(request, subject, flowId)).toEqual(NO_ACCESS);
        });

        await test.step("a direct read share grants read without granting write", async () => {
          shareId = (
            await shareWithUser(request, auth, "flow", flowId, subject.id, "read")
          ).id;
          granted.shares.push(shareId);
          expect(await probe(request, subject, flowId)).toEqual({
            readOther: 200,
            readMissing: 404,
            patchOther: 403,
            listsFlow: true,
          });
        });

        await test.step("deleting the share revokes it too", async () => {
          const removed = await request.delete(
            `/api/v1/authz/shares/${shareId}`,
            { headers },
          );
          expect(removed.ok()).toBe(true);
          // Deregister as well as delete: leaving it on the tracker would have
          // the next test's reset try to delete it again. Harmless today only
          // because that reset swallows errors, which is not a property to lean on.
          granted.shares.splice(granted.shares.indexOf(shareId!), 1);
          shareId = undefined;
          expect(await probe(request, subject, flowId)).toEqual(NO_ACCESS);
        });
      } finally {
        if (shareId) {
          await request
            .delete(`/api/v1/authz/shares/${shareId}`, { headers })
            .catch(() => undefined);
        }
        await request
          .delete(`/api/v1/flows/${flowId}`, { headers })
          .catch(() => undefined);
        // The subject is shared by the file and torn down in afterAll; what
        // this test must undo is what it granted, which beforeEach also does.
      }
    },
  );

  test(
    "the decision API answers the question it was asked, and agrees with enforcement",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const headers = { Authorization: auth };
      const created = await request.post("/api/v1/flows/", {
        headers,
        data: {
          name: `decision-owned-${Date.now()}`,
          description: "",
          data: { nodes: [], edges: [] },
        },
      });
      expect(created.status()).toBe(201);
      const flowId = ((await created.json()) as { id: string }).id;

      let shareId: string | undefined;

      try {
        shareId = (
          await shareWithUser(request, auth, "flow", flowId, subject.id, "read")
        ).id;
        granted.shares.push(shareId);

        await test.step("ground truth: the subject can read the shared flow", async () => {
          const read = await request.get(`/api/v1/flows/${flowId}`, {
            headers: { Authorization: subject.auth },
          });
          expect(read.status()).toBe(200);
        });

        await test.step("asked about THIS flow, the decision API agrees and names the share", async () => {
          const decision = await authzCheck(
            request,
            auth,
            subject.id,
            `flow:${flowId}`,
            "read",
          );
          expect(decision.allowed).toBe(true);
          // Naming the matched rule is what makes the answer auditable rather
          // than merely correct: it says WHICH grant produced it.
          expect(decision.matched_policy).toEqual(
            expect.arrayContaining([`user:${subject.id}`, `flow:${flowId}`]),
          );
        });

        await test.step("asked about flows in general, it correctly says no", async () => {
          // Not a disagreement. `flow:*` is answered from role policy alone,
          // and this subject holds no role — a client that asks the general
          // question about a specific resource hides things its user can open.
          const general = await authzCheck(
            request,
            auth,
            subject.id,
            "flow:*",
            "read",
          );
          expect(general.allowed).toBe(false);
        });

        await test.step("an unknown pattern is denied, and says so by matching nothing", async () => {
          const unknown = await authzCheck(
            request,
            auth,
            subject.id,
            "banana:*",
            "read",
          );
          expect(unknown.allowed).toBe(false);
          // The empty match is the only signal separating a mis-encoded
          // question from a real refusal — both answer 200 with allowed:false.
          expect(unknown.matched_policy).toEqual([]);
        });

        await test.step("the effective-permissions route agrees with both", async () => {
          expect(
            await effectivePermissions(request, subject.auth, "flow", flowId),
          ).toEqual(["read"]);
        });
      } finally {
        if (shareId) {
          await request
            .delete(`/api/v1/authz/shares/${shareId}`, { headers })
            .catch(() => undefined);
        }
        await request
          .delete(`/api/v1/flows/${flowId}`, { headers })
          .catch(() => undefined);
        // Same: the shared subject outlives this test by design.
      }
    },
  );
});
