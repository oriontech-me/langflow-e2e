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
const windowDays = Number(arg('--window', '30'));

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

const rows = parseHistory(readFileSync(historyPath, 'utf8'));
const dataset = buildDataset(rows, fetchIssues(), { windowDays });
if (!dataset) {
  process.stderr.write('No red run found in history — nothing to triage.\n');
  process.exit(2);
}
dataset.skips = readSkips(resultsPath);
process.stdout.write(JSON.stringify(dataset, null, 2) + '\n');
