// Unit tests for scripts/start-echo-source.sh and scripts/stop-echo-source.sh.
// Run with: npm run test:scripts
//
// What these protect: the properties that make a native echo endpoint safe to hand
// the echo-dependent specs. Every one of them fails GREEN if it breaks.
//
//   - The version is the container's. These specs are written against go-httpbin's
//     exact behaviour, and the lane this starter serves exists to compare the VM's
//     verdict with the Actions runner's — so a different build is the one difference
//     that lane cannot tell from a product change. The pin is read out of the
//     workflows at test time, never copied here, so bumping the image without
//     bumping the script fails this file instead of drifting.
//   - The bind address is one the specs can assert against. Loopback fails loudly;
//     a PUBLIC address is the dangerous one, because `privateEchoEndpoint()` SKIPS
//     rather than fails, and a lane one silent test short reports success. A host
//     that carries a public address alongside the private one puts the wrong pick
//     one interface-ordering away.
//   - The download is verified, and the checksum line is matched by WHOLE filename.
//     The release publishes `<asset>.sbom.json` beside the asset, so any substring
//     match picks up both lines and the verification fails for a reason that has
//     nothing to do with the download. That happened the first time this ran.
//   - Per-port state, and a PID file that names the process that has to die.
//   - Readiness is established, not assumed: an occupied port and a process that
//     exits during startup are both refused.
//
// curl, tar, the go-httpbin binary and `ip` are stubbed through a PATH shim, so
// nothing is downloaded and no server runs; the checksum arithmetic, however, is
// real — the stub tarball is hashed by the same `sha256sum`/`shasum` the script uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");
const START = join(HERE, "start-echo-source.sh");
const STOP = join(HERE, "stop-echo-source.sh");

// Unique per START, not per test file. Most tests here leave their stub server
// running, so a marker shared across them makes the stop script's "no survivors"
// assertion read every earlier test's leftovers and fail on somebody else's process.
// The process id keeps it unique against a concurrent run of this same file.
let markerSeq = 40;
function nextMarker() {
  markerSeq += 1;
  return `${markerSeq}.${process.pid}`;
}

function processTable() {
  return execFileSync("ps", ["-ax", "-o", "command="], { encoding: "utf8" });
}

function serverPattern(marker) {
  return new RegExp(`sleep ${marker.replace(".", "\\.")}`);
}

/** Bounded synchronous wait — the starter returns before the launched process has
 * necessarily reached its first instruction, so reading the process table straight
 * after execFileSync is a race that only loses under load. */
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
 * Runs the starter with curl, tar, `ip` and the binary itself stubbed.
 *
 * `portBusy: true` makes the PRE-START probe answer, which is a port already taken.
 * `healthy: false` makes the readiness probe refuse, reaching the timeout branch.
 * `serverExits: true` makes the launched binary exit at once, as a failed bind does.
 * `binaryPresent` / `binaryVersion` cover the provisioning branches: absent means
 * download, present-and-wrong-version means refuse.
 * `addresses` is what the stubbed `ip` reports, in order.
 * `corruptDownload: true` makes the stub curl deliver a tarball whose bytes do not
 * match the published checksum.
 */
function runScript({
  env = {},
  healthy = true,
  portBusy = false,
  serverExits = false,
  binaryPresent = true,
  binaryVersion = null,
  addresses = ["203.0.113.10", "10.0.0.5"],
  corruptDownload = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "start-echo-source-test-"));
  const bin = join(dir, "bin");
  const binDir = join(dir, "echo-bin");
  const stateRoot = join(dir, "state-root");
  const releaseDir = join(dir, "release");
  mkdirSync(bin);
  mkdirSync(binDir);
  mkdirSync(stateRoot);
  mkdirSync(releaseDir);

  const version = env.ECHO_VERSION ?? pinnedVersion();
  const marker = nextMarker();

  // The fake go-httpbin: answers -version, and otherwise becomes a long-lived
  // process, because the starter checks that what it launched is still alive before
  // it will call the endpoint ready.
  const fakeBinary = `#!/usr/bin/env bash
echo "$*" >> "${join(dir, "server.args")}"
if [ "$1" = "-version" ]; then
  echo "go-httpbin version ${binaryVersion ?? version}"
  exit 0
fi
${serverExits ? "exit 1" : `exec sleep ${marker}`}
`;

  // A real tarball, hashed for real. `checksums.txt` carries the decoy `.sbom.json`
  // line the release actually publishes, FIRST, so a substring match would pick it.
  const asset = "go-httpbin-linux-amd64.tar.gz";
  const payloadDir = join(dir, "payload");
  mkdirSync(payloadDir);
  writeFileSync(join(payloadDir, "go-httpbin"), fakeBinary, { mode: 0o755 });
  execFileSync("tar", ["czf", join(releaseDir, asset), "-C", payloadDir, "go-httpbin"]);
  const tarBytes = readFileSync(join(releaseDir, asset));
  const trueSum = createHash("sha256").update(tarBytes).digest("hex");
  const publishedSum = corruptDownload ? "0".repeat(64) : trueSum;
  writeFileSync(
    join(releaseDir, "checksums.txt"),
    [
      `${"f".repeat(64)}  ${asset}.sbom.json`,
      `${publishedSum}  ${asset}`,
      `${"e".repeat(64)}  go-httpbin-darwin-all.tar.gz`,
    ].join("\n") + "\n",
  );

  if (binaryPresent) {
    writeFileSync(join(binDir, `go-httpbin-${version}`), fakeBinary, { mode: 0o755 });
  }

  const curlLog = join(dir, "curl.log");
  const probeCount = join(dir, "probe.count");

  // One stub, two jobs, told apart by `-o`: a download writes a file, a probe
  // answers. Probe call 1 is the pre-start "is this port taken?" check and every
  // later call is the readiness poll — they need opposite answers in the ordinary
  // case, so the stub counts rather than guessing from its arguments.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
echo "$*" >> "${curlLog}"
OUT=""
URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    http*) URL="$1"; shift ;;
    *) shift ;;
  esac
done
if [ -n "$OUT" ]; then
  SRC="${releaseDir}/$(basename "$URL")"
  [ -f "$SRC" ] || exit 22
  cp "$SRC" "$OUT"
  exit 0
fi
N=$(cat "${probeCount}" 2>/dev/null || echo 0)
N=$((N + 1))
echo "$N" > "${probeCount}"
if [ "$N" -eq 1 ]; then
  ${portBusy ? "exit 0" : "exit 22"}
fi
${healthy && !serverExits ? "exit 0" : "exit 22"}
`,
    { mode: 0o755 },
  );

  writeFileSync(
    join(bin, "ip"),
    `#!/usr/bin/env bash
${addresses.map((a, i) => `echo "${i + 2}: eth${i}    inet ${a}/21 brd 10.0.0.255 scope global eth${i}"`).join("\n")}
exit 0
`,
    { mode: 0o755 },
  );

  const result = spawnSync("bash", [START], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      ECHO_BIN_DIR: binDir,
      ECHO_STATE_ROOT: stateRoot,
      ECHO_POLL_INTERVAL_S: "1",
      ECHO_START_TIMEOUT_S: "2",
      ECHO_RELEASE_BASE: "https://example.invalid/release",
      ...env,
    },
  });

  return {
    ...result,
    dir,
    binDir,
    stateRoot,
    marker,
    curl: existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "",
    serverArgs: existsSync(join(dir, "server.args")) ? readFileSync(join(dir, "server.args"), "utf8") : "",
    cleanup: () => {
      // Kills this call's stub server before dropping the directory. Without it the
      // sleeps outlive the run and pile up for the length of the suite.
      spawnSync("pkill", ["-f", `sleep ${marker}`]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The go-httpbin tag the CI lanes run, read from the workflows themselves. */
function pinnedVersion() {
  const lanes = readdirSync(join(REPO_ROOT, ".github/workflows")).filter((f) => f.endsWith(".yml"));
  const tags = new Set();
  for (const lane of lanes) {
    const text = readFileSync(join(REPO_ROOT, ".github/workflows", lane), "utf8");
    for (const m of text.matchAll(/ghcr\.io\/mccutchen\/go-httpbin:([\w.]+)/g)) tags.add(m[1]);
  }
  assert.equal(tags.size, 1, `expected one go-httpbin tag across the lanes, found ${[...tags].join(", ")}`);
  return [...tags][0];
}

test("the version default IS the tag the CI lanes run", () => {
  // The whole point of a native echo is that it behaves like the container. Read
  // from the workflows rather than compared to a copy, so bumping the image without
  // bumping this script fails here instead of turning into a VM-only divergence
  // that looks like a product change.
  const script = readFileSync(START, "utf8");
  const declared = script.match(/VERSION="\$\{ECHO_VERSION:-([\w.]+)\}"/)?.[1];
  assert.equal(declared, pinnedVersion());
});

test("the RFC-1918 address is chosen over the public one the VM also carries", () => {
  const r = runScript({});
  assert.equal(r.status, 0, r.stderr);
  // Both the human line and the machine-readable one, since a caller over ssh reads
  // the second and a person reads the first.
  assert.match(r.stdout, /on 10\.0\.0\.5:8080/);
  assert.match(r.stdout, /^ECHO_HOST_IP=10\.0\.0\.5$/m);
  assert.match(r.serverArgs, /-host 10\.0\.0\.5/);
  r.cleanup();
});

test("a machine with no private address is refused, naming the silent skip", () => {
  const r = runScript({ addresses: ["203.0.113.10"] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no RFC-1918 address/);
  // "Unreachable" would send the reader to the firewall; the address is reachable,
  // which is exactly why this has to name the skip instead.
  assert.match(r.stderr, /SKIP/);
  r.cleanup();
});

test("an explicit public bind host is refused for the same reason", () => {
  const r = runScript({ env: { ECHO_BIND_HOST: "203.0.113.10" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not an RFC-1918 address/);
  assert.match(r.stderr, /private-echo-endpoint\.ts/);
  r.cleanup();
});

test("loopback is refused, because Langflow blocks it whatever the allowlist says", () => {
  for (const host of ["127.0.0.1", "localhost"]) {
    const r = runScript({ env: { ECHO_BIND_HOST: host } });
    assert.equal(r.status, 2, host);
    assert.match(r.stderr, /loopback/);
    r.cleanup();
  }
});

test("state is keyed on the port, so two endpoints do not share a PID file", () => {
  // STATE_DIR is never injected here — only STATE_ROOT — so the leaf the script
  // derives is the thing under test.
  const r = runScript({ env: { ECHO_PORT: "8081", ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(r.stateRoot, "echo-source-8081", "echo.pid")));
  assert.ok(!existsSync(join(r.stateRoot, "echo-source-8080")));
  r.cleanup();
});

test("the PID file names the process that has to die", () => {
  const r = runScript({ env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(waitFor(() => serverPattern(r.marker).test(processTable())), "the stub server never appeared");

  execFileSync("bash", [STOP], {
    encoding: "utf8",
    env: { ...process.env, ECHO_STATE_ROOT: r.stateRoot },
  });

  assert.ok(
    waitFor(() => !serverPattern(r.marker).test(processTable())),
    "the process the PID file named survived the stop script",
  );
  r.cleanup();
});

test("a port that already answers is refused, not started on top of", () => {
  // Without this the failed bind is invisible: the readiness poll would be answered
  // by the OTHER endpoint and the lane would run against it.
  const r = runScript({ portBusy: true, env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already answers \/get/);
  r.cleanup();
});

test("a binary that exits during startup is reported as that, not as a timeout", () => {
  const r = runScript({ serverExits: true, env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exited after/);
  // The PID file has to go, or the next start refuses over a process that is gone.
  assert.ok(!existsSync(join(r.stateRoot, "echo-source-8080", "echo.pid")));
  r.cleanup();
});

test("an endpoint that never answers fails instead of reporting ready", () => {
  const r = runScript({ healthy: false, env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not answer/);
  r.cleanup();
});

test("readiness is probed at the address Langflow will call, not at loopback", () => {
  // Probing loopback would confirm the process is up without confirming the specs
  // can reach it — and a bind on the wrong interface breaks only the second half.
  const r = runScript({ env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.curl, /http:\/\/10\.0\.0\.5:8080\/get/);
  assert.doesNotMatch(r.curl, /localhost:8080/);
  r.cleanup();
});

test("a missing binary is downloaded and verified against the whole filename", () => {
  // The release publishes `<asset>.sbom.json`, and its line sits FIRST in the
  // fixture's checksums.txt. A substring match would take it and the verification
  // would fail for a reason unrelated to the download.
  const r = runScript({ binaryPresent: false, env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Installed .*go-httpbin-/);
  assert.match(r.stdout, new RegExp(`verified ${pinnedVersion().replace(/\./g, "\\.")}`));
  assert.ok(existsSync(join(r.binDir, `go-httpbin-${pinnedVersion()}`)));
  r.cleanup();
});

test("a download whose checksum does not match installs nothing", () => {
  const r = runScript({ binaryPresent: false, corruptDownload: true, env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /checksum mismatch/);
  assert.ok(!existsSync(join(r.binDir, `go-httpbin-${pinnedVersion()}`)));
  r.cleanup();
});

test("a binary whose own -version disagrees with the pin is refused, not reused", () => {
  // The file name cannot catch this: a truncated extract, or a binary someone put
  // there by hand, carries the pinned name and a different build.
  const r = runScript({ binaryVersion: "2.20.0", env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reports version '2\.20\.0'/);
  r.cleanup();
});

test("ECHO_DOWNLOAD=0 refuses rather than reaching the network", () => {
  const r = runScript({ binaryPresent: false, env: { ECHO_DOWNLOAD: "0", ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /ECHO_DOWNLOAD is not 1/);
  // The pre-start port probe is local and still expected; what must not happen is a
  // download, which is the only curl call here that leaves the machine.
  assert.doesNotMatch(r.curl, /-o /, "it downloaded anyway");
  r.cleanup();
});

test("-use-real-hostname is never passed, so /hostname leaks no topology", () => {
  // Off by default upstream, and it has to stay off: the real hostname is internal
  // topology, and /hostname would publish it into whatever report captures the
  // response. Asserted because "we did not add a flag" is exactly what a later edit
  // adds without noticing.
  const r = runScript({ env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.serverArgs, /use-real-hostname/);
  r.cleanup();
});

test("the max-duration default leaves /delay/5 inside the limit", () => {
  // A spec asserts /delay/5. go-httpbin refuses a delay above -max-duration, so
  // lowering this default turns that spec red for a cause no one would look for.
  const r = runScript({ env: { ECHO_BIND_HOST: "10.0.0.5" } });
  assert.equal(r.status, 0, r.stderr);
  const seconds = Number(r.serverArgs.match(/-max-duration (\d+)s/)?.[1]);
  assert.ok(seconds >= 5, `-max-duration ${seconds}s does not cover the /delay/5 spec`);
  r.cleanup();
});

test("a rejected poll interval names itself instead of failing inside sleep", () => {
  // "" is absent from this list on purpose: `${ECHO_POLL_INTERVAL_S:-1}` treats an
  // empty value as unset, so it legitimately takes the default rather than failing.
  for (const value of ["0", "abc", "-1"]) {
    const r = runScript({ env: { ECHO_POLL_INTERVAL_S: value, ECHO_BIND_HOST: "10.0.0.5" } });
    assert.equal(r.status, 2, `interval ${JSON.stringify(value)}`);
    assert.match(r.stderr, /positive integer/);
    r.cleanup();
  }
});

test("a rejected start deadline names itself instead of reporting a timeout", () => {
  // The nastier half of the same class as the interval: `[ 0 -lt abc ]` exits 2, a
  // `while` reads that as false, so the readiness loop runs ZERO times — the script
  // killed the server it had just launched and printed "did not answer in abcs", a
  // timeout message for a typo, on a run that never probed anything.
  for (const value of ["0", "abc", "-1"]) {
    const r = runScript({ env: { ECHO_START_TIMEOUT_S: value, ECHO_BIND_HOST: "10.0.0.5" } });
    assert.equal(r.status, 2, `deadline ${JSON.stringify(value)}`);
    assert.match(r.stderr, /ECHO_START_TIMEOUT_S must be a positive integer/);
    assert.doesNotMatch(r.stderr, /did not answer/, "it reached the loop and reported a timeout");
    r.cleanup();
  }
});

test("stopping a port with no PID file is a no-op, not an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-echo-source-test-"));
  const r = spawnSync("bash", [STOP], {
    encoding: "utf8",
    env: { ...process.env, ECHO_STATE_ROOT: dir, ECHO_PORT: "8099" },
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No PID file for port 8099/);
  rmSync(dir, { recursive: true, force: true });
});
