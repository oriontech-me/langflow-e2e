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
  isUnreadableStream,
  parseStreamEvents,
  runStreamSurface,
} from "./flow-error-policy";

const ANTHROPIC_400 =
  "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Your credit balance is too low to access the Anthropic API.'}}";

// ---------- URL scope ----------

test("the v2 run POST is the newly covered surface — the miss that made #1162 possible", () => {
  assert.equal(runStreamSurface("http://localhost:7860/api/v2/workflows", "POST"), "v2");
});

test("the v1 endpoints keep their pre-existing, test-failing surface", () => {
  for (const url of [
    "http://localhost:7860/api/v1/build/abc/flow",
    "http://localhost:7860/api/v1/run/abc",
    "http://localhost:7860/api/v1/flows/abc/events?event_delivery=polling",
  ]) {
    assert.equal(runStreamSurface(url, "POST"), "v1", url);
  }
});

test("the /pending poll is NOT a run stream — it fires every 5s on every canvas spec", () => {
  assert.equal(
    runStreamSurface("http://localhost:7860/api/v2/workflows/pending?flow_id=abc", "GET"),
    null,
  );
  // Only the POST is a run; the GET on the same path is react-query polling.
  assert.equal(runStreamSurface("http://localhost:7860/api/v2/workflows", "GET"), null);
});

test("matching is anchored on the pathname — substring matching hit static assets", () => {
  // Measured with the previous `url.includes()` implementation: all three
  // matched, and one of them is a 300 KB JS bundle.
  for (const url of [
    "http://localhost:7860/assets/build/index.js",
    "http://localhost:7860/api/v1/files/download/run/report.json",
    "http://localhost:7860/api/v1/monitor/messages?flow_id=/run/x",
  ]) {
    assert.equal(runStreamSurface(url, "GET"), null, url);
  }
});

test("unrelated endpoints are not monitored", () => {
  for (const url of [
    "http://localhost:7860/api/v1/flows/",
    "http://localhost:7860/api/v1/monitor/builds?flow_id=abc",
    "http://localhost:7860/api/v1/variables/",
  ]) {
    assert.equal(runStreamSurface(url, "POST"), null, url);
  }
});

test("a malformed URL is not a run stream rather than a crash", () => {
  assert.equal(runStreamSurface("not-a-url", "POST"), null);
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

test("agent prose that CONTAINS a Python traceback is not a verdict", () => {
  // The measured false-positive vector: the raw-text traceback patterns used to
  // run over the whole body, which on a structured stream means every assistant
  // token and every echoed prompt. An agent answering a Python question, or a
  // tool returning a traceback the agent then handled, turned a healthy run red.
  for (const text of [
    "Sure — TypeError: unsupported operand happens when you add str and int.",
    "retrying after ValueError: bad shape",
    "KeyError: 'foo' means the dict has no such key",
  ]) {
    const body = `data: ${JSON.stringify({
      type: "CUSTOM",
      name: "langflow.event",
      value: { event_type: "add_message", data: { data: { sender: "Machine", text, error: false } } },
    })}`;
    assert.deepEqual(classifyFlowError(body), { failed: false }, text);
  }
});

test("a traceback in an UNSTRUCTURED body is still a verdict", () => {
  // The patterns keep their job where they were useful: a body that is not a
  // stream at all (a plain 200 carrying a traceback).
  const verdict = classifyFlowError("Traceback (most recent call last):\nValueError: bad input shape");
  assert.equal(verdict.failed, true);
  assert.equal(verdict.shape, "python exception");
});

test("the minimal v2 error payload yields text, not [object Object]", () => {
  // `agui_translator.py`'s minimal path sends {"error": "<text>"} rather than a
  // nested message. Reading only the nested one produced literally
  // "[object Object]" as the failure message.
  const verdict = classifyFlowError(
    `data: ${JSON.stringify({ type: "CUSTOM", value: { event_type: "error", data: { error: "Graph blew up" } } })}`,
  );
  assert.equal(verdict.failed, true);
  assert.equal(verdict.message, "Graph blew up");
});

test("the v1 event envelope's error is matched despite error:false", () => {
  // `{"event": "<type>", "data": …}` is the v1 wire format
  // (`lfx/events/event_manager.py`), and its error payload carries error:false —
  // so neither of the two v1 shapes the old detector knew was the error carrier.
  const verdict = classifyFlowError(
    JSON.stringify({ event: "error", data: { text: "Error building Component X", error: false } }),
  );
  assert.equal(verdict.failed, true);
  assert.equal(verdict.shape, "event=error");
  assert.match(verdict.message, /Error building Component X/);
});

test("the node shape keeps the provider message, not just its prefix", () => {
  // `errorMessage` opens with "Error building Component Agent: \n\n<cause>", so
  // taking only line 1 dropped the part that says what went wrong.
  const verdict = classifyFlowError(
    `data: ${JSON.stringify({
      type: "STATE_DELTA",
      delta: [
        {
          path: "/nodes/Agent-1",
          value: {
            status: "error",
            output: { outputs: { response: { message: { errorMessage: `Error building Component Agent: \n\n${ANTHROPIC_400}` } } } },
          },
        },
      ],
    })}`,
  );
  assert.equal(verdict.failed, true);
  if (!verdict.failed) return;
  assert.match(verdict.message, /Error building Component Agent/);
  assert.match(verdict.message, /credit balance is too low/);
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
  assert.match(fixture, /runStreamSurface\(url, response\.request\(\)\.method\(\)\)/);
  assert.match(fixture, /classifyFlowError\(/);

  // THE invariant behind the v1 gate, and the reason this assertion exists: the
  // v1 body read must stay UNHANDLED. Attaching any `.catch()` to it marks its
  // rejection handled and the gate silently degrades from "interrupts the test"
  // to "fails its teardown" — measured at 238 ms vs 10 249 ms on a probe that
  // waits 10 s after the error. That regressed once already (#1162), which is
  // why it is pinned on the source rather than trusted to review.
  assert.doesNotMatch(fixture, /bodyRead/);
  assert.match(fixture, /if \(!allowFlowErrors\) \{/);
  assert.match(fixture, /throw new Error\(errorMessage\)/);

  // The two surfaces must reach a verdict by DIFFERENT routes (#1168). v1 still
  // asks for the buffered body; v2 must not, because asking after the fact is
  // the failure mode itself — a run stream outlives its test and Chromium has
  // dropped the buffer by then.
  assert.match(fixture, /if \(surface === "v1"\)/);
  assert.match(fixture, /attachRunStreamCapture\(/);
  assert.match(fixture, /runStreamCapture\.drain\(\)/);
  // ...and the old machinery for waiting on a v2 read must not come back: it
  // could not work, and a 10 s drain proved it (the resource is evicted, not
  // slow).
  assert.doesNotMatch(fixture, /pendingBodyReads/);
  assert.doesNotMatch(fixture, /RUN_STREAM_READ_TIMEOUT_MS/);

  // Every give-up path must be accounted for, not silent.
  assert.match(fixture, /countUnevaluated\(/);
  assert.match(fixture, /capture unavailable/);
  // The inline URL list and the blanket event-stream skip are what #1162 is
  // about; neither may come back.
  assert.doesNotMatch(fixture, /url\.includes\("\/build\/"\)/);
  assert.doesNotMatch(fixture, /streamingContentHints/);
  assert.match(fixture, /isUnreadableStream\(contentType\)/);
  // Advisories must NOT land in `errors`: its length is the `📋 Found N backend
  // error(s)` line, and that line is the human gate (#1084). Padding it with
  // entries that explicitly do not fail anything is the same log-noise problem
  // that gate was written to remove.
  assert.match(fixture, /advisoryFlowErrors\.push\(/);
  assert.doesNotMatch(fixture, /flow_error_advisory/);
});

test("the capture never buffers the stream on the page's behalf", () => {
  // `page.route` + `route.fetch()` is the obvious tee and the wrong one here:
  // `APIResponse` has no streaming body accessor, so the fixture would have to
  // hold the whole run before fulfilling, and the page would get it in one
  // chunk at the end. That breaks incremental delivery for every playground
  // spec — `playground-response-streaming-sse.spec.ts` asserts on it directly.
  const capture = fs.readFileSync(
    path.join(__dirname, "run-stream-capture.ts"),
    "utf8",
  );
  // Comments stripped first: the module's own docblock explains why
  // `route.fulfill()` is the wrong tool, and a bare `doesNotMatch` over the raw
  // file fails on that explanation rather than on any code.
  const code = capture
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /page\.route\(/);
  assert.doesNotMatch(code, /route\.fulfill\(/);
  assert.match(capture, /Network\.streamResourceContent/);
  // Chunks are concatenated as Buffers, never decoded one at a time: a chunk
  // boundary can split a multi-byte character.
  assert.match(capture, /Buffer\.concat\(/);
  // A cancelled stream must still yield its bytes — that is the whole point.
  assert.match(capture, /complete: false/);
});
