// Unit tests for OpenRouter as an agent-spec provider (issue #2292).
// Run with: npm run test:units
//
// What these pin, and why:
//
//  - A refusal reads as what it is (#2292 scope 4): 402 is the account's credit, 401
//    the key — OpenRouter's own 401 message is "User not found.", which says neither.
//    The 402 wording must keep the status, because collect-models' BILLING_OR_QUOTA
//    test reads `\b402\b` to downgrade a drained account to a transient skip.
//  - Only the PREFERRED, tool-capable models are recorded: the live catalog is ~470
//    models, and recording it would hand every per-provider sweep hundreds of targets.
//  - `openRouterTargeted` is the single predicate that decides who owns the instance's
//    OpenRouter credential — `globalSetup` configures on it, the specs that need it
//    unconfigured yield on it. It must answer `false` for a run pinned elsewhere.
//  - The configuration writes one Credential, enables the model under Langflow's display
//    name, and never puts the key in its detail.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { APIRequestContext } from "@playwright/test";
import {
  OPENROUTER_PREFERRED_MODELS,
  describeOpenRouterRefusal,
  ensureOpenRouterConfigured,
  fetchOpenRouterToolModels,
  openRouterCandidates,
  openRouterTargetModel,
  openRouterTargeted,
  validateOpenRouterModel,
} from "./openrouter";

const ENV = { OPENROUTER_API_KEY: "sk-or-v1-secret" };

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, calls: Call[] = []) {
  return async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  };
}

// ─── Refusals ─────────────────────────────────────────────────────────────────

test("a 402 names the credit and keeps the status for the billing downgrade", () => {
  const reason = describeOpenRouterRefusal(402, "Insufficient credits");
  assert.match(reason, /^HTTP 402: OpenRouter credit exhausted/);
  assert.match(reason, /Insufficient credits$/);
  // The same test collect-models.spec.ts applies to tell a transient account state
  // from a dead key.
  assert.match(reason, /\b402\b/);
});

test("a 401 says the key was refused, since OpenRouter's own message does not", () => {
  assert.equal(
    describeOpenRouterRefusal(401, "User not found."),
    "HTTP 401: OpenRouter refused the key: User not found.",
  );
});

test("any other status keeps OpenRouter's message, and an empty one keeps the status alone", () => {
  assert.equal(
    describeOpenRouterRefusal(400, "openai/no-such-model is not a valid model ID"),
    "HTTP 400: openai/no-such-model is not a valid model ID",
  );
  assert.equal(describeOpenRouterRefusal(503, undefined), "HTTP 503");
});

// ─── Catalog ──────────────────────────────────────────────────────────────────

test("the catalog keeps only tool-capable ids, read from supported_parameters", async () => {
  const calls: Call[] = [];
  const result = await fetchOpenRouterToolModels(
    "sk-or-v1-secret",
    fakeFetch(
      200,
      {
        data: [
          { id: "openai/gpt-4o-mini", supported_parameters: ["tools", "max_tokens"] },
          { id: "some/no-tools", supported_parameters: ["max_tokens"] },
          { id: "some/no-params" },
          { supported_parameters: ["tools"] },
        ],
      },
      calls,
    ),
  );
  assert.deepEqual(result, { models: ["openai/gpt-4o-mini"] });
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models");
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-or-v1-secret");
});

test("an unreadable catalog is an error, never an empty list", async () => {
  assert.deepEqual(await fetchOpenRouterToolModels("k", fakeFetch(200, { nope: true })), {
    error: "OpenRouter /models answered without a `data` list",
  });
  const refused = await fetchOpenRouterToolModels("k", fakeFetch(401, { error: { message: "User not found." } }));
  assert.ok("error" in refused);
  assert.match(refused.error, /HTTP 401: OpenRouter refused the key/);
});

test("candidates are the preferred models the catalog offers, in preference order", () => {
  assert.equal(OPENROUTER_PREFERRED_MODELS[0], "openai/gpt-4o-mini");
  assert.deepEqual(
    openRouterCandidates(["openai/gpt-4o", "meta-llama/llama-3.3-70b-instruct", "openai/gpt-4o-mini"]),
    ["openai/gpt-4o-mini", "openai/gpt-4o"],
  );
  // Exact ids: a dated snapshot or a search variant is not the preferred model.
  assert.deepEqual(openRouterCandidates(["openai/gpt-4o-mini-search-preview"]), []);
});

// ─── Key axis ─────────────────────────────────────────────────────────────────

test("the probe is a small chat completion authenticated by bearer", async () => {
  const calls: Call[] = [];
  const verdict = await validateOpenRouterModel("openai/gpt-4o-mini", ENV, fakeFetch(200, {}, calls));
  assert.deepEqual(verdict, { status: "active", error: null });
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  const body = JSON.parse(String(calls[0].init.body));
  assert.equal(body.model, "openai/gpt-4o-mini");
  assert.equal(body.max_tokens, 16);
  assert.ok(calls[0].init.signal, "the probe must be bounded");
});

test("no key is inactive without any request; a refusal and a transport error are inactive too", async () => {
  const calls: Call[] = [];
  assert.deepEqual(await validateOpenRouterModel("m", {}, fakeFetch(200, {}, calls)), {
    status: "inactive",
    error: "OPENROUTER_API_KEY not set",
  });
  assert.equal(calls.length, 0);

  const drained = await validateOpenRouterModel("m", ENV, fakeFetch(402, { error: { message: "Insufficient credits" } }));
  assert.equal(drained.status, "inactive");
  assert.match(drained.error ?? "", /^HTTP 402: OpenRouter credit exhausted/);

  const down = await validateOpenRouterModel("m", ENV, async () => {
    throw new Error("getaddrinfo ENOTFOUND openrouter.ai");
  });
  assert.deepEqual(down, { status: "inactive", error: "getaddrinfo ENOTFOUND openrouter.ai" });
});

// ─── Targeting ────────────────────────────────────────────────────────────────

const CATALOG = [
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "openrouter", model: "openai/gpt-4o-mini" },
  { provider: "openrouter", model: "openai/gpt-4o" },
];
const HEALTHY = new Map<string, string>();

test("a run pinned to another provider does NOT target OpenRouter", () => {
  const opts = {
    env: { ...ENV, MODEL_TEST_PROVIDER: "openai", MODEL_TEST_ID: "gpt-4o-mini" },
    models: CATALOG,
    skipReasons: HEALTHY,
  };
  assert.equal(openRouterTargeted(opts), false);
  assert.equal(openRouterTargetModel(opts), null);
});

test("a run pinned to OpenRouter, or unpinned with it in the catalog, targets its first model", () => {
  for (const env of [{ ...ENV, MODEL_TEST_PROVIDER: "openrouter" }, { ...ENV }]) {
    const opts = { env, models: CATALOG, skipReasons: HEALTHY };
    assert.equal(openRouterTargeted(opts), true, JSON.stringify(env));
    assert.equal(openRouterTargetModel(opts), "openai/gpt-4o-mini", JSON.stringify(env));
  }
});

test("OpenRouter is not targeted without a key, absent from the catalog, or skipped by health", () => {
  assert.equal(openRouterTargeted({ env: {}, models: CATALOG, skipReasons: HEALTHY }), false);
  assert.equal(openRouterTargeted({ env: ENV, models: [CATALOG[0]], skipReasons: HEALTHY }), false);
  assert.equal(
    openRouterTargeted({
      env: ENV,
      models: CATALOG,
      skipReasons: new Map([["openrouter", "inactive: credit exhausted"]]),
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

function fakeRequest(replies: Record<string, { status?: number; body?: unknown }>, recorded: Recorded[]): APIRequestContext {
  const reply = (method: string, url: string) => {
    const r = replies[`${method} ${url}`] ?? {};
    const status = r.status ?? 200;
    const body = r.body ?? {};
    return {
      ok: () => status >= 200 && status < 300,
      status: () => status,
      json: async () => body,
      text: async () => JSON.stringify(body),
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

test("writes one Credential, then enables the model under Langflow's display name", async () => {
  const recorded: Recorded[] = [];
  const result = await ensureOpenRouterConfigured(
    fakeRequest(
      {
        "GET /api/v1/auto_login": { body: { access_token: "t" } },
        "GET /api/v1/variables/": { body: [] },
        "POST /api/v1/models/enabled_models": {
          body: { enabled_models: ["OpenRouter::llm::openai/gpt-4o-mini"] },
        },
      },
      recorded,
    ),
    "openai/gpt-4o-mini",
    ENV,
    new Set(),
  );
  assert.equal(result.configured, true, result.detail);
  assert.equal(result.wrote, true);
  const writes = recorded.filter((r) => r.method === "POST" && r.url === "/api/v1/variables/");
  assert.deepEqual(
    writes.map((w) => w.data),
    [{ name: "OPENROUTER_API_KEY", value: "sk-or-v1-secret", type: "Credential", default_fields: [] }],
  );
  const enable = recorded.find((r) => r.url === "/api/v1/models/enabled_models");
  assert.deepEqual(enable?.data, [
    { provider: "OpenRouter", model_id: "openai/gpt-4o-mini", enabled: true, model_type: "llm" },
  ]);
  assert.doesNotMatch(result.detail, /sk-or-v1-secret/, "the detail must never carry the key");
});

test("no key makes no request at all", async () => {
  const recorded: Recorded[] = [];
  const result = await ensureOpenRouterConfigured(fakeRequest({}, recorded), "openai/gpt-4o-mini", {}, new Set());
  assert.equal(result.configured, false);
  assert.match(result.detail, /OPENROUTER_API_KEY not set/);
  assert.equal(recorded.length, 0);
});

test("a catalog DEFAULT model is confirmed by reading the effective state, not by the echo", async () => {
  // Measured on 1.13.0.dev45 (#2292): `openai/gpt-4o-mini` is one of OpenRouter's
  // defaults, so the enable answers 200 with an echo that never lists it. Requiring the
  // echo failed every OpenRouter test with OPENROUTER_NOT_CONFIGURED.
  const replies = {
    "GET /api/v1/auto_login": { body: { access_token: "t" } },
    "GET /api/v1/variables/": { body: [{ name: "OPENROUTER_API_KEY" }] },
    "POST /api/v1/models/enabled_models": { body: { enabled_models: ["OpenAI::llm::gpt-4o-mini"] } },
  };
  const enabled = await ensureOpenRouterConfigured(
    fakeRequest(
      {
        ...replies,
        "GET /api/v1/models/enabled_models?purpose=configure": {
          body: { enabled_models_by_type: { OpenRouter: { llm: { "openai/gpt-4o-mini": true } } } },
        },
      },
      [],
    ),
    "openai/gpt-4o-mini",
    ENV,
    new Set(),
  );
  assert.equal(enabled.configured, true, enabled.detail);
  assert.match(enabled.detail, /catalog default, confirmed by a read/);

  // The read is what keeps the echo check's purpose: a model the server does not
  // report enabled is still a failure, with both observations in the detail.
  const off = await ensureOpenRouterConfigured(
    fakeRequest(
      {
        ...replies,
        "GET /api/v1/models/enabled_models?purpose=configure": {
          body: { enabled_models: { OpenRouter: { "openai/gpt-4o-mini": false } } },
        },
      },
      [],
    ),
    "openai/gpt-4o-mini",
    ENV,
    new Set(),
  );
  assert.equal(off.configured, false);
  assert.match(off.detail, /did not report "OpenRouter::llm::openai\/gpt-4o-mini".*effective state read back: false/);
});

// ─── The read-back's rules (#2321) ───────────────────────────────────────────
//
// Each case below kills one mutation that left the suite green after #2293: reading an
// ABSENT model as enabled (`state !== false`), preferring the flat map over the per-type
// one, and reporting a failed read as anything but unreadable.

const READ_URL = "GET /api/v1/models/enabled_models?purpose=configure";
const NOT_ECHOED = {
  "GET /api/v1/auto_login": { body: { access_token: "t" } },
  "GET /api/v1/variables/": { body: [{ name: "OPENROUTER_API_KEY" }] },
  "POST /api/v1/models/enabled_models": { body: { enabled_models: [] } },
};

async function configureWithRead(read: { status?: number; body?: unknown }) {
  return ensureOpenRouterConfigured(
    fakeRequest({ ...NOT_ECHOED, [READ_URL]: read }, []),
    "openai/gpt-4o-mini",
    ENV,
    new Set(),
  );
}

test("a model ABSENT from the read is not enabled — the false positive the read exists to prevent", async () => {
  // An unknown provider name, or a model the live catalog did not list, reads back as
  // no entry at all. That must never confirm the configuration.
  const absent = await configureWithRead({
    body: { enabled_models: { OpenRouter: { "openai/gpt-4o": true } }, enabled_models_by_type: {} },
  });
  assert.equal(absent.configured, false);
  assert.match(absent.detail, /effective state read back: false/);
  assert.match(absent.detail, /live catalog did not load/);
});

test("the per-type map decides over the flat one, which ORs rows across model types", async () => {
  const typedOff = await configureWithRead({
    body: {
      enabled_models: { OpenRouter: { "openai/gpt-4o-mini": true } },
      enabled_models_by_type: { OpenRouter: { llm: { "openai/gpt-4o-mini": false } } },
    },
  });
  assert.equal(typedOff.configured, false, typedOff.detail);
});

test("a read that does not answer is reported as unreadable, never as a verdict", async () => {
  const failed = await configureWithRead({ status: 500, body: { detail: "boom" } });
  assert.equal(failed.configured, false);
  assert.match(failed.detail, /effective state read back: unreadable/);
  assert.doesNotMatch(failed.detail, /live catalog/);
});
