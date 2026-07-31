// Unit tests for the triage input gate (#1178). Run with: npm run test:scripts
//
// Why these exist: the failure this gate prevents already happened and was
// invisible in the job log — the propose job printed `no results.json —
// history-only` as a warning and ran the agent anyway, which spent 28 of 30 turns
// and $1.66 reconstructing a daily that had recorded ZERO test results. Every
// branch below is one of the states that run could have been in, and the two that
// matter most are the ones that look alike:
//
//  - a run with zero tests (skip) vs a PARTIAL run where some shards aborted and
//    others executed (#1058 — must still be triaged, 205 tests recorded while
//    ~184 never ran);
//  - an absent report (skip, the daily produced nothing) vs a present-but-
//    unparseable one (hard error — a verdict this gate cannot derive must not be
//    reported as the healthy "nothing to triage", #1035).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decideTriageInput, readReportOrThrow } from "./triage-input-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "triage-input-gate.mjs");
const REPO_ROOT = path.resolve(HERE, "..");

const healthy = { stats: { expected: 460, unexpected: 2, flaky: 10, skipped: 2 } };
const zeroTests = { stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } };
const zeroWithAbort = {
  stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 },
  errors: [{ message: "Error: No report files found in .../all-blobs" }],
};
const partial = {
  stats: { expected: 200, unexpected: 5, flaky: 0, skipped: 0 },
  errors: [{ message: "Error: credentials preflight failed" }],
};

const from = (report) => () => report;

test("an absent report skips the agent", () => {
  const d = decideTriageInput("results.json", from(null));

  assert.equal(d.runAgent, false);
  assert.equal(d.verdict, "no-report");
  assert.match(d.reason, /was not produced by the triggering run/);
});

test("a zero-test run skips the agent and names the abort", () => {
  const d = decideTriageInput("results.json", from(zeroWithAbort));

  assert.equal(d.runAgent, false);
  assert.equal(d.verdict, "zero-tests");
  assert.match(d.reason, /ZERO test results/);
  assert.match(d.reason, /1 top-level error/);
  assert.match(d.reason, /infra abort/);
});

test("a zero-test run with no top-level error still skips", () => {
  const d = decideTriageInput("results.json", from(zeroTests));

  assert.equal(d.runAgent, false);
  assert.equal(d.verdict, "zero-tests");
  // No abort claim when nothing was observed — naming the wrong cause is worse
  // than naming none.
  assert.doesNotMatch(d.reason, /top-level error/);
});

test("a PARTIAL run RUNS the agent — the #1058 case is exactly what triage is for", () => {
  // The trap this asserts against: gating on "did anything abort" would skip the
  // most misleading run shape there is.
  const d = decideTriageInput("results.json", from(partial));

  assert.equal(d.runAgent, true);
  assert.equal(d.verdict, "partial");
  assert.equal(d.testsTotal, 205);
  assert.match(d.reason, /some shards aborted while others ran/);
});

test("an ordinary red daily runs the agent", () => {
  const d = decideTriageInput("results.json", from(healthy));

  assert.equal(d.runAgent, true);
  assert.equal(d.verdict, "usable");
  assert.equal(d.testsTotal, 474);
});

test("present-but-unparseable throws instead of returning a verdict", () => {
  assert.equal(
    readReportOrThrow("absent.json", { exists: () => false }),
    null,
    "an absent file is a state, not an error",
  );

  assert.throws(
    () =>
      readReportOrThrow("results.json", {
        exists: () => true,
        readFile: () => "{not json",
      }),
    /exists but does not parse as JSON/,
  );
});

test("CLI: skip path writes should_run_agent=false, warns, and summarises", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-gate-"));
  const results = path.join(dir, "results.json");
  const out = path.join(dir, "github_output");
  const summary = path.join(dir, "github_step_summary");
  fs.writeFileSync(results, JSON.stringify(zeroWithAbort));
  fs.writeFileSync(out, "");
  fs.writeFileSync(summary, "");

  const stdout = execFileSync(process.execPath, [SCRIPT, "--results", results], {
    env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  assert.equal(JSON.parse(stdout).runAgent, false);
  assert.match(fs.readFileSync(out, "utf-8"), /^should_run_agent=false$/m);
  assert.match(fs.readFileSync(out, "utf-8"), /^verdict=zero-tests$/m);
  // The reason must survive onto GITHUB_OUTPUT as ONE line — a multi-line value
  // would corrupt the output file and every later key with it.
  const reasonLines = fs
    .readFileSync(out, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("reason="));
  assert.equal(reasonLines.length, 1);
  assert.match(fs.readFileSync(summary, "utf-8"), /Triage agent SKIPPED/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("CLI: usable path writes should_run_agent=true; unparseable exits 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-gate-"));
  const results = path.join(dir, "results.json");
  const out = path.join(dir, "github_output");
  fs.writeFileSync(results, JSON.stringify(healthy));
  fs.writeFileSync(out, "");

  execFileSync(process.execPath, [SCRIPT, "--results", results], {
    env: { ...process.env, GITHUB_OUTPUT: out },
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.match(fs.readFileSync(out, "utf-8"), /^should_run_agent=true$/m);

  fs.writeFileSync(results, "{not json");
  assert.throws(
    () =>
      execFileSync(process.execPath, [SCRIPT, "--results", results], {
        encoding: "utf-8",
        stdio: "pipe",
      }),
    (error) => error.status === 2,
  );

  fs.rmSync(dir, { recursive: true, force: true });
});

test("triage-dispatch.yml gates the propose agent and pins the model on both jobs", () => {
  // Structural guard. Without it the gate can be reduced to a step that runs and
  // is ignored — the agent would still start, and the log would still look right.
  const yaml = fs.readFileSync(
    path.join(REPO_ROOT, ".github/workflows/triage-dispatch.yml"),
    "utf-8",
  );
  const lines = yaml.split("\n");

  const gate = lines.findIndex((l) => l.includes("scripts/triage-input-gate.mjs"));
  assert.ok(gate > 0, "the propose job must run the input gate");

  // Match the STEP, not any mention: a comment in this file also names the
  // action, and counting it made this guard fail against a correct workflow.
  const agents = lines
    .map((l, i) => [l, i])
    .filter(([l]) => /^\s*-\s+uses:\s*anthropics\/claude-code-action/.test(l))
    .map(([, i]) => i);
  assert.equal(agents.length, 2, "expected exactly two agent steps (propose + execute)");

  // The propose agent is the one after the gate, and it must be conditional on it.
  const proposeAgent = agents.find((i) => i > gate);
  assert.ok(proposeAgent, "the gate must precede the propose agent step");
  const proposeBlock = lines.slice(proposeAgent, proposeAgent + 8).join("\n");
  assert.match(
    proposeBlock,
    /should_run_agent == 'true'/,
    "the propose agent step must be gated on the input verdict",
  );

  // Model pinned on BOTH jobs — the action's default is claude-opus-5[1m].
  const pinned = lines.filter((l) => l.includes("--model claude-sonnet-5"));
  assert.equal(pinned.length, 2, "both claude_args must pin --model claude-sonnet-5");
  assert.equal(
    lines.filter((l) => l.includes("claude_args")).length,
    2,
    "expected exactly two claude_args lines",
  );
});
