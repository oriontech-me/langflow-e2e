// Unit tests for ops/vm/lib/wait-for-dns.sh, the bounded wait for public names that the
// daily wrapper and its watchdog run before they touch the network.
// Run with: npm run test:scripts
//
// `getent` is a stub on PATH that fails a set number of times and then answers, so each
// test drives the real loop through one shape of outage. `dig` is a stub too: the
// per-nameserver lines are the evidence for a ticket, and they must name each server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "vm", "lib", "wait-for-dns.sh");
const HAS_TIMEOUT = spawnSync("/bin/sh", ["-c", "command -v timeout"]).status === 0;
const BASH = execFileSync("/usr/bin/env", ["bash", "-c", "command -v bash"], { encoding: "utf8" }).trim();

/**
 * Runs `wait_for_dns <hosts>` with getent failing its first `failFor` calls per run
 * (counted across hosts) and answering after. `failFor: Infinity` never answers.
 */
function waitFor(hosts, { failFor = 0, env = {}, dig = true, getentDelayS = 0, resolvConf = "nameserver 10.0.0.1\nnameserver 10.0.0.2\nnameserver 10.0.0.3\n" } = {}) {
  const dir = makeTempDir("dns-wait-test-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  // PATH is this directory alone: the stubs, plus links to the few real tools the library
  // uses. A real dig elsewhere on the developer's PATH must not answer for the stub.
  for (const tool of ["awk", "head", "grep", "cat", "sleep", "sh", "sed", ...(HAS_TIMEOUT ? ["timeout"] : [])]) {
    const real = execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(bin, tool));
  }
  const count = join(dir, "getent-calls");
  const limit = failFor === Infinity ? 1e9 : failFor;
  writeFileSync(
    join(bin, "getent"),
    `#!/bin/sh\n${getentDelayS ? `sleep ${getentDelayS}\n` : ""}n=$(cat ${JSON.stringify(count)} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${JSON.stringify(count)}\n[ $n -le ${limit} ] && exit 2\necho "192.0.2.1 $2"\n`,
    { mode: 0o755 },
  );
  if (dig) writeFileSync(join(bin, "dig"), `#!/bin/sh\ncase "$*" in\n  *@10.0.0.1*) printf ';; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1\\n;; ANSWER SECTION:\\nhost. 60 IN CNAME edge.example.\\nedge.example. 60 IN A 192.0.2.1\\n' ;;\n  *@10.0.0.3*) printf ';; ->>HEADER<<- opcode: QUERY, status: NXDOMAIN, id: 1\\n' ;;\n  *) echo ";; connection timed out; no servers could be reached" ;;\nesac\nexit 0\n`, { mode: 0o755 });
  const conf = join(dir, "resolv.conf");
  writeFileSync(conf, resolvConf);
  const r = spawnSync(BASH, ["-c", `. ${JSON.stringify(LIB)}; wait_for_dns "$@"`, "x", ...hosts], {
    encoding: "utf8",
    env: { PATH: bin, DNS_WAIT_STEP_S: "0", DNS_WAIT_RESOLV_CONF: conf, ...env },
  });
  const calls = existsSync(count) ? Number(readFileSync(count, "utf8")) : 0;
  rmSync(dir, { recursive: true, force: true });
  return { ...r, calls };
}

test("names that resolve on the first try: no wait, and nothing printed", () => {
  const r = waitFor(["github.com", "pypi.org"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "", "a normal day must read the same as before");
  assert.equal(r.calls, 2, "one lookup per host");
});

test("an outage that ends: it waits, says how long, and names each nameserver once", () => {
  // 2 hosts x 3 failed rounds = 6 failing lookups; the 4th round answers.
  const r = waitFor(["github.com", "pypi.org"], { failFor: 6 });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^dns-wait: cannot resolve: github\.com pypi\.org -- waiting up to \d+s$/m);
  assert.match(r.stdout, /^dns-wait: nameserver 10\.0\.0\.1: NOERROR 192\.0\.2\.1 \(github\.com\)$/m);
  assert.match(r.stdout, /^dns-wait: nameserver 10\.0\.0\.2: timed out \(github\.com\)$/m);
  assert.match(r.stdout, /^dns-wait: nameserver 10\.0\.0\.3: NXDOMAIN \(github\.com\)$/m);
  assert.match(r.stdout, /^dns-wait: waited \d+s -- names resolve again$/m);
  assert.equal((r.stdout.match(/nameserver 10\.0\.0\.1/g) || []).length, 1, "the diagnosis repeats on every attempt");
  assert.equal(r.calls, 8);
});

test("an outage longer than the bound: it gives up, returns 1, and diagnoses again", () => {
  const r = waitFor(["github.com"], { failFor: Infinity, env: { DNS_WAIT_ATTEMPTS: "3" } });
  assert.equal(r.status, 1);
  assert.equal(r.calls, 3, "the bound is the number of lookups");
  assert.match(r.stdout, /^dns-wait: still failing after \d+s: github\.com -- giving up$/m);
  assert.equal((r.stdout.match(/nameserver 10\.0\.0\.1/g) || []).length, 2, "the state at the end is evidence too");
});

test("a long wait reports progress every 5 attempts, in the shape the watchdog reads", () => {
  const r = waitFor(["github.com"], { failFor: 11, env: { DNS_WAIT_ATTEMPTS: "20" } });
  assert.equal(r.status, 0);
  assert.equal((r.stdout.match(/^dns-wait: still failing after \d+s: github\.com$/gm) || []).length, 2);
});

test("only the hosts that fail are named", () => {
  // getent's counter is shared, so fail exactly the first lookup: github.com.
  const r = waitFor(["github.com", "pypi.org"], { failFor: 1 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /cannot resolve: github\.com -- /);
  assert.doesNotMatch(r.stdout, /cannot resolve:.*pypi\.org/);
});

test("no dig, or no resolv.conf, is said and does not stop the wait", () => {
  const noDig = waitFor(["github.com"], { failFor: 1, dig: false });
  assert.equal(noDig.status, 0);
  assert.match(noDig.stdout, /dig is not installed/);
  const noConf = waitFor(["github.com"], { failFor: 1, env: { DNS_WAIT_RESOLV_CONF: "/nonexistent/resolv.conf" } });
  assert.equal(noConf.status, 0);
  assert.match(noConf.stdout, /is unreadable/);
});

test("a malformed bound refuses to wait instead of waiting forever or not at all", () => {
  for (const [key, value] of [["DNS_WAIT_ATTEMPTS", "0"], ["DNS_WAIT_ATTEMPTS", "abc"], ["DNS_WAIT_STEP_S", "1m"], ["DNS_WAIT_LOOKUP_S", "0"]]) {
    const r = waitFor(["github.com"], { failFor: Infinity, env: { [key]: value } });
    assert.equal(r.status, 2, `${key}=${value} was accepted`);
    assert.equal(r.calls, 0, `${key}=${value} looked something up`);
  }
});

test("the bound is the clock, not only the count: slow lookups end the wait on time", () => {
  // Each lookup takes 2s and fails; 3 attempts 1s apart is a 2s bound. Counting attempts
  // alone would run all 3 (about 8s); the clock ends it after the first.
  const r = waitFor(["github.com"], { failFor: Infinity, getentDelayS: 2, env: { DNS_WAIT_ATTEMPTS: "3", DNS_WAIT_STEP_S: "1" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /giving up/);
  assert.ok(r.calls < 3, `the wait ran ${r.calls} attempts past its 2s bound`);
});

test("a lookup that hangs is cut at DNS_WAIT_LOOKUP_S", { skip: !HAS_TIMEOUT && "no timeout(1) here; the VM has it" }, () => {
  const started = Date.now();
  const r = waitFor(["github.com"], { failFor: Infinity, getentDelayS: 30, env: { DNS_WAIT_ATTEMPTS: "1", DNS_WAIT_LOOKUP_S: "1" } });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - started < 15000, "the hanging lookup was not cut");
});

test("with a single attempt the state is diagnosed once, not twice in a row", () => {
  const r = waitFor(["github.com"], { failFor: Infinity, env: { DNS_WAIT_ATTEMPTS: "1" } });
  assert.equal((r.stdout.match(/nameserver 10\.0\.0\.1/g) || []).length, 1);
});

test("without getent it does not wait at all", () => {
  const dir = makeTempDir("dns-wait-nogetent-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["sh", "sleep"]) symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), join(bin, tool));
  const r = spawnSync(BASH, ["-c", `. ${JSON.stringify(LIB)}; wait_for_dns github.com`], { encoding: "utf8", env: { PATH: bin } });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /getent is not installed -- not waiting/);
});
