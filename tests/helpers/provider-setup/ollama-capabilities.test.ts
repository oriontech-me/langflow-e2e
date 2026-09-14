// Unit tests for the Ollama capability oracle (issue #1810).
// Run with: npm run test:units
//
// The oracle is what makes `assistant-ollama-provider.spec.ts` worth running: it
// answers "which models does this Ollama instance really serve?" from the Ollama API
// itself, so a Langflow response can be checked against something Langflow did not
// produce. Three traps worth pinning:
//
//  - `completion` is the class Langflow lists, not `tools`. `fetch_live_ollama_models`
//    marks every completion tag as tool-calling, so the Assistant's "tool-calling only"
//    filter is a no-op for Ollama today. The spec therefore bounds the list between
//    the two classes, and `boundOllamaModelList` must report each side separately.
//  - An unreadable tag is NOT a tag without capabilities. Folding it into "embedding
//    only" or "no completion" would turn an oracle that failed to read into one that
//    confidently disagrees with Langflow (#1012: unknown is not clean).
//  - A pinned model is the lane's choice and must never be substituted: a drifted CI
//    image skips naming what IS available (the `ollama-provider.spec.ts` lesson).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  boundOllamaModelList,
  classifyOllamaCapabilities,
  declaredParameterCountB,
  readOllamaCapabilities,
  resolveAssistantTestModel,
  resolveComponentTestModel,
  type OllamaHttp,
} from "./ollama-capabilities";

// ---------------------------------------------------------------------------
// classifyOllamaCapabilities
// ---------------------------------------------------------------------------

test("classifies completion, completion+tools, embedding-only and unreadable tags", () => {
  const classes = classifyOllamaCapabilities([
    { name: "qwen2.5:0.5b", capabilities: ["completion", "tools"] },
    { name: "gemma2:2b", capabilities: ["completion"] },
    { name: "all-minilm:latest", capabilities: ["embedding"] },
    { name: "broken:tag", capabilities: null },
  ]);

  assert.deepEqual(classes.tags, ["qwen2.5:0.5b", "gemma2:2b", "all-minilm:latest", "broken:tag"]);
  assert.deepEqual(classes.completion, ["qwen2.5:0.5b", "gemma2:2b"]);
  assert.deepEqual(classes.completionWithTools, ["qwen2.5:0.5b"]);
  assert.deepEqual(classes.embeddingOnly, ["all-minilm:latest"]);
  assert.deepEqual(classes.unreadable, ["broken:tag"]);
});

test("a tag declaring both embedding and completion is a completion tag, not embedding-only", () => {
  const classes = classifyOllamaCapabilities([
    { name: "dual:latest", capabilities: ["embedding", "completion"] },
  ]);
  assert.deepEqual(classes.completion, ["dual:latest"]);
  assert.deepEqual(classes.embeddingOnly, []);
});

test("an empty capabilities array is unreadable, never a tag with no capabilities", () => {
  // Langflow's own reader never caches an empty list for the same reason: a 200 with
  // no capabilities is indistinguishable from a transient read.
  const classes = classifyOllamaCapabilities([{ name: "empty:tag", capabilities: [] }]);
  assert.deepEqual(classes.unreadable, ["empty:tag"]);
  assert.deepEqual(classes.completion, []);
  assert.deepEqual(classes.embeddingOnly, []);
});

// ---------------------------------------------------------------------------
// boundOllamaModelList
// ---------------------------------------------------------------------------

const DEV_BOX = classifyOllamaCapabilities([
  { name: "qwen2.5:0.5b", capabilities: ["completion", "tools"] },
  { name: "gemma2:2b", capabilities: ["completion"] },
  { name: "all-minilm:latest", capabilities: ["embedding"] },
]);

test("a list between completion+tools and completion has no violations", () => {
  assert.deepEqual(boundOllamaModelList(["qwen2.5:0.5b"], DEV_BOX), {
    missing: [],
    notCompletion: [],
    embeddingOnly: [],
  });
  assert.deepEqual(boundOllamaModelList(["qwen2.5:0.5b", "gemma2:2b"], DEV_BOX), {
    missing: [],
    notCompletion: [],
    embeddingOnly: [],
  });
});

test("a dropped tool-capable tag is reported as missing", () => {
  assert.deepEqual(boundOllamaModelList(["gemma2:2b"], DEV_BOX).missing, ["qwen2.5:0.5b"]);
});

test("a static-catalog fallback reports every catalog name as not a completion tag", () => {
  // What check-config returns when the live fetch fails: the provider's static names.
  const verdict = boundOllamaModelList(["llama3.3", "qwq"], DEV_BOX);
  assert.deepEqual(verdict.notCompletion, ["llama3.3", "qwq"]);
  assert.deepEqual(verdict.missing, ["qwen2.5:0.5b"]);
});

test("an admitted embedding tag is reported on both the upper bound and its own list", () => {
  const verdict = boundOllamaModelList(["qwen2.5:0.5b", "all-minilm:latest"], DEV_BOX);
  assert.deepEqual(verdict.notCompletion, ["all-minilm:latest"]);
  assert.deepEqual(verdict.embeddingOnly, ["all-minilm:latest"]);
});

// ---------------------------------------------------------------------------
// resolveAssistantTestModel
// ---------------------------------------------------------------------------

test("a pinned completion model is used as-is", () => {
  assert.deepEqual(resolveAssistantTestModel(DEV_BOX, "gemma2:2b"), { model: "gemma2:2b" });
});

test("a pinned model the instance does not serve skips naming what it does serve", () => {
  const resolution = resolveAssistantTestModel(DEV_BOX, "llama3.2:1b");
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /llama3\.2:1b/);
  assert.match(resolution.skipReason, /qwen2\.5:0\.5b/);
});

test("a pinned model that is not completion-capable skips instead of being substituted", () => {
  const resolution = resolveAssistantTestModel(DEV_BOX, "all-minilm:latest");
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /all-minilm:latest/);
  assert.match(resolution.skipReason, /completion/);
});

test("unpinned, the first tool-capable completion tag is preferred over an earlier plain one", () => {
  // A tool-capable tag is listed by the Assistant whether or not upstream ever makes its
  // tool-calling filter real for Ollama; a plain completion tag is listed only today.
  const classes = classifyOllamaCapabilities([
    { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
    { name: "gemma2:2b", capabilities: ["completion"] },
    { name: "qwen2.5:0.5b", capabilities: ["completion", "tools"] },
  ]);
  assert.deepEqual(resolveAssistantTestModel(classes, undefined), { model: "qwen2.5:0.5b" });
  assert.deepEqual(resolveAssistantTestModel(classes, ""), { model: "qwen2.5:0.5b" });
});

test("unpinned, with no tool-capable tag, the first completion tag in the instance's order is used", () => {
  const classes = classifyOllamaCapabilities([
    { name: "all-minilm:latest", capabilities: ["embedding"] },
    { name: "gemma2:2b", capabilities: ["completion"] },
    { name: "phi:2.7b", capabilities: ["completion"] },
  ]);
  assert.deepEqual(resolveAssistantTestModel(classes, undefined), { model: "gemma2:2b" });
});

test("unpinned, an instance with no completion tag skips", () => {
  const classes = classifyOllamaCapabilities([
    { name: "all-minilm:latest", capabilities: ["embedding"] },
  ]);
  const resolution = resolveAssistantTestModel(classes, undefined);
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /no completion-capable/);
});

// ---------------------------------------------------------------------------
// resolveComponentTestModel (#1850)
// ---------------------------------------------------------------------------

// The instance #1850 was measured on, in its own /api/tags order: two embedding tags
// BEFORE the only chat model. Taking the first tag is the defect.
const EMBEDDING_FIRST = classifyOllamaCapabilities([
  { name: "all-minilm:latest", capabilities: ["embedding"] },
  { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
  { name: "qwen2.5:0.5b", capabilities: ["completion", "tools"] },
]);

test("unpinned, an embedding tag listed first is never chosen — the first completion tag is", () => {
  assert.deepEqual(resolveComponentTestModel(EMBEDDING_FIRST, undefined), { model: "qwen2.5:0.5b" });
  assert.deepEqual(resolveComponentTestModel(EMBEDDING_FIRST, ""), { model: "qwen2.5:0.5b" });
});

test("unpinned, instance order decides between completion tags — tools earn no preference here", () => {
  // The component lists every completion tag, `tools` or not, so preferring a tool-capable
  // one (as the Assistant resolver does) would only reorder what is already listed.
  const classes = classifyOllamaCapabilities([
    { name: "gemma2:2b", capabilities: ["completion"] },
    { name: "qwen2.5:0.5b", capabilities: ["completion", "tools"] },
  ]);
  assert.deepEqual(resolveComponentTestModel(classes, undefined), { model: "gemma2:2b" });
});

test("unpinned, an unreadable tag is never chosen, even as the only candidate left", () => {
  // Unknown is not completion (#1012): resolving from an unread capability is how an
  // embedding tag got picked in the first place.
  const classes = classifyOllamaCapabilities([
    { name: "all-minilm:latest", capabilities: ["embedding"] },
    { name: "mystery:tag", capabilities: null },
  ]);
  const resolution = resolveComponentTestModel(classes, undefined);
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /embedding-only: all-minilm:latest/);
  assert.match(resolution.skipReason, /capabilities unreadable: mystery:tag/);
  assert.match(resolution.skipReason, /OLLAMA_TEST_MODEL/);
});

test("unpinned, an instance serving only embedding models skips naming them", () => {
  const classes = classifyOllamaCapabilities([
    { name: "all-minilm:latest", capabilities: ["embedding"] },
    { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
  ]);
  const resolution = resolveComponentTestModel(classes, undefined);
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /no completion model/);
  assert.match(resolution.skipReason, /embedding-only: all-minilm:latest, nomic-embed-text:latest/);
});

test("unpinned, a tag with capabilities but no completion is named as such", () => {
  const classes = classifyOllamaCapabilities([{ name: "vision-only:tag", capabilities: ["vision"] }]);
  const resolution = resolveComponentTestModel(classes, undefined);
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /no completion capability: vision-only:tag/);
});

test("unpinned, a model-less instance skips saying it serves no model", () => {
  const resolution = resolveComponentTestModel(classifyOllamaCapabilities([]), undefined);
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /serves no model/);
});

test("a pinned completion model is used as-is, wherever the instance lists it", () => {
  assert.deepEqual(resolveComponentTestModel(EMBEDDING_FIRST, "qwen2.5:0.5b"), {
    model: "qwen2.5:0.5b",
  });
});

test("a pinned model the instance does not serve skips naming what it serves", () => {
  const resolution = resolveComponentTestModel(EMBEDDING_FIRST, "llama3.2:1b");
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /"llama3\.2:1b" is not served/);
  assert.match(resolution.skipReason, /all-minilm:latest, nomic-embed-text:latest, qwen2\.5:0\.5b/);
});

test("a pinned embedding model skips instead of waiting for a dropdown option that cannot exist", () => {
  const resolution = resolveComponentTestModel(EMBEDDING_FIRST, "all-minilm:latest");
  assert.ok("skipReason" in resolution);
  assert.match(resolution.skipReason, /"all-minilm:latest" is not a completion model/);
  assert.match(resolution.skipReason, /embedding-only/);
});

test("a pinned model whose capabilities could not be read is driven, not skipped", () => {
  // The deliberate difference from the Assistant resolver: a pin is the lane's choice and
  // every CI lane pins, so a failed metadata read on the test host must not turn a
  // `@stable` run into a skip. The component's own dropdown gives the verdict.
  const classes = classifyOllamaCapabilities([
    { name: "llama3.2:1b", capabilities: null },
    { name: "all-minilm:latest", capabilities: ["embedding"] },
  ]);
  assert.deepEqual(resolveComponentTestModel(classes, "llama3.2:1b"), { model: "llama3.2:1b" });
});

// ---------------------------------------------------------------------------
// declaredParameterCountB
// ---------------------------------------------------------------------------

test("reads the parameter count a tag declares, in billions", () => {
  assert.equal(declaredParameterCountB("llama3.2:1b"), 1);
  assert.equal(declaredParameterCountB("qwen2.5:0.5b"), 0.5);
  assert.equal(declaredParameterCountB("qwen2.5-coder:32b"), 32);
  assert.equal(declaredParameterCountB("llama3.1:8b-instruct-q8_0"), 8);
  assert.equal(declaredParameterCountB("deepseek-r1:1.5b"), 1.5);
  assert.equal(declaredParameterCountB("hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M"), 1);
});

test("a family version number is not a parameter count", () => {
  // `3.2` and `2.5` are versions: only a digit run followed by `b` counts.
  assert.equal(declaredParameterCountB("llama3.2:latest"), undefined);
  assert.equal(declaredParameterCountB("qwen2.5"), undefined);
  assert.equal(declaredParameterCountB("mistral"), undefined);
  assert.equal(declaredParameterCountB("nomic-embed-text:latest"), undefined);
});

test("an ambiguous size is undefined rather than guessed", () => {
  // Mixture-of-experts totals and million-parameter tags are not `<N>b`.
  assert.equal(declaredParameterCountB("mixtral:8x7b"), undefined);
  assert.equal(declaredParameterCountB("gemma3:270m"), undefined);
});

// ---------------------------------------------------------------------------
// readOllamaCapabilities
// ---------------------------------------------------------------------------

interface FakeCall {
  method: "GET" | "POST";
  url: string;
  data?: unknown;
}

function fakeResponse(status: number, body: unknown) {
  return { status: () => status, json: async () => body };
}

function fakeOllama(
  routes: {
    tags: () => { status: number; body: unknown };
    show: (model: string) => { status: number; body: unknown };
  },
  calls: FakeCall[] = [],
): OllamaHttp {
  return {
    async get(url) {
      calls.push({ method: "GET", url });
      const { status, body } = routes.tags();
      return fakeResponse(status, body);
    },
    async post(url, options) {
      calls.push({ method: "POST", url, data: options?.data });
      const model = (options?.data as { model?: string } | undefined)?.model ?? "";
      const { status, body } = routes.show(model);
      return fakeResponse(status, body);
    },
  };
}

test("reads /api/tags, then /api/show per tag, and classifies the result", async () => {
  const calls: FakeCall[] = [];
  const http = fakeOllama(
    {
      tags: () => ({
        status: 200,
        body: { models: [{ name: "qwen2.5:0.5b" }, { name: "all-minilm:latest" }] },
      }),
      show: (model) => ({
        status: 200,
        body: { capabilities: model === "qwen2.5:0.5b" ? ["completion", "tools"] : ["embedding"] },
      }),
    },
    calls,
  );

  const oracle = await readOllamaCapabilities(http, "http://localhost:11434/");
  assert.ok(oracle.reachable);
  assert.deepEqual(oracle.classes.completionWithTools, ["qwen2.5:0.5b"]);
  assert.deepEqual(oracle.classes.embeddingOnly, ["all-minilm:latest"]);
  // A trailing slash on the base URL must not produce `//api/…`.
  assert.deepEqual(calls[0], { method: "GET", url: "http://localhost:11434/api/tags" });
  assert.deepEqual(calls[1], {
    method: "POST",
    url: "http://localhost:11434/api/show",
    data: { model: "qwen2.5:0.5b" },
  });
});

test("an unreachable instance is reported with the address, never classified as empty", async () => {
  const http: OllamaHttp = {
    async get() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    },
    async post() {
      throw new Error("unreachable");
    },
  };
  const oracle = await readOllamaCapabilities(http, "http://localhost:11434");
  assert.equal(oracle.reachable, false);
  assert.ok(!oracle.reachable && /not reachable at http:\/\/localhost:11434/.test(oracle.reason));
});

test("a non-200 /api/tags is reported with its status", async () => {
  const http = fakeOllama({
    tags: () => ({ status: 503, body: {} }),
    show: () => ({ status: 200, body: {} }),
  });
  const oracle = await readOllamaCapabilities(http, "http://ollama:11434");
  assert.equal(oracle.reachable, false);
  assert.ok(!oracle.reachable && /503/.test(oracle.reason));
});

test("a failed /api/show marks only that tag unreadable", async () => {
  const http = fakeOllama({
    tags: () => ({
      status: 200,
      body: { models: [{ name: "good:1b" }, { name: "bad:1b" }, { name: "shapeless:1b" }] },
    }),
    show: (model) => {
      if (model === "bad:1b") return { status: 500, body: {} };
      if (model === "shapeless:1b") return { status: 200, body: { details: {} } };
      return { status: 200, body: { capabilities: ["completion"] } };
    },
  });
  const oracle = await readOllamaCapabilities(http, "http://ollama:11434");
  assert.ok(oracle.reachable);
  assert.deepEqual(oracle.classes.completion, ["good:1b"]);
  assert.deepEqual(oracle.classes.unreadable, ["bad:1b", "shapeless:1b"]);
});
