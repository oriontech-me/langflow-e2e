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
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseHistory,
  testKey,
  selectRuns,
  indexOutcomes,
  compareRuns,
  renderReport,
} from "./lib/lane-verdict-diff.mjs";
import { parseArgs, defaultHistoryPath } from "./compare-lane-verdicts.mjs";

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

test("the default history path prefers the ledger when it exists", () => {
  const env = { XDG_STATE_HOME: "/state", HOME: "/home/x" };
  assert.equal(defaultHistoryPath(env, () => true), "/state/langflow-e2e/daily-history.jsonl");
  assert.match(defaultHistoryPath(env, () => false), /reports\/daily-history\.jsonl$/);
});

const runCli = (args, history) => {
  const dir = mkdtempSync(join(tmpdir(), "lane-diff-"));
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
  assert.match(parsed.source, /daily-history\.jsonl$/);
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
  assert.equal(defaultHistoryPath(env, () => true), "/ledger/daily-history.jsonl");
  assert.equal(
    defaultHistoryPath(env, (p) => p.startsWith("/state")),
    "/state/langflow-e2e/daily-history.jsonl",
    "an unset-but-declared LEDGER_DIR must not shadow a ledger that exists",
  );
});

test("--json stays parseable when the history file is missing", () => {
  const res = spawnSync(process.execPath, [CLI, "--history", "/nonexistent/history.jsonl", "--json"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  const parsed = JSON.parse(res.stdout);
  assert.match(parsed.error, /no history at/);
});
