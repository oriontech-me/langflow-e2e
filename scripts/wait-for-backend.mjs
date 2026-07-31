#!/usr/bin/env node
// Post-collect-models health gate — the single implementation (issue #1045).
//
// WHY THIS EXISTS
//
// collect-models' model-toggle sweep can leave the shared Langflow backend
// process-wide WEDGED: container alive, healthcheck green, event loop blocked,
// requests simply not answered (#922, #927). Playwright's own globalSetup polls
// /api/v1/version for 120 s and then throws, so a wedge that outlasts that
// window costs the whole lane and reports itself as an unattributed preflight
// timeout. This gate runs BETWEEN the sweep and the test run and does two things
// globalSetup cannot: it gives the wedge a longer window to clear, and when it
// does not clear it fails in its OWN step with the real cause named (#1011).
//
// WHY IT IS A SCRIPT AND NOT FOUR SHELL LOOPS
//
// The loop was copy-pasted into daily-stable.yml (#1011), pr-validation.yml
// (#1019/#1044) and manual.yml, and the copies had already diverged on the
// deadline, the heartbeat, the failure attribution and the pre-flight warning —
// while weekly-stable.yml, the documented fallback, had no gate at all. #1045
// extracts it once, behind `.github/actions/wait-for-backend`, and carries every
// copy's best behaviour into all four lanes. Being a script rather than shell in
// a composite action is what makes the four backend states testable
// (`scripts/wait-for-backend.test.mjs`, `npm run test:scripts`): healthy, dead
// port, wedged, and wedged-then-recovers — none of which can be reproduced in
// CI on demand, because the wedge depends on the runner's collect-models load.
//
// PROBE SHAPE
//
// Short per-request deadline over a long total deadline (the #928 shape): a hung
// request must fail FAST so the loop keeps polling across the wedge instead of
// burning the whole budget on one GET. The shell copies expressed this as
// `curl --connect-timeout 5 --max-time 8`; `fetch` has no separate connect
// deadline, so one 8 s per-probe deadline stands in for both — a refused
// connection fails in milliseconds regardless, which is the only case the split
// distinguished.
//
// FAILURE CLASSIFICATION
//
// The shell copies decoded curl's exit code (7 = refused, 28 = timeout) because
// that code is the one datum separating "the backend is dead" from "the backend
// is wedged" — two states that call for different follow-ups. Node reports the
// same distinction natively and more precisely (`cause.code` / `TimeoutError`),
// so nothing is lost in the port.
//
// Inputs (env — all optional, defaults below):
//   WAIT_BASE_URL          Langflow base URL (default http://localhost:7860/)
//   WAIT_TIMEOUT_S         total deadline in seconds (default 420)
//   WAIT_PROBE_TIMEOUT_MS  per-probe deadline (default 8000)
//   WAIT_INTERVAL_S        sleep between attempts (default 5)
//   WAIT_HEARTBEAT_EVERY   log a heartbeat every N attempts (default 6, 0 = off)
//   WAIT_NEXT_STEP_LABEL   what runs after this gate, for both log lines
//   WAIT_ATTRIBUTION       lane-specific "NOT ..." clause of the error
//   WAIT_COLLECT_MODELS_OUTCOME  the pre-flight step's outcome, surfaced as a
//                          ::warning:: here where a reader is already looking —
//                          the run is NOT gated on it (#980)
//
// Exit 0 = backend answered; exit 1 = deadline expired (the lane should stop).
//
// Pure, dependency-free ESM so every lane runs it with plain `node` (no ts-node).

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULTS = {
  baseUrl: "http://localhost:7860/",
  timeoutS: 420,
  probeTimeoutMs: 8000,
  intervalS: 5,
  heartbeatEvery: 6,
  nextStepLabel: "the test run",
  attribution: "NOT a per-test failure",
};

const HEALTH_PATH = "/api/v1/version";

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// `manual.yml` can target an arbitrary Langflow (a dispatched URL, not the
// service container), and those URLs arrive with or without a trailing slash.
export function buildProbeUrl(baseUrl) {
  return `${String(baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, "")}${HEALTH_PATH}`;
}

// The kinds are what the caller ACTS on, so they are deliberately coarse:
//   dead   nothing is listening — the backend never came up, or came down for
//          good. Waiting longer cannot help; look at the container's own log.
//   wedged the connection is accepted and never answered. This is the #922/#927
//          shape, and the one state where the budget buys a real recovery: the
//          replacement worker only arrives after gunicorn's own WORKER TIMEOUT.
//   http   it ANSWERS, with a non-2xx. Not a wedge at all — an application-level
//          failure that a longer wait will not change either, but which must not
//          be reported as one, or the next reader chases the wrong bug.
//   other  DNS, TLS, an unroutable host — usually a wiring mistake in the lane.
// `headline` is the sentence that assigns blame. It is per-kind on purpose: the
// inline copies claimed "This is the post-collect-models wedge" unconditionally,
// which is a false statement on three of the four states and sends the next
// reader after the wrong bug — the exact cost the gate was built to avoid.
export function classifyFailure(failure) {
  if (!failure) {
    return { kind: "unknown", diag: "no failure recorded", headline: "The gate recorded no probe result, which is a bug in the gate itself" };
  }
  if (failure.status) {
    return {
      kind: "http",
      diag: `answered HTTP ${failure.status} — the backend is UP but ${HEALTH_PATH} is failing, so this is not the wedge`,
      headline: `The backend is answering and rejecting ${HEALTH_PATH}, so this is an application-level failure and NOT the post-collect-models wedge`,
    };
  }
  const code = failure.code || "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
    return {
      kind: "dead",
      diag: `connection ${code === "ECONNREFUSED" ? "refused" : `failed (${code})`} — the backend is DEAD or never came back up`,
      headline: "Nothing is listening: the backend died or never came back after the sweep (the #1011 class), and waiting longer cannot help",
    };
  }
  if (code === "TIMEOUT" || /TIMEOUT/i.test(code)) {
    return {
      kind: "wedged",
      diag: "connection accepted but unanswered within the probe deadline — the WEDGE shape of #922/#927",
      headline: "This is the post-collect-models wedge (#922/#927/#1011/#1019)",
    };
  }
  return {
    kind: "other",
    diag: `${code || failure.reason || "unknown error"} — check the lane's wiring, not the wedge`,
    headline: "The probe never reached a Langflow: this looks like the lane's own wiring (base URL, DNS, network), not the wedge",
  };
}

export async function probeOnce(url, timeoutMs, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { ok: true, ms: Date.now() - started };
    return { ok: false, ms: Date.now() - started, status: res.status, reason: `HTTP ${res.status}` };
  } catch (err) {
    // A wedge surfaces as an abort (`TimeoutError`) or as one of undici's own
    // *_TIMEOUT codes depending on how far the request got; both map to the same
    // verdict, so normalise them here instead of in the classifier.
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError" || /TIMEOUT/i.test(err?.cause?.code || "");
    // `cause.code` is the normal carrier, but not a guaranteed one: undici surfaces
    // some failures with the code only inside `cause.message` ("connect
    // ECONNREFUSED 127.0.0.1:7860"), and losing it there would demote a DEAD
    // backend to the generic "check the lane's wiring" bucket — the one
    // distinction this gate exists to make.
    const fromMessage = /\b(E[A-Z]{2,})\b/.exec(err?.cause?.message || "")?.[1];
    const code = isTimeout ? "TIMEOUT" : err?.cause?.code || fromMessage || err?.code || err?.name || "UNKNOWN";
    return { ok: false, ms: Date.now() - started, code, reason: String(err?.message || err).slice(0, 120) };
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until the backend answers or the deadline expires.
 *
 * `probe`, `now` and `sleep` are injectable so the unit tests can drive the loop
 * deterministically; CI always uses the real ones.
 *
 * @returns {Promise<{ok: boolean, attempts: number, elapsedS: number, failure?: object}>}
 */
export async function waitForBackend(options = {}) {
  const {
    url = buildProbeUrl(DEFAULTS.baseUrl),
    timeoutS = DEFAULTS.timeoutS,
    probeTimeoutMs = DEFAULTS.probeTimeoutMs,
    intervalS = DEFAULTS.intervalS,
    heartbeatEvery = DEFAULTS.heartbeatEvery,
    log = console.log,
    probe = (u) => probeOnce(u, probeTimeoutMs),
    now = () => Date.now(),
    sleep = realSleep,
  } = options;

  const startedAt = now();
  const deadline = startedAt + timeoutS * 1000;
  let attempts = 0;
  let failure;

  for (;;) {
    attempts += 1;
    const result = await probe(url);
    if (result.ok) {
      return { ok: true, attempts, elapsedS: Math.round((now() - startedAt) / 1000), failure: undefined };
    }
    failure = result;

    // The deadline is checked AFTER a probe and BEFORE the sleep, so the budget
    // is never overshot by a full interval and a timeoutS smaller than one
    // interval still gets one real attempt.
    if (now() >= deadline) {
      return { ok: false, attempts, elapsedS: Math.round((now() - startedAt) / 1000), failure };
    }

    // Without this a step that legitimately sits for 5-7 min prints nothing and
    // reads as hung — the improvement #1044 parked on pr-validation only.
    if (heartbeatEvery > 0 && attempts % heartbeatEvery === 0) {
      const left = Math.max(0, Math.round((deadline - now()) / 1000));
      log(
        `Still waiting: attempt ${attempts}, last failure ${failure.code || failure.reason || "unknown"}, ${left}s left of ${timeoutS}s.`,
      );
    }
    await sleep(intervalS * 1000);
  }
}

export async function main(env = process.env, log = console.log) {
  const baseUrl = env.WAIT_BASE_URL || DEFAULTS.baseUrl;
  const timeoutS = num(env.WAIT_TIMEOUT_S, DEFAULTS.timeoutS);
  const probeTimeoutMs = num(env.WAIT_PROBE_TIMEOUT_MS, DEFAULTS.probeTimeoutMs);
  const intervalS = num(env.WAIT_INTERVAL_S, DEFAULTS.intervalS);
  const heartbeatEvery = Number(env.WAIT_HEARTBEAT_EVERY ?? DEFAULTS.heartbeatEvery);
  const nextStep = env.WAIT_NEXT_STEP_LABEL || DEFAULTS.nextStepLabel;
  const attribution = env.WAIT_ATTRIBUTION || DEFAULTS.attribution;
  const url = buildProbeUrl(baseUrl);

  // Surface the pre-flight's verdict here, where a reader is already looking.
  // Without it a failed sweep is buried in its own step's log and the resulting
  // provider skips look unexplained (the silent-erosion class of #570).
  if (env.WAIT_COLLECT_MODELS_OUTCOME === "failure") {
    log(
      "::warning::Collect models FAILED. The run continues by design (#980), but providers.json/models.json may be stale or incomplete, so provider-parameterized specs can skip. Check that step's log for which provider is down.",
    );
  }

  log(`Waiting up to ${timeoutS}s for ${url} (probe deadline ${probeTimeoutMs}ms, interval ${intervalS}s).`);
  const outcome = await waitForBackend({
    url,
    timeoutS,
    probeTimeoutMs,
    intervalS,
    heartbeatEvery: Number.isFinite(heartbeatEvery) ? heartbeatEvery : DEFAULTS.heartbeatEvery,
    log,
  });

  if (outcome.ok) {
    log(
      `Backend answered ${HEALTH_PATH} on attempt ${outcome.attempts} after ${outcome.elapsedS}s — proceeding to ${nextStep}.`,
    );
    return 0;
  }

  const { diag, headline } = classifyFailure(outcome.failure);
  log(
    `::error::Langflow did not answer ${HEALTH_PATH} within ${timeoutS}s after the Collect models step ` +
      `(${outcome.attempts} attempts; ${diag}). ${nextStep} would abort in globalSetup with zero tests. ` +
      `${headline}, ${attribution}.`,
  );
  return 1;
}

// Run only when invoked directly (not when imported by the test file). Same
// realpath/pathToFileURL normalisation as scripts/watch-backend.mjs.
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
