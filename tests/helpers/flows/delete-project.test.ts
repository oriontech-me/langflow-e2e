// Unit tests for deleteProject's key revocation (#2512).
// Run with: npm run test:units
//
// Langflow mints an account API key named `MCP Project <name> - default` for
// every project and leaves it active when the project is deleted. deleteProject
// revokes it, and these tests pin when it must and must not: after a delete it
// performed, never when the project was not there to delete, never when the
// delete failed, and with the name read BEFORE the delete (after it, the
// project is no longer listed and the name is lost).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { deleteProject } from "./delete-project";
import { mintedKeyName } from "./revoke-project-minted-keys";

function fakeInstance(opts: {
  projects: Array<{ id: string; name: string }>;
  keys: Array<{ id: string; name: string }>;
  deleteStatuses?: number[];
}) {
  const projects = [...opts.projects];
  const keys = [...opts.keys];
  const statuses = [...(opts.deleteStatuses ?? [204])];
  const calls: string[] = [];
  const res = (status: number, body: unknown) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  const request = {
    get: async (url: string) => {
      calls.push(`GET ${url}`);
      if (url === "/api/v1/projects/") return res(200, [...projects]);
      if (url === "/api/v1/api_key/") return res(200, { api_keys: [...keys] });
      throw new Error(`unexpected GET ${url}`);
    },
    delete: async (url: string) => {
      calls.push(`DELETE ${url}`);
      const id = url.split("/").pop()!;
      if (url.startsWith("/api/v1/projects/")) {
        const i = projects.findIndex((p) => p.id === id);
        if (i < 0) return res(404, { detail: "Project not found" });
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
        if (status < 300) projects.splice(i, 1);
        return res(status, {});
      }
      const k = keys.findIndex((x) => x.id === id);
      if (k >= 0) keys.splice(k, 1);
      return res(200, {});
    },
  } as unknown as APIRequestContext;
  return { request, calls, keyIds: () => keys.map((k) => k.id) };
}

const H = { headers: { Authorization: "Bearer t" } };

test("revokes the project's minted key after deleting it", async () => {
  const f = fakeInstance({
    projects: [{ id: "p1", name: "Test Folder 1" }],
    keys: [
      { id: "own", name: mintedKeyName("Test Folder 1") },
      { id: "other", name: mintedKeyName("Starter Project") },
    ],
  });
  await deleteProject(f.request, "p1", H);
  assert.deepEqual(f.keyIds(), ["other"]);
});

test("reads the name before the delete, and revokes only after it", async () => {
  const f = fakeInstance({
    projects: [{ id: "p1", name: "n" }],
    keys: [{ id: "own", name: mintedKeyName("n") }],
  });
  await deleteProject(f.request, "p1", H);
  const nameRead = f.calls.indexOf("GET /api/v1/projects/");
  const del = f.calls.indexOf("DELETE /api/v1/projects/p1");
  const keyDel = f.calls.indexOf("DELETE /api/v1/api_key/own");
  assert.ok(nameRead >= 0 && nameRead < del, "name read before the delete");
  assert.ok(keyDel > del, "key revoked after the delete");
});

test("revokes after a delete that succeeded on retry (#965)", async () => {
  const f = fakeInstance({
    projects: [{ id: "p1", name: "n" }],
    keys: [{ id: "own", name: mintedKeyName("n") }],
    deleteStatuses: [500, 204],
  });
  const original = console.warn;
  console.warn = () => {};
  try {
    await deleteProject(f.request, "p1", H);
  } finally {
    console.warn = original;
  }
  assert.deepEqual(f.keyIds(), []);
});

test("touches no key when the project was already gone", async () => {
  // A 404 is a done delete, but this call deleted nothing and cannot know the
  // name; a caller that deleted the project itself revokes by name.
  const f = fakeInstance({
    projects: [],
    keys: [{ id: "k", name: mintedKeyName("n") }],
  });
  await deleteProject(f.request, "p1", H);
  assert.deepEqual(f.keyIds(), ["k"]);
  assert.ok(!f.calls.includes("GET /api/v1/api_key/"));
});

test("touches no key when the delete failed", async () => {
  const f = fakeInstance({
    projects: [{ id: "p1", name: "n" }],
    keys: [{ id: "k", name: mintedKeyName("n") }],
    deleteStatuses: [500],
  });
  const original = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(() => deleteProject(f.request, "p1", H));
  } finally {
    console.warn = original;
  }
  assert.deepEqual(f.keyIds(), ["k"]);
  // Not merely kept by the live-project guard: no revocation is attempted.
  assert.ok(!f.calls.includes("GET /api/v1/api_key/"));
});
