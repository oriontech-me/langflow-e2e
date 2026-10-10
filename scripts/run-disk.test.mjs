// Unit tests for ops/vm/run-disk.sh, the disk routine (stage 3, task 8). Run with:
// npm run test:scripts
//
// uv, du, df, flock and systemctl are fakes answering from the options below, so every
// branch runs without a full disk or a 15 GB cache. What these pin is what a quiet day on
// the machine would not show: the clean happens only over the cap and only under the
// heavy-lane lock, a busy lock leaves the cache alone, the filling disk is an ALARM beside
// a green day and never a red, and nothing is published.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "ops", "vm", "run-disk.sh");
const q = JSON.stringify;
const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const kv = (text) =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const GB = 1024 * 1024; // in KB, du's unit

/**
 * cacheGb:   uv's cache size before any clean, in GB (after a clean it is 0.1)
 * usedPct:   df's use% before a clean; afterPct, after one (defaults to usedPct)
 * heavyBusy: the heavy-lane lock never comes
 * duAfterFails: du cannot read the cache once it has been cleaned
 * cacheMissing: `uv cache dir` names a directory that does not exist
 * slowSurvey: du on the survey's largest entry never finishes
 * lockPct:   df's use% from the moment the lock is taken (another lane wrote while it was awaited)
 * clean:     "ok" | "fail"   what `uv cache clean` does
 * uv:        false removes uv from PATH
 * env:       extra environment for the routine
 */
function disk({ cacheGb = 3, usedPct = 23, afterPct = null, lockPct = null, heavyBusy = false, slowSurvey = false, duAfterFails = false, cacheMissing = false, clean = "ok", uv = true, dfBroken = false, env = {} } = {}) {
  const dir = makeTempDir("run-disk-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "ops", "vm", "lib"), { recursive: true });
  copyFileSync(join(ROOT, "ops", "vm", "lib", "routine.sh"), join(repo, "ops", "vm", "lib", "routine.sh"));
  mkdirSync(join(repo, "scripts"));
  const reportOut = join(dir, "report.out");
  writeFileSync(join(repo, "scripts", "routine-report.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${q(reportOut)}, process.argv.slice(2).join(" "));\n`);

  const cache = join(dir, "uv-cache");
  mkdirSync(cache);
  // The marker that makes the fake du answer "big"; the fake clean removes it.
  writeFileSync(join(cache, "big"), "");
  const cacheNamed = cacheMissing ? join(dir, "elsewhere", "uv") : cache;
  const survey = join(dir, "root");
  mkdirSync(join(survey, "e2e-qa"), { recursive: true });
  mkdirSync(join(survey, "rehearsal-1931"), { recursive: true });

  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(dir, "calls.log");
  stub(bin, "systemctl", "echo inactive");
  const lockMark = join(dir, "lock-taken");
  stub(bin, "flock", `echo "flock $*" >> ${q(calls)}\ncase "$*" in *8) ${heavyBusy ? "exit 1" : `touch ${q(lockMark)}; exit 0`} ;; esac\nexit 0`);
  if (uv) {
    stub(
      bin,
      "uv",
      `echo "uv $*" >> ${q(calls)}
case "$*" in
  "cache dir") echo ${q(cacheNamed)} ;;
  "cache clean") ${clean === "ok" ? `rm -f ${q(join(cache, "big"))}; echo "Removed 4120 files"` : `echo "error: failed to remove the cache: Permission denied" >&2; exit 2`} ;;
  *) exit 64 ;;
esac`,
    );
  }
  // du: the cache's size from the marker; the survey's entries at fixed sizes.
  stub(
    bin,
    "du",
    `last="\${@: -1}"
for a in "$@"; do case "$a" in
  ${q(cache)}) if [ -e ${q(join(cache, "big"))} ]; then printf '%s\\t%s\\n' ${Math.round(cacheGb * GB)} "$a"; else ${duAfterFails ? "exit 1;" : ""} printf '%s\\t%s\\n' ${Math.round(0.1 * GB)} "$a"; fi ;;
  */e2e-qa) ${slowSurvey ? "sleep 30;" : ""} printf '%s\\t%s\\n' ${15 * GB} "$a" ;;
  */rehearsal-1931) printf '%s\\t%s\\n' ${GB} "$a" ;;
esac; done`,
  );
  const after = afterPct ?? usedPct;
  stub(
    bin,
    "df",
    dfBroken
      ? "echo 'df: cannot read' >&2; exit 1"
      : `pct=${usedPct}; ${lockPct === null ? "" : `[ -e ${q(lockMark)} ] && pct=${lockPct};`} [ -e ${q(join(cache, "big"))} ] || pct=${after}
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/mapper/root 260046848 59768832 $(( (100 - pct) * 2600468 )) \${pct}% /"`,
  );

  const state = join(dir, "state");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      // uv: false works by not stubbing it; /usr/bin and /bin carry no uv on the test hosts.
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      E2E_ROUTINE_REPO: repo,
      E2E_ROUTINE_STATE_ROOT: state,
      E2E_ROUTINE_LOG_ROOT: join(dir, "log"),
      E2E_HEAVY_LOCK: join(dir, "heavy.lock"),
      E2E_SHADOW_STATE: join(dir, "shadow"),
      E2E_ROUTINE_POLL_S: "0",
      // A Saturday noon: outside the daily's window, so only the lock decides.
      E2E_ROUTINE_NOW: "6 1200",
      E2E_ROUTINE_SECRETS: join(dir, "no-secrets"),
      E2E_ROUTINE_LANE: join(dir, "no-lane"),
      DISK_SURVEY_ROOT: survey,
      DISK_WAIT_BUDGET_S: "0",
      ...env,
    },
  });
  const lastEnv = join(state, "disk", "last.env");
  return {
    r,
    result: existsSync(lastEnv) ? kv(readFileSync(lastEnv, "utf8")) : {},
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    reported: existsSync(reportOut),
    cacheKept: existsSync(join(cache, "big")),
  };
}

test("under the cap and under the alarm: green, measured, nothing cleaned, no lock taken", () => {
  const { r, result, calls, cacheKept } = disk();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(result.STATUS, "green");
  assert.equal(result.UV_CACHE_MB, String(3 * 1024));
  assert.equal(result.UV_CLEANED, "no");
  assert.equal(result.DISK_USED_PCT, "23");
  assert.equal(result.ALARM, undefined);
  assert.ok(cacheKept);
  assert.doesNotMatch(calls, /cache clean/);
  assert.doesNotMatch(calls, /flock/, "a light day must not queue behind a heavy lane");
});

test("over the cap: the clean runs under the heavy-lane lock, and the result says what the disk got back", () => {
  const { r, result, calls, cacheKept } = disk({ cacheGb: 16, usedPct: 30, afterPct: 24 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(result.STATUS, "green");
  // du's count and df's delta, both: they differ when cache files are hard-linked into venvs.
  assert.match(result.UV_CLEANED, /^yes, 16384 MB to 102 MB, 15237 MB returned to the disk$/);
  assert.equal(result.DISK_USED_PCT, "24", "the result keeps the measure taken after the clean");
  assert.ok(!cacheKept);
  const lines = calls.split("\n");
  const lock = lines.findIndex((l) => /^flock .*8$/.test(l));
  const clean = lines.findIndex((l) => l === "uv cache clean");
  assert.ok(lock >= 0 && clean > lock, `the lock must come before the clean:\n${calls}`);
});

test("what the clean gave back is counted from the lock, not from before the wait for it", () => {
  // Another lane filled 5% of the disk while the lock was awaited: counted from the first
  // measure, the clean would be credited with 1 point instead of 6.
  const { result } = disk({ cacheGb: 16, usedPct: 30, lockPct: 35, afterPct: 29 });
  assert.equal(result.STATUS, "green");
  assert.match(result.UV_CLEANED, /, 15237 MB returned to the disk$/);
});

test("a cache du cannot read after the clean is unknown, never a measured 0", () => {
  const { result } = disk({ cacheGb: 16, usedPct: 30, afterPct: 24, duAfterFails: true });
  assert.equal(result.STATUS, "green");
  assert.match(result.UV_CLEANED, /^yes, 16384 MB to unknown MB \(du could not read it after the clean\), 15237 MB returned/);
  assert.doesNotMatch(result.UV_CLEANED, /to 0 MB/);
});

test("exactly at the cap is not over it: nothing is cleaned", () => {
  const { result, calls } = disk({ cacheGb: 15 });
  assert.equal(result.STATUS, "green");
  assert.equal(result.UV_CLEANED, "no");
  assert.doesNotMatch(calls, /cache clean/);
});

test("over the cap with the machine busy: skipped, and the cache is left alone", () => {
  const { r, result, calls, cacheKept } = disk({ cacheGb: 16, heavyBusy: true });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(result.STATUS, "skipped");
  assert.match(result.REASON, /busy/);
  assert.ok(cacheKept);
  assert.doesNotMatch(calls, /cache clean/);
});

test("a skipped or failed day still carries the disk's numbers and its ALARM to the watchdog", () => {
  const skipped = disk({ cacheGb: 16, heavyBusy: true, usedPct: 75 });
  assert.equal(skipped.result.STATUS, "skipped");
  assert.equal(skipped.result.DISK_USED_PCT, "75");
  assert.match(skipped.result.ALARM, /75% used/);
  const failed = disk({ cacheGb: 16, clean: "fail", usedPct: 75 });
  assert.equal(failed.result.STATUS, "failed");
  assert.match(failed.result.ALARM, /75% used/);
});

test("the daily has priority: inside its window the routine waits, and out of budget it is skipped untouched", () => {
  const { r, result, calls } = disk({ cacheGb: 16, env: { E2E_ROUTINE_NOW: "1 0800" } });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(result.STATUS, "skipped");
  assert.match(result.REASON, /the daily's window/);
  assert.equal(calls, "", "neither uv nor the lock may be touched while the daily has the machine");
});

test("a day the daily keeps the machine is still measured, and still carries its ALARM", () => {
  const { r, result } = disk({ usedPct: 82, env: { E2E_ROUTINE_NOW: "1 0800" } });
  assert.equal(r.status, 2, r.stderr);
  assert.equal(result.STATUS, "skipped");
  assert.equal(result.DISK_USED_PCT, "82", "df must run before the daily-priority wait, not after it");
  assert.match(result.ALARM, /82% used/);
});

test("a clean that fails is the machine's: failed, with uv's words", () => {
  const { r, result } = disk({ cacheGb: 16, clean: "fail" });
  assert.equal(r.status, 3);
  assert.equal(result.STATUS, "failed");
  assert.match(result.REASON, /uv cache clean failed .*Permission denied/);
});

test("a filling disk is an ALARM beside a green day, never a red, and names where to look", () => {
  const { r, result } = disk({ usedPct: 71 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(result.STATUS, "green");
  assert.match(result.ALARM, /71% used, at or over the 70% alarm/);
  assert.match(result.ALARM, /e2e-qa 15\.0 GB, rehearsal-1931 1\.0 GB/);
});

test("the survey in the EXIT trap is bounded: a walk that does not finish is cut and said so", () => {
  const t0 = Date.now();
  const { r, result } = disk({ usedPct: 88, slowSurvey: true, env: { DISK_SURVEY_TIMEOUT_S: "1" } });
  assert.ok(Date.now() - t0 < 15000, "the trap must not wait for du past its bound");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(result.STATUS, "green");
  assert.match(result.ALARM, /88% used/);
  assert.match(result.ALARM, /survey cut at 1s, incomplete/);
});

test("the free space keeps one decimal, so a nearly full disk never reads '0 GB free'", () => {
  // df's fake gives (100 - pct) * 2600468 KB free: 2.5 GB at 99%.
  const { result } = disk({ usedPct: 99 });
  assert.equal(result.DISK_AVAIL_GB, "2.5");
  assert.match(result.ALARM, /with 2\.5 GB free/);
});

test("exactly at the alarm sounds it; one under does not", () => {
  assert.match(disk({ usedPct: 70 }).result.ALARM, /70% used/);
  assert.equal(disk({ usedPct: 69 }).result.ALARM, undefined);
});

test("the disk is measured after the clean: a clean that brings it under the alarm stays quiet", () => {
  const { result } = disk({ cacheGb: 16, usedPct: 72, afterPct: 66 });
  assert.equal(result.DISK_USED_PCT, "66");
  assert.equal(result.ALARM, undefined);
});

test("the thresholds come from the environment, and a bad one is refused before any work", () => {
  const lower = disk({ cacheGb: 3, env: { UV_CACHE_CAP_GB: "2" } });
  assert.match(lower.result.UV_CLEANED, /^yes/);
  for (const env of [{ UV_CACHE_CAP_GB: "0" }, { UV_CACHE_CAP_GB: "15GB" }, { DISK_ALARM_PCT: "101" }, { DISK_ALARM_PCT: "seventy" }]) {
    const { result, calls } = disk({ env });
    assert.equal(result.STATUS, "failed", JSON.stringify(env));
    assert.equal(calls, "", `nothing may run on a bad threshold: ${JSON.stringify(env)}`);
  }
});

test("a threshold with a leading zero is read in base 10, never as octal", () => {
  // 015 as octal is 13 GB, and a 14 GB cache would be cleaned under it.
  const octal = disk({ cacheGb: 14, env: { UV_CACHE_CAP_GB: "015" } });
  assert.equal(octal.result.STATUS, "green");
  assert.equal(octal.result.UV_CLEANED, "no");
  assert.equal(octal.result.UV_CACHE_CAP_GB, "15");
  // 08 is no octal number at all: it aborted the shell before a verdict.
  const eight = disk({ env: { UV_CACHE_CAP_GB: "08", DISK_ALARM_PCT: "070" } });
  assert.equal(eight.result.STATUS, "green", eight.result.REASON);
  assert.equal(eight.result.DISK_ALARM_PCT, "70");
});

test("a cache directory that does not exist is a wrong place, failed, never a green 0", () => {
  const { r, result, calls } = disk({ cacheMissing: true });
  assert.equal(r.status, 3);
  assert.equal(result.STATUS, "failed");
  assert.match(result.REASON, /no such directory/);
  assert.doesNotMatch(calls, /cache clean/);
});

test("no uv on the machine, or no df answer, is failed", () => {
  assert.match(disk({ uv: false }).result.REASON, /uv is not on PATH/);
  assert.match(disk({ dfBroken: true }).result.REASON, /could not read the disk usage/);
});

test("it publishes nothing: no issue, no Slack, REPORT=none even on an alarm", () => {
  const { result, reported } = disk({ usedPct: 90 });
  assert.equal(result.REPORT, "none");
  assert.ok(!reported, "routine-report.mjs must not be called");
});
