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
 *
 * **The credential is an API key, sent as `x-api-key` — never a session token**
 * (#1522). Langflow's gate (`langflow/api/v1/mcp_projects.py`) reads the key from
 * the `x-api-key` header or a query param of the same name, and resolves a caller
 * that presented nothing to the superuser only under
 * `LANGFLOW_SKIP_AUTH_AUTO_LOGIN`; its own comment states the intent — *"AUTO_LOGIN
 * alone is not a credential"*. Measured on the same endpoint, same project:
 *
 * | Credential on `initialize` | 1.12.0.dev31 | 1.12.0.dev33 |
 * |---|---|---|
 * | `Authorization: Bearer <auto_login JWT>` | 200 | **403** |
 * | `x-api-key: <API key>` | 200 | **200** |
 * | `Authorization: Bearer <API key>` | 200 | **403** |
 * | no credential at all | 200 | **403** |
 *
 * dev31 answering 200 to a request carrying *nothing* is why this went unnoticed:
 * the specs asserted the protocol without exercising auth at all. An API key works
 * on both builds, so keying on it needs no lane change — and no lane sets the
 * bypass, on purpose (it would turn off the control these specs exercise).
 *
 * The credential is an object rather than a header string so a bearer token cannot
 * be passed by accident: it would compile and then 403 at run time, which is the
 * failure this signature exists to make impossible.
 */

/**
 * The transport's credential: a plaintext Langflow API key. Mint one with
 * `createApiKey` (`tests/helpers/auth/create-api-key.ts`) and delete it in
 * teardown — a key outlives the test that created it.
 */
export interface McpTransportCredential {
  apiKey: string;
}

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
 * response. `credential` carries the API key the transport requires (see header).
 */
export async function mcpCall(
  request: APIRequestContext,
  url: string,
  credential: McpTransportCredential,
  method: string,
  params?: Record<string, unknown>,
  id = 1,
): Promise<JsonRpcResponse> {
  const res = await request.post(url, {
    headers: { ...MCP_HEADERS, "x-api-key": credential.apiKey },
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
  credential: McpTransportCredential,
): Promise<any> {
  const init = await mcpCall(request, url, credential, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "langflow-e2e", version: "0.1" },
  });
  // Notification: no id, no response expected. The transport still answers with
  // an (empty) SSE frame or 202 — fire it and ignore the body.
  await request
    .post(url, {
      headers: { ...MCP_HEADERS, "x-api-key": credential.apiKey },
      data: { jsonrpc: "2.0", method: "notifications/initialized" },
    })
    .catch(() => {});
  return init.result;
}
