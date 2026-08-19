// Unit tests for the mutually exclusive run lanes.
// Run with: npm run test:units
//
// The value under test is the one thing a wrong lane costs the most: which
// tests a run is allowed to select. A regex that is right for the normal lane
// and wrong for one of the two opt-in lanes is invisible in a green run — the
// excluded tests simply never report — so every lane is asserted by SELECTION
// against representative tag strings, not by comparing regex source text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLane } from "./lane";

/** Tag strings shaped like the ones Playwright matches a title+tags against. */
const NORMAL = "renames a flow @stable @workspace";
const DESTRUCTIVE = "deletes every project @destructive @api";
const ENTERPRISE = "the admin surface rejects an unauthorised write @enterprise @api";

function selects(grepInvert: RegExp | undefined, title: string): boolean {
  return !grepInvert || !grepInvert.test(title);
}

test("normal lane runs neither opt-in lane", () => {
  const { grepInvert, serial } = resolveLane({});
  assert.equal(selects(grepInvert, NORMAL), true);
  assert.equal(selects(grepInvert, DESTRUCTIVE), false);
  assert.equal(selects(grepInvert, ENTERPRISE), false);
  assert.equal(serial, false);
});

test("destructive lane runs destructive tests and still excludes enterprise", () => {
  const { grepInvert, serial } = resolveLane({ PW_DESTRUCTIVE: "1" });
  assert.equal(selects(grepInvert, DESTRUCTIVE), true);
  assert.equal(selects(grepInvert, ENTERPRISE), false);
  // The destructive lane wipes account-wide state; it must never schedule two.
  assert.equal(serial, true);
});

test("enterprise lane runs enterprise tests and still excludes destructive", () => {
  const { grepInvert, serial } = resolveLane({ PW_ENTERPRISE: "1" });
  assert.equal(selects(grepInvert, ENTERPRISE), true);
  assert.equal(selects(grepInvert, DESTRUCTIVE), false);
  // Serial because an Enterprise instance rate-limits login and every worker
  // must authenticate — not because the specs collide.
  assert.equal(serial, true);
});

test("no lane can select both selectors at once", () => {
  for (const env of [{}, { PW_DESTRUCTIVE: "1" }, { PW_ENTERPRISE: "1" }]) {
    const { grepInvert } = resolveLane(env);
    const both = selects(grepInvert, DESTRUCTIVE) && selects(grepInvert, ENTERPRISE);
    assert.equal(both, false, `lane ${JSON.stringify(env)} selected both lanes`);
  }
});

test("both flags set resolves to the enterprise lane and says so", () => {
  const { grepInvert, notices } = resolveLane({ PW_DESTRUCTIVE: "1", PW_ENTERPRISE: "1" });
  assert.equal(selects(grepInvert, ENTERPRISE), true);
  assert.equal(selects(grepInvert, DESTRUCTIVE), false);
  assert.equal(
    notices.some((line) => line.includes("both set")),
    true,
    "an ambiguous request must not resolve silently",
  );
});

test("every exclusion is announced with the command that runs it", () => {
  const normal = resolveLane({});
  assert.equal(normal.notices.length, 2);
  assert.equal(
    normal.notices.some((line) => line.includes("PW_ENTERPRISE=1")),
    true,
  );
  assert.equal(
    normal.notices.some((line) => line.includes("PW_DESTRUCTIVE=1")),
    true,
  );
  // A lane that excludes something must still say what it left out.
  assert.equal(resolveLane({ PW_ENTERPRISE: "1" }).notices.length, 1);
  assert.equal(resolveLane({ PW_DESTRUCTIVE: "1" }).notices.length, 1);
});
