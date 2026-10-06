// Unit tests for ops/vm/run-daily.sh, the VM lane's daily wrapper.
// Run with: npm run test:scripts
//
// The wrapper's happy path needs the machine -- a published image, a venv, four
// backends -- and is exercised there. What these cover is what can go wrong without
// anyone noticing on the machine: the refusals that keep a run from reporting to the
// wrong host or the wrong people, and the re-exec that makes the wrapper which runs be
// the one main holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = join(ROOT, "ops", "vm", "run-daily.sh");
const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const COMPLETE_LANE = [
  "ISSUE_HOST=issues.example.invalid",
  "ISSUE_REPO=owner/name",
  'ISSUE_CC="@someone"',
  "BACKUP_DEST=backup-host:/tmp/ledger",
];

/**
 * A clone that holds the wrapper, and a HOME whose ~/.local/bin shadows the two network
 * calls. The wrapper prepends that directory to PATH itself, which is why the stubs go
 * there and not on the PATH given to spawn. With no resolver in the fake clone, a run
 * that gets past every refusal stops at "could not resolve the version" -- which is the
 * observable proof that it got past them, without touching a network or a venv.
 */
function makeLane(dir, laneLines, files = {}, binStubs = {}) {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "ops", "vm"), { recursive: true });
  copyFileSync(WRAPPER, join(repo, "ops", "vm", "run-daily.sh"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body, { mode: 0o755 });
  }
  const git = (...args) => execFileSync(REAL_GIT, args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "wrapper");

  const home = join(dir, "home");
  const bin = join(home, ".local", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 22\n", { mode: 0o755 });
  for (const [name, body] of Object.entries(binStubs)) writeFileSync(join(bin, name), body, { mode: 0o755 });
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\n[ "$1" = ls-remote ] && exit 2\nexec ${JSON.stringify(REAL_GIT)} "$@"\n`,
    { mode: 0o755 },
  );

  const secrets = join(dir, "secrets.env");
  writeFileSync(secrets, "\n");
  const lane = join(dir, "lane.env");
  if (laneLines !== null) writeFileSync(lane, laneLines.join("\n") + "\n");
  return { repo, home, secrets, lane, logs: join(dir, "logs") };
}

function runWrapper(dir, laneLines, script = WRAPPER, files = {}, binStubs = {}) {
  const l = makeLane(dir, laneLines, files, binStubs);
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmp,
      HOME: l.home,
      E2E_DAILY_REPO: l.repo,
      E2E_DAILY_LOG_DIR: l.logs,
      E2E_DAILY_SECRETS: l.secrets,
      E2E_DAILY_LANE: l.lane,
      E2E_DAILY_VENV: join(dir, "venv"),
      E2E_SHADOW_STATE: join(dir, "shadow-state"),
      // Never the machine's /run/lock: whether a routine holds its turn is the test's.
      E2E_HEAVY_LOCK: join(dir, "heavy.lock"),
    },
  });
  return { ...r, log: readFileSync(join(l.logs, "latest.log"), "utf8"), leftInTmp: readdirSync(tmp) };
}

/**
 * Stubs for everything after the lane check, so a run goes the whole way through. The
 * resolver is the real one's output shape: one `::warning::` line on stderr, the JSON
 * on stdout -- which is what every fallback path of the real one prints.
 */
function fullRun({ runExit = 0, warn = true } = {}) {
  return {
    "scripts/resolve-target-version.mjs": [
      warn ? 'process.stderr.write("::warning::resolve-target-version: no v1.2.3 tag in the refs\\n");' : "",
      'process.stdout.write(JSON.stringify({ ok: true, version: "1.2.3", warnings: ["no v1.2.3 tag"] }) + "\\n");',
    ].join("\n"),
    "scripts/prepare-target-dist.sh": "#!/bin/sh\necho frontend_dir=/nowhere/frontend\n",
    "scripts/run-e2e.sh": `#!/bin/sh\necho run-e2e ran\necho "run-e2e got AUTO_REMOVE=[$AUTO_REMOVE] CREATE_ISSUE=[$CREATE_ISSUE]"\necho "run-e2e got USE_LEDGER_DURATIONS=[$USE_LEDGER_DURATIONS]"\necho "run-e2e got HISTORY_TO_SOURCE=[$HISTORY_TO_SOURCE]"\nexit ${runExit}\n`,
    "scripts/backup-ledger.sh": "#!/bin/sh\necho backup ran\n",
  };
}

test("with no lane file, it refuses before resolving or installing anything", () => {
  const dir = makeTempDir("wrapper-no-lane");
  const r = runWrapper(dir, null);
  assert.equal(r.status, 1);
  assert.match(r.log, /lane\.env is missing or unreadable/);
  assert.doesNotMatch(r.log, /target should be|could not resolve/);
  rmSync(dir, { recursive: true, force: true });
});

for (const key of ["ISSUE_HOST", "ISSUE_REPO", "ISSUE_CC", "BACKUP_DEST"]) {
  test(`a lane file without ${key} is refused, and the refusal names it`, () => {
    // Every one of these has a default somewhere downstream, and every default is wrong
    // for this lane: the origin's issue host, the github.com /cc handles, no backup.
    const dir = makeTempDir(`wrapper-no-${key}`);
    const r = runWrapper(dir, COMPLETE_LANE.filter((l) => !l.startsWith(`${key}=`)));
    assert.equal(r.status, 1);
    assert.match(r.log, new RegExp(`does not set: ${key}\\b`));
    assert.doesNotMatch(r.log, /could not resolve/);
    rmSync(dir, { recursive: true, force: true });
  });
}

test("an EMPTY ISSUE_CC is a choice, not a missing key", () => {
  // create-failure-issue.mjs tests ISSUE_CC for undefined: "" opens an issue with no
  // /cc line. Refusing it would take that choice away; treating an ABSENT key the same
  // way would bring back CC_DEFAULT, which is the defect the key exists to prevent.
  const dir = makeTempDir("wrapper-empty-cc");
  const lane = COMPLETE_LANE.map((l) => (l.startsWith("ISSUE_CC=") ? 'ISSUE_CC=""' : l));
  const r = runWrapper(dir, lane);
  assert.doesNotMatch(r.log, /does not set/);
  assert.match(r.log, /could not resolve the version/, "it did not get past the lane check");
  rmSync(dir, { recursive: true, force: true });
});

test("the pass that pulls hands over to the wrapper main holds, once", () => {
  // Invoked from a copy OUTSIDE the clone, the way yesterday's file is outside today's
  // main. The second pass is the clone's copy: it is the one that prints "wrapper at:",
  // and the start banner is printed once, because the second pass inherits the log.
  const dir = makeTempDir("wrapper-reexec");
  // Yesterday's copy differs from the clone's in the line only the second pass prints,
  // so the log says which file ran it. Without the difference the test passes with the
  // exec deleted: the first pass would fall through and print the same line itself.
  const outside = join(dir, "yesterday.sh");
  writeFileSync(outside, readFileSync(WRAPPER, "utf8").replace('echo "wrapper at:', 'echo "YESTERDAY at:'));
  const r = runWrapper(dir, COMPLETE_LANE, outside);
  assert.equal((r.log.match(/=== daily start/g) || []).length, 1);
  assert.match(r.log, /wrapper at: [0-9a-f]+ wrapper/);
  assert.doesNotMatch(r.log, /YESTERDAY at:/, "the second pass ran from the pre-pull copy");
  rmSync(dir, { recursive: true, force: true });
});

test("topology is read from the lane file, never assigned in the wrapper", () => {
  // The origin is public and mirrors to the destination. ops-units.test.mjs refuses
  // internal host names in ops/; this pins the other half -- the handles and the
  // destinations -- by structure, since a handle is not a host and no digest list can
  // anticipate the next person on the roster.
  const text = readFileSync(WRAPPER, "utf8");
  const code = text
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  for (const key of ["ISSUE_HOST", "ISSUE_REPO", "ISSUE_CC", "BACKUP_DEST"]) {
    assert.doesNotMatch(code, new RegExp(`(^|[\\s;])(export\\s+)?${key}=["']?[^"'$\\s]`, "m"), `${key} is assigned a literal`);
  }
  assert.doesNotMatch(code, /@[A-Za-z][\w-]*-[\w-]+/, "a handle-shaped literal is in the wrapper");
});

test("it installs the target with the repository's installer, not a machine copy", () => {
  // The /root installer checked only the eight-file `langflow` meta-package and built
  // the frontend path from a hardcoded interpreter; scripts/prepare-target-dist.sh
  // verifies langflow-base as well and reports the path it found.
  const code = readFileSync(WRAPPER, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.match(code, /\.\/scripts\/prepare-target-dist\.sh/);
  assert.doesNotMatch(code, /install-target-dist/);
  assert.doesNotMatch(code, /python3\.\d+\/site-packages/, "the frontend path is guessed again");
});

test("a resolver warning does not stop the run: stderr is kept out of the JSON", () => {
  // Every fallback path of the resolver warns on stderr. Mixed into the captured JSON,
  // the warning made the parse fail and the day the fallback exists for refused to run.
  const dir = makeTempDir("wrapper-resolver-warns");
  const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, fullRun());
  assert.doesNotMatch(r.log, /could not resolve/);
  assert.match(r.log, /target should be: 1\.2\.3/);
  assert.match(r.log, /::warning::resolve-target-version: no v1\.2\.3 tag/, "the warning left the log");
  assert.match(r.log, /run-e2e ran/);
  rmSync(dir, { recursive: true, force: true });
});

for (const runExit of [0, 1, 3]) {
  test(`the wrapper exits with the run's status (${runExit}), not the log pruning's`, () => {
    // It ends by pruning logs and copying the ledger, both of which succeed on a red
    // day; a bare `exit` after them made every red day Result=success in systemd.
    const dir = makeTempDir(`wrapper-exit-${runExit}`);
    const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, fullRun({ runExit, warn: false }));
    assert.match(r.log, new RegExp(`=== daily end, exit=${runExit} ===`));
    assert.match(r.log, /backup ran/, "the ledger is copied on a red day too");
    assert.equal(r.status, runExit);
    rmSync(dir, { recursive: true, force: true });
  });
}

test("the scratch directory is removed on exit, and the cleanup does not error", () => {
  // The EXIT trap fires after main returns. With TMP a local of main, `set -u` made the
  // trap fail on an unbound variable and the directory stayed behind every day.
  const dir = makeTempDir("wrapper-tmp-cleanup");
  const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, fullRun({ warn: false }));
  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr + r.log, /unbound variable/);
  assert.deepEqual(r.leftInTmp, []);
  rmSync(dir, { recursive: true, force: true });
});

test("the lane turns the @stable removal on, and run-e2e.sh receives it (#1945)", () => {
  // run-e2e.sh compares AUTO_REMOVE strictly against "1" and defaults it to 0, so the
  // switch only exists if it crosses the exec into the orchestrator. Read from what the
  // orchestrator saw, not from the wrapper's text: an unexported assignment reads right
  // and does nothing.
  const dir = makeTempDir("wrapper-auto-remove");
  const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, fullRun({ warn: false }));
  assert.match(r.log, /run-e2e got AUTO_REMOVE=\[1\] CREATE_ISSUE=\[1\]/);
  rmSync(dir, { recursive: true, force: true });
});

test("the lane balances on its own ledger timings, and run-e2e.sh receives the switch (#2159)", () => {
  // The Actions daily, the only writer of reports/spec-durations.json, is off since
  // 2026-10-02. Read from what the orchestrator saw: run-e2e.sh compares the switch
  // strictly against "1", and an unexported assignment would leave it at 0.
  const dir = makeTempDir("wrapper-ledger-durations");
  const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, fullRun({ warn: false }));
  assert.match(r.log, /run-e2e got USE_LEDGER_DURATIONS=\[1\]/);
  rmSync(dir, { recursive: true, force: true });
});

test("the lane writes its history rows to the source, and run-e2e.sh receives the switch (#2164)", () => {
  // Read from what the orchestrator saw: an unexported assignment would leave it at 0.
  const dir = makeTempDir("wrapper-history-to-source");
  const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, fullRun({ warn: false }));
  assert.match(r.log, /run-e2e got HISTORY_TO_SOURCE=\[1\]/);
  rmSync(dir, { recursive: true, force: true });
});

test("a running shadow is stopped before the official run, whatever state systemd names it by (#2094)", () => {
  // Type=oneshot: while run-shadow.sh runs, systemd reports the unit `activating`, which
  // `systemctl is-active` does not count. The first version of this guard asked
  // is-active, so it could never fire; this runs the wrapper against each state.
  for (const [state, stops] of [["activating", true], ["active", true], ["deactivating", true], ["reloading", true], ["inactive", false], ["failed", false], ["", false]]) {
    const dir = makeTempDir("run-daily-shadow-");
    try {
      const calls = join(dir, "systemctl.calls");
      const systemctl = `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\n[ "$1" = show ] && echo ${JSON.stringify(state)}\nexit 0\n`;
      // The week the shadow was asked for: a stopped shadow did not answer it.
      mkdirSync(join(dir, "shadow-state"), { recursive: true });
      writeFileSync(join(dir, "shadow-state", "requested-week"), "2026-W42\n");
      const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl });
      assert.equal(existsSync(join(dir, "shadow-state", "requested-week")), !stops, `${state || "(none)"}: the week's record after the guard`);
      const log = readFileSync(calls, "utf8");
      assert.match(log, /show -p ActiveState --value e2e-shadow\.service/, `${state}: the state was not asked`);
      if (stops) {
        assert.match(log, /^stop e2e-shadow\.service$/m, `${state || "(none)"}: a running shadow was not stopped`);
        assert.match(r.log, new RegExp(`stopping the image shadow \\(${state}\\) before this run`));
      } else {
        assert.doesNotMatch(log, /^stop /m, `${state || "(none)"}: a shadow that is not running was stopped`);
      }
      // Past the guard either way: it never ends the daily.
      assert.match(r.log, /could not resolve the version/, `${state}: the daily did not continue past the guard`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a running on-demand run is stopped before the official run, and only a running one", () => {
  // It refuses to START in the daily's window, but one started just before, or a slow
  // build, can still be going at 08:00; the daily's priority is the same as over the
  // shadow, and so is the check, state by state.
  for (const [state, stops] of [["activating", true], ["active", true], ["deactivating", true], ["reloading", true], ["inactive", false], ["failed", false], ["", false]]) {
    const dir = makeTempDir("run-daily-ondemand-");
    try {
      const calls = join(dir, "systemctl.calls");
      const systemctl = `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\ncase "$*" in *e2e-on-demand*) [ "$1" = show ] && echo ${JSON.stringify(state)} ;; *) [ "$1" = show ] && echo inactive ;; esac\nexit 0\n`;
      const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl });
      const log = readFileSync(calls, "utf8");
      assert.match(log, /show -p ActiveState --value e2e-on-demand\.service/, `${state}: the state was not asked`);
      if (stops) {
        assert.match(log, /^stop e2e-on-demand\.service$/m, `${state}: a running on-demand run was not stopped`);
        assert.match(r.log, new RegExp(`stopping the on-demand run \\(${state}\\) before this run`));
      } else {
        assert.doesNotMatch(log, /^stop /m, `${state || "(none)"}: an on-demand run that is not running was stopped`);
      }
      assert.match(r.log, /could not resolve the version/, `${state}: the daily did not continue past the guard`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("with the heavy lock held by an unknown holder, every running routine is stopped, found by name, and the watchdog template is not", () => {
  // ops/vm/lib/routine.sh: routines wait out the daily's window, but one started late or
  // held by a slow turn can still be going at 08:00. Found by the e2e-routine-* pattern
  // so a new routine needs no line in the wrapper; a templated unit is never a routine.
  const dir = makeTempDir("run-daily-routines-");
  try {
    const calls = join(dir, "systemctl.calls");
    const listing = [
      "e2e-routine-migration.service loaded activating start Migration",
      "e2e-routine-validation.service loaded active running Validation",
      "e2e-routine-watchdog@migration.service loaded activating start Alarm",
    ].join("\\n");
    const systemctl = `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\ncase "$1" in list-units) printf '${listing}\\n' ;; show) echo inactive ;; stop) [ "$2" = e2e-routine-validation.service ] && exit 1 ;; esac\nexit 0\n`;
    // Held, and no holder line to say by whom: stopping them all is the safe side.
    const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl, flock: "#!/bin/sh\nexit 1\n" });
    const log = readFileSync(calls, "utf8");
    assert.match(log, /^list-units --plain --no-legend --state=activating,active,reloading,deactivating e2e-routine-\*\.service$/m);
    assert.match(log, /^stop e2e-routine-migration\.service$/m);
    assert.match(log, /^stop e2e-routine-validation\.service$/m);
    assert.doesNotMatch(log, /^stop e2e-routine-watchdog@/m, "the watchdog template was stopped as a routine");
    // A failed stop is said and the daily goes on, as for the shadow.
    assert.match(r.log, /WARNING: could not stop e2e-routine-validation\.service/);
    assert.match(r.log, /could not resolve the version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed stop of the on-demand run is said and does not end the daily", () => {
  const dir = makeTempDir("run-daily-ondemand-");
  try {
    const systemctl = `#!/bin/sh\ncase "$*" in "show "*e2e-on-demand*) echo active; exit 0 ;; "stop e2e-on-demand.service") exit 1 ;; show*) echo inactive ;; esac\nexit 0\n`;
    const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl });
    assert.match(r.log, /WARNING: could not stop e2e-on-demand\.service/);
    assert.match(r.log, /could not resolve the version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed stop is said and does not end the daily (#2094)", () => {
  const dir = makeTempDir("run-daily-shadow-");
  try {
    const systemctl = `#!/bin/sh\n[ "$1" = show ] && { echo activating; exit 0; }\n[ "$1" = stop ] && exit 1\nexit 0\n`;
    const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl });
    assert.match(r.log, /WARNING: could not stop e2e-shadow\.service/);
    assert.match(r.log, /could not resolve the version/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ROUTINE_LISTING = [
  "e2e-routine-migration.service loaded activating start Migration",
  "e2e-routine-validation.service loaded activating start Validation",
].join("\\n");
const routineSystemctl = (calls) =>
  `#!/bin/sh\necho "$*" >> ${JSON.stringify(calls)}\ncase "$1" in list-units) printf '${ROUTINE_LISTING}\\n' ;; show) echo inactive ;; esac\nexit 0\n`;

test("a routine still waiting for its turn is left to wait: it is doing nothing, and this run keeps it waiting", () => {
  // A routine whose timer falls in the daily's window is `activating` while it waits; the
  // first version stopped it and its day read failed (review of #2190).
  const dir = makeTempDir("run-daily-routines-wait-");
  try {
    const calls = join(dir, "systemctl.calls");
    const flockCalls = join(dir, "flock.calls");
    const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl: routineSystemctl(calls), flock: `#!/bin/sh\necho "$*" >> ${JSON.stringify(flockCalls)}\nexit 0\n` });
    const log = readFileSync(calls, "utf8");
    assert.doesNotMatch(log, /^stop e2e-routine-/m, log);
    // The probe: non-blocking, on the lock the routines take, and nothing held after it.
    assert.equal(readFileSync(flockCalls, "utf8"), `-n ${join(dir, "heavy.lock")} true\n`);
    assert.match(r.log, /leaving the routine e2e-routine-migration\.service: it is waiting for its turn/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("with the lock held, only the routine that holds it is stopped", () => {
  const dir = makeTempDir("run-daily-routines-holder-");
  try {
    const calls = join(dir, "systemctl.calls");
    writeFileSync(join(dir, "heavy.lock.holder"), "migration (pid 4242) since 20261006T074500Z\n");
    const r = runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl: routineSystemctl(calls), flock: "#!/bin/sh\nexit 1\n" });
    const log = readFileSync(calls, "utf8");
    assert.match(log, /^stop e2e-routine-migration\.service$/m, log);
    assert.doesNotMatch(log, /^stop e2e-routine-validation\.service$/m, log);
    assert.match(r.log, /leaving the routine e2e-routine-validation\.service/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a holder named for no listed unit is unknown: every routine is stopped", () => {
  // A routine whose routine_start name is not its unit's would otherwise be the one left
  // running beside the daily (review of #2190).
  const dir = makeTempDir("run-daily-routines-ghost-");
  try {
    const calls = join(dir, "systemctl.calls");
    writeFileSync(join(dir, "heavy.lock.holder"), "ghost (pid 4242) since 20261006T074500Z\n");
    runWrapper(dir, COMPLETE_LANE, WRAPPER, {}, { systemctl: routineSystemctl(calls), flock: "#!/bin/sh\nexit 1\n" });
    const log = readFileSync(calls, "utf8");
    assert.match(log, /^stop e2e-routine-migration\.service$/m, log);
    assert.match(log, /^stop e2e-routine-validation\.service$/m, log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
