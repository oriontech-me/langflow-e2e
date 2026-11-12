// Unit tests for createRunnableChatFlowViaApi's `folderId` option (#2412).
// Run with: npm run test:units
//
// The option was added so a spec can put its flow in a project it controls —
// since 1.14.0.dev23 the default project is `apikey` under AUTO_LOGIN, so "where
// the flow lands" decides whether its A2A/MCP endpoints are public. The second
// test pins the other half: every existing caller passes no option and must keep
// sending exactly the payload it sent before.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { createRunnableChatFlowViaApi } from "./create-runnable-chat-flow-via-api";

function fakeRequest() {
  const posted: Array<Record<string, unknown>> = [];
  const request = {
    post: async (_url: string, o: { data?: Record<string, unknown> } = {}) => {
      posted.push(o.data ?? {});
      return {
        ok: () => true,
        status: () => 201,
        json: async () => ({ id: "flow-1" }),
        text: async () => "",
      };
    },
  } as unknown as APIRequestContext;
  return { request, posted };
}

test("folderId puts the flow in that project", async () => {
  const { request, posted } = fakeRequest();
  await createRunnableChatFlowViaApi(request, {}, { folderId: "proj-1" });
  assert.equal(posted[0].folder_id, "proj-1");
});

test("without folderId the payload carries no folder_id at all", async () => {
  const { request, posted } = fakeRequest();
  await createRunnableChatFlowViaApi(request, {});
  assert.equal("folder_id" in posted[0], false);
});
