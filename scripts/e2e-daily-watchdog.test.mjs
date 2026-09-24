// Guards over ops/vm/e2e-daily-watchdog.sh, the alarm for a VM daily that did not speak.
//
// The script asks systemd and posts with curl, so both are replaced by stubs on PATH:
// `systemctl` answers nothing, which is the "unit is missing" branch -- a real alarm
// path that needs no GNU `date` -- and `curl` records that it was called instead of
// reaching a webhook. Whether curl was called is the whole question for DRY_RUN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "ops", "vm", "e2e-daily-watchdog.sh");
const BASH = execFileSync("/usr/bin/env", ["bash", "-c", "command -v bash"], { encoding: "utf8" }).trim();

function runWatchdog(env) {
  const dir = makeTempDir("watchdog-test-");
  const bin = join(dir, "bin");
  const posted = join(dir, "curl-was-called");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(bin, "curl"), `#!/bin/sh\ntouch ${JSON.stringify(posted)}\nprintf 200\n`);
  chmodSync(join(bin, "systemctl"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
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
  return { ...r, posted: existsSync(posted) };
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
