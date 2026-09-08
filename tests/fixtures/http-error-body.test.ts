// Unit tests for the HTTP-error body reporting decision (issue #1432).
// Run with: npm run test:units
//
// The defect this covers was a branch that printed NOTHING: when
// `response.text()` threw, the fixture put a sentinel string in the entry and
// moved on, so the log showed a `🚨 Backend Error` line and then silence —
// identical to an error whose body was genuinely empty. The reason was
// discarded with the body.
//
// So the load-bearing assertions here are the negative ones: that an EMPTY body
// and an UNREADABLE body come out different in both places a human or a script
// can look (the printed line and the recorded entry), and that no input shape
// can produce an entry that says nothing about its body at all — #1012's rule
// applied to the fixture that is itself the suite's evidence trail.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BODY_PENDING,
  describeResponseBody,
  readFailureReason,
  summarizeMissingBodies,
} from "./http-error-body";

// The rejection Playwright actually produces when the buffer is gone — the
// shape #1168 measured on a run stream that outlived its test.
const REAL_REJECTION = new Error(
  "Protocol error (Network.getResponseBody): No resource with given identifier found",
);

// ─── The two branches that used to look alike ────────────────────────────────

test("a read body is recorded and printed", () => {
  const out = describeResponseBody({ ok: true, body: '{"detail":"nope"}' });
  assert.equal(out.responseBody, '{"detail":"nope"}');
  assert.equal(out.bodyUnavailable, undefined);
  assert.equal(out.line, '   Response: {"detail":"nope"}');
});

test("an EMPTY body and an UNREADABLE one differ in the printed line", () => {
  const empty = describeResponseBody({ ok: true, body: "" });
  const unreadable = describeResponseBody({ ok: false, error: REAL_REJECTION });
  assert.notEqual(empty.line, unreadable.line);
  assert.match(empty.line, /<empty body>/);
  assert.match(unreadable.line, /could not be read/);
  assert.match(unreadable.line, /No resource with given identifier found/);
});

test("an EMPTY body and an UNREADABLE one differ in the recorded entry", () => {
  // The programmatic half. A sentinel STRING in `responseBody` cannot carry
  // this distinction, because a sentinel is also a value a backend could
  // legitimately return — hence two optional fields rather than one magic one.
  const empty = describeResponseBody({ ok: true, body: "" });
  assert.equal(empty.responseBody, "");
  assert.equal(empty.bodyUnavailable, undefined);

  const unreadable = describeResponseBody({ ok: false, error: REAL_REJECTION });
  assert.equal(unreadable.responseBody, undefined);
  assert.equal(
    unreadable.bodyUnavailable,
    "Protocol error (Network.getResponseBody): No resource with given identifier found",
  );
});

test("every branch prints — the defect was a branch that did not", () => {
  for (const read of [
    { ok: true, body: "x" },
    { ok: true, body: "" },
    { ok: false, error: REAL_REJECTION },
  ] as const) {
    const out = describeResponseBody(read);
    assert.ok(out.line.trim().length > 0, `${JSON.stringify(read)} prints a line`);
  }
});

test("exactly one of the two fields is ever set", () => {
  for (const read of [
    { ok: true, body: "x" },
    { ok: true, body: "" },
    { ok: false, error: REAL_REJECTION },
  ] as const) {
    const out = describeResponseBody(read);
    const set = [out.responseBody, out.bodyUnavailable].filter(
      (v) => v !== undefined,
    );
    assert.equal(set.length, 1, `${JSON.stringify(read)} sets one field`);
  }
});

// ─── The reason, which used to be thrown away with the body ──────────────────

test("the reason is the first line of the error, not its stack", () => {
  const withStack = new Error("apiRequestContext.get: Target page closed");
  withStack.stack = "Error: apiRequestContext.get: Target page closed\n    at x";
  assert.equal(
    readFailureReason(withStack),
    "apiRequestContext.get: Target page closed",
  );
});

test("a non-Error thrown value still yields a reason", () => {
  // The catch this replaces accepted anything, so this one has to as well.
  assert.equal(readFailureReason("boom"), "boom");
  assert.equal(readFailureReason(undefined), "undefined");
  assert.equal(readFailureReason(null), "null");
  assert.equal(readFailureReason(42), "42");
  assert.match(readFailureReason({ toString: null } as never), /.+/);
});

test("an error with an empty message reports that, rather than an empty line", () => {
  const out = describeResponseBody({ ok: false, error: new Error("") });
  assert.equal(out.bodyUnavailable, "the read failed with no message");
  assert.match(out.line, /the read failed with no message/);
});

test("a NAMED error class with no message reports its name", () => {
  // `TimeoutError` says something; the generic `Error` name does not, which is
  // why the two do not share a fallback.
  const named = new Error("");
  named.name = "TimeoutError";
  assert.equal(readFailureReason(named), "TimeoutError");
});

test("a very long reason is capped so one failure cannot flood the log", () => {
  const reason = readFailureReason(new Error("x".repeat(5000)));
  assert.ok(reason.length <= 201, `capped, got ${reason.length}`);
  assert.match(reason, /…$/);
});

// ─── The third state: a read that never settled ──────────────────────────────

test("the pending sentinel is a reason, so an unsettled read is never silent", () => {
  // The fixture records the entry BEFORE the read (#1084's undercount), so a
  // read that neither resolves nor rejects before the test ends would otherwise
  // leave an entry with no body and no failure — which is not "no body", it is
  // "we never found out".
  assert.ok(BODY_PENDING.length > 0);
  assert.deepEqual(summarizeMissingBodies([{ bodyUnavailable: BODY_PENDING }]), [
    "   ⚠️  1 of them carry NO body — unread is unknown, not absent (#1012):",
    `      1× ${BODY_PENDING}`,
  ]);
});

// ─── The teardown summary ────────────────────────────────────────────────────

test("errors that all carried a body add no lines at all", () => {
  assert.deepEqual(
    summarizeMissingBodies([{}, { bodyUnavailable: undefined }]),
    [],
    "the common case must stay silent, or the summary becomes the noise #1084 was about",
  );
});

test("missing bodies are grouped by reason and ordered by how often they happened", () => {
  const lines = summarizeMissingBodies([
    { bodyUnavailable: "rare" },
    { bodyUnavailable: "common" },
    { bodyUnavailable: "common" },
    {},
  ]);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ {3}⚠️ {2}3 of them carry NO body/);
  assert.match(lines[1], /2× common/);
  assert.match(lines[2], /1× rare/);
});
