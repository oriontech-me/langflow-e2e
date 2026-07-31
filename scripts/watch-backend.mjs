#!/usr/bin/env node
// In-run backend liveness recorder for the sharded stable workflows (issue #1030).
//
// WHY THIS EXISTS
//
// The #1011 health gate protects the START of a shard: it waits out the
// post-collect-models wedge before Playwright launches. Nothing watches the
// backend DURING the run, and #1048 established that a wedge mid-run is not an
// anomaly on the heavy shards — on daily run 30444299314 gunicorn killed the
// single Langflow worker 7 times on shard 3 and 10 times on shard 4, spread
// evenly across each shard's ~30 minutes of specs.
//
// That run also showed why the wedge cannot be quantified after the fact from
// the artifacts we keep:
//   - the Langflow image logs no per-request access line, so the container dump
//     gives the KILL timestamps but not when the event loop actually stalled;
//   - gunicorn's async worker only reveals a stall via `WORKER TIMEOUT`, which
//     fires 60-120 s late (`LANGFLOW_WORKER_TIMEOUT=120`, #1048), so a
//     post-hoc "outage window" is 60-120 s wide by construction;
//   - at ~1 wedge per 3 minutes those windows cover 33-73% of the shard, and
//     almost every failing attempt lands inside one BY CHANCE. Correlating
//     failures against them proves nothing.
//
// So the measurement has to happen while the run is happening. This recorder
// polls the same URL the specs talk to, at a fixed interval, and appends one
// JSONL line per probe. Two consecutive failed probes bound an outage to a few
// seconds instead of two minutes, which is narrow enough for the merge job to
// attribute collateral failures honestly. (#1031 keeps the @stable decision on
// the failure's own error signature and consumes only the `wedged` verdict, to
// word its exemption — see scripts/lib/infra-signatures.ts.)
//
// It is DIAGNOSTIC ONLY. It never fails a step, never aborts a shard, and never
// gates the @stable tag — at this wedge frequency an abort would discard the
// ~100 specs per shard that pass across the outages (see #1030's rejected
// levers). It records; the merge job reports.
//
// MODES
//   (default)    poll until SIGTERM/SIGINT (or WATCH_MAX_SECONDS), appending
//                one probe per tick to WATCH_OUT
//   --summarize  read WATCH_OUT and write a compact JSON summary to
//                WATCH_SUMMARY (outage windows + totals), for the merge job
//
// Inputs (env):
//   WATCH_URL          probe target (default http://localhost:7860/api/v1/version)
//   WATCH_OUT          JSONL probe log (default backend-liveness.jsonl)
//   WATCH_SUMMARY      summary path, --summarize only (default backend-liveness.json)
//   WATCH_INTERVAL_MS  probe period (default 2000) — the sleep is interval minus
//                      the probe's own duration, so a probe that burns the full
//                      timeout relaxes the cadence to ~WATCH_TIMEOUT_MS. The
//                      resolution DURING an outage is therefore the timeout, not
//                      the interval
//   WATCH_TIMEOUT_MS   per-probe deadline (default 4000) — a wedged backend
//                      accepts the TCP connection and never answers, so without
//                      this the probe would hang instead of recording a failure
//   WATCH_MAX_SECONDS  hard stop so a leaked recorder cannot outlive the job
//                      (default 7200)
//   WATCH_MIN_PROBES   consecutive failed probes required to call it an outage
//                      (default 2 — one failed probe can be a local blip)
//   WATCH_LABEL        shard label carried into the summary (e.g. "3")
//   WATCH_FILES        the spec files this shard ran, whitespace-separated
//                      (matrix.files) — the merge job needs it to map a test in
//                      the MERGED report back to the shard whose backend wedged
//
// Always exits 0: a diagnostic must never be the reason a shard goes red.
//
// Pure, dependency-free ESM so CI runs it with plain `node` (no ts-node).

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULTS = {
  url: "http://localhost:7860/api/v1/version",
  out: "backend-liveness.jsonl",
  summary: "backend-liveness.json",
  intervalMs: 2000,
  timeoutMs: 4000,
  maxSeconds: 7200,
  minProbes: 2,
};

// Reason strings are the only free-form text in a probe line. Cap them so a
// pathological error message cannot bloat the log we upload as an artifact.
const REASON_MAX = 80;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseProbes(text) {
  const probes = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      // A torn last line is expected: the recorder is killed mid-append when
      // the job moves on. Skip it rather than failing the summary.
      continue;
    }
    const t = Date.parse(rec?.t);
    if (!Number.isFinite(t)) continue;
    probes.push({ t, ok: rec.ok === true, ms: Number(rec.ms) || 0, reason: rec.reason || "" });
  }
  return probes.sort((a, b) => a.t - b.t);
}

// A window spans [first failed probe, first probe that answered again]. Both
// edges are CONSERVATIVE in the direction that under-reports the outage: the
// backend stopped answering at most one interval BEFORE the first failed probe,
// and was back at most one interval before `endAt`. So `seconds` is a lower
// bound on the real outage, never an inflated one — the opposite of the
// post-hoc `WORKER TIMEOUT` window this replaces.
export function summarizeProbes(probes, { minProbes = DEFAULTS.minProbes } = {}) {
  const sorted = [...probes].sort((a, b) => a.t - b.t);
  const windows = [];
  let blips = 0;
  let run = [];

  const close = (endAt, openEnded) => {
    if (!run.length) return;
    if (run.length >= minProbes) {
      const startAt = run[0].t;
      windows.push({
        startAt: new Date(startAt).toISOString(),
        endAt: new Date(endAt).toISOString(),
        seconds: Math.round(((endAt - startAt) / 1000) * 10) / 10,
        probes: run.length,
        openEnded,
        reason: run[0].reason || "",
      });
    } else {
      blips += run.length;
    }
    run = [];
  };

  for (const p of sorted) {
    if (p.ok) {
      close(p.t, false);
    } else {
      run.push(p);
    }
  }
  // The log ended while the backend was still down (the run finished, or the
  // recorder was killed). Close at the last failed probe: anything past it is
  // unmeasured, and guessing would inflate the outage.
  close(run.length ? run[run.length - 1].t : 0, true);

  const downSeconds = windows.reduce((acc, w) => acc + w.seconds, 0);
  const firstProbeAt = sorted.length ? new Date(sorted[0].t).toISOString() : null;
  const lastProbeAt = sorted.length ? new Date(sorted[sorted.length - 1].t).toISOString() : null;
  const spanSeconds = sorted.length
    ? Math.round(((sorted[sorted.length - 1].t - sorted[0].t) / 1000) * 10) / 10
    : 0;

  return {
    measured: sorted.length > 0,
    probeCount: sorted.length,
    failedProbes: sorted.filter((p) => !p.ok).length,
    ignoredBlips: blips,
    firstProbeAt,
    lastProbeAt,
    spanSeconds,
    windows,
    outageCount: windows.length,
    downSeconds: Math.round(downSeconds * 10) / 10,
    // Share of the OBSERVED span the backend was unreachable. The merge job
    // prints this next to any failure correlation: at 50% coverage, "the
    // failure fell inside an outage" is a coin flip, not evidence.
    downPct: spanSeconds > 0 ? Math.round((downSeconds / spanSeconds) * 1000) / 10 : 0,
  };
}

async function probeOnce(url, timeoutMs) {
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, ms: Date.now() - started, reason: res.ok ? "" : `HTTP ${res.status}` };
  } catch (err) {
    const reason = String(err?.name === "TimeoutError" ? `timeout>${timeoutMs}ms` : err?.message || err);
    return { ok: false, ms: Date.now() - started, reason: reason.slice(0, REASON_MAX) };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function watch() {
  const url = process.env.WATCH_URL || DEFAULTS.url;
  const out = process.env.WATCH_OUT || DEFAULTS.out;
  const intervalMs = num(process.env.WATCH_INTERVAL_MS, DEFAULTS.intervalMs);
  const timeoutMs = num(process.env.WATCH_TIMEOUT_MS, DEFAULTS.timeoutMs);
  const maxSeconds = num(process.env.WATCH_MAX_SECONDS, DEFAULTS.maxSeconds);
  const deadline = Date.now() + maxSeconds * 1000;

  let running = true;
  // The recorder is stopped by the workflow's `kill` in a later step, so a
  // signal is the NORMAL exit path, not an error.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      running = false;
    });
  }

  console.log(`[liveness] probing ${url} every ${intervalMs}ms (timeout ${timeoutMs}ms) → ${out}`);
  let lastOk = null;
  while (running && Date.now() < deadline) {
    const tick = Date.now();
    const probe = await probeOnce(url, timeoutMs);
    try {
      fs.appendFileSync(
        out,
        JSON.stringify({ t: new Date(tick).toISOString(), ok: probe.ok, ms: probe.ms, ...(probe.reason ? { reason: probe.reason } : {}) }) + "\n",
      );
    } catch (err) {
      // Losing a probe line is preferable to killing the recorder: the summary
      // degrades, the shard is unaffected.
      console.log(`[liveness] could not append a probe: ${err?.message || err}`);
    }
    // Log only transitions — a line per probe would bury the shard's own output.
    if (lastOk !== probe.ok) {
      console.log(
        `[liveness] ${new Date(tick).toISOString()} backend ${probe.ok ? "UP" : `DOWN (${probe.reason})`}`,
      );
      lastOk = probe.ok;
    }
    await sleep(Math.max(0, intervalMs - (Date.now() - tick)));
  }
  console.log("[liveness] recorder stopped.");
}

function summarize() {
  const out = process.env.WATCH_OUT || DEFAULTS.out;
  const summaryPath = process.env.WATCH_SUMMARY || DEFAULTS.summary;
  const minProbes = num(process.env.WATCH_MIN_PROBES, DEFAULTS.minProbes);
  const shard = process.env.WATCH_LABEL || "";
  const files = String(process.env.WATCH_FILES || "")
    .split(/\s+/)
    .filter(Boolean);

  let text = "";
  try {
    text = fs.readFileSync(out, "utf8");
  } catch {
    // No probe log at all: the recorder never started (or died instantly). Say
    // so explicitly — `measured: false` must never be read as "no outage".
    console.log(`[liveness] ${out} is missing — writing an UNMEASURED summary for shard ${shard || "?"}.`);
  }

  const summary = { shard, files, ...summarizeProbes(parseProbes(text), { minProbes }) };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + "\n");

  if (!summary.measured) {
    console.log(`[liveness] shard ${shard || "?"}: NOT MEASURED (no usable probe recorded).`);
    return;
  }
  console.log(
    `[liveness] shard ${shard || "?"}: ${summary.outageCount} outage(s), ` +
      `${summary.downSeconds}s down of ${summary.spanSeconds}s observed (${summary.downPct}%), ` +
      `${summary.probeCount} probes, ${summary.ignoredBlips} single-probe blip(s) ignored.`,
  );
  for (const w of summary.windows) {
    console.log(
      `[liveness]   ${w.startAt} → ${w.endAt}  ${w.seconds}s` +
        `${w.openEnded ? " (still down when the log ended)" : ""}${w.reason ? `  ${w.reason}` : ""}`,
    );
  }
}

async function main() {
  try {
    if (process.argv.includes("--summarize")) {
      summarize();
    } else {
      await watch();
    }
  } catch (err) {
    // Diagnostics never break the build.
    console.log(`[liveness] recorder error (ignored): ${err?.stack || err}`);
  }
}

// Run only when invoked directly (not when imported by the test file). Same
// realpath/pathToFileURL normalisation as scripts/check-run-integrity.mjs —
// see the comment there for why both halves are load-bearing.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
