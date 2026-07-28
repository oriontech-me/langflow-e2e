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
//   unreadable     "true" when the report was missing or unparseable — a SUBSET of
//                  `empty`, split out so the failure message can name the real
//                  condition ("the merge produced nothing" rather than "the shards
//                  aborted before the first test", which points triage elsewhere)
//   tests_total    expected + unexpected + flaky + skipped
//   report_errors  number of top-level report errors
//   first_error    first error signature (single line, capped, display-safe) or ""
//
// Always exits 0 — this step reports facts and the workflow decides whether to
// fail, so the guard's own message stays separable from the run's verdict. A
// missing or unparseable report counts as EMPTY: a guard must not go green
// because it could not look.
//
// Pure, dependency-free ESM so the merge job runs it with plain `node` (no ts-node).

import fs from "node:fs";
import { pathToFileURL } from "node:url";

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

// Make a signature safe to RENDER (step output → `::error::` annotation and the
// umbrella issue's fenced block) WITHOUT changing what `errorSignature` returns:
// that value is the clustering key shared with the history appender, and rewriting
// it would stop new signatures from matching the ones already committed in
// reports/daily-history.jsonl — the 30-day same-signature flake criterion in
// CONTRIBUTING.md compares them across runs.
//   1. Playwright error messages carry ANSI colour codes (the committed history
//      shows `Error: \u001b[2mexpect(\u001b[22m…`), which render as literal noise
//      in an issue body.
//   2. Any remaining C0/DEL control char becomes a space. A lone `\r` survives
//      `errorSignature` (it splits on "\n" and only trims the ends) and the Actions
//      runner reads $GITHUB_OUTPUT line-wise, so a CR inside the value could forge
//      a second `key=value` line — `empty=false` included. Sanitising at the source
//      makes the output injection-proof without needing a heredoc delimiter.
export function displaySignature(signature) {
  if (!signature) return "";
  return signature
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
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
    for (const sig of result.signatures.slice(0, 4)) {
      console.log(`[integrity]   ${displaySignature(sig)}`);
    }
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
        `unreadable=${result.unreadable}`,
        `tests_total=${result.testsTotal}`,
        `report_errors=${result.reportErrors}`,
        // Single line and control-char free by construction (see displaySignature),
        // so a plain key=value is safe here — no heredoc delimiter needed.
        `first_error=${displaySignature(result.signatures[0])}`,
      ].join("\n") + "\n",
    );
  }
}

// Run only when invoked directly (not when imported by the test file).
//
// Both normalisations are load-bearing, and getting either wrong is SILENT: main()
// simply never runs, the step exits 0 with NO outputs, the workflow reads `empty`
// as "" and — before the fail-closed gate — went green on an empty report. A guard
// that can vanish quietly is the failure mode this whole file exists to remove, so
// the comparison has to be exact:
//   pathToFileURL — import.meta.url is percent-encoded, so a `file://${argv[1]}`
//     template stops matching as soon as the path needs escaping (one space does it);
//   realpathSync — the ESM loader resolves symlinks in import.meta.url while argv[1]
//     keeps the path as typed, so any symlinked ancestor (a macOS /var/folders tmpdir,
//     a symlinked checkout) breaks a plain comparison.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main();
}
