#!/usr/bin/env node
// Backfill the `backend` block onto run-history lines already written (#1077).
//
// WHY IT EXISTS, AND WHY IT IS COMMITTED RATHER THAN RUN AS A ONE-OFF. The wedge
// this repo has been measuring since #1030 is recorded into the per-shard
// `liveness-N` artifacts, uploaded with `retention-days: 7`. #1077's first
// *Done when* asks for a baseline of ≥2 consecutive dailies with every shard
// measured; on 2026-09-02 five consecutive scheduled dailies satisfied it and
// three older ones had already expired. Waiting for the field to accumulate
// forward would have thrown that baseline away — including 2026-08-27, the one
// run in the window that measured ZERO outages on all four shards while
// executing every test, which is the control the benchmark most needs.
//
// It builds the block through `scripts/lib/backend-history.mjs` — the SAME
// function the appender calls — so a backfilled row cannot differ in shape from
// a live one. That is the property that makes hand-repair unnecessary and this
// script preferable to editing the file, which `CLAUDE.md` forbids outright.
//
// Every other line is passed through as its original BYTES: only a line whose
// run_id was asked for is re-serialised, so the diff is exactly the rows named.
//
// Usage:
//   node scripts/backfill-backend-history.mjs \
//     --history reports/daily-history.jsonl \
//     --artifacts <dir> \
//     --shard-total <n> \
//     [--dry-run]
//
// `<dir>` holds one subdirectory per run id, laid out as the run's artifacts
// download:  <dir>/<run_id>/liveness-N/backend-liveness.json
//            <dir>/<run_id>/results.json          (the merged Playwright JSON)
// Obtain it with, per run:
//   gh run download <run_id> --repo <owner/repo> -n liveness-N -D <dir>/<run_id>/liveness-N
//   gh run download <run_id> --repo <owner/repo> -n playwright-json-daily-<run_id> -D <dir>/<run_id>
import fs from "node:fs";
import path from "node:path";
import { buildBackendBlock } from "./lib/backend-history.mjs";
import { readSummaries } from "./report-backend-outages.mjs";

// Accepts both `--flag value` and `--flag=value`. The `=` form used to fall
// through to the fallback silently, which for `--shard-total=6` meant writing
// the DEFAULT while the refusal below reported a number the caller never typed.
function arg(name, fallback = null) {
  const argv = process.argv;
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return fallback;
}

const historyPath = arg("history", "reports/daily-history.jsonl");
const artifactsDir = arg("artifacts");
const dryRun = process.argv.includes("--dry-run");

if (!artifactsDir) {
  console.error("--artifacts <dir> is required.");
  process.exit(2);
}

// REQUIRED, and parsed strictly. It used to default to 4 — a guess about runs
// the caller may not have checked, and `shard_total` is the one field whose
// entire purpose is making a shard that uploaded NOTHING visible. A 2-shard
// repro backfilled under that default records `shards_reported: 2` against
// `shard_total: 4`, which reads as "two shards died" forever, and the
// `shards_reported > shard_total` refusal below cannot see it — it only catches
// the excess. An unparseable value is refused for the sharper version of the
// same reason: `Number("abc") || null` yielded `null`, which SHORT-CIRCUITS that
// refusal and writes the state this file's own comments call the one that makes
// a silent shard undetectable.
const shardTotalRaw = arg("shard-total");
if (shardTotalRaw === null) {
  console.error("--shard-total <n> is required — the run's real shard count, not a guess.");
  process.exit(2);
}
const shardTotal = Number(shardTotalRaw);
if (!Number.isInteger(shardTotal) || shardTotal < 1) {
  console.error(`--shard-total must be a positive integer; got "${shardTotalRaw}".`);
  process.exit(2);
}

const runDirs = fs
  .readdirSync(artifactsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

if (!runDirs.length) {
  // A backfill that silently rewrites nothing is indistinguishable from one that
  // worked, which is the failure mode #1012 exists about.
  console.error(`No run directories under ${artifactsDir}.`);
  process.exit(2);
}

const blocks = new Map();
for (const runId of runDirs) {
  const dir = path.join(artifactsDir, runId);
  // Unfiltered on purpose: `buildBackendBlock` rejects non-summary JSON itself
  // (and says how many it dropped), so the live appender and this script cannot
  // disagree about what counts as a shard. This script used to carry its own
  // copy of that filter while the appender carried none — the hardening was on
  // the ad-hoc path and missing from the one that runs unattended forever.
  const summaries = readSummaries(dir);
  const reportPath = path.join(dir, "results.json");
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
    : null;
  if (!report) {
    // Without the merged report the per-shard test counts and the collateral
    // attribution are unavailable, and a block missing half its axes is worse
    // than no block: it would read as a measured run with nothing to show.
    console.error(`run ${runId}: results.json missing — refusing to write a partial block.`);
    process.exit(1);
  }
  const block = buildBackendBlock(summaries, report, shardTotal);
  if (!block) {
    console.error(`run ${runId}: no liveness summary found — nothing to backfill.`);
    process.exit(1);
  }
  // `--shard-total` is one value for the whole invocation, and its default is a
  // guess about runs the caller may not have checked. `shard_total` is the one
  // field whose entire purpose is making a shard that uploaded NOTHING visible,
  // so a wrong value there is worse than an absent one: more summaries than the
  // declared count means the declaration is wrong, and writing it anyway would
  // record a permanent lie in the direction nothing else can detect.
  if (block.shard_total !== null && block.shards_reported > block.shard_total) {
    console.error(
      `run ${runId}: ${block.shards_reported} shard summaries but --shard-total ${block.shard_total}.` +
        " Pass the run's real shard count.",
    );
    process.exit(1);
  }
  blocks.set(runId, block);
}

if (!fs.existsSync(historyPath)) {
  // A raw ENOENT stack here points at `node:fs` rather than at the typo in
  // `--history`, and this script's whole job is not to damage that file.
  console.error(`History file not found at ${historyPath}.`);
  process.exit(2);
}
const lines = fs.readFileSync(historyPath, "utf8").split("\n");
const seen = new Set();
const out = lines.map((line) => {
  if (!line.trim()) return line;
  const row = JSON.parse(line);
  const block = blocks.get(String(row.run_id));
  if (!block) return line; // untouched, byte for byte
  if (row.backend) {
    console.error(`run ${row.run_id}: already carries a backend block — refusing to overwrite.`);
    process.exit(1);
  }
  seen.add(String(row.run_id));
  return JSON.stringify({ ...row, backend: block });
});

const missing = [...blocks.keys()].filter((id) => !seen.has(id));
if (missing.length) {
  console.error(`No history line for run(s): ${missing.join(", ")}.`);
  process.exit(1);
}

for (const id of seen) {
  const b = blocks.get(id);
  console.log(
    `run ${id}: outages=${b.outages_total} down=${b.down_seconds_total}s ` +
      `shards_measured=${b.shards_measured}/${b.shard_total ?? "?"}`,
  );
}

if (dryRun) {
  console.log(`[dry-run] ${seen.size} line(s) would be rewritten in ${historyPath}.`);
} else {
  fs.writeFileSync(historyPath, out.join("\n"));
  console.log(`${seen.size} line(s) rewritten in ${historyPath}.`);
}
