// Unit tests for createProjectViaApi (#1353).
// Run with: npm run test:units
//
// The load-bearing part is the TEARDOWN, not the creation. Langflow mints an API
// key of its own (`MCP Project <name> - default`) whenever a project is created
// with `auth_settings`, and `DELETE /api/v1/projects/{id}` answers 204 while
// leaving that key behind — measured on 1.12.0.dev18. If the sweep regresses, the
// symptom is invisible: every spec using a restricted project keeps passing while
// one orphan key accumulates per run on the shared superuser account.
//
// So these tests pin the sweep's three properties that a reader cannot verify by
// looking at a green spec: it deletes the project's own key, it does NOT touch
// anybody else's, and it runs AFTER the project delete without ever masking it.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { createProjectViaApi } from "./create-project-via-api";

interface Call {
  method: string;
  url: string;
  data?: unknown;
}

/**
 * A fake APIRequestContext recording every call. `keys` is the account's key list
 * as the sweep will read it; deletions mutate it, so a test can assert on the
 * end state rather than only on the calls made.
 */
function fakeRequest(
  opts: {
    createStatus?: number;
    keys?: Array<{ id: string; name: string }>;
    deleteProjectStatus?: number;
    keyListStatus?: number;
    keyDeleteStatus?: number;
  } = {},
) {
  const {
    createStatus = 201,
    keys = [],
    deleteProjectStatus = 204,
    keyListStatus = 200,
    keyDeleteStatus = 200,
  } = opts;

  const calls: Call[] = [];
  const live = [...keys];
  let createdName = "";

  const res = (status: number, body: unknown) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const request = {
    post: async (url: string, o: { data?: any } = {}) => {
      calls.push({ method: "POST", url, data: o.data });
      createdName = o.data?.name ?? "";
      return res(createStatus, {
        id: "proj-1",
        name: createdName,
        auth_settings: o.data?.auth_settings,
      });
    },
    get: async (url: string) => {
      calls.push({ method: "GET", url });
      return res(keyListStatus, { api_keys: live });
    },
    delete: async (url: string) => {
      calls.push({ method: "DELETE", url });
      if (url.startsWith("/api/v1/projects/")) {
        return res(deleteProjectStatus, {});
      }
      const id = url.split("/").pop()!;
      const i = live.findIndex((k) => k.id === id);
      if (i >= 0 && keyDeleteStatus < 300) live.splice(i, 1);
      return res(keyDeleteStatus, {});
    },
    patch: async () => res(200, {}),
  } as unknown as APIRequestContext;

  return {
    request,
    calls,
    liveKeys: () => live,
    createdName: () => createdName,
  };
}

const HEADERS = { Authorization: "Bearer t" };

test("sends auth_settings when given, and omits the field entirely when not", async () => {
  const withAuth = fakeRequest();
  await createProjectViaApi(withAuth.request, HEADERS, {
    authSettings: { auth_type: "apikey" },
  });
  const a = withAuth.calls.find((c) => c.method === "POST")!.data as any;
  assert.deepEqual(a.auth_settings, { auth_type: "apikey" });

  const withoutAuth = fakeRequest();
  await createProjectViaApi(withoutAuth.request, HEADERS);
  const b = withoutAuth.calls.find((c) => c.method === "POST")!.data as any;
  // Absent, not null: an explicit null is a different request to the API.
  assert.equal("auth_settings" in b, false);
});

test("the generated name is unique per call, so the sweep cannot collide", async () => {
  const one = fakeRequest();
  const two = fakeRequest();
  await createProjectViaApi(one.request, HEADERS, { namePrefix: "p" });
  await createProjectViaApi(two.request, HEADERS, { namePrefix: "p" });
  assert.notEqual(one.createdName(), two.createdName());
});

test("teardown deletes the project's auto-created key and leaves other keys alone", async () => {
  const f = fakeRequest({ keys: [] });
  const project = await createProjectViaApi(f.request, HEADERS, {
    namePrefix: "authgate",
    authSettings: { auth_type: "apikey" },
  });

  // Langflow mints the key at creation time; model that after the fact so the
  // name matches the one the helper actually generated.
  const name = f.createdName();
  f.liveKeys().push(
    { id: "k-own", name: `MCP Project ${name} - default` },
    { id: "k-other", name: "MCP Project someone-elses-project - default" },
    { id: "k-user", name: "a key a human made" },
  );

  await project.deleteProject();

  assert.deepEqual(
    f.liveKeys().map((k) => k.id),
    ["k-other", "k-user"],
    "only the project's own key is swept",
  );
});

test("the sweep runs AFTER the project delete", async () => {
  const f = fakeRequest();
  const project = await createProjectViaApi(f.request, HEADERS, {
    authSettings: { auth_type: "apikey" },
  });
  f.liveKeys().push({ id: "k1", name: `MCP Project ${f.createdName()} - default` });

  await project.deleteProject();

  const projectDelete = f.calls.findIndex(
    (c) => c.method === "DELETE" && c.url.startsWith("/api/v1/projects/"),
  );
  const keyList = f.calls.findIndex(
    (c) => c.method === "GET" && c.url === "/api/v1/api_key/",
  );
  assert.ok(projectDelete >= 0 && keyList > projectDelete, "project first, sweep second");
});

test("a failing sweep never masks a successful project delete", async () => {
  const f = fakeRequest({ keyListStatus: 500 });
  const project = await createProjectViaApi(f.request, HEADERS, {
    authSettings: { auth_type: "apikey" },
  });
  // Must not throw: the project IS gone, and turning cleanup noise into a test
  // failure would redden a spec whose subject passed.
  await project.deleteProject();
});

test("a failed key delete is reported, not swallowed into a false clean", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const f = fakeRequest({ keyDeleteStatus: 500 });
    const project = await createProjectViaApi(f.request, HEADERS, {
      authSettings: { auth_type: "apikey" },
    });
    f.liveKeys().push({ id: "k1", name: `MCP Project ${f.createdName()} - default` });
    await project.deleteProject();
    assert.ok(
      warnings.some((w) => w.includes("auto-created API key")),
      "the orphan is named in the log",
    );
  } finally {
    console.warn = original;
  }
});

test("a non-201 creation throws instead of returning an unusable project", async () => {
  const f = fakeRequest({ createStatus: 500 });
  await assert.rejects(() => createProjectViaApi(f.request, HEADERS));
});
