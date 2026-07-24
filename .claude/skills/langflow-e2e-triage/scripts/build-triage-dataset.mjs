#!/usr/bin/env node
// Thin I/O wrapper around lib/triage-core.mjs. Reads the daily history, fetches
// the daily-failure issues via gh, assembles the normalized triage dataset, and
// prints it as JSON. No judgment lives here — see lib/triage-core.mjs.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseHistory, buildDataset } from './lib/triage-core.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const historyPath = arg('--history', 'reports/daily-history.jsonl');
const resultsPath = arg('--results', null);
const windowRaw = Number(arg('--window', '30'));
const windowDays = Number.isFinite(windowRaw) ? windowRaw : 30;
const runId = arg('--run', null);

// Daily-failure issues (open + closed) — the umbrella may already be closed.
function fetchIssues() {
  try {
    const out = execFileSync('gh', [
      'issue', 'list', '--label', 'daily-failure', '--state', 'all',
      '--limit', '50', '--json', 'number,title,body',
    ], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    process.stderr.write(`warning: gh issue list failed (${e.message}); umbrella will be null\n`);
    return [];
  }
}

// Per-skip detail from a local Playwright results.json, if provided. Best effort.
function readSkips(path) {
  if (!path) return [];
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const skips = [];
    const walk = (suite) => {
      for (const s of suite.suites || []) walk(s);
      for (const spec of suite.specs || []) {
        for (const t of spec.tests || []) {
          const status = t.results?.[t.results.length - 1]?.status;
          if (status === 'skipped') {
            const reason = t.annotations?.find((a) => a.type === 'skip')?.description || '';
            skips.push({ test: spec.title, file: suite.file || '', reason });
          }
        }
      }
    };
    for (const s of report.suites || []) walk(s);
    return skips;
  } catch (e) {
    process.stderr.write(`warning: could not read results.json (${e.message}); skips omitted\n`);
    return [];
  }
}

// Build a `${test}\0${file}` → param map from a local Playwright results.json,
// walking the suite path exactly as the history appender does. Used to backfill
// the `param` (provider variant) on runs whose history predates #899's appender
// change, so a re-run against an old artifact still surfaces provider clusters.
function readParamMap(path) {
  const map = new Map();
  if (!path) return map;
  try {
    const report = JSON.parse(readFileSync(path, 'utf8'));
    const paramOf = (suitePath) => {
      for (let i = suitePath.length - 1; i >= 0; i--) {
        const m = /\[([^\]]+)\]/.exec(suitePath[i] || '');
        if (m) return m[1].trim();
      }
      return null;
    };
    const walk = (suite, sp) => {
      const path2 = suite.title ? [...sp, suite.title] : sp;
      const param = paramOf(path2);
      for (const spec of suite.specs || []) {
        if (param) map.set(`${spec.title}\0${suite.file || spec.file || ''}`, param);
      }
      for (const s of suite.suites || []) walk(s, path2);
    };
    for (const s of report.suites || []) walk(s, []);
  } catch (e) {
    process.stderr.write(`warning: could not read results.json for params (${e.message})\n`);
  }
  return map;
}

const rows = parseHistory(readFileSync(historyPath, 'utf8'));

// Backfill `param` on history entries from a supplied results.json (best effort).
const paramMap = readParamMap(resultsPath);
if (paramMap.size > 0) {
  for (const row of rows) {
    for (const e of [...(row.failures || []), ...(row.flaky || [])]) {
      if (!e.param) {
        const p = paramMap.get(`${e.test}\0${e.file}`);
        if (p) e.param = p;
      }
    }
  }
}

const dataset = buildDataset(rows, fetchIssues(), { windowDays, runId });
if (!dataset) {
  process.stderr.write(
    runId
      ? `Run ${runId} not found in history — nothing to triage.\n`
      : 'No red run found in history — nothing to triage.\n',
  );
  process.exit(2);
}
dataset.skips = readSkips(resultsPath);
if (dataset.stale_history) {
  const s = dataset.stale_history;
  process.stderr.write(
    `warning: history may be stale — umbrella #${s.newest_umbrella} for ${s.newest_umbrella_date} is newer than the latest history run (${s.history_latest_date}). Run 'git pull' on main to refresh reports/daily-history.jsonl.\n`,
  );
}
process.stdout.write(JSON.stringify(dataset, null, 2) + '\n');
