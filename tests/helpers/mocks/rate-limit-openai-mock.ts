import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";

/**
 * A scriptable OpenAI-compatible endpoint that Langflow calls from its own process
 * (#2572). It answers `GET /v1/models` with one model and `POST /v1/chat/completions`
 * with `ECHO:<last user message>`, and it can answer `429` on demand, which no real
 * provider does. Every request it receives is recorded, with its arrival time, so a
 * spec can see what the caller did (batching, retries) rather than infer it.
 *
 * Langflow is the caller, not the test, so the server listens on every interface and
 * is reached through an address Langflow can route to and its SSRF layer admits:
 * `addressForLangflow()`.
 */

export const MOCK_MODEL_ID = "e2e-mock-model";
export const MOCK_RATE_LIMIT_MESSAGE = "Rate limit reached (mock)";

/** The address Langflow uses to reach the test host, when the heuristic cannot pick it. */
export const MOCK_HOST_ENV = "E2E_MOCK_HOST_FROM_LANGFLOW";

export interface MockRequest {
  /** Milliseconds since the mock started. */
  at: number;
  method: string;
  path: string;
  /** The last user message of a chat completion, "" otherwise. */
  user: string;
  status: number;
}

export interface MockBehaviour {
  /** Answer `429` to the first N chat completions of each distinct user message. */
  rateLimitFirstPerMessage: number;
  /** The `Retry-After` header sent with a `429`, in seconds. */
  retryAfterSeconds: number;
  /** How long a successful completion takes, so concurrency shows in the arrival times. */
  responseDelayMs: number;
}

const DEFAULT_BEHAVIOUR: MockBehaviour = { rateLimitFirstPerMessage: 0, retryAfterSeconds: 0, responseDelayMs: 0 };

export interface RateLimitMock {
  /** The base URL to give Langflow, `http://<address>:<port>/v1`. */
  baseUrlForLangflow: string;
  /** Resets the record and sets the behaviour for the next run. */
  reset(behaviour?: Partial<MockBehaviour>): void;
  /** The chat completions received since the last reset, in arrival order. */
  completions(): MockRequest[];
  close(): Promise<void>;
}

type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>;

function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * The address Langflow should call the mock at.
 *
 * Langflow's SSRF layer blocks loopback, link-local and CGNAT outright and admits
 * private addresses only through `LANGFLOW_SSRF_ALLOWED_HOSTS`, which every lane sets
 * to the RFC-1918 ranges. So the answer is the test host's first non-internal
 * RFC-1918 IPv4 address, which a container on that host (Docker or Podman) and a
 * Langflow running natively on it can both reach. `E2E_MOCK_HOST_FROM_LANGFLOW`
 * overrides it, for a topology where that is not the right interface. Returns
 * `undefined` when there is none, and the caller fails naming the variable.
 */
export function addressForLangflow(
  env: NodeJS.ProcessEnv = process.env,
  interfaces: NetworkInterfaces = os.networkInterfaces(),
): string | undefined {
  const override = env[MOCK_HOST_ENV]?.trim();
  if (override) return override;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address)) return entry.address;
    }
  }
  return undefined;
}

function lastUserMessage(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> })?.messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user" && typeof messages[i].content === "string") return messages[i].content as string;
  }
  return "";
}

export async function startRateLimitMock(
  env: NodeJS.ProcessEnv = process.env,
  interfaces: NetworkInterfaces = os.networkInterfaces(),
): Promise<RateLimitMock> {
  const host = addressForLangflow(env, interfaces);
  if (!host) {
    throw new Error(
      `no RFC-1918 IPv4 address on this host for Langflow to reach the mock; set ${MOCK_HOST_ENV} ` +
        "to the address Langflow can route to (an address its SSRF allow-list admits)",
    );
  }
  const started = Date.now();
  let behaviour = { ...DEFAULT_BEHAVIOUR };
  let record: MockRequest[] = [];
  let seen = new Map<string, number>();

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: unknown = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const path = (req.url ?? "").split("?")[0];
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };
      const entry: MockRequest = { at: Date.now() - started, method: req.method ?? "", path, user: "", status: 200 };

      if (req.method === "GET" && path.endsWith("/models")) {
        return json(200, { object: "list", data: [{ id: MOCK_MODEL_ID, object: "model", created: 0, owned_by: "e2e" }] });
      }
      if (req.method === "POST" && path.endsWith("/chat/completions")) {
        entry.user = lastUserMessage(body);
        const count = (seen.get(entry.user) ?? 0) + 1;
        seen.set(entry.user, count);
        if (count <= behaviour.rateLimitFirstPerMessage) {
          entry.status = 429;
          record.push(entry);
          return json(
            429,
            { error: { message: MOCK_RATE_LIMIT_MESSAGE, type: "requests", code: "rate_limit_exceeded" } },
            { "Retry-After": String(behaviour.retryAfterSeconds) },
          );
        }
        record.push(entry);
        const reply = () =>
          json(200, {
            id: `chatcmpl-e2e-${count}`,
            object: "chat.completion",
            created: 0,
            model: (body as { model?: string }).model ?? MOCK_MODEL_ID,
            choices: [{ index: 0, message: { role: "assistant", content: `ECHO:${entry.user}` }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          });
        if (behaviour.responseDelayMs > 0) setTimeout(reply, behaviour.responseDelayMs);
        else reply();
        return;
      }
      json(404, { error: { message: `mock: no route for ${req.method} ${path}` } });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    baseUrlForLangflow: `http://${host}:${port}/v1`,
    reset(next = {}) {
      behaviour = { ...DEFAULT_BEHAVIOUR, ...next };
      record = [];
      seen = new Map();
    },
    completions: () => [...record],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
