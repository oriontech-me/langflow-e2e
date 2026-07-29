#!/usr/bin/env node
// Merge-side reporter for the in-run backend liveness data (issue #1030).
//
// Consumes the per-shard summaries written by scripts/watch-backend.mjs
// --summarize and answers the question the umbrella issue could not answer
// before: was the backend GONE during this run, and which failures overlap the
// outages? Without it the daily reports a wedge as a list of unrelated specs and
// triage pays a full cycle to rediscover the cause (run 30374528125: 14 phantom
// failures on one shard, 5 real ones across the other three).
//
// Attribution across shards is only possible because each summary carries the
// spec-file list its shard ran (matrix.files). The MERGED Playwright report has
// no shard column, so without that list a shard-3 outage could be blamed for a
// shard-4 failure.
//
// HONESTY REQUIREMENT (why the rendered output always prints the down-share):
// on daily run 30444299314 the heavy shards were unreachable for 33-73% of
// their span. At that coverage "the failure landed inside an outage" is close to
// a coin flip, so the section states the share next to the count and calls the
// overlap a lead, never a verdict. Turning overlap into a tag decision is #1031's
// job, under its own rules.
//
// This step REPORTS. It never fails the run and never gates the @stable tag: a
// missing artifact yields `measured=false`, which must never be read as "no
// wedge happened" — the distinction a silent diagnostic would erase.
//
// "Never fails the run" is ENFORCED, not merely intended: the entry point below
// swallows every throw, and the workflow step carries continue-on-error. Both
// halves matter, because the merge job's `Auto-remove @stable from hard failures`
// and `Create issue on failure` steps have no always() — a red step here would
// skip the umbrella issue this reporter is meant to improve.
//
// Inputs (env):
//   LIVENESS_DIR      directory of per-shard summary JSONs (default all-liveness)
//   PLAYWRIGHT_JSON   merged Playwright JSON report (default results.json)
//   MAX_WINDOWS       windows rendered per shard before truncating (default 12)
//   GITHUB_OUTPUT     when set, step outputs are appended
//   GITHUB_STEP_SUMMARY  when set, the section is appended to the run summary
//
// Outputs:
//   measured             "true" when at least one shard recorded probes
//   wedged               "true" when at least one outage was measured
//   shards_measured      how many shard summaries carried probes
//   outages_total        outage windows across all shards
//   down_seconds_total   measured unreachable seconds across all shards
//   collateral_attempts  failing attempts overlapping a measured outage
//   summary_md           the rendered section (heredoc-delimited)
//
// Pure, dependency-free ESM so the merge job runs it with plain `node`.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_MAX_WINDOWS = 12;
// A fixed heredoc delimiter for the multiline step output. Any rendered line
// equal to it is dropped (see outputLines) so the value cannot be closed early
// — the $GITHUB_OUTPUT equivalent of the injection guard in
// scripts/check-run-integrity.mjs.
export const MD_DELIMITER = "LIVENESS_MD_EOF";

// The merged report's spec paths are relative to Playwright's rootDir (`tests/`),
// while matrix.files may carry either form depending on how the list was built.
// Normalise both sides to the rootDir-relative shape.
export function normalizeSpecPath(file) {
  return String(file || "")
    .replace(/^\.\//, "")
    .replace(/^tests\//, "");
}

export function readSummaries(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // download-artifact without merge-multiple nests each artifact in its own
      // directory; tolerate both layouts rather than depending on the caller.
      summaries.push(...readSummaries(full));
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
      if (parsed && typeof parsed === "object") summaries.push(parsed);
    } catch {
      // A truncated summary is data we do not have, not a reason to fail.
    }
  }
  return summaries.sort((a, b) => String(a.shard).localeCompare(String(b.shard), "en", { numeric: true }));
}

// Flatten the merged report into attempt records. Every retry counts: the cost
// of a wedge is precisely that each collateral test burns its whole retry budget.
export function collectAttempts(report) {
  const attempts = [];
  const walk = (node, inheritedFile) => {
    const file = node.file || inheritedFile;
    for (const sub of node.suites || []) walk(sub, file);
    for (const spec of node.specs || []) {
      const specFile = spec.file || file;
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          const startAt = Date.parse(result.startTime);
          if (!Number.isFinite(startAt)) continue;
          attempts.push({
            file: normalizeSpecPath(specFile),
            title: spec.title || "",
            status: result.status,
            retry: Number(result.retry) || 0,
            startAt,
            endAt: startAt + (Number(result.duration) || 0),
          });
        }
      }
    }
  };
  for (const suite of report?.suites || []) walk(suite, suite.file);
  return attempts;
}

const FAILED = new Set(["failed", "timedOut", "interrupted"]);

function overlapsAny(attempt, windows) {
  return windows.some((w) => {
    const start = Date.parse(w.startAt);
    const end = Date.parse(w.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
    return attempt.startAt <= end && attempt.endAt >= start;
  });
}

export function attribute(summaries, attempts) {
  const shards = summaries.map((summary) => {
    const own = new Set((summary.files || []).map(normalizeSpecPath));
    const mine = attempts.filter((a) => own.has(a.file));
    const failing = mine.filter((a) => FAILED.has(a.status));
    const windows = summary.windows || [];
    const collateral = failing.filter((a) => overlapsAny(a, windows));
    return {
      shard: String(summary.shard || "?"),
      measured: summary.measured === true,
      outageCount: Number(summary.outageCount) || 0,
      downSeconds: Number(summary.downSeconds) || 0,
      spanSeconds: Number(summary.spanSeconds) || 0,
      downPct: Number(summary.downPct) || 0,
      probeCount: Number(summary.probeCount) || 0,
      windows,
      attempts: mine.length,
      failing: failing.length,
      collateral: collateral.length,
      collateralFiles: [...new Set(collateral.map((a) => a.file.split("/").pop()))].sort(),
    };
  });

  return {
    shards,
    measured: shards.some((s) => s.measured),
    shardsMeasured: shards.filter((s) => s.measured).length,
    wedged: shards.some((s) => s.outageCount > 0),
    outagesTotal: shards.reduce((acc, s) => acc + s.outageCount, 0),
    downSecondsTotal: Math.round(shards.reduce((acc, s) => acc + s.downSeconds, 0) * 10) / 10,
    collateralAttempts: shards.reduce((acc, s) => acc + s.collateral, 0),
  };
}

const min = (seconds) => `${Math.round((seconds / 60) * 10) / 10} min`;
const clock = (iso) => (Date.parse(iso) ? new Date(iso).toISOString().slice(11, 19) : "?");

export function renderSection(agg, { maxWindows = DEFAULT_MAX_WINDOWS } = {}) {
  const head = "### 🔌 Backend liveness (in-run measurement)";

  if (!agg.measured) {
    return [
      head,
      "",
      "**Not measured** — no shard produced liveness probes, so this run says *nothing*",
      "about whether the backend was up. Do not read this as a clean backend: check the",
      "`Start the backend liveness recorder` / `Summarize backend liveness` steps and the",
      "`liveness-*` artifacts. Mechanism: #1030.",
    ].join("\n");
  }

  if (!agg.wedged) {
    return [
      head,
      "",
      `The backend answered every probe on ${agg.shardsMeasured} measured shard(s) — no mid-run outage.`,
      "Failures on this run are **not** wedge collateral (#1030).",
    ].join("\n");
  }

  const rows = agg.shards
    .filter((s) => s.measured)
    .map(
      (s) =>
        `| ${s.shard} | ${s.outageCount} | ${min(s.downSeconds)} (${s.downPct}%) | ${min(s.spanSeconds)} | ${s.failing} | ${s.collateral} |`,
    );

  const worst = Math.max(...agg.shards.map((s) => s.downPct), 0);
  const lines = [
    head,
    "",
    `**The Langflow worker went down mid-run on ${agg.shards.filter((s) => s.outageCount > 0).length} shard(s)** —`,
    `${agg.outagesTotal} outage(s), ${min(agg.downSecondsTotal)} of measured unreachable backend.`,
    "This is the mid-run wedge (#1030), measured by the in-run recorder rather than inferred",
    "from the report. It is **not** a per-test regression.",
    "",
    "| Shard | Outages | Backend down | Observed span | Failing attempts | …overlapping an outage |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
    `⚠️ **Read the last column against the down-share.** The backend was unreachable for up to ${worst}%`,
    "of the observed span, so an attempt can overlap an outage by chance. Overlap is a **lead, not a",
    "verdict** — the tag decision belongs to #1031's rules, not to this table.",
  ];

  for (const shard of agg.shards.filter((s) => s.outageCount > 0)) {
    const shown = shard.windows.slice(0, maxWindows);
    lines.push(
      "",
      `**Shard ${shard.shard} outage windows** (UTC):`,
      shown
        .map((w) => `\`${clock(w.startAt)}→${clock(w.endAt)}\` ${w.seconds}s${w.openEnded ? " (open-ended)" : ""}`)
        .join(" · "),
    );
    if (shard.windows.length > shown.length) {
      lines.push(`…and ${shard.windows.length - shown.length} more window(s) — full data in the \`liveness-${shard.shard}\` artifact.`);
    }
    if (shard.collateralFiles.length) {
      const files = shard.collateralFiles.slice(0, 8);
      lines.push(
        `Specs failing inside an outage: ${files.map((f) => `\`${f}\``).join(", ")}` +
          (shard.collateralFiles.length > files.length ? ` and ${shard.collateralFiles.length - files.length} more` : ""),
      );
    }
  }

  const unmeasured = agg.shards.filter((s) => !s.measured).map((s) => s.shard);
  if (unmeasured.length) {
    lines.push(
      "",
      `Shard(s) ${unmeasured.join(", ")} recorded no probes — their backend state is **unknown**, not clean.`,
    );
  }
  return lines.join("\n");
}

// Kept pure (and exported) so the heredoc framing is unit-testable: a rendered
// line equal to the delimiter would close the multiline value early and let the
// rest of the markdown be parsed as further key=value outputs.
export function outputLines(agg, markdown) {
  const safe = String(markdown)
    .split("\n")
    .filter((line) => line.trim() !== MD_DELIMITER)
    .join("\n");
  return [
    `measured=${agg.measured}`,
    `wedged=${agg.wedged}`,
    `shards_measured=${agg.shardsMeasured}`,
    `outages_total=${agg.outagesTotal}`,
    `down_seconds_total=${agg.downSecondsTotal}`,
    `collateral_attempts=${agg.collateralAttempts}`,
    `summary_md<<${MD_DELIMITER}`,
    safe,
    MD_DELIMITER,
  ];
}

function writeOutputs(agg, markdown) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, outputLines(agg, markdown).join("\n") + "\n");
}

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // No merged report (or unparseable): the outage data still stands on its
    // own, only the failure attribution is lost.
    return null;
  }
}

function main() {
  const dir = process.env.LIVENESS_DIR || "all-liveness";
  const reportPath = process.env.PLAYWRIGHT_JSON || "results.json";
  const maxWindows = Number(process.env.MAX_WINDOWS) || DEFAULT_MAX_WINDOWS;

  const summaries = readSummaries(dir);
  const report = readReport(reportPath);
  if (!report) {
    console.log(`[liveness] ${reportPath} unreadable — reporting outages without failure attribution.`);
  }
  const agg = attribute(summaries, collectAttempts(report));
  const markdown = renderSection(agg, { maxWindows });

  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
  }
  writeOutputs(agg, markdown);
}

// See scripts/check-run-integrity.mjs for why both normalisations are required.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    // A diagnostic must never be the reason a step goes red — same contract as
    // scripts/watch-backend.mjs. Here the stakes are higher than losing the
    // section: the merge job's `Auto-remove @stable from hard failures` and
    // `Create issue on failure` steps carry no always(), so they run under the
    // implicit success() of every step before them. A throw here would SKIP the
    // umbrella issue on a red daily — this reporter exists to make that issue
    // more useful, not to delete it. The step also carries continue-on-error as
    // a second layer.
    console.log(`[liveness] reporter error (ignored): ${err?.stack || err}`);
  }
}
