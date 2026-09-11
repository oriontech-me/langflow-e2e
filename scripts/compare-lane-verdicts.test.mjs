// Unit tests for scripts/lib/lane-verdict-diff.mjs and its CLI.
// Run with: npm run test:scripts
//
// What these protect. This comparator is the instrument for step 14 of the VM
// migration: the stage's product is the classified list of differences between the
// Actions daily and the VM daily. So the failures worth pinning are the ones that
// would make the list LOOK right while being wrong:
//
//   - a comparison run across two DIFFERENT Langflow versions. That list is the
//     product's changelog wearing the costume of an environment difference, and it
//     is the single thing step 14 says must not happen. It has to BLOCK, not warn.
//   - a lane that skipped tests the other ran. A history row never names skipped
//     tests, so those differences are invisible; printing "no divergences" over them
//     would be worse than printing nothing. Only the skipped COUNT can betray it.
//   - a lane whose run aborted (run_errors). Its row carries totals, so it looks
//     like a verdict and is not one.
//   - keying a test on its LINE. The two lanes can sit one commit apart, so an edit
//     above a spec renumbers it, and a line-keyed diff then reports a file both lanes
//     failed identically as failing on one lane only.
//   - a failure both lanes saw being dropped instead of reported. That is the
//     product failing, and hiding it makes the day look lighter than it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseHistory,
  mergeEntries,
  testKey,
  specKey,
  isGenericSignature,
  comparableSignature,
  paramProvider,
  selectRuns,
  indexOutcomes,
  compareRuns,
  renderReport,
} from "./lib/lane-verdict-diff.mjs";
import { parseArgs, defaultHistorySources } from "./compare-lane-verdicts.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "compare-lane-verdicts.mjs");

const fail = (over = {}) => ({
  test: "a run emits a trace",
  file: "tests-automations/regression/api/monitor/api-monitor-traces.spec.ts",
  line: 42,
  tags: ["stable"],
  attempts: 3,
  error_signature: "Error: expected 200",
  ...over,
});

const row = (workflow, over = {}) => ({
  version: 1,
  date: "2026-09-07",
  workflow,
  run_id: workflow === "daily-stable" ? "111" : "step11",
  langflow_image: "langflowai/langflow-nightly:latest",
  langflow_version: "1.13.0.dev3",
  duration_ms: 1000,
  totals: { passed: 10, failed: 0, flaky: 0, skipped: 2 },
  failures: [],
  flaky: [],
  ...over,
});

const compare = (ci, vm, extra = {}) => compareRuns({ ci, vm, date: "2026-09-07", ...extra });

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a malformed line is reported, not silently dropped", () => {
  const { entries, bad } = parseHistory('{"date":"2026-09-07"}\nnot json\n\n{"date":"2026-09-08"}\n');
  assert.equal(entries.length, 2);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 2);
});

// ---------------------------------------------------------------------------
// Test identity
// ---------------------------------------------------------------------------

test("the key ignores the line number, so a renumbered spec still matches", () => {
  assert.equal(testKey(fail({ line: 42 })), testKey(fail({ line: 900 })));
});

test("the key separates parameterized variants of one spec", () => {
  assert.notEqual(testKey(fail({ param: "google" })), testKey(fail({ param: "openai" })));
});

test("a spec failing at a different line on each lane is AGREED, not two one-sided divergences", () => {
  const result = compare(
    row("daily-stable", { failures: [fail({ line: 42 })], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm", { failures: [fail({ line: 907 })], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  );
  assert.equal(result.divergences.length, 0);
  assert.equal(result.agreed.length, 1);
  assert.equal(result.agreed[0].kind, "agreed-failed");
});

// ---------------------------------------------------------------------------
// Blockers - the comparison must refuse rather than mislead
// ---------------------------------------------------------------------------

test("two different Langflow versions BLOCK the comparison and produce no list", () => {
  const result = compare(
    row("daily-stable", { langflow_version: "1.13.0.dev3", failures: [fail()] }),
    row("daily-stable-vm", { langflow_version: "1.12.0", failures: [] }),
  );
  assert.equal(result.comparable, false);
  assert.equal(result.divergences.length, 0);
  assert.match(result.blockers.join(" "), /DIFFERENT Langflow versions/);
  assert.match(renderReport(result), /NOT COMPARABLE/);
});

test("a missing lane row blocks and names which lane is missing", () => {
  const result = compare(row("daily-stable"), null);
  assert.equal(result.comparable, false);
  assert.match(result.blockers.join(" "), /daily-stable-vm/);
});

test("run_errors block: a row with totals is still not a verdict when the run aborted", () => {
  const result = compare(
    row("daily-stable"),
    row("daily-stable-vm", { run_errors: ["globalSetup failed: backend never answered"] }),
  );
  assert.equal(result.comparable, false);
  assert.match(result.blockers.join(" "), /top-level run error/);
  assert.match(result.blockers.join(" "), /globalSetup failed/);
});

// ---------------------------------------------------------------------------
// Warnings - the comparison stands but is narrower than it looks
// ---------------------------------------------------------------------------

test("an absent langflow_version WARNS instead of blocking, and says the parity is unverified", () => {
  const result = compare(
    row("daily-stable", { langflow_version: null }),
    row("daily-stable-vm"),
  );
  assert.equal(result.comparable, true);
  assert.match(result.warnings.join(" "), /UNVERIFIED/);
});

test("different skipped counts warn, naming both, because those tests are invisible in the list", () => {
  const result = compare(
    row("daily-stable", { totals: { passed: 10, failed: 0, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm", { totals: { passed: 8, failed: 0, flaky: 0, skipped: 4 } }),
  );
  const w = result.warnings.join(" ");
  assert.match(w, /SKIPPED different numbers/);
  assert.match(w, /Actions 2/);
  assert.match(w, /VM 4/);
  assert.match(w, /the VM ran fewer specs/);
});

test("equal skipped counts produce no skip warning", () => {
  const result = compare(row("daily-stable"), row("daily-stable-vm"));
  assert.equal(result.warnings.filter((w) => /SKIPPED/.test(w)).length, 0);
});

test("a failure carrying an infra_signature is flagged as not attributable to its spec", () => {
  const result = compare(
    row("daily-stable"),
    row("daily-stable-vm", {
      failures: [fail({ infra_signature: "backend-unreachable" })],
      totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 },
    }),
  );
  assert.match(result.warnings.join(" "), /infra_signature/);
});

test("different shard counts warn without blocking", () => {
  const result = compare(
    row("daily-stable", { backend: { shard_total: 4 } }),
    row("daily-stable-vm", { backend: { shard_total: 1 } }),
  );
  assert.equal(result.comparable, true);
  assert.match(result.warnings.join(" "), /different shard counts/);
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("a failure only the VM saw is classified as such and reaches the report", () => {
  const result = compare(
    row("daily-stable"),
    row("daily-stable-vm", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  );
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].kind, "vm-only-failed");
  assert.match(renderReport(result), /FAILED on the VM only/);
  assert.match(renderReport(result), /api-monitor-traces/);
});

test("a failure only Actions saw is classified as such", () => {
  const result = compare(
    row("daily-stable", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm"),
  );
  assert.equal(result.divergences[0].kind, "ci-only-failed");
});

test("failed on one lane and flaky on the other is a divergence of severity, not agreement", () => {
  const result = compare(
    row("daily-stable", { flaky: [fail()], totals: { passed: 9, failed: 0, flaky: 1, skipped: 2 } }),
    row("daily-stable-vm", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  );
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].kind, "severity-differs");
  assert.equal(result.divergences[0].ci.status, "flaky");
  assert.equal(result.divergences[0].vm.status, "failed");
});

test("a failure BOTH lanes saw is reported as agreement, not dropped", () => {
  const result = compare(
    row("daily-stable", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  );
  assert.equal(result.divergences.length, 0);
  assert.equal(result.agreed.length, 1);
  assert.match(renderReport(result), /Failed on BOTH lanes[^\n]*: 1/);
});

test("a test listed as both failed and flaky on one lane counts as failed", () => {
  const index = indexOutcomes({ failures: [fail()], flaky: [fail()] });
  assert.equal(index.size, 1);
  assert.equal([...index.values()][0].status, "failed");
});

test("VM-only failures sort above Actions-only ones, because they are the lane under test", () => {
  const other = fail({ test: "another", file: "b.spec.ts" });
  const result = compare(
    row("daily-stable", { failures: [other], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  );
  assert.deepEqual(
    result.divergences.map((d) => d.kind),
    ["vm-only-failed", "ci-only-failed"],
  );
});

// ---------------------------------------------------------------------------
// The target split (#1766)
// ---------------------------------------------------------------------------
// What these protect. The day's target is resolved at RUN TIME, so the two lanes can
// run one spec under different targets on the same morning — on 2026-09-08 Actions
// landed on google/gemini-3.5-flash and the VM on anthropic/claude-haiku-4-5, and a
// smoke that afternoon settled google/gemini-2.5-flash against the Actions lane's
// google/gemini-3.5-flash. Keyed with the target, one spec becomes two identities and a
// failure BOTH lanes saw is reported as two one-sided differences: that morning the
// report printed `Flaky on BOTH lanes: 0` while holding exactly that evidence.
//
// The SECOND thing they protect is that the fold does not conclude. Three review rounds
// found sixteen defects here and every one was a claim the row could not support:
// "different providers" over a shared provider, "the provider is eliminated" over an
// assertion shell, over a failure the harness could not attribute, and over a hard
// failure paired with a retry. So the tests below pin the ABSENCE of those claims as
// hard as they pin the fold itself.

const paramFail = (param, over = {}) =>
  fail({ test: "agent interaction suite", file: "tests-automations/regression/core-functionality/llm-agents/agent-component-regression.spec.ts", param, ...over });

const oneEach = (ciOver, vmOver, ciTotals = { passed: 9, failed: 1, flaky: 0, skipped: 2 }, vmTotals = ciTotals) => {
  const key = (t) => (t.failed ? "failures" : "flaky");
  return compare(
    row("daily-stable", { [key(ciTotals)]: [ciOver], totals: ciTotals }),
    row("daily-stable-vm", { [key(vmTotals)]: [vmOver], totals: vmTotals }),
  );
};

test("specKey drops the parameterization that testKey keeps", () => {
  assert.notEqual(testKey(paramFail("google")), testKey(paramFail("anthropic")));
  assert.equal(specKey(paramFail("google")), specKey(paramFail("anthropic")));
});

test("paramProvider reads the label shapes the corpus actually carries", () => {
  // Counted, not assumed: 97 param-carrying entries over both series, 8 distinct
  // labels, all `provider / model` except one `provider:openai (fallback)`. An earlier
  // comment here claimed a bare `google` was one of the shapes — it appears ZERO times.
  assert.equal(paramProvider("google / gemini-3.5-flash"), "google");
  assert.equal(paramProvider("provider:openai (fallback)"), "openai");
  assert.equal(paramProvider("google"), "google"); // tolerated, not a documented input
  assert.equal(paramProvider(null), null);
  assert.equal(paramProvider(""), null);
  // Names a MODEL, so it names no provider. Returning the whole string as one rendered
  // `providers DIFFER (Actions openai, VM model:gpt-4o-mini)` — the overclaim again.
  assert.equal(paramProvider("model:gpt-4o-mini"), null);
});

test("a side that names no provider is not reported as the SAME provider", () => {
  // `providersDiffer` is false for two different reasons — equal, or one side unnamed —
  // and the render collapsed both into "SAME provider (X)", printing `VM [no target]`
  // and `SAME provider (google)` on adjacent lines over a row that never said google.
  // It is also the only line in the block that touches cause.
  const result = oneEach(
    paramFail("google / gemini-3.5-flash", { error_signature: "Error: same" }),
    paramFail(undefined, { error_signature: "Error: same" }),
  );
  const d = result.divergences[0];
  assert.equal(d.crossTarget.providersKnown, false);
  assert.equal(d.crossTarget.providersDiffer, false);
  const text = renderReport(result);
  assert.match(text, /one side does not name a provider \(Actions google, VM —\)/);
  assert.match(text, /cannot be told from these two rows/);
  assert.doesNotMatch(text, /SAME provider/);
  // The --json surface was already right; the text has to agree with it.
  assert.deepEqual(d.providers, { ci: "google", vm: null });
});

test("the same spec under two targets is ONE entry, not two one-sided ones", () => {
  const result = oneEach(
    paramFail("google / gemini-3.5-flash", { error_signature: "Error: the agent never answered" }),
    paramFail("anthropic / claude-haiku-4-5", { error_signature: "Error: the agent never answered" }),
  );
  assert.equal(result.divergences.length, 1);
  const d = result.divergences[0];
  assert.equal(d.kind, "cross-target-failed");
  assert.deepEqual(d.params, { ci: "google / gemini-3.5-flash", vm: "anthropic / claude-haiku-4-5" });
  assert.equal(d.crossTarget.signaturesMatch, true);
  assert.equal(d.crossTarget.providersDiffer, true);
  // The name carries no target: the entry IS the pair.
  assert.doesNotMatch(d.name, /gemini|claude/);
});

test("two models of the SAME provider are not reported as different providers", () => {
  // The load-bearing defect the cold review found: the only comparison was string
  // inequality of the whole label, and every claim built on it said "providers". Nine
  // specs in the series have been recorded under two different google models, and a
  // 2026-09-08 smoke settled gemini-2.5-flash while the Actions lane pinned 3.5.
  const result = oneEach(
    paramFail("google / gemini-3.5-flash", { error_signature: "Error: the agent never answered" }),
    paramFail("google / gemini-2.5-flash", { error_signature: "Error: the agent never answered" }),
  );
  const d = result.divergences[0];
  assert.equal(d.crossTarget.providersDiffer, false);
  const text = renderReport(result);
  assert.match(text, /SAME provider \(google\), different target — the provider is NOT ruled out/);
  assert.doesNotMatch(text, /providers DIFFER/);
});

test("the fold NEVER stamps the head of the report, whatever it found", () => {
  // The stamp is the surface that cannot be qualified, and three rounds found it
  // asserting what the entry beneath it declined to assert. There is no longer one.
  for (const [ciSig, vmSig] of [
    ["Error: a real cause", "Error: a real cause"],
    ["Error: expect(locator).toBeVisible() failed", "Error: expect(locator).toBeVisible() failed"],
    ["Error: one thing", "Error: another thing"],
  ]) {
    const text = renderReport(
      oneEach(paramFail("google", { error_signature: ciSig }), paramFail("anthropic", { error_signature: vmSig })),
    );
    assert.doesNotMatch(text, /^!!/m, `stamped for ${ciSig} / ${vmSig}`);
    assert.doesNotMatch(text, /eliminated as the cause/);
    assert.doesNotMatch(text, /they are the product/);
  }
});

test("a folded pair ranks below BOTH one-sided failures, not just one of them", () => {
  // Half-pinned before: `-1` was caught but `0.5` — above `ci-only-failed`, which the
  // docblock says it must never outrank — passed, because the fixture had no
  // `ci-only-*` entry at all. Both sides now appear.
  const vmOnly = fail({ test: "traces are listed", file: "tests-automations/regression/api/monitor/api-monitor-traces.spec.ts" });
  const ciOnly = fail({ test: "a flow publishes", file: "tests-automations/regression/flow-functionality/publish-flow.spec.ts" });
  const result = compare(
    row("daily-stable", {
      failures: [ciOnly, paramFail("google", { error_signature: "Error: same" })],
      totals: { passed: 8, failed: 2, flaky: 0, skipped: 2 },
    }),
    row("daily-stable-vm", {
      failures: [vmOnly],
      flaky: [paramFail("anthropic", { error_signature: "Error: same" })],
      totals: { passed: 8, failed: 1, flaky: 1, skipped: 2 },
    }),
  );
  assert.deepEqual(
    result.divergences.map((d) => d.kind),
    ["vm-only-failed", "ci-only-failed", "cross-target-failed"],
  );
});

test("a flaky pair ranks with the flakes, below every hard failure", () => {
  // The old fixture had exactly one divergence, so `divergences[0]` was that pair at
  // ANY rank — `-99`, first in the whole report above every red, passed the test whose
  // title said "ranks with the flakes".
  const red = fail({ test: "traces are listed", file: "tests-automations/regression/api/monitor/api-monitor-traces.spec.ts" });
  const result = compare(
    row("daily-stable", {
      flaky: [paramFail("google", { error_signature: "Error: boom" })],
      totals: { passed: 9, failed: 0, flaky: 1, skipped: 2 },
    }),
    row("daily-stable-vm", {
      failures: [red],
      flaky: [paramFail("anthropic", { error_signature: "Error: boom" })],
      totals: { passed: 8, failed: 1, flaky: 1, skipped: 2 },
    }),
  );
  assert.deepEqual(
    result.divergences.map((d) => d.kind),
    ["vm-only-failed", "cross-target-flaky"],
  );
  assert.match(renderReport(result), /a retry passed on both/);
});

test("an infra_signature on ONE side names that side, and does not claim both", () => {
  // It is an OR, and one-sided is the ordinary case (2026-09-07: one on Actions against
  // five on the VM). The old text asserted "both sides" and "either lane", contradicting
  // the per-lane narrowing printed directly above it on the same screen.
  const result = oneEach(
    paramFail("google", { error_signature: "Error: same" }),
    paramFail("anthropic", { error_signature: "Error: same", infra_signature: "api-request-timeout" }),
  );
  const d = result.divergences[0];
  assert.equal(d.crossTarget.infraCi, false);
  assert.equal(d.crossTarget.infraVm, true);
  const text = renderReport(result);
  assert.match(text, /an infra_signature is present on the VM:/);
  // Specific to the infra line: the KIND_LABEL legitimately says "on both lanes",
  // which is what makes a broad assertion here useless.
  assert.doesNotMatch(text, /present on both lanes/);
  assert.doesNotMatch(text, /present on Actions/);
});

test("an assertion shell says it names no cause, and claims nothing further", () => {
  const shell = "Error: expect(locator).toBeVisible() failed";
  const result = oneEach(
    paramFail("google", { error_signature: shell }),
    paramFail("anthropic", { error_signature: shell }),
  );
  assert.equal(result.divergences[0].crossTarget.generic, true);
  const text = renderReport(result);
  assert.match(text, /signatures match, but the shared one is an assertion shell: it names no cause/);
  assert.doesNotMatch(text, /LEAD/);
});

test("a locator assertion is a shell too - it is the suite's most frequent signature", () => {
  // Requiring `expect(received)` covered the minority: measured over both series,
  // `expect(locator)` shells are 158 of 764 signatures against 97, and
  // `expect(locator).toBeVisible() failed` alone is 115.
  assert.equal(isGenericSignature("Error: expect(locator).toBeVisible() failed"), true);
  assert.equal(isGenericSignature("Error: expect(locator).toHaveCount(expected) failed"), true);
  assert.equal(isGenericSignature("Error: expect(received).not.toBeNull()"), true);
  // Still not a shell: it names its own cause.
  assert.equal(isGenericSignature("Error: setupPlayground: a canvas edit never reached the database"), false);
});

test("the shell rule sees THROUGH the ANSI the rows actually carry", () => {
  // Restored: the rewrite deleted this and nothing replaced it, leaving the only reason
  // the shell caveat ever fires on real data unpinned. Counted over both series: 262 of
  // 696 signatures are assertion shells and ALL 262 are ANSI-wrapped, so an
  // un-normalized rule recognises exactly zero of them.
  const esc = String.fromCharCode(27);
  const wrapped = `Error: ${esc}[2mexpect(${esc}[22m${esc}[31mreceived${esc}[39m${esc}[2m).${esc}[22mtoBe${esc}[2m(${esc}[22mexpected)`;
  assert.equal(isGenericSignature(wrapped), true);
  assert.equal(isGenericSignature(`Error: ${esc}[2mexpect(locator).toBeVisible() failed`), true);
});

test("each lane's line carries THAT lane's status and signature", () => {
  // Both were mirrorable without failing a test: every fixture gave the two sides the
  // same signature, and the mixed-severity test that asserted the two statuses was
  // deleted in the rewrite. "Both statuses printed" is named as a fact the entry
  // renders, so it has to be pinned.
  const result = compare(
    row("daily-stable", {
      failures: [paramFail("google", { error_signature: "Error: only Actions saw this" })],
      totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 },
    }),
    row("daily-stable-vm", {
      flaky: [paramFail("anthropic", { error_signature: "Error: only the VM saw this" })],
      totals: { passed: 9, failed: 0, flaky: 1, skipped: 2 },
    }),
  );
  const text = renderReport(result);
  assert.match(text, /Actions \[google\] failed: Error: only Actions saw this/);
  assert.match(text, /VM\s+\[anthropic\] flaky: Error: only the VM saw this/);
});

test("'unknown' is the absence of a signature, so it never makes a pair agree", () => {
  // `append-weekly-history.mjs` writes `unknown` when a failure carries no message, and
  // its own comment says triage already clustered unrelated specs by matching on it.
  // 15 of the 764 signatures in reports/daily-history.jsonl are `unknown`.
  const result = oneEach(
    paramFail("google", { error_signature: "unknown" }),
    paramFail("anthropic", { error_signature: "unknown" }),
  );
  assert.equal(result.divergences[0].crossTarget.signaturesMatch, false);
  assert.equal(comparableSignature("unknown"), null);
  assert.match(renderReport(result), /signatures do NOT match \(or one is absent\)/);
});

test("colorization on one lane only does not split one cause into two", () => {
  // 255 of the 764 rows carry SGR escapes, and the colorization is environment-derived —
  // nothing here sets FORCE_COLOR/NO_COLOR and supports-color keys on GITHUB_ACTIONS,
  // which the VM does not have.
  const esc = String.fromCharCode(27);
  const colorized = `Error: ${esc}[2mexpect(received)${esc}[22m.toBe(expected)`;
  const plain = "Error: expect(received).toBe(expected)";
  assert.equal(comparableSignature(colorized), plain);
  const result = oneEach(
    paramFail("google", { error_signature: colorized }),
    paramFail("anthropic", { error_signature: plain }),
  );
  assert.equal(result.divergences[0].crossTarget.signaturesMatch, true);
});

test("the two BOTH-lanes tallies keep their meaning, and the pairs get a line of their own", () => {
  // Adding pairs to those tallies is how an infra pair and a shell pair ended up
  // counted under "the product, not the environment". Leaving them uncounted is how a
  // day whose only finding was a pair ended with two zeroes and no mention of it.
  const result = oneEach(
    paramFail("google", { error_signature: "Error: same", infra_signature: "api-request-timeout" }),
    paramFail("anthropic", { error_signature: "Error: same", infra_signature: "api-request-timeout" }),
  );
  const text = renderReport(result);
  assert.match(text, /Failed on BOTH lanes \(the product, not the environment\): 0\n/);
  assert.match(text, /Same spec, DIFFERENT targets \(counted in neither tally above\): 1/);
  assert.match(text, /agent-component-regression/);
});

test("a day with no folded pair says zero, not nothing", () => {
  const text = renderReport(compare(row("daily-stable"), row("daily-stable-vm")));
  assert.match(text, /Same spec, DIFFERENT targets \(counted in neither tally above\): 0/);
});

test("the folded entry carries the tags of BOTH sides, not the CI side's empty array", () => {
  // `??` falls through on null, not on `[]`, so a CI entry tagged `[]` erased tags the
  // VM entry had. The lanes can sit one commit apart, which is how the two sides come
  // to disagree about tags at all — PR 1745 restored `@stable` to four specs between
  // two runs — and `--json` consumers filter on this field.
  const result = oneEach(
    paramFail("google", { error_signature: "Error: X", tags: [] }),
    paramFail("anthropic", { error_signature: "Error: X", tags: ["stable", "agents"] }),
  );
  assert.deepEqual(result.divergences[0].tags, ["stable", "agents"]);
});

test("three one-sided entries for one spec do NOT fold: which pairs with which is a guess", () => {
  const result = compare(
    row("daily-stable", {
      failures: [paramFail("google"), paramFail("openai")],
      totals: { passed: 8, failed: 2, flaky: 0, skipped: 2 },
    }),
    row("daily-stable-vm", { failures: [paramFail("anthropic")], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  );
  assert.equal(result.divergences.length, 3);
  assert.equal(result.divergences.filter((d) => d.kind.startsWith("cross-target")).length, 0);
});

test("two one-sided entries from the SAME lane are not a pair", () => {
  const result = compare(
    row("daily-stable", {
      failures: [paramFail("google"), paramFail("openai")],
      totals: { passed: 8, failed: 2, flaky: 0, skipped: 2 },
    }),
    row("daily-stable-vm"),
  );
  assert.equal(result.divergences.length, 2);
  assert.deepEqual(result.divergences.map((d) => d.kind), ["ci-only-failed", "ci-only-failed"]);
});

test("a spec targeted on one lane only still folds, and the report names the empty side", () => {
  const result = oneEach(
    paramFail("google", { error_signature: "Error: X" }),
    paramFail(undefined, { error_signature: "Error: X" }),
  );
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].kind, "cross-target-failed");
  assert.match(renderReport(result), /VM\s+\[no target\]/);
});

test("pairing leaves an unparameterized one-sided failure alone", () => {
  // The traces family carries no target, and the VM fails all of it every day while
  // Actions passes it. Folding anything there would erase divergence nº 4.
  const result = compare(
    row("daily-stable"),
    row("daily-stable-vm", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  );
  assert.equal(result.divergences.length, 1);
  assert.equal(result.divergences[0].kind, "vm-only-failed");
});

// ---------------------------------------------------------------------------
// Row selection
// ---------------------------------------------------------------------------

test("the default date is the newest day BOTH lanes recorded, not merely the newest day", () => {
  const entries = [
    { date: "2026-09-07", workflow: "daily-stable" },
    { date: "2026-09-07", workflow: "daily-stable-vm" },
    { date: "2026-09-08", workflow: "daily-stable" },
  ];
  assert.equal(selectRuns(entries).date, "2026-09-07");
});

test("with no complete day, the newest day is chosen so the blocker can explain it", () => {
  const picked = selectRuns([{ date: "2026-09-08", workflow: "daily-stable" }]);
  assert.equal(picked.date, "2026-09-08");
  assert.equal(picked.vm, null);
});

test("a re-run on the same day uses the LAST append and says so", () => {
  const entries = [
    { date: "2026-09-07", workflow: "daily-stable", run_id: "first" },
    { date: "2026-09-07", workflow: "daily-stable", run_id: "second" },
    { date: "2026-09-07", workflow: "daily-stable-vm", run_id: "vm" },
  ];
  const picked = selectRuns(entries);
  assert.equal(picked.ci.run_id, "second");
  assert.equal(picked.ciExtra, 1);
  const result = compareRuns({ ...picked, ci: row("daily-stable"), vm: row("daily-stable-vm") });
  assert.match(result.warnings.join(" "), /more than one row/);
});

test("rows from other workflows are ignored", () => {
  const picked = selectRuns([
    { date: "2026-09-07", workflow: "weekly-stable" },
    { date: "2026-09-07", workflow: "daily-stable" },
  ]);
  assert.equal(picked.vm, null);
  assert.deepEqual(picked.datesAvailable, ["2026-09-07"]);
});

// ---------------------------------------------------------------------------
// The report always states what it cannot see
// ---------------------------------------------------------------------------

test("a clean comparison still states the skipped/passed blind spot", () => {
  const text = renderReport(compare(row("daily-stable"), row("daily-stable-vm")));
  assert.match(text, /Divergences: 0/);
  assert.match(text, /SKIPPED are not named/);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("--date rejects anything that is not YYYY-MM-DD", () => {
  assert.throws(() => parseArgs(["--date", "yesterday"]), /YYYY-MM-DD/);
  assert.equal(parseArgs(["--date", "2026-09-07"]).date, "2026-09-07");
});

test("an unknown option is refused rather than ignored", () => {
  assert.throws(() => parseArgs(["--compare-everything"]), /unknown option/);
});

test("the default sources are the ledger AND the tracked file, in that order", () => {
  const env = { XDG_STATE_HOME: "/state", HOME: "/home/x" };
  const both = defaultHistorySources(env, () => true);
  assert.equal(both[0], "/state/langflow-e2e/daily-history.jsonl");
  assert.match(both[1], /reports\/daily-history\.jsonl$/);
  // With no ledger, the tracked file alone -- and it is still NAMED when absent, so
  // the error can say which path was wrong instead of "nothing was found".
  assert.equal(defaultHistorySources(env, () => false).length, 1);
});

const runCli = (args, history) => {
  const dir = makeTempDir("lane-diff-");
  const file = join(dir, "daily-history.jsonl");
  writeFileSync(file, history.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return spawnSync(process.execPath, [CLI, "--history", file, ...args], { encoding: "utf8" });
};

test("CLI exits 0 when a comparison was produced, divergences included", () => {
  const res = runCli([], [
    row("daily-stable"),
    row("daily-stable-vm", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  ]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /FAILED on the VM only/);
});

test("CLI exits 1 when the two rows cannot be compared", () => {
  const res = runCli([], [row("daily-stable")]);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /NOT COMPARABLE/);
});

test("CLI exits 2 on a usage error", () => {
  const res = runCli(["--date", "nope"], [row("daily-stable"), row("daily-stable-vm")]);
  assert.equal(res.status, 2);
});

test("CLI --json emits the classified result and names the history it read", () => {
  const res = runCli(["--json"], [
    row("daily-stable"),
    row("daily-stable-vm", { failures: [fail()], totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 } }),
  ]);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.divergences[0].kind, "vm-only-failed");
  assert.match(parsed.sources[0], /daily-history\.jsonl$/);
});

test("CLI prints the history path it used, so reading the wrong series is visible", () => {
  const res = runCli([], [row("daily-stable"), row("daily-stable-vm")]);
  assert.match(res.stdout, /^history: .*daily-history\.jsonl$/m);
});

// ---------------------------------------------------------------------------
// The version check is only REACHABLE if both writers record the field
// ---------------------------------------------------------------------------
//
// The blocker above is the one guarantee this comparator offers that a human eye
// does not, and it is dead code unless BOTH lanes put langflow_version on their row.
// One side alone leaves the comparator permanently on "UNVERIFIED", which reads like
// a check and is not one.
//
// Both reads are SCOPED to the step that appends history, and that is the point of
// them rather than a detail: daily-stable.yml already sets LANGFLOW_VERSION in the
// payload step ABOVE it, so a file-wide grep would stay green with the history
// step carrying nothing (the shadowing shape of #1717, one file over).

function blockAfter(text, startPattern, endPattern) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => startPattern.test(l));
  assert.ok(start >= 0, `could not find ${startPattern} to scope the read`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => endPattern.test(l));
  return rest.slice(0, end === -1 ? rest.length : end).join("\n");
}

test("daily-stable.yml passes the resolved version to the history appender, not only to the payload", () => {
  const yml = readFileSync(join(HERE, "..", ".github", "workflows", "daily-stable.yml"), "utf8");
  const step = blockAfter(yml, /^\s*- name: Append daily history\s*$/, /^\s{6}- name: /);
  assert.match(step, /append-weekly-history\.mjs/, "scoped to the wrong step");
  assert.match(step, /LANGFLOW_VERSION:/);
});

test("run-e2e.sh passes the resolved version to the history appender", () => {
  const sh = readFileSync(join(HERE, "run-e2e.sh"), "utf8");
  const block = blockAfter(sh, /HISTORY_FILE="\$LEDGER_HISTORY"/, /append-weekly-history\.mjs/);
  assert.match(block, /LANGFLOW_VERSION=/);
});

// ---------------------------------------------------------------------------
// Review follow-ups (PR 1728)
// ---------------------------------------------------------------------------

test("a flake BOTH lanes saw gets its own heading, not the 'failed on both' one", () => {
  // The 33 tests before this one only ever built `agreed-failed`, so one heading over
  // both buckets stayed green while the report told a reader that a retry was a hard
  // failure on both lanes.
  const result = compare(
    row("daily-stable", { flaky: [fail()], totals: { passed: 9, failed: 0, flaky: 1, skipped: 2 } }),
    row("daily-stable-vm", { flaky: [fail()], totals: { passed: 9, failed: 0, flaky: 1, skipped: 2 } }),
  );
  assert.equal(result.agreed.length, 1);
  assert.equal(result.agreed[0].kind, "agreed-flaky");
  const text = renderReport(result);
  assert.match(text, /Failed on BOTH lanes[^\n]*: 0/);
  assert.match(text, /Flaky on BOTH lanes[^\n]*: 1/);
});

test("the missing-row blocker names the workflow id the caller actually asked for", () => {
  const result = compareRuns({ ci: row("daily-stable"), vm: null, date: "2026-09-07", vmWorkflow: "daily-stable-vm-canary" });
  assert.match(result.blockers.join(" "), /daily-stable-vm-canary/);
  assert.doesNotMatch(result.blockers.join(" "), /daily-stable-vm row/);
});

test("the unverified-version warning names the lane that is actually missing it", () => {
  const noCi = compare(row("daily-stable", { langflow_version: null }), row("daily-stable-vm"));
  assert.match(noCi.warnings.join(" "), /the Actions row does not carry/);
  const noVm = compare(row("daily-stable"), row("daily-stable-vm", { langflow_version: null }));
  assert.match(noVm.warnings.join(" "), /the VM row does not carry/);
});

test("warnings survive a blocker in the TEXT report, as they already did in the object", () => {
  const result = compare(
    row("daily-stable", { langflow_version: null }),
    row("daily-stable-vm", { langflow_version: null, run_errors: ["globalSetup failed"] }),
  );
  assert.equal(result.comparable, false);
  assert.match(result.warnings.join(" "), /UNVERIFIED/);
  assert.match(renderReport(result), /UNVERIFIED/);
});

test("--allow-version-mismatch compares anyway, and stamps both surfaces", () => {
  const rows = [
    row("daily-stable", { langflow_version: "1.13.0.dev3" }),
    row("daily-stable-vm", {
      langflow_version: "1.13.0.dev4",
      failures: [fail()],
      totals: { passed: 9, failed: 1, flaky: 0, skipped: 2 },
    }),
  ];
  const blocked = compareRuns({ ci: rows[0], vm: rows[1], date: "2026-09-07" });
  assert.equal(blocked.comparable, false);

  const allowed = compareRuns({ ci: rows[0], vm: rows[1], date: "2026-09-07", allowVersionMismatch: true });
  assert.equal(allowed.comparable, true);
  assert.equal(allowed.divergences.length, 1);
  assert.deepEqual(allowed.versionMismatch, { ci: "1.13.0.dev3", vm: "1.13.0.dev4", allowed: true });
  assert.match(renderReport(allowed), /VERSION MISMATCH ACCEPTED/);

  const cli = runCli(["--allow-version-mismatch", "--json"], rows);
  assert.equal(cli.status, 0);
  assert.equal(JSON.parse(cli.stdout).versionMismatch.allowed, true);
});

test("a dev-level difference is NOT quietly demoted: it blocks like any other mismatch", () => {
  const result = compare(
    row("daily-stable", { langflow_version: "1.13.0.dev3" }),
    row("daily-stable-vm", { langflow_version: "1.13.0.dev4" }),
  );
  assert.equal(result.comparable, false, "dev3 vs dev4 is a day of commits on the release branch");
});

test("LEDGER_DIR wins over XDG_STATE_HOME, because a machine that sets it writes only there", () => {
  const env = { LEDGER_DIR: "/ledger", XDG_STATE_HOME: "/state", HOME: "/home/x" };
  assert.equal(defaultHistorySources(env, () => true)[0], "/ledger/daily-history.jsonl");
  assert.equal(
    defaultHistorySources(env, (p) => !p.startsWith("/ledger"))[0],
    "/state/langflow-e2e/daily-history.jsonl",
    "a declared-but-absent LEDGER_DIR must not shadow a ledger that exists",
  );
});

test("--json stays parseable when the history file is missing", () => {
  const res = spawnSync(process.execPath, [CLI, "--history", "/nonexistent/history.jsonl", "--json"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  assert.match(parsed.error, /no history at/);
});

// ---------------------------------------------------------------------------
// The two lanes do not share a file (independent review, round 2)
// ---------------------------------------------------------------------------
//
// The shape of the defect, because a test that only checks "merge works" would not
// have caught it: `ledger_seed()` copies the tracked file into the ledger EXACTLY
// once, and the Actions daily keeps committing rows into the tracked file forever
// after. So the ledger holds Actions rows frozen at seed time plus every VM row, and
// the tracked file holds Actions rows only. Read either alone and the newest day with
// both lanes is the seed day — which the tool would compare, and exit 0 over.

const dated = (workflow, date, over = {}) => row(workflow, { date, run_id: `${workflow}-${date}`, ...over });

test("a ledger frozen at seed time plus a live tracked file still compares TODAY", () => {
  const ledger = [
    dated("daily-stable", "2026-09-01"), // seeded copy, frozen here
    dated("daily-stable-vm", "2026-09-01"),
    dated("daily-stable-vm", "2026-09-07"), // the VM keeps writing
  ];
  const tracked = [
    dated("daily-stable", "2026-09-01"), // same row as the seeded copy
    dated("daily-stable", "2026-09-07"), // Actions keeps committing
  ];

  const ledgerOnly = selectRuns(ledger);
  assert.equal(ledgerOnly.date, "2026-09-01", "the defect: the ledger alone only ever agrees on the seed day");

  const merged = selectRuns(mergeEntries([{ entries: ledger }, { entries: tracked }]));
  assert.equal(merged.date, "2026-09-07");
  assert.ok(merged.ci && merged.vm);
});

test("the seeded copy and the tracked original are ONE row, not a duplicate re-run", () => {
  const one = dated("daily-stable", "2026-09-01");
  const merged = mergeEntries([{ entries: [one] }, { entries: [{ ...one }] }]);
  assert.equal(merged.length, 1);
  const picked = selectRuns(merged, { date: "2026-09-01" });
  assert.equal(picked.ciExtra, 0, "without dedupe every seeded day would claim a re-run");
});

test("two genuinely different runs on one day are both kept", () => {
  const merged = mergeEntries([
    { entries: [dated("daily-stable", "2026-09-07", { run_id: "first" })] },
    { entries: [dated("daily-stable", "2026-09-07", { run_id: "second" })] },
  ]);
  assert.equal(merged.length, 2);
});

test("comparing a day that is not the newest in the series says so", () => {
  const entries = [
    dated("daily-stable", "2026-09-07"),
    dated("daily-stable-vm", "2026-09-07"),
    dated("daily-stable", "2026-09-08"), // today ran on one lane only
  ];
  const picked = selectRuns(entries);
  assert.equal(picked.date, "2026-09-07");
  const result = compareRuns({ ...picked, ci: row("daily-stable"), vm: row("daily-stable-vm") });
  assert.match(result.warnings.join(" "), /NOT the newest day/);
  assert.match(renderReport(result), /NOT the newest day/);
});

test("a blocked day still reports every narrowing fact, not just the version one", () => {
  // The reader needs the skip delta precisely when the day is blocked: it is what says
  // whether re-running with --allow-version-mismatch buys anything.
  const result = compare(
    row("daily-stable", { langflow_version: "1.13.0.dev3", totals: { passed: 10, failed: 0, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm", { langflow_version: "1.12.0", totals: { passed: 8, failed: 0, flaky: 0, skipped: 13 } }),
  );
  assert.equal(result.comparable, false);
  assert.match(result.warnings.join(" "), /SKIPPED different numbers/);
  assert.match(renderReport(result), /SKIPPED different numbers/);
});

test("the test key separates its components, so a title and a param cannot collide", () => {
  const a = testKey({ file: "a.spec.ts", test: "runs agent", param: null });
  const b = testKey({ file: "a.spec.ts", test: "runs", param: "agent" });
  assert.notEqual(a, b);
});

test("CLI accepts --history twice and merges both files", () => {
  const dir = makeTempDir("lane-merge-");
  const one = join(dir, "ledger.jsonl");
  const two = join(dir, "tracked.jsonl");
  writeFileSync(one, JSON.stringify(dated("daily-stable-vm", "2026-09-07")) + "\n");
  writeFileSync(two, JSON.stringify(dated("daily-stable", "2026-09-07")) + "\n");
  const res = spawnSync(process.execPath, [CLI, "--history", one, "--history", two], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /history: .*ledger\.jsonl/);
  assert.match(res.stdout, /history: .*tracked\.jsonl/);
});

test("one missing source is skipped with a warning, not fatal, while the other is read", () => {
  const dir = makeTempDir("lane-partial-");
  const present = join(dir, "present.jsonl");
  writeFileSync(
    present,
    [dated("daily-stable", "2026-09-07"), dated("daily-stable-vm", "2026-09-07")]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const res = spawnSync(
    process.execPath,
    [CLI, "--history", join(dir, "gone.jsonl"), "--history", present],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /no history at .*gone\.jsonl, skipped/);
});

// ---------------------------------------------------------------------------
// The collection gate (#1813)
// ---------------------------------------------------------------------------
// A history row's totals cannot distinguish "this lane ran fewer tests" from "this
// lane never listed the file those tests are in". The second is what a missing
// provider key does, and it is the shape that got filed as a catalog problem twice.
// These pin that the comparison names it.

const gate = (present, absent) => ({ collection_gate_keys: { present, absent } });
const THREE = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY"];

test("two lanes that listed with different keys are told so, by name", () => {
  const result = compare(
    row("daily-stable", gate(THREE, [])),
    row("daily-stable-vm", gate(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], ["GOOGLE_API_KEY"])),
  );
  assert.deepEqual(result.gateMismatch, {
    ci: THREE,
    vm: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    ciOnly: ["GOOGLE_API_KEY"],
    vmOnly: [],
  });
  const warning = result.warnings.find((w) => w.includes("LISTED DIFFERENT SUITES"));
  assert.ok(warning, result.warnings.join("\n"));
  assert.match(warning, /Only Actions had GOOGLE_API_KEY/);
  // A warning, never a blocker: the VM has no Google key today and the comparison is
  // still the product of the stage.
  assert.equal(result.comparable, true);
});

test("the asymmetry is reported whichever lane is the narrower one", () => {
  const result = compare(
    row("daily-stable", gate(["OPENAI_API_KEY"], ["ANTHROPIC_API_KEY", "GOOGLE_API_KEY"])),
    row("daily-stable-vm", gate(THREE, [])),
  );
  assert.deepEqual(result.gateMismatch.vmOnly, ["ANTHROPIC_API_KEY", "GOOGLE_API_KEY"]);
  assert.match(
    result.warnings.find((w) => w.includes("LISTED DIFFERENT SUITES")),
    /only the VM had ANTHROPIC_API_KEY, GOOGLE_API_KEY/,
  );
});

test("identical key sets raise nothing at all", () => {
  const result = compare(row("daily-stable", gate(THREE, [])), row("daily-stable-vm", gate(THREE, [])));
  assert.equal(result.gateMismatch, null);
  assert.ok(!result.warnings.some((w) => w.includes("collection-gate")), result.warnings.join("\n"));
  assert.ok(!result.warnings.some((w) => w.includes("LISTED DIFFERENT SUITES")));
});

test("a lane that resolved NO key is named as that, not as an empty list", () => {
  // "Actions resolved " followed by nothing is a sentence the reader finishes wrongly,
  // and it is the state main is actually in until #1796's env block lands.
  const result = compare(
    row("daily-stable", gate([], THREE)),
    row("daily-stable-vm", gate(["OPENAI_API_KEY"], ["ANTHROPIC_API_KEY", "GOOGLE_API_KEY"])),
  );
  assert.match(
    result.warnings.find((w) => w.includes("LISTED DIFFERENT SUITES")),
    /Actions resolved no provider key/,
  );
});

test("a row without the block leaves parity UNVERIFIED rather than assumed equal", () => {
  // The version field's own precedent: a row written before the field existed cannot
  // claim the parity, and silence there would read as agreement.
  for (const [ci, vm, expected] of [
    [row("daily-stable"), row("daily-stable-vm"), /neither row carries/],
    [row("daily-stable", gate(THREE, [])), row("daily-stable-vm"), /the VM row does not carry/],
    [row("daily-stable"), row("daily-stable-vm", gate(THREE, [])), /the Actions row does not carry/],
  ]) {
    const warning = compare(ci, vm).warnings.find((w) => w.includes("collection-gate parity UNVERIFIED"));
    assert.ok(warning, "no unverified warning");
    assert.match(warning, expected);
  }
});

test("a malformed block is treated as absent, not as an empty key set", () => {
  // `present: []` and "no block" mean different things, and a block whose shape this
  // comparator cannot read means neither: reading it as an empty set would report a
  // fully-keyed lane as having listed nothing.
  const result = compare(
    row("daily-stable", { collection_gate_keys: { present: "OPENAI_API_KEY" } }),
    row("daily-stable-vm", gate(THREE, [])),
  );
  assert.equal(result.gateMismatch, null);
  assert.match(
    result.warnings.find((w) => w.includes("collection-gate parity UNVERIFIED")),
    /the Actions row does not carry/,
  );
});

test("a count difference points at the measured cause, and a SKIP difference does not", () => {
  // The two deltas are not the same question, and conflating them re-creates the
  // defect this field exists to end. Collection decides which FILES exist, so a
  // test-count difference really is explained by the listing gate. A skip happens at
  // RUN time, and the Actions row's gate describes its `prep` job — which carries no
  // provider keys while its shards carry all three. Blaming a skip difference on that
  // gate names Actions as the narrower lane when at run time it is the wider one.
  const result = compare(
    row("daily-stable", { ...gate(THREE, []), totals: { passed: 13, failed: 0, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm", {
      ...gate(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], ["GOOGLE_API_KEY"]),
      totals: { passed: 10, failed: 0, flaky: 0, skipped: 0 },
    }),
  );
  const counts = result.warnings.find((w) => w.includes("different test counts"));
  assert.match(counts, /the listing keys above differ/);

  const skips = result.warnings.find((w) => w.includes("SKIPPED different numbers"));
  assert.match(skips, /A missing provider key is the usual cause/);
  assert.ok(!skips.includes("listing keys"), skips);
});

test("with no gate recorded, the count warnings keep their original hypothesis", () => {
  const result = compare(
    row("daily-stable", { totals: { passed: 13, failed: 0, flaky: 0, skipped: 2 } }),
    row("daily-stable-vm", { totals: { passed: 10, failed: 0, flaky: 0, skipped: 0 } }),
  );
  assert.match(result.warnings.find((w) => w.includes("SKIPPED different numbers")), /usual cause/);
  assert.match(
    result.warnings.find((w) => w.includes("different test counts")),
    /may not have run the same suite revision/,
  );
});

test("the report prints each lane's key set under its counts", () => {
  const text = renderReport(
    compare(
      row("daily-stable", gate(THREE, [])),
      row("daily-stable-vm", gate(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], ["GOOGLE_API_KEY"])),
    ),
  );
  assert.match(text, /Actions {2}run 111 \| 10 passed/);
  assert.match(text, /listed with OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY/);
  assert.match(text, /listed with OPENAI_API_KEY, ANTHROPIC_API_KEY \| absent: GOOGLE_API_KEY/);
});

test("a lane with no block prints no key line, rather than an empty one", () => {
  const text = renderReport(compare(row("daily-stable", gate(THREE, [])), row("daily-stable-vm")));
  assert.equal(text.split("\n").filter((l) => l.includes("listed with")).length, 1);
});
