import type { APIRequestContext } from "@playwright/test";

/**
 * Minimal A2A JSON-RPC client over Playwright's `APIRequestContext`, for driving
 * `POST /api/v1/a2a/{flow_id}/jsonrpc` in E2E assertions. NOT an a2a-sdk.
 *
 * Two deliberate differences from `helpers/mcp/mcp-streamable-client.ts`, which is
 * otherwise the same shape of problem:
 *
 *  1. **It never throws on a non-2xx.** The A2A endpoint returns **HTTP 200** for
 *     every JSON-RPC-level error — unknown method (`-32601`), malformed envelope
 *     (`-32600`), unparseable body (`-32700`) — measured on `1.12.0.dev14`. `mcpCall`
 *     throws when `!res.ok()`, which would make those assertions unreachable. Here
 *     the HTTP status is **returned** so the spec can assert it is 200 *and* read
 *     the error envelope.
 *  2. **The response is plain JSON, not an SSE frame.** Langflow's MCP streamable
 *     transport answers with `data: {...}`; this endpoint answers with a JSON body,
 *     so there is nothing to unwrap.
 *
 * `body` accepts an object (serialized normally) or a **raw string**, which is how
 * the invalid-JSON case (`-32700`) is exercised without the serializer fixing it.
 */

export interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: string | number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export interface A2aRpcResult {
  /** HTTP status — asserted explicitly, because protocol errors also arrive as 200. */
  status: number;
  /** Parsed JSON-RPC envelope. `null` when the body was not JSON at all. */
  body: JsonRpcEnvelope | null;
  /** Raw response text, for diagnostics and sentinel containment checks. */
  raw: string;
}

export function a2aJsonRpcPath(flowId: string): string {
  return `/api/v1/a2a/${flowId}/jsonrpc`;
}

/** POST one JSON-RPC request to a flow's A2A endpoint. Never throws on HTTP status. */
export async function postA2AJsonRpc(
  request: APIRequestContext,
  flowId: string,
  body: Record<string, unknown> | string,
  headers: Record<string, string> = {},
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<A2aRpcResult> {
  const res = await request.post(a2aJsonRpcPath(flowId), {
    headers: { "Content-Type": "application/json", ...headers },
    // A raw body must go as a Buffer, NOT as a string. Playwright JSON-serializes a
    // string `data` (it arrives quoted), so `"{not json"` reaches the server as the
    // valid JSON string `"\"{not json\""` — the server parses it fine and answers
    // -32600 "Each request should be an object (dict)" instead of the -32700 parse
    // error the case exists to prove. Measured: the assertion failed exactly that way
    // before this line. A Buffer is sent verbatim, keeping the Content-Type above so
    // the server tries to parse and fails, rather than rejecting the media type.
    data: typeof body === "string" ? Buffer.from(body, "utf-8") : body,
    // A real graph build takes seconds; the default 30 s is tight for a cold worker.
    timeout: timeoutMs,
  });

  const raw = await res.text();
  let parsed: JsonRpcEnvelope | null = null;
  try {
    parsed = JSON.parse(raw) as JsonRpcEnvelope;
  } catch {
    parsed = null;
  }
  return { status: res.status(), body: parsed, raw };
}

/**
 * Build a `message/send` envelope with a single text part.
 *
 * `contextId` is what makes a second call land in the same session (server-minted on
 * the first response). It goes **inside `message`**, not on `params` — measured.
 */
export function messageSendEnvelope(
  text: string,
  { id, messageId, contextId, taskId }: {
    id: string;
    messageId: string;
    contextId?: string;
    taskId?: string;
  },
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "message/send",
    params: {
      message: {
        role: "user",
        messageId,
        parts: [{ kind: "text", text }],
        ...(contextId ? { contextId } : {}),
        ...(taskId ? { taskId } : {}),
      },
    },
  };
}
