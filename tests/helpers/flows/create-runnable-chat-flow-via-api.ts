import { readFileSync } from "fs";
import type { APIRequestContext } from "@playwright/test";
import { expect } from "../../fixtures/fixtures";
import { deleteFlow } from "./delete-flow";

// A minimal, version-current runnable flow: Chat Input -> Chat Output passthrough
// (single edge, no LLM or external provider key required). Chat Output echoes
// whatever value Chat Input emits, so callers can make deterministic semantic
// assertions on the run output — unlike an empty flow, which only supports the
// structural contract.
const RUNNABLE_CHAT_FLOW_FIXTURE =
  "tests/assets/flows/chat-io-ok-trace-fixture.json";

// The `input_value` stored on the fixture's Chat Input node. With no top-level
// `input_value` and no overriding tweak, Chat Output echoes this verbatim — so
// it is the baseline value to assert against.
export const RUNNABLE_CHAT_FLOW_DEFAULT_INPUT = "Hello";

// The Chat Input node's display name, usable as a `tweaks` key to override the
// input value at runtime (tweaks reference a component by node id OR display name).
export const RUNNABLE_CHAT_FLOW_CHAT_INPUT_DISPLAY_NAME = "Chat Input";

export interface RunnableChatFlow {
  /** The id of the created flow, for use against `POST /api/v1/run/{flow_id}`. */
  flowId: string;
  /** Deletes the flow created by this helper. Safe to call in `afterAll`. */
  deleteFlow: () => Promise<void>;
}

/**
 * Creates a runnable Chat Input -> Chat Output flow via `POST /api/v1/flows/`
 * and returns its id plus a teardown callback.
 *
 * `headers` carries the auth the caller already holds — pass `{ "x-api-key": key }`
 * or `{ Authorization: bearer }`; in auto_login mode both map to the same
 * superuser, so flow ownership matches either way. The same header is reused for
 * teardown.
 */
export async function createRunnableChatFlowViaApi(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<RunnableChatFlow> {
  const fixture = JSON.parse(readFileSync(RUNNABLE_CHAT_FLOW_FIXTURE, "utf-8"));

  // The flow name must be unique per call: Langflow enforces a unique-name-per-user
  // constraint, and its auto-rename fallback is not transaction-safe — two parallel
  // creations with the same name race and the loser gets a 500. A random suffix on
  // top of the timestamp avoids same-millisecond collisions across parallel specs
  // (same convention as setup-blank-flow.ts).
  const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  const res = await request.post("/api/v1/flows/", {
    headers,
    data: {
      name: `Runnable Chat Flow ${uniqueSuffix}`,
      description: "Chat Input -> Chat Output passthrough for API run tests",
      data: fixture.data,
      is_component: false,
    },
  });
  expect(res.status()).toBe(201);
  const flowId = (await res.json()).id as string;

  return {
    flowId,
    deleteFlow: async () => {
      await deleteFlow(request, flowId, { headers }).catch(() => {});
    },
  };
}
