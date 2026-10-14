// Unit tests for the OpenAI LanguageModel helper's model pin (issue #2281).
// Run with: npm run test:units
//
// The lanes emit MODEL_TEST_ID together with MODEL_TEST_PROVIDER, so the id names the
// PINNED provider's model. This helper sets up OpenAI only, and before #2281 it read
// the id regardless of provider — on an Azure AI Foundry pin that meant OpenAI's own
// `gpt-5.6-sol`, a reasoning model (#569), because the deployment shares its name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { openAIModelPin } from "./setup-language-model-openai";

test("an OpenAI pin, or an id with no provider, is honoured", () => {
  assert.equal(openAIModelPin({ MODEL_TEST_PROVIDER: "openai", MODEL_TEST_ID: "gpt-4o-mini" }), "gpt-4o-mini");
  assert.equal(openAIModelPin({ MODEL_TEST_ID: "gpt-4.1-mini" }), "gpt-4.1-mini");
});

test("a pin to another provider says nothing about which OpenAI model to use", () => {
  for (const provider of ["azure-ai-foundry", "anthropic", "google"]) {
    assert.equal(
      openAIModelPin({ MODEL_TEST_PROVIDER: provider, MODEL_TEST_ID: "gpt-5.6-sol" }),
      undefined,
      provider,
    );
  }
});

test("no id, or a blank one, is no pin", () => {
  assert.equal(openAIModelPin({}), undefined);
  assert.equal(openAIModelPin({ MODEL_TEST_ID: "  " }), undefined);
});
