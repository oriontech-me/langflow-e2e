// Unit tests for the shared /api/v1/triggers helpers (#2448).
// Run with: npm run test:units
//
// Two of these functions carry a decision a spec relies on without re-checking
// it: `runProvider` is what keeps an instance-wide bulk pause scoped to one run,
// and `newestFirst` is the order a list assertion compares against. A provider
// the server refuses would fail every seed with a 422; an order that disagrees
// with the server's would fail a correct list, or pass a wrong one.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  bulkTriggers,
  createTrigger,
  listTriggers,
  newestFirst,
  runProvider,
  TRIGGER_PROVIDER_MAX_LENGTH,
  TRIGGER_PROVIDER_PATTERN,
  TRIGGER_READ_KEYS,
} from "./trigger-api";

test("runProvider: matches the server's provider pattern and length, whatever the label", () => {
  for (const label of ["", "bulk", "Operator View!", "x".repeat(200), "ÚNICO"]) {
    const provider = runProvider(label);
    assert.match(provider, TRIGGER_PROVIDER_PATTERN, `label ${JSON.stringify(label)}`);
    assert.ok(provider.length <= TRIGGER_PROVIDER_MAX_LENGTH, `label ${JSON.stringify(label)}: ${provider.length}`);
    assert.ok(provider.startsWith("e2eop"), provider);
  }
});

test("runProvider: two calls never collide, even with the same label", () => {
  const seen = new Set(Array.from({ length: 200 }, () => runProvider("same")));
  assert.equal(seen.size, 200);
});

test("runProvider: keeps the discriminator when the label alone would fill the length", () => {
  // A label is folded and then the whole is cut to 64; a long label must not cut
  // the discriminator off, or two runs with one label would share a provider.
  const a = runProvider("y".repeat(80));
  const b = runProvider("y".repeat(80));
  assert.notEqual(a, b);
});

test("newestFirst: orders by created_at desc, then id desc on a tie", () => {
  // The measured tie: rows created in the same second come back by id desc.
  const rows = [
    { id: "6a642217-ca8f-408c-b585-145b1892c7ea", created_at: "2026-11-15T23:34:15" },
    { id: "f1d349c1-c875-42ea-9f86-0f67d3e33c90", created_at: "2026-11-15T23:34:15" },
    { id: "0b1e3c09-0000-4000-8000-000000000000", created_at: "2026-11-15T23:34:16" },
    { id: "24881077-b127-4a18-bc6b-988422646168", created_at: "2026-11-15T23:34:14" },
  ];
  assert.deepEqual(
    [...rows].sort(newestFirst).map((row) => row.id),
    [
      "0b1e3c09-0000-4000-8000-000000000000",
      "f1d349c1-c875-42ea-9f86-0f67d3e33c90",
      "6a642217-ca8f-408c-b585-145b1892c7ea",
      "24881077-b127-4a18-bc6b-988422646168",
    ],
  );
});

test("newestFirst: dashes do not change the order the hex digits give", () => {
  const dashed = ["abcdef01-2345-4678-9abc-def012345678", "abcdef01-2345-4678-9abc-def012345679", "abcdef02-0000-4000-8000-000000000000"];
  const order = (ids: string[]) =>
    ids.map((id) => ({ id, created_at: "t" })).sort(newestFirst).map((row) => row.id.replace(/-/g, ""));
  const hexOrder = dashed.map((id) => id.replace(/-/g, "")).sort().reverse();
  assert.deepEqual(order(dashed), hexOrder);
});

test("TRIGGER_READ_KEYS: the 28 measured keys, sorted and unique", () => {
  assert.equal(TRIGGER_READ_KEYS.length, 28);
  assert.equal(new Set(TRIGGER_READ_KEYS).size, 28);
  assert.deepEqual([...TRIGGER_READ_KEYS], [...TRIGGER_READ_KEYS].sort());
});

/** A request whose every call answers `status` with `body`, recording what it was asked. */
function fakeRequest(status: number, body: unknown) {
  const calls: Array<{ method: string; url: string; options: unknown }> = [];
  const respond = (method: string) => async (url: string, options: unknown) => {
    calls.push({ method, url, options });
    return { status: () => status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { request: { get: respond("GET"), post: respond("POST") } as unknown as APIRequestContext, calls };
}

test("createTrigger: throws with the status and the server's body on a refusal", async () => {
  const { request } = fakeRequest(422, { detail: [{ type: "string_pattern_mismatch", loc: ["body", "provider"] }] });
  await assert.rejects(
    createTrigger(request, {}, { flow_id: "f", name: "n", kind: "inbound_webhook", provider: "BAD" }),
    (error: Error) => /answered 422, expected 201/.test(error.message) && /string_pattern_mismatch/.test(error.message),
  );
});

test("createTrigger: returns the body on 201", async () => {
  const { request, calls } = fakeRequest(201, { id: "t1", state: "active" });
  const row = await createTrigger(request, { Authorization: "Bearer x" }, { flow_id: "f", name: "n", kind: "inbound_webhook", state: "active" });
  assert.equal(row.id, "t1");
  assert.deepEqual(calls[0], {
    method: "POST",
    url: "/api/v1/triggers",
    options: { headers: { Authorization: "Bearer x" }, data: { flow_id: "f", name: "n", kind: "inbound_webhook", state: "active" } },
  });
});

test("listTriggers: sends the query as params, never concatenated into the path", async () => {
  const { request, calls } = fakeRequest(200, []);
  await listTriggers(request, {}, { scope: "all", provider: "e2eopx", limit: 1 });
  assert.equal(calls[0].url, "/api/v1/triggers");
  assert.deepEqual((calls[0].options as { params: unknown }).params, { scope: "all", provider: "e2eopx", limit: 1 });
});

test("bulkTriggers: a 403 for a non-superuser is an error, not an empty result", async () => {
  const { request } = fakeRequest(403, { detail: "The user doesn't have enough privileges" });
  await assert.rejects(bulkTriggers(request, {}, "pause", { trigger_ids: ["t1"] }), /answered 403/);
});
