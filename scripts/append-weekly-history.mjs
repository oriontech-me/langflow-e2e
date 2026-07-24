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
//   "failures": [ { test, file, line, tags, attempts, error_signature, param? } ],
//   "flaky":    [ { test, file, line, tags, attempts, error_signature, param? } ]
//   `param` (optional, additive to schema v1) is the parameterization label a
//   model-parameterized spec carries on its describe title (e.g.
//   "google / gemini-2.5-flash" or "model:gpt-4o-mini"), used by the triage
//   dataset to group failures by provider variant (#899).
// }

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

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
  const err = result?.error || result?.errors?.[0];
  if (!err) return null;
  const raw = err.message || err.value || "";
  // First *non-empty* line (some messages lead with a blank line), trimmed and
  // capped so equal causes cluster to an equal signature.
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
        const firstFailedSignature = (test.results || [])
          .map((r) => firstErrorMessage(r))
          .find((m) => m);
        flaky.push({
          test: title,
          file,
          line,
          tags,
          attempts,
          error_signature: firstFailedSignature || "unknown",
          ...(param ? { param } : {}),
        });
        continue;
      }
      // unexpected (or anything else) → failure
      totals.failed++;
      const lastFailed = [...(test.results || [])]
        .reverse()
        .find((r) => r.status !== "passed");
      failures.push({
        test: title,
        file,
        line,
        tags,
        attempts,
        error_signature: firstErrorMessage(lastFailed) || "unknown",
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
};

mkdirSync(dirname(historyPath), { recursive: true });
appendFileSync(historyPath, JSON.stringify(entry) + "\n");

const summary = `[history] ${entry.date} ${workflow} run=${runId} ` +
  `passed=${totals.passed} failed=${totals.failed} flaky=${totals.flaky} skipped=${totals.skipped}`;
console.log(summary);
