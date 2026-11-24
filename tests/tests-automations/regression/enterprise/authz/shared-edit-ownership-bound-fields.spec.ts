import { randomUUID } from "node:crypto";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { expect, test } from "../../../../fixtures/fixtures";
import { getEnterpriseAuthToken } from "../../../../helpers/enterprise/enterprise-auth";
import {
  assignRole,
  builtinRoleIds,
  getProjectOwnedBy,
  getSharedRbacSubject,
  getSubjectNonPersonalProject,
  requireRbacInstance,
  resetSubjectGrants,
  shareWithUser,
  type RbacUser,
} from "../../../../helpers/enterprise/rbac";

/**
 * A shared editor cannot change the fields that decide who owns a flow and
 * where it lives (#2554).
 *
 * On Enterprise with RBAC a non-owner can hold real write access to a flow —
 * a `write` share, or `developer` on its project. The flow write paths then
 * refuse that actor any CHANGE to `a2a_enabled`, `a2a_card_overrides`,
 * `folder_id`, `fs_path` and `user_id`, with a `403` naming the field. On OSS
 * the same guards are unreachable: a non-owner gets `404` on the flow before
 * any of them runs (#2553).
 *
 * Every refusal is paired with a request that succeeds — the editor's own
 * `name` edit, or the owner's identical request — because a lone `403` is
 * equally consistent with "the guard works" and "the body was invalid".
 *
 * The editor is the subject shared by the whole `authz/` directory: created
 * once, reset before each test through the superuser, never deleted. EE allows
 * five logins per minute per IP for the whole machine.
 */

const NOT_OWNER = {
  a2aEnabled: "Cannot change a2a_enabled of a flow you do not own.",
  a2aCardOverrides: "Cannot change a2a_card_overrides of a flow you do not own.",
  folder: "Cannot change folder of a flow you do not own.",
  fsPath: "Cannot change fs_path of a flow you do not own.",
  ownership: "Cannot transfer ownership of a flow you do not own.",
} as const;

interface FlowState {
  id: string;
  name: string;
  description: string | null;
  data: Record<string, unknown> | null;
  user_id: string;
  folder_id: string | null;
  workspace_id: string | null;
  fs_path: string | null;
  flow_type: string | null;
  a2a_enabled: boolean;
  a2a_card_overrides: Record<string, unknown> | null;
}

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

async function createFlowIn(
  request: APIRequestContext,
  auth: string,
  folderId: string,
): Promise<FlowState> {
  const response = await request.post("/api/v1/flows/", {
    headers: { Authorization: auth },
    data: {
      name: uniqueName("shared-edit"),
      description: "",
      data: { nodes: [], edges: [] },
      folder_id: folderId,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as FlowState;
}

async function createProject(request: APIRequestContext, auth: string): Promise<string> {
  const response = await request.post("/api/v1/projects/", {
    headers: { Authorization: auth },
    data: { name: uniqueName("shared-edit-target"), description: "" },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

async function readFlow(
  request: APIRequestContext,
  auth: string,
  flowId: string,
): Promise<FlowState> {
  const response = await request.get(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: auth },
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as FlowState;
}

function patchFlow(
  request: APIRequestContext,
  auth: string,
  flowId: string,
  data: Record<string, unknown>,
): Promise<APIResponse> {
  return request.patch(`/api/v1/flows/${flowId}`, {
    headers: { Authorization: auth },
    data,
  });
}

/**
 * `PUT` is the upsert path, a different function from `PATCH` with its own copy
 * of the guards. The body is the flow as the caller holds it plus `changes`, so
 * a refusal can only be about `changes`.
 */
function putFlow(
  request: APIRequestContext,
  auth: string,
  flow: FlowState,
  changes: Record<string, unknown>,
): Promise<APIResponse> {
  return request.put(`/api/v1/flows/${flow.id}`, {
    headers: { Authorization: auth },
    data: { name: flow.name, description: flow.description, data: flow.data, ...changes },
  });
}

async function expectNotOwnerRefusal(response: APIResponse, detail: string): Promise<void> {
  const text = await response.text();
  expect(response.status(), text).toBe(403);
  expect((JSON.parse(text) as { detail?: unknown }).detail, text).toBe(detail);
}

test.describe("Enterprise — a shared editor cannot change a flow's ownership-bound fields", () => {
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
    await resetSubjectGrants(request, auth, granted, subject?.id);
  });

  test.afterAll(async ({ request }) => {
    // Reset, never delete: the subject is shared across this directory and
    // cached between runs.
    const auth = await getEnterpriseAuthToken(request);
    await resetSubjectGrants(request, auth, granted, subject?.id);
  });

  test(
    "a shared editor cannot publish the owner's flow as an A2A agent, whichever grant gave it write access",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const ownerProject = await getProjectOwnedBy(request, auth);
      const created = await createFlowIn(request, auth, ownerProject);

      try {
        await test.step("before any grant, the editor cannot reach the flow", async () => {
          const response = await patchFlow(request, subject.auth, created.id, {
            name: uniqueName("before-share"),
          });
          expect(response.status(), await response.text()).toBe(404);
        });

        await test.step("a write share gives the editor real write access", async () => {
          granted.shares.push(
            (await shareWithUser(request, auth, "flow", created.id, subject.id, "write")).id,
          );
          const response = await patchFlow(request, subject.auth, created.id, {
            name: uniqueName("renamed-by-editor"),
          });
          expect(response.status(), await response.text()).toBe(200);
        });

        await test.step("the editor's PATCH cannot publish the flow or rewrite its card", async () => {
          await expectNotOwnerRefusal(
            await patchFlow(request, subject.auth, created.id, {
              flow_type: "agent",
              a2a_enabled: true,
            }),
            NOT_OWNER.a2aEnabled,
          );
          await expectNotOwnerRefusal(
            await patchFlow(request, subject.auth, created.id, {
              a2a_card_overrides: { name: "taken-over" },
            }),
            NOT_OWNER.a2aCardOverrides,
          );
        });

        await test.step("the editor's PUT (upsert) refuses the same two changes", async () => {
          const held = await readFlow(request, subject.auth, created.id);
          await expectNotOwnerRefusal(
            await putFlow(request, subject.auth, held, { a2a_enabled: true }),
            NOT_OWNER.a2aEnabled,
          );
          await expectNotOwnerRefusal(
            await putFlow(request, subject.auth, held, {
              a2a_card_overrides: { name: "taken-over" },
            }),
            NOT_OWNER.a2aCardOverrides,
          );
        });

        await test.step("the guard refuses a change, not the field: the current value is accepted", async () => {
          const response = await patchFlow(request, subject.auth, created.id, {
            a2a_enabled: false,
          });
          expect(response.status(), await response.text()).toBe(200);
        });

        await test.step("the owner reads the flow back unpublished", async () => {
          const flow = await readFlow(request, auth, created.id);
          expect(flow.a2a_enabled).toBe(false);
          expect(flow.flow_type).toBe(created.flow_type);
          expect(flow.a2a_card_overrides).toEqual(created.a2a_card_overrides);
        });

        await test.step("a project role refuses the same change: the rule is the actor, not the share", async () => {
          const shareId = granted.shares.pop();
          const revoked = await request.delete(`/api/v1/authz/shares/${shareId}`, {
            headers: { Authorization: auth },
          });
          expect(revoked.ok(), await revoked.text()).toBe(true);
          const withoutShare = await patchFlow(request, subject.auth, created.id, {
            name: uniqueName("after-revoke"),
          });
          expect(withoutShare.status(), await withoutShare.text()).toBe(404);

          const roles = await builtinRoleIds(request, auth);
          granted.assignments.push(
            await assignRole(request, auth, subject.id, roles.developer, {
              domain_type: "project",
              domain_id: ownerProject,
            }),
          );
          const inherited = await patchFlow(request, subject.auth, created.id, {
            name: uniqueName("renamed-through-project"),
          });
          expect(inherited.status(), await inherited.text()).toBe(200);
          await expectNotOwnerRefusal(
            await patchFlow(request, subject.auth, created.id, { a2a_enabled: true }),
            NOT_OWNER.a2aEnabled,
          );
        });

        await test.step("positive control: the owner's identical PATCH publishes the flow", async () => {
          const response = await patchFlow(request, auth, created.id, {
            flow_type: "agent",
            a2a_enabled: true,
          });
          expect(response.status(), await response.text()).toBe(200);
          expect((await readFlow(request, auth, created.id)).a2a_enabled).toBe(true);
        });
      } finally {
        await request
          .delete(`/api/v1/flows/${created.id}`, { headers: { Authorization: auth } })
          .catch(() => undefined);
      }
    },
  );

  test(
    "a shared editor cannot move the owner's flow to another project or storage path",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const ownerProject = await getProjectOwnedBy(request, auth);
      const editorProject = await getSubjectNonPersonalProject(request, auth, subject);
      const targetProject = await createProject(request, auth);
      try {
        const created = await createFlowIn(request, auth, ownerProject);

        try {
          granted.shares.push(
            (await shareWithUser(request, auth, "flow", created.id, subject.id, "write")).id,
          );

          await test.step("the editor's PATCH cannot move the flow into another of the owner's projects", async () => {
            await expectNotOwnerRefusal(
              await patchFlow(request, subject.auth, created.id, { folder_id: targetProject }),
              NOT_OWNER.folder,
            );
          });

          await test.step("nor into a project the editor owns", async () => {
            await expectNotOwnerRefusal(
              await patchFlow(request, subject.auth, created.id, { folder_id: editorProject }),
              NOT_OWNER.folder,
            );
          });

          await test.step("nor change where the flow is written on disk", async () => {
            await expectNotOwnerRefusal(
              await patchFlow(request, subject.auth, created.id, {
                fs_path: "shared-edit-takeover.json",
              }),
              NOT_OWNER.fsPath,
            );
          });

          await test.step("the editor's PUT (upsert) refuses the same two changes", async () => {
            const held = await readFlow(request, subject.auth, created.id);
            await expectNotOwnerRefusal(
              await putFlow(request, subject.auth, held, { folder_id: targetProject }),
              NOT_OWNER.folder,
            );
            await expectNotOwnerRefusal(
              await putFlow(request, subject.auth, held, { fs_path: "shared-edit-takeover.json" }),
              NOT_OWNER.fsPath,
            );
          });

          await test.step("a workspace_id in the editor's PATCH is discarded, not refused", async () => {
            // The route overwrites workspace_id with the workspace it resolves from
            // the OWNER's folder before `_patch_flow` compares it, so the
            // "Cannot change workspace" guard is unreachable here. A 403 would mean
            // the route stopped overwriting it: not a regression, but this spec
            // then measures something else and must be updated.
            const response = await patchFlow(request, subject.auth, created.id, {
              workspace_id: randomUUID(),
            });
            expect(
              response.status(),
              `PATCH workspace_id: the route no longer discards it — ${await response.text()}`,
            ).toBe(200);
          });

          await test.step("the owner reads the flow back where it was", async () => {
            const flow = await readFlow(request, auth, created.id);
            expect(flow.folder_id).toBe(ownerProject);
            expect(flow.fs_path).toBe(created.fs_path);
            expect(flow.workspace_id).toBe(created.workspace_id);
          });

          await test.step("positive control: the owner's identical PATCH moves the flow", async () => {
            const response = await patchFlow(request, auth, created.id, {
              folder_id: targetProject,
            });
            expect(response.status(), await response.text()).toBe(200);
            expect((await readFlow(request, auth, created.id)).folder_id).toBe(targetProject);
          });
        } finally {
          await request
            .delete(`/api/v1/flows/${created.id}`, { headers: { Authorization: auth } })
            .catch(() => undefined);
        }
      } finally {
        // After the flow's own cleanup, so a broken flow delete is not hidden by
        // the project taking the flow with it.
        await request
          .delete(`/api/v1/projects/${targetProject}`, { headers: { Authorization: auth } })
          .catch(() => undefined);
      }
    },
  );

  test(
    "a shared editor cannot take ownership of the flow",
    { tag: ["@enterprise", "@api", "@regression", "@authz"] },
    async ({ request }) => {
      const auth = await getEnterpriseAuthToken(request);
      await requireRbacInstance(request, auth);

      const ownerProject = await getProjectOwnedBy(request, auth);
      const created = await createFlowIn(request, auth, ownerProject);
      const owner = created.user_id;

      try {
        granted.shares.push(
          (await shareWithUser(request, auth, "flow", created.id, subject.id, "write")).id,
        );
        const held = await readFlow(request, subject.auth, created.id);

        await test.step("the editor's PUT cannot hand the flow to the editor", async () => {
          await expectNotOwnerRefusal(
            await putFlow(request, subject.auth, held, { user_id: subject.id }),
            NOT_OWNER.ownership,
          );
        });

        await test.step("the same PUT naming the current owner is accepted", async () => {
          // Differs from the refused request only in that one value, so it is
          // also the control that the PUT body is valid.
          const response = await putFlow(request, subject.auth, held, { user_id: owner });
          expect(response.status(), await response.text()).toBe(200);
        });

        await test.step("a user_id in the editor's PATCH is discarded, not refused", async () => {
          // `FlowUpdate`, the PATCH body model, has no `user_id` field: the value
          // is dropped while the request is parsed, before the ownership guard
          // runs. A 403 would mean the field was added and the guard became
          // reachable — this spec must then be updated.
          const response = await patchFlow(request, subject.auth, created.id, {
            user_id: subject.id,
          });
          expect(
            response.status(),
            `PATCH user_id: no longer discarded — ${await response.text()}`,
          ).toBe(200);
        });

        await test.step("the owner is still the owner", async () => {
          expect((await readFlow(request, auth, created.id)).user_id).toBe(owner);
        });
      } finally {
        await request
          .delete(`/api/v1/flows/${created.id}`, { headers: { Authorization: auth } })
          .catch(() => undefined);
      }
    },
  );
});
