// Adoption guard for the token attribution sidecar's bounds (issue #1217, §4.4).
// Run with: npm run test:scripts
//
// What this protects, and why review cannot:
//
// `TOKENS_TIMEOUT_MS` and `TOKENS_DETAIL_CAP` shipped as DEAD CONFIGURATION. They
// sat in the token POLLER step's own `env:` block, and a step-level `env:` does
// not cross into another step -- the sidecar runs inside the Playwright step, so
// it never saw either value and always used its hard-coded defaults. Nothing was
// wrong in the run: the lanes happened to set exactly the numbers that were
// already the defaults, so behaviour and intent agreed by coincidence. Change a
// lane's number and nothing would happen; the only symptom is a knob that does
// not turn.
//
// That is the failure mode this file exists for. It is invisible to a green run,
// invisible to a diff (the value IS in the workflow, spelled correctly, in a
// plausible place), and it defeats the mitigation exactly when it is needed --
// these are the bounds that stop a wedged monitor endpoint from eating a spec's
// 5-minute budget from inside `afterEach`, and the response to a wedge is to turn
// them DOWN in the lane, which would have done nothing.
//
// So the fix is job-level `env:`, and it is asserted structurally rather than
// reviewed. Job level is what makes ONE definition reach both readers: the poller
// step and the Playwright step the sidecar runs in. It is also the mechanism
// `manual.yml` already needs for its Ollama routing, because
// `.github/actions/run-e2e` declares per-step `env:` that ADDS to the job
// environment rather than replacing it.
//
// The lane list is DERIVED, not hard-coded: a lane is in scope because it sets
// `TOKENS_ATTRIB`, i.e. because it turns the sidecar on. A fourth lane that
// enables it inherits this guard the day it is written.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIR = path.join(REPO_ROOT, ".github/workflows");

/**
 * The bounds the sidecar reads. `TOKENS_ATTRIB` is the switch, not a bound.
 *
 * `TOKENS_BUDGET_MS` is listed ahead of its reader, deliberately. The per-call
 * wall-clock budget lands with #1217's `deleteFlow` hook, so on `main` today
 * nothing consumes it -- but the wiring is what this PR is about, and the
 * alternative is worse: adding it later means touching `pr-validation.yml` from a
 * spec PR, which flips that lane's coverage verdict to `canary` and drops its
 * impacted-spec run. Configuring it here costs nothing (an unread variable) and
 * means the sidecar lands into lanes that already turn its knob.
 */
const KNOBS = ["TOKENS_TIMEOUT_MS", "TOKENS_DETAIL_CAP", "TOKENS_BUDGET_MS"];

/**
 * Split a workflow into its jobs by indentation.
 *
 * No YAML parser is available in this repo (`npm run test:scripts` runs
 * dependency-free `.mjs`), and every other structural guard here reads the text.
 * Indentation is enough for the one question asked: GitHub Actions fixes the
 * depth of `jobs:` (0), a job id (2) and a job-level key (4), while anything
 * inside `steps:` sits at 6 or deeper.
 */
function jobsOf(text) {
  const lines = text.split("\n");
  const jobs = [];
  let current = null;
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    // A top-level key at column 0 ends the jobs block.
    if (/^\S/.test(line)) break;
    const jobStart = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobStart) {
      current = { id: jobStart[1], lines: [] };
      jobs.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs;
}

/**
 * The names defined in a job's JOB-LEVEL `env:` block — `    env:` at exactly
 * four spaces, its entries at six. A step's `env:` is indented deeper and is
 * deliberately not collected: that is the whole distinction this guard is about.
 */
function jobLevelEnv(job) {
  const names = new Set();
  let inside = false;
  for (const line of job.lines) {
    if (/^ {4}env:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    if (/^\s*(#.*)?$/.test(line)) continue;
    const entry = /^ {6}([A-Za-z0-9_]+):/.exec(line);
    if (entry) {
      names.add(entry[1]);
      continue;
    }
    // The block ends only at an OUTDENT, never at a deeper line. Treating any
    // non-entry line as the end was wrong and this guard caught it on itself: a
    // block-scalar value (`ANY_COMPLETION_PROVIDER: >-`) continues on an
    // eight-space line, so the scan stopped there and reported every later entry
    // as missing — a false red on a lane that was correctly wired.
    if (/^ {0,4}\S/.test(line)) inside = false;
  }
  return names;
}

/** Every `NAME:` defined inside a step-level `env:` (eight spaces or deeper). */
function stepLevelEnv(job) {
  const names = [];
  let indent = null;
  for (const line of job.lines) {
    const open = /^( {8,})env:\s*$/.exec(line);
    if (open) {
      indent = open[1].length + 2;
      continue;
    }
    if (indent === null) continue;
    if (/^\s*(#.*)?$/.test(line)) continue;
    const entry = new RegExp(`^ {${indent}}([A-Za-z0-9_]+):`).exec(line);
    if (entry) {
      names.push(entry[1]);
      continue;
    }
    // Same outdent rule as jobLevelEnv: a deeper line is a value continuation.
    if (new RegExp(`^ {0,${indent - 1}}\\S`).test(line)) indent = null;
  }
  return names;
}

/** Jobs that turn the sidecar on, across every workflow — the derived scope. */
function sidecarJobs() {
  const found = [];
  for (const file of fs.readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith(".yml"))) {
    const text = fs.readFileSync(path.join(WORKFLOW_DIR, file), "utf8");
    if (!text.includes("TOKENS_ATTRIB")) continue;
    for (const job of jobsOf(text)) {
      if (job.lines.some((l) => l.includes("TOKENS_ATTRIB"))) found.push({ file, job });
    }
  }
  return found;
}

test("every lane that enables the attribution sidecar defines its bounds at JOB level (§4.4)", () => {
  const jobs = sidecarJobs();
  // Fail-closed: a scope that silently came back empty would log the same line as
  // a healthy run, which is how this whole class of gap survives (#1012's rule).
  assert.ok(
    jobs.length >= 3,
    `expected at least the three lanes known to set TOKENS_ATTRIB (daily-stable, pr-validation, manual); ` +
      `found ${jobs.length} — either the scan broke or a lane lost the sidecar`,
  );

  for (const { file, job } of jobs) {
    const env = jobLevelEnv(job);
    for (const knob of KNOBS) {
      assert.ok(
        env.has(knob),
        `${file} → job "${job.id}" enables the sidecar but does not define ${knob} at JOB level. ` +
          `A step-level env: does not cross into the Playwright step the sidecar runs in, so the ` +
          `value would be dead configuration and the hard-coded default would apply instead.`,
      );
    }
  }
});

test("a bound is defined exactly once per lane, so the poller and the sidecar cannot drift (§4.4)", () => {
  for (const { file, job } of sidecarJobs()) {
    const perStep = stepLevelEnv(job);
    for (const knob of KNOBS) {
      const shadowed = perStep.filter((name) => name === knob).length;
      assert.equal(
        shadowed,
        0,
        `${file} → job "${job.id}" re-defines ${knob} in a step-level env:. Two definitions is how the ` +
          `poller and the sidecar end up bounded by different numbers while the workflow reads as if ` +
          `they share one — keep the job-level definition and delete this copy.`,
      );
    }
  }
});
