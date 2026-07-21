import type { APIRequestContext } from "@playwright/test";

/**
 * Minimal MCP client over the streamable-HTTP transport, backed by Playwright's
 * `APIRequestContext`. Enough to drive Langflow's project MCP server for E2E
 * assertions — NOT a full MCP SDK.
 *
 * Langflow's streamable endpoint (`/api/v1/mcp/project/{id}/streamable`) answers
 * each JSON-RPC POST with a single Server-Sent-Events frame:
 *
 *     event: message
 *     data: {"jsonrpc":"2.0","id":1,"result":{...}}
 *
 * On 1.11.0.dev49 the transport is stateless (no `mcp-session-id` header is
 * required between calls), so each request is independent. We send
 * `Accept: application/json, text/event-stream` (the transport requires the SSE
 * media type) and parse the `data:` line back into the JSON-RPC object.
 */

export interface JsonRpcResponse {
  jsonrpc: string;
  id?: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

/** Extract the JSON payload from the `data:` line of an SSE frame. */
function parseSseData(body: string): JsonRpcResponse {
  const line = body
    .split(/\r?\n/)
    .find((l) => l.startsWith("data:"));
  if (!line) {
    throw new Error(`MCP response is not an SSE frame with a data line:\n${body}`);
  }
  return JSON.parse(line.replace(/^data:\s*/, "")) as JsonRpcResponse;
}

/**
 * Send one JSON-RPC request to a streamable MCP endpoint and return the parsed
 * response. `authorization` is the full header value (e.g. `Bearer <token>`).
 */
export async function mcpCall(
  request: APIRequestContext,
  url: string,
  authorization: string,
  method: string,
  params?: Record<string, unknown>,
  id = 1,
): Promise<JsonRpcResponse> {
  const res = await request.post(url, {
    headers: { ...MCP_HEADERS, Authorization: authorization },
    data: { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) },
  });
  if (!res.ok()) {
    throw new Error(`MCP ${method} HTTP ${res.status()}: ${await res.text()}`);
  }
  return parseSseData(await res.text());
}

/**
 * Complete the MCP handshake: `initialize` then the `notifications/initialized`
 * notification. Returns the `initialize` result (carries `serverInfo` and
 * advertised `capabilities`).
 */
export async function mcpHandshake(
  request: APIRequestContext,
  url: string,
  authorization: string,
): Promise<any> {
  const init = await mcpCall(request, url, authorization, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "langflow-e2e", version: "0.1" },
  });
  // Notification: no id, no response expected. The transport still answers with
  // an (empty) SSE frame or 202 — fire it and ignore the body.
  await request
    .post(url, {
      headers: { ...MCP_HEADERS, Authorization: authorization },
      data: { jsonrpc: "2.0", method: "notifications/initialized" },
    })
    .catch(() => {});
  return init.result;
}
