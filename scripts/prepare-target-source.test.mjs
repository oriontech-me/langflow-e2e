// Unit tests for scripts/prepare-target-source.sh.
// Run with: npm run test:scripts
//
// What these protect: the properties that keep "the target is on the commit the CI
// tests" from becoming a claim instead of a fact. Almost every one of them fails
// GREEN if it breaks — a lane that runs against the wrong build still reports a
// verdict, and the verdict looks like a product result.
//
//   - Being TOLD the target, never guessing it. No sha and no ref is a refusal, an
//     absent commit is a refusal, and `main` is a refusal in all three inputs:
//     upstream's nightly builds the newest release-X.Y.Z branch, so a clone on main
//     tests something the CI never tests. A fallback here would put changelog into
//     the divergence list, which is the failure the whole step exists to remove.
//   - The tool check happens BEFORE the checkout. A missing npm found after the move
//     leaves the clone on the new commit with the old build — neither where it was
//     nor where it was going — and that state is one the starter has to refuse.
//   - The stamp dies before the build and is written only after the served
//     index.html exists. A stamp that outlives the assets it describes is a
//     confident wrong answer: the starter would trust it and serve an old UI.
//   - A rebuild is skipped only when the stamp AGREES with HEAD. Existence of assets
//     is not provenance.
//   - stdout carries only key=value, so the orchestrator can capture the summary
//     without parsing prose.
//
// git is REAL here — the checkout, the verification and the dirty check are the
// behaviour under test, and stubbing git would only test the stub. make, uv and npm
// are stubbed through a PATH shim, so nothing is downloaded and nothing is built.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "prepare-target-source.sh");
const STAMP_NAME = ".langflow-e2e-build-stamp";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * A real two-commit clone, plus a PATH shim for the build tools.
 *
 * `frontendBuilt` writes the served index.html WITHOUT a stamp, which is the state
 * every existing clone is in the first time the preparer runs on it.
 */
function setup({
  frontendBuilt = true,
  stampSha = null,
  dirty = false,
  stampOnlyDirt = false,
  withNpm = true,
  withUv = true,
  makeMode = "ok", // ok | fail-deps | fail-frontend | ok-without-assets
} = {}) {
  const dir = makeTempDir("prepare-target-source-test-");
  const bin = join(dir, "bin");
  const npmBin = join(dir, "npm-bin");
  const uvBin = join(dir, "uv-bin");
  const repo = join(dir, "clone");
  for (const d of [bin, npmBin, uvBin, repo]) mkdirSync(d, { recursive: true });

  execFileSync("git", ["init", "--quiet", "-b", "release-1.12.0", repo]);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  // Upstream gitignores the served frontend directory, and the real clone on the
  // target reports a clean tree WITH a build in it because of that. Without this the
  // fixture's own build would read as somebody's uncommitted work.
  writeFileSync(join(repo, ".gitignore"), "src/backend/base/langflow/frontend/\n");
  writeFileSync(join(repo, "README"), "old\n");
  git(repo, "add", "README", ".gitignore");
  git(repo, "commit", "--quiet", "-m", "old");
  const oldSha = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "README"), "new\n");
  git(repo, "commit", "--quiet", "-am", "new");
  const newSha = git(repo, "rev-parse", "HEAD");
  // Back to the old commit: the interesting starting point is "behind", like the
  // machine this step was written for.
  git(repo, "checkout", "--quiet", oldSha);

  const fe = join(repo, "src/backend/base/langflow/frontend");
  if (frontendBuilt) {
    mkdirSync(fe, { recursive: true });
    writeFileSync(join(fe, "index.html"), "<!doctype html>");
  }
  if (stampSha) writeFileSync(join(repo, STAMP_NAME), `sha=${stampSha}\nref=whatever\n`);
  // Untracked on purpose. A MODIFIED tracked file makes git itself refuse the
  // checkout, so PREPARE_ALLOW_DIRTY would appear not to work when what actually
  // happened is git protecting the edit — a different property, and git's, not ours.
  if (dirty) writeFileSync(join(repo, "scratch-work.txt"), "someone's work in progress\n");
  if (stampOnlyDirt) writeFileSync(join(repo, STAMP_NAME), `sha=${oldSha}\n`);

  const makeLog = join(dir, "make.log");
  const uvLog = join(dir, "uv.log");
  // `-n install_backend` is how the script asks whether the target exists; answering
  // 0 sends it down the Makefile path, which is what the target machine has.
  writeFileSync(
    join(bin, "make"),
    `#!/usr/bin/env bash
echo "$*" >> "${makeLog}"
for a in "$@"; do
  case "$a" in
    -n) exit 0 ;;
    install_backend) ${makeMode === "fail-deps" ? "exit 1" : "exit 0"} ;;
    install_frontend) exit 0 ;;
    build_frontend)
      ${makeMode === "fail-frontend" ? "exit 1" : ""}
      ${makeMode === "ok-without-assets" ? "exit 0" : `mkdir -p "${fe}" && echo built > "${fe}/index.html"`}
      exit 0 ;;
  esac
done
exit 0
`,
  );
  writeFileSync(join(uvBin, "uv"), `#!/usr/bin/env bash\necho "$*" >> "${uvLog}"\nexit 0\n`);
  writeFileSync(join(npmBin, "npm"), `#!/usr/bin/env bash\nexit 0\n`);
  chmodSync(join(bin, "make"), 0o755);
  chmodSync(join(uvBin, "uv"), 0o755);
  chmodSync(join(npmBin, "npm"), 0o755);

  return { dir, repo, bin, npmBin, uvBin, oldSha, newSha, makeLog, uvLog, fe, withNpm, withUv };
}

function run(ctx, env = {}) {
  // The shim comes first, and the real PATH last so git and coreutils still resolve.
  // Dropping npm or uv means dropping only its directory: with the caller's PATH in
  // front, a real npm on the machine would answer `command -v` and the branch under
  // test would never run.
  const parts = [ctx.bin];
  if (ctx.withUv) parts.push(ctx.uvBin);
  if (ctx.withNpm) parts.push(ctx.npmBin);
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${parts.join(":")}:/usr/bin:/bin`,
      HOME: ctx.dir,
      LANGFLOW_SRC_REPO: ctx.repo,
      PREPARE_FETCH: "0", // no remote in these clones; fetching is not what is under test
      ...env,
    },
  });
  const summary = {};
  for (const line of (r.stdout || "").split("\n")) {
    const m = line.match(/^([a-z_]+)=(.*)$/);
    if (m) summary[m[1]] = m[2];
  }
  return { ...r, summary, stdoutLines: (r.stdout || "").split("\n").filter(Boolean) };
}

const madeCalls = (ctx) => (existsSync(ctx.makeLog) ? readFileSync(ctx.makeLog, "utf8") : "");
const buildRan = (ctx) => /build_frontend/.test(madeCalls(ctx));
const stampAt = (ctx) =>
  existsSync(join(ctx.repo, STAMP_NAME)) ? readFileSync(join(ctx.repo, STAMP_NAME), "utf8") : null;

test("refuses to run without a target, and does not move the clone", () => {
  const ctx = setup();
  const r = run(ctx);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /neither TARGET_SHA nor TARGET_REF/);
  assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.oldSha);
  assert.equal(buildRan(ctx), false);
});

for (const variable of ["TARGET_SHA", "TARGET_REF", "TARGET_BRANCH"]) {
  test(`refuses main given as ${variable}`, () => {
    const ctx = setup();
    // TARGET_BRANCH alone is not a target, so it is paired with a real sha: the point
    // is that a `main` anywhere in the inputs stops the run, not just in the checkout
    // target. Fetching main to then take a commit "reachable from it" is the same
    // mistake with a different flag.
    const env = variable === "TARGET_BRANCH" ? { TARGET_SHA: ctx.newSha, TARGET_BRANCH: "main" } : { [variable]: "main" };
    const r = run(ctx, env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /refusing to prepare the target from 'main'/);
    assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.oldSha);
  });
}

test("refuses a commit that is not in the clone, rather than substituting one", () => {
  const ctx = setup();
  const r = run(ctx, { TARGET_SHA: "0".repeat(40) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not exist in .*Refusing to fall\nback to anything else/s);
  assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.oldSha);
});

test("refuses a dirty clone, and PREPARE_ALLOW_DIRTY is the only way past it", () => {
  const dirtyCtx = setup({ dirty: true });
  const refused = run(dirtyCtx, { TARGET_SHA: dirtyCtx.newSha });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /modified path\(s\)/);
  assert.match(refused.stderr, /scratch-work\.txt/);
  assert.equal(git(dirtyCtx.repo, "rev-parse", "HEAD"), dirtyCtx.oldSha);

  const allowed = setup({ dirty: true });
  const ok = run(allowed, { TARGET_SHA: allowed.newSha, PREPARE_ALLOW_DIRTY: "1", PREPARE_SKIP_BUILD: "1" });
  assert.equal(ok.status, 0);
});

test("the stamp file alone does not make the clone dirty", () => {
  // The stamp is untracked and lives inside the clone on purpose (it must survive a
  // reboot). If it counted as dirt, the second run would always refuse.
  const ctx = setup({ stampOnlyDirt: true });
  const r = run(ctx, { TARGET_SHA: ctx.newSha, PREPARE_SKIP_BUILD: "1" });
  assert.equal(r.status, 0);
  assert.equal(r.summary.moved, "yes");
});

for (const missing of ["npm", "uv"]) {
  test(`refuses when ${missing} is missing, BEFORE moving the clone`, () => {
    const ctx = setup(missing === "npm" ? { withNpm: false } : { withUv: false });
    const r = run(ctx, { TARGET_SHA: ctx.newSha });
    assert.equal(r.status, 2);
    assert.match(r.stderr, new RegExp(`${missing} is not on PATH`));
    // The property, not the message: a build that cannot finish must not have already
    // moved the clone. Otherwise the machine is left with a new backend and an old UI.
    assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.oldSha);
  });
}

test("the revert hint is usable on a clone this script already prepared", () => {
  // A prepared clone is detached, where `rev-parse --abbrev-ref` answers "HEAD" — so
  // the hint used to read `checkout HEAD` and revert nothing. The fixture is already
  // detached, which is why this went unnoticed until the script ran on the machine:
  // reading the code, "BEFORE_REF" looks like a branch name.
  const ctx = setup();
  const r = run(ctx, { TARGET_SHA: ctx.newSha, PREPARE_SKIP_BUILD: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stderr, new RegExp(`revert with: git -C \\S+ checkout ${ctx.oldSha}`));
  assert.doesNotMatch(r.stderr, /checkout HEAD$/m);
});

test("moves the clone, rebuilds, and stamps the commit it built", () => {
  const ctx = setup({ frontendBuilt: false });
  const r = run(ctx, { TARGET_SHA: ctx.newSha, TARGET_REF: "v1.13.0.dev1" });
  assert.equal(r.status, 0);
  assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.newSha);
  assert.equal(r.summary.moved, "yes");
  assert.equal(r.summary.rebuilt, "yes");
  assert.equal(r.summary.prepared_sha, ctx.newSha);
  assert.equal(r.summary.prepared_ref, "v1.13.0.dev1");
  assert.match(madeCalls(ctx), /install_frontend/);
  assert.match(madeCalls(ctx), /build_frontend/);
  const stamp = stampAt(ctx);
  assert.match(stamp, new RegExp(`^sha=${ctx.newSha}$`, "m"));
});

test("skips the rebuild only when the stamp agrees with HEAD", () => {
  const ctx = setup({ stampSha: null });
  // First bring it to the target and let it build, which writes the stamp.
  run(ctx, { TARGET_SHA: ctx.newSha });
  const again = run(ctx, { TARGET_SHA: ctx.newSha });
  assert.equal(again.status, 0);
  assert.equal(again.summary.moved, "no");
  assert.equal(again.summary.rebuilt, "no");
  assert.equal(again.summary.rebuild_reason, "none");
});

test("assets whose commit is unknown are treated as stale, not as good", () => {
  // Every clone built by hand before this script existed is in exactly this state:
  // an index.html and no stamp. Trusting it is the debt this step closes.
  const ctx = setup({ frontendBuilt: true, stampSha: null });
  const r = run(ctx, { TARGET_SHA: ctx.newSha });
  assert.equal(r.status, 0);
  assert.equal(r.summary.rebuilt, "yes");
  assert.match(r.summary.rebuild_reason, /carries no stamp/);
});

test("a stamp from another commit forces a rebuild", () => {
  const ctx = setup({ frontendBuilt: true, stampSha: "f".repeat(40) });
  const r = run(ctx, { TARGET_SHA: ctx.newSha });
  assert.equal(r.status, 0);
  assert.equal(r.summary.rebuilt, "yes");
  assert.match(r.summary.rebuild_reason, /the build belongs to fffffffff/);
});

for (const mode of ["fail-deps", "fail-frontend"]) {
  test(`a failed build (${mode}) leaves NO stamp behind`, () => {
    // The core fail-closed property. The stamp is removed before the build starts, so
    // an interrupted or failed build leaves "unknown" rather than a stale claim that
    // the starter would believe.
    const ctx = setup({ frontendBuilt: true, stampSha: "f".repeat(40), makeMode: mode });
    const r = run(ctx, { TARGET_SHA: ctx.newSha });
    assert.notEqual(r.status, 0);
    assert.equal(stampAt(ctx), null);
  });
}

test("a build that reports success without producing index.html is a failure", () => {
  const ctx = setup({ frontendBuilt: false, makeMode: "ok-without-assets" });
  const r = run(ctx, { TARGET_SHA: ctx.newSha });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reported success but there is no/);
  assert.equal(stampAt(ctx), null);
});

test("PREPARE_SKIP_BUILD moves the clone and says the build does not match", () => {
  const ctx = setup({ frontendBuilt: true, stampSha: "f".repeat(40) });
  const r = run(ctx, { TARGET_SHA: ctx.newSha, PREPARE_SKIP_BUILD: "1" });
  assert.equal(r.status, 0);
  assert.equal(git(ctx.repo, "rev-parse", "HEAD"), ctx.newSha);
  assert.equal(r.summary.rebuilt, "no");
  assert.notEqual(r.summary.rebuild_reason, "none");
  assert.equal(buildRan(ctx), false);
});

test("stdout is only key=value, so a caller can capture it without parsing prose", () => {
  const ctx = setup({ frontendBuilt: false });
  const r = run(ctx, { TARGET_SHA: ctx.newSha });
  assert.equal(r.status, 0);
  for (const line of r.stdoutLines) {
    assert.match(line, /^[a-z_]+=/, `prose on stdout: ${line}`);
  }
  // And the human narration still exists — on stderr, where it cannot corrupt the
  // summary.
  assert.match(r.stderr, /before: /);
});

test("reports deps and frontend timings separately", () => {
  // The number that decides whether the rebuild fits at the head of a run or becomes
  // its own step. One total would not answer that.
  const ctx = setup({ frontendBuilt: false });
  const r = run(ctx, { TARGET_SHA: ctx.newSha });
  assert.match(r.summary.deps_s, /^\d+$/);
  assert.match(r.summary.frontend_s, /^\d+$/);
  assert.match(r.summary.total_s, /^\d+$/);
});
