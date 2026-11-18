// Unit tests for the port guard and the startup liveness check (#2087) in
// start-langflow-pip.sh, start-langflow-serving-identity.sh and
// start-langflow-enterprise.sh. start-langflow-docker.sh has the same two guards plus
// a version check, covered in start-langflow-docker.test.mjs; start-langflow-source.sh
// had them first, covered in start-langflow-source.test.mjs.
// Run with: npm run test:scripts
//
// What these protect is a start that reports success for an instance it did not
// launch. A readiness loop that asks only the PORT is answered by whatever holds it,
// so a failed launch beside another instance read as an instant healthy start — and
// the version it printed, which a spec doc's `Last validated` records, was the other
// instance's. Two guards close it:
//
//   - before launching, something already answering /health_check refuses the start;
//   - while polling, a process or container that is no longer alive fails fast
//     instead of being waited out (and, before the first guard, reported as healthy
//     once the other instance answered).
//
// docker, curl, pip, langflow, git and sleep are stubbed through a PATH shim, so
// nothing is installed, built, pulled or started. The health probe answers only after
// the stubbed launch, unless the test says the port is already held.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const PIP = script("start-langflow-pip.sh");
const SERVING = script("start-langflow-serving-identity.sh");
const ENTERPRISE = script("start-langflow-enterprise.sh");

function run(path, { portHeld = false, dies = false, inspect = "", env = {} } = {}) {
  const dir = makeTempDir("start-port-guard-test-");
  const log = join(dir, "calls.log");
  const started = join(dir, "started");
  const langflowPid = join(dir, "langflow.pid");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  // The launch: `docker run` for the container scripts, `langflow run` for pip. A
  // launch that "dies" never answers, and for docker reports the container stopped.
  stub(
    "docker",
    `case "$1" in
  run) [ "$FAKE_DIES" = "1" ] || : > "${started}" ;;
  container)
    if [ "$2" = "inspect" ]; then
      case "$FAKE_INSPECT" in
        error) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;
        noisy) echo "Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg." >&2 ;;
      esac
      [ "$FAKE_DIES" = "1" ] && echo false || echo true
    fi ;;
  image) [ "$2" = "inspect" ] && echo abc123 ;;
  exec) [ "$FAKE_EXEC_FAILS" = "1" ] && exit 126; echo "\${FAKE_CONTAINER_VERSION:-0.0.0-test}" ;;
esac
exit 0`,
  );
  stub(
    "langflow",
    `echo $$ > "${langflowPid}"
[ "$FAKE_DIES" = "1" ] && exit 3
: > "${started}"
exec /bin/sleep 30`,
  );
  stub("pip", "exit 0");
  stub("git", `case "$*" in *rev-parse*) echo abc123 ;; esac; exit 0`);
  stub(
    "curl",
    `[ -e "${started}" ] || [ "$FAKE_PORT_HELD" = "1" ] || exit 7
echo "\${FAKE_HTTP_BODY:-{\"version\":\"0.0.0-test\",\"package\":\"Langflow\"}}"`,
  );
  // Real but short: the pip poll must give a dying background process time to exit.
  stub("sleep", "exec /bin/sleep 0.05");

  let out = "";
  let status = 0;
  try {
    out = execFileSync("bash", [path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_PORT_HELD: portHeld ? "1" : "0",
        FAKE_DIES: dies ? "1" : "0",
        FAKE_INSPECT: inspect,
        LANGFLOW_EE_REPO: dir,
      },
    });
  } catch (err) {
    status = err.status ?? 1;
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (existsSync(langflowPid)) {
    try {
      process.kill(Number(readFileSync(langflowPid, "utf8").trim()));
    } catch {
      // already gone
    }
  }
  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    // nothing was called
  }
  rmSync(dir, { recursive: true, force: true });
  return { out, status, calls };
}

const launched = (calls) => calls.some((c) => c.startsWith("docker run ") || c.startsWith("langflow run"));

const SCRIPTS = [
  { name: "start-langflow-pip.sh", path: PIP, port: "7860", portVar: "LANGFLOW_PORT" },
  { name: "start-langflow-serving-identity.sh", path: SERVING, port: "7893", portVar: "LANGFLOW_SERVING_PORT" },
  { name: "start-langflow-enterprise.sh", path: ENTERPRISE, port: "7890", portVar: "LANGFLOW_EE_PORT" },
];

for (const s of SCRIPTS) {
  test(`${s.name}: something already answering on the port refuses the start before anything is launched`, () => {
    const r = run(s.path, { portHeld: true });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, new RegExp(`something already answers /health_check on localhost:${s.port}`));
    assert.match(r.out, new RegExp(`pick another with ${s.portVar}`));
    assert.ok(!launched(r.calls), `launched on an occupied port:\n${r.calls.join("\n")}`);
    assert.doesNotMatch(r.out, /ready after|is up at/);
  });

  test(`${s.name}: a launch that dies during startup fails fast instead of waiting out the budget`, () => {
    const r = run(s.path, { dies: true });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /exited during startup/);
    assert.doesNotMatch(r.out, /ready after|is up at|did not start in time|did not become healthy/);
  });

  test(`${s.name}: a free port and a live launch still start`, () => {
    const r = run(s.path);
    assert.equal(r.status, 0, r.out);
    assert.ok(launched(r.calls));
    assert.match(r.out, /ready after|is up at/);
  });
}

test("start-langflow-pip.sh refuses an occupied port before installing anything", () => {
  const r = run(PIP, { portHeld: true });
  assert.ok(!r.calls.some((c) => c.startsWith("pip ")), r.calls.join("\n"));
});

test("start-langflow-pip.sh names the exit status of a launch that died", () => {
  const r = run(PIP, { dies: true });
  assert.match(r.out, /langflow run \(PID \d+\) exited during startup with status 3/);
});

test("the container scripts guard only after removing their own container, which is replaced, not refused", () => {
  for (const [path, name] of [
    [SERVING, "langflow-serving-identity"],
    [ENTERPRISE, "langflow-ee-runner"],
  ]) {
    const r = run(path, { portHeld: true });
    assert.ok(r.calls.includes(`docker rm -f ${name}`), `${name}:\n${r.calls.join("\n")}`);
  }
});

test("the container scripts print the dead container's own logs", () => {
  for (const [path, name] of [
    [SERVING, "langflow-serving-identity"],
    [ENTERPRISE, "langflow-ee-runner"],
  ]) {
    const r = run(path, { dies: true });
    assert.ok(r.calls.includes(`docker logs --tail 40 ${name}`), `${name}:\n${r.calls.join("\n")}`);
  }
});

test("the container scripts name a liveness check docker cannot answer, and start through stderr noise", () => {
  for (const path of [SERVING, ENTERPRISE]) {
    const failed = run(path, { inspect: "error" });
    assert.equal(failed.status, 1, failed.out);
    assert.match(failed.out, /could not ask docker whether .* is running \(answer: ''\): Cannot connect to the Docker daemon/);
    assert.doesNotMatch(failed.out, /exited during startup/);
    const noisy = run(path, { inspect: "noisy" });
    assert.equal(noisy.status, 0, noisy.out);
  }
});

test("start-langflow-serving-identity.sh compares the version field, so a release does not pass for its pre-release", () => {
  const body = '{"version":"1.14.0.dev31","main_version":"1.14.0","package":"Langflow Nightly"}';
  const shadowed = run(SERVING, { env: { FAKE_CONTAINER_VERSION: "1.14.0", FAKE_HTTP_BODY: body } });
  assert.equal(shadowed.status, 1, shadowed.out);
  assert.match(shadowed.out, /SHADOWED/);
  const same = run(SERVING, { env: { FAKE_CONTAINER_VERSION: "1.14.0.dev31", FAKE_HTTP_BODY: body } });
  assert.equal(same.status, 0, same.out);
});

test("start-langflow-serving-identity.sh survives a container it cannot ask its version, and says so", () => {
  // Under pipefail a failed `docker exec | tr` with no `|| true` aborted the script
  // right after "Langflow ready", with no message.
  const r = run(SERVING, { env: { FAKE_EXEC_FAILS: "1" } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARNING: could not compare the container's langflow version/);
});
