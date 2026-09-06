// Unit tests for scripts/start-langflow-source.sh and scripts/stop-langflow-source.sh.
// Run with: npm run test:scripts
//
// What these protect: the properties that make this starter usable on the QA VMs,
// every one of which is invisible when it breaks — the failure is a GREEN run, not a
// red one.
//
//   - Per-port state. Several instances run side by side there. The assertions below
//     never pass LANGFLOW_SRC_STATE_DIR, only a temporary STATE_ROOT, so the leaf the
//     script derives is the thing under test; an earlier version of this file pinned
//     the directory it had itself injected, and dropping the port from the default
//     left all eight tests green.
//   - The PID file names the process that has to die. Asserted by killing it through
//     the real stop script and looking for survivors, not by reading the script.
//   - Readiness is established, not assumed: an occupied port, a process that exits
//     during startup, and a clone with no frontend build each have to be refused.
//   - The environment block matches the pip starter's. Read out of
//     start-langflow-pip.sh at test time rather than copied here, so a variable added
//     there fails this file instead of silently diverging.
//
// uv, git and curl are stubbed through a PATH shim, so nothing is synced and no real
// server starts; the assertions read what the script would have run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const START = join(HERE, "start-langflow-source.sh");
const STOP = join(HERE, "stop-langflow-source.sh");
const PIP_START = join(HERE, "start-langflow-pip.sh");

// The stub server sleeps for a duration unique to THIS test process, so a survivor of
// the stop script can be told apart from an unrelated sleep — including one left by a
// concurrent run of this same file. A shared constant made the orphan assertion read
// the whole machine's process table and answer about somebody else's leftovers.
const SERVER_MARKER = `30.${process.pid}`;

function processTable() {
  return execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
}

function serverPattern() {
  return new RegExp(`sleep ${SERVER_MARKER.replace(".", "\\.")}`);
}

/**
 * Bounded synchronous wait. The starter returns the moment the readiness probe
 * answers, which is BEFORE the launched process has necessarily reached its own
 * first instruction — so the stub's env dump and the server's entry in the process
 * table both land after the script has already exited. Reading either one straight
 * after execFileSync is a race that only loses under load: it passed every time this
 * file ran alone and failed twice inside `npm run test:scripts`, where node runs the
 * files in parallel.
 */
function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(idle, 0, 0, 25);
  }
  return predicate();
}

/**
 * Runs the starter with uv, git and curl stubbed.
 *
 * `healthy: false` makes the readiness probe refuse, which is how the timeout branch
 * is reached; the poll interval is turned down so the test does not wait it out.
 * `portBusy: true` makes the PRE-START probe succeed instead, which is a port already
 * answering. The two are separate because the script calls curl for both, and the
 * stub tells them apart by call order.
 * `ignoresTerm: true` makes the launched process ignore SIGTERM — the shape the
 * timeout path has to survive, since `kill` returning 0 only proves delivery.
 * `serverExits: true` makes the launched process exit immediately, as a failed bind
 * does. `frontendBuilt: false` removes the served asset directory.
 */
function runScript({
  env = {},
  healthy = true,
  portBusy = false,
  repoExists = true,
  frontendBuilt = true,
  serverExits = false,
  ignoresTerm = false,
  withUv = true,
  stamp = null,
} = {}) {
  const dir = makeTempDir("start-langflow-source-test-");
  const bin = join(dir, "bin");
  // uv lives in its own directory so `withUv: false` can drop it from PATH without
  // also dropping the real mkdir/rm/tail/sleep the script needs to run at all.
  const uvBin = join(dir, "uv-bin");
  const repo = join(dir, "langflow-src");
  const stateRoot = join(dir, "state-root");
  mkdirSync(bin);
  mkdirSync(uvBin);
  mkdirSync(stateRoot);
  if (repoExists) mkdirSync(repo, { recursive: true });
  if (repoExists && frontendBuilt) {
    const fe = join(repo, "src/backend/base/langflow/frontend");
    mkdirSync(fe, { recursive: true });
    writeFileSync(join(fe, "index.html"), "<!doctype html>");
  }
  // The build stamp scripts/prepare-target-source.sh writes. The git stub below
  // answers every rev-parse with "abc1234", so that is the sha a MATCHING stamp
  // carries and anything else is the stale case.
  if (repoExists && stamp) writeFileSync(join(repo, ".langflow-e2e-build-stamp"), `sha=${stamp}\n`);

  const uvLog = join(dir, "uv.log");
  const gitLog = join(dir, "git.log");
  const envLog = join(dir, "env.log");
  const curlCount = join(dir, "curl.count");

  // Logs its arguments, plus the Langflow variables the run inherits — the run
  // command is what carries them, so they are only observable from inside it. Then
  // it becomes a long-lived process, because the starter now checks that what it
  // launched is still alive before it will call the instance ready.
  writeFileSync(
    join(uvBin, "uv"),
    `#!/usr/bin/env bash
echo "$*" >> "${uvLog}"
if [ "$1" = "run" ]; then
  env | grep -E '^LANGFLOW_' | sort >> "${envLog}"
  ${serverExits ? "exit 1" : `${ignoresTerm ? "trap '' TERM\n" : ""}exec sleep ${SERVER_MARKER}`}
fi
exit 0
`,
  );
  writeFileSync(
    join(bin, "git"),
    `#!/usr/bin/env bash
echo "$*" >> "${gitLog}"
case "$*" in
  *rev-parse*) echo "abc1234" ;;
esac
exit 0
`,
  );
  // Call 1 is the pre-start "is this port free?" probe; every later call is the
  // readiness poll. They need opposite answers in the ordinary case, so the stub
  // counts rather than guessing from its arguments.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
N=$(cat "${curlCount}" 2>/dev/null || echo 0)
N=$((N + 1))
echo "$N" > "${curlCount}"
if [ "$N" -eq 1 ]; then exit ${portBusy ? 0 : 1}; fi
exit ${healthy ? 0 : 1}
`,
  );
  chmodSync(join(uvBin, "uv"), 0o755);
  for (const f of ["git", "curl"]) chmodSync(join(bin, f), 0o755);

  // `withUv: false` must not inherit the caller's PATH, or a real uv on the machine
  // answers `command -v uv` and the branch under test is never reached. The minimal
  // path still carries the coreutils the script itself needs (mkdir, rm, tail, sleep).
  const path = withUv
    ? `${uvBin}:${bin}:${process.env.PATH}`
    : `${bin}:/usr/bin:/bin`;
  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", [START], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path,
        LANGFLOW_SRC_REPO: repo,
        LANGFLOW_SRC_STATE_ROOT: stateRoot,
        LANGFLOW_POLL_INTERVAL_S: "1",
        LANGFLOW_START_TIMEOUT_S: healthy && !serverExits ? "30" : "3",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // The starter must RETURN once the instance is ready, with the server still
      // running behind it. It only can because the launch `exec`s: without that the
      // subshell survives holding this pipe, and a caller capturing output — every
      // CI `run:` step — blocks until Langflow exits. A timeout turns that into a
      // failed assertion instead of a wedged test run.
      timeout: 12000,
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    if (e.code === "ETIMEDOUT") stdout += "\nTIMED OUT: the starter did not return";
  }

  const port = env.LANGFLOW_PORT ?? "7860";
  const stateDir = env.LANGFLOW_SRC_STATE_DIR ?? join(stateRoot, `langflow-source-${port}`);
  const pidFile = join(stateDir, "langflow.pid");
  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

  // Settle the two things the launched process writes on its own schedule, so no
  // assertion below has to race it.
  if (status === 0 && existsSync(pidFile)) {
    waitFor(() => serverPattern().test(processTable()));
    if (withUv && !env.LANGFLOW_SRC_RUN_CMD) waitFor(() => read(envLog).length > 0);
  }

  return {
    status,
    stdout,
    uv: read(uvLog),
    git: read(gitLog),
    langflowEnv: read(envLog),
    log: read(join(stateDir, "langflow.log")),
    stateRoot,
    stateDir,
    pidFile,
    pidFileExists: existsSync(pidFile),
    pid: read(pidFile).trim(),
    port,
    repo,
    binPath: path,
    // Callers that let a stub server start are responsible for stopping it; the
    // teardown is deliberately theirs, since two tests stop it through the real
    // stop script and that is the thing being measured.
    cleanup() {
      const pid = read(pidFile).trim();
      if (pid) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs the real stop script against a state directory the starter just wrote. */
function runStop(r, extraEnv = {}) {
  try {
    return {
      status: 0,
      stdout: execFileSync("bash", [STOP], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: r.binPath,
          LANGFLOW_SRC_STATE_ROOT: r.stateRoot,
          LANGFLOW_PORT: r.port,
          LANGFLOW_STOP_TIMEOUT_S: "5",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

test("a missing source clone fails with exit 2, naming the path and the override", () => {
  const r = runScript({ repoExists: false });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Langflow source clone not found/);
  assert.match(r.stdout, /LANGFLOW_SRC_REPO/);
  r.cleanup();
});

test("the clone is not moved when no ref is requested", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.git, /checkout/);
  r.cleanup();
});

test("LANGFLOW_SRC_REF opts in to moving the clone, and warns the frontend is not rebuilt", () => {
  const r = runScript({ env: { LANGFLOW_SRC_REF: "v1.12.0" } });
  assert.equal(r.status, 0);
  assert.match(r.git, /checkout --quiet v1\.12\.0/);
  assert.match(r.stdout, /Checking out v1\.12\.0/);
  assert.match(r.stdout, /frontend assets are NOT rebuilt/);
  r.cleanup();
});

test("the PORT keys the state directory, so two ports never share one", () => {
  // Neither call passes LANGFLOW_SRC_STATE_DIR: the leaf the script derives is the
  // property under test. Pinning an injected path is what let a fixed, pip-style
  // directory pass this file before.
  const a = runScript({ env: { LANGFLOW_PORT: "7863" } });
  const b = runScript({ env: { LANGFLOW_PORT: "7864" } });
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.match(a.stateDir, /langflow-source-7863$/);
  assert.notEqual(a.stateDir, b.stateDir);
  assert.ok(a.pidFileExists, "expected a PID file under the per-port state directory");
  assert.ok(b.pidFileExists, "expected a PID file under the per-port state directory");
  assert.match(a.langflowEnv, new RegExp(`LANGFLOW_CONFIG_DIR=${a.stateDir}/data`));
  assert.match(a.langflowEnv, new RegExp(`LANGFLOW_DATABASE_URL=sqlite:///${a.stateDir}/data/langflow\\.db`));
  assert.match(a.uv, /--port 7863/);
  assert.match(b.uv, /--port 7864/);
  a.cleanup();
  b.cleanup();
});

test("the PID file names the server itself, so the stop script leaves no orphan", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  assert.ok(r.pid, "expected a PID");
  assert.match(
    processTable(),
    serverPattern(),
    "the stub server should be running before the stop",
  );

  const stop = runStop(r);
  assert.equal(stop.status, 0, stop.stdout);
  assert.match(stop.stdout, /stopped/);
  // The real assertion. With $! holding the subshell instead of the server, the stop
  // reported success here while the server survived, reparented, still on the port.
  assert.doesNotMatch(
    processTable(),
    serverPattern(),
    "the server survived the stop script — the PID file is not naming it",
  );
  assert.equal(existsSync(r.pidFile), false, "the stop script should clear the PID file");
  r.cleanup();
});

test("the starter returns while the server keeps running, holding none of the caller's pipes", () => {
  // The launch is a simple background command for this reason as much as for the PID.
  // With `( cd X && cmd ) &` the subshell survives holding the CALLER's stderr, so a
  // caller that captures output — node here, a CI `run:` step in production — blocks
  // until Langflow itself exits. Wrapping the command in `exec` does not fix it:
  // measured on bash 3.2 that construct still forks. This is the assertion that told
  // the two apart, and it reads elapsed time because the symptom is a hang, not a
  // wrong value.
  const started = Date.now();
  const r = runScript();
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0);
  assert.ok(elapsed < 10000, `the starter took ${elapsed}ms to return; it is holding the caller's pipes`);
  assert.match(processTable(), serverPattern(), "the server should still be running behind it");
  r.cleanup();
});

test("a port that already answers is refused, instead of being reported ready", () => {
  // Without this the failed bind is invisible: the readiness probe is answered by
  // whatever already holds the port, and the lane runs against that instance.
  const r = runScript({ portBusy: true });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /already answers \/health_check/);
  assert.equal(r.uv, "", "nothing should be synced or launched once the port is taken");
  r.cleanup();
});

test("a still-running instance from a previous start is refused, naming the stop command", () => {
  const first = runScript();
  assert.equal(first.status, 0);
  // Same state root and port, and the first instance is still alive.
  const second = runScript({
    env: { LANGFLOW_SRC_STATE_DIR: first.stateDir },
    portBusy: false,
  });
  assert.equal(second.status, 2);
  assert.match(second.stdout, /still running on port/);
  assert.match(second.stdout, /stop-langflow-source\.sh/);
  first.cleanup();
  second.cleanup();
});

test("a frontend build that belongs to another commit is refused", () => {
  // What the LANGFLOW_SRC_REF note used to only warn about. A checkout moves the
  // backend and leaves the previous build's index.html in place: the specs that did
  // not change pass, the ones that did fail, and the report blames the product.
  const r = runScript({ stamp: "deadbeefdeadbeef" });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /was built from deadbeefde/);
  assert.match(r.stdout, /prepare-target-source\.sh/);
  assert.equal(r.pidFileExists, false);
  r.cleanup();
});

test("an unstamped build warns by default and is fatal when the lane demands it", () => {
  // Both halves are load-bearing. A clone built by hand has no stamp and has to stay
  // usable; the scheduled lane runs the preparer first, so there "no stamp" means the
  // preparer did not run and the assets' origin is unknown.
  const lenient = runScript();
  assert.equal(lenient.status, 0);
  assert.match(lenient.stdout, /no build stamp at/);
  lenient.cleanup();

  const strict = runScript({ env: { LANGFLOW_REQUIRE_BUILD_STAMP: "1" } });
  assert.equal(strict.status, 2);
  assert.match(strict.stdout, /asks for a guarantee/);
  assert.equal(strict.pidFileExists, false);
  strict.cleanup();
});

test("a stamp that agrees with HEAD starts with nothing to say about provenance", () => {
  const r = runScript({ stamp: "abc1234" });
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stdout, /build stamp/);
  r.cleanup();
});

test("a clone with no frontend build is refused, naming the build command", () => {
  // src/backend/base/langflow/frontend is gitignored upstream, so a fresh clone has
  // none and the backend answers /health_check 200 while serving no UI at all.
  const r = runScript({ frontendBuilt: false });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /no frontend build at/);
  assert.match(r.stdout, /install_frontend build_frontend/);
  r.cleanup();
});

test("a process that exits during startup fails immediately, not at the deadline", () => {
  const r = runScript({ serverExits: true, healthy: false });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /exited .* without answering/);
  assert.equal(r.pidFileExists, false);
  r.cleanup();
});

test("a process that ignores SIGTERM is escalated, not left as an orphan", () => {
  // The timeout path used to send SIGTERM and remove the PID file in the next line.
  // `kill` returning 0 only means the signal was DELIVERED, so a backend that ignores
  // it — or is wedged, which on this one is a documented state (#922/#927: process
  // alive, port bound, event loop blocked) — survived with its only handle deleted.
  // The next start could not see it either: /health_check cannot answer from a port
  // that is BOUND but silent, which is the very state the timeout was reached in.
  const r = runScript({ healthy: false, ignoresTerm: true, env: { LANGFLOW_STOP_TIMEOUT_S: "2" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /ignored SIGTERM/);
  assert.doesNotMatch(
    processTable(),
    serverPattern(),
    "the process that ignored SIGTERM survived the starter's failure path",
  );
  // Gone for real, so the handle is no longer needed — and the next start must not be
  // refused over a process that does not exist.
  assert.equal(r.pidFileExists, false);
  r.cleanup();
});

test("tracing is the caller's to set, and its default is not moved", () => {
  // The scheduled lane needs tracing ON (daily-stable.yml runs it on, and the traces
  // specs assert against a traced instance); a developer's own instance does not, which
  // is what #1300/#1183 decided. So the value has to be a parameter — and the default
  // has to STAY put, because the env-block parity test below is what keeps a spec from
  // being able to tell which starter brought its instance up (#1714).
  // The pip starter's value is READ, not repeated: the claim being made is that the two
  // agree, and a hardcoded `true` here would keep passing after pip changed. That is the
  // same "read from that file" the env-block parity test below uses.
  // Anchored to the start of a line, because the pip starter's own COMMENT spells the
  // same assignment two lines above the real one — an unanchored match reads the prose
  // and keeps passing after the setting changes. Found by mutation: flipping pip's real
  // value left this test green.
  const pipDefault = readFileSync(PIP_START, "utf8").match(/^LANGFLOW_DEACTIVATE_TRACING=(\w+)/m)?.[1];
  assert.ok(pipDefault, "could not read the pip starter's tracing value");

  const off = runScript();
  assert.match(off.langflowEnv, new RegExp(`^LANGFLOW_DEACTIVATE_TRACING=${pipDefault}$`, "m"));
  off.cleanup();

  const on = runScript({ env: { LANGFLOW_DEACTIVATE_TRACING: "false" } });
  assert.match(on.langflowEnv, /^LANGFLOW_DEACTIVATE_TRACING=false$/m);
  on.cleanup();
});

test("the environment block matches the pip starter's, read from that file", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  const pip = readFileSync(PIP_START, "utf8");

  // Every LANGFLOW_* the pip starter puts in front of `langflow run` must reach the
  // process here too. A new variable added there now fails this test instead of
  // quietly making the two lanes different instances.
  const pipVars = [...pip.matchAll(/^\s*(LANGFLOW_[A-Z0-9_]+)=/gm)].map((m) => m[1]);
  assert.ok(pipVars.length >= 6, `expected the pip starter's env block, found ${pipVars.length} vars`);
  for (const v of new Set(pipVars)) {
    assert.match(r.langflowEnv, new RegExp(`^${v}=`, "m"), `${v} is set by the pip starter but not here`);
  }

  // And the two defaults whose exact value is load-bearing rather than incidental.
  const ssrf = pip.match(/LANGFLOW_SSRF_ALLOWED_HOSTS="\$\{LANGFLOW_SSRF_ALLOWED_HOSTS:-([^}]*)\}"/)?.[1];
  assert.ok(ssrf, "could not read the pip starter's SSRF default");
  assert.match(r.langflowEnv, new RegExp(`LANGFLOW_SSRF_ALLOWED_HOSTS=${ssrf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  // Loopback stays out on purpose: a spec asserts the SSRF refusal of a loopback fetch.
  assert.doesNotMatch(r.langflowEnv, /LANGFLOW_SSRF_ALLOWED_HOSTS=[^\n]*127\.0\.0\.1/);

  const workers = pip.match(/--workers "\$\{LANGFLOW_WORKERS:-(\d+)\}"/)?.[1];
  assert.ok(workers, "could not read the pip starter's worker default");
  assert.match(r.uv, new RegExp(`--workers ${workers}`));
  r.cleanup();
});

test("the default bind is loopback, unlike the pip starter's, because the VM is shared", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  assert.match(r.uv, /--host 127\.0\.0\.1/);
  const opted = runScript({ env: { LANGFLOW_BIND_HOST: "0.0.0.0" } });
  assert.match(opted.uv, /--host 0\.0\.0\.0/);
  r.cleanup();
  opted.cleanup();
});

test("the sync keeps the lockfile frozen, so the clone is not rewritten", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  assert.match(r.uv, /sync --frozen/);
  r.cleanup();
});

test("LANGFLOW_SRC_RUN_CMD replaces the uv path entirely", () => {
  const r = runScript({ env: { LANGFLOW_SRC_RUN_CMD: `sleep ${SERVER_MARKER}` } });
  assert.equal(r.status, 0);
  assert.equal(r.uv, "", "uv must not be invoked when the run command is overridden");
  r.cleanup();
});

test("no uv and no override is an error, not a silent pip install of published packages", () => {
  // pip cannot build this clone: the root package's dependencies resolve through
  // [tool.uv.sources] workspace = true, so `pip install -e .` reaches PyPI for
  // langflow-base and every lfx-* bundle and installs RELEASED versions instead.
  const r = runScript({ withUv: false });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /uv is not installed/);
  assert.match(r.stdout, /LANGFLOW_SRC_RUN_CMD/);
  r.cleanup();
});

test("the log is truncated per start, so a failure tail cannot show the previous run", () => {
  const first = runScript({ serverExits: true, healthy: false });
  assert.equal(first.status, 1);
  writeFileSync(join(first.stateDir, "langflow.log"), "PREVIOUS RUN MARKER\n");
  const second = runScript({
    env: { LANGFLOW_SRC_STATE_DIR: first.stateDir },
    serverExits: true,
    healthy: false,
  });
  assert.equal(second.status, 1);
  assert.doesNotMatch(second.stdout, /PREVIOUS RUN MARKER/);
  assert.doesNotMatch(second.log, /PREVIOUS RUN MARKER/);
  first.cleanup();
  second.cleanup();
});

test("LANGFLOW_SRC_KEEP_STATE=1 keeps the previous database and log", () => {
  const first = runScript();
  const dataMarker = join(first.stateDir, "data", "keepme");
  writeFileSync(dataMarker, "x");
  runStop(first);
  const second = runScript({
    env: { LANGFLOW_SRC_STATE_DIR: first.stateDir, LANGFLOW_SRC_KEEP_STATE: "1" },
  });
  assert.equal(second.status, 0);
  assert.ok(existsSync(dataMarker), "KEEP_STATE=1 should not wipe the data directory");
  first.cleanup();
  second.cleanup();
});

test("a backend that never answers fails with exit 1 and clears the PID file", () => {
  const r = runScript({ healthy: false });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /did not become ready/);
  assert.equal(r.pidFileExists, false);
  r.cleanup();
});

test("a poll interval of zero is refused, because it never advances the deadline", () => {
  const r = runScript({ env: { LANGFLOW_POLL_INTERVAL_S: "0" } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /LANGFLOW_POLL_INTERVAL_S/);
  r.cleanup();
});

test("the stop script reports honestly when the recorded process is already gone", () => {
  const r = runScript();
  execFileSync("kill", ["-9", r.pid]);
  const stop = runStop(r);
  assert.equal(stop.status, 0);
  assert.match(stop.stdout, /already gone/);
  assert.equal(existsSync(r.pidFile), false);
  r.cleanup();
});

test("stopping a port with no instance is a no-op, not a failure", () => {
  const r = runScript({ repoExists: false });
  const stop = runStop(r);
  assert.equal(stop.status, 0);
  assert.match(stop.stdout, /No PID file/);
  r.cleanup();
});
