// Unit tests for ops/vm/build-target-image.sh, which builds the image a declared-target
// run measures (#2111). Run with: npm run test:scripts
//
// The build itself needs docker and five minutes, and is exercised on the qa VM. What
// these pin is what a real build would not report: a fork or a ref that got built, a
// commit other than the one resolved, a build failure that reads as anything else, and
// a source tree left behind. Upstream is a local repository and docker is a stub that
// records what it was asked and answers `image inspect` with the label it was given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "ops", "vm", "build-target-image.sh");

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository with one commit per branch; `files` maps a branch to the files its commit carries. */
function makeRepo(dir, branches) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "seed");
  git(dir, "config", "user.email", "t@localhost");
  git(dir, "config", "user.name", "t");
  // Fetching a bare commit by SHA is what the script does against GitHub; a local
  // repository only serves that when told to.
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(dir, "README.md"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "seed");
  const shas = {};
  for (const [branch, files] of Object.entries(branches)) {
    git(dir, "checkout", "-q", "-B", branch, "seed");
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", branch);
    shas[branch] = git(dir, "rev-parse", "HEAD");
  }
  git(dir, "checkout", "-q", "seed");
  return shas;
}

const buildable = (version = "1.13.0") => ({
  "pyproject.toml": `[project]\nname = "langflow"\nversion = "${version}"\n`,
  "docker/build_and_push.Dockerfile": "FROM scratch AS runtime\nFROM runtime AS full\n",
});

/** Runs the script against a local upstream and a stub docker. */
function build(branch, { buildFails = false, label = null, snap = false, buildRoot = null, fork = false, oldPython = false } = {}) {
  const dir = makeTempDir("build-target-image-");
  const upstream = join(dir, "upstream");
  const shas = makeRepo(upstream, {
    "release-1.13.0": buildable(),
    "feature/nested-name": buildable("1.14.0.dev0"),
    "no-dockerfile": { "pyproject.toml": '[project]\nversion = "1.2.0"\n' },
    "no-version": { "pyproject.toml": '[project]\nname = "langflow"\n', "docker/build_and_push.Dockerfile": "FROM scratch AS full\n" },
    "no-full-stage": { "pyproject.toml": '[project]\nversion = "1.0.0"\n', "docker/build_and_push.Dockerfile": "FROM scratch AS runtime\n" },
  });
  if (fork) makeRepo(join(dir, "fork"), { "only-in-fork": buildable() });

  const bin = join(dir, "bin");
  mkdirSync(bin);
  const calls = join(dir, "docker.log");
  const labelFile = join(dir, "label");
  // `build` remembers the org.langflow.sha label it was given; `image inspect` answers
  // with it, or with the override that simulates an image built from something else.
  const stubBody = `#!/usr/bin/env bash
echo "$*" >> ${JSON.stringify(calls)}
case "$1" in
  build)
    for a in "$@"; do case "$a" in org.langflow.sha=*) printf '%s' "\${a#org.langflow.sha=}" > ${JSON.stringify(labelFile)} ;; esac; done
    ${label !== null ? `printf '%s' ${JSON.stringify(label)} > ${JSON.stringify(labelFile)}` : ""}
    echo "step 1/9 ..."
    ${buildFails ? 'echo "ERROR: failed to solve: npm ci exited 1"; exit 1' : "exit 0"} ;;
  image) cat ${JSON.stringify(labelFile)} ;;
esac`;
  if (snap) {
    // The snap's docker is a link to /usr/bin/snap; this is the same shape.
    writeFileSync(join(bin, "snap"), stubBody, { mode: 0o755 });
    symlinkSync(join(bin, "snap"), join(bin, "docker"));
  } else {
    writeFileSync(join(bin, "docker"), stubBody, { mode: 0o755 });
  }

  if (oldPython) {
    // A python3 that predates tomllib: the import fails, and --version says so.
    writeFileSync(join(bin, "python3"), `#!/usr/bin/env bash
[ "$1" = "--version" ] && { echo "Python 3.10.12"; exit 0; }
case "$*" in *tomllib*) echo "ModuleNotFoundError: No module named 'tomllib'" >&2; exit 1 ;; esac
exit 1
`, { mode: 0o755 });
  }
  const root = buildRoot ?? join(dir, "root");
  const r = spawnSync("bash", [SCRIPT, ...(branch === undefined ? [] : [branch])], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      UPSTREAM_REPO_URL: `file://${upstream}`,
      BUILD_ROOT: root,
      IMAGE_REPO: "langflow-ondemand",
    },
  });
  const out = Object.fromEntries(
    r.stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    out,
    shas,
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
    leftovers: existsSync(root) ? readdirSync(root).filter((n) => n.startsWith("src-")) : [],
    root,
  };
}

test("a branch of upstream is built from the commit it points at, labelled with it", () => {
  const r = build("release-1.13.0");
  assert.equal(r.status, 0, r.stderr);
  const sha = r.shas["release-1.13.0"];
  assert.deepEqual(
    { ...r.out, build_s: "n" },
    { target_ref: "release-1.13.0", target_sha: sha, target_version: "1.13.0", image: `langflow-ondemand:${sha.slice(0, 12)}`, build_s: "n" },
  );
  assert.match(r.out.build_s, /^\d+$/);
  const buildCall = r.calls.find((c) => c.startsWith("build "));
  assert.ok(buildCall, `docker build was called: ${r.calls}`);
  assert.match(buildCall, /-f \S+\/docker\/build_and_push\.Dockerfile --target full /, "the nightly's Dockerfile and target");
  assert.match(buildCall, new RegExp(`--label org\\.langflow\\.sha=${sha} `));
  assert.match(buildCall, /--label org\.langflow\.ref=release-1\.13\.0 /);
  assert.deepEqual(r.leftovers, [], "the source tree is removed");
});

test("stdout is exactly the block a caller evals into a declared run", () => {
  const r = build("feature/nested-name");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split("\n").length, 5, `nothing else on stdout: ${r.stdout}`);
  const evald = spawnSync("bash", ["-c", `eval "$1"; printf '%s|%s|%s|%s' "$target_ref" "$target_sha" "$target_version" "$image"`, "_", r.stdout], { encoding: "utf8" });
  const sha = r.shas["feature/nested-name"];
  assert.equal(evald.stdout, `feature/nested-name|${sha}|1.14.0.dev0|langflow-ondemand:${sha.slice(0, 12)}`);
});

test("anything that is not a branch of upstream is refused before any fetch or build", () => {
  for (const [name, why] of [
    [undefined, /no branch named/],
    ["", /no branch named/],
    ["-uhelp", /starts with '-'/],
    ["someone:feature", /names a fork or a remote/],
    ["refs/heads/release-1.13.0", /is a ref, not a branch name/],
    ["pull/123/head", /is a ref, not a branch name/],
    ["bad..name", /not a valid branch name/],
    ["a;touch${IFS}x", /characters this lane does not accept/],
    ["does-not-exist", /is not a branch of file:/],
  ]) {
    const r = build(name);
    assert.equal(r.status, 2, `${JSON.stringify(name)}: ${r.stderr}`);
    assert.match(r.stderr, why, JSON.stringify(name));
    assert.equal(r.stdout, "", `${JSON.stringify(name)}: nothing on stdout`);
    assert.ok(!r.calls.some((c) => c.startsWith("build")), `${JSON.stringify(name)}: docker build ran`);
  }
});

test("a branch that exists only on a fork is not a branch of upstream", () => {
  const r = build("only-in-fork", { fork: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /'only-in-fork' is not a branch of .*A fork's branch is never one/);
});

test("a commit with no version, or no nightly Dockerfile, is refused before the build", () => {
  const noVersion = build("no-version");
  assert.equal(noVersion.status, 4);
  assert.match(noVersion.stderr, /no readable \[project\]\.version/);
  const noDockerfile = build("no-dockerfile");
  assert.equal(noDockerfile.status, 4);
  assert.match(noDockerfile.stderr, /has no docker\/build_and_push\.Dockerfile/);
  for (const r of [noVersion, noDockerfile]) {
    assert.ok(!r.calls.some((c) => c.startsWith("build")));
    assert.deepEqual(r.leftovers, [], "the source tree is removed on a refusal too");
  }
});

test("a failed build is its own status, never a test result, and keeps its log", () => {
  const r = build("release-1.13.0", { buildFails: true });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /This is a build failure, not a test result/);
  assert.match(r.stderr, /npm ci exited 1/, "the tail of the log is shown");
  const log = r.stderr.match(/the full log is (\S+)\./)?.[1];
  assert.ok(log && existsSync(log), `the log is kept: ${log}`);
  assert.equal(r.stdout, "");
  assert.deepEqual(r.leftovers, []);
});

test("an image that does not carry the commit it was built from is refused", () => {
  const r = build("release-1.13.0", { label: "0".repeat(40) });
  assert.equal(r.status, 6);
  assert.match(r.stderr, /carries org\.langflow\.sha='0{40}'/);
  assert.equal(r.stdout, "");
});

test("the snap's docker is refused a build context under /tmp or /var/tmp, and a plain docker is not", () => {
  for (const root of ["/tmp/target-builds", "/var/tmp/target-builds"]) {
    const r = build("release-1.13.0", { snap: true, buildRoot: root });
    assert.equal(r.status, 2, root);
    assert.match(r.stderr, /the docker snap cannot read a build context there/);
    assert.ok(!r.calls.some((c) => c.startsWith("build")));
  }
  // The same snap-shaped docker under a normal root builds; the refusal is about the
  // directory, not the snap. The root is made under $HOME, because the temp directory
  // IS /tmp on Linux (CI), where the refusal above is exactly the right answer.
  const normal = join(makeTempDir("build-target-image-root-", { dir: homedir() }), "root");
  const r = build("release-1.13.0", { snap: true, buildRoot: normal });
  assert.equal(r.status, 0, r.stderr);
});

test("a Dockerfile with no 'full' stage is the commit's problem (4), not a failed build (5)", () => {
  const r = build("no-full-stage");
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /has no 'full' stage, which is what the nightly builds/);
  assert.ok(!r.calls.some((c) => c.startsWith("build")), "docker was never asked");
});

test("a python3 without tomllib is the machine's problem (7), never every branch's", () => {
  const r = build("release-1.13.0", { oldPython: true });
  assert.equal(r.status, 7, r.stderr);
  assert.match(r.stderr, /no tomllib \(it needs 3\.11 or later: Python 3\.10\.12\)\. This is the machine, not the branch/);
  assert.doesNotMatch(r.stderr, /no readable \[project\]\.version/);
});

test("each run builds from its own directory and writes its own log", () => {
  const r = build("release-1.13.0");
  assert.equal(r.status, 0, r.stderr);
  const sha12 = r.shas["release-1.13.0"].slice(0, 12);
  const context = r.calls.find((c) => c.startsWith("build ")).split(" ").pop();
  assert.match(context, new RegExp(`/src-${sha12}-[A-Za-z0-9]{6}$`), "the context is a per-run directory");
  const logs = readdirSync(r.root).filter((n) => n.endsWith(".log"));
  assert.deepEqual(logs, [`build-${sha12}-${context.split("-").pop()}.log`], "and the log is named for that run");
});

test("two builds of the same commit at the same time do not break each other", async () => {
  // Measured shape of the defect this pins: with the tree named for the commit alone,
  // the second run's cleanup removed the tree the first run's build was still reading.
  const dir = makeTempDir("build-target-image-concurrent-");
  const upstream = join(dir, "upstream");
  makeRepo(upstream, { "release-1.13.0": buildable() });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // A build that takes a second and fails if its context disappears meanwhile.
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
case "$1" in
  build)
    ctx="\${@: -1}"; for a in "$@"; do case "$a" in org.langflow.sha=*) sha="\${a#org.langflow.sha=}" ;; esac; done
    sleep 1
    [ -f "$ctx/pyproject.toml" ] || { echo "context vanished: $ctx"; exit 1; }
    printf '%s' "$sha" > "$ctx.label" ;;
  image) cat "$(ls ${JSON.stringify(join(dir, "root"))}/src-*.label | head -1)" ;;
esac
`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, UPSTREAM_REPO_URL: `file://${upstream}`, BUILD_ROOT: join(dir, "root") };
  const once = () =>
    new Promise((resolve) => {
      const p = spawn("bash", [SCRIPT, "release-1.13.0"], { env });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, err }));
    });
  const [a, b] = await Promise.all([once(), once()]);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  assert.deepEqual(readdirSync(join(dir, "root")).filter((n) => n.startsWith("src-") && !n.endsWith(".label")), [], "both trees are removed");
});
