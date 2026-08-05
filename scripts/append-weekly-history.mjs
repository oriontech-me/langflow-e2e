#!/usr/bin/env node
// Append one JSON line to reports/weekly-history.jsonl from a Playwright
// JSON report. Designed to run inside weekly-stable.yml after the test step.
//
// Inputs (env vars):
//   PLAYWRIGHT_JSON           Path to Playwright JSON output (default: results.json)
//   HISTORY_FILE              Path to JSONL file (default: reports/weekly-history.jsonl)
//   WORKFLOW                  Workflow id stored in the entry (default: weekly-stable)
//   GITHUB_RUN_ID             Run id (provided by Actions)
//   GITHUB_SERVER_URL         e.g. https://github.com (provided by Actions)
//   GITHUB_REPOSITORY         e.g. owner/repo (provided by Actions)
//   LANGFLOW_IMAGE            Full image ref including tag, e.g. langflowai/langflow-nightly:latest
//
// Schema (version 1):
// {
//   "version": 1,
//   "date": "YYYY-MM-DD",
//   "workflow": "weekly-stable",
//   "run_id": "...",
//   "run_url": "...",
//   "langflow_image": "...",
//   "duration_ms": 0,
//   "totals": { "passed": 0, "failed": 0, "flaky": 0, "skipped": 0 },
//   "failures": [ { test, file, line, tags, attempts, error_signature, infra_signature, param? } ],
//   "flaky":    [ { test, file, line, tags, attempts, error_signature, infra_signature, param? } ],
//   "run_errors": [ "..." ]                     // optional, see below
//   `infra_signature` (additive to schema v1, #1310) is the id of the
//   infra-signature the entry's error matched (`scripts/lib/infra-signatures.mjs`)
//   or null — i.e. "the harness could not reach the backend, so this failure is
//   not attributable to the spec that reported it". It is written HERE, rather
//   than derived by triage, because it must be classified from the FULL error
//   text: `error_signature` is line 1 only, and a wedge routinely surfaces as an
//   assertion whose *cause* line carries the transport error (the `#751`
//   credential guard being the usual wrapper). Rows written before #1310 lack
//   the field, and the triage dataset falls back to classifying
//   `error_signature` for those — a strictly weaker check.
//   `param` (optional, additive to schema v1) is the parameterization label a
//   model-parameterized spec carries on its describe title (e.g.
//   "google / gemini-2.5-flash" or "model:gpt-4o-mini"), used by the triage
//   dataset to group failures by provider variant (#899).
//   `run_errors` (optional, additive to schema v1) carries the TOP-LEVEL report
//   errors — globalSetup / worker-level failures that stopped tests from running
//   at all. Omitted when there are none, so its presence is itself the signal
//   that something failed outside the tests (#1012).
// }

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { classifyInfraError } from "./lib/infra-signatures.mjs";

const SCHEMA_VERSION = 1;

const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
const historyPath = process.env.HISTORY_FILE || "reports/weekly-history.jsonl";
const workflow = process.env.WORKFLOW || "weekly-stable";

if (!existsSync(reportPath)) {
  console.error(`[history] Playwright JSON not found at ${reportPath}; skipping append.`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(reportPath, "utf8"));

const totals = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
const failures = [];
const flaky = [];

function firstErrorMessage(result) {
  return errorSignature(result?.error || result?.errors?.[0]);
}

// The COMPLETE message of the same error object `firstErrorMessage` summarises —
// uncapped and unsplit. Only used for `infra_signature` (#1310): the exemption's
// classifier matches anywhere in the message, and truncating to line 1 first is
// what makes it miss the guard-wrapped shape. Never stored; the full text of a
// failure belongs in the artifact, not in the history file.
function fullErrorText(result) {
  const err = result?.error || result?.errors?.[0];
  if (!err) return null;
  return err.message || err.value || null;
}

// The id of the infra signature this error carries, or null. `null` means "could
// be the spec's own", never "definitely the spec's own" — the list is narrow by
// design (scripts/lib/infra-signatures.ts).
function infraSignatureId(result) {
  return classifyInfraError(fullErrorText(result))?.id ?? null;
}

// Normalise ONE error object (not a result) to its signature: first *non-empty*
// line (some messages lead with a blank line), trimmed and capped so equal
// causes cluster to an equal signature. Shared by the per-test path above and
// the top-level `report.errors` path below, whose entries are already error
// objects rather than results.
function errorSignature(err) {
  if (!err) return null;
  const raw = err.message || err.value || "";
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  return line ? line.slice(0, 240) : null;
}

function specRelFile(spec) {
  const file = spec?.file || spec?.location?.file || "";
  try {
    return relative(process.cwd(), resolve(file));
  } catch {
    return file;
  }
}

// Extract the parameterization label a model-parameterized spec carries on its
// `describe` title — e.g. `Agent max_tokens [google / gemini-2.5-flash]` →
// `google / gemini-2.5-flash`, or `[model:gpt-4o-mini]` → `model:gpt-4o-mini`.
// Scan the suite path innermost-first and return the first bracketed content;
// null when nothing is parameterized. Recorded as `param` so the triage dataset
// can group failures by provider variant (#899).
function paramFromSuitePath(suitePath) {
  for (let i = suitePath.length - 1; i >= 0; i--) {
    const m = /\[([^\]]+)\]/.exec(suitePath[i] || "");
    if (m) return m[1].trim();
  }
  return null;
}

function visit(node, suitePath = []) {
  const path = node.title ? [...suitePath, node.title] : suitePath;
  const param = paramFromSuitePath(path);
  for (const spec of node.specs || []) {
    const file = specRelFile(spec);
    const line = spec?.line || spec?.location?.line || 0;

    for (const test of spec.tests || []) {
      const tags = test.tags || spec.tags || [];
      const status = test.status; // "expected" | "unexpected" | "flaky" | "skipped"
      const attempts = (test.results || []).length;
      const title = spec.title;

      if (status === "skipped") {
        totals.skipped++;
        continue;
      }
      if (status === "expected") {
        totals.passed++;
        continue;
      }
      if (status === "flaky") {
        totals.flaky++;
        // A flaky test failed on an earlier attempt and passed on a retry.
        // Surface that first failed attempt's message through the same
        // normaliser used for hard failures, so the flake-recurrence criterion
        // in CONTRIBUTING.md (same signature within 30 days) can be applied
        // mechanically to `.flaky[]` rows too. Pick the first result that
        // actually carries a message — skipping any interrupted/no-message
        // attempt that may precede the real failure.
        // Hold on to the RESULT, not just its signature: `infra_signature` has to
        // be classified from that same attempt's full error text (#1310).
        const firstFailedResult = (test.results || []).find((r) => firstErrorMessage(r));
        const firstFailedSignature = firstErrorMessage(firstFailedResult);
        flaky.push({
          test: title,
          file,
          line,
          tags,
          attempts,
          error_signature: firstFailedSignature || "unknown",
          infra_signature: infraSignatureId(firstFailedResult),
          ...(param ? { param } : {}),
        });
        continue;
      }
      // unexpected (or anything else) → failure
      totals.failed++;
      // `skipped` is excluded, not just `passed` (#1310). When a test fails and
      // its retries are then SKIPPED — what a `test.describe.serial` block does
      // when it aborts — the last non-passed result is a skipped attempt that
      // carries no error at all, so this used to select it and record
      // `error_signature: "unknown"` while the real message sat on attempt 0.
      // Two of the 24 hard failures on run 30997773754 landed that way
      // (`webhook-component-regression:191`, `agent-context-id-isolation:557`),
      // and `unknown` is not a signature but the absence of one: triage's
      // recurrence rule matches on it, so message-less failures clustered
      // together across unrelated specs.
      //
      // `build-run-payload.mjs` has always excluded `skipped` here, and its
      // header claims to mirror this file's parsing — the two had drifted, which
      // is why the umbrella's collateral block named these two failures while
      // the history row for the same failure said `unknown`.
      const lastFailed = [...(test.results || [])]
        .reverse()
        .find((r) => r.status !== "passed" && r.status !== "skipped");
      failures.push({
        test: title,
        file,
        line,
        tags,
        attempts,
        error_signature: firstErrorMessage(lastFailed) || "unknown",
        // Classified from the LAST failed attempt, matching the exemption's own
        // wording ("a hard failure whose LAST error is transport-level") and
        // `remove-stable-from-failures.ts`, so the history and the umbrella's
        // collateral block cannot disagree about the same failure.
        infra_signature: infraSignatureId(lastFailed),
        ...(param ? { param } : {}),
      });
    }
  }
  for (const child of node.suites || []) visit(child, path);
}

for (const suite of report.suites || []) visit(suite);

const runId = process.env.GITHUB_RUN_ID || "local";
const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
const repo = process.env.GITHUB_REPOSITORY || "";
const runUrl = repo ? `${serverUrl}/${repo}/actions/runs/${runId}` : null;

// Top-level report errors — globalSetup / worker-level failures that stopped
// tests from running at all, as opposed to a test failing. Recorded so a line
// whose `totals` are ALL ZERO carries its own explanation instead of being
// indistinguishable from "nothing failed" (#1012: on 2026-07-28 every shard
// aborted in the globalSetup preflight and the history line said 0/0/0/0 with
// no reason attached). Additive and optional — omitted when there are none, so
// schema v1 readers are unaffected.
const runErrors = (report?.errors || []).map((e) => errorSignature(e)).filter(Boolean);

const entry = {
  version: SCHEMA_VERSION,
  date: new Date().toISOString().split("T")[0],
  workflow,
  run_id: runId,
  run_url: runUrl,
  langflow_image: process.env.LANGFLOW_IMAGE || null,
  duration_ms: Math.round(report?.stats?.duration ?? 0),
  totals,
  failures,
  flaky,
  ...(runErrors.length ? { run_errors: runErrors } : {}),
};

mkdirSync(dirname(historyPath), { recursive: true });
appendFileSync(historyPath, JSON.stringify(entry) + "\n");

const executed = totals.passed + totals.failed + totals.flaky + totals.skipped;
const summary = `[history] ${entry.date} ${workflow} run=${runId} ` +
  `passed=${totals.passed} failed=${totals.failed} flaky=${totals.flaky} skipped=${totals.skipped}` +
  (runErrors.length ? ` run_errors=${runErrors.length}` : "") +
  (executed === 0 ? " (ZERO tests executed — infra abort)" : "");
console.log(summary);
