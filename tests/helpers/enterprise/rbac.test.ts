// Unit tests for retryOnDroppedConnection (#1562).
// Run with: npm run test:units
//
// The wrapper exists because `expect.poll` PROPAGATES a throw from its poller, so
// a poll written to tolerate timing dies on a dropped connection — which is the
// error the Access Control UI spec actually hit, against a container that never
// restarted, never OOM-killed anything and logged nothing.
//
// It is tested here rather than proven by a green spec because the mechanism is
// load-dependent and does not reproduce on demand: ten consecutive local runs of
// that spec never dropped a connection. A green run is therefore no evidence the
// wrapper works, and — worse — no evidence that it is still narrow. The risk of a
// retry helper is not that it fails to retry; it is that it quietly retries
// things it must not, turning a real product refusal into a passing test.
//
// So the four properties pinned below are the ones a reader cannot check by
// looking at the spec: it retries a transport throw, it retries only ONCE, it
// leaves a non-2xx response completely alone, and it re-throws anything that is
// not a transport error — an assertion failure above all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { retryOnDroppedConnection } from "./rbac";

/** A call that throws `messages[i]` on attempt i, then returns `value`. */
function throwingTimes(messages: string[], value = "ok") {
  let attempt = 0;
  const call = async () => {
    const message = messages[attempt];
    attempt += 1;
    if (message !== undefined) throw new Error(message);
    return value;
  };
  return { call, attempts: () => attempt };
}

test("retries a dropped connection and returns the second attempt's value", async () => {
  const { call, attempts } = throwingTimes(["apiRequestContext.get: socket hang up"]);
  assert.equal(await retryOnDroppedConnection(call), "ok");
  assert.equal(attempts(), 2, "the call should have been re-dialled exactly once");
});

test("recognises the whole transport family, not just the observed spelling", async () => {
  // The observed failure was `socket hang up`; the same drop surfaces under
  // several names depending on where it is noticed. Pinning only the one that was
  // seen would leave the wrapper looking correct and doing nothing.
  for (const message of [
    "apiRequestContext.get: socket hang up",
    "request to http://localhost:7891 failed, reason: read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:7891",
    "write EPIPE",
    "apiRequestContext.post: socket disconnected before secure TLS connection",
  ]) {
    const { call, attempts } = throwingTimes([message]);
    assert.equal(await retryOnDroppedConnection(call), "ok", message);
    assert.equal(attempts(), 2, message);
  }
});

test("retries ONCE — a second drop is reported, not swallowed", async () => {
  // A wrapper that kept retrying would turn a dead instance into a timeout with
  // no cause named, which is the failure mode this repo counts as worse than a
  // red (#1012).
  const { call, attempts } = throwingTimes(["socket hang up", "socket hang up"]);
  await assert.rejects(() => retryOnDroppedConnection(call), /socket hang up/);
  assert.equal(attempts(), 2, "exactly two attempts, then the error surfaces");
});

test("does not retry anything that is not a transport error", async () => {
  // The load-bearing negative. An assertion failure is a verdict about the
  // product, and retrying it is how a resilience helper silently becomes a way of
  // making red tests green.
  const { call, attempts } = throwingTimes([
    "expect(received).toBe(expected)\n\nExpected: 201\nReceived: 403",
  ]);
  await assert.rejects(() => retryOnDroppedConnection(call), /Expected: 201/);
  assert.equal(attempts(), 1, "an assertion failure must not be re-attempted");
});

test("a response that arrived is passed through untouched, whatever its status", async () => {
  // The wrapper wraps the REQUEST, never the status check. A 403 that arrived is
  // the product answering, and the caller's own assertion is what must see it.
  let attempts = 0;
  const call = async () => {
    attempts += 1;
    return { status: () => 403 };
  };
  const response = await retryOnDroppedConnection(call);
  assert.equal(response.status(), 403);
  assert.equal(attempts, 1, "a non-2xx response is not a reason to re-dial");
});

test("a successful call is made exactly once", async () => {
  let attempts = 0;
  await retryOnDroppedConnection(async () => {
    attempts += 1;
    return "fine";
  });
  assert.equal(attempts, 1);
});
