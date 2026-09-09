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
import * as fs from "node:fs";
import * as path from "node:path";

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

// ─── Review findings, pinned ─────────────────────────────────────────────────

test("a message whose FIRST line is blank is not reported as no message at all", () => {
  // `raw.split("\n")[0]` took the empty line and the fallback then claimed there
  // was no message — losing the reason, which is the exact defect #1432 exists
  // to fix, reintroduced inside the fix.
  assert.equal(
    readFailureReason(new Error("\nresponse.text: Target page closed")),
    "response.text: Target page closed",
  );
  assert.equal(
    readFailureReason(new Error("   \n\t\n  the real cause  ")),
    "the real cause",
  );
});

test("an error whose message getter THROWS does not throw out of the fixture", () => {
  // The `catch (e)` this replaced never touched `e`. This function must not be
  // the first thing able to throw from inside an async `response` handler that
  // has no surrounding try — the handler is the evidence trail.
  const evil = Object.create(Error.prototype) as Error;
  Object.defineProperty(evil, "message", {
    get() {
      throw new Error("boom");
    },
  });
  const out = describeResponseBody({ ok: false, error: evil });
  assert.match(out.bodyUnavailable ?? "", /could not be inspected/);
  assert.match(out.line, /could not be read/);
});

test("an error whose message is NOT a string does not throw out of the fixture", () => {
  // The sibling above pins a message getter that THROWS, which the outer try
  // catches. This pins the case that ESCAPED it: `Error.message` is typed
  // `string` and is a plain own property, so anything can be written to it, and
  // the coercion happened one frame up — OUTSIDE the try — where `raw.split()`
  // threw `TypeError: raw.split is not a function`. From an async `response`
  // handler with no surrounding try that is an unhandled rejection, i.e. an
  // HTTP error FAILING a test, which #1084 says never happens.
  const withMessage = (message: unknown): Error => {
    const error = new Error("placeholder");
    Object.defineProperty(error, "message", { value: message });
    return error;
  };
  for (const message of [
    Symbol("s"),
    123,
    { a: 1 },
    ["a"],
    null,
    undefined,
    true,
  ]) {
    const out = describeResponseBody({ ok: false, error: withMessage(message) });
    assert.equal(typeof out.bodyUnavailable, "string");
    assert.ok(out.line.length > 0, `no line for message ${String(message)}`);
    assert.equal(out.responseBody, undefined);
  }
});

test("both real Chromium rejection messages survive intact", () => {
  // Two different real strings, and the two halves of this change had been
  // pinning one each without saying so: `#1168` measured "No resource with
  // given identifier found" on a run stream, while a bodyless response gives
  // "No data found for resource with given identifier". A redirect gives a
  // third. All three must reach the log unmangled.
  for (const message of [
    "response.text: Protocol error (Network.getResponseBody): No resource with given identifier found",
    "response.text: Protocol error (Network.getResponseBody): No data found for resource with given identifier",
    "response.text: Response body is unavailable for redirect responses",
  ]) {
    assert.equal(readFailureReason(new Error(message)), message);
  }
});

// ─── The fixture wiring, pinned structurally ─────────────────────────────────
//
// These two assert a SPELLING, not a behaviour, and #1226 is explicit that such
// a guard passes mutations it should catch. They are here because the behaviour
// they stand in for is unreachable from a test: the pending stamp is only ever
// observable on a read that never settles, and the teardown summary prints
// after every hook has run, which `http-error-gate.spec.ts` already records as
// a structural limit of that file. Recorded as the weaker thing they are,
// rather than left absent — before this, deleting either line left the whole
// unit lane AND the gate spec green.

test("the fixture stamps the pending reason before it attempts the read", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "fixtures.ts"),
    "utf-8",
  );
  const stamp = source.indexOf("bodyUnavailable: BODY_PENDING");
  const push = source.indexOf("errors.push(entry)");
  const read = source.indexOf("describeResponseBody(");
  assert.ok(stamp > 0, "the entry is stamped with a pending reason");
  assert.ok(push > stamp, "the stamp is part of the entry, set before it is recorded");
  assert.ok(
    read > push,
    "the read is still attempted AFTER the entry is recorded (#1084's undercount)",
  );
});

test("the fixture PRINTS what the teardown summary returns", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "fixtures.ts"),
    "utf-8",
  );
  // Pinning the CALL alone left the mutation that matters alive: keeping
  // `for (const line of summarizeMissingBodies(httpErrors))` and dropping the
  // `console.log(line)` inside it passes the whole unit lane, because the lines
  // print during fixture teardown and no test in this repo can observe them
  // (the same structural limit `http-error-gate.spec.ts` records for the
  // `📋 Found N` total). This pins the EFFECT, not just the call — still a
  // spelling guard, and #1226 is the standing reason that is the weaker thing.
  assert.match(
    source,
    /for \(const line of summarizeMissingBodies\(httpErrors\)\) \{\s*console\.log\(line\);\s*\}/,
  );
});
