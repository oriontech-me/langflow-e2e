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
//   extract  — after a GREEN daily, read the merged results.json and emit
//              reports/spec-durations.json (file -> seconds). Committed back to
//              main by the merge job, same machinery as reports/daily-history.jsonl.
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
    // extract <results.json>  ->  { version, durations: {file: sec} }  on stdout
    const [resultsPath] = rest;
    if (!resultsPath) throw new Error("usage: partition-shards.mjs extract <results.json>");
    const durations = stableDurationsByFile(readJSON(resultsPath));
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
    if (durPath && durPath !== "-" && fs.existsSync(durPath)) {
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
