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
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./start-langflow-docker.sh", import.meta.url));

/**
 * Runs the script with `docker` and `curl` stubbed out.
 *
 * The docker stub logs every invocation and can be told to fail `pull` and to
 * deny that a local copy exists, which is how the two refresh-failure branches
 * are reached. The curl stub answers the health check immediately so the run
 * does not sit through the 120 s readiness loop.
 */
function runScript({ args = [], env = {}, pullFails = false, localCopy = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "start-langflow-test-"));
  const log = join(dir, "docker.log");

  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1" in
  pull) [ "\${FAKE_PULL_FAILS}" = "1" ] && exit 1 ;;
  image) [ "$2" = "inspect" ] && [ "\${FAKE_LOCAL_COPY}" = "0" ] && exit 1 ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
echo '{"version":"0.0.0-test"}'
exit 0
`,
  );
  chmodSync(join(dir, "docker"), 0o755);
  chmodSync(join(dir, "curl"), 0o755);

  let stdout = "";
  let status = 0;
  try {
    stdout = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_PULL_FAILS: pullFails ? "1" : "0",
        FAKE_LOCAL_COPY: localCopy ? "1" : "0",
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
  rmSync(dir, { recursive: true, force: true });

  const runCall = calls.find((c) => c.startsWith("run "));
  return {
    stdout,
    status,
    calls,
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
  // LANGFLOW_WORKERS=1 is load-bearing (#773: OOM on a small Docker VM) and
  // LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true is required by every custom-component
  // spec (#668/#746). Both are easy to drop when editing the run block.
  const r = runScript();
  const runCall = r.calls.find((c) => c.startsWith("run "));
  assert.match(runCall, /LANGFLOW_WORKERS=1/);
  assert.match(runCall, /LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true/);
  assert.match(runCall, /LANGFLOW_AUTO_LOGIN=true/);
});
