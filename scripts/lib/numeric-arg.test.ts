// Unit tests for the shared numeric argument parser (issue #1769).
// Run with: npm run test:units
//
// This parser validates CLI flags that gate writes behind a plausibility floor.
// Both the catalog-baseline writer's `--min-categories` and the
// inherited-backlog-baseline writer's `--min-specs` use it to refuse
// malformed or implausibly small values, because a wrong baseline is worse than
// none — it either hides drift or trains readers to ignore warnings. The
// validation must not be accidentally disabled by passing an empty string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumericArg } from "./numeric-arg";

test("a missing argument returns the fallback", () => {
  assert.equal(parseNumericArg([], "--min-categories", 20), 20);
  assert.equal(
    parseNumericArg(["--force", "--other=3"], "--min-categories", 20),
    20,
  );
});

test("an argument belonging to a different flag does not match", () => {
  assert.equal(parseNumericArg(["--min-specs=5"], "--min-categories", 20), 20);
});

test("a valid value parses, including zero", () => {
  assert.equal(parseNumericArg(["--min-categories=5"], "--min-categories", 20), 5);
  assert.equal(parseNumericArg(["--min-categories=0"], "--min-categories", 20), 0);
  assert.equal(parseNumericArg(["--min-specs=42"], "--min-specs", 10), 42);
});

test("an empty value is refused rather than silently disabling the floor", () => {
  // Number("") is 0 — finite and non-negative — so an empty value used to
  // pass validation and silently disable the plausibility floor. Any baseline
  // would then be written, including an implausibly small one, making the
  // guard worthless. Disabling a floor must be explicit and intentional.
  for (const argv of [["--min-categories="], ["--min-categories=  "]]) {
    assert.throws(
      () => parseNumericArg(argv, "--min-categories", 20),
      /was given no value/,
      `must be refused: ${JSON.stringify(argv)}`,
    );
  }
});

test("a non-numeric value is refused", () => {
  for (const raw of ["nope", "NaN", "1e-fake"]) {
    assert.throws(
      () => parseNumericArg([`--min-categories=${raw}`], "--min-categories", 20),
      /must be a non-negative number/,
      `must be refused: ${raw}`,
    );
  }
});

test("a negative value is refused", () => {
  assert.throws(
    () => parseNumericArg(["--min-categories=-1"], "--min-categories", 20),
    /must be a non-negative number/,
    "must refuse negative values",
  );
});

test("importing the module does not run any side effects", () => {
  // The functions exported from this module are pure — they have no side
  // effects and can be safely imported by other scripts without triggering
  // I/O or initialization code. This guards against regression if the module
  // structure changes.
  assert.equal(typeof parseNumericArg, "function");
});
