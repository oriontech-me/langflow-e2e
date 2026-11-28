// Unit tests for ops/mirror/sync-mirror.sh, the mirror sync moved from a laptop to the
// QA VM (#2041). Run with: npm run test:scripts
//
// Real git, three local repositories: a SOURCE with commits, the bare MIRROR the script
// keeps, and a bare DESTINATION. Every refusal of the guard gets a case, as the issue
// asks, and each asserts what reached the destination — not only the exit code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../ops/mirror/sync-mirror.sh", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** A source with main and a feature branch, an empty bare destination, and no mirror yet. */
function setup() {
  const root = makeTempDir("mirror-sync-");
  const source = join(root, "source");
  mkdirSync(source);
  git(source, "init", "-q", "-b", "main");
  writeFileSync(join(source, "a.txt"), "1\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "one");
  git(source, "checkout", "-q", "-b", "feature");
  writeFileSync(join(source, "b.txt"), "2\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "two");
  git(source, "checkout", "-q", "main");
  git(source, "tag", "v1");
  const dest = join(root, "dest.git");
  git(root, "init", "-q", "--bare", "dest.git");
  return { root, source, dest, mirror: join(root, "mirror", "m.git") };
}

const sync = (ctx, env = {}) =>
  spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, MIRROR_DIR: ctx.mirror, SOURCE_URL: ctx.source, DEST_URL: ctx.dest, CREDENTIAL_HELPER: "", MIRROR_LOCK: join(ctx.root, "lock"), LANE_FILE: join(ctx.root, "no-lane"), ...env },
  });
const refs = (repo) => git(repo, "for-each-ref", "--format=%(refname) %(objectname:short)").split("\n").filter(Boolean).sort();
const head = (repo, ref) => git(repo, "rev-parse", ref);

test("the first run creates the mirror and pushes every branch and tag", () => {
  const ctx = setup();
  const r = sync(ctx);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /creating the mirror/);
  assert.match(r.stdout, /3 ref\(s\) changed; main=\w+ \(status=changes_applied\)/);
  assert.equal(head(ctx.dest, "refs/heads/main"), head(ctx.source, "main"));
  assert.equal(head(ctx.dest, "refs/heads/feature"), head(ctx.source, "feature"));
  assert.equal(head(ctx.dest, "refs/tags/v1"), head(ctx.source, "v1"));
  // Heads and tags only: nothing else from the source becomes a destination ref.
  assert.deepEqual(git(ctx.mirror, "config", "--get-all", "remote.origin.fetch").split("\n"), ["+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"]);
  // A second run has nothing to do, and says so.
  const again = sync(ctx);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /up to date; main=\w+ \(status=up_to_date\)/);
});

test("a merge on the source reaches the destination on the next run, fast-forwarded", () => {
  const ctx = setup();
  sync(ctx);
  writeFileSync(join(ctx.source, "c.txt"), "3\n");
  git(ctx.source, "add", ".");
  git(ctx.source, "commit", "-q", "-m", "three");
  const r = sync(ctx);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /1 ref\(s\) changed/, "a fast-forward counts as a change");
  assert.equal(head(ctx.dest, "refs/heads/main"), head(ctx.source, "main"));
});

test("a failed fetch aborts before anything is pushed (the prune would delete good branches)", () => {
  const ctx = setup();
  sync(ctx);
  const before = refs(ctx.dest);
  const r = sync(ctx, { SOURCE_URL: join(ctx.root, "nowhere") });
  // The mirror's origin is set at creation; a source gone dark is the fetch failing.
  git(ctx.mirror, "remote", "set-url", "origin", join(ctx.root, "nowhere"));
  const gone = sync(ctx);
  assert.equal(gone.status, 1, gone.stdout);
  assert.match(gone.stdout, /ABORTED: the fetch from the source failed; nothing was pushed \(status=fetch_failed\)/);
  assert.deepEqual(refs(ctx.dest), before);
  assert.equal(r.status, 0, "SOURCE_URL only seeds a new mirror; an existing one keeps its origin");
});

test("a destination the listing cannot reach aborts with nothing pushed", () => {
  const ctx = setup();
  const r = sync(ctx, { DEST_URL: join(ctx.root, "no-such-dest.git") });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /ABORTED: listing the destination failed; nothing was pushed \(status=verify_failed\)/);
});

test("a commit born on the destination is never overwritten, unless ALLOW_OVERWRITE=1 says so", () => {
  const ctx = setup();
  sync(ctx);
  // Someone pushes straight to the destination: a commit the mirror has never seen.
  const clone = join(ctx.root, "dest-work");
  git(ctx.root, "clone", "-q", ctx.dest, "dest-work");
  git(clone, "checkout", "-q", "main");
  writeFileSync(join(clone, "x.txt"), "born on the destination\n");
  git(clone, "add", ".");
  git(clone, "commit", "-q", "-m", "work made on the destination");
  git(clone, "push", "-q", "origin", "main");
  const theirs = head(ctx.dest, "refs/heads/main");

  const r = sync(ctx);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /DIVERGENCE on the destination:\n {2}refs\/heads\/main -> \w+ \(a commit the mirror has never seen\)/);
  assert.match(r.stdout, /status=diverged/);
  assert.equal(head(ctx.dest, "refs/heads/main"), theirs, "the destination's work survives");

  const dry = sync(ctx, { DRY_RUN: "1" });
  assert.equal(dry.status, 2, "a dry run refuses the same divergence");

  const forced = sync(ctx, { ALLOW_OVERWRITE: "1" });
  assert.equal(forced.status, 0, forced.stdout);
  assert.match(forced.stdout, /ALLOW_OVERWRITE=1: pushing over the divergence above/);
  assert.equal(head(ctx.dest, "refs/heads/main"), head(ctx.source, "main"));
});

test("an orphan — a branch deleted on the source after a squash — is pruned, not refused", () => {
  const ctx = setup();
  sync(ctx);
  // The feature branch merged by squash and deleted on the source: its commit is still
  // in the mirror's objects, and no ref reaches it any more.
  git(ctx.source, "branch", "-q", "-D", "feature");
  const r = sync(ctx);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /orphan refs on the destination \(pruned unless the run stops: .*\):\n {2}refs\/heads\/feature -> \w+/);
  assert.ok(!refs(ctx.dest).some((l) => l.startsWith("refs/heads/feature ")), "pruned from the destination");
});

test("DRY_RUN=1 fetches and verifies, and pushes nothing", () => {
  const ctx = setup();
  const r = sync(ctx, { DRY_RUN: "1" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /DRY_RUN=1: the verification passed; nothing was pushed \(status=dry_run, main=\w+\)/);
  assert.deepEqual(refs(ctx.dest), []);
  assert.ok(existsSync(ctx.mirror), "the mirror itself is kept current");
});

test("bad switches and no destination are refused; a held lock ends the run quietly", () => {
  const ctx = setup();
  for (const [env, why] of [
    [{ DRY_RUN: "yes" }, /DRY_RUN must be 0 or 1, got 'yes'/],
    [{ ALLOW_OVERWRITE: "true" }, /ALLOW_OVERWRITE must be 0 or 1/],
    [{ DEST_URL: "" }, /no destination: set DEST_URL, or ISSUE_HOST and ISSUE_REPO in /],
  ]) {
    const r = sync(ctx, env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.stdout, why);
  }
  // The destination from the lane file, as the VM names it (no .git suffix, #2332).
  writeFileSync(join(ctx.root, "lane"), "ISSUE_HOST=ghe.example.invalid\nISSUE_REPO=org/repo\n");
  const lane = sync(ctx, { DEST_URL: "", LANE_FILE: join(ctx.root, "lane"), DRY_RUN: "1" });
  assert.match(lane.stdout, /-> https:\/\/ghe\.example\.invalid\/org\/repo$/m);
  assert.equal(lane.status, 1, "that host does not answer: verify_failed, nothing pushed");

  if (spawnSync("bash", ["-c", "command -v flock"]).status === 0) {
    const held = spawnSync("bash", ["-c", `exec 9> "$1"; flock 9; bash "$2"`, "x", join(ctx.root, "lock"), SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, MIRROR_DIR: ctx.mirror, SOURCE_URL: ctx.source, DEST_URL: ctx.dest, CREDENTIAL_HELPER: "", MIRROR_LOCK: join(ctx.root, "lock") },
    });
    assert.equal(held.status, 0);
    assert.match(held.stdout, /another sync is still running; this one ends/);
  }
});

test("the destination's credential is only the helper this repository ships", () => {
  // A personal token in root's git configuration must never be what pushes (#2490): the
  // calls that reach the destination reset git's helper list and name this one, and the
  // fetch from the public source carries no credential at all.
  const ctx = setup();
  const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(ctx.root, "bin");
  mkdirSync(bin);
  const calls = join(ctx.root, "git-calls.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const helper = join(ctx.root, "helper.sh");
  writeFileSync(helper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const r = sync(ctx, { CREDENTIAL_HELPER: helper, PATH: `${bin}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(calls, "utf8").split("\n");
  const withHelper = (l) => l.includes(`-c credential.helper= -c credential.helper=${helper}`);
  for (const verb of [" ls-remote ", " push "]) {
    const line = lines.find((l) => l.includes(verb));
    assert.ok(line && withHelper(line), `${verb.trim()} must carry only this repository's helper: ${line}`);
  }
  assert.ok(!withHelper(lines.find((l) => l.includes(" fetch ")) || ""), "the source fetch carries none");
  // By default, the helper the #2518 minting ships.
  assert.match(readFileSync(SCRIPT, "utf8"), /CREDENTIAL_HELPER="\$\{CREDENTIAL_HELPER-\$REPO\/scripts\/git-credential-destination\.sh\}"/);
});

test("a new mirror against a destination another writer filled refuses a branch the source has dropped, and loses nothing", () => {
  // The cutover: the laptop pushed `feature`, then the branch was deleted on the source.
  // A FRESH mirror never fetched its commits, so they read as born on the destination —
  // a refusal (the unit's comment says how to seed the mirror to avoid it), never a prune.
  const ctx = setup();
  const laptop = join(ctx.root, "laptop.git");
  git(ctx.root, "clone", "-q", "--bare", ctx.source, "laptop.git");
  git(laptop, "push", "-q", "--mirror", ctx.dest);
  git(ctx.source, "branch", "-q", "-D", "feature");
  const featureOnDest = head(ctx.dest, "refs/heads/feature");
  const r = sync(ctx);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stdout, /refs\/heads\/feature -> \w+ \(a commit the mirror has never seen\)/);
  assert.equal(head(ctx.dest, "refs/heads/feature"), featureOnDest, "nothing was pruned");
});

test("a branch created on the destination at a known commit is named before the prune deletes it", () => {
  const ctx = setup();
  sync(ctx);
  git(ctx.dest, "update-ref", "refs/heads/made-on-dest", head(ctx.dest, "refs/heads/main"));
  const dry = sync(ctx, { DRY_RUN: "1" });
  assert.match(dry.stdout, /WARNING: refs on the destination that the source does not name \(would be pruned unless the run stops .*\):\n {2}refs\/heads\/made-on-dest -> \w+/);
  assert.ok(refs(ctx.dest).some((l) => l.startsWith("refs/heads/made-on-dest ")), "a dry run deletes nothing");
  const r = sync(ctx);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /\(pruned unless the run stops/);
  assert.ok(!refs(ctx.dest).some((l) => l.startsWith("refs/heads/made-on-dest ")), "the laptop's behaviour: pruned, now with its name in the journal");
});

test("an emptied source never empties the destination", () => {
  const ctx = setup();
  sync(ctx);
  const before = refs(ctx.dest);
  const empty = join(ctx.root, "empty.git");
  git(ctx.root, "init", "-q", "--bare", "empty.git");
  git(ctx.mirror, "remote", "set-url", "origin", empty);
  const r = sync(ctx);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /ABORTED: the mirror has no main after the fetch — an empty source would empty the destination/);
  assert.deepEqual(refs(ctx.dest), before);
});

test("the lane file gives the destination and nothing else; a missing helper is said plainly", () => {
  const ctx = setup();
  writeFileSync(join(ctx.root, "lane"), "ISSUE_HOST=ghe.example.invalid\nISSUE_REPO=org/repo\nDRY_RUN=0\nALLOW_OVERWRITE=1\n");
  // DRY_RUN=1 from the unit survives a DRY_RUN=0 in the lane file: the listing of the
  // unreachable host fails, and the run never got as far as deciding to push.
  const r = sync(ctx, { DEST_URL: "", LANE_FILE: join(ctx.root, "lane"), DRY_RUN: "1" });
  assert.match(r.stdout, /sync started \(dry_run=1\) -> https:\/\/ghe\.example\.invalid\/org\/repo$/m);
  assert.equal(r.status, 1);
  const missing = sync(ctx, { CREDENTIAL_HELPER: join(ctx.root, "no-helper.sh") });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /the credential helper .*no-helper\.sh is not there or not executable/);
});
