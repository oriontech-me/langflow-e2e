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

// Finding A7. This test used to assert only `typeof parseNumericArg ===
// "function"` under the title "importing the module does not run any side
// effects" -- a name promising a property nothing checked. The property is
// worth having: this module is imported by two CLI scripts that BOTH gate a
// committed baseline behind it, so a stray top-level `console.log` added here
// would print into their output — and both of them are read by a human deciding
// whether a refusal is real. So it is asserted rather than renamed.
//
// Asserted by RELOADING the module with the observable side-effect channels
// stubbed: a fresh evaluation is the only moment a top-level statement runs,
// and the import at the top of this file already happened.
//
// Scoped to what a require CAN observe, deliberately: a `require.main ===
// module` block would NOT fire here (nor on any import), so claiming to detect
// one would be the same overstated title this test is fixing.
test("importing the module runs no side effects — no output, no exit", () => {
  const modulePath = require.resolve("./numeric-arg");
  const observed: string[] = [];
  const real = {
    log: console.log, error: console.error, warn: console.warn, exit: process.exit,
  };
  console.log = (...a: unknown[]) => { observed.push(`console.log: ${a.join(" ")}`); };
  console.error = (...a: unknown[]) => { observed.push(`console.error: ${a.join(" ")}`); };
  console.warn = (...a: unknown[]) => { observed.push(`console.warn: ${a.join(" ")}`); };
  process.exit = ((code?: number) => {
    observed.push(`process.exit: ${code}`);
  }) as unknown as typeof process.exit;

  let reloaded: { parseNumericArg?: unknown } = {};
  try {
    delete require.cache[modulePath];
    reloaded = require("./numeric-arg");
  } finally {
    console.log = real.log;
    console.error = real.error;
    console.warn = real.warn;
    process.exit = real.exit;
  }

  assert.deepEqual(observed, [], "a fresh evaluation of the module must produce nothing");
  assert.equal(typeof reloaded.parseNumericArg, "function", "and must still export the parser");
});
