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
  // v1 must still fail the test, v2 must not (yet) — the staging this lands with.
  assert.match(fixture, /const advisory = surface === "v2"/);
  assert.match(fixture, /if \(!advisory && !allowFlowErrors\)/);
  // THE invariant behind the v1 gate: only the v2 read may be tracked for the
  // drain. Attaching a `.catch()` to the v1 read marks its rejection handled, and
  // the gate silently degrades from "interrupts the test" to "fails its
  // teardown". Measured: 238 ms vs 10 249 ms on a probe that waits 10 s after the
  // error. This assertion exists because that regression shipped once already.
  assert.match(fixture, /if \(surface === "v2"\) \{\s*\n\s*const tracked = bodyRead\.catch/);
  // Every give-up path must be accounted for, not silent.
  assert.match(fixture, /unevaluatedStreams/);
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
  // The long budget is v2-ONLY, and this pairs with the invariant above: the two
  // together are what keeps a late verdict inside the test that caused it. Only
  // v2 reads are drained (tracking a v1 read disarms its mid-test interrupt), so
  // a v1 read with a 4-minute budget could resolve after teardown had already
  // rendered its verdict — pushing into an array nobody reads again, or throwing
  // outside the test. v1 keeps the pre-#1162 bound instead.
  assert.match(
    fixture,
    /surface === "v2" && contentType\.includes\("text\/event-stream"\)/,
  );
  // Advisories must NOT land in `errors`: its length is the `📋 Found N backend
  // error(s)` line, and that line is the human gate (#1084). Padding it with
  // entries that explicitly do not fail anything is the same log-noise problem
  // that gate was written to remove.
  assert.match(fixture, /advisoryFlowErrors\.push\(/);
  assert.doesNotMatch(fixture, /flow_error_advisory/);
});

test("the v2 read budget stays under the per-test timeout it is derived from", () => {
  // `RUN_STREAM_READ_TIMEOUT_MS` is hand-copied from `playwright.config.ts`'s
  // `timeout`, in another file, with a margin for teardown. Nothing else would
  // notice the two drifting apart: a budget at or above the test timeout can
  // never fire, so the read would hang until Playwright killed the test and the
  // "read timed out" accounting would silently stop working.
  const fixture = fs.readFileSync(path.join(__dirname, "fixtures.ts"), "utf8");
  const config = fs.readFileSync(
    path.join(__dirname, "..", "..", "playwright.config.ts"),
    "utf8",
  );

  const budget = fixture.match(/RUN_STREAM_READ_TIMEOUT_MS = ([\d_]+)/);
  assert.ok(budget, "RUN_STREAM_READ_TIMEOUT_MS not found in fixtures.ts");
  const budgetMs = Number(budget[1].replace(/_/g, ""));

  const timeout = config.match(/timeout:\s*([\d\s*_]+?),/);
  assert.ok(timeout, "no `timeout:` found in playwright.config.ts");
  const timeoutMs = timeout[1]
    .split("*")
    .map((part) => Number(part.replace(/_/g, "").trim()))
    .reduce((a, b) => a * b, 1);

  assert.ok(
    budgetMs < timeoutMs,
    `the run-stream read budget (${budgetMs} ms) must stay below the per-test timeout (${timeoutMs} ms)`,
  );
  assert.ok(
    timeoutMs - budgetMs >= 30_000,
    `only ${timeoutMs - budgetMs} ms of teardown margin between the read budget and the test timeout — too tight to render a verdict`,
  );
});
