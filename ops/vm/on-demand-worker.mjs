#!/usr/bin/env node
// The on-demand worker: what e2e-on-demand-worker.service runs.
//
// ## What it is
//
// The bridge between the platform's on-demand queue and the executor on this machine
// (ops/vm/run-on-demand.sh, e2e-on-demand.service). The platform runs outside the IBM
// network and cannot reach the qa, so the VM pulls: every call here is outbound HTTPS.
// The worker claims one request, writes it into the executor's one slot, starts the
// unit, reports what the executor's log shows, and forwards the executor's result.
//
// ## The contract is the platform's
//
// The HTTP contract lives in oriontech-me/quality-platform and is not copied here:
//
//   apps/api/src/functions/on-demand/contract.ts   NORMATIVE: the zod schemas
//   docs/ON_DEMAND_QUEUE_CONTRACT.md                the readable side
//
// What this file repeats from it -- the constants, the shapes, the running states --
// it repeats because the worker must re-validate a claimed request before writing it
// into request.env, and must not depend on the platform's code to do so. A change
// there that a deployed worker could trip on bumps CONTRACT_VERSION.
//
// ## It interprets nothing
//
// The result goes VERBATIM: the keys and string values of results/<id>.env, as the
// executor wrote them. A green, a red and a refusal are the executor's words; the
// worker only carries them. Beside it goes the suite summary (phase 7): the run's
// results.json counted the way the daily's payload counts it
// (scripts/lib/on-demand-summary.mjs). Counting is not judging: the verdict stays
// the executor's, and a summary that cannot be built goes as null, never in place
// of the result. The one judgement it makes is WHEN: only once the unit is
// not running, because a result read during the cleanup says CLEANUP=pending and the
// platform keeps the first terminal body it gets.
//
// ## The daily has priority, here too
//
// The worker does not claim on the executor's own refusal conditions, so a claim never
// turns into a `refused` that only meant "not now" (the heartbeat says
// paused_for_daily instead):
//
//   - weekdays from 07:25 UTC to 08:40, five minutes before the executor's 07:30, so a
//     request claimed at the edge still starts outside it;
//   - while e2e-daily.service or e2e-shadow.service is running, whatever the hour;
//   - while a shadow request for today waits at /root/e2e-shadow/request.env.
//
// A request already held keeps its `busy` heartbeat through all of them, and a held
// request that must be started again (recovery) waits for them to pass.
//
// ## What survives a restart
//
// $STATE/worker/state.json holds the claim token and the held request. The token is
// written BEFORE the claim is sent, so a claim answer lost to the VPN is recovered by
// claiming again with the same token, and a worker restarted mid-run carries on as the
// holder. The executor runs in its own unit, so restarting the worker never stops a
// run.
//
// ## Exit statuses
//
//   0   stopped by a signal
//   78  the configuration is wrong: a variable is missing, or the platform answered 401
//       to the worker secret. The unit does not restart on it (RestartPreventExitStatus),
//       because retrying a wrong secret every 30 seconds fixes nothing.
import { readFileSync, writeFileSync, renameSync, linkSync, existsSync, mkdirSync, rmSync, openSync, fsyncSync, closeSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { summaryFromFile } from "../../scripts/lib/on-demand-summary.mjs";

// --- the contract's constants (contract.ts) -----------------------------------------

export const CONTRACT_VERSION = 1;
export const ENDPOINTS = { claim: "on-demand-worker-claim", report: "on-demand-worker-report", heartbeat: "on-demand-worker-heartbeat" };
export const LEASE_SECONDS = 900;
export const HEARTBEAT_SECONDS = 60;
export const MAX_HOLD_SECONDS = 7200;
export const POLL_SECONDS = 45; // inside the contract's 30-60
export const UNIT_RUNNING_STATES = ["activating", "active", "reloading", "deactivating"];
export const REPORT_MAX_BYTES = 512 * 1024;
export const RESULT_STATUSES = ["done", "failed", "build_failed", "refused"];

/** The request shapes: run-on-demand.sh's ondemand_parse_request, character for character. */
export const SHAPES = {
  id: /^[A-Za-z0-9._-]{1,64}$/,
  ref: /^[A-Za-z0-9._/-]{1,200}$/,
  provider: /^[a-z0-9-]{0,40}$/,
  model: /^[A-Za-z0-9._:/-]{0,120}$/,
  requestedBy: /^[A-Za-z0-9._@+-]{0,128}$/,
  suiteRef: /^[A-Za-z0-9._/-]{0,200}$/,
  workerId: /^[A-Za-z0-9._-]{1,64}$/,
  claimToken: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  stamp: /^\d{8}T\d{6}Z$/,
};

export const EXIT_CONFIG = 78;
const EXECUTOR_UNIT = "e2e-on-demand.service";
const DAILY_UNITS = ["e2e-daily.service", "e2e-shadow.service"];
const RANK = { claimed: 1, building: 2, running: 3 };

// --- pure parts ---------------------------------------------------------------------

/** "2026-10-01T22:34:05Z": the contract's timestamps, second precision as in its examples. */
export const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The executor's `date -u +%Y%m%dT%H%M%SZ` as ISO, or null when it is not one. */
export function stampToIso(stamp) {
  const m = SHAPES.stamp.test(stamp ?? "") && stamp.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/);
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(ms) ? null : isoUtc(ms);
}

/**
 * Why the worker must not claim (or start a recovery) now, or null. The executor's own
 * refusal conditions, with the clock five minutes earlier; `states` maps each daily
 * unit to its ActiveState, and an unreadable one counts as running.
 */
export function pauseReason({ nowMs, states, shadowRequest }) {
  const d = new Date(nowMs);
  const dow = d.getUTCDay(); // 0 Sunday .. 6 Saturday
  const hm = d.getUTCHours() * 100 + d.getUTCMinutes();
  if (dow >= 1 && dow <= 5 && hm >= 725 && hm < 840) return `the daily's window (weekdays 07:25-08:40 UTC, now ${String(hm).padStart(4, "0")})`;
  for (const unit of DAILY_UNITS) {
    const st = states[unit] ?? "unknown";
    if (st === "unknown" || UNIT_RUNNING_STATES.includes(st)) return `${unit} is ${st}`;
  }
  const today = d.toISOString().slice(0, 10);
  if (shadowRequest !== null && shadowRequest.split(/\r?\n/).includes(`SHADOW_DATE=${today}`)) return "a shadow request for today is waiting";
  return null;
}

/** What is wrong with a claimed request, or null. The worker writes nothing it did not check. */
export function claimedRequestError(req) {
  if (req === null || typeof req !== "object") return "the request is not an object";
  const fields = [["id", SHAPES.id], ["ref", SHAPES.ref], ["provider", SHAPES.provider], ["model", SHAPES.model], ["requested_by", SHAPES.requestedBy], ["claim_token", SHAPES.claimToken]];
  for (const [key, re] of fields) {
    if (typeof req[key] !== "string" || !re.test(req[key])) return `${key} does not have the executor's shape: ${JSON.stringify(String(req[key]).slice(0, 80))}`;
  }
  // The executor refuses a ref git would refuse, through build-target-image.sh; the
  // platform refuses these too. Checked again so request.env never carries one.
  const segs = req.ref.split("/");
  if (req.ref.includes("..") || segs.some((s) => s === "" || s === "." || s.startsWith(".") || s.endsWith(".lock"))) return `ref is not a branch name: ${JSON.stringify(req.ref)}`;
  if (req.model !== "" && req.provider === "") return "model needs provider: a model is declared for a provider";
  // Optional: a platform from before the suite ref sends none, which is the daily's.
  if (req.suite_ref !== undefined && req.suite_ref !== null) {
    if (typeof req.suite_ref !== "string" || !SHAPES.suiteRef.test(req.suite_ref)) return `suite_ref does not have the executor's shape: ${JSON.stringify(String(req.suite_ref).slice(0, 80))}`;
    const s = req.suite_ref;
    if (s !== "" && (s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.includes("..") || s.includes("//") || s.endsWith(".lock") || s.split("/").some((seg) => seg.startsWith(".")))) return `suite_ref is not a branch or tag name: ${JSON.stringify(s)}`;
  }
  return null;
}

/** request.env for the executor: one ONDEMAND_* line per field, values already checked. */
export function requestEnv(req) {
  return [
    `ONDEMAND_ID=${req.id}`,
    `ONDEMAND_REF=${req.ref}`,
    `ONDEMAND_PROVIDER=${req.provider}`,
    `ONDEMAND_MODEL=${req.model}`,
    `ONDEMAND_REQUESTED_BY=${req.requested_by}`,
    `ONDEMAND_SUITE_REF=${req.suite_ref ?? ""}`,
  ].join("\n") + "\n";
}

/**
 * results/<id>.env as an object, verbatim: every line split at its first '=', every
 * value a string, '' kept as ''. Nothing is renamed, dropped or added.
 */
export function parseResult(text) {
  const out = {};
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

/** The ONDEMAND_ID a request.env names, or null. */
export const slotId = (text) => text.split(/\r?\n/).find((l) => l.startsWith("ONDEMAND_ID="))?.slice("ONDEMAND_ID=".length) ?? null;

/**
 * What the executor's log says about request `id`: null when the log is another
 * request's; otherwise whether the build has started and, once the suite has, its
 * run id, the version and the build seconds (the "built:" line).
 *
 * The build starts soon after "suite at:", which comes after every refusal but the
 * provider pre-check's (langflow-e2e#2230): that one asks the provider in seconds,
 * between the two, so a request it refuses may show `building` for that long. Not on
 * build-target-image.sh's own "building" line: its stderr reaches the log only once
 * the build has ended. The full SHA is not here either: the log carries 12 characters
 * of it and the terminal result all 40, so `running` goes without it, as the contract
 * allows.
 */
export function readProgress(log, id) {
  if (!log.split("\n").some((l) => l.startsWith(`request: id=${id} `))) return null;
  const building = /^suite at: /m.test(log);
  const run = log.match(/^=== run start (\d{8}T\d{6}Z) ===$/m);
  const built = log.match(/^built: .* @ [0-9a-f]{12}, version (\S+), (\d+)s, as /m);
  return {
    building,
    runId: run ? run[1] : null,
    version: built && /^[\x21-\x7e]{1,200}$/.test(built[1]) ? built[1] : null,
    buildS: built ? Number(built[2]) : null,
  };
}

/** The worker's own refusal, in the executor's result format, for a request it will not write. */
export function refusalResult(id, reason, nowMs) {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return [
    `ONDEMAND_ID=${id}`,
    "STATUS=refused",
    "VERDICT=",
    `REASON=${reason.replace(/[\r\n]/g, " ")}`,
    "EXIT=2",
    "CLEANUP=ok",
    `FINISHED=${stamp}`,
  ].join("\n") + "\n";
}

/**
 * The terminal report's body, kept under REPORT_MAX_BYTES: over it, the summary goes
 * (the result alone always fits, the contract measures it under 50 KB).
 */
export function terminalBody({ workerId, held, result, summary, nowMs }) {
  const body = {
    contract_version: CONTRACT_VERSION,
    worker_id: workerId,
    id: held.id,
    claim_token: held.claim_token,
    at: stampToIso(result.FINISHED) ?? isoUtc(nowMs),
    status: result.STATUS,
    result,
    summary,
    evaluation: null,
  };
  if (summary !== null && Buffer.byteLength(JSON.stringify(body)) > REPORT_MAX_BYTES) body.summary = null;
  return body;
}

// --- the worker ---------------------------------------------------------------------

export class FatalConfig extends Error {}

export class Worker {
  /**
   * @param cfg  apiBase, token, workerId, state (the executor's $STATE), logDir,
   *             shadowState, systemctl (the binary), now (ms), fetch, log
   */
  constructor(cfg) {
    this.cfg = { systemctl: "systemctl", now: () => Date.now(), fetch: globalThis.fetch, log: (...a) => console.log(...a), ...cfg };
    this.dir = join(this.cfg.state, "worker");
    this.file = join(this.dir, "state.json");
    this.next = { heartbeat: 0, claim: 0, report: 0 };
    this.backoff = { claim: 0, report: 0 };
    this.said = "";
    this.state = this.load();
  }

  log(msg) { this.cfg.log(`on-demand-worker: ${msg}`); }

  /** A message once per change, for the states a loop sits in for minutes. */
  sayOnce(msg) { if (this.said !== msg) { this.said = msg; this.log(msg); } }

  load() {
    try {
      const s = JSON.parse(readFileSync(this.file, "utf8"));
      if (s && typeof s === "object" && SHAPES.claimToken.test(s.claim_token ?? "")) {
        return { claim_token: s.claim_token, claim_unanswered: s.claim_unanswered === true, held: s.held ?? null };
      }
    } catch { /* first start, or a state file that cannot be read: start clean */ }
    return { claim_token: null, claim_unanswered: false, held: null };
  }

  /** Written whole, synced, then renamed, so a crash never leaves half a token. */
  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
    const fd = openSync(tmp, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
  }

  unitState(unit) {
    try {
      return execFileSync(this.cfg.systemctl, ["show", "-p", "ActiveState", "--value", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown";
    } catch {
      return "unknown";
    }
  }

  pause() {
    const states = Object.fromEntries(DAILY_UNITS.map((u) => [u, this.unitState(u)]));
    let shadowRequest = null;
    try { shadowRequest = readFileSync(join(this.cfg.shadowState, "request.env"), "utf8"); } catch { /* none waiting */ }
    return pauseReason({ nowMs: this.cfg.now(), states, shadowRequest });
  }

  /**
   * One POST. Answers { ok, status, json, code } for any HTTP answer and { network }
   * when there was none. Branches on the status; reads `code` only when one is there,
   * since a 401, a 413 or malformed JSON come from the server with no code.
   */
  async post(name, body) {
    let res;
    try {
      res = await this.cfg.fetch(`${this.cfg.apiBase}/fn/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      return { network: String(e?.cause?.code ?? e?.name ?? e) };
    }
    let json = null;
    try { json = await res.json(); } catch { /* an answer with no JSON body */ }
    if (res.status === 401) throw new FatalConfig(`${name} answered 401: the worker secret is wrong, or not set on the platform`);
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json, code: typeof json?.code === "string" ? json.code : null };
  }

  /** Doubles from `base` up to five minutes; reset by the next success. */
  later(kind, base) {
    this.backoff[kind] = Math.min(this.backoff[kind] ? this.backoff[kind] * 2 : base, 300_000);
    this.next[kind] = this.cfg.now() + this.backoff[kind];
  }

  /** One pass of the loop: heartbeat when due, a claim when free, then the held request. */
  async step() {
    const now = this.cfg.now();
    if (now >= this.next.heartbeat) await this.heartbeat();
    if (!this.state.held) {
      // A claim sent just before the pause whose answer was lost may hold a request on
      // the platform. Retrying it with the same token is idempotent, so it goes on
      // through the pause; a request it turns out to hold waits for the pause to end,
      // on busy heartbeats. Without it the lease would lapse unseen during the window.
      const paused = this.pause();
      if (paused && !this.state.claim_unanswered) return this.sayOnce(`paused, not claiming: ${paused}`);
      if (now >= this.next.claim) await this.claim();
    }
    if (this.state.held) await this.tend();
  }

  async heartbeat() {
    this.next.heartbeat = this.cfg.now() + HEARTBEAT_SECONDS * 1000;
    const h = this.state.held;
    const base = { contract_version: CONTRACT_VERSION, worker_id: this.cfg.workerId };
    const body = h ? { ...base, state: "busy", request_id: h.id, claim_token: h.claim_token } : { ...base, state: this.pause() ? "paused_for_daily" : "idle" };
    const r = await this.post(ENDPOINTS.heartbeat, body);
    if (r.network || !r.ok) return this.sayOnce(`heartbeat not delivered (${r.network ?? `HTTP ${r.status}${r.code ? ` ${r.code}` : ""}`}); next in ${HEARTBEAT_SECONDS}s`);
    if (h && r.json?.lease === "lost" && !h.progress_lost) {
      h.progress_lost = true;
      this.save();
      this.log(`the lease on ${h.id} is lost (abandoned, or no longer this token's): no more progress reports; its result still goes once it exists`);
    }
  }

  async claim() {
    if (!this.state.claim_token || !this.state.claim_unanswered) {
      // Before the call: a lost answer is recovered with the same token, even by a
      // worker restarted in between, and even inside the daily's pause.
      this.state.claim_token ||= randomUUID();
      this.state.claim_unanswered = true;
      this.save();
    }
    const r = await this.post(ENDPOINTS.claim, { contract_version: CONTRACT_VERSION, worker_id: this.cfg.workerId, claim_token: this.state.claim_token });
    if (r.network || r.status >= 500) {
      this.later("claim", 30_000);
      return this.sayOnce(`claim not answered (${r.network ?? `HTTP ${r.status}`}); retrying with the same token`);
    }
    this.state.claim_unanswered = false;
    this.save();
    this.backoff.claim = 0;
    this.next.claim = this.cfg.now() + POLL_SECONDS * 1000;
    if (r.ok) {
      const req = r.json?.request ?? null;
      if (req === null) return this.sayOnce("idle: nothing queued");
      return this.take(req, "claimed");
    }
    if (r.status === 409 && r.code === "already_holding") return this.take(r.json?.held, "adopted (already_holding)");
    if (r.status === 409 && r.code === "claim_token_used") {
      this.state.claim_token = randomUUID();
      this.save();
      this.next.claim = 0;
      return this.log("claim_token_used: minted a new token");
    }
    // 400 and anything else: a bug on one side, which retrying will not fix soon.
    this.next.claim = this.cfg.now() + 600_000;
    this.log(`::error:: claim answered HTTP ${r.status}${r.code ? ` ${r.code}` : ""}: ${JSON.stringify(r.json)?.slice(0, 300)}; next claim in 10 minutes`);
  }

  /** Holds a request handed over by a claim, or by already_holding. */
  take(req, how) {
    const err = claimedRequestError(req);
    if (err && !(req && typeof req.id === "string" && SHAPES.id.test(req.id) && SHAPES.claimToken.test(req.claim_token ?? ""))) {
      // Nothing to answer it with: a result names its id, and a report its token. The
      // platform abandons it when the lease lapses.
      return this.log(`::error:: ${how} a request that cannot even be answered (${err}); left to lapse`);
    }
    // The executor would refuse it too; the refusal is written as its answer, BEFORE
    // the hold is saved, and forwarded like one, so the request ends with the reason
    // instead of lapsing. start() checks again, for a state file from elsewhere.
    if (err) this.refuse(req.id, err);
    this.state.claim_token = req.claim_token;
    this.state.held = {
      id: req.id, ref: req.ref, provider: req.provider, model: req.model, requested_by: req.requested_by,
      claim_token: req.claim_token, held_since: isoUtc(this.cfg.now()),
      reported: "claimed", progress_lost: false, starts: 0, last_start_ms: 0,
    };
    this.save();
    this.said = "";
    if (err) return this.log(`${how} ${req.id}, and refused it: ${err}`);
    this.log(`${how} ${req.id}: ref=${req.ref} provider=${req.provider || "<rotation>"} model=${req.model || "<default>"} by=${req.requested_by || "<unnamed>"}`);
  }

  /** results/<id>.env in the executor's format: the worker's own refusal. */
  refuse(id, err) {
    const res = join(this.cfg.state, "results", `${id}.env`);
    mkdirSync(join(this.cfg.state, "results"), { recursive: true });
    writeFileSync(`${res}.tmp`, refusalResult(id, `the worker refused the request before the executor saw it: ${err}`, this.cfg.now()));
    renameSync(`${res}.tmp`, res);
  }

  /** The held request: forward its result, report its progress, or start it. */
  async tend() {
    const h = this.state.held;
    const unit = this.unitState(EXECUTOR_UNIT);
    // An unreadable state counts as running: never start or forward on a guess.
    const running = unit === "unknown" || UNIT_RUNNING_STATES.includes(unit);
    const resultFile = join(this.cfg.state, "results", `${h.id}.env`);
    if (existsSync(resultFile)) {
      if (running) return this.sayOnce(`${h.id}: result on disk, waiting for ${EXECUTOR_UNIT} (${unit}) to finish its cleanup`);
      if (this.cfg.now() < this.next.report) return;
      const text = readFileSync(resultFile, "utf8");
      return this.deliver(text, { summary: this.summaryOf(parseResult(text)) });
    }
    if (running) return this.progress();

    const now = this.cfg.now();
    // A start was asked for and has not shown yet; then, a start that came to nothing
    // (the executor's lock held by a run by hand) is retried 1, 2, 4 ... 15 minutes apart.
    const wait = h.starts === 0 ? 0 : Math.min(60_000 * 2 ** (h.starts - 1), 900_000);
    if (now < h.last_start_ms + wait) return;
    if (h.progress_lost && !existsSync(join(this.cfg.state, "requests", `${h.id}.env`))) {
      // Abandoned before any run took it: whoever asked was told so, and starting it
      // now would spend half an hour on a request nobody waits for. A consumed one is
      // still started, because its start only writes the orphan's answer.
      this.log(`${h.id}: the lease was lost before a run took the request; released without starting it`);
      return this.release();
    }
    // Consumed, the request is still started past the hold limit: that start writes the
    // orphan's answer, which the platform takes over abandoned. Only a start tried past
    // the limit that came to nothing (the executor's lock held) lets it go.
    const deadline = Date.parse(h.held_since) + MAX_HOLD_SECONDS * 1000;
    if (h.progress_lost && now > deadline && h.last_start_ms > deadline) {
      this.log(`::error:: ${h.id}: lease lost, held past ${MAX_HOLD_SECONDS}s, and a start since then left no result; released`);
      return this.release();
    }
    const paused = this.pause();
    if (paused) return this.sayOnce(`${h.id}: not started, ${paused}; the busy heartbeat keeps the lease`);
    this.start();
  }

  /** Recovery and the first start alike: the contract's three cases. */
  start() {
    const h = this.state.held;
    const err = claimedRequestError(h);
    if (err) {
      this.refuse(h.id, err);
      return this.log(`${h.id}: refused before the slot: ${err}`);
    }
    const slot = join(this.cfg.state, "request.env");
    const consumed = join(this.cfg.state, "requests", `${h.id}.env`);
    let inSlot = null;
    try { inSlot = slotId(readFileSync(slot, "utf8")); } catch { /* empty slot */ }
    const slotTaken = existsSync(slot);
    if (slotTaken && inSlot !== h.id) {
      // Somebody wrote a request by hand. Starting the unit would answer theirs.
      return this.sayOnce(`${h.id}: the executor's slot holds another request (${inSlot ?? "unreadable"}); waiting for it to be served`);
    }
    let why;
    if (existsSync(consumed)) why = "consumed by a run that never answered it: the start's orphan pass answers it";
    else if (slotTaken) why = "still in the slot: starting again";
    else {
      mkdirSync(this.cfg.state, { recursive: true });
      // A link, not a rename: a request written by hand since the check above makes it
      // fail instead of being replaced.
      writeFileSync(`${slot}.tmp`, requestEnv(h));
      try {
        linkSync(`${slot}.tmp`, slot);
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        return this.sayOnce(`${h.id}: the executor's slot was written by somebody else just now; waiting for it to be served`);
      } finally {
        rmSync(`${slot}.tmp`, { force: true });
      }
      why = h.starts === 0 ? "written to the slot" : "neither in the slot nor consumed: written again";
    }
    try {
      execFileSync(this.cfg.systemctl, ["start", "--no-block", EXECUTOR_UNIT], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.log(`::error:: ${h.id}: systemctl start failed: ${String(e.stderr ?? e).trim().slice(0, 300)}`);
    }
    h.starts += 1;
    h.last_start_ms = this.cfg.now();
    this.save();
    this.said = "";
    this.log(`${h.id}: ${why}; started ${EXECUTOR_UNIT} (start ${h.starts})`);
  }

  /** building and running, from the executor's log, each at most once. */
  async progress() {
    const h = this.state.held;
    if (h.progress_lost || this.cfg.now() < this.next.report) return;
    let log;
    try { log = readFileSync(realpathSync(join(this.cfg.logDir, "latest.log")), "utf8"); } catch { return; }
    const p = readProgress(log, h.id);
    if (p === null) return this.sayOnce(`${h.id}: ${EXECUTOR_UNIT} is running another request's log; waiting`);
    const base = { contract_version: CONTRACT_VERSION, worker_id: this.cfg.workerId, id: h.id, claim_token: h.claim_token };
    let body = null;
    if (p.runId && RANK[h.reported] < RANK.running) {
      body = { ...base, at: stampToIso(p.runId) ?? isoUtc(this.cfg.now()), status: "running", run_id: p.runId };
      if (p.version) body.target_version = p.version;
      if (p.buildS !== null) body.build_s = p.buildS;
    } else if (p.building && RANK[h.reported] < RANK.building) {
      body = { ...base, at: isoUtc(this.cfg.now()), status: "building" };
    }
    if (!body) return;
    const r = await this.post(ENDPOINTS.report, body);
    if (r.network || r.status >= 500) return this.later("report", 10_000);
    this.backoff.report = 0;
    if (r.ok) {
      h.reported = body.status;
      this.save();
      return this.log(`${h.id}: reported ${body.status}${body.run_id ? ` (run ${body.run_id})` : ""}: ${r.json?.outcome}`);
    }
    // 409 (not held), 404 or 400: progress is no longer this worker's to report. The
    // result still goes once it exists.
    h.progress_lost = true;
    this.save();
    this.log(`${h.id}: ${body.status} answered HTTP ${r.status}${r.code ? ` ${r.code}` : ""}; no more progress reports, the result still goes`);
  }

  /**
   * The suite summary of a result's run: $STATE/runs/<RUN_ID>/results.json, counted.
   * null when the result names no run (a refusal, a failed build, an orphan's
   * answer), the run left no results.json, or it does not parse.
   */
  summaryOf(result) {
    const runId = result.RUN_ID ?? "";
    if (!/^\d{8}T\d{6}Z$/.test(runId)) return null;
    // The suite runs in $STATE/wt (run-on-demand.sh), not in this checkout.
    return summaryFromFile(join(this.cfg.state, "runs", runId, "results.json"), { root: join(this.cfg.state, "wt") });
  }

  async deliver(text, { summary = null } = {}) {
    const h = this.state.held;
    const result = parseResult(text);
    const body = terminalBody({ workerId: this.cfg.workerId, held: h, result, summary, nowMs: this.cfg.now() });
    const r = await this.post(ENDPOINTS.report, body);
    if (r.network || r.status >= 500) {
      this.later("report", 10_000);
      return this.sayOnce(`${h.id}: result not delivered (${r.network ?? `HTTP ${r.status}`}); retrying`);
    }
    this.backoff.report = 0;
    if (r.ok) {
      const s = r.json?.summary;
      this.log(`${h.id}: result delivered, ${result.STATUS}${result.VERDICT ? `/${result.VERDICT}` : ""}: ${r.json?.outcome}${s ? `, summary ${s}${r.json?.summary_error ? ` (${r.json.summary_error})` : ""}` : ""}`);
      return this.release();
    }
    if (r.status === 413 && body.summary !== null) return this.deliver(text, { summary: null });
    if (r.status === 409 && r.code === "already_terminal") {
      this.log(`${h.id}: already answered on the platform; the first answer stands`);
      return this.release();
    }
    // 400 (the result does not fit the contract), 404, a 409 not_held, a 413 with no
    // summary: nothing this worker can resend. The result stays on disk.
    this.log(`::error:: ${h.id}: the result was refused, HTTP ${r.status}${r.code ? ` ${r.code}` : ""}: ${JSON.stringify(r.json)?.slice(0, 500)}; it stays at results/${h.id}.env; released`);
    return this.release();
  }

  /**
   * Done with the held request: a fresh token for the next claim. Its request goes
   * from the slot if it is still there (never taken, or taken by an executor killed
   * before the move): left behind, it would block every later start as "another
   * request" for good.
   */
  release() {
    const slot = join(this.cfg.state, "request.env");
    const aside = `${slot}.release`;
    try {
      // Moved aside and read again before it is removed, so what goes is what was read:
      // a request written by hand in between is put back, never deleted.
      if (slotId(readFileSync(slot, "utf8")) === this.state.held.id) {
        renameSync(slot, aside);
        if (slotId(readFileSync(aside, "utf8")) === this.state.held.id) {
          rmSync(aside);
          this.log(`${this.state.held.id}: removed from the executor's slot`);
        } else {
          try {
            linkSync(aside, slot);
            rmSync(aside);
          } catch (e) {
            this.log(`::error:: ${this.state.held.id}: a request taken from the slot by mistake could not go back (${e.code}); it is kept at ${aside}`);
          }
        }
      }
    } catch { /* empty slot, or the executor took it first */ }
    this.state.held = null;
    this.state.claim_token = randomUUID();
    this.save();
    this.said = "";
    this.next.claim = 0;
  }
}

// --- the service --------------------------------------------------------------------

export function configFromEnv(env) {
  const missing = ["QA_ON_DEMAND_API_BASE", "QA_ON_DEMAND_WORKER_TOKEN"].filter((k) => !env[k]);
  if (missing.length) throw new FatalConfig(`${missing.join(" and ")} not set (the unit's EnvironmentFile)`);
  const apiBase = env.QA_ON_DEMAND_API_BASE.replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/.test(apiBase) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiBase)) {
    throw new FatalConfig(`QA_ON_DEMAND_API_BASE must be https://<host>, got ${JSON.stringify(apiBase)}`);
  }
  const workerId = env.QA_ON_DEMAND_WORKER_ID || "qa";
  if (!SHAPES.workerId.test(workerId)) throw new FatalConfig(`QA_ON_DEMAND_WORKER_ID does not fit ${SHAPES.workerId}`);
  return {
    apiBase,
    token: env.QA_ON_DEMAND_WORKER_TOKEN,
    workerId,
    state: env.E2E_ONDEMAND_STATE || "/root/e2e-on-demand",
    logDir: env.E2E_ONDEMAND_LOG_DIR || "/var/log/e2e-on-demand",
    shadowState: env.E2E_SHADOW_STATE || "/root/e2e-shadow",
  };
}

async function main() {
  let worker;
  try {
    worker = new Worker(configFromEnv(process.env));
  } catch (e) {
    console.error(`on-demand-worker: ::error:: ${e.message}`);
    process.exit(e instanceof FatalConfig ? EXIT_CONFIG : 1);
  }
  let stopping = false;
  let wake = () => {};
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopping = true; wake(); });
  const tickMs = Number(process.env.E2E_ONDEMAND_WORKER_TICK_MS) || 10_000;
  const h = worker.state.held;
  worker.log(`started as ${worker.cfg.workerId} against ${worker.cfg.apiBase}${h ? `, holding ${h.id} (${h.reported})` : ""}`);
  while (!stopping) {
    try {
      await worker.step();
    } catch (e) {
      if (e instanceof FatalConfig) {
        console.error(`on-demand-worker: ::error:: ${e.message}; stopping`);
        process.exit(EXIT_CONFIG);
      }
      worker.log(`::error:: ${e?.stack ?? e}`);
    }
    await new Promise((r) => { wake = r; setTimeout(r, tickMs); });
  }
  worker.log("stopped");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) main();
