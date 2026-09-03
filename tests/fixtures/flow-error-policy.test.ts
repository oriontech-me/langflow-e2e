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

// The payload the shape tests below run on. It USED to be the drained-account
// message now held in `ANTHROPIC_CREDIT_DRAINED`, and that is worth recording
// rather than quietly swapping: the capture #1162 built the whole v2 detector
// from was itself a provider outage, so every shape test was demonstrating
// detection on the one class of message #1165 has to classify differently.
// Once the message carries a second axis, a shape test must not sit on a payload
// that trips it — otherwise the two axes cannot be told apart, and the four
// tests below would have been asserting the opposite of the policy.
//
// Same wire shape, same provider, a message that IS the flow's fault.
const ANTHROPIC_400 =
  "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'messages: at least one message is required'}}";

// ---------- provider outages (#1165), measured on the daily ----------

/** 2026-09-02, run 33630411848 shard 3, `openai-compatible-provider-setup`. */
const ANTHROPIC_CREDIT_DRAINED =
  "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.'}, 'request_id': 'req_011Ceee5xzgsKA7fuXzosWUx'}";

/** 2026-09-01, run 33511210195 shard 3, `rag-pipeline`. */
const GOOGLE_QUOTA_EXHAUSTED =
  "Error embedding content (RESOURCE_EXHAUSTED): 429 RESOURCE_EXHAUSTED. {'error': {'code': 429, 'message': 'Resource has been exhausted (e.g. check quota).', 'status': 'RESOURCE_EXHAUSTED'}}";

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
  assert.match(verdict.message, /at least one message is required/);
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
  assert.match(verdict.message, /at least one message is required/);
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
  assert.match(verdict.message, /at least one message is required/);
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
  // The advisory machinery is GONE (#1165): a v2 verdict now lands in `errors`
  // like a v1 one, and the teardown fails on it. Pinned as an absence because
  // the flip is easy to half-revert — leaving the ADVISORY branch in place while
  // the docs say otherwise is precisely the "docs claim a gate the code does not
  // have" state #1084 was raised about.
  assert.doesNotMatch(fixture, /advisoryFlowErrors/);
  assert.doesNotMatch(fixture, /do NOT fail the test yet/);
  assert.doesNotMatch(fixture, /flow_error_advisory/);

  // A provider outage must be reported before the `failed` test, on BOTH
  // surfaces (#1165). It is a `failed: false` verdict, so an early return on
  // `!verdict.failed` would drop it in silence — on the surface that does fail
  // tests. Two call sites, one per surface.
  assert.equal(
    (fixture.match(/reportProviderOutage\(/g) ?? []).length,
    2,
    "expected exactly one call per run-stream surface (v1 and v2)",
  );
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

// ---------- provider outages are UNEVALUATED, never a flow error (#1165) ----------

test("a drained provider key is not a flow error — it is unevaluated", () => {
  // Measured on the 2026-09-02 daily. Without this the fixture fails the spec,
  // the failure text matches nothing in `infra-signature-patterns.json` (that
  // list is transport-level only), and `remove-stable-from-failures.ts` strips
  // `@stable` in an unreviewed commit. Three account drains are on record here.
  const verdict = classifyFlowError(
    `data: ${JSON.stringify({ type: "RUN_ERROR", message: ANTHROPIC_CREDIT_DRAINED })}`,
  );
  assert.equal(verdict.failed, false);
  assert.ok("providerOutage" in verdict);
  assert.equal((verdict as any).providerOutage, "credit-exhausted");
});

test("an exhausted embedding quota is not a flow error either", () => {
  // Measured on the 2026-09-01 daily, `rag-pipeline`, via the event shape.
  const verdict = classifyFlowError(
    `data: ${JSON.stringify({
      type: "CUSTOM",
      name: "langflow.event",
      value: { event_type: "error", data: { error: GOOGLE_QUOTA_EXHAUSTED } },
    })}`,
  );
  assert.equal(verdict.failed, false);
  assert.equal((verdict as any).providerOutage, "quota-exhausted");
});

test("the downgrade is not clean — it keeps the message and the shape", () => {
  // #1012's rule: an unevaluated run is unknown, not healthy. A verdict that
  // dropped the text would make the outage indistinguishable from a run that
  // simply never errored, which is the failure this whole file exists about.
  const verdict = classifyFlowError(
    `data: ${JSON.stringify({ type: "RUN_ERROR", message: ANTHROPIC_CREDIT_DRAINED })}`,
  ) as any;
  assert.equal(verdict.shape, "RUN_ERROR");
  assert.match(verdict.message, /credit balance is too low/);
});

test("every shape downgrades, not only the two that were sampled", () => {
  // The measured cases arrived as RUN_ERROR and event_type=error. A per-shape
  // check would have covered exactly those and silently failed a test the day
  // the same provider message arrived on a node or a v1 envelope.
  const bodies: Record<string, string> = {
    RUN_ERROR: JSON.stringify({ type: "RUN_ERROR", message: ANTHROPIC_CREDIT_DRAINED }),
    "event_type=error": JSON.stringify({
      type: "CUSTOM",
      value: { event_type: "error", data: { error: ANTHROPIC_CREDIT_DRAINED } },
    }),
    "event=error": JSON.stringify({
      event: "error",
      data: { text: ANTHROPIC_CREDIT_DRAINED },
    }),
    "node status=error": JSON.stringify({
      type: "STATE_DELTA",
      delta: [
        {
          path: "/nodes/Agent-x",
          value: {
            status: "error",
            output: {
              outputs: { response: { message: { errorMessage: ANTHROPIC_CREDIT_DRAINED } } },
            },
          },
        },
      ],
    }),
    "error=true": JSON.stringify({
      data: { error: true, error_message: ANTHROPIC_CREDIT_DRAINED },
    }),
  };
  for (const [shape, body] of Object.entries(bodies)) {
    const verdict = classifyFlowError(`data: ${body}`) as any;
    assert.equal(verdict.failed, false, shape);
    assert.equal(verdict.shape, shape, shape);
  }
});

test("a rate limit the provider names is downgraded; a bare 429 in prose is not", () => {
  const limited = classifyFlowError(
    `data: ${JSON.stringify({
      type: "RUN_ERROR",
      message: "Error code: 429 - Rate limit reached for gpt-4o-mini",
    })}`,
  ) as any;
  assert.equal(limited.failed, false);
  assert.equal(limited.providerOutage, "rate-limited");

  // "429" alone appears in request ids and token counts, so it is deliberately
  // not a pattern on its own.
  const notLimited = classifyFlowError(
    `data: ${JSON.stringify({
      type: "RUN_ERROR",
      message: "Error building Component Agent: request 429 of 500 failed",
    })}`,
  );
  assert.equal(notLimited.failed, true);
});

test("an agent MENTIONING a quota in prose is still a healthy run", () => {
  // The message is matched, never the whole body — the same fencing the raw
  // traceback patterns get. An agent explaining RESOURCE_EXHAUSTED to a user
  // must not read as its own provider dying.
  const body = `data: ${JSON.stringify({
    type: "CUSTOM",
    value: {
      event_type: "message",
      data: { text: "RESOURCE_EXHAUSTED means the API quota ran out; try again later." },
    },
  })}`;
  const verdict = classifyFlowError(body);
  assert.equal(verdict.failed, false);
  assert.equal("providerOutage" in verdict, false, "a healthy run is clean, not unevaluated");
});

// The OpenAI 429 body verbatim, as the API returns it. Kept as one constant
// because the two quota tokens sit at OPPOSITE ENDS of it, which is the whole
// point of the tests below: the prose at ~offset 50, `'type':
// 'insufficient_quota'` at ~offset 276.
const OPENAI_QUOTA_429 =
  "Error code: 429 - {'error': {'message': 'You exceeded your current quota, " +
  "please check your plan and billing details. For more information on this " +
  "error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.', " +
  "'type': 'insufficient_quota', 'param': None, 'code': 'insufficient_quota'}}";

test("a drained OpenAI key is a provider outage, wrapped or bare", () => {
  // Langflow prefixes a component failure with "Error building Component <n>",
  // so the message the fixture sees is the wrapped form, not the API's own.
  for (const message of [OPENAI_QUOTA_429, `Error building Component Agent: \n\n${OPENAI_QUOTA_429}`]) {
    const verdict = classifyFlowError(
      `data: ${JSON.stringify({ type: "RUN_ERROR", message })}`,
    ) as any;
    assert.equal(verdict.failed, false, message.slice(0, 40));
    assert.equal(verdict.providerOutage, "quota-exhausted");
  }
});

test("the quota verdict survives summarize() truncating the payload's tail", () => {
  // `providerOutage()` runs on the message AFTER summarize() cuts it to 400
  // chars, so a pattern anchored on the payload's LAST token is one long
  // component name away from being unreachable. Reproduce that: pad the prefix
  // until `insufficient_quota` is past the cut, and assert the verdict holds.
  const padded = `Error building Component ${"A".repeat(120)}: \n\n${OPENAI_QUOTA_429}`;
  const verdict = classifyFlowError(
    `data: ${JSON.stringify({ type: "RUN_ERROR", message: padded })}`,
  ) as any;

  assert.ok(
    !/insufficient_quota/i.test(verdict.message),
    "fixture is not exercising the truncation it claims to — the tail token still survives",
  );
  assert.equal(verdict.failed, false);
  assert.equal(verdict.providerOutage, "quota-exhausted");
});

test("the OpenAI-compatible drained-account wordings are provider outages too", () => {
  // These three are the strings `openai-compatible-provider-setup.spec.ts:1029`
  // already treats as a drained account. Measured as FAILING the test before
  // this list covered them.
  const cases: Array<[string, string]> = [
    [
      "no credits remaining",
      "Error code: 402 - {'error': {'message': 'You have no credits remaining. Add credits to continue using the API', 'code': 402}}",
    ],
    [
      "billing_not_active",
      "Error code: 403 - {'error': {'message': 'Your account is not active, please check your billing details.', 'code': 'billing_not_active'}}",
    ],
    ["bare status", "Error building Component Agent: 402 Payment Required"],
  ];
  for (const [label, message] of cases) {
    const verdict = classifyFlowError(
      `data: ${JSON.stringify({ type: "RUN_ERROR", message })}`,
    ) as any;
    assert.equal(verdict.failed, false, label);
    assert.ok(
      ["credit-exhausted", "payment-required"].includes(verdict.providerOutage),
      `${label}: expected a billing id, got ${verdict.providerOutage}`,
    );
  }
});

test("a bare 429 stays a flow error while a bare 402 does not", () => {
  // The asymmetry is deliberate and worth pinning: 429 doubles as a request id
  // or a token count ("request 429 of 500"), 402 has no other source here. If a
  // future pattern makes 429 bare, this test is where it should show up.
  const notLimited = classifyFlowError(
    `data: ${JSON.stringify({ type: "RUN_ERROR", message: "Error building Component Agent: request 429 of 500 failed" })}`,
  );
  assert.equal(notLimited.failed, true);
});

test("an ordinary flow error is untouched by the downgrade", () => {
  const verdict = classifyFlowError(
    `data: ${JSON.stringify({ type: "RUN_ERROR", message: "THIS IS A TEST ERROR MESSAGE" })}`,
  );
  assert.equal(verdict.failed, true);
});
