// Unit tests for the flow-error policy (issue #1162).
//
// The payloads below are TRIMMED CAPTURES from a real 1.12.0.dev10 run whose Agent
// hit an Anthropic 400 (Playwright trace of `agent-max-tokens.spec.ts`), not
// invented shapes. That matters: the previous detector was written against the
// shapes of an older endpoint and nothing failed when the endpoint changed, which
// is exactly what #1162 is about.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  classifyFlowError,
  isRunStreamUrl,
  isUnreadableStream,
  parseStreamEvents,
} from "./flow-error-policy";

const ANTHROPIC_400 =
  "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Your credit balance is too low to access the Anthropic API.'}}";

// ---------- URL scope ----------

test("the v2 run endpoint is monitored — the miss that made #1162 possible", () => {
  assert.equal(isRunStreamUrl("http://localhost:7860/api/v2/workflows"), true);
  assert.equal(
    isRunStreamUrl("http://localhost:7860/api/v2/workflows/pending?flow_id=abc"),
    true,
  );
});

test("the v1 endpoints stay monitored", () => {
  for (const url of [
    "http://localhost:7860/api/v1/build/abc/flow",
    "http://localhost:7860/api/v1/run/abc",
    "http://localhost:7860/api/v1/flows/abc/events?event_delivery=polling",
  ]) {
    assert.equal(isRunStreamUrl(url), true, url);
  }
});

test("unrelated endpoints are not monitored", () => {
  for (const url of [
    "http://localhost:7860/api/v1/flows/",
    "http://localhost:7860/api/v1/monitor/builds?flow_id=abc",
    "http://localhost:7860/api/v1/variables/",
  ]) {
    assert.equal(isRunStreamUrl(url), false, url);
  }
});

test("event-stream bodies are readable; only truly opaque ones are skipped", () => {
  // Skipping `text/event-stream` was the second half of #1162: the v2 run stream
  // IS an event stream, so skipping it discards every execution error.
  assert.equal(isUnreadableStream("text/event-stream; charset=utf-8"), false);
  assert.equal(isUnreadableStream("application/x-ndjson"), false);
  assert.equal(isUnreadableStream("application/grpc"), true);
  assert.equal(isUnreadableStream("application/octet-stream"), true);
  assert.equal(isUnreadableStream(undefined), false);
});

// ---------- parsing both wire formats ----------

test("parseStreamEvents reads SSE data lines and bare NDJSON alike", () => {
  const sse = 'data: {"type":"A"}\n\ndata: {"type":"B"}\n';
  assert.deepEqual(parseStreamEvents(sse), [{ type: "A" }, { type: "B" }]);
  assert.deepEqual(parseStreamEvents('{"type":"A"}\n{"type":"B"}'), [
    { type: "A" },
    { type: "B" },
  ]);
});

test("parseStreamEvents ignores SSE framing, comments and a truncated tail", () => {
  const body = [
    "event: message",
    "id: 42",
    ": keep-alive",
    'data: {"type":"ok"}',
    'data: {"type":"trunc',
  ].join("\n");
  assert.deepEqual(parseStreamEvents(body), [{ type: "ok" }]);
});

// ---------- the v2 shapes ----------

test("RUN_ERROR is detected and quoted", () => {
  const verdict = classifyFlowError(`data: ${JSON.stringify({ type: "RUN_ERROR", message: ANTHROPIC_400 })}`);
  assert.equal(verdict.failed, true);
  assert.equal(verdict.shape, "RUN_ERROR");
  assert.match(verdict.message, /Error code: 400/);
  assert.match(verdict.message, /credit balance is too low/);
});

test("an error event is detected DESPITE carrying error:false — the trap that hid #1162", () => {
  // Captured verbatim: the message object inside the error event has
  // `"error": false`, so a detector keyed on `data.error === true` reads a failed
  // run as healthy. The event_type is the signal.
  const body = `data: ${JSON.stringify({
    type: "CUSTOM",
    name: "langflow.event",
    value: {
      event_type: "error",
      data: { text_key: "text", data: { sender: "Agent", text: ANTHROPIC_400, error: false } },
    },
  })}`;
  const verdict = classifyFlowError(body);
  assert.equal(verdict.failed, true);
  assert.equal(verdict.shape, "event_type=error");
  assert.match(verdict.message, /credit balance is too low/);
});

test("a node that ends in error is detected with its component context", () => {
  const body = `data: ${JSON.stringify({
    type: "STATE_DELTA",
    delta: [
      {
        op: "add",
        path: "/nodes/Agent-q9bOb",
        value: {
          status: "error",
          output: {
            outputs: {
              response: {
                message: {
                  errorMessage: `Error building Component Agent: \n\n${ANTHROPIC_400}`,
                  stackTrace: "Traceback (most recent call last): ...",
                },
              },
            },
          },
        },
      },
    ],
  })}`;
  const verdict = classifyFlowError(body);
  assert.equal(verdict.failed, true);
  assert.equal(verdict.shape, "node status=error");
  assert.match(verdict.message, /Error building Component Agent/);
});

test("a successful node in the same delta shape is not an error", () => {
  const body = `data: ${JSON.stringify({
    type: "STATE_DELTA",
    delta: [{ op: "add", path: "/nodes/ChatInput-i7ndo", value: { status: "success", output: { results: {} } } }],
  })}`;
  assert.deepEqual(classifyFlowError(body), { failed: false });
});

// ---------- the v1 shapes still work ----------

test("the v1 shapes the inline detector knew are preserved", () => {
  assert.equal(
    classifyFlowError(JSON.stringify({ data: { build_data: { params: "Error building node" } } })).failed,
    true,
  );
  const flagged = classifyFlowError(
    JSON.stringify({ data: { error: true, error_message: "boom in the graph" } }),
  );
  assert.equal(flagged.failed, true);
  assert.match(flagged.message, /boom in the graph/);
  assert.equal(classifyFlowError('{"data":{"error":false}}').failed, false);
});

test("a Python traceback in plain text is still caught", () => {
  const verdict = classifyFlowError("Traceback...\nValueError: bad input shape\n  at ...");
  assert.equal(verdict.failed, true);
  assert.equal(verdict.shape, "python exception");
  assert.match(verdict.message, /ValueError: bad input shape/);
});

// ---------- no false positives on healthy traffic ----------

test("a healthy run stream produces no verdict", () => {
  const body = [
    'data: {"type":"RUN_STARTED"}',
    `data: ${JSON.stringify({
      type: "CUSTOM",
      name: "langflow.event",
      value: { event_type: "add_message", data: { data: { sender: "User", text: "hi", error: false } } },
    })}`,
    `data: ${JSON.stringify({
      type: "STATE_DELTA",
      delta: [{ op: "add", path: "/nodes/Agent-1", value: { status: "success", output: { outputs: {} } } }],
    })}`,
    'data: {"type":"CUSTOM","name":"langflow.event","value":{"event_type":"end","data":{"build_duration":6.8}}}',
  ].join("\n");
  assert.deepEqual(classifyFlowError(body), { failed: false });
});

test("empty and non-JSON bodies are not errors", () => {
  for (const body of ["", "   ", "<html>nope</html>", "ok"]) {
    assert.deepEqual(classifyFlowError(body), { failed: false }, JSON.stringify(body));
  }
});

test("a chat message merely CONTAINING the word error is not a verdict", () => {
  // The agent's own prose mentions errors constantly ("If a tool fails, read the
  // error…" is in the default system prompt). Matching on text would fail every
  // agent spec.
  const body = `data: ${JSON.stringify({
    type: "CUSTOM",
    name: "langflow.event",
    value: {
      event_type: "add_message",
      data: { data: { sender: "Machine", text: "If a tool fails, read the error before retrying.", error: false } },
    },
  })}`;
  assert.deepEqual(classifyFlowError(body), { failed: false });
});

// ---------- the fixture actually uses it ----------

test("fixtures.ts consumes the policy instead of an inline filter", () => {
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures.ts"), "utf8");
  assert.match(fixture, /from "\.\/flow-error-policy"/);
  assert.match(fixture, /isRunStreamUrl\(/);
  assert.match(fixture, /classifyFlowError\(/);
  // The inline URL list and the blanket event-stream skip are what #1162 is
  // about; neither may come back. Note `text/event-stream` still appears in the
  // fixture — it selects the longer read budget — so the assertion pins the two
  // constructs that caused the miss, not the string.
  assert.doesNotMatch(fixture, /url\.includes\("\/build\/"\)/);
  assert.doesNotMatch(fixture, /streamingContentHints/);
  assert.match(fixture, /isUnreadableStream\(contentType\)/);
  // An SSE body must not be bounded by the old 2 s, which could never see a run
  // stream close, and teardown must wait for the reads it started.
  assert.match(fixture, /RUN_STREAM_READ_TIMEOUT_MS/);
  assert.match(fixture, /pendingBodyReads/);
});
