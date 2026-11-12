import { expect, test } from "../../../../fixtures/fixtures";
import {
  createApiKey,
  deleteApiKey,
} from "../../../../helpers/auth/create-api-key";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import { createFlow } from "../../../../helpers/flows/create-flow";
import {
  type CreatedProject,
  createProjectViaApi,
} from "../../../../helpers/flows/create-project-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { servedProjectResourcesFollowMcpVisibility } from "../../../../helpers/mcp/mcp-resource-visibility";
import {
  type McpTransportCredential,
  mcpCall,
  mcpHandshake,
} from "../../../../helpers/mcp/mcp-streamable-client";

/**
 * MCP Server — flow-file resources over the MCP protocol (QA-CHECKLIST §14.1
 * resources, re-scoped from §13.1; see docs/mcp/server/mcp-server-resources.md).
 *
 * Companion to mcp-server-protocol.spec.ts (which covers §14.1 tools and notes
 * resources/list is empty for a file-less flow). Langflow exposes the uploaded
 * files of a project's MCP-exposed flows as MCP resources: such a file appears in
 * resources/list and is readable via resources/read by its URI. This spec speaks
 * the real MCP protocol to the generated streamable endpoint of a project it
 * creates, holding two flows with one uploaded file each — `exposed`
 * (`mcp_enabled: true`) and `hidden` (`mcp_enabled: false`):
 *   T1 — resources/list surfaces the exposed file (name + URI) and, on a build
 *        carrying langflow-ai/langflow#16127, not the hidden one.
 *   T2 — resources/read returns the exposed file's content (per-run sentinel)
 *        and, on such a build, refuses the hidden one.
 *
 * #16127 (`1.14.0.dev23` / `1.13.2rc0`) scoped project resources to
 * `mcp_enabled` flows; before it every flow of the project was listed, and this
 * spec's flow — created through the API, so `mcp_enabled: false` — was never
 * exposed, which is what turned T1 red on the daily of 2026-11-11 (#2426).
 *
 * The client side (§13.1) is NOT covered — the MCPTools component / v2 client
 * API expose tools only, no resource surface exists to test.
 *
 * T1 is `@stable` (#948; quarantine of #2426 lifted). T2 is not: it was held
 * back by LE-2012 on 1.12.x and its promotion is outside #2426's scope.
 */

// A resource read can arrive base64-encoded (blob), and on 1.11.0 the blob is
// double-base64. Decode defensively up to two levels so the assertion survives a
// future switch to single-encoding or a plain-text field, without passing on
// garbage (the sentinel is distinctive enough that a wrong decode can't match).
function decodedContentContainsSentinel(
  value: string | undefined,
  sentinel: string,
): boolean {
  if (!value) return false;
  let cur = value;
  for (let depth = 0; depth <= 2; depth++) {
    if (cur.includes(sentinel)) return true;
    const next = Buffer.from(cur, "base64").toString("utf-8");
    if (!next || next === cur) break;
    cur = next;
  }
  return false;
}

interface FlowWithFile {
  flowId: string;
  /** The stored, server-assigned (timestamp-prefixed) file name. */
  fileName: string;
  /** `/api/v1/files/download/{flowId}/{fileName}` — the resource URI's path. */
  resourcePath: string;
  sentinel: string;
}

const runId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const uriPath = (uri: string) => decodeURIComponent(new URL(uri).pathname);

test.describe("MCP Server — flow-file resources protocol", () => {
  let authorization: string;
  // The MCP transport takes an API key and nothing else; `authorization` still
  // authenticates every other API call here (#1522).
  let credential: McpTransportCredential;
  let apiKeyId: string;
  let project: CreatedProject | undefined;
  let streamableUrl: string;
  const flowIds: string[] = [];
  let exposed: FlowWithFile;
  let hidden: FlowWithFile;
  // Whether the instance carries #16127, decided from its declared version.
  let visibilityEnforced: boolean;

  test.beforeAll(async ({ request }) => {
    authorization = await getAuthToken(request);
    const headers = { Authorization: authorization };

    const created = await createApiKey(request, headers, {
      namePrefix: "e2e-mcp-resources",
    });
    credential = { apiKey: created.key };
    apiKeyId = created.id;

    visibilityEnforced = await servedProjectResourcesFollowMcpVisibility(request);

    // A project of its own: in the shared default project another spec's PATCH
    // of the MCP settings could flip `hidden` on and fake a product change.
    project = await createProjectViaApi(request, headers, {
      namePrefix: "e2emcpres",
      description: "MCP flow-file resources (#2426)",
    });
    streamableUrl = `/api/v1/mcp/project/${project.projectId}/streamable`;

    const flowWithFile = async (role: string): Promise<FlowWithFile> => {
      const flowId = await createFlow(
        request,
        {
          name: `MCP resources ${role} ${runId()}`,
          description: "Holds one uploaded file for the MCP resources spec",
          data: { nodes: [], edges: [] },
          is_component: false,
          folder_id: project!.projectId,
        },
        { headers },
      );
      flowIds.push(flowId);

      const sentinel = `mcp-res-${role}-${runId()}`;
      const uploadRes = await request.post(`/api/v1/files/upload/${flowId}`, {
        headers,
        multipart: {
          file: {
            name: `resource-${role}.txt`,
            mimeType: "text/plain",
            buffer: Buffer.from(sentinel, "utf-8"),
          },
        },
      });
      expect(uploadRes.ok(), `upload into the ${role} flow failed: ${uploadRes.status()}`).toBeTruthy();
      // The server prepends a timestamp to the stored name — capture the real
      // one. Only the name is taken: `file_path` carries the storage folder
      // (`flow-<id>/` since LE-3242), which the resource URI does not.
      const filePath = (await uploadRes.json()).file_path as string;
      const fileName = filePath.split("/").pop() ?? "";
      expect(fileName, "upload response must carry a stored file name").toBeTruthy();
      return {
        flowId,
        fileName,
        resourcePath: `/api/v1/files/download/${flowId}/${fileName}`,
        sentinel,
      };
    };

    exposed = await flowWithFile("exposed");
    hidden = await flowWithFile("hidden");

    // Both states are written, so the control does not rest on the API's
    // creation default for `mcp_enabled`.
    const patchRes = await request.patch(`/api/v1/mcp/project/${project.projectId}`, {
      headers,
      data: {
        settings: [
          {
            id: exposed.flowId,
            mcp_enabled: true,
            action_name: `e2e_res_exposed_${Date.now().toString(36)}`,
            action_description: "E2E MCP resources (exposed)",
          },
          {
            id: hidden.flowId,
            mcp_enabled: false,
            action_name: `e2e_res_hidden_${Date.now().toString(36)}`,
            action_description: "E2E MCP resources (hidden)",
          },
        ],
      },
    });
    expect(patchRes.ok(), `PATCH mcp/project answered ${patchRes.status()}: ${await patchRes.text()}`).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    // Playwright forbids reusing the beforeAll request here; use this hook's own.
    const headers = { Authorization: authorization };
    const failures: string[] = [];
    for (const id of flowIds) {
      await deleteFlow(request, id, { headers }).catch((e) => failures.push(`flow ${id}: ${e}`));
    }
    if (project) {
      await project.deleteProject(request).catch((e) => failures.push(`project ${project?.projectId}: ${e}`));
    }
    if (apiKeyId) {
      await deleteApiKey(request, apiKeyId, headers).catch((e) => failures.push(`api key ${apiKeyId}: ${e}`));
    }
    expect(failures, `teardown left state behind: ${failures.join(" | ")}`).toEqual([]);
  });

  /** Records, on the report, that a #16127 assertion was not applicable. */
  function noteVisibilityNotEnforced(what: string) {
    test.info().annotations.push({
      type: "not-applicable",
      description:
        `${what}: this build predates langflow-ai/langflow#16127 (< 1.14.0.dev23 / < 1.13.2rc0), ` +
        "where a project MCP server lists every flow's files by design.",
    });
  }

  test(
    "resources/list surfaces the uploaded flow file as a resource",
    { tag: ["@stable", "@regression", "@api", "@mcp"] },
    async ({ request }) => {
      await mcpHandshake(request, streamableUrl, credential);

      // resources/list can lag a moment behind the upload — poll until the
      // exposed flow's file appears, matching on its exact URI path, and keep
      // the response that proved it.
      let listed: Array<{ name: string; uri: string }> = [];
      let matched: { name: string; uri: string } | undefined;

      await test.step("the exposed flow's file is listed under its download URI", async () => {
        await expect
          .poll(
            async () => {
              // Re-dialled inside `mcpCall`, around the POST only: a dropped socket is
              // retried once, a non-2xx answer is never re-sent.
              const resp = await mcpCall(request, streamableUrl, credential, "resources/list", {}, 2, {
                retryDroppedConnection: true,
              });
              listed = (resp.result?.resources ?? []) as Array<{ name: string; uri: string }>;
              matched = listed.find((r) => uriPath(r.uri) === exposed.resourcePath);
              return Boolean(matched);
            },
            {
              timeout: 30000,
              intervals: [500, 1000, 3000],
              message: `resources/list never listed ${exposed.resourcePath}`,
            },
          )
          .toBeTruthy();
        expect(matched?.name).toBe(exposed.fileName);
      });

      await test.step("the hidden flow's file is absent from the same response", async () => {
        if (!visibilityEnforced) {
          noteVisibilityNotEnforced("the hidden-file absence check was not run");
          return;
        }
        // Both files were uploaded before the first poll, so the response that
        // lists the exposed one is past any listing lag for the hidden one.
        const hiddenPrefix = `/api/v1/files/download/${hidden.flowId}/`;
        const leaked = listed.filter((r) => uriPath(r.uri).startsWith(hiddenPrefix)).map((r) => r.uri);
        expect(
          leaked,
          "a project MCP server listed a file of a flow that is not mcp_enabled (langflow-ai/langflow#16127)",
        ).toEqual([]);
      });
    },
  );

  // NOT @stable — held back by LE-2012 on 1.12.x (resources/read raised
  // AttributeError 'str' has no attribute 'hex'); it passes on 1.14.0.dev25, but
  // promotion is outside #2426's scope. Kept as a regression guard.
  test(
    "resources/read returns the uploaded file content by URI",
    { tag: ["@regression", "@api", "@mcp"] },
    async ({ request }) => {
      // handle_read_resource only consumes the URI's last two path segments, so a
      // host built from the test's base URL is accepted regardless of the host the
      // server uses in the listed URI.
      const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:7860/";

      await mcpHandshake(request, streamableUrl, credential);

      await test.step("the exposed flow's file is served with its content", async () => {
        const resp = await mcpCall(request, streamableUrl, credential, "resources/read", {
          uri: new URL(exposed.resourcePath, baseUrl).toString(),
        }, 3);

        expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
        const contents = (resp.result?.contents ?? []) as Array<{
          uri: string;
          text?: string;
          blob?: string;
        }>;
        expect(contents.length).toBeGreaterThan(0);

        const content = contents[0];
        expect(uriPath(content.uri)).toBe(exposed.resourcePath);
        expect(
          decodedContentContainsSentinel(content.text ?? content.blob, exposed.sentinel),
          "resource content must contain the uploaded sentinel",
        ).toBe(true);
      });

      await test.step("the hidden flow's file is refused", async () => {
        if (!visibilityEnforced) {
          noteVisibilityNotEnforced("the hidden-file read refusal was not checked");
          return;
        }
        const resp = await mcpCall(request, streamableUrl, credential, "resources/read", {
          uri: new URL(hidden.resourcePath, baseUrl).toString(),
        }, 4);

        expect(
          resp.result,
          `a project MCP server served a file of a flow that is not mcp_enabled: ${JSON.stringify(resp.result)}`,
        ).toBeUndefined();
        expect(resp.error?.message).toBe("Resource not found or access denied");
      });
    },
  );
});
