#!/usr/bin/env node
/**
 * Selects the dedicated-issue numbers a `since`-window contract sweep must check.
 *
 * Why this is a script and not three lines of `jq` inside the action (#1037):
 * the sweep runs as an inline post-step of `triage-dispatch.yml`'s `execute` job
 * with `continue-on-error: true` — report, never block — so a window that selects
 * **nothing** produces a green job and one indistinguishable log line. `checked=0`
 * and "everything was fine" read identically. That path only fires on a `pode
 * abrir` comment on an umbrella, which itself needs a red daily plus a human, so
 * the selection could not be proven before merge and #1037 was opened to remember
 * to look. Extracting it makes the window provable by `npm run test:scripts` on
 * every PR instead of waiting for that coincidence.
 *
 * Pure by design: it takes the issue list on stdin and never calls the network, so
 * the tests exercise the real comparison instead of a mock of it.
 *
 * Run:
 *   gh issue list --label daily-failure --state all --limit 100 \
 *     --json number,createdAt,title \
 *   | node scripts/select-dedicated-issues.mjs --since 2026-07-30T11:34:36Z
 *
 * Output (stdout, JSON):
 *   {
 *     selected: number[],     // issue numbers at or after `since`
 *     scanned: number,        // how many the caller handed over
 *     inWindow: number,       // selected.length, i.e. what the sweep will check
 *     oldestScanned: string,  // so a truncated page is visible, not assumed away
 *     truncated: boolean,     // scanned === limit ⇒ older issues may be missing
 *     warnings: string[],     // human-readable, one per condition worth surfacing
 *   }
 */

const HELP = `usage: select-dedicated-issues.mjs --since <iso8601> [--limit <n>] [--json-file <path>]

  --since      ISO-8601 timestamp, e.g. 2026-07-30T11:34:36Z (required)
  --limit      the --limit the caller passed to \`gh issue list\`, used to detect a
               truncated page (default 100)
  --json-file  read the issue list from a file instead of stdin (tests, debugging)
`;

/**
 * The timestamp comparison the sweep depends on.
 *
 * `gh` emits `createdAt` as `2026-07-30T11:37:49Z` and the workflow stamps `since`
 * with `date -u … +%Y-%m-%dT%H:%M:%SZ`, so a plain string `>=` happens to be
 * correct today — and silently wrong the day either side changes format (an offset
 * of `+00:00`, fractional seconds, a local-time stamp). Comparing parsed instants
 * removes that dependency entirely: same answer for the formats that agree, right
 * answer for the ones that do not.
 */
export function isAtOrAfter(createdAt, since) {
  const a = Date.parse(createdAt);
  const b = Date.parse(since);
  if (Number.isNaN(a) || Number.isNaN(b)) return null; // unparseable → caller decides
  return a >= b;
}

export function selectDedicatedIssues(issues, { since, limit = 100 } = {}) {
  if (!since || Number.isNaN(Date.parse(since))) {
    throw new Error(`select-dedicated-issues: --since is missing or not a parseable timestamp: ${JSON.stringify(since)}`);
  }
  const list = Array.isArray(issues) ? issues : [];
  const warnings = [];
  const selected = [];
  let unparseable = 0;

  for (const issue of list) {
    const verdict = isAtOrAfter(issue?.createdAt, since);
    if (verdict === null) {
      unparseable += 1;
      continue;
    }
    if (verdict) selected.push(issue.number);
  }

  const timestamps = list
    .map((i) => i?.createdAt)
    .filter((t) => typeof t === "string" && !Number.isNaN(Date.parse(t)))
    .sort();
  const oldestScanned = timestamps[0] ?? null;

  // A full page only threatens coverage when the window could reach PAST it: if
  // the oldest issue scanned predates `since`, the page demonstrably spans the
  // whole window and the page size is irrelevant. Warning on a full page alone
  // would fire on every run — the label has 114 issues and grows — and a warning
  // that always fires stops being read.
  const pageFull = list.length >= limit;
  const windowReachesPastPage =
    oldestScanned === null || isAtOrAfter(oldestScanned, since) === true;
  const truncated = pageFull && windowReachesPastPage;
  if (truncated) {
    warnings.push(
      `the issue page is full (${list.length} of --limit ${limit}) AND its oldest issue (${oldestScanned ?? "n/a"}) is still inside the window, so older in-window issues may not have been scanned. Raise --limit.`,
    );
  }
  if (unparseable > 0) {
    warnings.push(
      `${unparseable} issue(s) had an unparseable createdAt and were NOT selected — the sweep cannot vouch for them.`,
    );
  }
  // The condition #1037 exists for. Zero selected is legitimate when the triage
  // created nothing, and a broken window looks exactly the same, so it is reported
  // as a condition to check rather than passed over in silence.
  if (selected.length === 0) {
    warnings.push(
      `NOTHING selected for since=${since}. Either the triage created no dedicated issue, or the window is wrong — these are indistinguishable here. Confirm against the issues the run actually created before reading this as a pass (#1037).`,
    );
  }

  return {
    selected,
    scanned: list.length,
    inWindow: selected.length,
    oldestScanned,
    truncated,
    warnings,
  };
}

function parseArgs(argv) {
  const args = { limit: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--since") args.since = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--json-file") args.jsonFile = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`select-dedicated-issues: unknown argument ${arg}`);
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Executed directly (not imported by the tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const raw = args.jsonFile
    ? (await import("node:fs")).readFileSync(args.jsonFile, "utf8")
    : await readStdin();

  let issues;
  try {
    issues = JSON.parse(raw || "[]");
  } catch (error) {
    // Fail loud: an unreadable list must never degrade into "nothing to check".
    process.stderr.write(
      `::error::select-dedicated-issues could not parse the issue list (${error.message}). Treating as a guard failure, not an empty sweep.\n`,
    );
    process.exit(2);
  }

  let result;
  try {
    result = selectDedicatedIssues(issues, { since: args.since, limit: args.limit });
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exit(2);
  }

  // Human-readable on stderr so the step log shows the mechanics; machine-readable
  // on stdout for the caller.
  process.stderr.write(
    `since=${args.since}: scanned ${result.scanned} daily-failure issue(s) (oldest ${result.oldestScanned ?? "n/a"}), ${result.inWindow} in window.\n`,
  );
  for (const warning of result.warnings) {
    process.stderr.write(`::warning::${warning}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
