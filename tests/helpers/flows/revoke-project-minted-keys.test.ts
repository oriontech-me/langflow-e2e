// Unit tests for revokeProjectMintedKeys (#2512).
// Run with: npm run test:units
//
// The helper deletes account API keys, on an account parallel workers share, so
// what these tests pin is mostly what it must NOT delete: a key whose project
// still exists, a key that only resembles the name, and anything at all when
// the project list cannot be read.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  mintedKeyName,
  revokeProjectMintedKeys,
} from "./revoke-project-minted-keys";

interface Key {
  id: string;
  name: string;
}

function fakeRequest(
  opts: {
    keys?: Key[];
    projects?: unknown;
    keyListStatus?: number;
    projectListStatus?: number;
    keyDeleteStatus?: number;
  } = {},
) {
  const {
    keys = [],
    projects = [],
    keyListStatus = 200,
    projectListStatus = 200,
    keyDeleteStatus = 200,
  } = opts;
  const live = [...keys];
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
      if (url === "/api/v1/api_key/") return res(keyListStatus, { api_keys: live });
      if (url === "/api/v1/projects/") return res(projectListStatus, projects);
      throw new Error(`unexpected GET ${url}`);
    },
    delete: async (url: string) => {
      calls.push(`DELETE ${url}`);
      const id = url.split("/").pop()!;
      const i = live.findIndex((k) => k.id === id);
      if (i >= 0 && keyDeleteStatus < 300) live.splice(i, 1);
      return res(keyDeleteStatus, {});
    },
  } as unknown as APIRequestContext;
  return { request, calls, ids: () => live.map((k) => k.id) };
}

const H = { Authorization: "Bearer t" };

test("revokes the minted key of a deleted project and nothing else", async () => {
  const f = fakeRequest({
    keys: [
      { id: "own", name: mintedKeyName("Test Folder 1") },
      { id: "starter", name: mintedKeyName("Starter Project") },
      { id: "human", name: "a key a human made" },
    ],
    projects: [{ name: "Starter Project" }],
  });
  await revokeProjectMintedKeys(f.request, H, ["Test Folder 1"]);
  assert.deepEqual(f.ids(), ["starter", "human"]);
});

test("matches the exact key name, never a name that merely contains it", async () => {
  // `includes` would revoke `pdup-x (1)`'s key while revoking `pdup-x`'s.
  const f = fakeRequest({
    keys: [
      { id: "plain", name: mintedKeyName("pdup-x") },
      { id: "suffixed", name: mintedKeyName("pdup-x (1)") },
    ],
    projects: [],
  });
  await revokeProjectMintedKeys(f.request, H, ["pdup-x"]);
  assert.deepEqual(f.ids(), ["suffixed"]);
});

test("keeps every key of a name some live project still carries", async () => {
  // Two UI specs both create `New Project`: while either one exists, neither
  // key may go, because the helper cannot tell which key is whose.
  const f = fakeRequest({
    keys: [
      { id: "np1", name: mintedKeyName("New Project") },
      { id: "np2", name: mintedKeyName("New Project") },
      { id: "gone", name: mintedKeyName("del-integrity-1") },
    ],
    projects: [{ name: "New Project" }],
  });
  await revokeProjectMintedKeys(f.request, H, ["New Project", "del-integrity-1"]);
  assert.deepEqual(f.ids(), ["np1", "np2"]);
});

test("revokes every key of a non-unique name once no project carries it", async () => {
  const f = fakeRequest({
    keys: [
      { id: "np1", name: mintedKeyName("New Project") },
      { id: "np2", name: mintedKeyName("New Project") },
    ],
    projects: [],
  });
  await revokeProjectMintedKeys(f.request, H, ["New Project"]);
  assert.deepEqual(f.ids(), []);
});

test("reads the keys BEFORE the projects", async () => {
  // The reverse order would let a project created between the reads be
  // missed by the project list while its key is caught by the key list.
  const f = fakeRequest({
    keys: [{ id: "k", name: mintedKeyName("p") }],
    projects: [],
  });
  await revokeProjectMintedKeys(f.request, H, ["p"]);
  assert.deepEqual(f.calls.slice(0, 2), [
    "GET /api/v1/api_key/",
    "GET /api/v1/projects/",
  ]);
});

test("revokes nothing when the project list cannot be read", async () => {
  for (const variant of [
    { projectListStatus: 500 },
    { projects: { detail: "Not authenticated" } },
  ]) {
    const f = fakeRequest({
      keys: [{ id: "k", name: mintedKeyName("p") }],
      ...variant,
    });
    await revokeProjectMintedKeys(f.request, H, ["p"]);
    assert.deepEqual(f.ids(), ["k"], JSON.stringify(variant));
  }
});

test("never throws, and names the key it could not delete", async () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  try {
    const f = fakeRequest({
      keys: [{ id: "k", name: mintedKeyName("p") }],
      keyDeleteStatus: 500,
    });
    await revokeProjectMintedKeys(f.request, H, ["p"]);
    assert.ok(warnings.some((w) => w.includes(mintedKeyName("p"))));

    const broken = {
      get: async () => {
        throw new Error("socket hang up");
      },
    } as unknown as APIRequestContext;
    await revokeProjectMintedKeys(broken, H, ["p"]);
    assert.ok(warnings.some((w) => w.includes("socket hang up")));
  } finally {
    console.warn = original;
  }
});

test("asks the API nothing when there is no name to revoke", async () => {
  const f = fakeRequest();
  await revokeProjectMintedKeys(f.request, H, []);
  assert.deepEqual(f.calls, []);
});
