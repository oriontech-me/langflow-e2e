// Unit tests for the catalog-baseline writer's argument parsing (#1040).
// Run with: npm run test:units
//
// Only the pure part is covered here — the writer itself needs a live Langflow.
// What matters is that its refusals cannot be disabled by accident: a wrong
// baseline is worse than none, since it either reports drift that is not there
// (training readers to ignore the warning) or hides drift that is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumericArg } from "./update-component-catalog-baseline";

test("an absent flag keeps the default floor", () => {
  assert.equal(parseNumericArg([], "--min-categories", 20), 20);
  assert.equal(
    parseNumericArg(["--force", "--other=3"], "--min-categories", 20),
    20,
  );
});

test("an explicit value is honoured", () => {
  assert.equal(parseNumericArg(["--min-categories=5"], "--min-categories", 20), 5);
  assert.equal(parseNumericArg(["--min-categories=0"], "--min-categories", 20), 0);
});

test("an EMPTY value is refused instead of silently disabling the floor", () => {
  // `Number("")` is 0 — finite and non-negative — so `--min-categories=` used to
  // pass the validation and set the floor to 0, reaching the same state as
  // `--force` without the explicit opt-in that makes `--force` legitimate. Any
  // catalog would then be written, including the near-empty one a still-booting
  // instance returns, with nothing printed.
  for (const argv of [["--min-categories="], ["--min-categories=  "]]) {
    assert.throws(
      () => parseNumericArg(argv, "--min-categories", 20),
      /was given no value/,
      `must be refused: ${JSON.stringify(argv)}`,
    );
  }
});

test("a non-numeric or negative value is refused", () => {
  for (const raw of ["nope", "-1", "NaN", "1e-fake"]) {
    assert.throws(
      () => parseNumericArg([`--min-categories=${raw}`], "--min-categories", 20),
      /must be a non-negative number/,
      `must be refused: ${raw}`,
    );
  }
});

test("importing the module does not run the writer", () => {
  // The script is `require.main === module`-guarded so it stays importable. If
  // that guard goes away this lane starts hitting the network on import — and the
  // symptom would be a unit test that fails only when Langflow is down.
  assert.equal(typeof parseNumericArg, "function");
});
