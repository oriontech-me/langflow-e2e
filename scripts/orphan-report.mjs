#!/usr/bin/env node
// The network half of the stable-orphans routine (ops/vm/run-stable-orphans.sh, #2224):
// what reads the trackers before the reconciler runs, and what publishes its report after.
// The reconciler itself (scripts/reconcile-stable-orphans.ts) is unchanged in what it
// decides; on Actions the workflow did these two jobs with `gh` and `github-script`.
//
//   node scripts/orphan-report.mjs issues <out.json>
//       Every open issue of ONE repository, as the JSON array the reconciler reads with
//       --issues-file, each issue carrying `repo`. Reads ORPHAN_ISSUES_HOST,
//       ORPHAN_ISSUES_REPO and ORPHAN_ISSUES_TOKEN (optional for a public repository).
//       Called once per repository that owns trackers: today the source, where the
//       older dedicated issues live, and the destination, where the VM lane's new ones
//       open. Stage 4 moves the backlog and drops the source from the list.
//
//   node scripts/orphan-report.mjs publish <outputs> <report.json> <state-dir>
//       The report issue on the destination, kept current exactly as the workflow kept
//       it: one issue under the reconciler's fixed title, its body replaced each run,
//       closed with a comment when nothing is left. Then Slack, only for orphans the
//       previous published run did not list. Reads ISSUE_HOST, ISSUE_REPO, GITHUB_TOKEN
//       or GH_TOKEN, and SLACK_WEBHOOK_URL.
//
//       <outputs> is the reconciler's $GITHUB_OUTPUT file, <report.json> its --json.
//       Prints KEY=VALUE lines for the routine's result. Exit 0 when the issue is
//       current (a failed Slack post is SLACK=failed, for the watchdog), 1 when the
//       issue could not be made current, 2 on bad usage.
import { readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { apiUrlFor } from "./create-failure-issue.mjs";
import { TIMEOUT_MS, deliverAlarm } from "./routine-report.mjs";

/**
 * The reconciler's $GITHUB_OUTPUT: `key=value` lines and `key<<DELIM` blocks. PURE.
 * A later key wins, as it does for Actions.
 */
export function parseOutputs(text) {
  const out = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heredoc = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(lines[i]);
    if (heredoc) {
      const [, key, delim] = heredoc;
      const body = [];
      for (i++; i < lines.length && lines[i] !== delim; i++) body.push(lines[i]);
      out[key] = body.join("\n");
      continue;
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(lines[i]);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** One orphan's identity across runs: the reconciler's own key, path and title. */
export const orphanKey = (row) => `${row.relativePath}::${row.title}`;

/** The orphans in `current` that `previous` (keys, or null on a first run) did not list. PURE. */
export function newOrphans(current, previous) {
  const seen = new Set(previous ?? []);
  return current.filter((row) => !seen.has(orphanKey(row)));
}

/**
 * What to do with the report issue. PURE. The two lookups are the workflow's guards: a
 * lookup that could not be made decides nothing, and a body rewrite or a close on one
 * would replace standing findings with a page that says less.
 *   lookup failed            -> untouched
 *   findings    + open       -> refresh
 *   findings    + none       -> create
 *   no findings + open       -> close
 *   no findings + none       -> none
 */
export function issueAction(outputs, openIssue) {
  if (outputs.tracker_lookup_failed !== "false" || outputs.gate_lookup_failed !== "false") return "untouched";
  if (outputs.has_findings === "true") return openIssue ? "refresh" : "create";
  if (outputs.has_findings === "false") return openIssue ? "close" : "none";
  return "untouched";
}

/**
 * The Slack words for new orphans. PURE. On the routine's first run every standing orphan
 * is "new" to it: that is said, rather than passed off as this week's (review of #2225).
 * Deliberate: the report these orphans stood in on the source went unread.
 */
export function slackText(rows, issueUrl, { firstRun = false } = {}) {
  const n = rows.length;
  const headline = firstRun
    ? `@stable: ${n} orphan${n === 1 ? "" : "s"} standing, first report from the VM: test${n === 1 ? "" : "s"} out of the daily that nobody holds`
    : `@stable: ${n} new orphan${n === 1 ? "" : "s"}, a test out of the daily that nobody holds`;
  const list = rows.slice(0, 10).map((r) => `• ${r.title} (\`${r.relativePath}\`)`);
  if (n > 10) list.push(`• and ${n - 10} more`);
  const body = [...list, "", "Restore the tag, open an issue that owns the restore, or declare the absence.", issueUrl ? `Report: ${issueUrl}` : ""]
    .filter((l, i, a) => l || i < a.length - 1)
    .join("\n");
  return { headline, body };
}

const ghHeaders = (token) => ({
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

async function gh(fetchFn, token, method, url, body) {
  const res = await fetchFn(url, { method, headers: ghHeaders(token), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return { data: text ? JSON.parse(text) : {}, link: res.headers?.get?.("link") ?? "" };
}

const nextLink = (link) => /<([^>]+)>;\s*rel="next"/.exec(link ?? "")?.[1] ?? null;

/** Every open issue (pull requests included: the reconciler drops them itself), every page. */
export async function fetchOpenIssues({ fetchFn = fetch, host, repo, token }) {
  const all = [];
  let url = `${apiUrlFor(host, repo)}?state=open&per_page=100`;
  // A cap, so a Link header that never ends cannot hold the routine: 50 pages is 5,000
  // open issues, two orders of magnitude above either repository.
  for (let page = 0; url; page++) {
    if (page >= 50) throw new Error(`more than 50 pages of open issues in ${repo}: refusing a partial list`);
    const { data, link } = await gh(fetchFn, token, "GET", url);
    if (!Array.isArray(data)) throw new Error(`${repo}: the issues endpoint did not answer with a list`);
    all.push(...data);
    url = nextLink(link);
  }
  return all.map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", html_url: i.html_url, pull_request: i.pull_request, repo }));
}

/**
 * Every open report issue under exactly this title, NEWEST first: the workflow refreshed
 * the first the API listed, which is the newest, and a close must close them all, or a
 * duplicate stays open and stale (review of #2225).
 */
async function findReportIssues({ fetchFn, token, host, repo, title }) {
  const open = await fetchOpenIssues({ fetchFn, host, repo, token });
  return open.filter((i) => i.title === title && !i.pull_request).sort((a, b) => b.number - a.number);
}

function readSeen(stateDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(stateDir, "orphans-seen.json"), "utf8"));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSeen(stateDir, keys) {
  mkdirSync(stateDir, { recursive: true });
  const file = join(stateDir, "orphans-seen.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(keys, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/**
 * Publish one run. Returns { ok, fields } and never throws; `fields` are the KEY=VALUE
 * lines for the routine's result. `fetchFn` is injectable so the decisions are tested
 * without a network.
 */
export async function publish({ outputs, report, stateDir, env, fetchFn = fetch }) {
  const fields = {};
  const host = env.ISSUE_HOST;
  const repo = env.ISSUE_REPO;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
  const title = outputs.issue_title;
  const body = outputs.summary_md ?? "";
  if (!host || !repo || !token) {
    return { ok: false, fields: { PUBLISH_ERROR: "ISSUE_HOST, ISSUE_REPO and a token (GITHUB_TOKEN or GH_TOKEN) are all required" } };
  }
  if (!title || !body.trim()) {
    // The workflow's refusal: findings with no title or body would open an empty issue.
    return { ok: false, fields: { PUBLISH_ERROR: "the reconciler emitted no issue title or body" } };
  }

  let issueUrl = "";
  let action;
  try {
    const all = await findReportIssues({ fetchFn, token, host, repo, title });
    const open = all[0] ?? null;
    action = issueAction(outputs, open);
    const base = apiUrlFor(host, repo);
    if (action === "refresh") {
      await gh(fetchFn, token, "PATCH", `${base}/${open.number}`, { body });
      issueUrl = open.html_url;
    } else if (action === "create") {
      const { data } = await gh(fetchFn, token, "POST", base, { title, body });
      issueUrl = data.html_url ?? "";
      // Labelled SEPARATELY and tolerantly, as the workflow did: a label renamed or
      // missing on the destination must not cost the report.
      try {
        await gh(fetchFn, token, "POST", `${base}/${data.number}/labels`, { labels: ["qa-infra"] });
      } catch (e) {
        fields.LABEL_WARNING = `opened without the qa-infra label: ${e.message}`.slice(0, 300);
      }
    } else if (action === "close") {
      for (const issue of all) {
        await gh(fetchFn, token, "POST", `${base}/${issue.number}/comments`, {
          body: [
            "Every `@stable` removal now has an owner, a declaration, or the tag back.",
            "",
            body,
            "",
            "Closing. A new finding opens a fresh issue rather than reopening this one, so the body always describes one reconciliation.",
          ].join("\n"),
        });
        await gh(fetchFn, token, "PATCH", `${base}/${issue.number}`, { state: "closed", state_reason: "completed" });
      }
      issueUrl = open.html_url;
    }
  } catch (e) {
    return { ok: false, fields: { ...fields, ISSUE: action ? `${action}-failed` : "lookup-failed", PUBLISH_ERROR: e.message.slice(0, 300) } };
  }
  fields.ISSUE = issueUrl ? `${action} ${issueUrl}` : action;

  // Slack only for what is new since the last PUBLISHED run, and the list of what was
  // seen moves only once whatever it owed has been said: a post that failed is owed
  // again next week, not dropped.
  if (action === "untouched") {
    fields.SLACK = "none";
    return { ok: true, fields };
  }
  const current = report?.orphans?.orphaned ?? [];
  const seen = readSeen(stateDir);
  const fresh = newOrphans(current, seen);
  fields.NEW_ORPHANS = String(fresh.length);
  if (fresh.length === 0) {
    fields.SLACK = "none";
  } else {
    const { headline, body: text } = slackText(fresh, issueUrl, { firstRun: seen === null });
    const r = await deliverAlarm(headline, text, env, { fetchFn });
    fields.SLACK = r.ok ? "sent" : `failed: ${r.errors.join("; ")}`.slice(0, 300);
    if (!r.ok) return { ok: true, fields };
  }
  try {
    writeSeen(stateDir, current.map(orphanKey));
  } catch (e) {
    fields.SEEN_WARNING = `the seen list was not saved, so these orphans will be announced again: ${e.message}`.slice(0, 300);
  }
  return { ok: true, fields };
}

const kv = (k, v) => `${k}=${String(v).replace(/[\r\n]+/g, " ")}`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "issues" && rest.length === 1) {
    const host = process.env.ORPHAN_ISSUES_HOST ?? "";
    const repo = process.env.ORPHAN_ISSUES_REPO ?? "";
    if (!repo) {
      console.error("orphan-report: ORPHAN_ISSUES_REPO is required");
      return 2;
    }
    try {
      const issues = await fetchOpenIssues({ host, repo, token: process.env.ORPHAN_ISSUES_TOKEN ?? "" });
      writeFileSync(rest[0], `${JSON.stringify(issues)}\n`);
      console.log(`orphan-report: ${issues.length} open issue(s) and pull request(s) in ${repo}`);
      return 0;
    } catch (e) {
      console.error(`orphan-report: ERROR reading the open issues of ${repo}: ${e.message}`);
      return 1;
    }
  }
  if (cmd === "publish" && rest.length === 3) {
    const [outputsFile, reportFile, stateDir] = rest;
    let outputs;
    let report;
    try {
      outputs = parseOutputs(readFileSync(outputsFile, "utf8"));
      report = JSON.parse(readFileSync(reportFile, "utf8"));
    } catch (e) {
      console.log(kv("PUBLISH_ERROR", `the reconciler's output could not be read: ${e.message}`));
      return 1;
    }
    const r = await publish({ outputs, report, stateDir, env: process.env });
    for (const [k, v] of Object.entries(r.fields)) console.log(kv(k, v));
    return r.ok ? 0 : 1;
  }
  console.error("usage: orphan-report.mjs issues <out.json> | publish <outputs> <report.json> <state-dir>");
  return 2;
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exitCode = await main(process.argv.slice(2));
