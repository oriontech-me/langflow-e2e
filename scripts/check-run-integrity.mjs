#!/usr/bin/env node
// Report-integrity guard for the stable workflows (issue #1012).
//
// The `shardguard` step in daily-stable.yml counts blob FILES, not tests. When
// every shard dies politely — aborting in globalSetup but still uploading a
// valid, EMPTY blob — that guard reports complete=true and the run reaches
// triage looking benign. On run 30351107916 (2026-07-28) all four shards
// aborted on the post-collect-models backend wedge (#1011): 4/4 blobs present,
// ZERO tests executed, and the umbrella issue rendered "No per-test @stable
// hard failures were auto-removed" — which reads like a clean triage.
//
// This script answers the question a blob count cannot: did the run produce any
// test result at all? Playwright's merged report makes that unambiguous —
// `stats` carries the aggregate, and `errors` carries the top-level
// (globalSetup / worker-level) failures that prevented tests from running:
//
//   "stats":  { "expected": 0, "skipped": 0, "unexpected": 0, "flaky": 0 }
//   "errors": [ 4x "[preflight] Langflow backend ... is not reachable ..." ]
//
// An empty run is a DIFFERENT failure class from an incomplete merge: the
// merge was complete, the shards simply never ran anything. It must never reach
// the @stable auto-removal path, and it must not be reported as a per-test day.
//
// Inputs (env):
//   PLAYWRIGHT_JSON   path to the MERGED Playwright JSON report (default: results.json)
//   GITHUB_OUTPUT     when set, step outputs are appended as key=value lines
//
// Outputs ($GITHUB_OUTPUT + human summary on stdout):
//   empty          "true" when the report carries no test result at all
//   tests_total    expected + unexpected + flaky + skipped
//   report_errors  number of top-level report errors
//   first_error    first error signature (single line, capped) or ""
//
// Always exits 0 — this step reports facts and the workflow decides whether to
// fail, so the guard's own message stays separable from the run's verdict. A
// missing or unparseable report counts as EMPTY: a guard must not go green
// because it could not look.
//
// Pure, dependency-free ESM so the merge job runs it with plain `node` (no ts-node).

import fs from "node:fs";

// Same normalisation the history appender uses (scripts/append-weekly-history.mjs):
// first non-empty line, trimmed, capped at 240 chars, so equal causes cluster to
// an equal signature across both consumers.
const SIGNATURE_MAX = 240;

export function errorSignature(error) {
  const raw = error?.message || error?.value || "";
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, SIGNATURE_MAX) : null;
}

export function errorSignatures(report) {
  return (report?.errors || []).map((e) => errorSignature(e)).filter(Boolean);
}

// Total test results the run produced, in any state. Read from `stats` rather
// than by walking `suites`, because `stats` is what Playwright itself reports
// for the merged run — an empty `suites` array with a non-zero `stats` (or the
// reverse) would be a Playwright bug, and `stats` is the cheaper source of truth.
export function testsTotal(report) {
  const s = report?.stats || {};
  return (
    (Number(s.expected) || 0) +
    (Number(s.unexpected) || 0) +
    (Number(s.flaky) || 0) +
    (Number(s.skipped) || 0)
  );
}

export function analyze(report) {
  // `null` = the report could not be read/parsed at all. Treated as empty, with
  // no error signatures to show, so the caller still fails loudly.
  if (!report) {
    return { empty: true, testsTotal: 0, reportErrors: 0, signatures: [], unreadable: true };
  }
  const total = testsTotal(report);
  const signatures = errorSignatures(report);
  return {
    empty: total === 0,
    testsTotal: total,
    reportErrors: (report.errors || []).length,
    signatures,
    unreadable: false,
  };
}

function readReport(path) {
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
  const result = analyze(readReport(reportPath));

  if (result.unreadable) {
    console.log(`[integrity] ${reportPath} is missing or unparseable — treating the run as EMPTY.`);
  } else if (result.empty) {
    console.log(
      `[integrity] ZERO tests executed (stats total = 0) with ${result.reportErrors} top-level ` +
        `report error(s) — the shards aborted before any test ran.`,
    );
    for (const sig of result.signatures.slice(0, 4)) console.log(`[integrity]   ${sig}`);
  } else {
    console.log(
      `[integrity] ${result.testsTotal} test result(s) in ${reportPath}` +
        `${result.reportErrors ? ` (plus ${result.reportErrors} top-level report error(s))` : ""}.`,
    );
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `empty=${result.empty}`,
        `tests_total=${result.testsTotal}`,
        `report_errors=${result.reportErrors}`,
        // Single-line by construction (the signature is one capped line), so a
        // plain key=value is safe here — no heredoc delimiter needed.
        `first_error=${result.signatures[0] || ""}`,
      ].join("\n") + "\n",
    );
  }
}

// Run only when invoked directly (not when imported by the test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
