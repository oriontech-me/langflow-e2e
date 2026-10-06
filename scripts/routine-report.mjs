#!/usr/bin/env node
// What a VM-lane routine says outside the machine (ops/vm/lib/routine.sh).
//
//   node scripts/routine-report.mjs verdict <result.env>
//       A green or red result, per the routine's declared visibility:
//         ROUTINE_ISSUE=1          ONE open issue per routine on the destination. A red
//                                  day comments on it, or opens it when none is open; the
//                                  first green day comments and closes it. A week of the
//                                  same breakage is one issue with its days in it, which
//                                  is how the Actions migration workflows behaved.
//         ROUTINE_SLACK=red|always|never
//   node scripts/routine-report.mjs alarm <headline> <body>
//       The watchdog's: Slack only, for a day the routine did not speak.
//
// Reads ISSUE_HOST, ISSUE_REPO, ISSUE_CC (the lane file), GITHUB_TOKEN or GH_TOKEN, and
// SLACK_WEBHOOK_URL (the secrets file). Exit 0 when everything asked for was delivered,
// 1 otherwise, 2 on bad usage. It never changes the routine's status: the caller records
// a failed delivery, and the watchdog reports it.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { apiUrlFor } from "./create-failure-issue.mjs";

/** KEY=VALUE lines, parsed, never evaluated. Later keys win. */
export function parseResult(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const labelFor = (routine) => `routine:${routine}`;
export const LABELS = (routine) => ["routine-failure", labelFor(routine)];

/** The day a result belongs to, from its STARTED stamp (20261005T091500Z). */
export function dayOf(stamp = "") {
  const m = /^(\d{4})(\d{2})(\d{2})T/.exec(stamp);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "unknown day";
}

// Fields every result has, shown apart; the rest are the routine's own.
const CORE = new Set(["ROUTINE", "STATUS", "REASON", "EXIT", "STARTED", "FINISHED", "LOG", "REPORT", "DETAIL"]);

/**
 * The markdown for one day. PURE. `detail` is the routine's own report (its DETAIL file),
 * included verbatim; the fields are what the result recorded.
 */
export function renderDay(result, { detail = "", hostname = "the QA VM" } = {}) {
  const lines = [`## ${dayOf(result.STARTED)}: ${result.STATUS}`, "", result.REASON || "(no reason recorded)", ""];
  const extra = Object.keys(result).filter((k) => !CORE.has(k));
  if (extra.length) {
    lines.push("| Field | Value |", "|---|---|");
    for (const k of extra) lines.push(`| ${k} | ${String(result[k]).replace(/\|/g, "\\|") || "—"} |`);
    lines.push("");
  }
  if (detail.trim()) lines.push(detail.trim(), "");
  lines.push(`Log on ${hostname}: \`${result.LOG || "?"}\``);
  return lines.join("\n");
}

/**
 * What to do with the routine's issue. PURE.
 *   red   + open  -> comment
 *   red   + none  -> create
 *   green + open  -> close (with a comment)
 *   green + none  -> nothing
 */
export function issueAction(status, openIssue) {
  if (status === "red") return openIssue ? "comment" : "create";
  if (status === "green") return openIssue ? "close" : "none";
  return "none";
}

/** Slack's two transports, keyed on the URL's path, as notify-slack.mjs does. */
export function slackPayload(url, headline, body, links = "") {
  if (url.includes("/services/")) {
    return {
      blocks: [
        { type: "header", text: { type: "plain_text", text: headline.slice(0, 150) } },
        { type: "section", text: { type: "mrkdwn", text: body.slice(0, 2900) } },
      ],
    };
  }
  // A Workflow Builder trigger: all three variables, always, even empty (#2038).
  return { headline, body, links };
}

const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
});

async function gh(fetchFn, token, method, url, body) {
  const res = await fetchFn(url, { method, headers: ghHeaders(token), body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** The routine's open issue, or null. Pull requests share the endpoint and are skipped. */
export async function findOpenIssue({ fetchFn, token, host, repo, routine }) {
  const url = `${apiUrlFor(host, repo)}?state=open&per_page=20&labels=${encodeURIComponent(labelFor(routine))}`;
  const list = await gh(fetchFn, token, "GET", url);
  const issues = (Array.isArray(list) ? list : []).filter((i) => !i.pull_request);
  // The oldest: if two are ever open, the episode began with the first.
  issues.sort((a, b) => a.number - b.number);
  return issues[0] ?? null;
}

/**
 * Deliver a verdict. Returns { ok, did: [..], errors: [..] }; never throws.
 * `fetchFn` is injectable so the decisions are tested without a network.
 */
export async function deliverVerdict(result, env, { fetchFn = fetch, detail = "" } = {}) {
  const did = [];
  const errors = [];
  const routine = result.ROUTINE;
  const status = result.STATUS;
  if (!routine || !["green", "red"].includes(status)) {
    return { ok: false, did, errors: [`not a verdict: ROUTINE=${routine ?? ""} STATUS=${status ?? ""}`] };
  }
  const day = renderDay(result, { detail });
  let issueUrl = "";

  if (env.ROUTINE_ISSUE === "1") {
    const host = env.ISSUE_HOST;
    const repo = env.ISSUE_REPO;
    const token = env.GITHUB_TOKEN || env.GH_TOKEN || "";
    if (!host || !repo || !token) {
      errors.push("issue: ISSUE_HOST, ISSUE_REPO and a token (GITHUB_TOKEN or GH_TOKEN) are all required");
    } else {
      try {
        const open = await findOpenIssue({ fetchFn, token, host, repo, routine });
        const action = issueAction(status, open);
        const base = apiUrlFor(host, repo);
        if (action === "comment") {
          await gh(fetchFn, token, "POST", `${base}/${open.number}/comments`, { body: day });
          issueUrl = open.html_url ?? "";
        } else if (action === "create") {
          const cc = env.ISSUE_CC ? `\n\n/cc ${env.ISSUE_CC}` : "";
          const intro =
            `The VM-lane routine \`${routine}\` found something wrong. This issue stays open while it ` +
            `stays red: each red day is added below as a comment, and the first green day closes it.`;
          const created = await gh(fetchFn, token, "POST", base, {
            title: `Routine ${routine}: red since ${dayOf(result.STARTED)}`,
            body: `${intro}\n\n${day}${cc}`,
            labels: LABELS(routine),
          });
          issueUrl = created.html_url ?? "";
        } else if (action === "close") {
          await gh(fetchFn, token, "POST", `${base}/${open.number}/comments`, {
            body: `Back to green on ${dayOf(result.STARTED)}, closing.\n\n${day}`,
          });
          await gh(fetchFn, token, "PATCH", `${base}/${open.number}`, { state: "closed", state_reason: "completed" });
          issueUrl = open.html_url ?? "";
        }
        did.push(`issue:${action}${issueUrl ? ` ${issueUrl}` : ""}`);
      } catch (e) {
        errors.push(`issue: ${e.message}`);
      }
    }
  }

  const slack = env.ROUTINE_SLACK ?? "never";
  if (slack === "always" || (slack === "red" && status === "red")) {
    const url = env.SLACK_WEBHOOK_URL ?? "";
    if (!url) {
      errors.push("slack: SLACK_WEBHOOK_URL is not set");
    } else {
      const headline = `Routine ${routine}: ${status} (${dayOf(result.STARTED)})`;
      const body = `${result.REASON || ""}${issueUrl ? `\nIssue: ${issueUrl}` : ""}`;
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(slackPayload(url, headline, body, issueUrl)),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        did.push("slack");
      } catch (e) {
        errors.push(`slack: ${e.message}`);
      }
    }
  }
  return { ok: errors.length === 0, did, errors };
}

export async function deliverAlarm(headline, body, env, { fetchFn = fetch } = {}) {
  const url = env.SLACK_WEBHOOK_URL ?? "";
  if (!url) return { ok: false, errors: ["slack: SLACK_WEBHOOK_URL is not set"] };
  try {
    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(slackPayload(url, headline, body)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, errors: [] };
  } catch (e) {
    return { ok: false, errors: [`slack: ${e.message}`] };
  }
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "verdict" && rest.length === 1) {
    const result = parseResult(readFileSync(rest[0], "utf8"));
    let detail = "";
    if (result.DETAIL) {
      try {
        detail = readFileSync(result.DETAIL, "utf8");
      } catch {
        detail = `(the routine's detail file ${result.DETAIL} could not be read)`;
      }
    }
    const r = await deliverVerdict(result, process.env, { detail });
    for (const d of r.did) console.log(`routine-report: ${d}`);
    for (const e of r.errors) console.error(`routine-report: ERROR ${e}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "alarm" && rest.length === 2) {
    const r = await deliverAlarm(rest[0], rest[1], process.env);
    for (const e of r.errors) console.error(`routine-report: ERROR ${e}`);
    if (r.ok) console.log("routine-report: alarm posted");
    return r.ok ? 0 : 1;
  }
  console.error("usage: routine-report.mjs verdict <result.env> | alarm <headline> <body>");
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
