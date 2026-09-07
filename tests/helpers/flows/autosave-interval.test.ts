// Unit tests for the run-scoped autosave interval (#1741).
// Run with: npm run test:units
//
// Why these are unit-tested: every consumer's guarantee is a DEADLINE derived
// from this value, and a deadline that is too short fails silently — the barrier
// returns on a save that was never issued, and the run is green. The cases below
// pin the two directions that matter: an unreadable value must degrade to the
// conservative fallback, never to zero, and a readable one must be used as-is.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTOSAVE_INTERVAL_ENV,
  AUTOSAVE_INTERVAL_FALLBACK_MS,
  describeAutosaveInterval,
  pendingSaveQuietMs,
  publishAutosaveInterval,
  readAutosaveIntervalMs,
  SAVE_COMPLETION_BUDGET_MS,
  saveScheduledDeadlineMs,
} from "./autosave-interval";

const env = (value?: string): NodeJS.ProcessEnv =>
  value === undefined ? {} : { [AUTOSAVE_INTERVAL_ENV]: value };

test("reads a published interval back", () => {
  assert.equal(readAutosaveIntervalMs(env("2000")), 2000);
});

test("an absent or blank value is UNKNOWN, not a default", () => {
  assert.equal(readAutosaveIntervalMs(env()), null);
  assert.equal(readAutosaveIntervalMs(env("   ")), null);
});

test("a non-positive or non-integer value reads as unknown", () => {
  // A 0 would collapse every derived deadline to 'already due' — the one state
  // no caller can recover from, so it must not survive as a value.
  for (const bad of ["0", "-1", "abc", "2000.5", "NaN", "Infinity"]) {
    assert.equal(readAutosaveIntervalMs(env(bad)), null, `${bad} must be unknown`);
  }
});

test("publish round-trips through the real environment, and null clears it", () => {
  const before = process.env[AUTOSAVE_INTERVAL_ENV];
  try {
    publishAutosaveInterval(1234);
    assert.equal(readAutosaveIntervalMs(), 1234);
    publishAutosaveInterval(null);
    assert.equal(readAutosaveIntervalMs(), null);
  } finally {
    if (before === undefined) delete process.env[AUTOSAVE_INTERVAL_ENV];
    else process.env[AUTOSAVE_INTERVAL_ENV] = before;
  }
});

test("the deadline allows a full debounce plus slack", () => {
  assert.equal(saveScheduledDeadlineMs(2000, { slackMs: 1500 }), 3500);
});

test("an unknown interval falls back ABOVE every value upstream has shipped", () => {
  const deadline = saveScheduledDeadlineMs(null, { slackMs: 0 });
  assert.equal(deadline, AUTOSAVE_INTERVAL_FALLBACK_MS);
  // 300 (SAVE_DEBOUNCE_TIME) -> 1000 -> 2000 are the values this repo has
  // measured; the fallback must not be a regression against the largest.
  assert.ok(deadline > 2000, "the fallback must exceed the largest known interval");
});

test("the description names which of the two states produced the number", () => {
  assert.match(describeAutosaveInterval(2000), /2000 ms/);
  assert.match(describeAutosaveInterval(2000), /auto_saving_interval/);
  assert.match(describeAutosaveInterval(null), /UNKNOWN/);
  assert.match(describeAutosaveInterval(null), new RegExp(String(AUTOSAVE_INTERVAL_FALLBACK_MS)));
});

test("the pending-save quiet window is longer than the debounce itself", () => {
  // The gap waitForFlowSaveSettled leaves open is a save that is SCHEDULED and
  // not yet issued; only a window longer than the debounce closes it.
  assert.ok(pendingSaveQuietMs(2000) > 2000);
  assert.equal(pendingSaveQuietMs(2000, { slackMs: 500 }), 2500);
  assert.ok(
    pendingSaveQuietMs(null) > AUTOSAVE_INTERVAL_FALLBACK_MS - 1,
    "an unknown interval must not shrink the window",
  );
});

test("the completion budget is separate from, and larger than, the issuance slack", () => {
  // Folding them into one makes a healthy-but-slow round trip indistinguishable
  // from an edit that never marked the node dirty.
  assert.ok(SAVE_COMPLETION_BUDGET_MS > 0);
  assert.ok(
    SAVE_COMPLETION_BUDGET_MS > saveScheduledDeadlineMs(2000) - 2000,
    "the completion budget must exceed the issuance slack it was split from",
  );
});
