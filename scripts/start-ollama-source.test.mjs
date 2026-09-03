// Unit tests for scripts/start-ollama-source.sh and scripts/stop-ollama-source.sh.
// Run with: npm run test:scripts
//
// What these protect: the properties that make a native Ollama safe to hand
// ollama-provider.spec.ts. Every one of them fails GREEN if it breaks.
//
//   - The version is the container's. The spec compares a VM verdict against an
//     Actions verdict, so a different Ollama build is the one difference that lane
//     cannot tell from a product change. The pin is read out of
//     docker/ollama-e2e/Dockerfile at test time, never copied here — which is also
//     why that file had to stop saying `latest`: an unpinned base means the image
//     moves on rebuild and nothing fails until the VM reports a phantom.
//   - The model is the container's too, read from the same Dockerfile and
//     cross-checked against every lane's OLLAMA_TEST_MODEL.
//   - The bind address is one Langflow can call. Loopback is blocked by the SSRF
//     layer whatever the allowlist says; a public address is not admitted by
//     LANGFLOW_SSRF_ALLOWED_HOSTS, so the provider call the spec asserts on would be
//     refused and read as a product bug.
//   - Ready means the MODEL is there, not just the server. A model-less instance
//     answers /api/tags perfectly and makes the spec SKIP with a reason nobody reads
//     on a green lane — a lane one silent test short reports success.
//   - The download is verified, and the checksum line is matched by WHOLE filename.
//     This release writes its entries as `./<asset>` and publishes a 1 GB
//     `-rocm` sibling, so a substring match picks the wrong line and the failure
//     looks like a corrupt download.
//   - Per-port state, a PID file that names the process that has to die, and no
//     orphan left behind on any failure path.
//
// curl, tar, zstd, `ip` and the ollama binary itself are stubbed through a PATH shim,
// so nothing is downloaded and no server runs; the checksum arithmetic is real — the
// stub tarball is hashed by the same sha256sum/shasum the script uses.
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
// Absolute, for the reason the echo starter's tests record: one case runs the script
// with the stub directory as its whole PATH, and a bare "bash" would be looked up
// there and fail to spawn at all (status null, which reads as a crash).
const BASH = execFileSync("/usr/bin/env", ["bash", "-c", "command -v bash"], { encoding: "utf8" }).trim();
const REAL_TAR = execFileSync("/usr/bin/env", ["bash", "-c", "command -v tar"], { encoding: "utf8" }).trim();
const START = join(HERE, "start-ollama-source.sh");
const STOP = join(HERE, "stop-ollama-source.sh");

// Unique per START: most tests leave their stub server running, so a marker shared
// across them makes an assertion about survivors read someone else's process.
let markerSeq = 70;
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
 * after spawnSync is a race that only loses under load. */
function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const idle = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (predicate()) return true;
    Atomics.wait(idle, 0, 0, 25);
  }
  return predicate();
}

/** The Ollama version the CI image is built from, read from the Dockerfile itself. */
function pinnedVersion() {
  const text = readFileSync(join(REPO_ROOT, "docker/ollama-e2e/Dockerfile"), "utf8");
  const tag = text.match(/^FROM\s+ollama\/ollama:([\w.]+)\s*$/m)?.[1];
  assert.ok(tag, "docker/ollama-e2e/Dockerfile has no pinned `FROM ollama/ollama:<version>` line");
  assert.notEqual(tag, "latest", "the base image must be pinned: `latest` moves the container without moving this script");
  return tag;
}

/** The model baked into that image, cross-checked against every lane that names it. */
function pinnedModel() {
  const text = readFileSync(join(REPO_ROOT, "docker/ollama-e2e/Dockerfile"), "utf8");
  const model = text.match(/^ARG\s+OLLAMA_E2E_MODEL=(\S+)\s*$/m)?.[1];
  assert.ok(model, "docker/ollama-e2e/Dockerfile has no ARG OLLAMA_E2E_MODEL");

  const lanes = readdirSync(join(REPO_ROOT, ".github/workflows")).filter((f) => f.endsWith(".yml"));
  const declared = new Set();
  for (const lane of lanes) {
    const laneText = readFileSync(join(REPO_ROOT, ".github/workflows", lane), "utf8");
    for (const m of laneText.matchAll(/OLLAMA_TEST_MODEL:\s*(\S+)/g)) declared.add(m[1]);
  }
  assert.deepEqual([...declared], [model], `lanes name ${[...declared].join(", ")}, the image bakes ${model}`);
  return model;
}

/**
 * Runs the starter with curl, tar, zstd, `ip` and the ollama binary stubbed.
 *
 * `portBusy: true` makes the PRE-START probe answer, which is a port already taken.
 * `healthy: false` makes the readiness probe refuse, reaching the timeout branch.
 * `serverExits: true` makes the launched binary exit at once, as a failed bind does.
 * `ignoresTerm: true` makes it ignore SIGTERM — the shape every stop path has to
 * survive, since `kill` returning 0 only proves delivery.
 * `binaryPresent` / `binaryVersion` cover the provisioning branches; `versionExitCode`
 * makes the binary print its version and still exit non-zero, which the real client
 * does when it cannot reach a server.
 * `modelPresent: false` starts an instance without the model; `pullWorks` then says
 * whether the pull this script runs fixes that.
 * `addresses` is what the stubbed `ip` reports, in order.
 * `corruptDownload: true` makes the stub curl deliver bytes that do not match the
 * published checksum.
 */
function runScript({
  env = {},
  healthy = true,
  portBusy = false,
  serverExits = false,
  ignoresTerm = false,
  binaryPresent = true,
  binaryVersion = null,
  versionExitCode = 0,
  modelPresent = true,
  pullWorks = true,
  addresses = ["203.0.113.10", "10.0.0.5"],
  corruptDownload = false,
  discoveryTools = true,
  probeDelayS = 0,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "start-ollama-source-test-"));
  const bin = join(dir, "bin");
  const prefix = join(dir, "ollama-prefix");
  const stateRoot = join(dir, "state-root");
  const releaseDir = join(dir, "release");
  mkdirSync(bin);
  mkdirSync(stateRoot);
  mkdirSync(releaseDir);

  const version = env.OLLAMA_VERSION ?? pinnedVersion();
  const model = env.OLLAMA_E2E_MODEL ?? pinnedModel();
  const marker = nextMarker();
  const modelFlag = join(dir, "model.present");
  const pullLog = join(dir, "pull.log");
  if (modelPresent) writeFileSync(modelFlag, "");

  // The fake ollama. `--version` answers the way the real one does with no server
  // running — a warning line first, the version on the next — because the script's
  // parse has to survive exactly that.
  const fakeBinary = `#!/usr/bin/env bash
echo "$* host=\${OLLAMA_HOST:-unset}" >> "${join(dir, "server.args")}"
case "$1" in
  --version)
    echo "Warning: could not connect to a running Ollama instance"
    echo "Warning: client version is ${binaryVersion ?? version}"
    exit ${versionExitCode}
    ;;
  list)
    echo "NAME    ID    SIZE    MODIFIED"
    [ -f "${modelFlag}" ] && echo "${model}    abc123    1.3 GB    1 minute ago"
    exit 0
    ;;
  pull)
    echo "pull $2 host=\${OLLAMA_HOST:-unset}" >> "${pullLog}"
    ${pullWorks ? `: > "${modelFlag}"` : ":"}
    exit 0
    ;;
  serve)
    ${serverExits ? "exit 1" : `${ignoresTerm ? "trap '' TERM\n    " : ""}exec sleep ${marker}`}
    ;;
esac
exit 0
`;

  // A real archive, hashed for real, named the way the release names it. The
  // published list carries the `-rocm` sibling FIRST and writes paths with a `./`
  // prefix — both are what the real sha256sum.txt does, and both are what a
  // substring match gets wrong.
  const asset = "ollama-linux-amd64.tar.zst";
  const payloadDir = join(dir, "payload");
  mkdirSync(join(payloadDir, "bin"), { recursive: true });
  mkdirSync(join(payloadDir, "lib", "ollama"), { recursive: true });
  writeFileSync(join(payloadDir, "bin", "ollama"), fakeBinary, { mode: 0o755 });
  writeFileSync(join(payloadDir, "lib", "ollama", "runner"), "stub\n");
  execFileSync(REAL_TAR, ["czf", join(releaseDir, asset), "-C", payloadDir, "bin", "lib"]);
  const trueSum = createHash("sha256").update(readFileSync(join(releaseDir, asset))).digest("hex");
  writeFileSync(
    join(releaseDir, "sha256sum.txt"),
    [
      `${"f".repeat(64)}  ./ollama-linux-amd64-rocm.tar.zst`,
      `${corruptDownload ? "0".repeat(64) : trueSum}  ./${asset}`,
      `${"e".repeat(64)}  ./ollama-darwin.tgz`,
    ].join("\n") + "\n",
  );

  if (binaryPresent) {
    mkdirSync(join(prefix, "bin"), { recursive: true });
    writeFileSync(join(prefix, "bin", "ollama"), fakeBinary, { mode: 0o755 });
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
${probeDelayS ? `[ "$N" -gt 1 ] && sleep ${probeDelayS}` : ":"}
if [ "$N" -eq 1 ]; then
  ${portBusy ? "exit 0" : "exit 22"}
fi
${healthy && !serverExits ? "exit 0" : "exit 22"}
`,
    { mode: 0o755 },
  );

  // The asset is really a .tar.gz wearing the release's name: zstd is not available
  // on every developer machine, and stubbing the DECOMPRESSION would also stub the
  // layout check this file wants to exercise for real (bin/ollama beside lib/).
  writeFileSync(
    join(bin, "tar"),
    `#!/usr/bin/env bash
ARGS=()
for a in "$@"; do
  [ "$a" = "--zstd" ] && continue
  ARGS+=("$a")
done
exec "${REAL_TAR}" -z "\${ARGS[@]}"
`,
    { mode: 0o755 },
  );
  // Only ever reached by \`command -v\`: the script names a missing zstd rather than
  // letting tar fail with a message about a compression program.
  writeFileSync(join(bin, "zstd"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

  if (discoveryTools) {
    writeFileSync(
      join(bin, "ip"),
      `#!/usr/bin/env bash
${addresses.map((a, i) => `echo "${i + 2}: eth${i}    inet ${a}/21 brd 10.0.0.255 scope global eth${i}"`).join("\n")}
exit 0
`,
      { mode: 0o755 },
    );
  }

  const result = spawnSync(BASH, [START], {
    encoding: "utf8",
    env: {
      ...process.env,
      // With the discovery tools removed the stub directory is the WHOLE path. That
      // is sufficient on purpose: the guard under test runs on builtins alone, ahead
      // of the first external the script needs.
      PATH: discoveryTools ? `${bin}:${process.env.PATH}` : bin,
      HOME: dir,
      OLLAMA_PREFIX: prefix,
      OLLAMA_STATE_ROOT: stateRoot,
      OLLAMA_POLL_INTERVAL_S: "1",
      OLLAMA_START_TIMEOUT_S: "2",
      OLLAMA_PULL_TIMEOUT_S: "5",
      OLLAMA_RELEASE_BASE: "https://example.invalid/release",
      // Inherited from a developer's shell this would point the stub client at a real
      // instance, and the model assertions would read that machine's models.
      OLLAMA_HOST: "",
      ...env,
    },
  });

  return {
    ...result,
    dir,
    prefix,
    stateRoot,
    marker,
    curl: existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "",
    pulls: existsSync(pullLog) ? readFileSync(pullLog, "utf8") : "",
    serverArgs: existsSync(join(dir, "server.args")) ? readFileSync(join(dir, "server.args"), "utf8") : "",
    cleanup: () => {
      spawnSync("pkill", ["-f", `sleep ${marker}`]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("the version default IS the tag the CI image is built from", () => {
  // Read from the Dockerfile rather than compared to a copy, so bumping the image
  // without bumping this script fails here instead of turning into a VM-only
  // divergence that looks like a product change.
  const script = readFileSync(START, "utf8");
  const declared = script.match(/VERSION="\$\{OLLAMA_VERSION:-([\w.]+)\}"/)?.[1];
  assert.equal(declared, pinnedVersion());
});

test("the model default IS the one baked into the image and named by the lanes", () => {
  const script = readFileSync(START, "utf8");
  const declared = script.match(/MODEL="\$\{OLLAMA_E2E_MODEL:-(\S+?)\}"/)?.[1];
  assert.equal(declared, pinnedModel());
});

test("the RFC-1918 address is chosen over the public one the VM also carries", () => {
  const r = runScript({});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /on 10\.0\.0\.5:11434/);
  // Both the human line and the machine-readable ones: a caller over ssh reads the
  // second set and turns it into the three variables the spec already reads.
  assert.match(r.stdout, /^OLLAMA_HOST_IP=10\.0\.0\.5$/m);
  assert.match(r.stdout, /^OLLAMA_PORT=11434$/m);
  assert.match(r.stdout, new RegExp(`^OLLAMA_MODEL=${pinnedModel().replace(".", "\\.")}$`, "m"));
  r.cleanup();
});

test("the server is told to listen on that address, not on loopback", () => {
  const r = runScript({});
  assert.equal(r.status, 0, r.stderr);
  // `ollama serve` takes its bind from OLLAMA_HOST, so the export is the whole
  // mechanism — a serve invocation without it listens on 127.0.0.1 and every
  // Langflow call is refused by the SSRF layer.
  assert.match(r.serverArgs, /serve host=10\.0\.0\.5:11434/);
  r.cleanup();
});

test("a machine with no private address is refused, naming the refusal", () => {
  const r = runScript({ addresses: ["203.0.113.10"] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no RFC-1918 address/);
  // "Unreachable" would send the reader to the firewall; the address is reachable,
  // and it is Langflow that will not call it.
  assert.match(r.stderr, /LANGFLOW_SSRF_ALLOWED_HOSTS/);
  r.cleanup();
});

test("an explicit public bind host is refused for the same reason", () => {
  const r = runScript({ env: { OLLAMA_BIND_HOST: "203.0.113.10" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not an RFC-1918 address/);
  r.cleanup();
});

test("loopback is refused, because Langflow blocks it whatever the allowlist says", () => {
  for (const host of ["127.0.0.1", "localhost"]) {
    const r = runScript({ env: { OLLAMA_BIND_HOST: host } });
    assert.equal(r.status, 2, host);
    assert.match(r.stderr, /loopback/);
    r.cleanup();
  }
});

test("no way to enumerate addresses is reported as that, not as no private address", () => {
  const r = runScript({ discoveryTools: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /neither/);
  assert.match(r.stderr, /NOT the same as having no RFC-1918 address/);
  r.cleanup();
});

test("state is keyed on the port, so two instances do not share a PID file", () => {
  const r = runScript({ env: { OLLAMA_PORT: "11435" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(r.stateRoot, "ollama-source-11435", "ollama.pid")));
  assert.ok(!existsSync(join(r.stateRoot, "ollama-source-11434", "ollama.pid")));
  r.cleanup();
});

test("an occupied port is refused, naming what a silent collision would serve", () => {
  const r = runScript({ portBusy: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already answers \/api\/tags/);
  // The specific harm is not "two servers": it is that the spec would read the OTHER
  // server's model list and either skip or assert against weights nobody pinned.
  assert.match(r.stderr, /model list/);
  r.cleanup();
});

test("a version that is printed by a binary exiting non-zero is still read", () => {
  // The real client exits non-zero when it cannot reach a server, and the parse is a
  // pipeline under `pipefail` whose awk closes the pipe early. Reading the version
  // with `|| echo unknown` inside the substitution APPENDS the fallback to the good
  // value, and the script then refuses the binary it had just read correctly.
  const r = runScript({ binaryPresent: true, versionExitCode: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /reports version/);
  r.cleanup();
});

test("a binary at the pinned path with the wrong version is refused, not reused", () => {
  const r = runScript({ binaryPresent: true, binaryVersion: "0.1.0" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /reports version '0\.1\.0'/);
  r.cleanup();
});

test("the download is verified against the whole checksum field, `./` and all", () => {
  const r = runScript({ binaryPresent: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Installed .*ollama.*verified/);
  // The prefix, not just the binary: the runners in lib/ have to travel with it.
  assert.ok(existsSync(join(r.prefix, "bin", "ollama")));
  assert.ok(existsSync(join(r.prefix, "lib", "ollama", "runner")));
  r.cleanup();
});

test("an OLLAMA_BIN that does not exist is refused before the download, not after", () => {
  // The expensive failure: without this check the script downloads and verifies ~1 GB,
  // installs the prefix, and only then dies on `chmod` against the bogus path — with
  // libc's message, the one path here that fails without explaining itself.
  const r = runScript({ binaryPresent: false, env: { OLLAMA_BIN: "/nonexistent/ollama" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /OLLAMA_BIN=\/nonexistent\/ollama is not an executable file/);
  assert.doesNotMatch(r.curl, /tar\.zst/, "the release was downloaded anyway");
  r.cleanup();
});

test("a download whose bytes do not match the published sum installs nothing", () => {
  const r = runScript({ binaryPresent: false, corruptDownload: true });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /checksum mismatch/);
  assert.ok(!existsSync(join(r.prefix, "bin", "ollama")));
  r.cleanup();
});

test("a missing model is pulled, and the pull goes to the instance this script started", () => {
  const r = runScript({ modelPresent: false });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Pulling /);
  assert.match(r.pulls, new RegExp(`pull ${pinnedModel().replace(".", "\\.")} host=10\\.0\\.0\\.5:11434`));
  r.cleanup();
});

test("a model that is still absent after a successful pull fails, and leaves no orphan", () => {
  // The dangerous case: the server is up and healthy, so every probe passes, and the
  // spec would SKIP on the missing model — green, one test short.
  const r = runScript({ modelPresent: false, pullWorks: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /still not listed/);
  assert.ok(waitFor(() => !serverPattern(r.marker).test(processTable())), "the launched server was left running");
  assert.ok(!existsSync(join(r.stateRoot, "ollama-source-11434", "ollama.pid")));
  r.cleanup();
});

test("refusing to pull is a refusal, not a start without the model", () => {
  const r = runScript({ modelPresent: false, env: { OLLAMA_PULL: "0" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /OLLAMA_PULL is not 1/);
  assert.ok(waitFor(() => !serverPattern(r.marker).test(processTable())), "the launched server was left running");
  r.cleanup();
});

test("a server that exits during startup is reported as that, not as a timeout", () => {
  // The deadline is raised for this case alone, and it is not padding: the readiness
  // loop checks liveness FIRST and the probe second, so distinguishing "exited" from
  // "timed out" needs at least one iteration to land after the stub has actually
  // died. At the 2s default that window is a single scheduling slot, and under the
  // parallel lane it is occasionally missed — the run then reports the timeout, which
  // is the message this very test exists to rule out.
  const r = runScript({ serverExits: true, env: { OLLAMA_START_TIMEOUT_S: "8" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exited after/);
  assert.ok(!existsSync(join(r.stateRoot, "ollama-source-11434", "ollama.pid")));
  r.cleanup();
});

test("a server that never answers is killed, and the PID file goes with it", () => {
  const r = runScript({ healthy: false });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not answer in 2s/);
  assert.ok(waitFor(() => !serverPattern(r.marker).test(processTable())), "the launched server was left running");
  assert.ok(!existsSync(join(r.stateRoot, "ollama-source-11434", "ollama.pid")));
  r.cleanup();
});

test("a start whose server ignores SIGTERM escalates, and says so", () => {
  // Asserted unconditionally, and that is the point of this shape. The first version
  // of this test guarded everything behind `if (survived)` — a branch that cannot be
  // taken, because the stub server is a plain `sleep` and SIGKILL always reaps it. It
  // passed while asserting nothing.
  //
  // What IS reachable is the escalation itself, and it is worth pinning: the timeout
  // path must send SIGTERM, wait the stated window, then escalate — and only then
  // drop the PID file, because it has established that the process is gone.
  //
  // The other half — KEEPING the file when even SIGKILL fails — needs a process that
  // survives SIGKILL (uninterruptible sleep), which is not reproducible portably, so
  // it stays reviewed rather than tested. The short timeout is deliberate: at the
  // 10s default this single case cost more than a third of the file's runtime.
  const r = runScript({ healthy: false, ignoresTerm: true, env: { OLLAMA_STOP_TIMEOUT_S: "2" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ignored SIGTERM after 2s; sending SIGKILL/);
  assert.ok(waitFor(() => !serverPattern(r.marker).test(processTable())), "the launched server was left running");
  assert.ok(!existsSync(join(r.stateRoot, "ollama-source-11434", "ollama.pid")));
  r.cleanup();
});

test("a stop timeout that is not an integer is refused before anything is launched", () => {
  // `30s` is the plausible spelling — it is how `timeout` takes it — and it is the
  // one value in this script whose badness announces itself nowhere: both uses sit in
  // `while` conditions, which `set -e` exempts, so the wait silently becomes zero and
  // a live server is SIGKILLed while the script reports a clean stop.
  const r = runScript({ env: { OLLAMA_STOP_TIMEOUT_S: "30s" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /OLLAMA_STOP_TIMEOUT_S must be a positive integer/);
  assert.equal(r.serverArgs, "");
  r.cleanup();
});

test("the readiness deadline is wall clock, not a count of polls", () => {
  // The case the probe's `--max-time` exists for is a FILTERED port: it does not
  // refuse, it hangs, so each iteration costs the probe plus the sleep. Counting
  // iterations turns an advertised 4s wait into 4 x (probe + sleep) — here ~12s, and
  // with the real 60s default and a 5s max-time, six minutes announced as sixty
  // seconds.
  const started = Date.now();
  const r = runScript({ healthy: false, probeDelayS: 2, env: { OLLAMA_START_TIMEOUT_S: "4", OLLAMA_STOP_TIMEOUT_S: "2" } });
  const elapsedS = (Date.now() - started) / 1000;
  assert.equal(r.status, 1);
  assert.match(r.stderr, /did not answer in 4s/);
  // Generous bound: the point is that it tracks the deadline rather than multiplying
  // it by the per-iteration cost, which would land near 12s here.
  assert.ok(elapsedS < 9, `waited ${elapsedS.toFixed(1)}s for a 4s deadline`);
  r.cleanup();
});

test("a non-numeric deadline is refused before anything is launched", () => {
  const r = runScript({ env: { OLLAMA_START_TIMEOUT_S: "abc" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /OLLAMA_START_TIMEOUT_S must be a positive integer/);
  assert.equal(r.serverArgs, "");
  r.cleanup();
});

// --- the stop script ------------------------------------------------------------

function runStop(env, stateRoot) {
  return spawnSync(BASH, [STOP], {
    encoding: "utf8",
    env: { ...process.env, OLLAMA_STATE_ROOT: stateRoot, ...env },
  });
}

test("stop is a no-op when there is no PID file for that port", () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-ollama-source-test-"));
  const r = runStop({ OLLAMA_PORT: "11434" }, dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No PID file for port 11434/);
  rmSync(dir, { recursive: true, force: true });
});

test("stop clears a PID file whose process is already gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "stop-ollama-source-test-"));
  const stateDir = join(dir, "ollama-source-11434");
  mkdirSync(stateDir, { recursive: true });
  const pidFile = join(stateDir, "ollama.pid");
  // A PID that cannot be alive: spawn something and wait for it to exit.
  const dead = spawnSync(BASH, ["-c", "exit 0"]);
  writeFileSync(pidFile, String(dead.pid ?? 999999));
  const r = runStop({ OLLAMA_PORT: "11434" }, dir);
  assert.equal(r.status, 0);
  assert.ok(!existsSync(pidFile));
  rmSync(dir, { recursive: true, force: true });
});

test("stop waits for the process to be GONE before reporting success", () => {
  const r = runScript({});
  assert.equal(r.status, 0, r.stderr);
  const stop = runStop({ OLLAMA_PORT: "11434" }, r.stateRoot);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stdout, /stopped \(PID \d+, after \d+s\)/);
  // Asserted after the stop returns, not waited for: the point of the wait inside
  // the script is that "stopped" already means gone.
  assert.ok(!serverPattern(r.marker).test(processTable()));
  assert.ok(!existsSync(join(r.stateRoot, "ollama-source-11434", "ollama.pid")));
  r.cleanup();
});

test("stop refuses a non-integer timeout instead of skipping the graceful wait", () => {
  const r = runScript({});
  assert.equal(r.status, 0, r.stderr);
  const stop = runStop({ OLLAMA_PORT: "11434", OLLAMA_STOP_TIMEOUT_S: "30s" }, r.stateRoot);
  assert.equal(stop.status, 2);
  assert.match(stop.stderr, /OLLAMA_STOP_TIMEOUT_S must be a positive integer/);
  // The point of refusing: the server is still there to be stopped properly, rather
  // than already SIGKILLed by a wait that never ran.
  assert.ok(serverPattern(r.marker).test(processTable()), "the server was killed anyway");
  r.cleanup();
});

test("stop escalates to SIGKILL when SIGTERM is ignored", () => {
  const r = runScript({ ignoresTerm: true });
  assert.equal(r.status, 0, r.stderr);
  const stop = runStop({ OLLAMA_PORT: "11434", OLLAMA_STOP_TIMEOUT_S: "2" }, r.stateRoot);
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stderr, /sending SIGKILL/);
  assert.ok(waitFor(() => !serverPattern(r.marker).test(processTable())));
  r.cleanup();
});
