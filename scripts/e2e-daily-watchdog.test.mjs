// Guards over ops/vm/e2e-daily-watchdog.sh, the alarm for a VM daily that did not speak.
//
// The script asks systemd and posts with curl, so both are replaced by stubs on PATH:
// `systemctl` answers nothing, which is the "unit is missing" branch -- a real alarm
// path that needs no GNU `date` -- and `curl` records that it was called instead of
// reaching a webhook. Whether curl was called is the whole question for DRY_RUN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, existsSync, chmodSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "ops", "vm", "e2e-daily-watchdog.sh");
const BASH = execFileSync("/usr/bin/env", ["bash", "-c", "command -v bash"], { encoding: "utf8" }).trim();

function runWatchdog(env, stubs = {}, latestLog = null) {
  const dir = makeTempDir("watchdog-test-");
  const bin = join(dir, "bin");
  const posted = join(dir, "curl-was-called");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\ntouch ${JSON.stringify(posted)}\nprintf 200\n`);
  // The webhook host resolves, unless a test says otherwise: the delivery waits for DNS.
  writeFileSync(join(bin, "getent"), "#!/bin/sh\necho 192.0.2.1 $2\n");
  for (const [name, body] of Object.entries(stubs)) writeFileSync(join(bin, name), body);
  for (const name of ["systemctl", "curl", "getent", ...Object.keys(stubs)]) chmodSync(join(bin, name), 0o755);
  if (latestLog !== null) {
    execFileSync("mkdir", ["-p", join(dir, "log")]);
    writeFileSync(join(dir, "log", "latest.log"), latestLog);
  }
  const r = spawnSync(BASH, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      WATCHDOG_LOG_DIR: join(dir, "log"),
      WATCHDOG_REPO: join(dir, "repo"),
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/triggers/T0/1/stub",
      DRY_RUN: "",
      ...env,
    },
  });
  const logFile = join(dir, "log", "watchdog.log");
  return { ...r, posted: existsSync(posted), watchdogLog: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" };
}

test("a DRY_RUN that is neither 0 nor 1 stops before anything is posted (#2056)", () => {
  // It was read as `= "1"`, so a typo'd `yes` meant NOT a dry run: the one invocation
  // whose purpose is to post nothing sent a fake incident to the channel.
  for (const value of ["yes", "true", "1 "]) {
    const r = runWatchdog({ DRY_RUN: value });
    assert.equal(r.status, 1, `DRY_RUN=${JSON.stringify(value)} was accepted`);
    assert.match(r.stderr, /DRY_RUN must be exactly '0' or '1'/);
    assert.equal(r.posted, false, `DRY_RUN=${JSON.stringify(value)} posted to Slack`);
  }
});

test("a non-numeric alarm point stops the check instead of silencing it", () => {
  // `[ "$elapsed_min" -ge abc ]` errors, the error reads as false, and a run stuck for an
  // hour was logged as "under the abc min alarm point": quiet on the case it covers.
  for (const value of ["abc", "4 5", "45m", "-1"]) {
    const r = runWatchdog({ STILL_RUNNING_ALARM_AFTER_MIN: value });
    assert.equal(r.status, 1, `STILL_RUNNING_ALARM_AFTER_MIN=${JSON.stringify(value)} was accepted`);
    assert.match(r.stderr, /STILL_RUNNING_ALARM_AFTER_MIN must be a whole number of minutes/);
    assert.equal(r.posted, false);
  }
  // Empty is the default here too, and a number is a number.
  for (const value of ["", "45", "0"]) {
    assert.equal(runWatchdog({ STILL_RUNNING_ALARM_AFTER_MIN: value }).status, 0, `${JSON.stringify(value)} was refused`);
  }
});

test("DRY_RUN=1 prints the alarm and posts nothing", () => {
  const r = runWatchdog({ DRY_RUN: "1" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DRY_RUN — would post/);
  assert.match(r.stdout, /the unit is missing/);
  assert.equal(r.posted, false);
});

test("an empty or 0 DRY_RUN still posts, which is what the timer relies on", () => {
  for (const value of ["", "0"]) {
    const r = runWatchdog({ DRY_RUN: value });
    assert.equal(r.status, 0, `DRY_RUN=${JSON.stringify(value)}: ${r.stderr}`);
    assert.equal(r.posted, true, `DRY_RUN=${JSON.stringify(value)} did not post`);
  }
});

// A unit that started `minutesAgo` and has not exited: the "still running" branch.
function runningFor(minutesAgo) {
  const start = Math.floor(Date.now() / 1000) - minutesAgo * 60;
  return `#!/bin/sh
case "$*" in
  *LoadState*) echo loaded ;;
  *ActiveState*) echo activating ;;
  *ExecMainStartTimestamp*) echo "@${start}" ;;
  *ExecMainExitTimestamp*) echo "" ;;
  *Result*) echo success ;;
esac
exit 0
`;
}

test("a run past the alarm point only because it waited for DNS is not reported as stuck", () => {
  // 60 min since the start, 50 of them waiting for names: 10 min of running. Following
  // is off here (WATCHDOG_FOLLOW_MAX_MIN=0): this is only the arithmetic.
  const waited = runWatchdog({ DRY_RUN: "1", WATCHDOG_FOLLOW_MAX_MIN: "0" }, { systemctl: runningFor(60) },
    "=== daily start\ndns-wait: cannot resolve: github.com -- waiting up to 3540s\ndns-wait: waited 3000s -- names resolve again\nsuite at: abc\n");
  assert.equal(waited.status, 0, waited.stderr);
  assert.doesNotMatch(waited.stdout, /would post/, "a run on time was reported as stuck");
  assert.match(waited.watchdogLog, /waited 3000s for DNS; counting 10 min of it as running/);
  assert.match(waited.watchdogLog, /quiet: still running, 10 min in/);
  // The control: the same run with no wait in its log is past the alarm point.
  const stuck = runWatchdog({ DRY_RUN: "1" }, { systemctl: runningFor(60) }, "=== daily start\nsuite at: abc\n");
  assert.match(stuck.stdout, /still running after 60 min/);
});

// Running for `minutesAgo`, until the ExecMainExitTimestamp has been read `runningReads`
// times; then it has exited, now. A run that ends after the 09:00 check.
function endsAfter(minutesAgo, runningReads) {
  const start = Math.floor(Date.now() / 1000) - minutesAgo * 60;
  return `#!/bin/sh
f="$(dirname "$0")/exit-reads"
case "$*" in
  *LoadState*) echo loaded ;;
  *ActiveState*) echo activating ;;
  *ExecMainStartTimestamp*) echo "@${start}" ;;
  *ExecMainExitTimestamp*)
    n=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"
    if [ $n -le ${runningReads} ]; then echo ""; else echo "@$(date +%s)"; fi ;;
  *Result*) echo exit-code ;;
esac
exit 0
`;
}

test("a run still waiting for DNS at the check is followed until it ends, and then judged (no silence)", () => {
  // 2026-11-16 shape: at 09:00 the wrapper is still waiting; it gives up at 09:01 and
  // aborts with no report. The check must not go quiet at 09:00 and miss that.
  const r = runWatchdog({ DRY_RUN: "1", WATCHDOG_FOLLOW_STEP_S: "0" }, { systemctl: endsAfter(60, 2) },
    "=== daily start\ndns-wait: still failing after 3540s: github.com\n");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.watchdogLog, /following: still running/);
  assert.match(r.stdout, /would post/, "the run ended after the check and nobody said so");
  assert.equal((r.watchdogLog.match(/--- check start/g) || []).length, 1, "a follow-up look is not a new check");
});

test("a run on time with no DNS wait is not followed: the check ends quiet, as before", () => {
  const r = runWatchdog({ DRY_RUN: "1", WATCHDOG_FOLLOW_STEP_S: "0" }, { systemctl: endsAfter(10, 2) }, "=== daily start\nsuite at: abc\n");
  assert.doesNotMatch(r.watchdogLog, /following/);
  assert.match(r.watchdogLog, /quiet: still running, 10 min in/);
  assert.doesNotMatch(r.stdout, /would post/);
});

test("following stops at its bound", () => {
  // Never exits; the bound has already passed.
  const r = runWatchdog({ DRY_RUN: "1", WATCHDOG_FOLLOW_STEP_S: "0", WATCHDOG_FOLLOW_UNTIL: "1" }, { systemctl: runningFor(60) },
    "=== daily start\ndns-wait: waited 3000s -- names resolve again\n");
  assert.doesNotMatch(r.watchdogLog, /following/);
  assert.match(r.watchdogLog, /quiet: still running/);
});

test("a malformed follow knob stops the check instead of looping or going quiet", () => {
  for (const [key, value] of [["WATCHDOG_FOLLOW_STEP_S", "5m"], ["WATCHDOG_FOLLOW_MAX_MIN", "abc"], ["WATCHDOG_FOLLOW_UNTIL", "x"]]) {
    const r = runWatchdog({ [key]: value });
    assert.equal(r.status, 1, `${key}=${value} was accepted`);
    assert.equal(r.posted, false);
  }
});

test("the alarm waits for the webhook's host to resolve, then posts", () => {
  // Fails the first lookup, answers the second.
  const getent = `#!/bin/sh\nf=$(dirname "$0")/../getent-calls\nn=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"\n[ $n -le 1 ] && exit 2\necho 192.0.2.1 $2\n`;
  const r = runWatchdog({ DNS_WAIT_STEP_S: "0", DNS_WAIT_RESOLV_CONF: "/nonexistent" }, { getent });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posted, true);
  assert.match(r.watchdogLog, /^\S+Z dns-wait: cannot resolve: hooks\.slack\.com/m, "the wait's lines carry the log's timestamp");
  assert.match(r.watchdogLog, /dns-wait: waited \d+s -- names resolve again/);
});

test("a host that never resolves still lets the post be tried, and says it gave up", () => {
  const r = runWatchdog({ DNS_WAIT_STEP_S: "0", DNS_WAIT_ATTEMPTS: "2", DNS_WAIT_RESOLV_CONF: "/nonexistent" }, { getent: "#!/bin/sh\nexit 2\n" });
  assert.equal(r.posted, true, "giving up on DNS must not skip the attempt");
  assert.match(r.watchdogLog, /giving up/);
});

test("the unit's timeout covers following the run and the delivery's own DNS wait", () => {
  // A kill in the middle of either loses the one alarm the wait exists to deliver
  // (#2473 review: the unit had TimeoutStartSec=5min under a wait of about an hour).
  const unit = readFileSync(join(HERE, "..", "ops", "systemd", "e2e-daily-watchdog.service"), "utf8");
  const m = unit.match(/^TimeoutStartSec=(\d+)(h|min)$/m);
  assert.ok(m, "no TimeoutStartSec in hours or minutes");
  const minutes = Number(m[1]) * (m[2] === "h" ? 60 : 1);
  const script = readFileSync(SCRIPT, "utf8");
  // The follow can overrun its bound by one step, the wait by a step plus its lookups,
  // and the post is capped by curl's --max-time.
  const follow = Number(script.match(/WATCHDOG_FOLLOW_MAX_MIN:-(\d+)/)[1]) + Math.ceil(Number(script.match(/WATCHDOG_FOLLOW_STEP_S:-(\d+)/)[1]) / 60);
  const curlMin = Math.ceil(Number(script.match(/curl -sS --max-time (\d+)/)[1]) / 60);
  const lib = readFileSync(join(HERE, "..", "ops", "vm", "lib", "wait-for-dns.sh"), "utf8");
  const attempts = Number(lib.match(/DNS_WAIT_ATTEMPTS:-(\d+)/)[1]);
  const step = Number(lib.match(/DNS_WAIT_STEP_S:-(\d+)/)[1]);
  const dnsWaitMin = Math.ceil(((attempts - 1) * step) / 60) + 2;
  assert.ok(minutes > follow + dnsWaitMin + curlMin + 10, `TimeoutStartSec=${minutes}min does not cover ${follow} + ${dnsWaitMin} min`);
});

test("a wait that has only begun at the check is followed too", () => {
  // A daily started by hand minutes before the check: only the first wait line exists.
  const r = runWatchdog({ DRY_RUN: "1", WATCHDOG_FOLLOW_STEP_S: "0" }, { systemctl: endsAfter(3, 2) },
    "=== daily start\ndns-wait: cannot resolve: github.com -- waiting up to 3540s\n");
  assert.match(r.watchdogLog, /following: still running/);
  assert.match(r.stdout, /^following: the daily waited for DNS/m, "a DRY_RUN by hand says why it waits");
  assert.match(r.stdout, /would post/);
});
