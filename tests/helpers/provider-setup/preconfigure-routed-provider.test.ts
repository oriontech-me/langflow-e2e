// Unit tests for the routed-provider pre-configuration (issue #1187).
// Run with: npm run test:units
//
// What these pin, and why it is worth pinning: the helper exists to close a race that
// only appears with TWO routed spec files on a 2-worker lane, which no unit test can
// reproduce and which cost #1187 a whole measurement round to diagnose (3 of 5
// dispatches lost one declaration each to `POST /api/v1/variables/ → 400 "Variable
// name already exists"`). So what is asserted here is the contract that makes the race
// unreachable and keeps it diagnosable:
//
//  - it is a NO-OP unless routing is requested (every hosted lane must be untouched);
//  - a duplicate 400 counts as CONFIGURED, not as an error — otherwise the fix
//    reintroduces the failure it exists to remove, on the two-shards-at-once path;
//  - every refusal is REPORTED rather than thrown, because `setupOllama` is the
//    authority per spec and a preflight abort would replace its precise verdict with a
//    vague one (#1012 wants the reason surfaced, not the run killed);
//  - the pinned model is enabled explicitly, since the auto-enable Langflow does on a
//    UI save is tied to the save this step deliberately bypasses.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { preconfigureRoutedProvider } from "./preconfigure-routed-provider";

interface Recorded {
  method: "GET" | "POST";
  url: string;
  data?: unknown;
}

interface Reply {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

/**
 * Minimal APIRequestContext double. `replies` is keyed by pathname; anything not
 * listed answers 200 with an empty body, which keeps each test's setup to the one
 * call it is about.
 */
function fakeRequest(
  replies: Record<string, Reply>,
  recorded: Recorded[] = [],
): APIRequestContext {
  const reply = (url: string) => {
    const r = replies[url] ?? {};
    const status = r.status ?? 200;
    const ok = r.ok ?? (status >= 200 && status < 300);
    const body = r.body ?? {};
    return {
      ok: () => ok,
      status: () => status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return {
    get: async (url: string) => {
      recorded.push({ method: "GET", url });
      return reply(url);
    },
    post: async (url: string, options?: { data?: unknown }) => {
      recorded.push({ method: "POST", url, data: options?.data });
      return reply(url);
    },
  } as unknown as APIRequestContext;
}

const AUTH: Reply = { body: { access_token: "t" } };
const ROUTED_ENV = {
  ANY_COMPLETION_PROVIDER: "ollama",
  OLLAMA_TEST_MODEL: "llama3.2:1b",
  OLLAMA_BASE_URL_FROM_LANGFLOW: "http://ollama:11434",
};

test("does nothing at all when no routing is requested", async () => {
  const recorded: Recorded[] = [];
  const result = await preconfigureRoutedProvider(fakeRequest({}, recorded), {});
  assert.equal(result.attempted, false);
  assert.equal(result.configured, false);
  // The hosted lanes are the overwhelming majority of runs: this must not even
  // authenticate, let alone write a variable.
  assert.deepEqual(recorded, []);
});

test("creates the base-URL variable and enables the pinned model", async () => {
  const recorded: Recorded[] = [];
  const req = fakeRequest(
    { "/api/v1/auto_login": AUTH, "/api/v1/variables/": { body: [] } },
    recorded,
  );
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);

  assert.equal(result.configured, true);
  const created = recorded.find((r) => r.method === "POST" && r.url === "/api/v1/variables/");
  assert.deepEqual(created?.data, {
    name: "OLLAMA_BASE_URL",
    value: "http://ollama:11434",
    type: "Global",
    default_fields: [],
  });
  const enabled = recorded.find(
    (r) => r.method === "POST" && r.url === "/api/v1/models/enabled_models",
  );
  // Langflow keys enabled_models by DISPLAY name ("Ollama"), not by the suite's
  // lowercase provider key — posting "ollama" silently enables nothing.
  assert.deepEqual(enabled?.data, [
    { provider: "Ollama", model_id: "llama3.2:1b", enabled: true, model_type: "llm" },
  ]);
});

test("skips creation when the variable already exists, and still enables the model", async () => {
  const recorded: Recorded[] = [];
  const req = fakeRequest(
    {
      "/api/v1/auto_login": AUTH,
      "/api/v1/variables/": { body: [{ name: "OLLAMA_BASE_URL" }] },
    },
    recorded,
  );
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);

  assert.equal(result.configured, true);
  assert.equal(
    recorded.filter((r) => r.method === "POST" && r.url === "/api/v1/variables/").length,
    0,
    "an existing variable must not be re-created — that POST is what 400s",
  );
  assert.ok(
    recorded.some((r) => r.url === "/api/v1/models/enabled_models"),
    "the model must be enabled even on the already-configured path",
  );
});

test("a duplicate 400 on the create counts as configured, not as a failure", async () => {
  // The two-shards-at-once window. Treating this as an error would make the helper
  // report a gap on exactly the path it exists to make harmless.
  const req = fakeRequest({
    "/api/v1/auto_login": AUTH,
    // The listing says absent (this shard read before the other wrote), the create
    // then loses the race.
    "/api/v1/variables/": { status: 400, body: { detail: "Variable name already exists" } },
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, true, result.detail);
});

test("a non-duplicate failure on the create is reported, not thrown", async () => {
  const req = fakeRequest({
    "/api/v1/auto_login": AUTH,
    "/api/v1/variables/": { status: 403, body: { detail: "forbidden" } },
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /403/);
  assert.match(result.detail, /OLLAMA_BASE_URL/);
});

test("a failure to enable the model is reported and names the model", async () => {
  const req = fakeRequest({
    "/api/v1/auto_login": AUTH,
    "/api/v1/variables/": { body: [{ name: "OLLAMA_BASE_URL" }] },
    "/api/v1/models/enabled_models": { status: 500, body: { detail: "boom" } },
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /llama3\.2:1b/);
});

test("refuses a provider that is not keyless, naming the right knob", async () => {
  const req = fakeRequest({ "/api/v1/auto_login": AUTH });
  const result = await preconfigureRoutedProvider(req, {
    ...ROUTED_ENV,
    ANY_COMPLETION_PROVIDER: "openai",
  });
  assert.equal(result.attempted, true);
  assert.equal(result.configured, false);
  assert.match(result.detail, /API-key provider/);
});

test("refuses an unknown provider", async () => {
  const req = fakeRequest({ "/api/v1/auto_login": AUTH });
  const result = await preconfigureRoutedProvider(req, {
    ...ROUTED_ENV,
    ANY_COMPLETION_PROVIDER: "llamafile",
  });
  assert.equal(result.attempted, true);
  assert.equal(result.configured, false);
  assert.match(result.detail, /not a provider this suite knows/);
});

test("reports the missing model pin instead of guessing a tag", async () => {
  // Same reasoning as `ollamaTestModel()`: a name this suite invents is a name the
  // instance may not serve, and enabling it would look like success.
  const req = fakeRequest({ "/api/v1/auto_login": AUTH });
  const result = await preconfigureRoutedProvider(req, {
    ANY_COMPLETION_PROVIDER: "ollama",
    OLLAMA_BASE_URL_FROM_LANGFLOW: "http://ollama:11434",
  });
  assert.equal(result.configured, false);
  assert.match(result.detail, /OLLAMA_TEST_MODEL/);
});

test("reports an unobtainable auth token without writing anything", async () => {
  const recorded: Recorded[] = [];
  const req = fakeRequest({ "/api/v1/auto_login": { status: 401, body: {} } }, recorded);
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /auth token/);
  assert.equal(
    recorded.filter((r) => r.method === "POST").length,
    0,
    "no write may be attempted unauthenticated",
  );
});
