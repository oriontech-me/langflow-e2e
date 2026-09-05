#!/usr/bin/env node
// Compare one day's verdict from the Actions daily against the VM daily.
//
// This is the instrument for step 14 of the VM migration: while both dailies run,
// the product of the stage is the classified list of differences between them.
// Doing that by eye against two reports is how a difference gets missed on the day
// nobody had time, so it is a script, and it runs on the machine that holds the
// ledger.
//
// Usage:
//   node scripts/compare-lane-verdicts.mjs                      # newest day both lanes recorded
//   node scripts/compare-lane-verdicts.mjs --date 2026-09-07
//   node scripts/compare-lane-verdicts.mjs --history <path> --json
//
// Options:
//   --history <path>   JSONL to read; repeatable. Default: BOTH the VM ledger and the
//                      tracked reports/daily-history.jsonl, merged — the two lanes do
//                      not share a file (see mergeEntries). Every path read is
//                      printed, because reading the wrong series in silence is the
//                      failure this whole lane keeps finding in itself.
//   --date <YYYY-MM-DD>  Compare that day instead of the newest complete one.
//   --ci-workflow / --vm-workflow  Override the two `workflow` ids.
//   --json             Emit the full result as JSON instead of the readable report.
//   --allow-version-mismatch
//                      Compare anyway when the two lanes tested different Langflow
//                      versions. The report and the JSON are STAMPED with the
//                      mismatch, because the list then contains product differences.
//
// Exit codes - a divergence is the EXPECTED product here, so it is not an error:
//   0  a comparison was produced (with or without divergences)
//   1  the two rows could not be compared; the reasons are printed
//   2  usage error

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseHistory,
  mergeEntries,
  selectRuns,
  compareRuns,
  renderReport,
  DEFAULT_CI_WORKFLOW,
  DEFAULT_VM_WORKFLOW,
} from "./lib/lane-verdict-diff.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every file that can hold a row, because no single file holds both lanes.
 *
 * The VM writes OUTSIDE the clone (the ledger) — `reports/` is tracked, and a line
 * written there leaves the tree dirty and breaks the wrapper's next
 * `git pull --ff-only`. The Actions daily commits its row INTO that tracked file every
 * morning. The ledger is seeded from the tracked file exactly once, so it is a
 * superset for one moment and then drifts: reading it alone finds no recent day with
 * both lanes, and reading the tracked file alone finds no VM row ever.
 *
 * So: both, merged. LEDGER_DIR is honoured first among the ledger candidates, and not
 * as a courtesy — run-e2e.sh calls it "the one knob a machine ever needs", so a
 * machine that sets it writes the VM rows there and nowhere else.
 */
export function defaultHistorySources(env = process.env, exists = existsSync) {
  const out = [];
  const ledgerCandidates = [];
  if (env.LEDGER_DIR) ledgerCandidates.push(join(env.LEDGER_DIR, "daily-history.jsonl"));
  const home = env.XDG_STATE_HOME || (env.HOME ? join(env.HOME, ".local", "state") : null);
  if (home) ledgerCandidates.push(join(home, "langflow-e2e", "daily-history.jsonl"));
  for (const c of ledgerCandidates) {
    if (exists(c)) {
      out.push(c);
      break;
    }
  }
  const tracked = join(REPO_ROOT, "reports", "daily-history.jsonl");
  if (exists(tracked)) out.push(tracked);
  // Never an empty list: an absent tracked file still has to be NAMED in the error, so
  // the reader learns which path was wrong rather than that "nothing was found".
  return out.length ? out : [tracked];
}

export function parseArgs(argv) {
  const opts = {
    history: [],
    date: null,
    ciWorkflow: DEFAULT_CI_WORKFLOW,
    vmWorkflow: DEFAULT_VM_WORKFLOW,
    json: false,
    allowVersionMismatch: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--history") opts.history.push(need());
    else if (a === "--date") opts.date = need();
    else if (a === "--ci-workflow") opts.ciWorkflow = need();
    else if (a === "--vm-workflow") opts.vmWorkflow = need();
    else if (a === "--json") opts.json = true;
    else if (a === "--allow-version-mismatch") opts.allowVersionMismatch = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown option: ${a}`);
  }
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${opts.date}"`);
  }
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n") + "\n");
    return 0;
  }

  // A --json caller gets JSON on every path it can reach, including the ones that
  // fail. Exiting 1 with prose on stdout hands a machine consumer nothing it can
  // parse, and "the output was empty" is the least useful way to learn a path is
  // wrong.
  const failure = (message, extra = {}) => {
    if (opts.json) process.stdout.write(JSON.stringify({ error: message, ...extra }, null, 2) + "\n");
    process.stderr.write(message + "\n");
    return 1;
  };

  const paths = opts.history.length ? opts.history : defaultHistorySources();
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length === paths.length) {
    return failure(
      `no history at ${paths.join(", ")} - pass --history, or run this on the machine that keeps the ledger.`,
      { sources: paths },
    );
  }
  for (const m of missing) process.stderr.write(`warning: no history at ${m}, skipped\n`);

  const read = paths.filter((p) => existsSync(p));
  const sources = read.map((p) => {
    const { entries, bad } = parseHistory(readFileSync(p, "utf8"));
    for (const b of bad) {
      process.stderr.write(`warning: ${p}:${b.line} is not JSON and was left out (${b.reason})\n`);
    }
    return { path: p, entries };
  });
  const entries = mergeEntries(sources);

  const selected = selectRuns(entries, {
    date: opts.date,
    ciWorkflow: opts.ciWorkflow,
    vmWorkflow: opts.vmWorkflow,
  });

  if (!selected.date) {
    return failure(
      `${read.join(", ")} hold no row for either lane (${opts.ciWorkflow}, ${opts.vmWorkflow}).`,
      { sources: read },
    );
  }

  const result = compareRuns({
    ...selected,
    ciWorkflow: opts.ciWorkflow,
    vmWorkflow: opts.vmWorkflow,
    allowVersionMismatch: opts.allowVersionMismatch,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ sources: read, ...result }, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(result, { sources: read }) + "\n");
    if (!result.comparable && selected.datesAvailable.length) {
      process.stderr.write(
        `\nDates present in this series: ${selected.datesAvailable.join(", ")}\n`,
      );
    }
  }
  return result.comparable ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)));
}
