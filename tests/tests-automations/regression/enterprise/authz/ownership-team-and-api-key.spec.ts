import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  addTeamMember,
  assignRole,
  builtinRoleIds,
  resetSubjectGrants,
  createApiKey,
  getSharedRbacSubject,
  createTeam,
  removeTeamMember,
  requireRbacInstance,
  shareWithTeam,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * The three grant paths the role matrix cannot reach: ownership, team
 * membership, and an API key.
 *
 * Each answers a different question. Ownership asks whether access survives the
 * role it was created under. A team share asks whether an indirect grant is a
 * real one, and whether both of the operator's revocation levers work. The API
 * key asks the security question — whether a credential any user can mint carries
 * more than the user who minted it.
 *
 * One subject for the file, created once and reset between tests through the
 * superuser. EE rate-limits login to five per minute per IP for the whole
 * machine and counts every attempt, failed ones included; a subject per test
 * makes this directory fail its own second run inside a minute.
 */

function scratchFlow(name: string) {
  return { name, description: "", data: { nodes: [], edges: [] } };
}

test.describe("Enterprise — ownership, team membership and API keys", () => {
  let subject: RbacUser;
  const granted: { assignments: string[]; shares: string[] } = {
    assignments: [],
    shares: [],
  };

  test.beforeAll(async ({ request }) => {
    const auth = await getEnterpriseAuthToken(request);
    subject = await getSharedRbacSubject(request, auth);
  });

  test.beforeEach(async ({ request }) => {
    const auth = await getEnterpriseAuthToken(request);
    await resetSubjectGrants(request, auth, granted);
  });

  test.afterAll(async ({ request }) => {
    // Reset, never delete. The subject is shared across this directory and
    // cached between runs; deleting it would cost a fresh login next time,
    // which is the whole reason it is shared.
    const auth = await getEnterpriseAuthToken(request);
    await resetSubjectGrants(request, auth, granted);
  });

  test(
    "ownership outlives the role it was created under",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const headers = { Authorization: auth };
      const roles = await builtinRoleIds(request, auth);
      const subjectHeaders = { Authorization: subject.auth };
      let flowId: string | undefined;

      try {
        await test.step("with developer, the subject creates and modifies its own flow", async () => {
          granted.assignments.push(
            await assignRole(request, auth, subject.id, roles.developer),
          );
          const created = await request.post("/api/v1/flows/", {
            headers: subjectHeaders,
            data: scratchFlow(`owned-${Date.now()}`),
          });
          expect(created.status()).toBe(201);
          flowId = ((await created.json()) as { id: string }).id;

          const patched = await request.patch(`/api/v1/flows/${flowId}`, {
            headers: subjectHeaders,
            data: { name: `owned-renamed-${Date.now()}` },
          });
          expect(patched.status()).toBe(200);
        });

        await test.step("with the role removed, the owner keeps full access", async () => {
          for (const id of granted.assignments.splice(0)) {
            const removed = await request.delete(
              `/api/v1/authz/role-assignments/${id}`,
              { headers },
            );
            expect(removed.ok()).toBe(true);
          }

          // Almost certainly intended — people keep what they made — but it is
          // a governance fact nothing stated before this spec: removing a role
          // does NOT remove access to what was created under it. An operator
          // offboarding a user has not revoked their existing flows. This must
          // fail the day it changes, in either direction.
          const read = await request.get(`/api/v1/flows/${flowId}`, {
            headers: subjectHeaders,
          });
          expect(read.status()).toBe(200);

          const write = await request.patch(`/api/v1/flows/${flowId}`, {
            headers: subjectHeaders,
            data: { name: `owned-after-revoke-${Date.now()}` },
          });
          expect(write.status()).toBe(200);

          const list = await request.get("/api/v1/flows/", {
            headers: subjectHeaders,
          });
          expect(
            ((await list.json()) as { id: string }[]).some(
              (flow) => flow.id === flowId,
            ),
          ).toBe(true);
        });
      } finally {
        if (flowId) {
          await request
            .delete(`/api/v1/flows/${flowId}`, { headers })
            .catch(() => undefined);
        }
      }
    },
  );

  test(
    "a team share grants read, and either revocation lever takes it back",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const headers = { Authorization: auth };
      const subjectHeaders = { Authorization: subject.auth };
      const created = await request.post("/api/v1/flows/", {
        headers,
        data: scratchFlow(`team-owned-${Date.now()}`),
      });
      expect(created.status()).toBe(201);
      const flowId = ((await created.json()) as { id: string }).id;

      const team = await createTeam(request, auth, "squad");
      let shareId: string | undefined;
      const readStatus = async () =>
        (await request.get(`/api/v1/flows/${flowId}`, { headers: subjectHeaders }))
          .status();

      try {
        await addTeamMember(request, auth, team.id, subject.id);

        await test.step("membership alone grants nothing", async () => {
          expect(await readStatus()).toBe(404);
        });

        await test.step("the team share grants read but not write", async () => {
          shareId = (
            await shareWithTeam(request, auth, "flow", flowId, team.id, "read")
          ).id;
          granted.shares.push(shareId);
          expect(await readStatus()).toBe(200);

          const write = await request.patch(`/api/v1/flows/${flowId}`, {
            headers: subjectHeaders,
            data: { name: `team-write-${Date.now()}` },
          });
          expect(write.status()).toBe(403);
        });

        await test.step("removing the membership revokes it, with the share intact", async () => {
          // The lever an operator is most likely to reach for when someone
          // changes team, and the one a share-only revocation test would miss.
          await removeTeamMember(request, auth, team.id, subject.id);
          expect(await readStatus()).toBe(404);
        });

        await test.step("re-adding the membership restores it", async () => {
          await addTeamMember(request, auth, team.id, subject.id);
          expect(await readStatus()).toBe(200);
        });

        await test.step("deleting the share revokes it too", async () => {
          const removed = await request.delete(
            `/api/v1/authz/shares/${shareId}`,
            { headers },
          );
          expect(removed.ok()).toBe(true);
          granted.shares.splice(granted.shares.indexOf(shareId!), 1);
          shareId = undefined;
          expect(await readStatus()).toBe(404);
        });
      } finally {
        if (shareId) {
          await request
            .delete(`/api/v1/authz/shares/${shareId}`, { headers })
            .catch(() => undefined);
        }
        await request
          .delete(`/api/v1/authz/teams/${team.id}`, { headers })
          .catch(() => undefined);
        await request
          .delete(`/api/v1/flows/${flowId}`, { headers })
          .catch(() => undefined);
      }
    },
  );

  test(
    "an API key carries its owner's permissions and never exceeds them",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const headers = { Authorization: auth };
      const roles = await builtinRoleIds(request, auth);
      const subjectHeaders = { Authorization: subject.auth };

      const foreign = await request.post("/api/v1/flows/", {
        headers,
        data: scratchFlow(`key-foreign-${Date.now()}`),
      });
      expect(foreign.status()).toBe(201);
      const foreignId = ((await foreign.json()) as { id: string }).id;

      let ownedId: string | undefined;
      let keyId: string | undefined;

      try {
        // Give the subject something of its own, then take the role away, so
        // the key is minted by an account holding ownership and nothing else.
        const assignment = await assignRole(
          request,
          auth,
          subject.id,
          roles.developer,
        );
        const owned = await request.post("/api/v1/flows/", {
          headers: subjectHeaders,
          data: scratchFlow(`key-owned-${Date.now()}`),
        });
        expect(owned.status()).toBe(201);
        ownedId = ((await owned.json()) as { id: string }).id;
        const removed = await request.delete(
          `/api/v1/authz/role-assignments/${assignment}`,
          { headers },
        );
        expect(removed.ok()).toBe(true);

        const key = await createApiKey(request, subject.auth, `probe-${Date.now()}`);
        keyId = key.id;

        // No Authorization header anywhere below. Sending both would let a pass
        // mean the bearer token did the work — the assertion inverted.
        const viaKey = { "x-api-key": key.secret };

        await test.step("it reaches what its owner owns", async () => {
          const read = await request.get(`/api/v1/flows/${ownedId}`, {
            headers: viaKey,
          });
          expect(read.status()).toBe(200);
        });

        await test.step("and nothing its owner cannot reach", async () => {
          // The escalation this test exists for: a key that answered otherwise
          // would be a path around the whole authorization model, mintable by
          // any user who can press "create key", and invisible to every test
          // that only ever authenticates with a bearer token.
          expect(
            (await request.get(`/api/v1/flows/${foreignId}`, { headers: viaKey }))
              .status(),
          ).toBe(404);
          expect(
            (
              await request.post("/api/v1/flows/", {
                headers: viaKey,
                data: scratchFlow(`key-denied-${Date.now()}`),
              })
            ).status(),
          ).toBe(403);
          expect(
            (await request.get("/api/v1/authz/admin/users", { headers: viaKey }))
              .status(),
          ).toBe(403);
        });
      } finally {
        if (keyId) {
          await request
            .delete(`/api/v1/api_key/${keyId}`, { headers: subjectHeaders })
            .catch(() => undefined);
        }
        for (const id of [ownedId, foreignId]) {
          if (id) {
            await request
              .delete(`/api/v1/flows/${id}`, { headers })
              .catch(() => undefined);
          }
        }
      }
    },
  );
});
