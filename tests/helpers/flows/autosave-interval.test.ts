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
  publishAutosaveInterval,
  readAutosaveIntervalMs,
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
