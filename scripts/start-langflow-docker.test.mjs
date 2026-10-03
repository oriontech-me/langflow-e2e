// Unit tests for scripts/start-langflow-docker.sh (issue #1076).
// Run with: npm run test:scripts
//
// What these protect: the script resolves an IMAGE from three inputs whose
// precedence is not obvious — a positional version, LANGFLOW_IMAGE_TAG, and
// LANGFLOW_IMAGE — across two DIFFERENT Docker repositories (nightly vs
// released). #1076 was exactly a silent divergence in that resolution: the
// repository was hardcoded to langflowai/langflow, so the documented
// "nightly by default" was false and every local validation ran the wrong build
// without saying so. A regression here is invisible for the same reason, which
// is why it is asserted rather than trusted.
//
// docker is stubbed via a PATH shim, so nothing is pulled and no container is
// started; the assertions read the arguments the script would have passed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";

import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("./start-langflow-docker.sh", import.meta.url));
const STOP_SCRIPT = fileURLToPath(new URL("./stop-langflow-docker.sh", import.meta.url));

/**
 * Runs the script with `docker` and `curl` stubbed out.
 *
 * The docker stub logs every invocation and can be told to fail `pull` and to
 * deny that a local copy exists, which is how the two refresh-failure branches
 * are reached. The curl stub answers the health check immediately so the run
 * does not sit through the 120 s readiness loop.
 *
 * `container` is what `docker container inspect` answers for the stopper:
 * "present", "absent" (docker's "No such container" error), "absent-podman"
 * (podman's lowercase "no such container"), "daemon-down" or "socket-missing"
 * (a missing engine socket, whose error also contains "no such").
 * `rm -f` exits 0 in every state, as docker 29 does for a missing container
 * (#2090) — so only the inspect can tell the stopper what happened.
 */
function runScript({ args = [], env = {}, pullFails = false, localCopy = true, healthy = true, container = "present", script = SCRIPT } = {}) {
  const dir = makeTempDir("start-langflow-test-");
  const log = join(dir, "docker.log");
  const curlLog = join(dir, "curl.log");

  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  pull) [ "\${FAKE_PULL_FAILS}" = "1" ] && exit 1 ;;
  image) [ "$2" = "inspect" ] && [ "\${FAKE_LOCAL_COPY}" = "0" ] && exit 1 ;;
  container)
    if [ "$2" = "inspect" ]; then
      case "\${FAKE_CONTAINER}" in
        absent) echo "Error response from daemon: No such container: $3" >&2; exit 1 ;;
        absent-podman) echo "Error: no such container $3" >&2; exit 1 ;;
        socket-missing) echo "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory" >&2; exit 1 ;;
        daemon-down) echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1 ;;
        *) echo '[{"Name":"/'"$3"'"}]' ;;
      esac
    fi ;;
  rm) echo "$3" ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "curl"),
    healthy
      ? `#!/usr/bin/env bash
echo "$*" >> "${curlLog}"
echo '{"version":"0.0.0-test"}'
exit 0
`
      : `#!/usr/bin/env bash
echo "$*" >> "${curlLog}"
exit 7
`,
  );
  // The readiness loop sleeps 5 s per attempt; the stub keeps an unhealthy run instant.
  writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "curl"), 0o755);
  chmodSync(join(dir, "sleep"), 0o755);

  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_PULL_FAILS: pullFails ? "1" : "0",
        FAKE_LOCAL_COPY: localCopy ? "1" : "0",
        FAKE_CONTAINER: container,
      },
    });
  } catch (err) {
    status = err.status ?? 1;
    stdout = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }

  let calls = [];
  try {
    calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    // no docker call at all — a valid outcome for the hard-fail branch
  }
  let urls = [];
  try {
    urls = readFileSync(curlLog, "utf8").trim().split("\n").filter(Boolean).map((c) => c.split(/\s+/).pop());
  } catch {
    // no probe at all — the script refused before starting anything
  }
  rmSync(dir, { recursive: true, force: true });

  const runCall = calls.find((c) => c.startsWith("run "));
  return {
    stdout,
    status,
    calls,
    urls,
    pulled: calls.some((c) => c.startsWith("pull ")),
    // The image is the last argument of `docker run`.
    image: runCall ? runCall.trim().split(/\s+/).pop() : null,
  };
}

test("no argument starts the nightly, and refreshes the moving tag", () => {
  const r = runScript();
  assert.equal(r.image, "langflowai/langflow-nightly:latest");
  assert.ok(r.pulled, "a moving tag must be refreshed before starting");
  assert.equal(r.status, 0);
});

test("a version argument resolves against the RELEASED repo, not nightly", () => {
  // The nightly repo keeps only recent dev tags, so `1.5.1` exists solely in
  // langflowai/langflow. Resolving it against nightly would fail on pull.
  const r = runScript({ args: ["1.5.1"] });
  assert.equal(r.image, "langflowai/langflow:1.5.1");
  assert.equal(r.pulled, false, "a pinned tag is immutable — no refresh needed");
});

test("LANGFLOW_IMAGE wins over the positional argument", () => {
  const r = runScript({
    args: ["1.5.1"],
    env: { LANGFLOW_IMAGE: "langflowai/langflow:1.11.1" },
  });
  assert.equal(r.image, "langflowai/langflow:1.11.1");
});

test("LANGFLOW_IMAGE_TAG still selects a released version (back-compat)", () => {
  const r = runScript({ env: { LANGFLOW_IMAGE_TAG: "1.9.0" } });
  assert.equal(r.image, "langflowai/langflow:1.9.0");
});

test("LANGFLOW_IMAGE_REPO overrides the repository", () => {
  const r = runScript({ env: { LANGFLOW_IMAGE_REPO: "langflowai/langflow" } });
  assert.equal(r.image, "langflowai/langflow:latest");
  assert.ok(r.pulled, "still a moving tag");
});

test("a failed refresh with a local copy warns and starts it anyway", () => {
  // Regression guard for the pull step itself: aborting here would make the
  // script unusable offline or on a full disk, which the pre-#1076 version
  // (no pull at all) never was.
  const r = runScript({ pullFails: true, localCopy: true });
  assert.match(r.stdout, /WARNING: could not refresh/);
  assert.match(r.stdout, /may be stale/);
  assert.equal(r.image, "langflowai/langflow-nightly:latest");
  assert.equal(r.status, 0);
});

test("a failed refresh with no local copy fails loudly and starts nothing", () => {
  const r = runScript({ pullFails: true, localCopy: false });
  assert.match(r.stdout, /ERROR: could not pull/);
  assert.equal(r.status, 1);
  assert.equal(r.image, null, "nothing may be started when there is no image");
});

test("the superuser and worker defaults are passed to the container", () => {
  // LANGFLOW_WORKERS=1 is load-bearing (#773: OOM on a small Docker VM),
  // LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true is required by every custom-component
  // spec (#668/#746), and LANGFLOW_A2A_ENABLED=true by every A2A spec (#1240 —
  // with it off the /api/v1/a2a/* routes 404 and those specs pass while testing
  // nothing). All are easy to drop when editing the run block.
  const r = runScript();
  const runCall = r.calls.find((c) => c.startsWith("run "));
  assert.match(runCall, /LANGFLOW_WORKERS=1/);
  assert.match(runCall, /LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true/);
  assert.match(runCall, /LANGFLOW_A2A_ENABLED=true/);
  assert.match(runCall, /LANGFLOW_AUTO_LOGIN=true/);
});

test("the SSRF allow-list matches the CI lanes, and keeps loopback OUT", () => {
  // #1391: without this a local instance behaves differently from all four CI
  // lanes — the guard refuses a self-hosted echo endpoint on a private IP, so
  // ECHO_BASE_URL-dependent specs fail (or skip) locally while passing in CI.
  // The value is the lanes' own; loopback is deliberately absent, because
  // agent-tool-error-handling.spec.ts uses an SSRF-blocked loopback fetch as its
  // deterministic error generator and ssrf-url-validation.spec.ts asserts that
  // refusal — allow-listing 127.0.0.1 here would silently disarm both.
  const r = runScript();
  const runCall = r.calls.find((c) => c.startsWith("run "));
  assert.match(runCall, /LANGFLOW_SSRF_ALLOWED_HOSTS=172\.16\.0\.0\/12,10\.0\.0\.0\/8,192\.168\.0\.0\/16/);
  assert.doesNotMatch(runCall, /LANGFLOW_SSRF_ALLOWED_HOSTS=[^ ]*127\.0\.0\.1/);
  assert.doesNotMatch(runCall, /LANGFLOW_SSRF_ALLOWED_HOSTS=[^ ]*localhost/);
});

test("the SSRF allow-list is a default, so another configuration is reproducible", () => {
  const r = runScript({ env: { LANGFLOW_SSRF_ALLOWED_HOSTS: "127.0.0.1" } });
  const runCall = r.calls.find((c) => c.startsWith("run "));
  assert.match(runCall, /LANGFLOW_SSRF_ALLOWED_HOSTS=127\.0\.0\.1/);
});

test("LANGFLOW_A2A_ENABLED can be forced off to reproduce the disabled surface", () => {
  // The disabled state is a real thing to reproduce by hand (the Agent tab's
  // serverDisabled copy, the 404 on all three routes), so the default must be a
  // default — not a hardcoded "true" that makes the off state unreachable.
  const r = runScript({ env: { LANGFLOW_A2A_ENABLED: "false" } });
  const runCall = r.calls.find((c) => c.startsWith("run "));
  assert.match(runCall, /LANGFLOW_A2A_ENABLED=false/);
});

// #2085 — the knobs a lane sets. Each default is asserted as well as the override,
// because the defaults are what every documented `docker exec langflow-e2e-runner …`
// and every developer's instance depend on.

const runCallOf = (r) => r.calls.find((c) => c.startsWith("run "));

test("the container keeps its documented name unless one is given", () => {
  const r = runScript();
  assert.match(runCallOf(r), /--name langflow-e2e-runner /);
  assert.ok(r.calls.includes("rm -f langflow-e2e-runner"), "the previous instance of THAT name is removed");
});

test("LANGFLOW_CONTAINER_NAME names the container, so shards do not remove each other", () => {
  // Before #2085 the name was fixed and start ran `docker rm -f` on it, so starting
  // shard 2 killed shard 1. The removal must target this instance's own name.
  const r = runScript({ env: { LANGFLOW_CONTAINER_NAME: "langflow-e2e-runner-7871", LANGFLOW_PORT: "7871" } });
  assert.match(runCallOf(r), /--name langflow-e2e-runner-7871 /);
  assert.ok(r.calls.includes("rm -f langflow-e2e-runner-7871"));
  assert.ok(!r.calls.includes("rm -f langflow-e2e-runner"), "another instance's name is left alone");
});

test("the port is published as before unless a bind host is given", () => {
  const r0 = runScript();
  assert.match(runCallOf(r0), / -p 7860:7860 /);
  assert.deepEqual(r0.urls, ["http://localhost:7860/health_check", "http://localhost:7860/api/v1/version"]);
  const r = runScript({ env: { LANGFLOW_BIND_HOST: "127.0.0.1", LANGFLOW_PORT: "7870" } });
  assert.match(runCallOf(r), / -p 127\.0\.0\.1:7870:7870 /);
});

test("the container listens on the port it is published on, so Langflow reaches itself there (#2159)", () => {
  // Remapped, localhost:<port> does not exist inside the container: the A2A self-card
  // fetch and the Streamable HTTP MCP self-registration failed on every shard but none.
  const r = runScript({ env: { LANGFLOW_BIND_HOST: "127.0.0.1", LANGFLOW_PORT: "7881" } });
  assert.match(runCallOf(r), / -p 127\.0\.0\.1:7881:7881 /);
  assert.match(runCallOf(r), / -e LANGFLOW_PORT=7881 /);
  const r0 = runScript();
  assert.match(runCallOf(r0), / -p 7860:7860 /);
  assert.match(runCallOf(r0), / -e LANGFLOW_PORT=7860 /);
});

test("readiness asks the address the port is published on", () => {
  // Bound to one non-loopback address, `localhost` is refused: a healthy container
  // would wait out the whole budget and the start would fail (#2086 review).
  const r = runScript({ env: { LANGFLOW_BIND_HOST: "10.23.12.107", LANGFLOW_PORT: "7870" } });
  assert.match(runCallOf(r), / -p 10\.23\.12\.107:7870:7870 /);
  assert.deepEqual(r.urls, ["http://10.23.12.107:7870/health_check", "http://10.23.12.107:7870/api/v1/version"]);
});

test("a wildcard bind is published as given and still probed on localhost", () => {
  for (const [host, spec] of [["0.0.0.0", "0\\.0\\.0\\.0"], ["::", "\\[::\\]"]]) {
    const r = runScript({ env: { LANGFLOW_BIND_HOST: host, LANGFLOW_PORT: "7870" } });
    assert.match(runCallOf(r), new RegExp(` -p ${spec}:7870:7870 `));
    assert.equal(r.urls[0], "http://localhost:7870/health_check", `${host} answers on localhost`);
  }
});

test("an IPv6 bind takes brackets in the publish spec and the probe, given with or without them", () => {
  for (const host of ["::1", "[::1]"]) {
    const r = runScript({ env: { LANGFLOW_BIND_HOST: host, LANGFLOW_PORT: "7870" } });
    assert.match(runCallOf(r), / -p \[::1\]:7870:7870 /, `from '${host}'`);
    assert.equal(r.urls[0], "http://[::1]:7870/health_check", `from '${host}'`);
  }
});

test("tracing stays off by default, and a lane can turn it on", () => {
  // Off is the local decision (#1300). The lanes run with it on (#1714), and before
  // #2085 no caller could ask for that.
  assert.match(runCallOf(runScript()), /LANGFLOW_DEACTIVATE_TRACING=true /);
  const r = runScript({ env: { LANGFLOW_DEACTIVATE_TRACING: "false" } });
  assert.match(runCallOf(r), /LANGFLOW_DEACTIVATE_TRACING=false /);
});

test("the worker timeout and the SQLite pragmas are forwarded by name, never given a value here", () => {
  // `-e NAME` with no value makes docker forward the variable only when it is set.
  // A value written here would become a starter default, which run-e2e.sh rules out
  // for the worker timeout (#1048), and an empty one would reach the container as "".
  for (const env of [{}, { LANGFLOW_WORKER_TIMEOUT: "120", LANGFLOW_SQLITE_PRAGMAS: '{"foreign_keys": "ON"}' }]) {
    const call = runCallOf(runScript({ env }));
    assert.match(call, / -e LANGFLOW_WORKER_TIMEOUT -e /);
    assert.match(call, / -e LANGFLOW_SQLITE_PRAGMAS -e /);
    assert.doesNotMatch(call, /LANGFLOW_WORKER_TIMEOUT=/);
    assert.doesNotMatch(call, /LANGFLOW_SQLITE_PRAGMAS=/);
  }
});

test("the readiness budget is LANGFLOW_READY_TIMEOUT_S, and a failure names the container", () => {
  const r = runScript({ healthy: false, env: { LANGFLOW_READY_TIMEOUT_S: "12", LANGFLOW_CONTAINER_NAME: "lf-7872" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /up to 12s/);
  assert.match(r.stdout, /Waiting\.\.\. \(15s\)/, "12 s rounds up to three 5 s attempts");
  assert.doesNotMatch(r.stdout, /Waiting\.\.\. \(20s\)/);
  assert.ok(r.calls.includes("logs lf-7872"), "the logs printed are this instance's");
});

test("the default readiness budget is still 120 s", () => {
  const r = runScript({ healthy: false });
  assert.match(r.stdout, /Waiting\.\.\. \(120s\)/);
  assert.doesNotMatch(r.stdout, /Waiting\.\.\. \(125s\)/);
});

test("a readiness budget that is not a positive integer is refused before anything starts", () => {
  // Leading zeros included: bash reads them as octal, so `08` aborted AFTER the
  // container was running and `030` silently meant 24 s (#2086 review).
  for (const bad of ["0", "abc", "-5", "1.5", "00", "08", "09", "030"]) {
    const r = runScript({ env: { LANGFLOW_READY_TIMEOUT_S: bad } });
    assert.equal(r.status, 1, `'${bad}' must be refused`);
    assert.match(r.stdout, /LANGFLOW_READY_TIMEOUT_S must be a positive integer/);
    assert.equal(runCallOf(r), undefined, "nothing may be started");
  }
});

test("stop removes the named container, and the documented one by default", () => {
  assert.deepEqual(runScript({ script: STOP_SCRIPT }).calls, [
    "container inspect langflow-e2e-runner",
    "rm -f langflow-e2e-runner",
  ]);
  const r = runScript({ script: STOP_SCRIPT, env: { LANGFLOW_CONTAINER_NAME: "langflow-e2e-runner-7873" } });
  assert.deepEqual(r.calls, ["container inspect langflow-e2e-runner-7873", "rm -f langflow-e2e-runner-7873"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^Container stopped\.$/m);
  assert.doesNotMatch(r.stdout, /No container to stop/);
});

test("stop with no container says so, even though rm -f would have exited 0 (#2090)", () => {
  // Both wordings: docker capitalises "No such", podman (and the QA VMs' podman
  // shim) does not, so a case-sensitive match would break only there.
  for (const container of ["absent", "absent-podman"]) {
    const r = runScript({ script: STOP_SCRIPT, container });
    assert.equal(r.status, 0, container);
    assert.match(r.stdout, /^No container to stop\.$/m, container);
    assert.doesNotMatch(r.stdout, /Container stopped/, container);
    assert.deepEqual(r.calls, ["container inspect langflow-e2e-runner"], `${container}: nothing to remove, so no rm`);
  }
});

test("stop that cannot ask docker fails naming why, never as 'no container'", () => {
  // socket-missing carries "no such" too ("no such file or directory"), which a
  // match on "no such" alone read as an absent container (#2144 review).
  for (const [container, cause] of [
    ["daemon-down", /Cannot connect to the Docker daemon/],
    ["socket-missing", /dial unix \/var\/run\/docker\.sock: connect: no such file or directory/],
  ]) {
    const r = runScript({ script: STOP_SCRIPT, container });
    assert.equal(r.status, 1, container);
    assert.match(r.stdout, /Could not check for container langflow-e2e-runner: /, container);
    assert.match(r.stdout, cause, container);
    assert.doesNotMatch(r.stdout, /No container to stop|Container stopped/, container);
    assert.ok(!r.calls.some((c) => c.startsWith("rm ")), `${container}: nothing may be removed blind`);
  }
});
