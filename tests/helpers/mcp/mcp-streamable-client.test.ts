// Unit tests for mcpCall's opt-in transport retry (#2243). Run with: npm run test:units
//
// The retry exists for one failure, a POST that dies at the transport layer, and must
// never re-send an answer the server gave: a 5xx is a statement about the product,
// even when its body happens to name ECONNREFUSED.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { mcpCall } from "./mcp-streamable-client";

const credential = { apiKey: "sk-test" };
const okFrame = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"resources":[]}}\n';

/** A fake request context whose POSTs play `steps` in order: an Error is thrown. */
function fakeRequest(steps: Array<Error | { status: number; body: string }>) {
  let posts = 0;
  const request = {
    async post() {
      const step = steps[Math.min(posts++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return { ok: () => step.status < 300, status: () => step.status, text: async () => step.body };
    },
  } as unknown as APIRequestContext;
  return { request, posts: () => posts };
}

test("with the option, a dropped socket is re-dialled once and the answer returned", async () => {
  const fake = fakeRequest([new Error("apiRequestContext.post: socket hang up"), { status: 200, body: okFrame }]);
  const resp = await mcpCall(fake.request, "/mcp", credential, "resources/list", {}, 2, {
    retryDroppedConnection: true,
  });
  assert.deepEqual(resp.result, { resources: [] });
  assert.equal(fake.posts(), 2);
});

test("with the option, a non-2xx naming a transport error is NOT re-sent", async () => {
  const fake = fakeRequest([{ status: 502, body: "upstream connect error: ECONNREFUSED" }, { status: 200, body: okFrame }]);
  await assert.rejects(
    mcpCall(fake.request, "/mcp", credential, "resources/list", {}, 2, { retryDroppedConnection: true }),
    /MCP resources\/list HTTP 502: upstream connect error: ECONNREFUSED/,
  );
  assert.equal(fake.posts(), 1, "a product error must surface, never be retried into a pass");
});

test("without the option, a dropped socket is not retried (a tools/call must not run twice)", async () => {
  const fake = fakeRequest([new Error("read ECONNRESET"), { status: 200, body: okFrame }]);
  await assert.rejects(mcpCall(fake.request, "/mcp", credential, "tools/call", {}), /ECONNRESET/);
  assert.equal(fake.posts(), 1);
});
