// Unit tests for ops/vm/run-stable-orphans.sh, the stable-orphans routine (stage 3,
// task 6, #2224). Run with: npm run test:scripts
//
// The source is a real git repository on disk (a bare one, reached by path), so the fetch
// and the worktree are git's own. The reconciler (behind node_modules/.bin/ts-node) and
// scripts/orphan-report.mjs are replaced by fakes that answer from a control file and
// record what they were handed. What these pin is what one good Monday on the machine
// would not show: findings that stay green, a reconciler that refuses (red) apart from a
// machine that cannot run it (failed), a tracker list that cannot be read failing the run
// instead of making every removal an orphan, each credential reaching only its own call,
// and the clone left as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "ops", "vm", "run-stable-orphans.sh");
const q = JSON.stringify;
const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const kv = (text) =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const GIT_ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ID } }).trim();

/**
 * reconcile: "findings" | "clean" | "refuse" (exits 1, the repository's) | "nomodule"
 *            | "trackerfail" | "gatefail"
 * issues:    { source: "ok"|"fail", destination: "ok"|"fail" }
 * publish:   "ok" | "fail" | "slackfail"
 */
function orphans({ reconcile = "findings", issues = {}, publish = "ok", token = "push-token", dryRun = false, runBusy = false, trackers = null, shallow = false } = {}) {
  const dir = makeTempDir("run-stable-orphans-");
  const control = join(dir, "control.json");
  writeFileSync(control, q({ reconcile, issues: { source: "ok", destination: "ok", ...issues }, publish }));
  const rec = join(dir, "rec");
  mkdirSync(rec);

  const seed = join(dir, "seed");
  mkdirSync(join(seed, "scripts"), { recursive: true });
  writeFileSync(join(seed, "scripts", "reconcile-stable-orphans.ts"), "// the repository's reconciler\n");
  git(dir, "init", "-q", "-b", "main", seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "commit", "-q", "--allow-empty", "-m", "second");
  const bare = join(dir, "source.git");
  git(dir, "clone", "-q", "--bare", seed, bare);

  // The clone the routine lives in, with the library, the fake network half and an
  // installed node_modules whose ts-node is the fake reconciler.
  const repo = join(dir, "repo");
  if (shallow) git(dir, "clone", "-q", "--depth", "1", `file://${bare}`, repo);
  else git(dir, "clone", "-q", bare, repo);
  mkdirSync(join(repo, "ops", "vm", "lib"), { recursive: true });
  copyFileSync(join(ROOT, "ops/vm/lib/routine.sh"), join(repo, "ops/vm/lib/routine.sh"));
  mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
  writeFileSync(
    join(repo, "node_modules", ".bin", "ts-node"),
    `#!/usr/bin/env node
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(${q(control)}, "utf8"));
fs.writeFileSync(${q(join(rec, "reconcile.json"))}, JSON.stringify({ env: process.env, argv: process.argv.slice(2), cwd: process.cwd() }));
const arg = (f) => process.argv[process.argv.indexOf(f) + 1];
if (c.reconcile === "refuse") { console.error("No declared tests found under tests/. Refusing to report a clean reconciliation from an empty parse."); process.exit(1); }
if (c.reconcile === "nomodule") { console.error("Error: Cannot find module 'typescript'"); process.exit(1); }
const findings = c.reconcile !== "clean";
fs.writeFileSync(arg("--markdown"), "# the report\\n");
fs.writeFileSync(arg("--json"), JSON.stringify({ orphans: { orphaned: findings ? [{ relativePath: "a.spec.ts", title: "t" }] : [] }, gates: {} }));
fs.appendFileSync(process.env.GITHUB_OUTPUT, [
  "orphan_count=" + (findings ? 1 : 0), "finding_count=" + (findings ? 2 : 0), "has_findings=" + findings,
  "gate_lookup_failed=" + (c.reconcile === "gatefail"), "tracker_lookup_failed=" + (c.reconcile === "trackerfail"),
  "issue_title=[@stable] report", "summary_md<<EOF", "body", "EOF", ""].join("\\n"));
`,
    { mode: 0o755 },
  );
  mkdirSync(join(repo, "scripts"), { recursive: true });
  writeFileSync(
    join(repo, "scripts", "orphan-report.mjs"),
    `import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const c = JSON.parse(readFileSync(${q(control)}, "utf8"));
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "issues") {
  const which = process.env.ORPHAN_ISSUES_HOST === "github.com" ? "source" : "destination";
  appendFileSync(${q(join(rec, "issues.jsonl"))}, JSON.stringify({ which, host: process.env.ORPHAN_ISSUES_HOST, repo: process.env.ORPHAN_ISSUES_REPO, token: process.env.ORPHAN_ISSUES_TOKEN, out: rest[0] }) + "\\n");
  if (c.issues[which] === "fail") { console.error("HTTP 502"); process.exit(1); }
  writeFileSync(rest[0], "[]\\n");
  process.exit(0);
}
if (cmd === "publish") {
  writeFileSync(${q(join(rec, "publish.json"))}, JSON.stringify({ env: process.env, argv: rest }));
  if (c.publish === "fail") { console.log("ISSUE=lookup-failed"); console.log("PUBLISH_ERROR=HTTP 401"); process.exit(1); }
  console.log("ISSUE=create https://dest.example.invalid/o/r/issues/9");
  console.log("NEW_ORPHANS=1");
  console.log(c.publish === "slackfail" ? "SLACK=failed: slack: HTTP 500" : "SLACK=sent");
  process.exit(0);
}
process.exit(2);
`,
  );
  const cloneBefore = { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain") };

  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  stub(bin, "systemctl", "echo inactive");
  stub(bin, "flock", `case "$*" in *9) exit ${runBusy ? 1 : 0} ;; esac\nexit 0`);

  const secrets = join(dir, "secrets.env");
  writeFileSync(
    secrets,
    [token ? `export SOURCE_PUSH_TOKEN=${token}` : "", "export GITHUB_TOKEN=issue-token", "export SLACK_WEBHOOK_URL=https://hooks.example.invalid/services/x"].join("\n") + "\n",
  );
  const lane = join(dir, "lane.env");
  writeFileSync(lane, "ISSUE_HOST=dest.example.invalid\nISSUE_REPO=o/r\nISSUE_CC=\n");
  const state = join(dir, "state");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      E2E_ROUTINE_REPO: repo,
      E2E_ROUTINE_STATE_ROOT: state,
      E2E_ROUTINE_LOG_ROOT: join(dir, "log"),
      E2E_HEAVY_LOCK: join(dir, "lock", "heavy.lock"),
      E2E_SHADOW_STATE: join(dir, "shadow"),
      E2E_ROUTINE_SECRETS: secrets,
      E2E_ROUTINE_LANE: lane,
      E2E_ROUTINE_NOW: "1 1000",
      E2E_ROUTINE_POLL_S: "0",
      SOURCE_REMOTE_URL: bare,
      ORPHANS_DRY_RUN: dryRun ? "1" : "0",
      ...(trackers !== null ? { ORPHAN_TRACKER_REPOS: trackers } : {}),
    },
  });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const last = readIf(join(state, "stable-orphans", "last.env"));
  const json = (p) => (readIf(p) ? JSON.parse(readIf(p)) : null);
  return {
    status: r.status,
    last: last ? kv(last) : {},
    log: readIf(join(dir, "log", "e2e-stable-orphans", "latest.log")) ?? `${r.stdout}${r.stderr}`,
    sourceSha: git(bare, "rev-parse", "main"),
    clone: {
      before: cloneBefore,
      after: { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain") },
      refs: git(repo, "for-each-ref", "--format=%(refname)"),
      worktrees: git(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length,
    },
    reconcile: json(join(rec, "reconcile.json")),
    issues: (readIf(join(rec, "issues.jsonl")) ?? "").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    publish: json(join(rec, "publish.json")),
    work: join(state, "stable-orphans", "work"),
  };
}

test("findings are green: the report is published and the run says what it found", () => {
  const r = orphans({ reconcile: "findings" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
  assert.match(r.last.REASON, /^1 orphan\(s\), 2 finding\(s\) on [0-9a-f]{12}; report issue: create https:\/\/dest\.example\.invalid\/o\/r\/issues\/9$/);
  assert.equal(r.last.SOURCE_SHA, r.sourceSha);
  assert.equal(r.last.NEW_ORPHANS, "1");
  assert.equal(r.last.SLACK, "sent");
  assert.equal(r.last.ALARM, undefined);
  assert.ok(r.publish, "the report was not published");
});

test("the reconciler runs on the fetched main, in a worktree of its own", () => {
  const r = orphans();
  assert.ok(r.reconcile, "the reconciler did not run");
  assert.equal(r.reconcile.cwd.endsWith("/stable-orphans/work/tree"), true, r.reconcile.cwd);
  assert.equal(r.reconcile.argv[0], "scripts/reconcile-stable-orphans.ts");
});

test("the trackers come from both repositories, each with its own credential, and both reach the reconciler", () => {
  const r = orphans();
  assert.deepEqual(
    r.issues.map(({ which, host, repo, token }) => ({ which, host, repo, token })),
    [
      { which: "source", host: "github.com", repo: "oriontech-me/langflow-e2e", token: "push-token" },
      { which: "destination", host: "dest.example.invalid", repo: "o/r", token: "issue-token" },
    ],
  );
  const files = r.reconcile.argv.flatMap((a, i, all) => (a === "--issues-file" ? [all[i + 1]] : []));
  assert.deepEqual(files, r.issues.map((i) => i.out));
  assert.equal(r.last.TRACKERS, "source destination");
});

test("stage 4's switch: ORPHAN_TRACKER_REPOS narrows the list", () => {
  const r = orphans({ trackers: "destination" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.issues.map((i) => i.which), ["destination"]);
  assert.equal(r.reconcile.argv.filter((a) => a === "--issues-file").length, 1);
});

test("a tracker list that cannot be read fails the run before the reconciler: ownership is undecided", () => {
  for (const which of ["source", "destination"]) {
    const r = orphans({ issues: { [which]: "fail" } });
    assert.equal(r.status, 3, `${which}: ${r.log}`);
    assert.equal(r.last.STATUS, "failed");
    assert.match(r.last.REASON, new RegExp(`^the open issues of the ${which} could not be read, so ownership is undecided`));
    assert.equal(r.reconcile, null, `${which}: the reconciler ran on a partial list`);
    assert.equal(r.publish, null, `${which}: something was published`);
  }
});

test("an unknown tracker repository name fails the run", () => {
  const r = orphans({ trackers: "source upstream" });
  assert.equal(r.last.STATUS, "failed");
  assert.match(r.last.REASON, /^the open issues of the upstream could not be read/);
});

test("a lookup the reconciler could not make fails the run and leaves the report alone", () => {
  for (const reconcile of ["trackerfail", "gatefail"]) {
    const r = orphans({ reconcile });
    assert.equal(r.status, 3, `${reconcile}: ${r.log}`);
    assert.equal(r.last.STATUS, "failed");
    assert.match(r.last.REASON, /the report issue was left alone$/, reconcile);
    assert.equal(r.publish, null, `${reconcile}: the report was published on an outage`);
  }
});

test("the reconciler refusing is red, the repository's; its tools missing is failed, the machine's", () => {
  const red = orphans({ reconcile: "refuse" });
  assert.equal(red.status, 1, red.log);
  assert.equal(red.last.STATUS, "red");
  assert.match(red.last.REASON, /^the reconciler ended with status 1 on [0-9a-f]{12}: No declared tests found/);
  assert.equal(red.publish, null);
  const machine = orphans({ reconcile: "nomodule" });
  assert.equal(machine.last.STATUS, "failed");
  assert.match(machine.last.REASON, /Cannot find module 'typescript'/);
});

test("a report that cannot be published is failed, with the destination's words", () => {
  const r = orphans({ publish: "fail" });
  assert.equal(r.status, 3, r.log);
  assert.equal(r.last.STATUS, "failed");
  assert.equal(r.last.REASON, "the report issue could not be made current on the destination: HTTP 401");
});

test("a Slack post that failed keeps the day green and leaves an ALARM for the watchdog", () => {
  const r = orphans({ publish: "slackfail" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
  assert.equal(r.last.ALARM, "the orphan report is current (create https://dest.example.invalid/o/r/issues/9), but its Slack post for new orphans failed: slack: HTTP 500");
});

test("each credential reaches only its own call", () => {
  const r = orphans();
  // The reconciler asks GitHub about gate references with the source token, and nothing
  // else: not the destination's issue token, not the Slack webhook.
  const recValues = Object.values(r.reconcile.env).join("\n");
  assert.equal(r.reconcile.env.GH_TOKEN, "push-token");
  assert.equal(r.reconcile.env.GH_HOST, "github.com");
  assert.equal(r.reconcile.env.GH_REPO, "oriontech-me/langflow-e2e");
  for (const secret of ["issue-token", "hooks.example.invalid", "x-access-token"]) {
    assert.ok(!recValues.includes(secret), `${secret} reached the reconciler`);
  }
  assert.deepEqual(Object.keys(r.reconcile.env).filter((k) => /^GIT_CONFIG/.test(k)), []);
  // The publisher has the destination's credentials, and not the source's.
  assert.equal(r.publish.env.GITHUB_TOKEN, "issue-token");
  assert.equal(r.publish.env.ISSUE_REPO, "o/r");
  assert.match(r.publish.env.SLACK_WEBHOOK_URL, /hooks\.example\.invalid/);
});

test("the clone is left as it was: same HEAD and status, no private ref, no extra worktree", () => {
  for (const reconcile of ["findings", "refuse", "trackerfail"]) {
    const r = orphans({ reconcile });
    assert.deepEqual(r.clone.after, r.clone.before, reconcile);
    assert.doesNotMatch(r.clone.refs, /refs\/e2e-orphans/, reconcile);
    assert.equal(r.clone.worktrees, 1, `${reconcile}: the run's worktree outlived it`);
  }
});

test("a dry run reconciles and stops: no issue, no Slack, no routine report, the report kept", () => {
  const r = orphans({ dryRun: true });
  assert.equal(r.status, 0, r.log);
  assert.match(r.last.REASON, /^dry run: 1 orphan\(s\), 2 finding\(s\) on [0-9a-f]{12}; the report is .*\/work\/report\.md$/);
  assert.equal(r.publish, null);
  assert.equal(r.last.REPORT, "none");
  assert.ok(existsSync(join(r.work, "report.md")), "the report was not kept");
});

test("a shallow clone is the machine's: failed before any walk", () => {
  const r = orphans({ shallow: true });
  assert.equal(r.last.STATUS, "failed");
  assert.match(r.last.REASON, /is shallow: the history walk needs the whole history$/);
  assert.equal(r.reconcile, null);
});

test("no source credential, or a second run while one is going, touches nothing", () => {
  const none = orphans({ token: "" });
  assert.equal(none.last.STATUS, "failed");
  assert.match(none.last.REASON, /^SOURCE_PUSH_TOKEN is not in the secrets file/);
  const busy = orphans({ runBusy: true });
  assert.equal(busy.last.STATUS, "skipped");
  assert.equal(busy.reconcile, null);
});
