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
  // 60 min since the start, 50 of them waiting for names: 10 min of running.
  const waited = runWatchdog({ DRY_RUN: "1" }, { systemctl: runningFor(60) },
    "=== daily start\ndns-wait: cannot resolve: github.com -- waiting up to 3600s\ndns-wait: waited 3000s -- names resolve again\nsuite at: abc\n");
  assert.equal(waited.status, 0, waited.stderr);
  assert.doesNotMatch(waited.stdout, /would post/, "a run on time was reported as stuck");
  assert.match(waited.watchdogLog, /waited 3000s for DNS; counting 10 min of it as running/);
  // Still waiting when the check runs: the progress line is the wait so far.
  const waiting = runWatchdog({ DRY_RUN: "1" }, { systemctl: runningFor(60) },
    "=== daily start\ndns-wait: still failing after 3540s: github.com\n");
  assert.doesNotMatch(waiting.stdout, /would post/);
  // The control: the same run with no wait in its log is past the alarm point.
  const stuck = runWatchdog({ DRY_RUN: "1" }, { systemctl: runningFor(60) }, "=== daily start\nsuite at: abc\n");
  assert.match(stuck.stdout, /still running after 60 min/);
});

test("the alarm waits for the webhook's host to resolve, then posts", () => {
  // Fails the first lookup, answers the second.
  const getent = `#!/bin/sh\nf=$(dirname "$0")/../getent-calls\nn=$(cat "$f" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$f"\n[ $n -le 1 ] && exit 2\necho 192.0.2.1 $2\n`;
  const r = runWatchdog({ DNS_WAIT_STEP_S: "0", DNS_WAIT_RESOLV_CONF: "/nonexistent" }, { getent });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.posted, true);
  assert.match(r.watchdogLog, /dns-wait: cannot resolve: hooks\.slack\.com/);
  assert.match(r.watchdogLog, /dns-wait: waited \d+s -- names resolve again/);
});

test("a host that never resolves still lets the post be tried, and says it gave up", () => {
  const r = runWatchdog({ DNS_WAIT_STEP_S: "0", DNS_WAIT_ATTEMPTS: "2", DNS_WAIT_RESOLV_CONF: "/nonexistent" }, { getent: "#!/bin/sh\nexit 2\n" });
  assert.equal(r.posted, true, "giving up on DNS must not skip the attempt");
  assert.match(r.watchdogLog, /giving up/);
});
