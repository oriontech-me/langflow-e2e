#!/usr/bin/env node
// In-run database-write watchdog for a shard (issue #2405, option 2).
//
// WHY THIS EXISTS
//
// The health gate (`wait-for-backend.mjs`) checks the backend once, before the
// round. On on-demand run od-20261109-e3743682 one shard's SQLite file was locked
// while `/api/v1/version` kept answering, and every spec then spent its whole
// auth budget (`get-auth-token.ts`: ~110 s per attempt, ~5 min per test at the
// default retries) rediscovering the same dead backend. The shard ran until the
// run deadline, which then discarded the three shards that had finished.
//
// This watchdog runs beside the round and asks the gate's two questions on a fixed
// interval: does `/api/v1/version` answer, and does `/api/v1/auto_login` (which
// writes) answer? When the version answers and the write has failed CONTINUOUSLY
// for `thresholdS`, it records a verdict and sends SIGINT to the round's process
// group. Playwright handles SIGINT by stopping and still writing its reporters, so
// the blob keeps every test that finished (measured: 2 passed, 1 interrupted,
// 1 did not run, exit 130), and the run can merge and publish instead of timing out.
//
// WHAT IT DELIBERATELY DOES NOT DO
//
// It never aborts on the wedge. A probe whose VERSION call fails resets the
// streak: #1030 rejected aborting a shard on the wedge, because at ~1 wedge per
// 3 minutes on the heavy shards an abort would discard the ~100 specs that pass
// across the outages (see `watch-backend.mjs`). The state this watchdog acts on is
// the other one: the event loop answering while the database will not take a
// write, which does not clear between tests. A 403 on the write probe (auto-login
// disabled) also resets it, because the write path cannot be judged there.
//
// Inputs (env):
//   WATCHDOG_BASE_URL         Langflow base URL (default http://localhost:7860/)
//   WATCHDOG_TARGET_PGID      process group of the round; the watchdog signals
//                             -PGID. Without it the watchdog only records.
//   WATCHDOG_OUT              verdict JSON path (default db-watchdog.json)
//   WATCHDOG_THRESHOLD_S      continuous write-failure window before acting (300)
//   WATCHDOG_INTERVAL_S       probe period (default 30)
//   WATCHDOG_PROBE_TIMEOUT_MS per-probe deadline (default 8000)
//   WATCHDOG_MAX_SECONDS      hard stop so a leaked watchdog cannot outlive the
//                             shard (default 7200)
//
// The verdict file is written once, when the watchdog acts or stops:
//   {"fired": true|false, "base_url", "streak_started_at", "fired_at",
//    "failed_probes", "last_failure", "diag", "threshold_s"}
//
// Always exits 0: whether the shard failed is decided by the round's exit status
// and the verdict file, never by this process's own exit code.
//
// Pure, dependency-free ESM so every lane runs it with plain `node`.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { buildProbeUrl, classifyFailure, probeBackend } from "./wait-for-backend.mjs";

export const DEFAULTS = {
  baseUrl: "http://localhost:7860/",
  out: "db-watchdog.json",
  thresholdS: 300,
  intervalS: 30,
  probeTimeoutMs: 8000,
  maxSeconds: 7200,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * One step of the streak. Only a write-stage failure extends it; anything else
 * (a pass, an unverifiable 403 pass, or a version failure = the wedge) resets it.
 *
 * @returns {{streakStartedAt: number|null, failedProbes: number, lastFailure: object|null, fire: boolean}}
 */
export function nextState(state, result, nowMs, thresholdS) {
  if (result.ok || result.stage !== "write") {
    return { streakStartedAt: null, failedProbes: 0, lastFailure: null, fire: false };
  }
  const streakStartedAt = state.streakStartedAt ?? nowMs;
  const failedProbes = state.failedProbes + 1;
  // Two probes at least: one failed write is not a streak, whatever the clock says.
  const fire = failedProbes >= 2 && nowMs - streakStartedAt >= thresholdS * 1000;
  return { streakStartedAt, failedProbes, lastFailure: result, fire };
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the watchdog acts, is stopped, or reaches its hard stop.
 * `probe`, `now`, `sleep`, `kill` and `stopped` are injectable for the unit tests.
 */
export async function runWatchdog(options = {}) {
  const {
    baseUrl = DEFAULTS.baseUrl,
    thresholdS = DEFAULTS.thresholdS,
    intervalS = DEFAULTS.intervalS,
    probeTimeoutMs = DEFAULTS.probeTimeoutMs,
    maxSeconds = DEFAULTS.maxSeconds,
    targetPgid,
    log = console.log,
    probe = (url) => probeBackend(url, probeTimeoutMs),
    now = () => Date.now(),
    sleep = realSleep,
    kill = (pid, signal) => process.kill(pid, signal),
    stopped = () => false,
  } = options;

  const url = buildProbeUrl(baseUrl);
  const startedAt = now();
  let state = { streakStartedAt: null, failedProbes: 0, lastFailure: null, fire: false };

  const verdict = (fired) => ({
    fired,
    base_url: baseUrl,
    threshold_s: thresholdS,
    streak_started_at: state.streakStartedAt ? new Date(state.streakStartedAt).toISOString() : null,
    fired_at: fired ? new Date(now()).toISOString() : null,
    failed_probes: state.failedProbes,
    last_failure: state.lastFailure,
    diag: state.lastFailure ? classifyFailure(state.lastFailure).diag : null,
  });

  while (!stopped() && now() - startedAt < maxSeconds * 1000) {
    const result = await probe(url);
    if (stopped()) break;
    state = nextState(state, result, now(), thresholdS);
    if (state.fire) {
      const v = verdict(true);
      log(
        `::error::DB-write watchdog: ${v.diag}, continuously for ${thresholdS}s ` +
          `(${state.failedProbes} probes since ${v.streak_started_at}). Stopping the round so the shard ` +
          `keeps what it measured instead of failing every remaining test in auth (#2405).`,
      );
      if (targetPgid) {
        try {
          kill(-targetPgid, "SIGINT");
        } catch (err) {
          log(`DB-write watchdog: could not signal process group ${targetPgid}: ${err?.message || err}`);
        }
      }
      return v;
    }
    await sleep(intervalS * 1000);
  }
  return verdict(false);
}

export async function main(env = process.env, log = console.log) {
  const out = env.WATCHDOG_OUT || DEFAULTS.out;
  const pgid = Number(env.WATCHDOG_TARGET_PGID);
  let stop = false;
  const onStop = () => {
    stop = true;
  };
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);

  const verdict = await runWatchdog({
    baseUrl: env.WATCHDOG_BASE_URL || DEFAULTS.baseUrl,
    thresholdS: num(env.WATCHDOG_THRESHOLD_S, DEFAULTS.thresholdS),
    intervalS: num(env.WATCHDOG_INTERVAL_S, DEFAULTS.intervalS),
    probeTimeoutMs: num(env.WATCHDOG_PROBE_TIMEOUT_MS, DEFAULTS.probeTimeoutMs),
    maxSeconds: num(env.WATCHDOG_MAX_SECONDS, DEFAULTS.maxSeconds),
    targetPgid: Number.isInteger(pgid) && pgid > 1 ? pgid : undefined,
    log,
    stopped: () => stop,
    // A SIGTERM must not wait out a whole interval: the shard is collecting.
    sleep: (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        const poll = setInterval(() => {
          if (stop) {
            clearTimeout(t);
            clearInterval(poll);
            resolve();
          }
        }, 200);
      }),
  });

  try {
    fs.writeFileSync(out, `${JSON.stringify(verdict)}\n`);
  } catch (err) {
    log(`DB-write watchdog: could not write ${out}: ${err?.message || err}`);
  }
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exit(await main());
}
