// Unit tests for Azure AI Foundry as an agent-spec provider (issue #2281).
// Run with: npm run test:units
//
// What these pin, and why:
//
//  - The key-axis probe sends NO `temperature` and uses `max_completion_tokens`. The
//    rotation deployment (`gpt-5.6-sol`) answers 400 to a non-default temperature,
//    so a probe that sent one would record a live account as dead.
//  - `azureFoundryTargeted` is the single predicate that decides who owns the
//    instance's Foundry credential — `globalSetup` configures on it, the Foundry
//    provider spec yields on it. It must answer `false` for a run pinned elsewhere,
//    or the Foundry spec would skip on every weekday instead of one.
//  - The configuration writes the key BEFORE the endpoint (the backend validates the
//    last write), treats a duplicate 400 as configured (another worker won the first
//    write), and checks the server's echo, because an unknown provider name is
//    accepted with HTTP 200 and enables nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  azureFoundryChatUrl,
  azureFoundryDeclaration,
  azureFoundryTargeted,
  ensureAzureFoundryConfigured,
  validateAzureFoundry,
} from "./azure-foundry";

const ENV = {
  AZURE_AI_FOUNDRY_API_KEY: "k",
  AZURE_AI_FOUNDRY_ENDPOINT: "https://res.openai.azure.com/openai/v1/",
  AZURE_AI_FOUNDRY_TEST_DEPLOYMENT: "gpt-5.6-sol",
};

// ─── Declaration and URL ─────────────────────────────────────────────────────

test("a declaration needs all three variables and names the missing ones", () => {
  const partial = azureFoundryDeclaration({ AZURE_AI_FOUNDRY_API_KEY: "k" });
  assert.equal(partial.declared, false);
  assert.deepEqual(
    (partial as { missing: string[] }).missing,
    ["AZURE_AI_FOUNDRY_ENDPOINT", "AZURE_AI_FOUNDRY_TEST_DEPLOYMENT"],
  );
  const full = azureFoundryDeclaration(ENV);
  assert.equal(full.declared, true);
  assert.equal((full as { endpoint: string }).endpoint, "https://res.openai.azure.com/openai/v1");
});

test("the chat URL maps a Foundry PROJECT endpoint the way Langflow does", () => {
  assert.equal(
    azureFoundryChatUrl("https://res.services.ai.azure.com/api/projects/Orion-e2e"),
    "https://res.services.ai.azure.com/openai/v1/chat/completions",
  );
  assert.equal(
    azureFoundryChatUrl("https://res.openai.azure.com/openai/v1"),
    "https://res.openai.azure.com/openai/v1/chat/completions",
  );
});

// ─── Key axis ────────────────────────────────────────────────────────────────

function fakeFetch(status: number, body: unknown, seen: Array<{ url: string; init: RequestInit }>) {
  return async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
}

test("an undeclared provider is inactive without any network call", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const verdict = await validateAzureFoundry({}, fakeFetch(200, {}, seen));
  assert.equal(verdict.status, "inactive");
  assert.equal(verdict.model, null);
  assert.match(verdict.error ?? "", /AZURE_AI_FOUNDRY_API_KEY.*not set/);
  assert.equal(seen.length, 0);
});

test("the probe sends no temperature, caps with max_completion_tokens, and authenticates by api-key", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const verdict = await validateAzureFoundry(ENV, fakeFetch(200, { choices: [] }, seen));
  assert.deepEqual(verdict, { status: "active", model: "gpt-5.6-sol", error: null });
  assert.equal(seen[0].url, "https://res.openai.azure.com/openai/v1/chat/completions");
  const body = JSON.parse(String(seen[0].init.body));
  assert.equal(body.model, "gpt-5.6-sol");
  assert.ok(!("temperature" in body), "a non-default temperature is a 400 on gpt-5*");
  assert.ok(!("max_tokens" in body), "gpt-5* refuses max_tokens");
  assert.ok(body.max_completion_tokens > 1);
  assert.equal((seen[0].init.headers as Record<string, string>)["api-key"], "k");
});

test("a refusal keeps Azure's own message, and a transport error is inactive too", async () => {
  const refused = await validateAzureFoundry(
    ENV,
    fakeFetch(401, { error: { message: "Access denied due to invalid subscription key" } }, []),
  );
  assert.equal(refused.status, "inactive");
  assert.equal(refused.model, "gpt-5.6-sol");
  assert.equal(refused.error, "Access denied due to invalid subscription key");

  const down = await validateAzureFoundry(ENV, async () => {
    throw new Error("getaddrinfo ENOTFOUND res.openai.azure.com");
  });
  assert.equal(down.status, "inactive");
  assert.match(down.error ?? "", /ENOTFOUND/);
});

// ─── Who owns the credential ─────────────────────────────────────────────────

const CATALOG = [
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "azure-ai-foundry", model: "gpt-5.6-sol" },
];
const HEALTHY = new Map<string, string>();

test("a run pinned to another provider does NOT target Foundry", () => {
  assert.equal(
    azureFoundryTargeted({
      env: { ...ENV, MODEL_TEST_PROVIDER: "openai", MODEL_TEST_ID: "gpt-4o-mini" },
      models: CATALOG,
      skipReasons: HEALTHY,
    }),
    false,
  );
});

test("a run pinned to Foundry, or unpinned with Foundry in the catalog, targets it", () => {
  for (const env of [
    { ...ENV, MODEL_TEST_PROVIDER: "azure-ai-foundry", MODEL_TEST_ID: "gpt-5.6-sol" },
    { ...ENV, MODEL_TEST_PROVIDER: "azure-ai-foundry" },
    { ...ENV },
  ]) {
    assert.equal(
      azureFoundryTargeted({ env, models: CATALOG, skipReasons: HEALTHY }),
      true,
      JSON.stringify(env),
    );
  }
});

test("a Foundry pin is honoured even when OpenAI lists a model of the same name (#2281)", () => {
  // The real catalog does: OpenAI ships `gpt-5.6-sol` too. Without the pair rule in
  // resolveTestTargets this answered false, so globalSetup never configured Foundry
  // and the run went to OpenAI.
  const colliding = [
    { provider: "openai", model: "gpt-5.6-sol" },
    { provider: "azure-ai-foundry", model: "gpt-5.6-sol" },
  ];
  assert.equal(
    azureFoundryTargeted({
      env: { ...ENV, MODEL_TEST_PROVIDER: "azure-ai-foundry", MODEL_TEST_ID: "gpt-5.6-sol" },
      models: colliding,
      skipReasons: HEALTHY,
    }),
    true,
  );
});

test("Foundry is not targeted when undeclared, absent from the catalog, or skipped by health", () => {
  assert.equal(azureFoundryTargeted({ env: {}, models: CATALOG, skipReasons: HEALTHY }), false);
  assert.equal(
    azureFoundryTargeted({ env: ENV, models: [CATALOG[0]], skipReasons: HEALTHY }),
    false,
  );
  assert.equal(
    azureFoundryTargeted({
      env: ENV,
      models: CATALOG,
      skipReasons: new Map([["azure-ai-foundry", "inactive: quota"]]),
    }),
    false,
  );
});

// ─── Configuration over the API ──────────────────────────────────────────────

interface Recorded {
  method: string;
  url: string;
  data?: unknown;
}

interface Reply {
  status?: number;
  body?: unknown;
}

function fakeRequest(replies: Record<string, Reply | Reply[]>, recorded: Recorded[]): APIRequestContext {
  const calls = new Map<string, number>();
  const reply = (method: string, url: string) => {
    const key = `${method} ${url}`;
    const entry = replies[key];
    const n = calls.get(key) ?? 0;
    calls.set(key, n + 1);
    const r = (Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry) ?? {};
    const status = r.status ?? 200;
    const body = r.body ?? {};
    return {
      ok: () => status >= 200 && status < 300,
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
  } as unknown as APIRequestContext;
}

const AUTH: Reply = { body: { access_token: "t" } };
const ENABLED_OK: Reply = {
  body: { enabled_models: ["Azure AI Foundry::llm::gpt-5.6-sol"], disabled_models: [] },
};

test("writes the key BEFORE the endpoint, then enables the deployment under the display name", async () => {
  const recorded: Recorded[] = [];
  const result = await ensureAzureFoundryConfigured(
    fakeRequest(
      {
        "GET /api/v1/auto_login": AUTH,
        "GET /api/v1/variables/": { body: [] },
        "POST /api/v1/models/enabled_models": ENABLED_OK,
      },
      recorded,
    ),
    ENV,
  );
  assert.equal(result.configured, true, result.detail);
  assert.equal(result.wrote, true);
  const writes = recorded.filter((r) => r.method === "POST" && r.url === "/api/v1/variables/");
  assert.deepEqual(
    writes.map((w) => (w.data as { name: string }).name),
    ["AZURE_AI_FOUNDRY_API_KEY", "AZURE_AI_FOUNDRY_ENDPOINT"],
  );
  assert.equal((writes[1].data as { value: string }).value, "https://res.openai.azure.com/openai/v1");
  const enable = recorded.find((r) => r.url === "/api/v1/models/enabled_models");
  assert.deepEqual(enable?.data, [
    { provider: "Azure AI Foundry", model_id: "gpt-5.6-sol", enabled: true, model_type: "llm" },
  ]);
  assert.doesNotMatch(result.detail, /\bk\b/, "the detail must never carry the key");
});

test("an already-configured instance is not written to, and reports wrote=false", async () => {
  const recorded: Recorded[] = [];
  const result = await ensureAzureFoundryConfigured(
    fakeRequest(
      {
        "GET /api/v1/auto_login": AUTH,
        "GET /api/v1/variables/": {
          body: [{ name: "AZURE_AI_FOUNDRY_API_KEY" }, { name: "AZURE_AI_FOUNDRY_ENDPOINT" }],
        },
        "POST /api/v1/models/enabled_models": ENABLED_OK,
      },
      recorded,
    ),
    ENV,
  );
  assert.equal(result.configured, true);
  assert.equal(result.wrote, false);
  assert.equal(recorded.filter((r) => r.url === "/api/v1/variables/" && r.method === "POST").length, 0);
});

test("a duplicate 400 means another worker configured it — not an error", async () => {
  const result = await ensureAzureFoundryConfigured(
    fakeRequest(
      {
        "GET /api/v1/auto_login": AUTH,
        "GET /api/v1/variables/": { body: [] },
        "POST /api/v1/variables/": { status: 400, body: { detail: "Variable name already exists" } },
        "POST /api/v1/models/enabled_models": ENABLED_OK,
      },
      [],
    ),
    ENV,
  );
  assert.equal(result.configured, true, result.detail);
  assert.equal(result.wrote, false);
});

test("a refused enable and a missing echo are both reported, never configured", async () => {
  const refused = await ensureAzureFoundryConfigured(
    fakeRequest(
      {
        "GET /api/v1/auto_login": AUTH,
        "GET /api/v1/variables/": { body: [] },
        "POST /api/v1/models/enabled_models": {
          status: 400,
          body: { detail: "Validation failed for Azure AI Foundry: 401" },
        },
      },
      [],
    ),
    ENV,
  );
  assert.equal(refused.configured, false);
  assert.match(refused.detail, /Validation failed for Azure AI Foundry/);

  const silent = await ensureAzureFoundryConfigured(
    fakeRequest(
      {
        "GET /api/v1/auto_login": AUTH,
        "GET /api/v1/variables/": { body: [] },
        "POST /api/v1/models/enabled_models": { body: { enabled_models: [] } },
      },
      [],
    ),
    ENV,
  );
  assert.equal(silent.configured, false);
  assert.match(silent.detail, /did not report "Azure AI Foundry::llm::gpt-5\.6-sol"/);
});

test("an undeclared provider makes no request at all", async () => {
  const recorded: Recorded[] = [];
  const result = await ensureAzureFoundryConfigured(fakeRequest({}, recorded), {});
  assert.equal(result.configured, false);
  assert.deepEqual(recorded, []);
});
