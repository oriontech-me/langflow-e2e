// Unit tests for scripts/check-mirror-freshness.mjs.
// Run with: npm run test:scripts
//
// What these protect: the one answer this check must never give by accident. "Current"
// is what lets a stale suite run unremarked, so every branch that CANNOT prove
// currency has to say so — an unreachable source, an unreadable destination, a tip of
// unknown age past the window. The 43 silent syncs of 2026-09-16..18 are what this
// exists for, and they produced no error anywhere: the sync did not fail, it just
// stopped pushing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  verdict,
  remoteTip,
  main,
  EXIT_CURRENT,
  EXIT_BEHIND,
  EXIT_UNKNOWN,
  EXIT_DIVERGED,
} from "./check-mirror-freshness.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 21, 8, 0, 0);

test("equal tips are current, and that is the only free pass", () => {
  const r = verdict({ sourceSha: "a".repeat(40), destSha: "a".repeat(40), now: NOW, maxLagMinutes: 120 });
  assert.equal(r.code, EXIT_CURRENT);
  assert.match(r.headline, /current at aaaaaaaa/);
});

test("a source that cannot be read is UNKNOWN, never current", () => {
  // The distinction the whole check is about: a network blip must not read as a clean
  // bill of health, because "fresh" is precisely the answer that hides a stale suite.
  const r = verdict({ sourceSha: null, destSha: "b".repeat(40), now: NOW, maxLagMinutes: 120 });
  assert.equal(r.code, EXIT_UNKNOWN);
  assert.match(r.headline, /UNKNOWN, which is not the same as current/);
});

test("a destination that cannot be read is UNKNOWN too", () => {
  const r = verdict({ sourceSha: "a".repeat(40), destSha: null, now: NOW, maxLagMinutes: 120 });
  assert.equal(r.code, EXIT_UNKNOWN);
});

test("behind but young is the ordinary window between a merge and the next push", () => {
  // The sync runs hourly. Alarming on a 12-minute-old difference would teach everyone
  // to ignore this check, which is worse than not having it.
  const r = verdict({
    sourceSha: "a".repeat(40),
    destSha: "b".repeat(40),
    oldestMissingAt: NOW - 12 * MINUTE,
    now: NOW,
    maxLagMinutes: 120,
    behindBy: 1,
  });
  assert.equal(r.code, EXIT_CURRENT);
  assert.match(r.headline, /1 commit\(s\) behind, 12 min old/);
});

test("behind and old is the stall, and it says what it costs", () => {
  const r = verdict({
    sourceSha: "a".repeat(40),
    destSha: "b".repeat(40),
    oldestMissingAt: NOW - 2 * 24 * 60 * MINUTE,
    now: NOW,
    maxLagMinutes: 120,
    behindBy: 41,
  });
  assert.equal(r.code, EXIT_BEHIND);
  assert.match(r.headline, /41 commit\(s\) behind/);
  // The consequence, in the words the comparison registry uses — a reader who sees
  // this must know the day is measured and not comparable, which is the whole lesson
  // of 17 and 18/09.
  assert.match(r.headline, /measured but NOT comparable/);
});

test("behind with a tip of unknown age does NOT get the young pass", () => {
  // Null when the source could not be walked at all — and a stall we cannot date is
  // still a stall, so it must not inherit the young-window pass.
  const r = verdict({
    sourceSha: "a".repeat(40),
    destSha: "b".repeat(40),
    oldestMissingAt: null,
    now: NOW,
    maxLagMinutes: 120,
    behindBy: null,
  });
  assert.equal(r.code, EXIT_BEHIND);
  assert.match(r.headline, /an unknown number of commit\(s\) behind/);
  assert.match(r.headline, /of unknown age/);
});

test("an unreachable remote reads as null rather than throwing", () => {
  const dir = makeTempDir("mirror-freshness-unreachable");
  assert.equal(remoteTip(join(dir, "there-is-no-repo-here"), "refs/heads/main", { cwd: dir }), null);
  rmSync(dir, { recursive: true, force: true });
});

test("end to end against two real repositories: current, then behind", () => {
  // The decision is a pure function above; this pins the plumbing that feeds it —
  // `ls-remote` parsing, the behind count and the tip's age — against real git.
  const dir = makeTempDir("mirror-freshness-e2e");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env });
  const source = join(dir, "source.git");
  const destination = join(dir, "destination.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", source], { env });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", destination], { env });
  execFileSync("git", ["clone", "-q", source, work], { env });
  mkdirSync(join(work, "x"), { recursive: true });
  writeFileSync(join(work, "x/a.txt"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "one");
  git(work, "push", "-q", "origin", "HEAD:main");
  git(work, "push", "-q", destination, "HEAD:main");
  git(work, "remote", "set-url", "origin", destination);

  // The isolated env goes to the CODE UNDER TEST too, not just to the test's own git
  // calls: `main` shells out to git, and inheriting the developer's global config lets
  // an `insteadOf` or a proxy decide what these assertions measure.
  const runIn = (extra = {}) =>
    main({ ...env, SOURCE_REMOTE_URL: source, DESTINATION_REMOTE: "origin", MAX_LAG_MINUTES: "120", ...extra }, work);
  assert.equal(runIn(), EXIT_CURRENT, "two identical tips read as behind");

  // The source moves and the mirror does not follow — the 43-run shape, with a commit
  // dated far enough back that the young-window pass cannot apply.
  writeFileSync(join(work, "x/a.txt"), "two\n");
  git(work, "add", "-A");
  execFileSync("git", ["commit", "-qm", "two"], {
    cwd: work,
    env: { ...env, GIT_AUTHOR_DATE: "2026-09-16T09:49:00Z", GIT_COMMITTER_DATE: "2026-09-16T09:49:00Z" },
  });
  git(work, "push", "-q", source, "HEAD:main");
  assert.equal(runIn(), EXIT_BEHIND, "a source that moved without the mirror read as current");

  rmSync(dir, { recursive: true, force: true });
});

test("an ordinary merge of an old branch is not a stall (#1948 review)", () => {
  // The finding that mattered, and it is about WHICH dates get read. `rev-list A..B`
  // includes everything a MERGE brought in, dated when the branch was written rather
  // than when it landed — and this repository merges with merge commits. Measured on
  // the last 25 merges of `main`: 12 carried a commit older than the 120 min window, so
  // half the merges would have declared the day not comparable for an hour, which is
  // the "everyone learns to ignore this" outcome the code warns about.
  const dir = makeTempDir("mirror-freshness-merge");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env });
  const source = join(dir, "source.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", source], { env });
  execFileSync("git", ["clone", "-q", source, work], { env });
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "one");
  git(work, "push", "-q", "origin", "HEAD:main");

  // The destination is a mirror of `main` as it stood BEFORE the merge.
  const destination = join(dir, "destination.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", destination], { env });
  git(work, "push", "-q", destination, "HEAD:main");

  // A branch written three days ago, merged into `main` just now — the ordinary shape.
  const old = { ...env, GIT_AUTHOR_DATE: "2026-09-18T09:00:00Z", GIT_COMMITTER_DATE: "2026-09-18T09:00:00Z" };
  git(work, "checkout", "-q", "-b", "feature");
  writeFileSync(join(work, "b.txt"), "branch work\n");
  execFileSync("git", ["add", "-A"], { cwd: work, env: old });
  execFileSync("git", ["commit", "-qm", "work written three days ago"], { cwd: work, env: old });
  git(work, "checkout", "-q", "main");
  git(work, "merge", "-q", "--no-ff", "-m", "Merge pull request #1 from feature", "feature");
  git(work, "push", "-q", source, "HEAD:main");
  git(work, "remote", "set-url", "origin", destination);

  const code = main(
    { ...env, SOURCE_REMOTE_URL: source, DESTINATION_REMOTE: "origin", MAX_LAG_MINUTES: "120" },
    work,
  );
  assert.equal(code, EXIT_CURRENT, "a merge that landed seconds ago was reported as a stall");
  rmSync(dir, { recursive: true, force: true });
});

test("a destination that is ahead is diverged, not behind", () => {
  // Different tips with nothing missing: the mirror holds what the source does not.
  // Reported as "0 commit(s) behind … of unknown age" before, which was both wrong and
  // indistinguishable from "could not walk the history".
  const r = verdict({
    sourceSha: "a".repeat(40),
    destSha: "b".repeat(40),
    oldestMissingAt: null,
    now: NOW,
    maxLagMinutes: 120,
    behindBy: 0,
  });
  assert.equal(r.code, EXIT_DIVERGED);
  assert.match(r.headline, /divergence, not lag/);
});

test("a window that is not a number falls back, loudly, instead of disabling itself", () => {
  // `Number("18O")` is NaN and every comparison with it is false, so the young-window
  // branch becomes unreachable and the output reads "past the NaN min window".
  const dir = makeTempDir("mirror-freshness-nan");
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    main({ SOURCE_REMOTE_URL: join(dir, "nope"), DESTINATION_REMOTE: join(dir, "nope"), MAX_LAG_MINUTES: "18O" }, dir);
  } finally {
    console.log = log;
  }
  assert.ok(
    lines.some((l) => /is not a number of minutes — using 120/.test(l)),
    `the bad window was accepted silently:\n${lines.join("\n")}`,
  );
  assert.ok(!lines.some((l) => /NaN/.test(l)), "NaN reached the output");
  rmSync(dir, { recursive: true, force: true });
});

test("run as a script from a path that needs escaping, it still speaks", () => {
  // A `file://${argv[1]}` guard stops matching on a percent-encoded path or a symlinked
  // ancestor, and the failure is SILENT: no output, exit 0 — which reads exactly like
  // "the mirror is current". The same trap `check-run-integrity.mjs` documents.
  const dir = makeTempDir("mirror freshness spaced");
  const copy = join(dir, "check-mirror-freshness.mjs");
  writeFileSync(copy, readFileSync(join(dirname(fileURLToPath(import.meta.url)), "check-mirror-freshness.mjs")));
  // `spawnSync`, because a working script EXITS NON-ZERO here — unreadable remotes are
  // UNKNOWN — and that is the outcome being asserted, not an error.
  const r = spawnSync(process.execPath, [copy], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, SOURCE_REMOTE_URL: join(dir, "nope"), DESTINATION_REMOTE: join(dir, "nope") },
  });
  assert.match(r.stdout, /\[mirror\] UNKNOWN/, `the script said nothing at all:\n${JSON.stringify(r.stdout)}`);
  assert.equal(r.status, EXIT_UNKNOWN, "silence with exit 0 is what this test exists to catch");
  rmSync(dir, { recursive: true, force: true });
});

test("a destination that really diverged is reported as diverged, not as behind", () => {
  // `EXIT_DIVERGED` was unreachable in the deployed shape: the destination's tip is a
  // local object only while it is an ancestor of the source, so in the one case the
  // verdict exists for — a commit written straight to the mirror — `rev-list` died
  // with "bad revision", the catch swallowed it, and the answer became "behind by an
  // unknown number", the opposite of the truth. Both tips are fetched now.
  const dir = makeTempDir("mirror-freshness-diverged");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env });
  const source = join(dir, "source.git");
  const destination = join(dir, "destination.git");
  const work = join(dir, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", source], { env });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", destination], { env });
  execFileSync("git", ["clone", "-q", source, work], { env });
  writeFileSync(join(work, "a.txt"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "one");
  git(work, "push", "-q", "origin", "HEAD:main");

  // Someone writes straight to the mirror — the thing the sync guard exists to catch.
  writeFileSync(join(work, "b.txt"), "written on the mirror\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "a commit the source has never seen");
  git(work, "push", "-q", destination, "HEAD:main");
  git(work, "reset", "-q", "--hard", "HEAD~1");
  git(work, "remote", "set-url", "origin", destination);

  const code = main({ ...env, SOURCE_REMOTE_URL: source, DESTINATION_REMOTE: "origin" }, work);
  assert.equal(code, EXIT_DIVERGED, "a mirror written to directly was reported as merely old");
  rmSync(dir, { recursive: true, force: true });
});

test("both sides resolving to the same repository cannot answer 'current'", () => {
  // A dev clone made straight from the source would compare the source with itself and
  // answer "current" forever — the one answer this module must never give by accident.
  const dir = makeTempDir("mirror-freshness-same");
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const repo = join(dir, "r.git");
  const work = join(dir, "w");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", repo], { env });
  execFileSync("git", ["clone", "-q", repo, work], { env });
  writeFileSync(join(work, "a.txt"), "one\n");
  execFileSync("git", ["add", "-A"], { cwd: work, env });
  execFileSync("git", ["commit", "-qm", "one"], { cwd: work, env });
  execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: work, env });

  assert.equal(
    main({ ...env, SOURCE_REMOTE_URL: repo, DESTINATION_REMOTE: "origin" }, work),
    EXIT_UNKNOWN,
    "a clone pointed at one repository twice reported the mirror as current",
  );
  rmSync(dir, { recursive: true, force: true });
});
