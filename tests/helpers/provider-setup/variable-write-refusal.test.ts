// Unit tests for the refused-variables-write classifier (issue #1424).
// Run with: npm run test:units
//
// What rides on this function: it decides whether a refused credential write ends
// a spec as a FAILURE or as a SKIP. Both directions cost something real.
//
// - Too permissive (skipping on a body it should fail on): the timing defect this
//   issue fixed — the panel issuing CREATE over an existing credential — would be
//   muted, and #1424 would come back with no test able to see it.
// - Too strict (failing on the environmental ones): the daily goes red every time
//   the account's key is refused or the Azure resource answers slower than the
//   backend's 10 s budget, which is precisely the three-daily streak that opened
//   this issue.
//
// Every body below is VERBATIM from a measurement: the two openai ones from the
// 2026-08-11 daily's shard-1 log (run 31475108157) and a local `PATCH` with a
// garbage key on 1.12.0.dev24; the Azure timeout from the 2026-08-10 and
// 2026-08-12 dailies (runs 31373880200 / 31581590030); the Azure 401 from a local
// `POST` against the same endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyVariableWriteRefusal,
  describeVariableWrite,
  isEnvironmentalRefusal,
  UNREADABLE_VARIABLE_WRITE_BODY,
  variableWriteDetail,
} from "./variable-write-refusal";

const DUPLICATE_BODY = '{"detail":"Variable name already exists"}';
const INVALID_OPENAI_BODY = '{"detail":"Invalid API key for OpenAI"}';
const AZURE_TIMEOUT_BODY =
  '{"detail":"Could not validate Azure AI Foundry credentials: ' +
  "HTTPSConnectionPool(host='langflow-test-123.openai.azure.com', port=443): " +
  'Read timed out. (read timeout=10.0)"}';
const AZURE_401_BODY =
  '{"detail":"Could not validate Azure AI Foundry credentials: 401 Client Error: ' +
  'PermissionDenied for url: https://langflow-test-123.openai.azure.com/openai/v1/models"}';
const EMPTY_VALUE_BODY = '{"detail":"Variable value cannot be empty"}';
const OPENROUTER_UNREACHABLE_BODY =
  '{"detail":"Could not reach OpenRouter to validate the API key: ' +
  'HTTPSConnectionPool(host=\'openrouter.ai\', port=443): Read timed out."}';

test("the duplicate-name refusal is OURS and must not be skippable", () => {
  const refusal = classifyVariableWriteRefusal(DUPLICATE_BODY);
  assert.equal(refusal.kind, "duplicate");
  assert.equal(refusal.detail, "Variable name already exists");
  assert.equal(isEnvironmentalRefusal(refusal.kind), false);
});

test("a credential the provider rejected is environmental", () => {
  const refusal = classifyVariableWriteRefusal(INVALID_OPENAI_BODY);
  assert.equal(refusal.kind, "invalid-credential");
  assert.equal(isEnvironmentalRefusal(refusal.kind), true);
});

test("Azure's read timeout is TRANSPORT, not a rejected credential", () => {
  // Both Azure bodies share the `Could not validate … credentials:` prefix, so a
  // classifier that tested credential-shape first would report a slow network as
  // a dead key — the opposite diagnosis, and the one that would send the next
  // occurrence hunting for a new Azure key.
  const refusal = classifyVariableWriteRefusal(AZURE_TIMEOUT_BODY);
  assert.equal(refusal.kind, "transport");
  assert.match(refusal.detail, /read timeout=10\.0/);
  assert.equal(isEnvironmentalRefusal(refusal.kind), true);
});

test("Azure's 401 under the same prefix is a rejected credential", () => {
  assert.equal(classifyVariableWriteRefusal(AZURE_401_BODY).kind, "invalid-credential");
});

test("an unreachable provider during validation is transport", () => {
  assert.equal(classifyVariableWriteRefusal(OPENROUTER_UNREACHABLE_BODY).kind, "transport");
});

test("an empty submitted value is OURS — the panel sent nothing", () => {
  // The anthropic panel's measured failure mode (#1385): the key field renders
  // empty and Save submits it. A skip here would hide a real UI defect.
  const refusal = classifyVariableWriteRefusal(EMPTY_VALUE_BODY);
  assert.equal(refusal.kind, "unknown");
  assert.equal(isEnvironmentalRefusal(refusal.kind), false);
});

test("an unreadable or empty body is UNKNOWN — never a free skip", () => {
  // #1432: the HTTP monitor loses the reason when `response.text()` throws. An
  // unread body is unknown, not benign, so it must fail the test rather than buy
  // the skip an environmental refusal buys.
  for (const body of ["", "   ", UNREADABLE_VARIABLE_WRITE_BODY]) {
    const refusal = classifyVariableWriteRefusal(body);
    assert.equal(refusal.kind, "unknown", `body ${JSON.stringify(body)}`);
    assert.equal(isEnvironmentalRefusal(refusal.kind), false);
  }
});

test("a non-JSON gateway body still classifies as transport", () => {
  assert.equal(
    classifyVariableWriteRefusal("<html><body>502 Bad Gateway</body></html>").kind,
    "transport",
  );
});

test("a FastAPI validation array is surfaced, not swallowed", () => {
  const body = '{"detail":[{"type":"missing","loc":["body","value"]}]}';
  const refusal = classifyVariableWriteRefusal(body);
  assert.equal(refusal.kind, "unknown");
  assert.match(refusal.detail, /"type":"missing"/);
});

test("variableWriteDetail falls back to the raw body when there is no envelope", () => {
  assert.equal(variableWriteDetail('{"error":"nope"}'), '{"error":"nope"}');
  assert.equal(variableWriteDetail("plain text"), "plain text");
  assert.equal(variableWriteDetail(""), "");
});

test("describeVariableWrite carries method, URL, status AND reason", () => {
  // The #1424 deliverable: a future occurrence reads its cause off the failure
  // message. All four parts must be present, or artifact archaeology returns.
  const line = describeVariableWrite({
    method: "POST",
    url: "http://localhost:7860/api/v1/variables/",
    status: 400,
    body: DUPLICATE_BODY,
  });
  assert.match(line, /POST/);
  assert.match(line, /\/api\/v1\/variables\//);
  assert.match(line, /400/);
  assert.match(line, /Variable name already exists/);
});

test("describeVariableWrite stays readable when the body is empty", () => {
  const line = describeVariableWrite({
    method: "PATCH",
    url: "http://localhost:7860/api/v1/variables/abc",
    status: 200,
    body: "",
  });
  assert.equal(line, "PATCH http://localhost:7860/api/v1/variables/abc -> 200");
});
