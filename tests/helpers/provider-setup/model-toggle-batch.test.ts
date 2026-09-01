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
import {
  flushVerdict,
  modelTriggerStallMessage,
  writeStallReason,
  type ToggleBatchObservation,
} from "./model-toggle-batch";

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

// --- #1649 (reopened): a give-up is an OBSERVED cause, and it must be carried ---
//
// The gate above already prints what it saw. What it did NOT do was hand that
// observation to the picker read that follows, so 90 s later the failure named a
// cause nobody had measured ("the picker did not refresh, or the option list is
// filtered") while the real one — the write never answered — sat in a log line no
// failure message, no `error_signature` and no triage dataset correlates. All eight
// give-ups on the 2026-09-01 daily read `1 write(s) started, 0 finished`.
//
// `writeStallReason` is the carrier, and it is pure for the same reason
// `flushVerdict` is. Three properties ride on it: an UNOBSERVED batch is not a
// negative one (#1012), a SETTLED batch must leave the existing verdict alone, and
// an unchanged panel is never a stall.

test("a gave-up batch yields a reason naming the write that never answered", () => {
  const reason = writeStallReason({
    clicked: 30,
    verdict: "gave-up",
    writesStarted: 1,
    writesFinished: 0,
  });
  assert.ok(reason !== null);
  assert.match(reason!, /30 toggle\(s\) clicked/);
  assert.match(reason!, /1 write\(s\) started/);
  assert.match(reason!, /0 finished/);
  // The endpoint is named, because "the write" is not actionable on its own.
  assert.match(reason!, /enabled_models/);
});

test("an UNOBSERVED batch is not a stalled one", () => {
  // The three provider helpers pass what they measured; anything else (a caller
  // that never ran the gate) must produce no claim at all rather than a negative.
  assert.equal(writeStallReason(undefined), null);
});

test("a settled batch is never a stall, whatever the counts say", () => {
  // This is the branch that keeps MODEL_PICKER_DEFECT alive: a picker that
  // disagrees AFTER a clean flush is the genuine, unexplained disagreement #1461
  // wrote its assertion for, and re-labelling it as an instance stall would blind
  // the suite to it.
  assert.equal(
    writeStallReason({ clicked: 36, verdict: "settled", writesStarted: 1, writesFinished: 1 }),
    null,
  );
  assert.equal(
    writeStallReason({ clicked: 0, verdict: "nothing-to-flush", writesStarted: 0, writesFinished: 0 }),
    null,
  );
});

test("a panel nobody changed is never a stall, even past the deadline", () => {
  // `flushVerdict` cannot return gave-up with clicked === 0 today, but the guard is
  // cheap and the alternative is a scary instance-stall verdict on a healthy run
  // the moment that ordering changes.
  assert.equal(
    writeStallReason({ clicked: 0, verdict: "gave-up", writesStarted: 0, writesFinished: 0 }),
    null,
  );
});

test("the model_model message blames the instance, keeps the original error, and cannot skip", () => {
  const message = modelTriggerStallMessage(
    { clicked: 30, verdict: "gave-up", writesStarted: 1, writesFinished: 0 },
    {
      providerLabel: "Google Generative AI",
      original: "locator.waitFor: Timeout 60000ms exceeded.",
    },
  );
  assert.ok(message !== null);
  // Two of #1649's six occurrences were this timeout, 60 s each, with nothing in
  // the message naming a cause. The prefix must NOT be the skip prefix.
  assert.ok(!message!.startsWith("MODEL_NOT_AVAILABLE"));
  assert.match(message!, /^MODEL_TOGGLE_WRITE_STALLED:/);
  assert.match(message!, /Google Generative AI/);
  assert.match(message!, /1 write\(s\) started, 0 finished/);
  assert.match(message!, /locator\.waitFor: Timeout 60000ms exceeded\./);
  // The refresh runs in the batch's own onSettled — saying so is what separates
  // this from a trigger/testid defect.
  assert.match(message!, /onSettled/);
  assert.match(message!, /#1649/);
});

test("with no stall the model_model failure is left exactly as it was", () => {
  // A trigger that never appears on a HEALTHY flush is a real defect and must keep
  // surfacing as Playwright's own locator error, not be re-labelled.
  assert.equal(
    modelTriggerStallMessage(
      { clicked: 36, verdict: "settled", writesStarted: 1, writesFinished: 1 },
      { providerLabel: "OpenAI", original: "locator.click: Timeout 60000ms exceeded." },
    ),
    null,
  );
});
