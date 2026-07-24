import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";
import {
  createRunnableChatFlowViaApi,
  type RunnableChatFlow,
} from "../../../../helpers/flows/create-runnable-chat-flow-via-api";
import { deleteFlow } from "../../../../helpers/flows/delete-flow";
import { mcpCall, mcpHandshake } from "../../../../helpers/mcp/mcp-streamable-client";

/**
 * MCP Server — flow-file resources over the MCP protocol (QA-CHECKLIST §14.1
 * resources, re-scoped from §13.1; see docs/mcp/server/mcp-server-resources.md).
 *
 * Companion to mcp-server-protocol.spec.ts (which covers §14.1 tools and notes
 * resources/list is empty for a file-less flow). Langflow exposes a flow's
 * uploaded files as MCP resources: a file uploaded into a project flow appears
 * in resources/list and is readable via resources/read by its URI. This spec
 * speaks the real MCP protocol to the project's generated streamable endpoint:
 *   T1 — resources/list surfaces the uploaded file as a resource (name + URI).
 *   T2 — resources/read returns that file's content (per-run sentinel).
 *
 * The client side (§13.1) is NOT covered — the MCPTools component / v2 client
 * API expose tools only, no resource surface exists to test.
 *
 * Promotion (#948, nightly 1.12.0.dev4): T1 (resources/list) is `@stable` after
 * repeated clean --retries=0 runs + a force-failure check. T2 (resources/read)
 * is NOT promoted — it hits a live Langflow regression on 1.12.x: the server
 * throws `AttributeError: 'str' object has no attribute 'hex'` because
 * handle_read_resource compares the UUID `Flow.id` column to the raw string URI
 * segment without converting it to UUID (mcp_utils.py). Filed upstream as
 * LE-2012; see docs/upstream-bugs/UPSTREAM-BUG-mcp-resources-read-uuid-hex.log.
 * T2 is kept as a live regression guard and will be promoted once LE-2012 lands.
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

// Shared project MCP surface is instance-wide; run serially so a sibling
// project-MCP spec can't race this one, and so T2 can rely on T1's ordering.
test.describe.configure({ mode: "serial" });

test.describe("MCP Server — flow-file resources protocol", () => {
  let authorization: string;
  let projectId: string;
  let streamableUrl: string;
  let flow: RunnableChatFlow;
  let uploadedName: string;
  let expectedResourcePath: string;
  let resourceUri: string;
  const sentinel = `mcp-res-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  test.beforeAll(async ({ request }) => {
    authorization = await getAuthToken(request);
    const headers = { Authorization: authorization };

    // Create the flow first, then scope to the project it actually lives in
    // (its folder_id), so resources/list on that project is guaranteed to
    // include this flow's file — instead of assuming projects[0].
    flow = await createRunnableChatFlowViaApi(request, headers);

    const flowRes = await request.get(`/api/v1/flows/${flow.flowId}`, { headers });
    expect(flowRes.ok()).toBeTruthy();
    projectId = ((await flowRes.json()).folder_id as string) ?? "";
    if (!projectId) {
      const projectsRes = await request.get("/api/v1/projects/", { headers });
      const projects = await projectsRes.json();
      const list = Array.isArray(projects) ? projects : projects.folders ?? [];
      expect(list.length).toBeGreaterThan(0);
      projectId = list[0].id;
    }
    streamableUrl = `/api/v1/mcp/project/${projectId}/streamable`;

    // Upload a small text file carrying the per-run sentinel into the flow.
    const uploadRes = await request.post(
      `/api/v1/files/upload/${flow.flowId}`,
      {
        headers,
        multipart: {
          file: {
            name: "resource-note.txt",
            mimeType: "text/plain",
            buffer: Buffer.from(sentinel, "utf-8"),
          },
        },
      },
    );
    expect(uploadRes.ok(), `upload failed: ${uploadRes.status()}`).toBeTruthy();
    // The server prepends a timestamp to the stored name — capture the real one.
    const filePath = (await uploadRes.json()).file_path as string;
    uploadedName = filePath.split("/").pop() ?? "";
    expect(uploadedName, "upload response must carry a stored file name").toBeTruthy();

    expectedResourcePath = `/api/v1/files/download/${flow.flowId}/${uploadedName}`;
    // handle_read_resource only consumes the URI's last two path segments, so a
    // host built from the test's base URL is accepted regardless of the host the
    // server uses in the listed URI.
    const baseUrl = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:7860/";
    resourceUri = new URL(expectedResourcePath, baseUrl).toString();
  });

  test.afterAll(async ({ request }) => {
    // Playwright forbids reusing the beforeAll request here; use this hook's own.
    if (flow?.flowId) {
      await deleteFlow(request, flow.flowId, {
        headers: { Authorization: authorization },
      }).catch(() => {});
    }
  });

  test(
    "resources/list surfaces the uploaded flow file as a resource",
    { tag: ["@stable", "@regression", "@api", "@mcp"] },
    async ({ request }) => {
      await mcpHandshake(request, streamableUrl, authorization);

      // resources/list can lag a moment behind the upload — poll until this
      // flow's file appears, matching on its exact URI path (the project list
      // also contains other flows' files, so a generic count is not enough).
      let matched: { name: string; uri: string } | undefined;
      await expect
        .poll(
          async () => {
            const resp = await mcpCall(
              request,
              streamableUrl,
              authorization,
              "resources/list",
              {},
              2,
            );
            const resources = (resp.result?.resources ?? []) as Array<{
              name: string;
              uri: string;
            }>;
            matched = resources.find(
              (r) =>
                decodeURIComponent(new URL(r.uri).pathname) ===
                expectedResourcePath,
            );
            return Boolean(matched);
          },
          { timeout: 30000, intervals: [1000, 2000, 3000, 5000] },
        )
        .toBeTruthy();

      expect(matched?.name).toBe(uploadedName);
    },
  );

  // NOT @stable — resources/read is broken on Langflow 1.12.x (LE-2012): the
  // server raises AttributeError 'str' has no attribute 'hex' (UUID column vs
  // raw string URI segment in handle_read_resource). Kept as a live regression
  // guard; promote to @stable once the upstream fix lands.
  test(
    "resources/read returns the uploaded file content by URI",
    { tag: ["@regression", "@api", "@mcp"] },
    async ({ request }) => {
      await mcpHandshake(request, streamableUrl, authorization);

      const resp = await mcpCall(
        request,
        streamableUrl,
        authorization,
        "resources/read",
        { uri: resourceUri },
        3,
      );

      expect(resp.error, JSON.stringify(resp.error)).toBeUndefined();
      const contents = (resp.result?.contents ?? []) as Array<{
        uri: string;
        text?: string;
        blob?: string;
      }>;
      expect(contents.length).toBeGreaterThan(0);

      const content = contents[0];
      expect(decodeURIComponent(new URL(content.uri).pathname)).toBe(
        expectedResourcePath,
      );
      expect(
        decodedContentContainsSentinel(content.text ?? content.blob, sentinel),
        "resource content must contain the uploaded sentinel",
      ).toBe(true);
    },
  );
});
