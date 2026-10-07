// Unit tests for ops/vm/lib/routine.sh, the common shape of a VM-lane routine.
// Run with: npm run test:scripts
//
// A routine is a script that sources the library; each test writes one, with a HOME whose
// ~/.local/bin shadows systemctl and flock, and a fake clone whose
// scripts/routine-report.mjs records what it was given. What these pin is what the machine
// would not report: a routine that ran beside the daily, two heavy lanes at once, a run
// with no result, a status the exit code lies about, and a publishing token that reached
// the routine's own work.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "ops", "vm", "lib", "routine.sh");
const q = JSON.stringify;
const stub = (dir, name, body) => writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const kv = (text) =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
// A Wednesday afternoon: outside the daily's window.
const OPEN = "3 1500";

/**
 * Run a routine whose body is `body` (bash, after routine_start), on a fake machine.
 *   states    { unit: ActiveState } for systemctl show
 *   busyFor   systemctl answers `active` for e2e-daily this many times, then inactive
 *   heavyBusy flock on fd 8 fails
 *   reportExit the fake routine-report.mjs's exit status
 */
function routine(body, { now = OPEN, states = {}, busyFor = 0, heavyBusy = false, noFlock = false, reportExit = 0, env: extra = {}, shadowToday = false } = {}) {
  const dir = makeTempDir("routine-lib-");
  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(dir, "systemctl.calls");
  const counter = join(dir, "busy.count");
  writeFileSync(counter, "0");
  const cases = Object.entries(states).map(([u, s]) => `  *${u}*) echo ${q(s)}; exit 0 ;;`).join("\n");
  stub(bin, "systemctl", `echo "$*" >> ${q(calls)}
case "$*" in
${cases}
  *e2e-daily*)
    n=$(cat ${q(counter)}); echo $((n + 1)) > ${q(counter)}
    if [ "$n" -lt ${busyFor} ]; then echo active; else echo inactive; fi; exit 0 ;;
esac
echo inactive`);
  // node itself opens descriptors, so whether the report inherited fd 8 is asked by the
  // shell that starts it, before node runs.
  const fd8 = join(dir, "report.fd8");
  stub(bin, "node", `echo "$( { : >&8; } 2>/dev/null && echo open || echo closed)" > ${q(fd8)}\nexec ${q(process.execPath)} "$@"`);
  if (!noFlock) stub(bin, "flock", `case "$*" in *8) exit ${heavyBusy ? 1 : 0} ;; esac\nexit 0`);

  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  const reportOut = join(dir, "report.out");
  // The report stub: what it was asked, and the environment it saw.
  writeFileSync(
    join(repo, "scripts", "routine-report.mjs"),
    `import { writeFileSync, readFileSync } from "node:fs";
writeFileSync(${q(reportOut)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, result: readFileSync(process.argv[3], "utf8") }));
process.exit(${reportExit});
`,
  );
  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, "export GITHUB_TOKEN=secret-token\nexport SLACK_WEBHOOK_URL=https://hooks.slack.com/triggers/x\nexport OPENAI_API_KEY=provider-key\n");
  const lane = join(dir, "lane.env");
  writeFileSync(lane, 'ISSUE_HOST=issues.example.invalid\nISSUE_REPO=owner/name\nISSUE_CC="@someone"\n');
  const shadow = join(dir, "shadow");
  mkdirSync(shadow);
  if (shadowToday) writeFileSync(join(shadow, "request.env"), `SHADOW_DATE=${new Date().toISOString().slice(0, 10)}\n`);

  const bodyOut = join(dir, "body.env");
  const script = join(dir, "routine.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -uo pipefail
. ${q(LIB)}
routine_start demo
env | sort > ${q(bodyOut)}
${body}
`,
    { mode: 0o755 },
  );
  const state = join(dir, "state");
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    E2E_ROUTINE_REPO: repo,
    E2E_ROUTINE_STATE_ROOT: state,
    E2E_ROUTINE_LOG_ROOT: join(dir, "log"),
    E2E_HEAVY_LOCK: join(dir, "lock", "heavy.lock"),
    E2E_SHADOW_STATE: shadow,
    E2E_ROUTINE_SECRETS: secrets,
    E2E_ROUTINE_LANE: lane,
    E2E_ROUTINE_NOW: now,
    E2E_ROUTINE_POLL_S: "0",
    ...extra,
  };
  if (noFlock) {
    // Every tool of the system's PATH but flock: on Linux it sits in /usr/bin, beside
    // the tools the library needs, so dropping a directory would not hide it.
    const sys = join(dir, "sys-bin");
    mkdirSync(sys);
    for (const d of (process.env.PATH ?? "").split(":").filter(Boolean)) {
      let names = [];
      try { names = readdirSync(d); } catch { continue; }
      for (const n of names) {
        if (n === "flock" || existsSync(join(sys, n))) continue;
        try { symlinkSync(join(d, n), join(sys, n)); } catch { /* a race or a name twice */ }
      }
    }
    env.PATH = sys;
  }
  const r = spawnSync("bash", [script], { encoding: "utf8", env });
  const readIf = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const last = readIf(join(state, "demo", "last.env"));
  return {
    status: r.status,
    last: last ? kv(last) : null,
    results: existsSync(join(state, "demo", "results")) ? readdirSync(join(state, "demo", "results")).filter((f) => f.endsWith(".env")) : [],
    log: readIf(join(dir, "log", "e2e-demo", "latest.log")) ?? `${r.stdout}${r.stderr}`,
    body: readIf(bodyOut),
    report: readIf(reportOut) ? { ...JSON.parse(readIf(reportOut)), fd8: readIf(fd8)?.trim() } : null,
    holder: readIf(join(dir, "lock", "heavy.lock.holder")),
    systemctl: readIf(calls) ?? "",
    dir,
  };
}

// ---------------------------------------------------------------------------
// The result and the exit status
// ---------------------------------------------------------------------------

test("each status exits with its own code, and the result says the same", () => {
  for (const [status, code] of [["green", 0], ["red", 1], ["skipped", 2], ["failed", 3], ["blocked", 4]]) {
    const r = routine(`routine_end ${status} "because ${status}"`);
    assert.equal(r.status, code, `${status}: ${r.log}`);
    assert.equal(r.last.STATUS, status);
    assert.equal(r.last.EXIT, String(code));
    assert.equal(r.last.REASON, `because ${status}`);
    assert.equal(r.results.length, 1, "the dated result is missing");
  }
});

test("a status the library does not know is failed, never passed through", () => {
  const r = routine('routine_end greenish "typo"');
  assert.equal(r.status, 3);
  assert.equal(r.last.STATUS, "failed");
  assert.match(r.last.REASON, /unknown status 'greenish'/);
});

test("an exit that never went through routine_end is failed, with why", () => {
  const plain = routine("exit 7");
  assert.equal(plain.status, 3);
  assert.equal(plain.last.STATUS, "failed");
  assert.match(plain.last.REASON, /ended with status 7 before a verdict/);

  // The daily's `systemctl stop`.
  const term = routine("kill -TERM $$; sleep 5");
  assert.equal(term.status, 3, term.log);
  assert.match(term.last.REASON, /stopped by SIGTERM/);
});

test("extra fields land in the result, one line each, with no newline inside a value", () => {
  const r = routine('routine_set TARGET 1.13.0.dev33; routine_set CELLS "a\nb"; routine_set bad-key x; routine_end green ok');
  assert.equal(r.last.TARGET, "1.13.0.dev33");
  assert.equal(r.last.CELLS, "a b");
  assert.equal(r.last["bad-key"], undefined);
  assert.match(r.log, /routine_set ignored bad key/);
});

test("the routine's cleanup hook runs on every exit, and its failure does not lose the result", () => {
  const r = routine(`routine_cleanup() { echo CLEANED; return 9; }\nexit 1`);
  assert.match(r.log, /CLEANED/);
  assert.match(r.log, /routine_cleanup ended with status 9/);
  assert.equal(r.last.STATUS, "failed");
});

// ---------------------------------------------------------------------------
// The daily's priority
// ---------------------------------------------------------------------------

test("in the daily's window a routine waits, and out of budget it is skipped, not run", () => {
  for (const [now, inWindow] of [["1 0730", true], ["5 0839", true], ["3 0729", false], ["3 0840", false], ["6 0800", false]]) {
    const r = routine("routine_wait_turn 0; routine_end green ran", { now });
    if (inWindow) {
      assert.equal(r.status, 2, `${now}: ${r.log}`);
      assert.equal(r.last.STATUS, "skipped");
      assert.match(r.last.REASON, /the daily's window/);
    } else {
      assert.equal(r.status, 0, `${now}: ${r.log}`);
    }
  }
});

test("beside the daily or the shadow, in any state systemd names a running oneshot, it is skipped", () => {
  for (const unit of ["e2e-daily.service", "e2e-shadow.service"]) {
    for (const st of ["activating", "active", "reloading", "deactivating"]) {
      const r = routine("routine_wait_turn 0; routine_end green ran", { states: { [unit]: st } });
      assert.equal(r.status, 2, `${unit} ${st}: ${r.log}`);
      assert.match(r.last.REASON, new RegExp(`${unit.replace(".", "\\.")} is ${st}`));
    }
  }
});

test("today's shadow request, not yet started, holds the routine back too", () => {
  const r = routine("routine_wait_turn 0; routine_end green ran", { shadowToday: true });
  assert.equal(r.status, 2);
  assert.match(r.last.REASON, /shadow request is waiting/);
});

test("a routine waits for the daily to end and then runs, within its budget", () => {
  const r = routine("routine_wait_turn 60; routine_end green ran", { busyFor: 3 });
  assert.equal(r.status, 0, r.log);
  assert.equal((r.log.match(/waiting: e2e-daily\.service is active/g) ?? []).length, 3);
});

test("a light routine waits for the daily lane alone: no lock taken, a busy one ignored", () => {
  const waited = routine("routine_wait_daily 60; routine_end green ran", { busyFor: 2, heavyBusy: true });
  assert.equal(waited.status, 0, waited.log);
  assert.equal((waited.log.match(/waiting: e2e-daily\.service is active/g) ?? []).length, 2);
  assert.equal(waited.holder, null, "a light routine named itself holder of the heavy-lane lock");
  // The daily's priority is the same as a heavy routine's.
  const windowed = routine("routine_wait_daily 0; routine_end green ran", { now: "2 0800" });
  assert.equal(windowed.status, 2, windowed.log);
  assert.match(windowed.last.REASON, /^its turn never came within 0s: the daily's window/);
});

// ---------------------------------------------------------------------------
// One heavy lane at a time
// ---------------------------------------------------------------------------

test("a busy heavy-lane lock skips the routine, names the holder, and leaves the holder's line", () => {
  const dir = makeTempDir("routine-holder-");
  mkdirSync(join(dir, "lock"));
  const lock = join(dir, "lock", "heavy.lock");
  writeFileSync(`${lock}.holder`, "on-demand req-9 (pid 77) since 20261006T090000Z\n");
  const r = routine("routine_wait_turn 0; routine_end green ran", { heavyBusy: true, env: { E2E_HEAVY_LOCK: lock } });
  assert.equal(r.status, 2, r.log);
  assert.match(r.last.REASON, /the machine was busy for 0s: on-demand req-9 \(pid 77\)/);
  assert.equal(readFileSync(`${lock}.holder`, "utf8"), "on-demand req-9 (pid 77) since 20261006T090000Z\n");
});

test("a routine with the lock names itself as holder while it runs, and clears it after", () => {
  const r = routine('routine_wait_turn 0; cat "$RT_HEAVY_LOCK.holder"; routine_end green ran', { env: { ROUTINE_ISSUE: "1" } });
  assert.equal(r.status, 0, r.log);
  assert.match(r.log, /^demo \(pid \d+\) since \d{8}T\d{6}Z$/m);
  assert.equal(r.holder, null, "the holder line outlived the routine");
  // Released before the report, which talks to the network and must hold nothing.
  assert.equal(r.report.fd8, "closed", "the report ran holding the heavy-lane lock");
});

test("without flock the routine refuses to run rather than share the machine", () => {
  const r = routine("routine_wait_turn 0; routine_end green ran", { noFlock: true });
  assert.equal(r.status, 3, r.log);
  assert.match(r.last.REASON, /flock is not on this machine/);
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

test("with no visibility declared nothing is reported, and REPORT says none", () => {
  const r = routine("routine_end red broken");
  assert.equal(r.report, null);
  assert.equal(r.last.REPORT, "none");
});

test("green and red are reported; skipped, failed and blocked are left to the watchdog", () => {
  for (const [status, reported] of [["green", true], ["red", true], ["skipped", false], ["failed", false], ["blocked", false]]) {
    const r = routine(`routine_end ${status} why`, { env: { ROUTINE_ISSUE: "1", ROUTINE_SLACK: "red" } });
    assert.equal(r.report !== null, reported, status);
    assert.equal(r.last.REPORT, reported ? "ok" : "none", status);
  }
});

test("the report reads the final result, with the lane's destination and the publishing credentials", () => {
  const r = routine("routine_set TARGET 1.13.0.dev33; routine_end red broken", { env: { ROUTINE_ISSUE: "1" } });
  assert.deepEqual(r.report.argv.slice(0, 1), ["verdict"]);
  assert.match(r.report.result, /^STATUS=red$/m);
  assert.match(r.report.result, /^TARGET=1\.13\.0\.dev33$/m);
  assert.equal(r.report.env.ISSUE_HOST, "issues.example.invalid");
  assert.equal(r.report.env.ISSUE_REPO, "owner/name");
  assert.equal(r.report.env.GITHUB_TOKEN, "secret-token");
  assert.equal(r.report.env.SLACK_WEBHOOK_URL, "https://hooks.slack.com/triggers/x");
});

test("visibility set by plain assignment inside the routine still reaches the report", () => {
  // A routine writes ROUTINE_ISSUE=1 as a shell variable, unexported. The first version
  // passed only the credentials to node, so a red day was reported nowhere and said ok.
  const r = routine("ROUTINE_ISSUE=1; ROUTINE_SLACK=red; routine_end red broken");
  assert.ok(r.report, "the report was not run");
  assert.equal(r.report.env.ROUTINE_ISSUE, "1");
  assert.equal(r.report.env.ROUTINE_SLACK, "red");
});

test("the result carries the start as epoch seconds, matching its stamp", () => {
  const r = routine("routine_end green ok");
  const epoch = Number(r.last.STARTED_EPOCH);
  assert.ok(epoch > 1_700_000_000, r.last.STARTED_EPOCH);
  assert.equal(new Date(epoch * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"), r.last.STARTED);
});

test("the publishing credentials never reach the routine's own work", () => {
  const r = routine("routine_end green ok", { env: { ROUTINE_ISSUE: "1" } });
  const body = kv(r.body);
  for (const name of ["GITHUB_TOKEN", "SLACK_WEBHOOK_URL", "ISSUE_HOST"]) assert.equal(body[name], undefined, `${name} reached the routine`);
});

test("a report that could not be delivered is recorded for the watchdog, and the status stands", () => {
  const r = routine("routine_end red broken", { env: { ROUTINE_ISSUE: "1" }, reportExit: 1 });
  assert.equal(r.status, 1);
  assert.equal(r.last.STATUS, "red");
  assert.equal(r.last.REPORT, "failed");
});

test("an extra named like a field of the result is refused: it would replace the verdict", () => {
  const r = routine("routine_set STATUS green; routine_set REASON fine; routine_set STARTED_EPOCH 0; routine_end red broken");
  assert.equal(r.status, 1, r.log);
  assert.equal(r.last.STATUS, "red");
  assert.equal(r.last.REASON, "broken");
  assert.notEqual(r.last.STARTED_EPOCH, "0");
  assert.match(r.log, /routine_set ignored 'STATUS': the result sets it itself/);
});

test("an unset name inside the secrets file does not abort the report of a routine under set -u", () => {
  const d = makeTempDir("routine-lib-secrets-");
  const secrets = join(d, "secrets.env");
  writeFileSync(secrets, "export GITHUB_TOKEN=secret-token\nexport EXTRA=${NOT_SET_ANYWHERE}/x\n");
  const r = routine("routine_end red broken", { env: { ROUTINE_ISSUE: "1", E2E_ROUTINE_SECRETS: secrets } });
  assert.ok(r.report, `the report never ran: ${r.log}`);
  assert.equal(r.report.env.GITHUB_TOKEN, "secret-token");
  assert.equal(r.last.REPORT, "ok");
});
