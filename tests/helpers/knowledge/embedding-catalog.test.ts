// Unit tests for the embedding-catalog helpers (issue #2044).
// Run with: npm run test:units
//
// The catalog is `GET /api/v1/models?purpose=use` — the request the Create Knowledge
// Base dialog fires when it opens (measured on 1.13.0.dev28). Each provider entry
// carries every model type, so the embeddings are the models whose
// `metadata.model_type` is `"embeddings"`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstUnservedModel, parseEmbeddingCatalog } from "./embedding-catalog";

const GOOGLE_ENTRY = {
  provider: "Google Generative AI",
  models: [
    { model_name: "gemini-2.5-flash", metadata: { model_type: "llm", deprecated: false } },
    { model_name: "gemini-embedding-2", metadata: { model_type: "embeddings", deprecated: false } },
    {
      model_name: "models/text-embedding-004",
      metadata: { model_type: "embeddings", deprecated: true },
    },
  ],
};

test("keeps only the embeddings models, with their provider and deprecation flag", () => {
  assert.deepEqual(parseEmbeddingCatalog([GOOGLE_ENTRY]), [
    { provider: "Google Generative AI", model: "gemini-embedding-2", deprecated: false },
    { provider: "Google Generative AI", model: "models/text-embedding-004", deprecated: true },
  ]);
});

test("a model with no deprecated flag reads as not deprecated", () => {
  assert.deepEqual(
    parseEmbeddingCatalog([
      { provider: "Ollama", models: [{ model_name: "all-minilm", metadata: { model_type: "embeddings" } }] },
    ]),
    [{ provider: "Ollama", model: "all-minilm", deprecated: false }],
  );
});

test("a body that is not a provider list is refused rather than read as an empty catalog", () => {
  // An empty catalog would make "no retired model is offered" pass vacuously.
  assert.throws(() => parseEmbeddingCatalog({ detail: "Not authenticated" }), /not a provider list/);
  assert.throws(() => parseEmbeddingCatalog(null), /not a provider list/);
});

test("the first catalog model with no served tag is picked", () => {
  assert.equal(
    firstUnservedModel(["nomic-embed-text", "all-minilm", "bge-m3"], ["nomic-embed-text:latest", "all-minilm:latest"]),
    "bge-m3",
  );
});

test("a model served under any tag counts as served", () => {
  // Ollama resolves a bare name to `:latest`, so `bge-m3:567m` alone would still 404
  // for `bge-m3` — but counting it as served only skips a candidate, never picks a
  // model the server might answer for.
  assert.equal(firstUnservedModel(["bge-m3", "bge-large"], ["bge-m3:567m", "bge-m3"]), "bge-large");
});

test("a bare tag with no version serves the model", () => {
  assert.equal(firstUnservedModel(["all-minilm", "bge-m3"], ["all-minilm"]), "bge-m3");
});

test("a tag that only shares a prefix does not count as serving the model", () => {
  assert.equal(firstUnservedModel(["bge-m3"], ["bge-m3-custom:latest"]), "bge-m3");
});

test("every model served leaves nothing to pick", () => {
  assert.equal(firstUnservedModel(["all-minilm"], ["all-minilm:latest"]), undefined);
});
