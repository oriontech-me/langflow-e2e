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
import {
  resolveEchoEndpoint,
  isPrivateIpv4,
  isLoopback,
  isIpv4,
} from "./resolve-echo-endpoint.mjs";

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
