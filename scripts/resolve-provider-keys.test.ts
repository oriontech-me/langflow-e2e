// Unit tests for the provider API-key resolver (issue #976).
// Run with: node --require ts-node/register --test scripts/resolve-provider-keys.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProbeFailure } from "../tests/helpers/provider-setup/probe-provider-key";

test("a thrown fetch (no HTTP response) is transport — never burns a key", () => {
  assert.equal(classifyProbeFailure(null, "fetch failed"), "transport");
  assert.equal(classifyProbeFailure(null, "ETIMEDOUT"), "transport");
});

test("a 5xx is transport — the provider is broken, not the key", () => {
  assert.equal(classifyProbeFailure(500, "internal server error"), "transport");
  assert.equal(classifyProbeFailure(503, "overloaded_error"), "transport");
});

test("a model-scoped rejection is model — the key is not to blame", () => {
  assert.equal(classifyProbeFailure(404, "model not found"), "model");
  assert.equal(
    classifyProbeFailure(403, "The model `claude-4-opus` does not exist or you do not have access"),
    "model",
  );
  assert.equal(classifyProbeFailure(400, "model is not supported for this endpoint"), "model");
});

test("auth, billing and quota rejections are key — advance to the next candidate", () => {
  assert.equal(classifyProbeFailure(401, "invalid x-api-key"), "key");
  assert.equal(classifyProbeFailure(402, "payment required"), "key");
  assert.equal(classifyProbeFailure(429, "rate limit exceeded"), "key");
  // The exact string that took Anthropic down on the 2026-07-27 daily (#967).
  assert.equal(
    classifyProbeFailure(400, "Your credit balance is too low to access the Anthropic API."),
    "key",
  );
  assert.equal(classifyProbeFailure(429, "insufficient_quota"), "key");
  assert.equal(classifyProbeFailure(400, "RESOURCE_EXHAUSTED"), "key");
});

test("billing wording wins over a status that would otherwise read as model", () => {
  // A drained account answering 404 must still burn the key, not the model.
  assert.equal(
    classifyProbeFailure(404, "Your credit balance is too low to access the Anthropic API."),
    "key",
  );
});

test("an unrecognised failure is transport — inconclusive, never burns a key", () => {
  assert.equal(classifyProbeFailure(418, "i am a teapot"), "transport");
  assert.equal(classifyProbeFailure(400, "malformed request"), "transport");
});
