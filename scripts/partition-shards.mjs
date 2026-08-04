#!/usr/bin/env node
// Duration-balanced shard partitioner for the daily @stable run (issue #936).
//
// Playwright's native `--shard=i/N` splits the test list by COUNT, ignoring
// per-spec runtime, so the heavy real-LLM specs pile onto one shard that then
// runs ~2x longer than the others against the single serialized Langflow
// backend — the load-induced-timeout root cause tracked in #773. This script
// instead partitions the @stable spec FILES into N balanced groups using their
// historical durations (LPT / longest-processing-time-first greedy bin-packing).
//
// Two roles, one self-feeding loop across a daily run:
//   extract  — after a daily, read the merged results.json and emit
//              reports/spec-durations.json (file -> seconds). Committed back to
//              main by the merge job, same machinery as reports/daily-history.jsonl.
//
// ## The loop never closed, and that is what #1252 fixes
//
// `extract` used to require a FULLY GREEN daily (`needs.test.result == 'success'`),
// on the sound reasoning that a red run's times are distorted by retries and
// timeouts and would poison the next partition. What that missed is that this suite
// has 1–10 hard failures on a normal day, so the gate was not strict — it was
// CLOSED. `reports/spec-durations.json` was never committed once: in the six
// scheduled dailies between the mechanism shipping (#936, 2026-07-24) and #1252,
// zero qualified, and across the whole 23-entry history only 2026-07-03 ever had
// `failed: 0` — three weeks before the file existed. So every daily ran
// `mode=count` (verified in run 30809091241: `partition: 171 @stable files -> 4
// shards (mode=count)`), and one red spec out of 430 discarded 429 valid
// measurements.
//
// The fix keeps the reasoning and drops the all-or-nothing: a file contributes its
// duration only when EVERY @stable test in it came back `expected` — Playwright's
// own word for "passed without needing a retry" — and any other file CARRIES
// FORWARD its previous value instead of being dropped. So the table converges from
// any real run rather than waiting for a perfect day, and a distorted number still
// never enters it.
//
// Two exclusions matter as much as the retry one:
//   - `flaky` (passed on retry) is excluded for the original reason: the recorded
//     time includes the failed attempts.
//   - `skipped` is excluded because it is FAST, not cheap. A file whose specs all
//     skipped (an inactive provider — routine here, #570/#1029) would record ~0 s
//     and then ride free onto whatever shard is heaviest. That hazard exists under
//     the old green-only gate too: a green run still skips.
//   matrix   — at "Prepare shard matrix" time, read the current @stable file set
//              (from `playwright test --grep @stable --list --reporter=json`) and
//              the committed durations, then print the GitHub Actions matrix with
//              an explicit file list per shard.
//
// Cold start / new specs: a file with no recorded duration is weighted at the
// median of the known durations (never 0, which would let it ride free onto a
// heavy shard). With NO durations at all, every file weighs 1 → the partition
// degrades gracefully to a file-COUNT balance, still better than a test-count split.
//
// Pure, dependency-free ESM so the prep job runs it with plain `node` (no ts-node).
// Unit tests: scripts/partition-shards.test.mjs (node --test).

import fs from "node:fs";

/**
 * Walk a Playwright JSON report (nested suites -> specs) and collect the unique
 * spec files that carry at least one @stable spec. Tags on the spec are stored
 * without the leading "@" (e.g. "stable").
 * @param {any} report
 * @returns {string[]}
 */
export function stableFilesFromReport(report) {
  const files = new Set();
  const walk = (suite, inherited) => {
    const file = suite.file || inherited;
    for (const spec of suite.specs || []) {
      if ((spec.tags || []).includes("stable")) files.add(spec.file || file);
    }
    for (const child of suite.suites || []) walk(child, file);
  };
  for (const s of report.suites || []) walk(s, s.file);
  return [...files];
}

/**
 * Sum every attempt's duration (ms) of every @stable spec, grouped by file, and
 * return seconds per file. Retries are intentionally included: they are the real
 * wall-clock cost the file imposes on its worker.
 * @param {any} report
 * @returns {Record<string, number>}
 */
export function stableDurationsByFile(report) {
  const ms = new Map();
  const walk = (suite, inherited) => {
    const file = suite.file || inherited;
    for (const spec of suite.specs || []) {
      if (!(spec.tags || []).includes("stable")) continue;
      const key = spec.file || file;
      let d = 0;
      for (const t of spec.tests || []) for (const r of t.results || []) d += r.duration || 0;
      ms.set(key, (ms.get(key) || 0) + d);
    }
    for (const child of suite.suites || []) walk(child, file);
  };
  for (const s of report.suites || []) walk(s, s.file);
  const out = {};
  for (const [k, v] of ms) out[k] = Math.round((v / 1000) * 10) / 10; // seconds, 1 dp
  return out;
}

/**
 * Which @stable files of a report carry a duration worth recording, and why the
 * others do not (#1252).
 *
 * A file is usable only when every @stable test in it has `status === "expected"`.
 * That is the reporter's own vocabulary, so the retry rule is not re-derived here:
 * `flaky` already means "passed, but a retry paid for it", and its recorded time
 * includes the failed attempts. `unexpected` is a failure and `skipped` measures
 * nothing.
 *
 * The reason is returned per file rather than just a boolean because the caller
 * prints it: a file silently absent from the table looks identical to a file that
 * was never selected (#1012).
 *
 * @param {any} report
 * @returns {{usable: Record<string, number>, excluded: {file: string, reason: string}[]}}
 */
export function classifyDurations(report) {
  const perFile = new Map(); // file -> { seconds, reasons:Set }
  const walk = (suite, inherited) => {
    const file = suite.file || inherited;
    for (const spec of suite.specs || []) {
      if (!(spec.tags || []).includes("stable")) continue;
      const key = spec.file || file;
      const entry = perFile.get(key) || { ms: 0, reasons: new Set() };
      for (const t of spec.tests || []) {
        // An absent status is UNDECIDABLE, not a pass. Reading it as one is how a
        // report-shape change would silently start recording distorted numbers.
        if (t.status !== "expected") entry.reasons.add(t.status ?? "unknown status");
        for (const r of t.results || []) entry.ms += r.duration || 0;
      }
      perFile.set(key, entry);
    }
    for (const child of suite.suites || []) walk(child, file);
  };
  for (const s of report.suites || []) walk(s, s.file);

  /** @type {Record<string, number>} */
  const usable = {};
  /** @type {{file: string, reason: string}[]} */
  const excluded = [];
  for (const [file, { ms, reasons }] of perFile) {
    if (reasons.size === 0) {
      usable[file] = Math.round((ms / 1000) * 10) / 10; // seconds, 1 dp
      continue;
    }
    excluded.push({ file, reason: [...reasons].sort().join(", ") });
  }
  return { usable, excluded: excluded.sort((a, b) => (a.file < b.file ? -1 : 1)) };
}

/**
 * The next `spec-durations.json` table: this run's clean measurements, with every
 * other CURRENT @stable file carrying its previous value forward (#1252).
 *
 * Scoped to the files the report actually contains, so a spec that was deleted or
 * lost its `@stable` tag drops out instead of accumulating forever — which is what
 * the old full-replacement `extract` got right and a naive merge would lose.
 *
 * A file that is neither usable nor previously known is simply absent, and that is
 * correct: `buildShards` weights an unknown file at the median of the known ones,
 * which is a better guess than a number measured under a retry.
 *
 * @param {any} report
 * @param {Record<string, number>} previous  the committed table, or {}
 * @returns {{durations: Record<string, number>, recorded: string[], carried: string[], unknown: string[], excluded: {file: string, reason: string}[]}}
 */
export function refreshDurations(report, previous = {}) {
  const { usable, excluded } = classifyDurations(report);
  const files = stableFilesFromReport(report);

  /** @type {Record<string, number>} */
  const durations = {};
  const recorded = [];
  const carried = [];
  const unknown = [];
  for (const file of files.sort()) {
    if (typeof usable[file] === "number") {
      durations[file] = usable[file];
      recorded.push(file);
    } else if (typeof previous[file] === "number") {
      durations[file] = previous[file];
      carried.push(file);
    } else {
      unknown.push(file);
    }
  }
  return { durations, recorded, carried, unknown, excluded };
}

function median(nums) {
  if (nums.length === 0) return 1;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Partition files into N shards balanced by weight using LPT greedy bin-packing:
 * sort files heaviest-first, then repeatedly drop the next file onto the shard
 * with the smallest running load. Ties (equal weight) break by filename, and
 * ties in shard load break by lowest shard index, so the output is deterministic.
 *
 * @param {string[]} files       spec files to distribute
 * @param {Record<string, number>} durations  file -> seconds (may be partial/empty)
 * @param {number} n             shard count
 * @returns {{shard:number, files:string[]}[]}
 */
export function buildShards(files, durations, n) {
  const known = files.map((f) => durations[f]).filter((v) => typeof v === "number");
  const fallback = known.length ? median(known) : 1;
  const weightOf = (f) => (typeof durations[f] === "number" ? durations[f] : fallback);

  const sorted = [...files].sort((a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0));

  const bins = Array.from({ length: n }, (_, i) => ({ shard: i + 1, files: [], load: 0 }));
  for (const f of sorted) {
    let best = bins[0];
    for (const b of bins) if (b.load < best.load) best = b;
    best.files.push(f);
    best.load += weightOf(f);
  }
  return bins.map(({ shard, files }) => ({ shard, files }));
}

// ---- CLI -------------------------------------------------------------------

function readJSON(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function main(argv) {
  const [cmd, ...rest] = argv;

  if (cmd === "extract") {
    // extract <results.json> [previous.json]  ->  { version, durations }  on stdout
    //
    // `previous.json` is the COMMITTED table. It may be absent (cold start) or "-".
    // Passing it is what makes a partial refresh safe: files this run could not
    // measure cleanly keep the number they already had instead of vanishing, which
    // is the whole reason the green-only gate can be dropped (#1252).
    const [resultsPath, prevPath] = rest;
    if (!resultsPath)
      throw new Error("usage: partition-shards.mjs extract <results.json> [previous.json]");
    let previous = {};
    if (prevPath && prevPath !== "-" && fs.existsSync(prevPath)) {
      previous = readJSON(prevPath).durations || {};
    }
    const { durations, recorded, carried, unknown, excluded } = refreshDurations(
      readJSON(resultsPath),
      previous,
    );

    // The accounting goes to STDERR so stdout stays the file. Printed always, not
    // only when something is wrong: "the table did not change today" and "the
    // refresh never ran" have to look different in the log (#1012).
    const lines = [
      `durations: ${Object.keys(durations).length} file(s) in the table ` +
        `(${recorded.length} measured now, ${carried.length} carried forward, ` +
        `${unknown.length} still unknown; previous table had ${Object.keys(previous).length})`,
    ];
    if (excluded.length) {
      lines.push(`  excluded from measurement (kept previous value where one exists):`);
      for (const { file, reason } of excluded) lines.push(`    ${file} — ${reason}`);
    }
    if (unknown.length) {
      lines.push(
        `  no duration at all yet (weighted at the median of the known files):`,
        ...unknown.map((f) => `    ${f}`),
      );
    }
    process.stderr.write(lines.join("\n") + "\n");
    process.stdout.write(JSON.stringify({ version: 1, durations }, null, 2) + "\n");
    return;
  }

  if (cmd === "matrix") {
    // matrix <list.json> <spec-durations.json|-> <N>  ->  { shard_total, include:[{shard,files}] }
    // <list.json>  is the output of `playwright test --grep @stable --list --reporter=json`.
    // <spec-durations.json> may be "-" or a missing path (cold start) -> empty durations.
    const [listPath, durPath, nRaw] = rest;
    const n = Number(nRaw || 4);
    if (!listPath || !Number.isInteger(n) || n < 1)
      throw new Error("usage: partition-shards.mjs matrix <list.json> <durations.json|-> <N>");

    const files = stableFilesFromReport(readJSON(listPath));
    let durations = {};
    const expected = !!durPath && durPath !== "-";
    const present = expected && fs.existsSync(durPath);
    if (present) {
      durations = readJSON(durPath).durations || {};
    }

    const shards = buildShards(files, durations, n);
    const include = shards.map((s) => ({ shard: s.shard, files: s.files.join(" ") }));
    const mode = Object.keys(durations).length ? "duration" : "count";
    process.stderr.write(
      `partition: ${files.length} @stable files -> ${n} shards (mode=${mode})\n` +
        shards.map((s) => `  shard ${s.shard}: ${s.files.length} files`).join("\n") +
        "\n",
    );
    // `mode=count` was already printed before #1252 and nobody read it as a problem —
    // which is how the daily ran a cold start every day for weeks while the log
    // truthfully said so. A caller that ASKED for a duration table and got none is a
    // different event from a caller that passed "-", so only the first is flagged, and
    // it is flagged as a `::warning::` because that is what surfaces in the job
    // summary rather than scrolling past in step output.
    if (expected && mode === "count") {
      const why = present
        ? `${durPath} exists but contains no durations`
        : `${durPath} does not exist`;
      process.stderr.write(
        `::warning::Shard partition fell back to a FILE-COUNT balance: ${why}. The ` +
          `heavy real-LLM specs can pile onto one shard, which is the load-induced ` +
          `timeout #936 exists to prevent. The table is refreshed by the daily's ` +
          `"Refresh spec durations" step and committed to main; if this persists, that ` +
          `step is not running (#1252).\n`,
      );
    }
    process.stdout.write(JSON.stringify({ shard_total: n, mode, include }) + "\n");
    return;
  }

  throw new Error(`unknown command '${cmd || ""}'. use: extract | matrix`);
}

// Run only when invoked directly (not when imported by the test file).
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  }
}
