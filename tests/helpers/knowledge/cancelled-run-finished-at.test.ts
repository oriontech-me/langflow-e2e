// Unit tests for cancelledRunKeepsNullFinishedAt (#2417).
// Run with: npm run test:units
//
// The predicate decides where memory-base-ingestion's finished_at check is DECLARED
// failing. Wrong in one direction it reddens a healthy build (1.13.x would be told
// to fail and pass); wrong in the other it hides the regression it records.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cancelledRunKeepsNullFinishedAt } from "./cancelled-run-finished-at";

test("the 1.14 line is affected from 1.14.0.dev23, where upstream #13508 landed", () => {
  assert.equal(cancelledRunKeepsNullFinishedAt("1.14.0.dev22"), false);
  assert.equal(cancelledRunKeepsNullFinishedAt("1.14.0.dev23"), true);
  assert.equal(cancelledRunKeepsNullFinishedAt("1.14.0.dev25"), true);
  assert.equal(cancelledRunKeepsNullFinishedAt("1.14.0"), true);
});

test("the 1.13 lines, which lack #13508, are not affected", () => {
  assert.equal(cancelledRunKeepsNullFinishedAt("1.13.1"), false);
  assert.equal(cancelledRunKeepsNullFinishedAt("1.13.3"), false);
});

test("an unreadable version is refused, not guessed", () => {
  // Guessing either way is wrong: "affected" would expect a failure from a build we
  // know nothing about, "unaffected" would redden it. versionAtLeast throws, naming
  // the version, and so does this.
  assert.throws(() => cancelledRunKeepsNullFinishedAt(undefined), /cannot be parsed/);
  assert.throws(() => cancelledRunKeepsNullFinishedAt("not-a-version"), /cannot be parsed/);
});
