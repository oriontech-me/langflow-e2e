// Unit tests for the evals premise verdict (#2563).
// Run with: npm run test:units
//
// The datasets spec has to tell three instances apart from one config read: a build
// that predates evals (skip, naming it), a 1.14 build with evals on (run), and a 1.14
// build with evals turned off (fail — the product default is on, so a green all-skip
// there would hide either a misconfigured lane or a changed default, #1010). A config
// it cannot read is the fourth answer, and it must fail rather than pass as "absent".
import { test } from "node:test";
import assert from "node:assert/strict";
import { evalsSurfaceVerdict } from "./datasets";

test("evalsSurfaceVerdict: feature_flags.evals true is enabled", () => {
  assert.deepEqual(evalsSurfaceVerdict({ feature_flags: { evals: true, wxo_deployments: false } }), {
    state: "enabled",
  });
});

test("evalsSurfaceVerdict: a feature_flags map without evals is a build that predates it", () => {
  const verdict = evalsSurfaceVerdict({ feature_flags: { wxo_deployments: false } });
  assert.equal(verdict.state, "absent");
  assert.match(verdict.state === "absent" ? verdict.reason : "", /predates evals/);
});

test("evalsSurfaceVerdict: evals false is disabled, never absent", () => {
  const verdict = evalsSurfaceVerdict({ feature_flags: { evals: false } });
  assert.equal(verdict.state, "disabled");
  assert.match(verdict.state === "disabled" ? verdict.reason : "", /feature_flags\.evals is false/);
});

test("evalsSurfaceVerdict: a config with no feature_flags map at all is unreadable, not absent", () => {
  for (const config of [{}, null, "nope", { feature_flags: null }, { feature_flags: [] }]) {
    assert.equal(evalsSurfaceVerdict(config).state, "unreadable", JSON.stringify(config));
  }
});

test("evalsSurfaceVerdict: a non-boolean evals value is unreadable, not enabled", () => {
  for (const evals of ["true", 1, null, {}]) {
    assert.equal(evalsSurfaceVerdict({ feature_flags: { evals } }).state, "unreadable", JSON.stringify(evals));
  }
});
