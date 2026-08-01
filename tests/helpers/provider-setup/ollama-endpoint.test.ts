// Unit tests for the local-Ollama endpoint resolution (issue #1187).
// Run with: npm run test:units
//
// Small surface, two traps worth pinning:
//
//  - The TWO urls must not collapse into one. `OLLAMA_BASE_URL` is what the test host
//    probes; `OLLAMA_BASE_URL_FROM_LANGFLOW` is what Langflow calls. They differ on
//    every dockerized local setup (`localhost` vs `host.docker.internal`) and only
//    coincide in CI, where both are the sibling service (#583).
//  - The model must NOT default. `ollama-provider.spec.ts` carried a hardcoded
//    fallback and it lied: with the baked model changed, the probe reported "model not
//    pulled" and the test skipped silently on the surface it exists to guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL_FROM_LANGFLOW,
  ollamaBaseUrl,
  ollamaBaseUrlFromLangflow,
  ollamaTestModel,
} from "./ollama-endpoint";

test("the two default urls are different vantage points, not a duplicate", () => {
  assert.equal(OLLAMA_DEFAULT_BASE_URL, "http://localhost:11434");
  assert.equal(OLLAMA_DEFAULT_BASE_URL_FROM_LANGFLOW, "http://host.docker.internal:11434");
  assert.notEqual(OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_BASE_URL_FROM_LANGFLOW);
});

test("each url reads its own variable and neither leaks into the other", () => {
  const env = {
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_BASE_URL_FROM_LANGFLOW: "http://ollama:11434",
  };
  assert.equal(ollamaBaseUrl(env), "http://localhost:11434");
  assert.equal(ollamaBaseUrlFromLangflow(env), "http://ollama:11434");
});

test("an unset or empty variable falls back to its default", () => {
  assert.equal(ollamaBaseUrl({}), OLLAMA_DEFAULT_BASE_URL);
  assert.equal(ollamaBaseUrl({ OLLAMA_BASE_URL: "" }), OLLAMA_DEFAULT_BASE_URL);
  assert.equal(ollamaBaseUrlFromLangflow({}), OLLAMA_DEFAULT_BASE_URL_FROM_LANGFLOW);
  assert.equal(
    ollamaBaseUrlFromLangflow({ OLLAMA_BASE_URL_FROM_LANGFLOW: "" }),
    OLLAMA_DEFAULT_BASE_URL_FROM_LANGFLOW,
  );
});

test("the CI shape — one hostname for both — resolves to that hostname twice", () => {
  const env = {
    OLLAMA_BASE_URL: "http://ollama:11434",
    OLLAMA_BASE_URL_FROM_LANGFLOW: "http://ollama:11434",
  };
  assert.equal(ollamaBaseUrl(env), "http://ollama:11434");
  assert.equal(ollamaBaseUrlFromLangflow(env), "http://ollama:11434");
});

test("the model is never invented — unset and empty both read as `undefined`", () => {
  assert.equal(ollamaTestModel({}), undefined);
  assert.equal(ollamaTestModel({ OLLAMA_TEST_MODEL: "" }), undefined);
  assert.equal(ollamaTestModel({ OLLAMA_TEST_MODEL: "llama3.2:1b" }), "llama3.2:1b");
});
