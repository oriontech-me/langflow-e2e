// Unit tests for createRunnableChatFlowInPublicProject (#2412).
// Run with: npm run test:units
//
// The helper exists because the default project stopped being public: from
// 1.14.0.dev23 (upstream #16186 + #16151) every project created under
// AUTO_LOGIN=true defaults to auth_type "apikey", the default one included. A spec
// that needs a public A2A agent now has to ask for it, so the properties pinned
// here are the ones a green spec cannot show on its own:
//   - the project is created with an EXPLICIT auth_type "none" (omitting it is
//     what silently yields an apikey project now);
//   - the flow is created INSIDE that project (a flow that lands in the default
//     project would be restricted, and every keyless call would 401);
//   - teardown never leaks the project, whichever half fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { createRunnableChatFlowInPublicProject } from "./create-public-runnable-flow";

interface Call {
  method: string;
  url: string;
  data?: Record<string, unknown>;
}

function fakeRequest(
  opts: {
    flowCreateStatus?: number;
    flowDeleteStatus?: number;
    projectDeleteStatus?: number;
  } = {},
) {
  const { flowCreateStatus = 201, flowDeleteStatus = 200, projectDeleteStatus = 204 } = opts;
  const calls: Call[] = [];

  const res = (status: number, body: unknown) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const request = {
    post: async (url: string, o: { data?: Record<string, unknown> } = {}) => {
      calls.push({ method: "POST", url, data: o.data });
      if (url === "/api/v1/projects/") {
        return res(201, { id: "proj-1", name: o.data?.name, auth_settings: o.data?.auth_settings });
      }
      if (url === "/api/v1/flows/") {
        return res(flowCreateStatus, flowCreateStatus === 201 ? { id: "flow-1" } : { detail: "refused" });
      }
      throw new Error(`unexpected POST ${url}`);
    },
    get: async (url: string) => {
      calls.push({ method: "GET", url });
      return res(200, { api_keys: [] });
    },
    delete: async (url: string) => {
      calls.push({ method: "DELETE", url });
      if (url.startsWith("/api/v1/flows/")) return res(flowDeleteStatus, {});
      if (url.startsWith("/api/v1/projects/")) return res(projectDeleteStatus, {});
      throw new Error(`unexpected DELETE ${url}`);
    },
  } as unknown as APIRequestContext;

  return { request, calls };
}

const headers = { Authorization: "Bearer t" };

test("creates the project with an explicit auth_type none", async () => {
  const { request, calls } = fakeRequest();
  await createRunnableChatFlowInPublicProject(request, headers);

  const create = calls.find((c) => c.method === "POST" && c.url === "/api/v1/projects/");
  assert.ok(create, "a project was created");
  assert.deepEqual(create.data?.auth_settings, { auth_type: "none" });
});

test("creates the flow inside that project, not in the default one", async () => {
  const { request, calls } = fakeRequest();
  const flow = await createRunnableChatFlowInPublicProject(request, headers);

  const create = calls.find((c) => c.method === "POST" && c.url === "/api/v1/flows/");
  assert.ok(create, "a flow was created");
  assert.equal(create.data?.folder_id, "proj-1");
  assert.equal(flow.flowId, "flow-1");
  assert.equal(flow.projectId, "proj-1");
});

test("cleanup deletes the flow before the project", async () => {
  const { request, calls } = fakeRequest();
  const flow = await createRunnableChatFlowInPublicProject(request, headers);
  await flow.cleanup();

  const deletes = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
  assert.deepEqual(deletes, ["/api/v1/flows/flow-1", "/api/v1/projects/proj-1"]);
});

test("a failed flow delete still deletes the project, and the failure surfaces", async () => {
  const { request, calls } = fakeRequest({ flowDeleteStatus: 400 });
  const flow = await createRunnableChatFlowInPublicProject(request, headers);

  await assert.rejects(flow.cleanup(), /Flow cleanup failed: 400/);
  assert.ok(
    calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/projects/proj-1"),
    "the project was deleted even though the flow delete failed",
  );
});

test("a failed project delete surfaces even when the flow delete succeeded", async () => {
  const { request } = fakeRequest({ projectDeleteStatus: 400 });
  const flow = await createRunnableChatFlowInPublicProject(request, headers);

  await assert.rejects(flow.cleanup(), /Project cleanup failed: 400/);
});

test("a refused flow creation deletes the project it made and rethrows", async () => {
  const { request, calls } = fakeRequest({ flowCreateStatus: 400 });

  await assert.rejects(
    createRunnableChatFlowInPublicProject(request, headers),
    /POST \/api\/v1\/flows\/ failed: 400/,
  );
  assert.ok(
    calls.some((c) => c.method === "DELETE" && c.url === "/api/v1/projects/proj-1"),
    "the project made for the flow does not leak",
  );
});
