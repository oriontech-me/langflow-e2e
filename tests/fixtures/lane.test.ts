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
const SERVING = "two end users on one session are isolated @api @regression @serving";

/** Every lane selector, so a new one cannot be added to `lane.ts` alone. */
const LANES: Array<{ env: Record<string, string>; title: string; name: string }> = [
  { env: { PW_DESTRUCTIVE: "1" }, title: DESTRUCTIVE, name: "destructive" },
  { env: { PW_ENTERPRISE: "1" }, title: ENTERPRISE, name: "enterprise" },
  { env: { PW_SERVING_IDENTITY: "1" }, title: SERVING, name: "serving" },
];

function selects(grepInvert: RegExp | undefined, title: string): boolean {
  return !grepInvert || !grepInvert.test(title);
}

test("normal lane runs none of the opt-in lanes", () => {
  const { grepInvert, serial } = resolveLane({});
  assert.equal(selects(grepInvert, NORMAL), true);
  assert.equal(selects(grepInvert, DESTRUCTIVE), false);
  assert.equal(selects(grepInvert, ENTERPRISE), false);
  assert.equal(selects(grepInvert, SERVING), false);
  assert.equal(serial, false);
});

test("destructive lane runs destructive tests and still excludes the others", () => {
  const { grepInvert, serial } = resolveLane({ PW_DESTRUCTIVE: "1" });
  assert.equal(selects(grepInvert, DESTRUCTIVE), true);
  assert.equal(selects(grepInvert, ENTERPRISE), false);
  assert.equal(selects(grepInvert, SERVING), false);
  // The destructive lane wipes account-wide state; it must never schedule two.
  assert.equal(serial, true);
});

test("enterprise lane runs enterprise tests and still excludes the others", () => {
  const { grepInvert, serial } = resolveLane({ PW_ENTERPRISE: "1" });
  assert.equal(selects(grepInvert, ENTERPRISE), true);
  assert.equal(selects(grepInvert, DESTRUCTIVE), false);
  assert.equal(selects(grepInvert, SERVING), false);
  // Serial because an Enterprise instance rate-limits login and every worker
  // must authenticate — not because the specs collide.
  assert.equal(serial, true);
});

test("serving-identity lane runs @serving tests and still excludes the others", () => {
  const { grepInvert, serial } = resolveLane({ PW_SERVING_IDENTITY: "1" });
  assert.equal(selects(grepInvert, SERVING), true);
  assert.equal(selects(grepInvert, DESTRUCTIVE), false);
  assert.equal(selects(grepInvert, ENTERPRISE), false);
  // PARALLEL, and this assertion is the decision — not a comment. Neither
  // cause that serialises the other two lanes applies: the variant image keeps
  // `auto_login` (so no login rate limit to exhaust) and the isolation under
  // test is keyed per `session_id`, so every test owns its own bucket and none
  // mutates account-wide state. Flipping this to `true` must fail here.
  assert.equal(serial, false);
});

test("no lane can select more than one selector at once", () => {
  const envs = [{}, ...LANES.map((lane) => lane.env)];
  for (const env of envs) {
    const { grepInvert } = resolveLane(env);
    const selected = LANES.filter((lane) => selects(grepInvert, lane.title)).map((l) => l.name);
    assert.ok(
      selected.length <= 1,
      `lane ${JSON.stringify(env)} selected ${selected.join(" + ")}`,
    );
  }
});

test("a test carrying two selectors is unrunnable in every lane", () => {
  // The pairs must stay unrunnable, which is what stops `@serving @destructive`
  // being written as if it were a combined lane.
  const pairs = [
    "wipes and serves @destructive @serving",
    "enterprise serving @enterprise @serving",
    "enterprise wipe @enterprise @destructive",
  ];
  for (const env of [{}, ...LANES.map((lane) => lane.env)]) {
    const { grepInvert } = resolveLane(env);
    for (const title of pairs) {
      assert.equal(
        selects(grepInvert, title),
        false,
        `lane ${JSON.stringify(env)} selected the double-tagged test ${title}`,
      );
    }
  }
});

test("several flags set resolve by a fixed precedence and say so", () => {
  // enterprise > serving > destructive, by how specialised an instance each
  // demands. Any ambiguous request resolves to exactly one lane and announces it.
  const cases: Array<[Record<string, string>, string]> = [
    [{ PW_DESTRUCTIVE: "1", PW_ENTERPRISE: "1" }, ENTERPRISE],
    [{ PW_SERVING_IDENTITY: "1", PW_ENTERPRISE: "1" }, ENTERPRISE],
    [{ PW_SERVING_IDENTITY: "1", PW_DESTRUCTIVE: "1" }, SERVING],
    [{ PW_SERVING_IDENTITY: "1", PW_DESTRUCTIVE: "1", PW_ENTERPRISE: "1" }, ENTERPRISE],
  ];
  for (const [env, winner] of cases) {
    const { grepInvert, notices } = resolveLane(env);
    const selected = LANES.filter((lane) => selects(grepInvert, lane.title));
    assert.equal(selected.length, 1, `${JSON.stringify(env)} did not resolve to one lane`);
    assert.equal(selects(grepInvert, winner), true, `${JSON.stringify(env)} chose the wrong lane`);
    assert.equal(
      notices.some((line) => line.includes("both set") || line.includes("set together")),
      true,
      `an ambiguous request must not resolve silently: ${JSON.stringify(env)}`,
    );
  }
});

test("every exclusion is announced with the command that runs it", () => {
  const normal = resolveLane({});
  assert.equal(normal.notices.length, LANES.length);
  for (const flag of ["PW_ENTERPRISE=1", "PW_DESTRUCTIVE=1", "PW_SERVING_IDENTITY=1"]) {
    assert.equal(
      normal.notices.some((line) => line.includes(flag)),
      true,
      `the normal lane did not say how to run ${flag}`,
    );
  }
  // A lane that excludes something must still say what it left out — one notice
  // per lane it is NOT running.
  for (const lane of LANES) {
    assert.equal(
      resolveLane(lane.env).notices.length,
      LANES.length - 1,
      `the ${lane.name} lane did not announce both exclusions`,
    );
  }
});
