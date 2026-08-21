import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  getSharedRbacSubject,
  readSharedWithMe,
  requireRbacInstance,
  resetSubjectGrants,
  shareCapability,
  shareTargets,
  shareWithUser,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * The RECIPIENT's side of a share, and who may be offered one.
 *
 * `ownership-team-and-api-key` and `deny-matrix-and-decision-api` both assert what
 * a share lets its target DO. Neither asserts the target can FIND it, and nothing
 * asks who the share picker is allowed to offer — which is where an enumeration
 * problem would live.
 *
 * Measured, `share-targets` is deliberately built against enumeration, and that is
 * the property this spec exists to pin: `search` is REQUIRED with a two-character
 * minimum, so there is no "list everybody" call, and a caller who cannot manage
 * the resource's shares gets `404` rather than an empty list. A regression that
 * made `search` optional would turn the endpoint into a user-directory dump and
 * would not look like a failure anywhere — the picker would just be more helpful.
 *
 * One pair is worth reading as coherent rather than inconsistent: `capability`
 * answers `200 {can_manage_shares: false}` to the same caller `share-targets`
 * answers `404`. The capability flag is a question about the CALLER, safe to
 * answer, while the target list is a question about the RESOURCE, which a
 * non-manager must not learn about. A client needs the first to render and must
 * not be given the second.
 */

test.describe("Enterprise — share discovery and the share picker", () => {
  let superuserAuth: string;
  let subject: RbacUser;
  let flowId: string;
  const granted: { assignments: string[]; shares: string[] } = {
    assignments: [],
    shares: [],
  };

  test.beforeAll(async ({ request }) => {
    superuserAuth = await getEnterpriseAuthToken(request);
    await requireRbacInstance(request, superuserAuth);
    subject = await getSharedRbacSubject(request, superuserAuth);

    const flow = await request.post("/api/v1/flows/", {
      headers: { Authorization: superuserAuth },
      data: {
        name: `authz-share-discovery-${Date.now()}`,
        description: "",
        data: { nodes: [], edges: [] },
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
  });

  test(
    "a share reaches the recipient's list, and revoking it takes it away",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      await test.step("before the share, the flow is not in the subject's list", async () => {
        const items = await readSharedWithMe(request, subject.auth);
        // Membership, not count: the instance carries other shares and this
        // subject is shared across the whole directory.
        expect(items.map((item) => item.resource_id)).not.toContain(flowId);
      });

      await test.step("after the share, it is listed with its owner and level", async () => {
        const share = await shareWithUser(
          request,
          superuserAuth,
          "flow",
          flowId,
          subject.id,
          "read",
        );
        granted.shares.push(share.id);

        const mine = (await readSharedWithMe(request, subject.auth)).find(
          (item) => item.resource_id === flowId,
        );
        // A share that grants access but never surfaces is one nobody uses, so
        // the entry has to carry enough to render: what it is, whose it is, and
        // what the recipient may do with it.
        expect(mine, "the shared flow appears in shared-with-me").toBeTruthy();
        expect(mine!.resource_type).toBe("flow");
        expect(mine!.owner_username).toBeTruthy();
        expect(mine!.permission_level).toBe("read");
      });

      await test.step("after revoking, it is gone", async () => {
        await resetSubjectGrants(request, superuserAuth, granted);
        const items = await readSharedWithMe(request, subject.auth);
        // The worse half of the pair: a lingering entry is a dead link to a
        // resource the recipient can no longer open.
        expect(items.map((item) => item.resource_id)).not.toContain(flowId);
      });
    },
  );

  test(
    "the share picker cannot be used to enumerate the directory",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      // The subject's username is generated as `authz-shared-<ts>-<n>`, so a
      // prefix of it is a meaningful search term without hardcoding an identity
      // the fixture regenerates.
      const term = subject.username.slice(0, 5);

      await test.step("the owner gets matching targets", async () => {
        const response = await shareTargets(
          request,
          superuserAuth,
          "flow",
          flowId,
          term,
        );
        expect(response.status()).toBe(200);
        const body = (await response.json()) as {
          users: { id: string; username: string }[];
          teams: unknown[];
        };
        expect(body.users.map((user) => user.id)).toContain(subject.id);
      });

      await test.step("a non-manager is told the resource is absent, not shown a list", async () => {
        const response = await shareTargets(
          request,
          subject.auth,
          "flow",
          flowId,
          term,
        );
        // Absent rather than forbidden, the convention the rest of the model
        // uses — and never an empty list, which would confirm the flow exists.
        expect(response.status()).toBe(404);
      });

      await test.step("there is no call that lists everybody", async () => {
        const response = await shareTargets(
          request,
          superuserAuth,
          "flow",
          flowId,
          "",
        );
        // THE assertion of this test. If `search` becomes optional, or its
        // minimum is dropped, this endpoint turns into a directory dump — and
        // nothing else in the suite would notice, because the picker would
        // simply return more.
        expect(response.status()).toBe(422);
        expect(await response.text()).toContain("at least 2 characters");
      });
    },
  );

  test(
    "the capability flag answers about the caller, where the target list refuses",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      expect(
        await shareCapability(request, superuserAuth, "flow", flowId),
      ).toBe(true);
      // Answered, not refused — a client needs this to decide whether to render
      // the share control at all, and it discloses nothing about the resource.
      expect(await shareCapability(request, subject.auth, "flow", flowId)).toBe(
        false,
      );
    },
  );
});
