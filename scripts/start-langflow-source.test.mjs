// Unit tests for scripts/start-langflow-source.sh.
// Run with: npm run test:scripts
//
// What these protect: the three properties that make this starter usable on the QA
// VMs, all of which are invisible when they break.
//
//   - Per-port state. Several instances run side by side there. If the PID file,
//     the database or the config directory ever stop being keyed on the port, the
//     second shard silently reuses the first one's, and the failure surfaces as a
//     flaky spec rather than as a wiring bug.
//   - The clone is not moved unless asked. A lane that checks out a ref behind the
//     caller's back makes its own report unattributable — the commit named in the
//     run is not the tree that produced it.
//   - The environment block matches the pip starter's. Two starters that disagree
//     turn a VM-only failure into something indistinguishable from a regression.
//
// uv, git and curl are stubbed through a PATH shim, so nothing is synced and no
// server is started; the assertions read what the script would have run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./start-langflow-source.sh", import.meta.url));

/**
 * Runs the starter with uv, git and curl stubbed.
 *
 * `healthy: false` makes the curl stub refuse, which is how the timeout branch is
 * reached; the poll interval is turned down so the test does not wait it out.
 * `repoExists: false` removes the clone the script is pointed at.
 */
function runScript({ env = {}, healthy = true, repoExists = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "start-langflow-source-test-"));
  const bin = join(dir, "bin");
  const repo = join(dir, "langflow-src");
  const state = join(dir, "state");
  mkdirSync(bin);
  if (repoExists) mkdirSync(repo);

  const uvLog = join(dir, "uv.log");
  const gitLog = join(dir, "git.log");
  const envLog = join(dir, "env.log");

  // Logs its arguments, plus the Langflow variables the run inherits — the run
  // command is what carries them, so they are only observable from inside it.
  writeFileSync(
    join(bin, "uv"),
    `#!/usr/bin/env bash
echo "$*" >> "${uvLog}"
if [ "$1" = "run" ]; then
  env | grep -E '^LANGFLOW_' | sort >> "${envLog}"
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
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
exit ${healthy ? 0 : 1}
`,
  );
  for (const f of ["uv", "git", "curl"]) chmodSync(join(bin, f), 0o755);

  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LANGFLOW_SRC_REPO: repo,
        LANGFLOW_SRC_STATE_DIR: state,
        LANGFLOW_POLL_INTERVAL_S: "1",
        LANGFLOW_START_TIMEOUT_S: healthy ? "30" : "1",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    status = e.status ?? 1;
    stdout = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }

  const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const result = {
    status,
    stdout,
    uv: read(uvLog),
    git: read(gitLog),
    langflowEnv: read(envLog),
    state,
    pidFile: join(state, "langflow.pid"),
    pidFileExists: existsSync(join(state, "langflow.pid")),
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("a missing source clone fails with exit 2, naming the path and the override", () => {
  const r = runScript({ repoExists: false });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Langflow source clone not found/);
  assert.match(r.stdout, /LANGFLOW_SRC_REPO/);
});

test("the clone is not moved when no ref is requested", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.git, /checkout/);
});

test("LANGFLOW_SRC_REF opts in to moving the clone, and says so", () => {
  const r = runScript({ env: { LANGFLOW_SRC_REF: "v1.12.0" } });
  assert.equal(r.status, 0);
  assert.match(r.git, /checkout --quiet v1\.12\.0/);
  assert.match(r.stdout, /Checking out v1\.12\.0/);
});

test("the port keys the state: PID file, database and config directory", () => {
  const r = runScript({ env: { LANGFLOW_PORT: "7863" } });
  assert.equal(r.status, 0);
  assert.ok(r.pidFileExists, "expected a PID file under the state directory");
  assert.match(r.langflowEnv, new RegExp(`LANGFLOW_CONFIG_DIR=${r.state}/data`));
  assert.match(r.langflowEnv, new RegExp(`LANGFLOW_DATABASE_URL=sqlite:///${r.state}/data/langflow\\.db`));
  assert.match(r.uv, /--port 7863/);
});

test("the environment block matches the pip starter's", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  assert.match(r.langflowEnv, /LANGFLOW_AUTO_LOGIN=true/);
  assert.match(r.langflowEnv, /LANGFLOW_DEACTIVATE_TRACING=true/);
  assert.match(r.langflowEnv, /LANGFLOW_A2A_ENABLED=true/);
  // Loopback stays out on purpose: a spec asserts the SSRF refusal of a loopback fetch.
  assert.match(r.langflowEnv, /LANGFLOW_SSRF_ALLOWED_HOSTS=172\.16\.0\.0\/12,10\.0\.0\.0\/8,192\.168\.0\.0\/16/);
  assert.doesNotMatch(r.langflowEnv, /LANGFLOW_SSRF_ALLOWED_HOSTS=[^\n]*127\.0\.0\.1/);
  assert.match(r.uv, /--workers 1/);
});

test("the sync keeps the lockfile frozen, so the clone is not rewritten", () => {
  const r = runScript();
  assert.equal(r.status, 0);
  assert.match(r.uv, /sync --frozen/);
});

test("LANGFLOW_SRC_RUN_CMD replaces the uv path entirely", () => {
  const r = runScript({ env: { LANGFLOW_SRC_RUN_CMD: "true", LANGFLOW_SRC_SYNC_CMD: "" } });
  assert.equal(r.status, 0);
  assert.equal(r.uv, "", "uv must not be invoked when the run command is overridden");
});

test("a backend that never answers fails with exit 1 and clears the PID file", () => {
  const r = runScript({ healthy: false });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /did not become ready/);
  assert.equal(r.pidFileExists, false);
});
