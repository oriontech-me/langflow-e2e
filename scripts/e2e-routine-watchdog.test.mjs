// Unit tests for ops/vm/e2e-routine-watchdog.sh, the absence alarm of the VM lane's
// routines. Run with: npm run test:scripts
//
// systemctl is a stub that answers each property from the test, and the alarm goes to a
// fake scripts/routine-report.mjs that records what it would post. Days are real: the
// stub's timestamps are computed from now, which is how the script itself reads them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "ops", "vm", "e2e-routine-watchdog.sh");
const q = JSON.stringify;

const now = () => Math.floor(Date.now() / 1000);
const stampOf = (epoch) => new Date(epoch * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
// Late enough in the UTC day that "a minute ago" is still today. At 00:00-00:02 UTC the
// tests would straddle midnight; they say so instead of failing.
const SAFE = now() % 86400 > 180;

/**
 * props: systemctl properties of e2e-routine-demo.service
 * last:  the routine's last.env, or null
 */
function watchdog({ props = {}, last = null, env = {}, reportExit = 0 } = {}) {
  const dir = makeTempDir("routine-watchdog-");
  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const cases = Object.entries(props).map(([p, v]) => `  *"-p ${p} "*) echo ${q(v)}; exit 0 ;;`).join("\n");
  writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash\nargs="$* "\ncase "$args" in\n${cases}\nesac\nexit 0\n`, { mode: 0o755 });
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const posted = join(dir, "posted.json");
  writeFileSync(
    join(repo, "scripts", "routine-report.mjs"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${q(posted)}, JSON.stringify({ argv: process.argv.slice(2), slack: process.env.SLACK_WEBHOOK_URL }));\nprocess.exit(${reportExit});\n`,
  );
  const state = join(dir, "state");
  mkdirSync(join(state, "demo"), { recursive: true });
  if (last) writeFileSync(join(state, "demo", "last.env"), Object.entries(last).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, "export SLACK_WEBHOOK_URL=https://hooks.slack.com/triggers/x\n");
  const r = spawnSync("bash", [SCRIPT, "demo"], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      WATCHDOG_REPO: repo,
      E2E_ROUTINE_STATE_ROOT: state,
      E2E_ROUTINE_LOG_ROOT: join(dir, "log"),
      E2E_ROUTINE_SECRETS: secrets,
      DRY_RUN: "0",
      ...env,
    },
  });
  const p = existsSync(posted) ? JSON.parse(readFileSync(posted, "utf8")) : null;
  const wlog = join(dir, "log", "e2e-demo", "watchdog.log");
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, posted: p, headline: p?.argv[1] ?? "", body: p?.argv[2] ?? "", log: existsSync(wlog) ? readFileSync(wlog, "utf8") : "" };
}

const ranToday = (extra = {}) => ({ LoadState: "loaded", ExecMainStartTimestamp: `@${now() - 60}`, ExecMainExitTimestamp: `@${now() - 30}`, Result: "success", ...extra });
const resultToday = (fields) => ({ ROUTINE: "demo", STARTED: stampOf(now() - 60), ...fields });

test("a bad routine name or DRY_RUN stops the check before anything", () => {
  const r = spawnSync("bash", [SCRIPT, "../x"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  const d = watchdog({ env: { DRY_RUN: "yes" } });
  assert.equal(d.status, 1);
  assert.equal(d.posted, null);
});

test("a missing unit is said as missing, with the routine's unit names", () => {
  const r = watchdog({ props: { LoadState: "not-found" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.posted.argv.slice(0, 2), ["alarm", "Routine demo: the unit is missing"]);
  assert.match(r.body, /e2e-routine-demo\.service and e2e-routine-demo\.timer/);
  assert.equal(r.posted.slack, "https://hooks.slack.com/triggers/x");
});

test("no recorded start is said with the two facts that tell a reboot from a dead schedule", () => {
  const r = watchdog({ props: { LoadState: "loaded", UserspaceTimestamp: "Tue 2026-10-06 01:00:00 EDT" } });
  assert.equal(r.headline, "Routine demo: systemd has no record of it running");
  assert.match(r.body, /This machine booted: Tue 2026-10-06/);
});

test("a last start before today's UTC midnight is no run today", () => {
  const r = watchdog({ props: ranToday({ ExecMainStartTimestamp: `@${now() - 86400 * 2}`, ExecMainExitTimestamp: `@${now() - 86400 * 2 + 60}` }) });
  assert.equal(r.headline, "Routine demo: no run today");
});

test("started today and not exited is still running, whatever ActiveState says", { skip: !SAFE && "too close to UTC midnight" }, () => {
  for (const exit of ["", `@${now() - 86400 * 3}`]) {
    const r = watchdog({ props: ranToday({ ExecMainExitTimestamp: exit }) });
    assert.equal(r.headline, "Routine demo: still running", `exit=${exit}`);
  }
});

test("ran today and ended with no result for today: the run died before its trap", { skip: !SAFE && "too close to UTC midnight" }, () => {
  for (const last of [null, resultToday({ STATUS: "green", STARTED: "20200101T000000Z" })]) {
    const r = watchdog({ props: ranToday({ Result: "signal" }), last });
    assert.equal(r.headline, "Routine demo: ran today and left no result");
    assert.match(r.body, /ended \(signal\)/);
  }
});

test("skipped, failed and blocked are each said, with the routine's own reason", { skip: !SAFE && "too close to UTC midnight" }, () => {
  for (const status of ["skipped", "failed", "blocked"]) {
    const r = watchdog({ props: ranToday(), last: resultToday({ STATUS: status, REASON: `why ${status}` }) });
    assert.equal(r.headline, `Routine demo: ${status} today`);
    assert.match(r.body, new RegExp(`^why ${status}$`, "m"));
  }
});

test("green and red that were delivered are quiet, and the quiet is logged", { skip: !SAFE && "too close to UTC midnight" }, () => {
  for (const status of ["green", "red"]) {
    for (const report of ["ok", "none"]) {
      const r = watchdog({ props: ranToday(), last: resultToday({ STATUS: status, REPORT: report }) });
      assert.equal(r.posted, null, `${status}/${report} posted`);
      assert.match(r.log, new RegExp(`quiet: ${status} today, report=${report}`));
    }
  }
});

test("a red nobody heard is said", { skip: !SAFE && "too close to UTC midnight" }, () => {
  const r = watchdog({ props: ranToday(), last: resultToday({ STATUS: "red", REASON: "2 of 12", REPORT: "failed" }) });
  assert.equal(r.headline, "Routine demo: red, and the report could not be delivered");
});

test("an unknown status is said, not taken for quiet", { skip: !SAFE && "too close to UTC midnight" }, () => {
  const r = watchdog({ props: ranToday(), last: resultToday({ STATUS: "greenish" }) });
  assert.equal(r.headline, "Routine demo: a result this check does not know");
});

test("DRY_RUN prints the alarm and posts nothing; a delivery that fails exits 1", () => {
  const dry = watchdog({ props: { LoadState: "not-found" }, env: { DRY_RUN: "1" } });
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /DRY_RUN — would post/);
  assert.equal(dry.posted, null);
  const failed = watchdog({ props: { LoadState: "not-found" }, reportExit: 1 });
  assert.equal(failed.status, 1);
  assert.match(failed.log, /the alarm itself could not be delivered/);
});

test("a delivery test is marked as one in the channel", () => {
  const r = watchdog({ props: { LoadState: "not-found" }, env: { WATCHDOG_TEST_NOTE: "rebuilding the qa" } });
  assert.match(r.headline, /^\[delivery test\] /);
  assert.match(r.body, /DELIVERY TEST of the routine alarm, not a real incident\. rebuilding the qa/);
});
