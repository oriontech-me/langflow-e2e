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
//  - the pinned model is enabled explicitly, and with the DISPLAY name Langflow keys
//    `enabled_models` by — a wrong name is accepted with HTTP 200 and enables nothing,
//    so the server's echo is checked rather than the status;
//  - a variable pointing at a different address is UPDATED, since a name-only check
//    would call the wrong address configured.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import { preconfigureRoutedProvider } from "./preconfigure-routed-provider";

interface Recorded {
  method: "GET" | "POST" | "PATCH";
  url: string;
  data?: unknown;
}

interface Reply {
  ok?: boolean;
  status?: number;
  body?: unknown;
}

/**
 * Minimal APIRequestContext double, keyed by `"<METHOD> <path>"`.
 *
 * Keyed by METHOD and path, not by path alone, and that is not cosmetic: this file's
 * whole subject is a POST that 400s on a path whose GET must still answer 200. Keying
 * on the path made `"/api/v1/variables/": { status: 400 }` break the LISTING too, so
 * the code under test reached the create through `existing.ok() === false` and the real
 * duplicate path — listing succeeds and reports the variable absent, then the create
 * loses the race — was never executed. That is #1216's lesson in miniature: a fixture
 * shaped so the assertion passes for the wrong reason.
 *
 * Anything not listed answers 200 with an empty body, which keeps each test's setup to
 * the one call it is about.
 */
function fakeRequest(
  replies: Record<string, Reply>,
  recorded: Recorded[] = [],
): APIRequestContext {
  const reply = (method: string, url: string) => {
    const r = replies[`${method} ${url}`] ?? {};
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
      return reply("GET", url);
    },
    post: async (url: string, options?: { data?: unknown }) => {
      recorded.push({ method: "POST", url, data: options?.data });
      return reply("POST", url);
    },
    patch: async (url: string, options?: { data?: unknown }) => {
      recorded.push({ method: "PATCH", url, data: options?.data });
      return reply("PATCH", url);
    },
  } as unknown as APIRequestContext;
}

const AUTH: Reply = { body: { access_token: "t" } };
// The server echoes both lists as "<Provider>::<type>::<model>" and the helper checks
// that composite key — so the double has to answer with it or the happy paths are not
// happy. Verified against a live 1.12.0.dev10 instance.
const ENABLED_OK: Reply = {
  body: { enabled_models: ["Ollama::llm::llama3.2:1b"], disabled_models: [] },
};
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
    {
      "GET /api/v1/auto_login": AUTH,
      "GET /api/v1/variables/": { body: [] },
      "POST /api/v1/models/enabled_models": ENABLED_OK,
    },
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
      "GET /api/v1/auto_login": AUTH,
      "GET /api/v1/variables/": { body: [{ name: "OLLAMA_BASE_URL", id: "v1", value: "http://ollama:11434" }] },
      "POST /api/v1/models/enabled_models": ENABLED_OK,
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
    "GET /api/v1/auto_login": AUTH,
    // The listing says absent (this shard read before the other wrote), the create
    // then loses the race.
    "GET /api/v1/variables/": { body: [] },
    "POST /api/v1/variables/": { status: 400, body: { detail: "Variable name already exists" } },
    "POST /api/v1/models/enabled_models": ENABLED_OK,
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, true, result.detail);
});

test("a non-duplicate failure on the create is reported, not thrown", async () => {
  const req = fakeRequest({
    "GET /api/v1/auto_login": AUTH,
    "GET /api/v1/variables/": { body: [] },
    "POST /api/v1/variables/": { status: 403, body: { detail: "forbidden" } },
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /403/);
  assert.match(result.detail, /OLLAMA_BASE_URL/);
});

test("a failure to enable the model is reported and names the model", async () => {
  const req = fakeRequest({
    "GET /api/v1/auto_login": AUTH,
    "GET /api/v1/variables/": { body: [{ name: "OLLAMA_BASE_URL", id: "v1", value: "http://ollama:11434" }] },
    "POST /api/v1/models/enabled_models": { status: 500, body: { detail: "boom" } },
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /llama3\.2:1b/);
});

test("refuses a provider that is not keyless, naming the right knob", async () => {
  const req = fakeRequest({ "GET /api/v1/auto_login": AUTH });
  const result = await preconfigureRoutedProvider(req, {
    ...ROUTED_ENV,
    ANY_COMPLETION_PROVIDER: "openai",
  });
  assert.equal(result.attempted, true);
  assert.equal(result.configured, false);
  assert.match(result.detail, /API-key provider/);
});

test("refuses an unknown provider", async () => {
  const req = fakeRequest({ "GET /api/v1/auto_login": AUTH });
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
  const req = fakeRequest({ "GET /api/v1/auto_login": AUTH });
  const result = await preconfigureRoutedProvider(req, {
    ANY_COMPLETION_PROVIDER: "ollama",
    OLLAMA_BASE_URL_FROM_LANGFLOW: "http://ollama:11434",
  });
  assert.equal(result.configured, false);
  assert.match(result.detail, /OLLAMA_TEST_MODEL/);
});

test("reports an unobtainable auth token without writing anything", async () => {
  const recorded: Recorded[] = [];
  const req = fakeRequest({ "GET /api/v1/auto_login": { status: 401, body: {} } }, recorded);
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /auth token/);
  assert.equal(
    recorded.filter((r) => r.method === "POST").length,
    0,
    "no write may be attempted unauthenticated",
  );
});

test("a 200 that did not actually enable the model is reported, not trusted", async () => {
  // The one silent path. Measured on 1.12.0.dev10: posting a provider name Langflow
  // does not know is accepted with HTTP 200 and stores a bogus `ollama::llm::<tag>`
  // entry that no real provider matches — so `ok()` alone would print "routed provider
  // ready" over a no-op. Note the echo below CONTAINS the model tag: a substring test
  // on the model name passes here, which is why the check is the composite key.
  const req = fakeRequest({
    "GET /api/v1/auto_login": AUTH,
    "GET /api/v1/variables/": { body: [{ name: "OLLAMA_BASE_URL", id: "v1", value: "http://ollama:11434" }] },
    "POST /api/v1/models/enabled_models": {
      body: { enabled_models: ["ollama::llm::llama3.2:1b"], disabled_models: [] },
    },
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /Ollama::llm::llama3\.2:1b/);
});

test("updates a variable whose value points somewhere else", async () => {
  // Reachable in practice: a dev box holds host.docker.internal from a dockerized run
  // while the lane wants ollama:11434. A name-only check would call that configured and
  // defer the real verdict to whichever spec opened the dropdown first.
  const recorded: Recorded[] = [];
  const req = fakeRequest(
    {
      "GET /api/v1/auto_login": AUTH,
      "GET /api/v1/variables/": {
        body: [{ name: "OLLAMA_BASE_URL", id: "v1", value: "http://host.docker.internal:11434" }],
      },
      "POST /api/v1/models/enabled_models": ENABLED_OK,
    },
    recorded,
  );
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);

  assert.equal(result.configured, true, result.detail);
  const patched = recorded.find((r) => r.method === "PATCH");
  // The ITEM route, not the collection: `PATCH /api/v1/variables/` answers 405, which a
  // local run proved the hard way.
  assert.equal(patched?.url, "/api/v1/variables/v1");
  assert.deepEqual(patched?.data, {
    id: "v1",
    name: "OLLAMA_BASE_URL",
    value: "http://ollama:11434",
    type: "Global",
    default_fields: [],
  });
});

test("reports a failed update instead of running against the wrong address", async () => {
  const req = fakeRequest({
    "GET /api/v1/auto_login": AUTH,
    "GET /api/v1/variables/": {
      body: [{ name: "OLLAMA_BASE_URL", id: "v1", value: "http://elsewhere:11434" }],
    },
    "PATCH /api/v1/variables/v1": { status: 500, body: { detail: "nope" } },
  });
  const result = await preconfigureRoutedProvider(req, ROUTED_ENV);
  assert.equal(result.configured, false);
  assert.match(result.detail, /elsewhere/);
  assert.match(result.detail, /ollama:11434/);
});
