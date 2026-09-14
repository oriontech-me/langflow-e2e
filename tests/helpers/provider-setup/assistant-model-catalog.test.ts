// Unit tests for the Assistant selector's expected model list (issue #1810).
// Run with: npm run test:units
//
// `assistant-ollama-provider.spec.ts` compares the model selector it renders with the
// list the panel SHOULD render, computed from the two flow-scoped reads the panel makes
// (`GET /api/v1/models` and `GET /api/v1/models/enabled_models`). This function mirrors
// the frontend's join — `useEnabledModels` plus `isModelEnabledForType` on
// release-1.13.0 — and each rule below is one a wrong mirror would silently break:
//
//  - A provider that is not `is_enabled` contributes nothing, whatever its models say.
//  - Only `model_type === "llm"` counts — an Ollama embedding model is in the same
//    catalog entry.
//  - Once a provider HAS a typed map, that map is authoritative for every type; the
//    flat map is a fallback only for a provider with no typed map at all. Reading the
//    flat map first would list a same-name embedding deployment as an LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assistantSelectorModels,
  type CatalogProviderEntry,
  type EnabledModelsResponse,
} from "./assistant-model-catalog";

const OLLAMA: CatalogProviderEntry = {
  provider: "Ollama",
  is_enabled: true,
  models: [
    { model_name: "qwen2.5:0.5b", metadata: { model_type: "llm" } },
    { model_name: "gemma2:2b", metadata: { model_type: "llm" } },
    { model_name: "all-minilm:latest", metadata: { model_type: "embeddings" } },
  ],
};

test("lists the enabled LLMs of the provider, in catalog order, from the typed map", () => {
  const enabled: EnabledModelsResponse = {
    enabled_models: {},
    enabled_models_by_type: {
      Ollama: {
        llm: { "qwen2.5:0.5b": true, "gemma2:2b": true },
        embeddings: { "all-minilm:latest": true },
      },
    },
  };
  assert.deepEqual(assistantSelectorModels([OLLAMA], enabled, "Ollama"), [
    "qwen2.5:0.5b",
    "gemma2:2b",
  ]);
});

test("a model disabled in the typed map is not listed", () => {
  const enabled: EnabledModelsResponse = {
    enabled_models_by_type: { Ollama: { llm: { "qwen2.5:0.5b": true, "gemma2:2b": false } } },
  };
  assert.deepEqual(assistantSelectorModels([OLLAMA], enabled, "Ollama"), ["qwen2.5:0.5b"]);
});

test("an embedding model is never listed, even when enabled in the flat map", () => {
  const enabled: EnabledModelsResponse = {
    enabled_models: { Ollama: { "qwen2.5:0.5b": true, "all-minilm:latest": true } },
  };
  assert.deepEqual(assistantSelectorModels([OLLAMA], enabled, "Ollama"), ["qwen2.5:0.5b"]);
});

test("the flat map is used only when the provider has no typed map", () => {
  const flatOnly: EnabledModelsResponse = {
    enabled_models: { Ollama: { "gemma2:2b": true } },
  };
  assert.deepEqual(assistantSelectorModels([OLLAMA], flatOnly, "Ollama"), ["gemma2:2b"]);

  // A typed map without an `llm` key is still authoritative: nothing is an enabled LLM.
  const typedWithoutLlm: EnabledModelsResponse = {
    enabled_models: { Ollama: { "gemma2:2b": true } },
    enabled_models_by_type: { Ollama: { embeddings: { "all-minilm:latest": true } } },
  };
  assert.deepEqual(assistantSelectorModels([OLLAMA], typedWithoutLlm, "Ollama"), []);
});

test("a provider that is not enabled contributes nothing", () => {
  const enabled: EnabledModelsResponse = {
    enabled_models_by_type: { Ollama: { llm: { "qwen2.5:0.5b": true } } },
  };
  assert.deepEqual(
    assistantSelectorModels([{ ...OLLAMA, is_enabled: false }], enabled, "Ollama"),
    [],
  );
  const { is_enabled: _omitted, ...withoutFlag } = OLLAMA;
  assert.deepEqual(assistantSelectorModels([withoutFlag], enabled, "Ollama"), []);
});

test("a provider absent from the catalog yields an empty list, not an error", () => {
  assert.deepEqual(
    assistantSelectorModels([OLLAMA], { enabled_models: {} }, "OpenAI"),
    [],
  );
});

test("another provider's entries never leak into the requested one", () => {
  const openai: CatalogProviderEntry = {
    provider: "OpenAI",
    is_enabled: true,
    models: [{ model_name: "gpt-5.4", metadata: { model_type: "llm" } }],
  };
  const enabled: EnabledModelsResponse = {
    enabled_models_by_type: {
      OpenAI: { llm: { "gpt-5.4": true } },
      Ollama: { llm: { "qwen2.5:0.5b": true } },
    },
  };
  assert.deepEqual(assistantSelectorModels([openai, OLLAMA], enabled, "Ollama"), [
    "qwen2.5:0.5b",
  ]);
});
