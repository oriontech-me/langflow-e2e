// Unit tests for scripts/orphan-report.mjs, the network half of the stable-orphans
// routine (#2224). Run with: npm run test:scripts
//
// The destination is a fake fetch that keeps issues in memory, so the lifecycle is
// exercised end to end: open, refresh, close, and the guards the workflow had (an outage
// decides nothing; the label is tolerant). What these pin beyond the workflow is the
// Slack rule: only an orphan the last PUBLISHED run did not list is announced, and one
// whose post failed is owed again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import { parseOutputs, issueAction, newOrphans, orphanKey, slackText, fetchOpenIssues, publish } from "./orphan-report.mjs";

const TITLE = "[@stable] absences nobody is holding — orphaned removals and expired justifications";
const ENV = { ISSUE_HOST: "dest.example.invalid", ISSUE_REPO: "o/r", GITHUB_TOKEN: "issue-token", SLACK_WEBHOOK_URL: "https://hooks.example.invalid/services/x" };
const API = "https://dest.example.invalid/api/v3/repos/o/r/issues";
const row = (relativePath, title = "t") => ({ relativePath, title });
const outputs = (o = {}) => ({ has_findings: "true", tracker_lookup_failed: "false", gate_lookup_failed: "false", issue_title: TITLE, summary_md: "**1 orphaned**", ...o });

/** A fake GitHub (issues only) and Slack. `fail` maps "METHOD url-suffix" to a status. */
function fakeNet({ issues = [], fail = {}, slack = 200 } = {}) {
  const calls = [];
  const state = { issues: issues.map((i) => ({ state: "open", labels: [], ...i })), slack: [] };
  const res = (status, body, link = "") => ({ ok: status < 300, status, text: async () => (body === undefined ? "" : JSON.stringify(body)), headers: { get: (h) => (h === "link" ? link : null) } });
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers?.Authorization });
    if (url.startsWith("https://hooks.")) {
      state.slack.push(JSON.parse(init.body));
      return res(slack, {});
    }
    const suffix = url.slice(API.length);
    const key = `${method} ${suffix.replace(/\?.*$/, "")}`;
    if (fail[key]) return res(fail[key], { message: "nope" });
    if (method === "GET") return res(200, state.issues.filter((i) => i.state === "open"));
    if (method === "POST" && suffix === "") {
      const n = { number: 100 + state.issues.length, html_url: `https://dest.example.invalid/o/r/issues/${100 + state.issues.length}`, state: "open", labels: [], ...JSON.parse(init.body) };
      state.issues.push(n);
      return res(201, n);
    }
    const m = /^\/(\d+)(\/comments|\/labels)?$/.exec(suffix);
    const issue = m && state.issues.find((i) => i.number === Number(m[1]));
    if (!issue) return res(404, { message: "Not Found" });
    if (m[2] === "/comments") {
      (issue.comments ??= []).push(JSON.parse(init.body).body);
      return res(201, {});
    }
    if (m[2] === "/labels") {
      issue.labels.push(...JSON.parse(init.body).labels);
      return res(200, []);
    }
    Object.assign(issue, JSON.parse(init.body));
    return res(200, issue);
  };
  return { fetchFn, calls, state };
}

const run = (net, { out = outputs(), orphaned = [row("a.spec.ts")], stateDir = makeTempDir("orphan-report-") } = {}) =>
  publish({ outputs: out, report: { orphans: { orphaned } }, stateDir, env: ENV, fetchFn: net.fetchFn }).then((r) => ({ ...r, stateDir }));

test("parseOutputs reads key=value lines and a heredoc body, as $GITHUB_OUTPUT holds them", () => {
  const text = ["orphan_count=1", "has_findings=true", "issue_title=[@stable] x — y", "summary_md<<__EOF_1__", "line one", "", "a=b inside the body", "__EOF_1__", "tracker_lookup_failed=false", ""].join("\n");
  assert.deepEqual(parseOutputs(text), {
    orphan_count: "1",
    has_findings: "true",
    issue_title: "[@stable] x — y",
    summary_md: "line one\n\na=b inside the body",
    tracker_lookup_failed: "false",
  });
});

test("issueAction: the workflow's table, and any lookup that failed, or a flag missing, leaves the issue alone", () => {
  const open = { number: 1 };
  assert.equal(issueAction(outputs(), open), "refresh");
  assert.equal(issueAction(outputs(), null), "create");
  assert.equal(issueAction(outputs({ has_findings: "false" }), open), "close");
  assert.equal(issueAction(outputs({ has_findings: "false" }), null), "none");
  for (const bad of [{ tracker_lookup_failed: "true" }, { gate_lookup_failed: "true" }, { tracker_lookup_failed: undefined }, { has_findings: undefined }]) {
    assert.equal(issueAction(outputs({ has_findings: "false", ...bad }), open), "untouched", JSON.stringify(bad));
  }
});

test("newOrphans: everything on a first run, only the unseen afterwards", () => {
  const a = row("a.spec.ts");
  const b = row("b.spec.ts", "other");
  assert.deepEqual(newOrphans([a, b], null), [a, b]);
  assert.deepEqual(newOrphans([a, b], [orphanKey(a)]), [b]);
  assert.deepEqual(newOrphans([a], [orphanKey(a), orphanKey(b)]), []);
});

test("slackText names the tests, caps the list, and links the report", () => {
  const rows = Array.from({ length: 12 }, (_, i) => row(`s${i}.spec.ts`, `test ${i}`));
  const { headline, body } = slackText(rows, "https://x/9");
  assert.match(headline, /^@stable: 12 new orphans/);
  assert.equal(body.split("\n").filter((l) => l.startsWith("•")).length, 11);
  assert.match(body, /and 2 more/);
  assert.match(body, /Report: https:\/\/x\/9$/);
  assert.match(slackText([row("a.spec.ts")], "").headline, /^@stable: 1 new orphan,/);
});

test("fetchOpenIssues follows every page, tags each issue with its repository, and refuses an endless list", async () => {
  const pages = [[{ number: 1, title: "a", html_url: "u1" }], [{ number: 2, title: "b", body: null, html_url: "u2", pull_request: {} }]];
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    const i = seen.length - 1;
    return { ok: true, status: 200, text: async () => JSON.stringify(pages[i]), headers: { get: () => (i === 0 ? '<https://api.github.com/next?page=2>; rel="next", <x>; rel="last"' : "") } };
  };
  const got = await fetchOpenIssues({ fetchFn, host: "github.com", repo: "s/r", token: "" });
  assert.deepEqual(got.map((i) => [i.number, i.repo, i.body]), [[1, "s/r", ""], [2, "s/r", ""]]);
  assert.ok(got[1].pull_request, "the PR flag is kept: the reconciler drops PRs itself");
  assert.equal(seen[0].url, "https://api.github.com/repos/s/r/issues?state=open&per_page=100");
  assert.equal(seen[1].url, "https://api.github.com/next?page=2");
  assert.equal(seen[0].auth, undefined, "no token, no Authorization header");

  const endless = async () => ({ ok: true, status: 200, text: async () => "[]", headers: { get: () => '<https://api.github.com/again>; rel="next"' } });
  await assert.rejects(fetchOpenIssues({ fetchFn: endless, host: "github.com", repo: "s/r" }), /more than 50 pages/);
  const notList = async () => ({ ok: true, status: 200, text: async () => "{}", headers: { get: () => "" } });
  await assert.rejects(fetchOpenIssues({ fetchFn: notList, host: "github.com", repo: "s/r" }), /did not answer with a list/);
});

test("findings and no report issue: one is opened under the fixed title, then labelled", async () => {
  const net = fakeNet();
  const r = await run(net);
  assert.equal(r.ok, true, JSON.stringify(r.fields));
  assert.equal(r.fields.ISSUE, "create https://dest.example.invalid/o/r/issues/100");
  const [created] = net.state.issues;
  assert.equal(created.title, TITLE);
  assert.equal(created.body, "**1 orphaned**");
  assert.deepEqual(created.labels, ["qa-infra"]);
  assert.ok(net.calls.filter((c) => !c.url.startsWith("https://hooks.")).every((c) => c.auth === "Bearer issue-token"));
});

test("findings and an open report issue: its body is replaced, not a second issue", async () => {
  const net = fakeNet({ issues: [{ number: 7, title: TITLE, body: "old", html_url: "https://d/7" }, { number: 6, title: `Re: ${TITLE}`, html_url: "https://d/6" }, { number: 5, title: "a PR with the title", html_url: "https://d/5", pull_request: {} }] });
  const r = await run(net, { out: outputs({ summary_md: "new body" }) });
  assert.equal(r.fields.ISSUE, "refresh https://d/7");
  assert.equal(net.state.issues.find((i) => i.number === 7).body, "new body");
  assert.equal(net.state.issues.find((i) => i.number === 6).body, undefined, "an issue quoting the title is not the report");
  assert.equal(net.state.issues.length, 3);
});

test("nothing left: the report issue says so and closes; with none open nothing happens", async () => {
  const net = fakeNet({ issues: [{ number: 7, title: TITLE, html_url: "https://d/7" }] });
  const r = await run(net, { out: outputs({ has_findings: "false", summary_md: "**0 orphaned**" }), orphaned: [] });
  assert.equal(r.fields.ISSUE, "close https://d/7");
  const closed = net.state.issues[0];
  assert.equal(closed.state, "closed");
  assert.match(closed.comments[0], /^Every `@stable` removal now has an owner/);
  assert.match(closed.comments[0], /\*\*0 orphaned\*\*/);
  const quiet = await run(fakeNet(), { out: outputs({ has_findings: "false" }), orphaned: [] });
  assert.equal(quiet.fields.ISSUE, "none");
});

test("a lookup that failed leaves a standing report untouched, and the seen list too", async () => {
  const net = fakeNet({ issues: [{ number: 7, title: TITLE, body: "standing", html_url: "https://d/7" }] });
  const r = await run(net, { out: outputs({ tracker_lookup_failed: "true", summary_md: "says less" }) });
  assert.equal(r.ok, true);
  assert.equal(r.fields.ISSUE, "untouched");
  assert.equal(net.state.issues[0].body, "standing");
  assert.equal(net.calls.filter((c) => c.method !== "GET").length, 0);
  assert.equal(existsSync(join(r.stateDir, "orphans-seen.json")), false);
});

test("a label that cannot be set does not cost the report", async () => {
  const net = fakeNet({ fail: { "POST /100/labels": 422 } });
  const r = await run(net);
  assert.equal(r.ok, true);
  assert.match(r.fields.ISSUE, /^create /);
  assert.match(r.fields.LABEL_WARNING, /^opened without the qa-infra label/);
});

test("a destination that refuses is not ok, and says which step", async () => {
  const lookup = await run(fakeNet({ fail: { "GET ": 401 } }));
  assert.equal(lookup.ok, false);
  assert.equal(lookup.fields.ISSUE, "lookup-failed");
  assert.match(lookup.fields.PUBLISH_ERROR, /HTTP 401/);
  const write = await run(fakeNet({ issues: [{ number: 7, title: TITLE, html_url: "https://d/7" }], fail: { "PATCH /7": 403 } }));
  assert.equal(write.ok, false);
  assert.equal(write.fields.ISSUE, "refresh-failed");
});

test("missing credentials, or an empty body, publish nothing", async () => {
  const net = fakeNet();
  const r = await publish({ outputs: outputs(), report: { orphans: { orphaned: [] } }, stateDir: makeTempDir("orphan-report-"), env: { ...ENV, GITHUB_TOKEN: "" }, fetchFn: net.fetchFn });
  assert.equal(r.ok, false);
  assert.match(r.fields.PUBLISH_ERROR, /are all required/);
  const empty = await run(net, { out: outputs({ summary_md: "  " }) });
  assert.equal(empty.ok, false);
  assert.equal(net.calls.length, 0);
});

test("Slack hears about an orphan once: the first run announces it, the next one does not", async () => {
  const net = fakeNet();
  const stateDir = makeTempDir("orphan-report-");
  const first = await run(net, { stateDir });
  assert.equal(first.fields.NEW_ORPHANS, "1");
  assert.equal(first.fields.SLACK, "sent");
  assert.equal(net.state.slack.length, 1);
  assert.match(net.state.slack[0].blocks[1].text.text, /a\.spec\.ts/);
  assert.match(net.state.slack[0].blocks[1].text.text, /Report: https:\/\/dest\.example\.invalid\/o\/r\/issues\/100/);
  const second = await run(net, { stateDir });
  assert.equal(second.fields.NEW_ORPHANS, "0");
  assert.equal(second.fields.SLACK, "none");
  assert.equal(net.state.slack.length, 1);
  const third = await run(net, { stateDir, orphaned: [row("a.spec.ts"), row("b.spec.ts")] });
  assert.equal(third.fields.NEW_ORPHANS, "1");
  assert.doesNotMatch(net.state.slack[1].blocks[1].text.text, /a\.spec\.ts/);
});

test("an orphan restored and orphaned again is announced again", async () => {
  const net = fakeNet();
  const stateDir = makeTempDir("orphan-report-");
  await run(net, { stateDir });
  await run(net, { stateDir, out: outputs({ has_findings: "false" }), orphaned: [] });
  const back = await run(net, { stateDir });
  assert.equal(back.fields.NEW_ORPHANS, "1");
  assert.equal(net.state.slack.length, 2);
});

test("a Slack post that failed is owed again next run: the seen list does not move", async () => {
  const stateDir = makeTempDir("orphan-report-");
  const failed = await run(fakeNet({ slack: 500 }), { stateDir });
  assert.equal(failed.ok, true, "the issue is current; Slack is the watchdog's to say");
  assert.match(failed.fields.SLACK, /^failed: slack: HTTP 500/);
  assert.equal(existsSync(join(stateDir, "orphans-seen.json")), false);
  const retry = await run(fakeNet(), { stateDir });
  assert.equal(retry.fields.NEW_ORPHANS, "1");
  assert.equal(retry.fields.SLACK, "sent");
});

test("an unreadable seen list counts as a first run, never as 'all seen'", async () => {
  const stateDir = makeTempDir("orphan-report-");
  writeFileSync(join(stateDir, "orphans-seen.json"), "{not json");
  const r = await run(fakeNet(), { stateDir });
  assert.equal(r.fields.NEW_ORPHANS, "1");
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "orphans-seen.json"), "utf8")), ["a.spec.ts::t"]);
});
