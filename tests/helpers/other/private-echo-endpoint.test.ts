// Unit tests for the private-echo-endpoint guard.
// Run with: npm run test:units
//
// The guard decides whether an SSRF spec's ADMITTED case can prove anything. Its
// two failure modes are opposite and both silent: an unset variable makes the
// test unrunnable, and a variable pointing at a PUBLIC host makes it green while
// proving nothing about the allow-list — reaching a public address says nothing
// about `LANGFLOW_SSRF_ALLOWED_HOSTS`. So both answers are asserted, and the
// skipReason text is asserted to name which one it is.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlockedRangeIpv4, privateEchoUrl } from "./private-echo-endpoint";

test("the ranges Langflow blocks by default are recognised", () => {
  for (const host of [
    "10.0.0.5", // 10.0.0.0/8
    "127.0.0.1", // loopback
    "172.17.0.5", // 172.16.0.0/12 — the docker bridge, where the echo container lands
    "172.31.255.254", // upper edge of the same /12
    "192.168.1.10", // 192.168.0.0/16
    "169.254.169.254", // link-local / cloud metadata
    "100.64.0.1", // CGNAT
  ]) {
    assert.equal(isBlockedRangeIpv4(host), true, `${host} should be blocked by default`);
  }
});

test("public addresses and non-addresses are not blocked ranges", () => {
  for (const host of [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1", // just below the /12
    "172.32.0.1", // just above the /12
    "192.169.0.1", // just outside the /16
    "api.openai.com", // a NAME, not an address: the guard cannot know what it resolves to
    "",
    "999.1.1.1", // syntactically an address, numerically not
  ]) {
    assert.equal(isBlockedRangeIpv4(host), false, `${host} should not count as a blocked range`);
  }
});

test("an unset variable yields a skip reason naming the variable", () => {
  const r = privateEchoUrl({});
  assert.ok("skipReason" in r);
  assert.match(r.skipReason, /ECHO_BASE_URL/);
});

test("either variable name is accepted, ECHO_BASE_URL first", () => {
  const both = privateEchoUrl({
    ECHO_BASE_URL: "http://10.0.0.5:8080",
    HTTPBIN_BASE_URL: "http://192.168.1.1:8080",
  });
  assert.ok("url" in both);
  assert.match(both.url, /10\.0\.0\.5/);

  const fallback = privateEchoUrl({ HTTPBIN_BASE_URL: "http://192.168.1.1:8080" });
  assert.ok("url" in fallback);
  assert.match(fallback.url, /192\.168\.1\.1/);
});

test("a PUBLIC echo host is skipped rather than accepted", () => {
  // The load-bearing case. Reaching a public address proves nothing about the
  // allow-list, so admitting it here would turn the admitted test into a green
  // assertion about nothing.
  const r = privateEchoUrl({ ECHO_BASE_URL: "https://httpbin.org" });
  assert.ok("skipReason" in r);
  assert.match(r.skipReason, /not an address Langflow blocks/);
});

test("a hostname rather than an address is skipped, even a private-sounding one", () => {
  // Langflow's `validators.url()` rejects a single-label host anyway, and the
  // guard cannot know what a name resolves to — so it must not guess.
  const r = privateEchoUrl({ ECHO_BASE_URL: "http://go-httpbin:8080" });
  assert.ok("skipReason" in r);
});

test("an unparseable value is skipped, naming the value", () => {
  const r = privateEchoUrl({ ECHO_BASE_URL: "not a url at all" });
  assert.ok("skipReason" in r);
  assert.match(r.skipReason, /not a url at all/);
});

test("a trailing slash is normalised away so callers can append a path", () => {
  const r = privateEchoUrl({ ECHO_BASE_URL: "http://10.0.0.5:8080/" });
  assert.ok("url" in r);
  assert.equal(r.url, "http://10.0.0.5:8080");
});

test("the verdict never throws, for any value", () => {
  for (const v of ["", "http://", "://x", "10.0.0.5", "http://[::1]:8080", "file:///etc/passwd"]) {
    assert.doesNotThrow(() => privateEchoUrl({ ECHO_BASE_URL: v }), `threw on ${v}`);
  }
});
