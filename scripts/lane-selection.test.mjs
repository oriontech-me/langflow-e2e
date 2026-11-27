// Unit tests for scripts/lane-selection.mjs, which decides what the VM daily's scheduled
// lanes run (#2142). Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { laneFilter, laneTestsByFile, selectLane, runLines } from "./lane-selection.mjs";
import { SCHEDULED_LANES, SERVING_HEADER } from "./lib/scheduled-lanes.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const CLI = fileURLToPath(new URL("./lane-selection.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const ROOT = "/repo/tests";
const S = "tests-automations/regression/serving/";

/** A Playwright --list report: one spec per [file, tags, tests] entry. */
const listing = (specs, root = ROOT) => ({
  config: { rootDir: root },
  suites: [{ title: "", file: "", specs: [], suites: specs.map(([file, tags, n = 1]) => ({ file, specs: [{ file, tags, tests: Array.from({ length: n }, () => ({})) }] })) }],
});
const declared = (files, root = ROOT) => ({ version: 1, root, files, laneOnly: [], unparseable: [], unresolvedTitles: [] });

test("the lane's --grep requires @stable and its tag, and the run's areas when it narrows", () => {
  assert.equal(laneFilter("destructive"), "(?=.*(?:@destructive))(?=.*(?:@stable))");
  assert.equal(laneFilter("serving", "(?<!\\S)(?:@api)(?!\\S)"), "(?=.*(?:@serving))(?=.*(?:@stable))(?=.*(?:(?<!\\S)(?:@api)(?!\\S)))");
  assert.throws(() => laneFilter("enterprise"), /no scheduled lane named 'enterprise'/);
});

test("only tests carrying both @stable and the lane tag are the lane's, counted per file", () => {
  const r = listing([["a.spec.ts", ["stable", "destructive"], 2], ["a.spec.ts", ["stable", "destructive"]], ["b.spec.ts", ["destructive"]], ["c.spec.ts", ["stable", "serving"]]]);
  assert.deepEqual([...laneTestsByFile(r, "destructive")], [["a.spec.ts", 3]]);
  assert.deepEqual([...laneTestsByFile(r, "serving")], [["c.spec.ts", 1]]);
});

test("nothing promoted yet is a verified, empty lane that starts nothing", () => {
  const v = selectLane("serving", listing([[`${S}end-user-identity-isolation.spec.ts`, ["serving"]]]), declared([]));
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.tests, 0);
  assert.deepEqual(v.runs, []);
  assert.deepEqual(runLines(v), []);
});

test("the destructive lane is one run over every file it lists", () => {
  const files = ["tests-automations/regression/governance/x.spec.ts", "tests-automations/regression/core-functionality/auth/login-rate-limit.spec.ts"];
  const v = selectLane("destructive", listing(files.map((f) => [f, ["stable", "destructive"]])), declared([...files].reverse()));
  assert.equal(v.verified, true, v.reason);
  assert.equal(v.tests, 2);
  assert.deepEqual(v.runs, [{ name: "destructive", env: {}, files: [...files].sort(), tests: 2 }]);
  assert.deepEqual(runLines(v), [`destructive\t-\t${[...files].sort().join(" ")}`]);
});

test("a serving spec runs under the one variant it asserts, and a spec in none fails the lane", () => {
  const iso = `${S}end-user-identity-isolation.spec.ts`;
  const req = `${S}end-user-identity-required.spec.ts`;
  const v = selectLane("serving", listing([[iso, ["stable", "serving"], 4], [req, ["stable", "serving"], 3]]), declared([iso, req]));
  assert.equal(v.verified, true, v.reason);
  assert.deepEqual(v.runs.map((r) => [r.name, r.files, r.tests]), [["trusted", [iso], 4], ["required", [req], 3]]);
  assert.deepEqual(v.runs[1].env, { LANGFLOW_SERVING_END_USER_HEADER: SERVING_HEADER, LANGFLOW_SERVING_TRUST_PROXY_HEADERS: "true", LANGFLOW_SERVING_END_USER_REQUIRED: "true" });
  assert.equal(runLines(v)[1], `required\tLANGFLOW_SERVING_END_USER_HEADER=X-End-User-Id LANGFLOW_SERVING_TRUST_PROXY_HEADERS=true LANGFLOW_SERVING_END_USER_REQUIRED=true\t${req}`);

  const stray = `${S}end-user-new-thing.spec.ts`;
  const bad = selectLane("serving", listing([[iso, ["stable", "serving"]], [stray, ["stable", "serving"]]]), declared([iso, stray]));
  assert.equal(bad.verified, false);
  assert.deepEqual(bad.unmapped, [stray]);
  assert.match(bad.reason, /1 listed spec file\(s\) map to no serving variant/);
  assert.deepEqual(bad.runs.map((r) => r.name), ["trusted"], "the mapped files still run");
});

test("a file declared on disk and absent from the lane's listing is missing, as for the shards", () => {
  const f = "tests-automations/regression/governance/x.spec.ts";
  const g = "tests-automations/regression/governance/y.spec.ts";
  const v = selectLane("destructive", listing([[f, ["stable", "destructive"]]]), declared([f, g]));
  assert.equal(v.verified, true);
  assert.deepEqual(v.missing, [g]);
  // Listed and not declared: no coverage lost, reported as unexpected.
  const u = selectLane("destructive", listing([[f, ["stable", "destructive"]]]), declared([]));
  assert.equal(u.verified, true);
  assert.deepEqual(u.unexpected, [f]);
});

test("a listing or declaration that cannot be read is unverified, never an empty lane", () => {
  for (const [rep, dec, why] of [
    [null, declared([]), /listing could not be read/],
    [{ suites: [] }, declared([]), /no config\.rootDir/],
    [listing([]), null, /no declared-spec set was passed/],
    [listing([["a.spec.ts", ["stable", "destructive"]]]), null, /no declared-spec set was passed/],
  ]) {
    const v = selectLane("destructive", rep, dec);
    assert.equal(v.verified, false, JSON.stringify([rep, dec]));
    assert.match(v.reason, why);
  }
});

test("every @serving spec in the tree maps to exactly one variant", () => {
  // The guard the `unmapped` verdict gives at run time, given here first: a new @serving
  // spec fails this test before it can reach a daily unscheduled.
  const dir = join(REPO, "tests/tests-automations/regression");
  const specs = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".spec.ts") && /["']@serving["']/.test(readFileSync(p, "utf8"))) specs.push(p.slice(join(REPO, "tests").length + 1));
    }
  };
  walk(dir);
  assert.ok(specs.length >= 4, `the walk found ${specs.length} @serving spec(s)`);
  const owners = (s) => SCHEDULED_LANES.serving.variants.filter((v) => v.specs.includes(s)).map((v) => v.name);
  for (const s of specs) assert.equal(owners(s).length, 1, `${s} maps to ${owners(s).join(", ") || "no variant"}`);
  for (const v of SCHEDULED_LANES.serving.variants) for (const s of v.specs) assert.ok(specs.includes(s), `${v.name} names ${s}, which is not a @serving spec`);
});

test("the variants are the three the serving starter brings up", () => {
  // scripts/start-langflow-serving-identity.sh is the documented way to start each one;
  // the lane must apply the same three switches, or a spec meets the wrong instance.
  const starter = readFileSync(join(REPO, "scripts/start-langflow-serving-identity.sh"), "utf8");
  for (const k of ["LANGFLOW_SERVING_END_USER_HEADER", "LANGFLOW_SERVING_TRUST_PROXY_HEADERS", "LANGFLOW_SERVING_END_USER_REQUIRED"]) assert.match(starter, new RegExp(`-e ${k}=`));
  assert.match(starter, new RegExp(`HEADER_NAME="\\$\\{LANGFLOW_SERVING_HEADER_NAME:-${SERVING_HEADER}\\}"`));
  const states = SCHEDULED_LANES.serving.variants.map((v) => [v.env.LANGFLOW_SERVING_TRUST_PROXY_HEADERS, v.env.LANGFLOW_SERVING_END_USER_REQUIRED]);
  assert.deepEqual(states, [["true", "false"], ["false", "false"], ["true", "true"]]);
});

test("the command line: flag, filter, select and runs", () => {
  const dir = makeTempDir("lane-selection-");
  const iso = `${S}end-user-identity-isolation.spec.ts`;
  writeFileSync(join(dir, "list.json"), JSON.stringify(listing([[iso, ["stable", "serving"], 2]])));
  writeFileSync(join(dir, "declared.json"), JSON.stringify(declared([iso])));
  const run = (...a) => spawnSync("node", [CLI, ...a], { encoding: "utf8" });
  assert.equal(run("flag", "destructive").stdout, "PW_DESTRUCTIVE\n");
  assert.equal(run("filter", "serving").stdout, "(?=.*(?:@serving))(?=.*(?:@stable))\n");
  const sel = run("select", "serving", join(dir, "list.json"), join(dir, "declared.json"));
  assert.equal(sel.status, 0, sel.stderr);
  writeFileSync(join(dir, "verdict.json"), sel.stdout);
  assert.equal(JSON.parse(sel.stdout).tests, 2);
  assert.match(run("runs", join(dir, "verdict.json")).stdout, /^trusted\tLANGFLOW_SERVING_END_USER_HEADER=X-End-User-Id .*\ttests-automations\/regression\/serving\/end-user-identity-isolation\.spec\.ts\n$/);
  // An unreadable listing still answers a verdict, unverified.
  assert.equal(JSON.parse(run("select", "serving", join(dir, "nope.json"), join(dir, "declared.json")).stdout).verified, false);
  assert.equal(run("flag", "enterprise").status, 2);
  assert.equal(run("bogus").status, 2);
});
