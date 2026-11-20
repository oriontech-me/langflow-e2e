// Unit tests for the shard DB-write watchdog (issue #2405, option 2).
//
// The load-bearing properties: it acts ONLY on a sustained write failure while the
// version probe answers, it never acts on the wedge (#1030), and when it acts it
// signals the round's process GROUP with SIGINT, so Playwright still writes its
// blob. The last half is pinned against `run-e2e.sh` structurally, because the
// wiring is shell.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { makeTempDir } from "./lib/tmp-dir.mjs";
import { nextState, runWatchdog } from "./watch-db-writes.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const EMPTY = { streakStartedAt: null, failedProbes: 0, lastFailure: null, fire: false };
const WRITE_FAIL = { ok: false, stage: "write", code: "TIMEOUT", reason: "timeout" };
const VERSION_FAIL = { ok: false, stage: "version", code: "TIMEOUT", reason: "timeout" };

// A fake clock: each probe advances it by `stepMs`.
function scripted(results, stepMs) {
  let t = 1_000_000;
  let i = 0;
  return {
    now: () => t,
    probe: async () => {
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      t += stepMs;
      return r;
    },
    sleep: async () => {},
    calls: () => i,
  };
}

test("only a write-stage failure extends the streak", () => {
  let s = nextState(EMPTY, WRITE_FAIL, 0, 300);
  assert.equal(s.failedProbes, 1);
  assert.equal(s.streakStartedAt, 0);
  for (const reset of [{ ok: true }, { ok: true, writeUnverified: true }, VERSION_FAIL]) {
    assert.deepEqual(nextState(s, reset, 1000, 300), EMPTY);
  }
});

test("it fires only after the threshold AND at least two failed probes", () => {
  // One failed probe never fires, even with a zero threshold.
  assert.equal(nextState(EMPTY, WRITE_FAIL, 0, 0).fire, false);
  let s = nextState(EMPTY, WRITE_FAIL, 0, 300);
  s = nextState(s, WRITE_FAIL, 299_000, 300);
  assert.equal(s.fire, false);
  s = nextState(s, WRITE_FAIL, 300_000, 300);
  assert.equal(s.fire, true);
  assert.equal(s.failedProbes, 3);
});

test("a sustained write failure fires and signals the round's process GROUP with SIGINT", async () => {
  const clock = scripted([WRITE_FAIL], 30_000);
  const kills = [];
  const lines = [];
  const v = await runWatchdog({
    thresholdS: 300,
    targetPgid: 4242,
    ...clock,
    kill: (pid, sig) => kills.push([pid, sig]),
    log: (l) => lines.push(l),
  });
  assert.equal(v.fired, true);
  assert.deepEqual(kills, [[-4242, "SIGINT"]]);
  assert.ok(v.failed_probes >= 2);
  assert.match(v.diag, /#2405/);
  assert.match(lines.join("\n"), /::error::DB-write watchdog: .*continuously for 300s/);
});

test("the wedge never fires: a version failure between write failures resets the streak", async () => {
  // Write fails, then the version probe fails (the wedge), alternating for far
  // longer than the threshold. #1030: the wedge must not cost the shard its round.
  const pattern = [];
  for (let i = 0; i < 40; i++) pattern.push(i % 3 === 2 ? VERSION_FAIL : WRITE_FAIL);
  let i = 0;
  let t = 0;
  const kills = [];
  const v = await runWatchdog({
    thresholdS: 100,
    maxSeconds: 1000,
    targetPgid: 7,
    now: () => t,
    probe: async () => {
      t += 30_000;
      return pattern[i++ % pattern.length];
    },
    sleep: async () => {},
    kill: (pid, sig) => kills.push([pid, sig]),
    log: () => {},
  });
  assert.equal(v.fired, false);
  assert.deepEqual(kills, []);
});

test("a write failure that clears before the threshold never fires", async () => {
  const clock = scripted([WRITE_FAIL, WRITE_FAIL, { ok: true }, WRITE_FAIL, { ok: true }], 30_000);
  const kills = [];
  const v = await runWatchdog({ thresholdS: 120, maxSeconds: 300, targetPgid: 9, ...clock, kill: (p, s) => kills.push([p, s]), log: () => {} });
  assert.equal(v.fired, false);
  assert.deepEqual(kills, []);
});

test("without a target group it records the verdict but signals nothing", async () => {
  const clock = scripted([WRITE_FAIL], 60_000);
  const kills = [];
  const v = await runWatchdog({ thresholdS: 60, ...clock, kill: (p, s) => kills.push([p, s]), log: () => {} });
  assert.equal(v.fired, true);
  assert.deepEqual(kills, []);
});

test("stopping it returns an unfired verdict at once", async () => {
  let stop = false;
  const v = await runWatchdog({
    thresholdS: 300,
    probe: async () => {
      stop = true;
      return WRITE_FAIL;
    },
    sleep: async () => {},
    stopped: () => stop,
    log: () => {},
  });
  assert.equal(v.fired, false);
});

test("against a real locked backend the CLI writes a fired verdict and signals the group", async () => {
  // version answers, auto_login never does: the od-20261109-e3743682 shape.
  const server = http.createServer((req, res) => {
    if (req.url === "/api/v1/auto_login") return;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = makeTempDir("dbwd-");
  const out = path.join(dir, "v.json");
  // A sacrificial process group standing in for the round.
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const exited = new Promise((r) => victim.on("exit", (code, signal) => r(signal)));
  try {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "scripts/watch-db-writes.mjs")], {
      env: {
        ...process.env,
        WATCHDOG_BASE_URL: `http://127.0.0.1:${port}/`,
        WATCHDOG_TARGET_PGID: String(victim.pid),
        WATCHDOG_OUT: out,
        WATCHDOG_THRESHOLD_S: "0.3",
        WATCHDOG_INTERVAL_S: "0.1",
        WATCHDOG_PROBE_TIMEOUT_MS: "100",
      },
      stdio: "pipe",
    });
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0);
    const v = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(v.fired, true);
    assert.equal(v.last_failure.stage, "write");
    assert.equal(await exited, "SIGINT");
  } finally {
    try {
      process.kill(-victim.pid, "SIGKILL");
    } catch {}
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI stops on SIGTERM and writes an unfired verdict", async () => {
  const server = http.createServer((_req, res) => res.end("{}"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = makeTempDir("dbwd-");
  const out = path.join(dir, "v.json");
  try {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "scripts/watch-db-writes.mjs")], {
      env: { ...process.env, WATCHDOG_BASE_URL: `http://127.0.0.1:${server.address().port}/`, WATCHDOG_OUT: out, WATCHDOG_INTERVAL_S: "30" },
      stdio: "pipe",
    });
    await new Promise((r) => setTimeout(r, 500));
    const started = Date.now();
    child.kill("SIGTERM");
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0);
    assert.ok(Date.now() - started < 5000, "it does not wait out the 30 s interval");
    assert.equal(JSON.parse(fs.readFileSync(out, "utf8")).fired, false);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Wiring in run-e2e.sh ─────────────────────────────────────────────────────

test("run-e2e.sh runs the round in its own process group, watched, and records the group for the EXIT trap", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "scripts/run-e2e.sh"), "utf8");
  const body = src.slice(src.indexOf("run_shard() {"), src.indexOf("phase_shards() {"));
  const round = body.indexOf('npx playwright test --grep "$STABLE_GREP"');
  const roundLine = body.slice(body.lastIndexOf("\n", round), body.indexOf("\n", round));
  assert.match(roundLine, /setpgrp/, "the round gets its own process group, so SIGINT reaches every Playwright process");
  assert.match(roundLine, /&\s*$/, "the round runs in the background so the watchdog can run beside it");
  const watchdog = body.indexOf("scripts/watch-db-writes.mjs");
  const wait = body.indexOf('wait "$round_pid"');
  assert.ok(round > 0 && watchdog > round && wait > watchdog, "round → watchdog → wait");
  assert.match(body.slice(round, watchdog + 200), /WATCHDOG_TARGET_PGID="\$round_pid"/);
  assert.match(body.slice(round, wait), /echo "-\$round_pid" >> "\$pidfile"/);
  // The EXIT trap must accept a negative id (a group), which `kill "$p"` would read as a signal.
  assert.match(body, /trap 'while read -r p; do kill -- "\$p" 2>\/dev\/null \|\| true; done/);
});

test("run-e2e.sh fails the shard on a fired verdict, and only on a fired one (executed, not spelled)", async () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "scripts/run-e2e.sh"), "utf8");
  const body = src.slice(src.indexOf("run_shard() {"), src.indexOf("phase_shards() {"));
  const start = body.indexOf('  if [ -s "$db_verdict" ]; then');
  const end = body.indexOf("\n  fi\n", start) + "\n  fi\n".length;
  assert.ok(start > 0 && end > start);
  const block = body.slice(start, end);
  const dir = makeTempDir("dbwd-sh-");
  const run = (verdict, status) => {
    fs.writeFileSync(path.join(dir, "v.json"), verdict);
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    const script = [
      "set -euo pipefail",
      'err() { echo "ERR:$*"; }',
      `db_verdict=${JSON.stringify(path.join(dir, "v.json"))}`,
      `RUN_DIR=${JSON.stringify(dir)}`,
      "idx=2 DB_WATCHDOG_THRESHOLD_S=300",
      `status=${status}`,
      block,
      'echo "STATUS:$status"',
    ].join("\n");
    return spawnSync("bash", ["-c", script], { encoding: "utf8" }).stdout;
  };
  try {
    const fired = run('{"fired":true,"diag":"x"}\n', 0);
    assert.match(fired, /ERR:shard 2: the DB-write watchdog stopped the round .* for 300s \(#2405\)/);
    assert.match(fired, /STATUS:1/);
    assert.ok(fs.existsSync(path.join(dir, "logs", "shard-2-db-watchdog.json")), "the verdict is kept with the run's logs");
    // Playwright's own non-zero status (130 after SIGINT) is kept, not overwritten.
    assert.match(run('{"fired":true}\n', 130), /STATUS:130/);
    const quiet = run('{"fired":false}\n', 0);
    assert.doesNotMatch(quiet, /ERR:/);
    assert.match(quiet, /STATUS:0/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
