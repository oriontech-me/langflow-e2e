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
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { verdict, remoteTip, main, EXIT_CURRENT, EXIT_BEHIND, EXIT_UNKNOWN } from "./check-mirror-freshness.mjs";
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

  const runIn = () => main({ SOURCE_REMOTE_URL: source, DESTINATION_REMOTE: "origin", MAX_LAG_MINUTES: "120" }, work);
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
