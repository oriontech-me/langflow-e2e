// Unit tests for the echo-endpoint decision (#1128). Run with: npm run test:scripts
//
// Why these exist: the go-httpbin decoupling (#462/#639) shipped into one
// workflow and the other three silently fell back to public httpbin.org, which is
// how PR #1133 reded on a third party. Extending it means the same choice now runs
// in two job topologies, and the two ways to get it wrong — a single-label host,
// or loopback — fail as an unattributed component error rather than as a wiring
// mistake. Both are asserted here instead of being discovered by a broken lane.
//
// The IPs are the real shapes: 172.18.0.2 is what Docker assigned the go-httpbin
// container in the local topology probe, and 172.17.x/10.x are what GitHub's
// `github_network_*` bridges hand out.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isBlockedByDefaultIpv4,
  resolveEchoEndpoint,
  isPrivateIpv4,
  isLoopback,
  isIpv4,
} from "./resolve-echo-endpoint.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(HERE, "resolve-echo-endpoint.mjs");

test("host-based job: Langflow gets the container IP, the job probes the published port", () => {
  // pr-validation / nightly / manual: no `container:`, so `getent` cannot resolve
  // a service alias and the IP comes from `docker inspect`. The container IP is
  // not reliably routable from the host on every platform (measured: it is not on
  // macOS/Docker Desktop), so the job must probe loopback instead — while Langflow
  // still needs the IP, because SSRF blocks loopback.
  const r = resolveEchoEndpoint({
    getentIp: "",
    dockerIp: "172.18.0.2",
    inContainer: false,
    servicePort: 8080,
    mappedPort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, true);
  assert.equal(r.langflowUrl, "http://172.18.0.2:8080");
  assert.equal(r.probeUrl, "http://localhost:8080");
  assert.match(r.strategy, /docker inspect/);
  assert.deepEqual(r.warnings, []);
});

test("in-container job: one address serves both, which is today's daily behaviour", () => {
  // daily-stable runs inside the Playwright image, on the job network, so it both
  // resolves the alias and reaches the IP directly.
  const r = resolveEchoEndpoint({
    getentIp: "172.17.0.4",
    dockerIp: "",
    inContainer: true,
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, true);
  assert.equal(r.langflowUrl, "http://172.17.0.4:8080");
  assert.equal(r.probeUrl, "http://172.17.0.4:8080", "same network — probe the IP");
  assert.match(r.strategy, /getent/);
});

test("a published port different from the service port is honoured", () => {
  const r = resolveEchoEndpoint({
    dockerIp: "10.1.2.3",
    inContainer: false,
    servicePort: 8080,
    mappedPort: 18080,
  });

  assert.equal(r.langflowUrl, "http://10.1.2.3:8080", "Langflow talks to the container");
  assert.equal(r.probeUrl, "http://localhost:18080", "the job talks to the host");
});

test("mode=fail refuses to fall back to the public host, and says why", () => {
  // The #1128 condition. A PR is the lane a human is waiting on: a silent public
  // fallback there produced a red that read like a product failure.
  const r = resolveEchoEndpoint({ inContainer: false, mode: "fail" });

  assert.equal(r.ok, false);
  assert.equal(r.langflowUrl, null);
  assert.ok(r.error, "an unavailable service must be reported, not shrugged off");
  assert.match(r.error, /public httpbin\.org/);
  assert.match(r.error, /#1128/);
});

test("mode=warn keeps the lane alive but names the exposure", () => {
  // daily-stable's existing choice, kept: a day of coverage is worth more than
  // strictness, but the log must not read like a healthy run.
  const r = resolveEchoEndpoint({ inContainer: true, mode: "warn" });

  assert.equal(r.ok, false);
  assert.equal(r.error, null, "warn mode must not fail the lane");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /PUBLIC default/);
  assert.match(r.warnings[0], /#1128/);
});

test("a single-label host is rejected — validators.url() would reject it downstream", () => {
  // The #462 trap: `http://go-httpbin:8080` resolves fine and still cannot be
  // used, because the API Request component validates the URL before fetching.
  const r = resolveEchoEndpoint({
    getentIp: "go-httpbin",
    inContainer: true,
    mode: "fail",
  });

  assert.equal(r.ok, false);
  assert.match(r.error, /not an IPv4 address/);
  assert.match(r.error, /validators\.url\(\)/);
});

test("loopback is rejected for the Langflow address specifically", () => {
  // Langflow's SSRF layer: "Hostname localhost resolves to blocked IP address(es):
  // ::1, 127.0.0.1". Handing it loopback produces a 400 that reads like a
  // component bug, so it is caught here with the real message quoted.
  for (const ip of ["127.0.0.1", "127.1.1.1"]) {
    const r = resolveEchoEndpoint({ dockerIp: ip, inContainer: false, mode: "fail" });
    assert.equal(r.ok, false, ip);
    assert.match(r.error, /SSRF/);
  }
});

test("a public IP resolves but warns that the CIDR allowlist does not cover it", () => {
  const r = resolveEchoEndpoint({
    dockerIp: "203.0.113.7",
    inContainer: false,
    mode: "fail",
  });

  assert.equal(r.ok, true, "reachable is still usable");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /LANGFLOW_SSRF_ALLOWED_HOSTS/);
});

test("on a host-based job a stray getent result is still usable, but flagged as unexpected", () => {
  const r = resolveEchoEndpoint({
    getentIp: "10.0.0.5",
    dockerIp: "",
    inContainer: false,
    mode: "fail",
  });

  assert.equal(r.ok, true);
  assert.equal(r.langflowUrl, "http://10.0.0.5:8080");
  assert.match(r.strategy, /unexpected on a host-based job/);
});

test("isPrivateIpv4 covers the ranges the SSRF allowlist authorizes, and nothing else", () => {
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "172.18.0.2"]) {
    assert.equal(isPrivateIpv4(ip), true, ip);
  }
  for (const ip of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "192.169.0.1", "not-an-ip", ""]) {
    assert.equal(isPrivateIpv4(ip), false, ip);
  }
});

test("isIpv4 rejects out-of-range octets and hostnames", () => {
  assert.equal(isIpv4("172.18.0.2"), true);
  assert.equal(isIpv4("256.1.1.1"), false);
  assert.equal(isIpv4("go-httpbin"), false);
  assert.equal(isIpv4("httpbin.org"), false);
});

test("isLoopback covers every shape the SSRF error message named", () => {
  for (const h of ["localhost", "127.0.0.1", "127.0.0.53", "::1"]) {
    assert.equal(isLoopback(h), true, h);
  }
  assert.equal(isLoopback("172.18.0.2"), false);
});

// ── The native topology: a process on a VM, no container anywhere ────────────
//
// What these protect is the one rule that differs from the container topology, and
// it is the kind that cannot be caught by running the lane: a PUBLIC address makes
// the SSRF spec SKIP rather than fail, so the lane goes green having asserted one
// thing fewer. A host carrying a public address alongside the private one puts the
// wrong pick one interface-ordering away.

test("native: the RFC-1918 address wins over the public one the VM also carries", () => {
  // The shape that matters: a host carrying a routable public address alongside
  // the private one, with the public one listed first by `ip -4 -o addr`.
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: ["203.0.113.10", "10.0.0.5"],
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, true);
  assert.equal(r.langflowUrl, "http://10.0.0.5:8080");
  // Same address, deliberately: there is no port mapping here, and probing loopback
  // would prove the process is up without proving the specs can reach it.
  assert.equal(r.probeUrl, "http://10.0.0.5:8080");
  assert.match(r.strategy, /native/);
  assert.deepEqual(r.warnings, []);
});

test("native: a public-only host is REFUSED, and the reason is the silent skip", () => {
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: ["203.0.113.10"],
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, false);
  assert.equal(r.langflowUrl, null);
  // The message has to name the skip. "Unreachable" would send whoever reads it to
  // the firewall, and the address is perfectly reachable — that is the trap.
  assert.match(r.error, /SKIP/);
  assert.match(r.error, /privateEchoEndpoint/);
});

test("container topology still only WARNS on the same public address", () => {
  // The asymmetry is the point of the two topologies existing, so it is asserted
  // rather than left to be inferred: under a container a public IP risks a 400 that
  // names itself; natively it subtracts an assertion from a green lane.
  const r = resolveEchoEndpoint({
    getentIp: "",
    dockerIp: "203.0.113.10",
    inContainer: false,
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.match(r.warnings[0], /LANGFLOW_SSRF_ALLOWED_HOSTS/);
});

test("native: loopback is refused with the loopback cause, not the public one", () => {
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: ["127.0.0.1"],
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, false);
  assert.match(r.error, /loopback/);
  assert.match(r.error, /ignores LANGFLOW_SSRF_ALLOWED_HOSTS/);
});

test("native: a single-label host is refused for the validators.url() reason", () => {
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: ["echo-host"],
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, false);
  assert.match(r.error, /validators\.url\(\)/);
});

test("native: no address at all fails the lane, and points at the starter", () => {
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: [],
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, false);
  assert.match(r.error, /start-echo-source\.sh/);
});

test("native: mode=warn keeps the lane alive and names the public fallback", () => {
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: [],
    servicePort: 8080,
    mode: "warn",
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, null);
  assert.match(r.warnings[0], /PUBLIC/);
});

test("native mode=warn resolves the LOCAL public address rather than falling back", () => {
  // The severity belongs to the LANE, not to the topology: `warn` asked for the best
  // available. Leaving ECHO_BASE_URL unset loses the same admitted-case assertion AND
  // puts every other echo spec on public httpbin.org (#1128) — so resolving the local
  // public address is strictly better, provided the cost is named rather than implied.
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: ["203.0.113.10"],
    servicePort: 8080,
    mode: "warn",
  });

  assert.equal(r.ok, true);
  assert.equal(r.langflowUrl, "http://203.0.113.10:8080");
  assert.equal(r.error, null);
  assert.match(r.warnings[0], /SKIP/);
  assert.match(r.warnings[0], /ssrf-url-validation\.spec\.ts/);
  assert.match(r.warnings[0], /--mode fail/);
});

test("native mode=warn refuses an address Langflow blocks by DEFAULT", () => {
  // The one case where resolving is worse than not resolving: CGNAT and link-local are
  // blocked before they are reached and are not in the allow-list either, so every echo
  // spec answers 400 — a red lane, where the trade `warn` is making is ONE skip.
  for (const blocked of ["100.100.4.7", "169.254.10.1", "127.0.0.1"]) {
    const r = resolveEchoEndpoint({
      topology: "native",
      hostIps: [blocked],
      servicePort: 8080,
      mode: "warn",
    });

    assert.equal(r.ok, false, blocked);
    assert.equal(r.langflowUrl, null, blocked);
    assert.equal(r.error, null, `${blocked} must WARN under mode=warn, not error`);
    assert.match(r.warnings[0], /400/, blocked);
  }
});

test("native mode=fail is unchanged by the warn degradation", () => {
  // The tightening this file exists for: on the lane where a human is waiting, a public
  // address is still a refusal, not a resolved URL with a warning nobody reads.
  const r = resolveEchoEndpoint({
    topology: "native",
    hostIps: ["203.0.113.10"],
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(r.ok, false);
  assert.equal(r.langflowUrl, null);
  assert.match(r.error, /SKIPS/);
});

test("isBlockedByDefaultIpv4 covers every range the SSRF guard blocks without an allow-list", () => {
  // Wider than isPrivateIpv4 on purpose, and a COPY of the canonical list in
  // tests/helpers/other/private-echo-endpoint.ts — no test can hold the two side by
  // side, since a .test.ts cannot import a .mjs under this repo's ts-node config.
  for (const blocked of ["10.0.0.5", "127.0.0.1", "172.16.0.2", "192.168.1.9", "169.254.169.254", "100.64.0.1", "100.127.255.254"]) {
    assert.equal(isBlockedByDefaultIpv4(blocked), true, blocked);
  }
  for (const reachable of ["203.0.113.10", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "echo-host"]) {
    assert.equal(isBlockedByDefaultIpv4(reachable), false, reachable);
  }
});

test("native mode=warn NEVER returns an error, whatever the addresses are", () => {
  // The property that makes this resolver's verdict caller-proof. The only shell in
  // the repo that consumes it (.github/actions/resolve-echo-endpoint) turns ANY not-ok
  // decision into `exit 0` under mode: warn without reading `error` — and the native
  // caller has to be hand-written, since a composite action only runs inside Actions
  // and the VMs have no runner, so that idiom is exactly what gets copied.
  //
  // It cannot swallow anything as long as an error implies mode=fail. A later branch
  // returning an error under warn would re-open that silently, which is why this is a
  // property over every input shape rather than a case.
  const shapes = [
    [],
    ["10.0.0.5"],
    ["203.0.113.10"],
    ["203.0.113.10", "10.0.0.5"],
    ["127.0.0.1"],
    ["::1"],
    ["echo-host"],
    ["100.100.4.7"],
    ["169.254.10.1", "echo-host"],
  ];

  for (const hostIps of shapes) {
    const r = resolveEchoEndpoint({ topology: "native", hostIps, servicePort: 8080, mode: "warn" });
    assert.equal(r.error, null, `mode=warn returned an error for ${JSON.stringify(hostIps)}`);
    // And it always says something: a decision that neither resolves nor warns is the
    // unevaluated-verdict shape (#1012), which reads as clean and is not.
    assert.ok(r.ok || r.warnings.length > 0, `silent not-ok decision for ${JSON.stringify(hostIps)}`);
  }
});

test("the CLI accepts --host-ips separated by commas OR whitespace", () => {
  // Both shapes occur for real: the starter prints one address per line, and a
  // caller capturing that with $(...) hands over a space-separated string, while a
  // human types commas. Accepting one and not the other resolves to zero candidates
  // and reads as "the echo is not running".
  const forms = ["203.0.113.10,10.0.0.5", "203.0.113.10 10.0.0.5", "203.0.113.10\n10.0.0.5"];
  for (const form of forms) {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, "--topology", "native", "--service-port", "8080", "--host-ips", form],
      { encoding: "utf8" },
    );
    assert.equal(JSON.parse(out).langflowUrl, "http://10.0.0.5:8080", form);
  }
});

test("native: the refusal separates the public case from the CGNAT one", () => {
  // Both are outside the allow-list, and they fail DIFFERENTLY: a public host is not
  // blocked by default, so privateEchoEndpoint() skips; a CGNAT/link-local one IS
  // blocked by default and is not admitted either, so Langflow answers 400. Naming
  // only the skip sent the reader looking for a green lane one test short.
  const cgnat = resolveEchoEndpoint({
    topology: "native",
    hostIps: ["100.100.4.7"],
    servicePort: 8080,
    mode: "fail",
  });

  assert.equal(cgnat.ok, false);
  assert.match(cgnat.error, /400/);
  assert.match(cgnat.error, /SKIPS/);
});

test("native: a container-only flag is REFUSED, not ignored", () => {
  // `--mapped-port` is the trap, and it is not hypothetical: the starter prints
  // `ECHO_PORT=<n>` and that flag is the one with "port" in its name, so a caller
  // wiring the two together resolved `http://10.0.0.5:8080` — the DEFAULT port —
  // with ok:true. A wrong URL that reports success is found minutes later by a probe
  // and attributed to the endpoint being down.
  const r = spawnSync(
    process.execPath,
    [SCRIPT, "--topology", "native", "--mapped-port", "8081", "--host-ips", "10.0.0.5"],
    { encoding: "utf8" },
  );

  assert.equal(r.status, 2);
  assert.match(r.stderr, /--mapped-port/);
  assert.match(r.stderr, /IGNORED under --topology native/);
  // And the flag that DOES carry the port there still works.
  const ok = execFileSync(
    process.execPath,
    [SCRIPT, "--topology", "native", "--service-port", "8081", "--host-ips", "10.0.0.5"],
    { encoding: "utf8" },
  );
  assert.equal(JSON.parse(ok).langflowUrl, "http://10.0.0.5:8081");
});

test("the CLI refuses an unknown --topology instead of defaulting to container", () => {
  // Defaulting would answer the native lane's question under the container's rules,
  // and the difference between them is exactly a warning where an error belongs.
  const r = spawnSync(process.execPath, [SCRIPT, "--topology", "vm"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--topology must be/);
});

// ── Portability guard: nothing the containerized lane runs may need `jq` ─────
//
// The 2026-07-31 daily executed ZERO tests. All four shards aborted in this very
// action, because it parsed the decision with `jq` and
// `mcr.microsoft.com/playwright:v1.58.2-noble` ships none — its Dockerfile installs
// curl/wget/gpg/ca-certificates, nodejs and git/openssh-client, nothing more.
//
// The bug survived review because `pr-validation.yml` is `runs-on: ubuntu-latest`
// with no `container:`, where `jq` is preinstalled: the PR lane CANNOT reach the
// topology it broke. `daily-stable.yml` is the only lane whose jobs are all
// containerized, and it is unattended. So the invariant has to be asserted here or
// it is only ever discovered by a lost day of @stable coverage.
//
// The convention already held everywhere else — every `jq` call site in the repo
// (pr-validation, adaptive-impacted, migration-test, guard-dedicated-issue) sits in
// a host-based job, and daily-stable's own three container jobs use `node -e`
// instead — it was simply never written down.

// Comment lines are stripped first: this file and the action both DISCUSS `jq` at
// length, and a guard that tripped on the word rather than the call would force the
// explanation out of the code that needs it.
function shellLines(yaml) {
  return yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .filter((l) => !/^\s*(#|description:)/.test(l));
}

function jqInvocations(yaml) {
  // `--jq` is `gh`'s own built-in JSON filter, not the binary — `gh` implements it
  // internally, so it stays available in a jq-less image and must not be flagged.
  return shellLines(yaml).filter((l) => /(^|[\s|(`$])jq\b/.test(l) && !/--jq\b/.test(l));
}

const CONTAINERIZED_LANE = "daily-stable.yml";

test(`${CONTAINERIZED_LANE} itself invokes no jq (all three of its jobs run in a container)`, () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", CONTAINERIZED_LANE), "utf8");
  const lines = text.split("\n");

  // Guard the premise too: if a job ever loses its `container:`, the reasoning above
  // stops applying and this test should be revisited rather than quietly relaxed.
  // Counted from the `jobs:` line down — 2-space keys also occur under `on:`
  // (`schedule:`, `workflow_dispatch:`), which are not jobs.
  const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  assert.ok(jobsAt > -1, `no top-level jobs: block found in ${CONTAINERIZED_LANE}`);
  const body = lines.slice(jobsAt + 1);
  const jobs = body.filter((l) => /^ {2}[a-z][a-z0-9-]*:\s*$/.test(l)).length;
  const containers = body.filter((l) => /^ {4}container:\s*$/.test(l)).length;

  assert.ok(jobs > 0, "no jobs parsed — the guard would pass vacuously");
  assert.equal(
    containers,
    jobs,
    `every job in ${CONTAINERIZED_LANE} must be containerized for this guard's premise to hold (${containers} container: for ${jobs} jobs)`,
  );
  assert.deepEqual(jqInvocations(text), []);
});

test(`every composite action ${CONTAINERIZED_LANE} uses invokes no jq`, () => {
  const lane = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", CONTAINERIZED_LANE), "utf8");
  const used = [...new Set([...lane.matchAll(/uses:\s*\.\/(\.github\/actions\/[a-z-]+)/g)].map((m) => m[1]))];

  // A guard that silently checks nothing is the failure mode #1035/#1037 called out.
  assert.ok(used.length > 0, `no local composite actions found in ${CONTAINERIZED_LANE} — the guard would pass vacuously`);
  assert.ok(
    used.includes(".github/actions/resolve-echo-endpoint"),
    "the action this guard exists for is no longer used by the containerized lane",
  );

  for (const action of used) {
    const text = fs.readFileSync(path.join(REPO_ROOT, action, "action.yml"), "utf8");
    assert.deepEqual(jqInvocations(text), [], `${action}/action.yml invokes jq, which the Playwright container lacks`);
  }
});

test("the guard flags a real jq call and ignores a comment or gh --jq", () => {
  // Proving the guard can fail: a guard never seen red is a guard nobody can trust.
  assert.deepEqual(jqInvocations('        OK="$(echo "$D" | jq -r .ok)"').length, 1);
  assert.deepEqual(jqInvocations("        jq -e . <<<\"$D\"").length, 1);
  assert.deepEqual(jqInvocations("        # we deliberately avoid jq here"), []);
  assert.deepEqual(jqInvocations("          gh issue view 1 --json title --jq .title"), []);
});
