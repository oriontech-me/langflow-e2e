import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reportTotal, collectObservations, verdictFor, renderTable, renderJson,
  unmatchedTitles, UNMATCHED_TITLE_CAP,
} from "./build-triage-table.mjs";

const report = (specs, stats) => ({
  stats: stats ?? { expected: specs.length, unexpected: 0, flaky: 0, skipped: 0 },
  suites: [{ title: "file", file: "a/x.spec.ts", specs, suites: [] }],
});
const spec = (title, status, stdout = []) => ({
  title, tests: [{ status, results: [{ status: status === "expected" ? "passed" : "failed", stdout }] }],
});

test("reportTotal reads stats, not the suite walk", () => {
  assert.equal(reportTotal(report([spec("a", "expected")])), 1);
  assert.equal(reportTotal({ stats: {}, suites: [] }), 0);
  assert.equal(reportTotal(null), 0);
});

test("collectObservations keys by test title", () => {
  const obs = collectObservations(report([spec("a", "expected"), spec("b", "unexpected")]));
  assert.deepEqual([...obs.keys()].sort(), ["a", "b"]);
  assert.equal(obs.get("a")[0].status, "expected");
});

test("collectObservations finds a backend error in stdout", () => {
  // The fixture logs it on stdout, which is where it goes -- a grep of stderr
  // under a JSON reporter returns a false zero.
  const obs = collectObservations(report([
    spec("a", "expected", [{ text: "🚨 Backend Error: 500 POST /api/v1/flows/\n" }]),
  ]));
  assert.equal(obs.get("a")[0].backendErrors, 1);
});

// P4: `JSONReportSTDIOEntry` (node_modules/playwright/types/testReporter.d.ts)
// is `{ text: string } | { buffer: string }` -- an object either way, never a
// bare string. A naive `String(chunk?.text ?? chunk)` reads the text variant
// above fine but stringifies the OBJECT for a buffer chunk to the literal
// "[object Object]", so a backend error Playwright encoded as base64 would
// silently not be counted. This is the one shape verified against the
// installed Playwright's own type declarations rather than a guess.
test("collectObservations decodes a base64 buffer stdout chunk, not just the text variant", () => {
  const encoded = Buffer.from("🚨 Backend Error: 500 POST /api/v1/flows/\n", "utf8").toString("base64");
  const obs = collectObservations(report([
    spec("a", "expected", [{ buffer: encoded }]),
  ]));
  assert.equal(obs.get("a")[0].backendErrors, 1);
});

test("collectObservations treats an unrecognized stdout chunk shape as empty, not a crash", () => {
  const obs = collectObservations(report([
    spec("a", "expected", [{ somethingElse: true }]),
  ]));
  assert.equal(obs.get("a")[0].backendErrors, 0);
});

test("verdictFor: all green over three observations", () => {
  const v = verdictFor([{ status: "expected" }, { status: "expected" }, { status: "expected" }]);
  assert.equal(v.verdict, "green");
  assert.match(v.detail, /3\/3/);
});

test("verdictFor: mixed is flaky with the rate", () => {
  const v = verdictFor([{ status: "expected" }, { status: "unexpected" }, { status: "expected" }]);
  assert.equal(v.verdict, "flaky");
  assert.match(v.detail, /2\/3/);
});

test("verdictFor: never passing is a hard failure", () => {
  assert.equal(verdictFor([{ status: "unexpected" }, { status: "unexpected" }]).verdict, "hard-failure");
});

test("verdictFor: only skipped is 'skipped', not green", () => {
  assert.equal(verdictFor([{ status: "skipped" }, { status: "skipped" }]).verdict, "skipped");
});

test("verdictFor: no observation is UNKNOWN, never clean", () => {
  const v = verdictFor([]);
  assert.equal(v.verdict, "unknown");
  assert.match(v.detail, /absent from every report/i);
});

test("renderJson carries one machine-readable row per baseline test", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2",
    tests: [{ title: "seen" }, { title: "never ran" }] }] };
  const j = renderJson(baseline, collectObservations(report([spec("seen", "expected")])));
  assert.equal(j.version, 1);
  assert.deepEqual(j.rows.map((r) => [r.title, r.verdict]), [["seen", "green"], ["never ran", "unknown"]]);
  assert.equal(j.rows[0].spec, "a/x.spec.ts");
});

test("renderTable lists every baseline test, including the unobserved ones", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2",
    tests: [{ title: "seen" }, { title: "never ran" }] }] };
  const md = renderTable(baseline, collectObservations(report([spec("seen", "expected")])));
  assert.match(md, /seen/);
  assert.match(md, /never ran/);
  assert.match(md, /unknown/i);
});

// P10: the opposite direction of silence. `renderTable`/`renderJson` iterate
// the BASELINE and look each of its titles up in the observations, so a
// report row whose title is NOT in the baseline is invisible to that walk --
// it means the `--grep` fragment reached outside the 92-test population
// (the exact failure mode Task 4's anchoring exists to rule out), and that
// must not be silently dropped.
test("unmatchedTitles finds an observed title absent from the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const byTitle = collectObservations(report([spec("known", "expected"), spec("mystery", "expected")]));
  assert.deepEqual(unmatchedTitles(baseline, byTitle), ["mystery"]);
});

test("unmatchedTitles is empty when every observed title is in the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const byTitle = collectObservations(report([spec("known", "expected")]));
  assert.deepEqual(unmatchedTitles(baseline, byTitle), []);
});

test("renderTable warns about, and names, an observed title outside the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const md = renderTable(
    baseline,
    collectObservations(report([spec("known", "expected"), spec("mystery", "expected")])),
  );
  assert.match(md, /## Warnings/);
  assert.match(md, /not in the baseline/i);
  assert.match(md, /mystery/);
});

test("renderTable has no Warnings section when every observed title is in the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const md = renderTable(baseline, collectObservations(report([spec("known", "expected")])));
  assert.doesNotMatch(md, /## Warnings/);
});

test("renderJson carries a structured warning for an observed title outside the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const j = renderJson(
    baseline,
    collectObservations(report([spec("known", "expected"), spec("mystery", "expected")])),
  );
  assert.equal(j.warnings.length, 1);
  assert.equal(j.warnings[0].type, "observed-not-in-baseline");
  assert.equal(j.warnings[0].count, 1);
  assert.deepEqual(j.warnings[0].titles, ["mystery"]);
  assert.equal(j.warnings[0].elided, 0);
});

test("renderJson.warnings is empty when every observed title is in the baseline", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const j = renderJson(baseline, collectObservations(report([spec("known", "expected")])));
  assert.deepEqual(j.warnings, []);
});

test("the unmatched-title warning is capped and names how many it elided", () => {
  const baseline = { specs: [{ relativePath: "a/x.spec.ts", tier: "T2", tests: [{ title: "known" }] }] };
  const strays = Array.from({ length: UNMATCHED_TITLE_CAP + 5 }, (_, i) => spec(`mystery-${i}`, "expected"));
  const byTitle = collectObservations(report([spec("known", "expected"), ...strays]));

  const j = renderJson(baseline, byTitle);
  assert.equal(j.warnings[0].count, UNMATCHED_TITLE_CAP + 5);
  assert.equal(j.warnings[0].titles.length, UNMATCHED_TITLE_CAP);
  assert.equal(j.warnings[0].elided, 5);

  const md = renderTable(baseline, byTitle);
  assert.match(md, /5 more not listed here/);
});
