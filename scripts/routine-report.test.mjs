// Unit tests for scripts/routine-report.mjs: what a VM-lane routine says outside the
// machine. Run with: npm run test:scripts
//
// The network is a fake fetch that records every call and answers from a script, so the
// decisions -- which issue, comment or create or close, which Slack shape -- are pinned
// without reaching a host. The one thing this script does that cannot be undone is write
// to the destination, so each write is asserted by method and URL, and so is its absence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResult, renderDay, issueAction, slackPayload, deliverVerdict, deliverAlarm, dayOf, LABELS } from "./routine-report.mjs";

const RED = {
  ROUTINE: "migration",
  STATUS: "red",
  REASON: "2 of 12 cells red",
  EXIT: "1",
  TARGET: "1.13.0.dev33",
  SOURCE: "1.12.4",
  STARTED: "20261006T091500Z",
  FINISHED: "20261006T100000Z",
  LOG: "/var/log/e2e-migration/20261006T091500Z.log",
  REPORT: "unreported",
};
const GREEN = { ...RED, STATUS: "green", REASON: "12 of 12 cells green", STARTED: "20261008T091500Z" };
const ENV = {
  ROUTINE_ISSUE: "1",
  ROUTINE_SLACK: "red",
  ISSUE_HOST: "github.ibm.com",
  ISSUE_REPO: "Langflow/e2e-qa",
  ISSUE_CC: "@someone",
  GITHUB_TOKEN: "t0ken",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/T/1/x",
};
const ISSUES = "https://github.ibm.com/api/v3/repos/Langflow/e2e-qa/issues";

/** A fetch that records calls and answers by "METHOD url-prefix" from `routes`. */
function fakeFetch(routes = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
    const [status, json] = key ? routes[key] : [200, {}];
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  return { fn, calls };
}

test("a result is parsed, never evaluated, and a value keeps its = signs", () => {
  const r = parseResult("ROUTINE=x\nREASON=a=b $(rm -rf /)\nnot a line\nlower=1\n");
  assert.deepEqual(r, { ROUTINE: "x", REASON: "a=b $(rm -rf /)" });
});

test("the day is the start's UTC date", () => {
  assert.equal(dayOf("20261006T091500Z"), "2026-10-06");
  assert.equal(dayOf(""), "unknown day");
});

test("issue action: red comments on the open issue or opens one; green closes it or does nothing", () => {
  assert.equal(issueAction("red", { number: 1 }), "comment");
  assert.equal(issueAction("red", null), "create");
  assert.equal(issueAction("green", { number: 1 }), "close");
  assert.equal(issueAction("green", null), "none");
  for (const s of ["skipped", "failed", "blocked"]) assert.equal(issueAction(s, { number: 1 }), "none");
});

test("the day's text carries the reason, the routine's own fields, its detail and the log", () => {
  const md = renderDay(RED, { detail: "| cell | verdict |\n|---|---|\n| sqlite-pip-upgrade | red |" });
  assert.match(md, /^## 2026-10-06: red$/m);
  assert.match(md, /2 of 12 cells red/);
  assert.match(md, /\| TARGET \| 1\.13\.0\.dev33 \|/);
  assert.match(md, /\| SOURCE \| 1\.12\.4 \|/);
  assert.doesNotMatch(md, /\| STATUS \|/, "core fields are repeated in the table");
  assert.match(md, /sqlite-pip-upgrade \| red/);
  assert.match(md, /e2e-migration\/20261006T091500Z\.log/);
});

test("Slack's shape follows the URL: Block Kit for /services/, the trigger's three variables otherwise", () => {
  assert.deepEqual(Object.keys(slackPayload("https://hooks.slack.com/triggers/a", "h", "b")).sort(), ["body", "headline", "links"]);
  const blocks = slackPayload("https://hooks.slack.com/services/a", "h", "b");
  assert.equal(blocks.blocks[0].type, "header");
});

test("a red day with no open issue opens one, labelled for the routine, on the destination", async () => {
  const { fn, calls } = fakeFetch({ [`GET ${ISSUES}?`]: [200, []], [`POST ${ISSUES}`]: [201, { html_url: "https://x/issues/5" }] });
  const r = await deliverVerdict(RED, ENV, { fetchFn: fn });
  assert.equal(r.ok, true, r.errors.join("; "));
  const get = calls.find((c) => c.method === "GET");
  assert.match(get.url, /labels=routine%3Amigration/);
  assert.match(get.url, /state=open/);
  const post = calls.find((c) => c.method === "POST" && c.url === ISSUES);
  assert.equal(post.body.title, "Routine migration: red since 2026-10-06");
  assert.deepEqual(post.body.labels, LABELS("migration"));
  assert.match(post.body.body, /each red day is added below as a comment/);
  assert.match(post.body.body, /\/cc @someone/);
  assert.equal(post.headers.Authorization, "Bearer t0ken");
  assert.deepEqual(r.did, ["issue:create https://x/issues/5", "slack"]);
});

test("a red day with an open issue comments on it and opens nothing; pull requests are not issues", async () => {
  const list = [{ number: 3, pull_request: {} }, { number: 9, html_url: "https://x/issues/9" }, { number: 7, html_url: "https://x/issues/7" }];
  const { fn, calls } = fakeFetch({ [`GET ${ISSUES}?`]: [200, list] });
  const r = await deliverVerdict(RED, ENV, { fetchFn: fn });
  assert.equal(r.ok, true, r.errors.join("; "));
  const posts = calls.filter((c) => c.method === "POST" && c.url.startsWith(ISSUES));
  assert.equal(posts.length, 1);
  // The oldest open one: the episode began there.
  assert.equal(posts[0].url, `${ISSUES}/7/comments`);
  assert.match(posts[0].body.body, /^## 2026-10-06: red/);
});

test("the first green day comments and closes the open issue; a green day with none writes nothing", async () => {
  const open = fakeFetch({ [`GET ${ISSUES}?`]: [200, [{ number: 7, html_url: "u" }]] });
  const r = await deliverVerdict(GREEN, ENV, { fetchFn: open.fn });
  assert.equal(r.ok, true, r.errors.join("; "));
  const writes = open.calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.url}`), [`POST ${ISSUES}/7/comments`, `PATCH ${ISSUES}/7`]);
  assert.match(writes[0].body.body, /^Back to green on 2026-10-08, closing\./);
  assert.equal(writes[1].body.state, "closed");

  const none = fakeFetch({ [`GET ${ISSUES}?`]: [200, []] });
  await deliverVerdict(GREEN, ENV, { fetchFn: none.fn });
  assert.deepEqual(none.calls.filter((c) => c.method !== "GET"), [], "a green day with no issue wrote something");
});

test("Slack: red speaks when asked for red, green only when asked for always, never when never", async () => {
  const slackCalls = async (result, mode) => {
    const { fn, calls } = fakeFetch({ [`GET ${ISSUES}?`]: [200, []] });
    await deliverVerdict(result, { ...ENV, ROUTINE_ISSUE: "0", ROUTINE_SLACK: mode }, { fetchFn: fn });
    return calls.filter((c) => c.url === ENV.SLACK_WEBHOOK_URL);
  };
  assert.equal((await slackCalls(RED, "red")).length, 1);
  assert.equal((await slackCalls(GREEN, "red")).length, 0);
  assert.equal((await slackCalls(GREEN, "always")).length, 1);
  assert.equal((await slackCalls(RED, "never")).length, 0);
  const [post] = await slackCalls(RED, "red");
  assert.equal(post.body.headline, "Routine migration: red (2026-10-06)");
});

test("the Slack post links the issue it opened, so the two views of one red point at each other", async () => {
  const { fn, calls } = fakeFetch({ [`GET ${ISSUES}?`]: [200, []], [`POST ${ISSUES}`]: [201, { html_url: "https://x/issues/5" }] });
  await deliverVerdict(RED, ENV, { fetchFn: fn });
  const slack = calls.find((c) => c.url === ENV.SLACK_WEBHOOK_URL);
  assert.match(slack.body.body, /Issue: https:\/\/x\/issues\/5/);
  assert.equal(slack.body.links, "https://x/issues/5");
});

test("a failed delivery is reported as not ok, and the other channel is still tried", async () => {
  const { fn, calls } = fakeFetch({ [`GET ${ISSUES}?`]: [500, { message: "down" }] });
  const r = await deliverVerdict(RED, ENV, { fetchFn: fn });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /^issue: GET .* HTTP 500/);
  assert.ok(calls.some((c) => c.url === ENV.SLACK_WEBHOOK_URL), "Slack was skipped after the issue failed");
});

test("missing destination or credentials are errors, not a silent skip", async () => {
  const { fn, calls } = fakeFetch();
  const r = await deliverVerdict(RED, { ...ENV, GITHUB_TOKEN: "", GH_TOKEN: "", SLACK_WEBHOOK_URL: "" }, { fetchFn: fn });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
  assert.deepEqual(calls, []);
});

test("only a green or red result is a verdict to deliver", async () => {
  const { fn, calls } = fakeFetch();
  const r = await deliverVerdict({ ...RED, STATUS: "skipped" }, ENV, { fetchFn: fn });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, []);
});

test("every request carries a timeout, so a hung host cannot hold the unit until it is killed", async () => {
  const { fn, calls } = fakeFetch({ [`GET ${ISSUES}?`]: [200, []], [`POST ${ISSUES}`]: [201, { html_url: "u" }] });
  const seen = [];
  await deliverVerdict(RED, ENV, { fetchFn: (url, init) => (seen.push(init.signal), fn(url, init)) });
  await deliverAlarm("h", "b", ENV, { fetchFn: (url, init) => (seen.push(init.signal), fn(url, init)) });
  assert.equal(seen.length, calls.length);
  assert.ok(seen.length >= 4);
  for (const s of seen) assert.ok(s instanceof AbortSignal, "a request without a timeout");
});

test("the alarm posts to Slack only, and says so when it cannot", async () => {
  const { fn, calls } = fakeFetch();
  assert.equal((await deliverAlarm("h", "b", ENV, { fetchFn: fn })).ok, true);
  assert.deepEqual(calls.map((c) => c.url), [ENV.SLACK_WEBHOOK_URL]);
  assert.equal((await deliverAlarm("h", "b", {}, { fetchFn: fn })).ok, false);
});
