// Unit tests for describeCommitFailure (issue #1695).
// Run with: npm run test:units
//
// The commit gate in `setup-playground.ts` can give up for four different
// reasons, and until #1695 all four printed the same sentence — one blaming the
// autosave-overtake race of #988. That was measured wrong in both directions on
// a HEALTHY 1.13.0.dev5 image: freezing the backend at t=7.5s produced the
// "stale graph" wording and freezing it at t=8.0s produced the "no read"
// wording, 500ms apart, with no product defect in either. So the discrimination
// cannot be a comment — it has to be a function with assertions on its output,
// and the load-bearing assertion is the one that runs each message back through
// `classifyInfraError`, the exact predicate `remove-stable-from-failures.ts`
// uses to decide whether a hard failure costs a test its `@stable`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInfraError } from "../../../scripts/lib/infra-signatures";
import { describeCommitFailure } from "./graph-commit-failure";
import type { AutosaveEvidence } from "./watch-autosave-writes";

/** Every write for this flow was issued, answered, and answered 2xx. */
const ALL_SETTLED_CLEAN: AutosaveEvidence = { failures: [], issued: 2, settled: 2 };
/** Nothing to say about the writes — the shape a caller must not read as clean. */
const NOTHING_ISSUED: AutosaveEvidence = { failures: [], issued: 0, settled: 0 };

const PROBE_TIMEOUT_ERROR =
  "apiRequestContext.get: Timeout 5000ms exceeded.\nCall log:\n  - → GET http://localhost:7860/api/v1/flows/abc";

test("a gate that never completed a read names the transport error, not #988", () => {
  const message = describeCommitFailure({
    expected: "1 node",
    timeoutMs: 15000,
    outcome: { kind: "no-read" },
    transportError: PROBE_TIMEOUT_ERROR,
    autosave: NOTHING_ISSUED,
  });

  assert.match(message, /no read of GET \/api\/v1\/flows\/\{id\} completed/);
  assert.match(message, /apiRequestContext\.get: Timeout 5000ms exceeded/);
  assert.doesNotMatch(message, /#988/);
});

test("a gate that never completed a read is classified as infrastructure", () => {
  const message = describeCommitFailure({
    expected: "1 node",
    timeoutMs: 15000,
    outcome: { kind: "no-read" },
    transportError: PROBE_TIMEOUT_ERROR,
    autosave: NOTHING_ISSUED,
  });

  const signature = classifyInfraError(message);
  assert.equal(signature?.id, "api-request-timeout");
});

test("a stale graph read is NOT classified as infrastructure", () => {
  const message = describeCommitFailure({
    expected: "2 nodes",
    timeoutMs: 15000,
    outcome: { kind: "graph", nodes: 1, edges: 0 },
    autosave: ALL_SETTLED_CLEAN,
  });

  assert.match(message, /last saw 1 node\(s\), 0 edge\(s\)/);
  assert.match(message, /#988/);
  assert.equal(
    classifyInfraError(message),
    null,
    "the stale-graph wording must never carry a transport signature — it would exempt a real #988 recurrence from the @stable removal",
  );
});

test("a stale graph whose autosave write failed blames the write, not #988", () => {
  const message = describeCommitFailure({
    expected: "2 nodes",
    timeoutMs: 15000,
    outcome: { kind: "graph", nodes: 1, edges: 0 },
    autosave: {
      failures: ["PATCH /api/v1/flows/abc → net::ERR_CONNECTION_RESET"],
      issued: 1,
      settled: 1,
    },
  });

  assert.match(message, /last saw 1 node\(s\), 0 edge\(s\)/);
  assert.match(message, /PATCH \/api\/v1\/flows\/abc → net::ERR_CONNECTION_RESET/);
  assert.doesNotMatch(
    message,
    /#988/,
    "a write that failed is not the overtake race — #988 is a write that SUCCEEDED and was committed out of order",
  );
  assert.equal(classifyInfraError(message)?.id, "connection-dropped");
});

test("a non-2xx read reports the status and does not blame #988", () => {
  const message = describeCommitFailure({
    expected: "1 edge",
    timeoutMs: 15000,
    outcome: { kind: "http-error", status: 502, statusText: "Bad Gateway" },
    autosave: NOTHING_ISSUED,
  });

  assert.match(message, /GET \/api\/v1\/flows\/\{id\} → 502 Bad Gateway/);
  assert.doesNotMatch(message, /#988/);
});

test("a 200 with an unparseable body reports the parse failure, not a node count", () => {
  const message = describeCommitFailure({
    expected: "1 node",
    timeoutMs: 15000,
    outcome: {
      kind: "unreadable-body",
      detail: "Unexpected token < in JSON at position 0",
    },
    autosave: NOTHING_ISSUED,
  });

  assert.match(message, /could not be parsed/);
  assert.match(message, /Unexpected token < in JSON at position 0/);
  assert.doesNotMatch(message, /node\(s\)/);
  assert.doesNotMatch(message, /#988/);
});

test("no read and no captured error says so instead of inventing a cause", () => {
  const message = describeCommitFailure({
    expected: "1 node",
    timeoutMs: 15000,
    outcome: { kind: "no-read" },
    autosave: NOTHING_ISSUED,
  });

  assert.match(message, /the request never returned/);
  assert.doesNotMatch(message, /#988/);
  assert.equal(
    classifyInfraError(message),
    null,
    "with no captured error there is nothing to exempt on — the message must not fabricate a transport signature",
  );
});

test("every message keeps the prefix triage greps for and names the budget", () => {
  const outcomes = [
    { kind: "no-read" as const },
    { kind: "http-error" as const, status: 500, statusText: "Internal Server Error" },
    { kind: "unreadable-body" as const, detail: "boom" },
    { kind: "graph" as const, nodes: 0, edges: 0 },
  ];

  for (const outcome of outcomes) {
    const message = describeCommitFailure({
      expected: "1 node",
      timeoutMs: 15000,
      outcome,
      autosave: ALL_SETTLED_CLEAN,
    });
    assert.match(
      message,
      /^setupPlayground: a canvas edit never reached the database — expected 1 node, /,
      `wrong prefix for ${outcome.kind}`,
    );
    assert.match(message, /15000ms/, `budget missing for ${outcome.kind}`);
  }
});

// --- absence of failure is three states, not two (#1695) -----------------
//
// A frozen backend leaves the autosave ISSUED and unanswered: no failure is
// recorded, and the first version of this function read that emptiness as
// "every write answered 2xx" and blamed #988 — a race between two COMPLETED
// writes — for an instance in which none had completed. Measured against a
// paused 1.13.0.dev5 container, which printed exactly that sentence.

test("an autosave still in flight is not evidence for #988", () => {
  const message = describeCommitFailure({
    expected: "1 node",
    timeoutMs: 15000,
    outcome: { kind: "graph", nodes: 0, edges: 0 },
    autosave: { failures: [], issued: 1, settled: 0 },
  });

  assert.match(message, /last saw 0 node\(s\), 0 edge\(s\)/);
  assert.match(message, /1 autosave write\(s\) for this flow were still in flight/);
  assert.doesNotMatch(
    message,
    /answered 2xx/,
    "a write with no answer must never be reported as one that answered",
  );
  assert.doesNotMatch(message, /#988/);
});

test("no autosave issued at all says so instead of blaming the database", () => {
  const message = describeCommitFailure({
    expected: "1 node",
    timeoutMs: 15000,
    outcome: { kind: "graph", nodes: 0, edges: 0 },
    autosave: NOTHING_ISSUED,
  });

  assert.match(message, /No autosave write was issued for this flow/);
  assert.doesNotMatch(message, /#988/);
});

test("#988 is claimed only when every write was issued, answered and answered 2xx", () => {
  const message = describeCommitFailure({
    expected: "2 nodes",
    timeoutMs: 15000,
    outcome: { kind: "graph", nodes: 1, edges: 0 },
    autosave: ALL_SETTLED_CLEAN,
  });

  assert.match(message, /Every autosave write for this flow answered 2xx/);
  assert.match(message, /#988/);
});

test("a failed write outranks an in-flight one — it is the concrete cause", () => {
  const message = describeCommitFailure({
    expected: "2 nodes",
    timeoutMs: 15000,
    outcome: { kind: "graph", nodes: 1, edges: 0 },
    autosave: {
      failures: ["PATCH /api/v1/flows/abc → 503 Service Unavailable"],
      issued: 3,
      settled: 1,
    },
  });

  assert.match(message, /503 Service Unavailable/);
  assert.doesNotMatch(message, /#988/);
});
