#!/usr/bin/env node
// Gate the dedicated-issue contract from OUTSIDE the agent that wrote the body.
//
// Phase 7 of the triage skill is told to call renderDedicatedIssueBody() and
// assertDedicatedIssueBody() — but "told to" is not a gate: an agent that
// hand-writes a body, or a human opening the issue without the form, bypasses
// both. This entrypoint is what CI runs against the issue as it actually exists
// on GitHub, so the check cannot be skipped by whoever authored it (#1035).
//
// Deliberately pure: it reads a title and a body and prints a verdict. Selecting
// WHICH issues to check is the workflow's job — that keeps this unit-testable and
// keeps `gh` out of the thing being tested.
//
// Usage:
//   node check-issue-body.mjs --title "<title>" --body-file body.md
//   gh issue view N --json body --jq .body | node check-issue-body.mjs --title "..."
//   ... --json      emit a machine-readable verdict instead of prose
//
// Exit codes: 0 = clean or not subject to the contract; 1 = problems found;
// 2 = bad invocation. Callers that must not fail the job (the report-don't-block
// rule) branch on the code rather than letting it propagate.

import { readFileSync } from 'node:fs';
import { classifyIssueTitle, assertDedicatedIssueBody } from './lib/triage-core.mjs';

/** Minimal flag parser: `--k v` and `--flag`. */
export function parseArgs(argv) {
  const out = { json: false, title: '', bodyFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--title') out.title = argv[++i] ?? '';
    else if (a === '--body-file') out.bodyFile = argv[++i] ?? null;
    else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
  }
  return out;
}

/**
 * The whole decision, as data. Separated from I/O so the tests exercise the
 * verdict rather than the process.
 */
export function checkIssue({ title, body }) {
  const kind = classifyIssueTitle(title);
  if (kind !== 'dedicated') {
    return {
      kind,
      checked: false,
      problems: [],
      reason:
        kind === 'umbrella'
          ? 'umbrella issue — a different contract, created by daily-stable.yml; not validated here'
          : 'not a dedicated per-cause issue (title does not match "[Daily #N] ...") — not validated here',
    };
  }
  return { kind, checked: true, problems: assertDedicatedIssueBody(body), reason: null };
}

/** Markdown for the comment the workflow posts. Kept here so it is tested too. */
export function renderVerdictComment(result, { issueNumber = null } = {}) {
  if (!result.checked || result.problems.length === 0) return null;
  return [
    '### ⚠️ This issue does not meet the dedicated-issue contract',
    '',
    'Opened as a per-cause failure issue, but these fields are missing or malformed:',
    '',
    ...result.problems.map((p) => `- ${p}`),
    '',
    'Nothing was closed or rejected — the report still carries evidence someone needs.',
    'Edit the body to fill the gaps and this check re-runs.',
    '',
    'The contract, and why each field exists, is in',
    '`.claude/skills/langflow-e2e-triage/references/issue-templates.md`.',
    'The triage skill renders a compliant body automatically via',
    '`renderDedicatedIssueBody()` — hand-writing one is what this check exists to catch.',
    ...(issueNumber ? ['', `<!-- dedicated-issue-contract-guard:${issueNumber} -->`] : []),
  ].join('\n');
}

/* c8 ignore start — process wiring, exercised by the workflow rather than tests */
function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(String(e.message));
    return 2;
  }
  if (!args.title) {
    console.error('check-issue-body: --title is required (the contract is selected by title)');
    return 2;
  }
  let body;
  try {
    body = args.bodyFile ? readFileSync(args.bodyFile, 'utf8') : readFileSync(0, 'utf8');
  } catch (e) {
    console.error(`check-issue-body: cannot read the body — ${e.message}`);
    return 2;
  }

  const result = checkIssue({ title: args.title, body });

  if (args.json) {
    console.log(JSON.stringify({ ...result, comment: renderVerdictComment(result) }));
  } else if (!result.checked) {
    console.log(`skipped (${result.kind}): ${result.reason}`);
  } else if (result.problems.length === 0) {
    console.log('ok: body meets the dedicated-issue contract');
  } else {
    console.error(`INVALID: ${result.problems.length} problem(s)`);
    for (const p of result.problems) console.error(`  - ${p}`);
  }
  return result.checked && result.problems.length > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
/* c8 ignore stop */
