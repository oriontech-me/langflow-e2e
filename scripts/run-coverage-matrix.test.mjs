// Unit tests for ops/vm/run-coverage-matrix.sh, the coverage-matrix routine (stage 3,
// task 7). Run with: npm run test:scripts
//
// The source is a real git repository on disk (a bare one, reached by path), so the
// fetch, the plumbing commit and the push are git's own, and a refused push is a real
// non-fast-forward. The repository's refresh and feed scripts are replaced by fakes that
// answer from a control file. What these pin is what one green day on the machine would
// not show: a red that is the repository's and a failure that is the machine's, the
// retry when main moves under the push, the clone left untouched, and no credential
// reaching the repository's own code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "ops", "vm", "run-coverage-matrix.sh");
const q = JSON.stringify;
const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const kv = (text) =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const GIT_ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ID } }).trim();
const HEATMAP = "docs/coverage-heatmap";

/**
 * refresh: "same" (writes what is committed) | "change" (moves data.json and the feed)
 *        | "fail" (exits 1)
 * check:   "ok" | "fail"     the feed check
 * moveOnce: main gets one more commit during the first refresh, so the first push is refused
 * post:    null (endpoint not configured) | HTTP code the fake curl answers
 * token:   the push credential in the secrets file, or "" for none
 */
function matrix({ refresh = "same", check = "ok", moveOnce = false, post = null, token = "push-token", dryRun = false, heavyBusy = false, sourceUrl = null } = {}) {
  const dir = makeTempDir("run-coverage-matrix-");
  const control = join(dir, "control.json");
  writeFileSync(control, q({ refresh, check, moveOnce, moved: false }));

  // The source: one commit with the matrix and fake scripts behind the npm names.
  const seed = join(dir, "seed");
  mkdirSync(join(seed, HEATMAP), { recursive: true });
  writeFileSync(join(seed, HEATMAP, "data.json"), '{"refreshed":"2026-10-01"}\n');
  writeFileSync(join(seed, HEATMAP, "dashboard-feed.json"), '{"feed":1}\n');
  writeFileSync(join(seed, HEATMAP, "history.jsonl"), '{"refreshed":"2026-10-01"}\n');
  writeFileSync(join(seed, "README.md"), "source\n");
  writeFileSync(
    join(seed, "package.json"),
    q({ name: "fixture", private: true, scripts: { "coverage:refresh": "node fake-refresh.mjs", "coverage:feed": "node fake-feed.mjs" } }),
  );
  const helper = join(dir, "helper");
  writeFileSync(
    join(seed, "fake-refresh.mjs"),
    `import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const c = JSON.parse(readFileSync(${q(control)}, "utf8"));
writeFileSync(${q(join(dir, "refresh-env.json"))}, JSON.stringify(process.env));
if (c.refresh === "fail") { console.error("refreshAreas: a judged axis would change"); process.exit(1); }
if (c.moveOnce && !c.moved) {
  c.moved = true; writeFileSync(${q(control)}, JSON.stringify(c));
  const env = { ...process.env, ${Object.entries(GIT_ID).map(([k, v]) => `${k}: ${q(v)}`).join(", ")} };
  execFileSync("git", ["-C", ${q(helper)}, "commit", "-q", "--allow-empty", "-m", "someone else"], { env });
  execFileSync("git", ["-C", ${q(helper)}, "push", "-q", "origin", "HEAD:main"], { env });
}
if (c.refresh === "change") {
  writeFileSync("${HEATMAP}/data.json", '{"refreshed":"2026-10-07"}\\n');
  writeFileSync("${HEATMAP}/dashboard-feed.json", '{"feed":2}\\n');
}
`,
  );
  writeFileSync(
    join(seed, "fake-feed.mjs"),
    `import { readFileSync } from "node:fs";
const c = JSON.parse(readFileSync(${q(control)}, "utf8"));
if (process.argv.includes("--check") && c.check === "fail") { console.error("dashboard-feed.json disagrees with data.json"); process.exit(1); }
`,
  );
  git(dir, "init", "-q", "-b", "main", seed);
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  const bare = join(dir, "source.git");
  git(dir, "clone", "-q", "--bare", seed, bare);
  git(dir, "clone", "-q", bare, helper);

  // The clone the routine lives in: the destination's mirror, here a clone of the source,
  // with the library, the report stub and an installed node_modules.
  const repo = join(dir, "repo");
  git(dir, "clone", "-q", bare, repo);
  for (const rel of ["ops/vm/lib/routine.sh"]) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(repo, rel));
  }
  mkdirSync(join(repo, "node_modules"));
  mkdirSync(join(repo, "scripts"));
  const reportOut = join(dir, "report.out");
  writeFileSync(join(repo, "scripts", "routine-report.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${q(reportOut)}, process.argv.slice(2).join(" "));\n`);
  const cloneBefore = { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain") };

  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  stub(bin, "systemctl", "echo inactive");
  stub(bin, "flock", `exit ${heavyBusy ? 1 : 0}`);
  const curlLog = join(dir, "curl.log");
  // The fake platform: records its argv and the headers file it was handed (read while it
  // still exists), and answers the configured code.
  stub(
    bin,
    "curl",
    `echo "ARGV $*" >> ${q(curlLog)}
for a in "$@"; do case "$a" in @*) [ -f "\${a#@}" ] && sed 's/^/HDR /' "\${a#@}" >> ${q(curlLog)} ;; esac; done
printf '%s' ${q(String(post ?? "000"))}
[ ${q(String(post ?? "000"))} = 000 ] && exit 7 || exit 0`,
  );

  const secrets = join(dir, "secrets.env");
  writeFileSync(
    secrets,
    [
      token ? `export SOURCE_PUSH_TOKEN=${token}` : "",
      post !== null ? "export QA_COVERAGE_MATRIX_ENDPOINT=https://platform.example.invalid/matrix" : "",
      "export QA_E2E_AUTOMATION_TOKEN=bearer-secret",
      "export GITHUB_TOKEN=issue-token",
    ].join("\n") + "\n",
  );
  const lane = join(dir, "lane.env");
  writeFileSync(lane, "ISSUE_HOST=h\nISSUE_REPO=o/r\nISSUE_CC=\n");
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
      E2E_ROUTINE_NOW: "3 1500",
      E2E_ROUTINE_POLL_S: "0",
      SOURCE_REMOTE_URL: sourceUrl ?? bare,
      MATRIX_DRY_RUN: dryRun ? "1" : "0",
    },
  });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const last = readIf(join(state, "coverage-matrix", "last.env"));
  return {
    status: r.status,
    last: last ? kv(last) : {},
    log: readIf(join(dir, "log", "e2e-coverage-matrix", "latest.log")) ?? `${r.stdout}${r.stderr}`,
    source: (...args) => git(bare, ...args),
    seedSha: git(seed, "rev-parse", "HEAD"),
    helperSha: () => git(helper, "rev-parse", "HEAD"),
    clone: { before: cloneBefore, after: { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain") }, refs: git(repo, "for-each-ref", "--format=%(refname)") },
    refreshEnv: readIf(join(dir, "refresh-env.json")) ? JSON.parse(readIf(join(dir, "refresh-env.json"))) : null,
    curl: readIf(curlLog) ?? "",
    report: readIf(reportOut),
    tree: join(state, "coverage-matrix", "work", "tree"),
  };
}

test("nothing moved: green, already current, and nothing is pushed", () => {
  const r = matrix({ refresh: "same" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
  assert.match(r.last.REASON, /^already current on main at [0-9a-f]{12}$/);
  assert.equal(r.source("rev-parse", "main"), r.seedSha);
  assert.equal(r.last.CHANGED, "");
});

test("moved: one commit on top of main with only the matrix files, as the VM robot", () => {
  const r = matrix({ refresh: "change" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
  assert.match(r.last.REASON, /^refreshed: 2 file\(s\) committed as [0-9a-f]{12} on top of [0-9a-f]{12}$/);
  assert.equal(r.source("rev-parse", "main^"), r.seedSha, "the commit's parent is the fetched main");
  assert.equal(r.source("rev-parse", "main"), r.last.COMMIT);
  assert.deepEqual(r.source("diff-tree", "--no-commit-id", "--name-only", "-r", "main").split("\n"), [`${HEATMAP}/dashboard-feed.json`, `${HEATMAP}/data.json`]);
  assert.equal(r.source("log", "-1", "--format=%an <%ae>|%cn|%s", "main"), "langflow-e2e vm routine <langflow-e2e-vm@users.noreply.github.com>|langflow-e2e vm routine|chore(coverage-matrix): refresh derivable axes (vm) [skip ci]");
  assert.equal(r.source("show", `main:${HEATMAP}/data.json`), '{"refreshed":"2026-10-07"}');
  assert.equal(r.last.CHANGED, `${HEATMAP}/dashboard-feed.json,${HEATMAP}/data.json`);
});

test("the clone is never touched: same HEAD, same status, and the private ref is gone", () => {
  for (const refresh of ["change", "fail"]) {
    const r = matrix({ refresh });
    assert.deepEqual(r.clone.after, r.clone.before, refresh);
    assert.doesNotMatch(r.clone.refs, /refs\/e2e-matrix/, refresh);
  }
});

test("main moves under the push: refused once, recomputed on the new tip, pushed there", () => {
  const r = matrix({ refresh: "change", moveOnce: true });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
  assert.match(r.log, /the push was refused: main moved since/);
  assert.equal(r.source("rev-parse", "main^"), r.helperSha(), "built on the commit that moved main, not on the first fetch");
  assert.equal(r.source("log", "-1", "--format=%s", "main^"), "someone else");
});

test("a refresh that fails is red, with its words, and nothing is pushed", () => {
  const r = matrix({ refresh: "fail" });
  assert.equal(r.status, 1, r.log);
  assert.equal(r.last.STATUS, "red");
  assert.match(r.last.REASON, /^npm run coverage:refresh failed on [0-9a-f]{12}: .*refreshAreas: a judged axis would change/);
  assert.equal(r.source("rev-parse", "main"), r.seedSha);
  assert.match(r.report ?? "", /^verdict /, "a red is reported");
});

test("a feed that disagrees with the data after the refresh is red", () => {
  const r = matrix({ refresh: "change", check: "fail" });
  assert.equal(r.status, 1, r.log);
  assert.equal(r.last.STATUS, "red");
  assert.match(r.last.REASON, /^the feed disagrees with data\.json after the refresh/);
  assert.equal(r.source("rev-parse", "main"), r.seedSha);
});

test("no push credential, or a source that cannot be read, is the machine's: failed", () => {
  const none = matrix({ token: "" });
  assert.equal(none.status, 3, none.log);
  assert.equal(none.last.STATUS, "failed");
  assert.match(none.last.REASON, /SOURCE_PUSH_TOKEN is not in the secrets file/);
  const gone = matrix({ sourceUrl: "/nonexistent/source.git" });
  assert.equal(gone.status, 3, gone.log);
  assert.equal(gone.last.STATUS, "failed");
  assert.match(gone.last.REASON, /could not read main from the source/);
});

test("no credential reaches the repository's own refresh", () => {
  const r = matrix({ refresh: "change", post: 201 });
  assert.ok(r.refreshEnv, "the refresh did not run");
  // By value: whatever a credential is called, its value must not be there.
  const values = Object.values(r.refreshEnv).join("\n");
  for (const secret of ["push-token", "bearer-secret", "issue-token", "x-access-token"]) {
    assert.ok(!values.includes(secret), `${secret} reached the refresh`);
  }
  assert.deepEqual(Object.keys(r.refreshEnv).filter((k) => /^GIT_CONFIG/.test(k)), []);
});

test("a dry run computes and stops: no push, no POST, the tree kept and the files named", () => {
  const r = matrix({ refresh: "change", post: 201, dryRun: true });
  assert.equal(r.status, 0, r.log);
  assert.match(r.last.REASON, /^dry run: would commit 2 file\(s\) on top of [0-9a-f]{12} \(docs\/coverage-heatmap\/dashboard-feed\.json docs\/coverage-heatmap\/data\.json\)/);
  assert.equal(r.source("rev-parse", "main"), r.seedSha);
  assert.equal(r.curl, "");
  assert.equal(r.last.PLATFORM, "dry-run");
  assert.ok(existsSync(join(r.tree, HEATMAP, "data.json")), "the tree was not kept");
});

test("a dry run reports nothing, green or red: no issue closed or opened, no Slack", () => {
  for (const refresh of ["change", "fail"]) {
    const r = matrix({ refresh, dryRun: true });
    assert.equal(r.report, null, `${refresh}: the dry run reached the report`);
    assert.equal(r.last.REPORT, "none", refresh);
  }
});

test("the platform: not configured is said and quiet; sent records the code", () => {
  const off = matrix({ refresh: "change" });
  assert.equal(off.last.PLATFORM, "not-configured");
  assert.equal(off.last.ALARM, undefined);
  assert.equal(off.curl, "");
  const on = matrix({ refresh: "change", post: 201 });
  assert.equal(on.last.PLATFORM, "sent (201)");
  assert.equal(on.last.ALARM, undefined);
  assert.match(on.curl, /ARGV .*-X POST https:\/\/platform\.example\.invalid\/matrix/);
  assert.match(on.curl, /--data-binary @.*docs\/coverage-heatmap\/dashboard-feed\.json/);
  assert.match(on.curl, /^HDR Authorization: Bearer bearer-secret$/m, "the bearer was not in the headers file");
  assert.doesNotMatch(on.curl.split("\n").filter((l) => l.startsWith("ARGV")).join("\n"), /bearer-secret/, "the bearer is on curl's argv");
  const current = matrix({ refresh: "same", post: 200 });
  assert.equal(current.last.PLATFORM, "sent (200)", "an already-current matrix is still sent");
});

test("a refused POST keeps the day green and leaves an ALARM for the watchdog", () => {
  const r = matrix({ refresh: "change", post: 500 });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
  assert.equal(r.last.PLATFORM, "failed (500)");
  assert.match(r.last.ALARM, /^the coverage matrix is current on main, but the QA platform refused its feed: HTTP 500/);
});

test("it takes no heavy-lane lock: a busy one does not hold it back", () => {
  const r = matrix({ refresh: "change", heavyBusy: true });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.last.STATUS, "green");
});
