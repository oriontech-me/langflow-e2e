// Unit tests for the provider panel's toggle-batch flush gate (#1649).
// Run with: npm run test:units
//
// What rides on this predicate is not a wait, it is WHICH of the product's two
// send paths carries the toggles. `useModelToggleQueue` debounces every toggle by
// 1000 ms; the debounced flush refreshes the model picker (its `onSettled` calls
// `refreshAllModelInputs`), while the close-path flush does not. Closing the panel
// inside the debounce window therefore leaves the picker on the PRE-toggle enabled
// set — on a freshly configured provider, the `MIN_DEFAULT_MODELS = 5` default —
// and the picker read that follows raises `MODEL_PICKER_DEFECT`.
//
// Measured on 1.12.0.dev44, one clean container, three runs of the identical
// sequence differing only in the pause before Close, server at enabled=41 in all
// three: 0 ms -> picker offers 5; 1200 ms -> 35; 2000 ms -> 35.
//
// The predicate is pure so every branch is reachable without a browser — the same
// reason `resolveModelOption` and `censusForTarget` are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { flushVerdict, type ToggleBatchObservation } from "./model-toggle-batch";

const OPTS = { quietMs: 1500, deadlineAt: 100_000 };

function obs(over: Partial<ToggleBatchObservation> = {}): ToggleBatchObservation {
  return {
    clicked: 3,
    lastClickAt: 1_000,
    postsStarted: 1,
    postsFinished: 1,
    lastPostStartedAt: 1_200,
    ...over,
  };
}

test("a panel nobody changed needs no flush at all", () => {
  // The normal CI path: `Collect models` already enabled everything, the loop
  // clicks nothing, and there is no batch to wait for. This branch is what keeps
  // the fix free on every run that does not hit the defect.
  const v = flushVerdict(obs({ clicked: 0, postsStarted: 0, postsFinished: 0 }), 1_000, OPTS);
  assert.equal(v.kind, "nothing-to-flush");
});

test("the debounce window still being open is not settled", () => {
  const v = flushVerdict(obs({ lastClickAt: 5_000 }), 5_900, OPTS);
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /debounce/i);
});

test("a write that was issued but has not answered is not settled", () => {
  const v = flushVerdict(obs({ postsStarted: 2, postsFinished: 1 }), 9_000, OPTS);
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /in flight/i);
});

test("clicks with NO write issued yet are not settled — the queue has not fired", () => {
  const v = flushVerdict(
    obs({ postsStarted: 0, postsFinished: 0, lastPostStartedAt: null }),
    9_000,
    OPTS,
  );
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /no write/i);
});

test("a write that answered but only just started leaves room for a follow-up batch", () => {
  // The queue splits into several batches when the loop is slow: a POST finishing
  // does not prove the LAST one has been sent. Requiring quiet since the last
  // start too is what makes this a quiescence check rather than a first-response
  // check — `waitForResponse` on the first POST was measured returning while the
  // batch was still being sent.
  const v = flushVerdict(obs({ lastPostStartedAt: 8_500 }), 9_000, OPTS);
  assert.equal(v.kind, "waiting");
  if (v.kind === "waiting") assert.match(v.reason, /quiet/i);
});

test("clicks flushed, answered and quiet on both clocks is settled", () => {
  const v = flushVerdict(obs({ lastClickAt: 1_000, lastPostStartedAt: 2_000 }), 4_000, OPTS);
  assert.equal(v.kind, "settled");
});

test("past the deadline it gives up NAMING what it saw, never silently", () => {
  // Giving up is not a failure: the picker read that follows is the real gate and
  // it fails loudly with the right message. What must not happen is giving up
  // without a trace — an unevaluated wait is unknown, not clean (#1012).
  const v = flushVerdict(
    obs({ clicked: 7, postsStarted: 2, postsFinished: 1 }),
    100_001,
    OPTS,
  );
  assert.equal(v.kind, "gave-up");
  if (v.kind === "gave-up") {
    assert.match(v.message, /7 toggle\(s\) clicked/);
    assert.match(v.message, /2 write\(s\) started/);
    assert.match(v.message, /1 finished/);
    assert.match(v.message, /#1649/);
  }
});

test("the deadline never overrides nothing-to-flush", () => {
  // An unchanged panel past the deadline is still nothing to flush — reporting a
  // give-up there would put a scary line in every healthy run's log.
  const v = flushVerdict(
    obs({ clicked: 0, postsStarted: 0, postsFinished: 0, lastClickAt: null }),
    100_001,
    OPTS,
  );
  assert.equal(v.kind, "nothing-to-flush");
});
