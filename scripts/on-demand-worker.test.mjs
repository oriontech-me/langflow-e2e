// Unit tests for ops/vm/on-demand-worker.mjs, which e2e-on-demand-worker.service runs.
// Run with: npm run test:scripts
//
// The worker is driven against the REAL executor (ops/vm/run-on-demand.sh on the fake
// machine its own tests use, behind a systemctl stub that runs it the way the unit
// does) and a fake platform that keeps the queue contract's rules: one held request,
// the same token answering the same request, a terminal result taken once. What the
// platform's schemas would refuse is checked against the real API by hand (see the PR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, symlinkSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { ROOT, ONDEMAND, setup, q, kv } from "./lib/on-demand-machine.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";
import {
  Worker, FatalConfig, pauseReason, claimedRequestError, requestEnv, parseResult, readProgress,
  terminalBody, stampToIso, configFromEnv, REPORT_MAX_BYTES, UNIT_RUNNING_STATES,
} from "../ops/vm/on-demand-worker.mjs";

const WORKER = join(ROOT, "ops", "vm", "on-demand-worker.mjs");
// Wednesday 2026-09-30 15:00 UTC: outside the daily's window.
const WED_1500 = Date.UTC(2026, 8, 30, 15, 0, 0);
const at = (dow, hh, mm) => Date.UTC(2026, 8, 27 + dow, hh, mm); // 2026-09-27 is a Sunday
const TOKEN = "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ = (over = {}) => ({ id: "od-20260930-1a2b3c4d", ref: "release-1.13.0", provider: "anthropic", model: "", requested_by: "victor@oriontech.me", ...over });

// ---------------------------------------------------------------------------
// A fake platform: the contract's rules, in memory
// ---------------------------------------------------------------------------

const RANK = { queued: 0, claimed: 1, building: 2, running: 3, done: 4, failed: 4, build_failed: 4, refused: 4, abandoned: 4 };
function reportOutcome(current, reported) {
  if (current === "queued") return "not_held";
  if (current === "abandoned") return RANK[reported] === 4 ? "applied" : "not_held";
  if (current === reported) return "duplicate";
  if (RANK[current] === 4) return RANK[reported] === 4 ? "conflict" : "stale";
  return RANK[reported] > RANK[current] ? "applied" : "stale";
}

// ExecutorResult's rules (contract.ts), the ones a result from the executor could break.
const RESULT_KEYS = ["ONDEMAND_ID", "STATUS", "VERDICT", "REASON", "EXIT", "RUN_ID", "TARGET_REF", "TARGET_SHA", "TARGET_VERSION", "BUILD_S", "SUITE_SHA", "PROVIDER", "MODEL", "REQUESTED_BY", "CLEANUP", "STARTED", "FINISHED", "LOG"];
const EXPECTED_EXIT = { "done/green": "0", "done/red": "1", "refused/": "2", "failed/": "3", "build_failed/": "4" };
function resultError(r) {
  const unknown = Object.keys(r).filter((k) => !RESULT_KEYS.includes(k));
  if (unknown.length) return `unknown keys ${unknown}`;
  for (const k of ["ONDEMAND_ID", "STATUS", "VERDICT", "REASON", "EXIT", "CLEANUP", "FINISHED"]) if (typeof r[k] !== "string") return `${k} missing`;
  if (Object.values(r).some((v) => typeof v !== "string")) return "a value is not a string";
  if ((r.STATUS === "done") !== (r.VERDICT !== "")) return "VERDICT is green or red exactly when STATUS is done";
  if (EXPECTED_EXIT[`${r.STATUS}/${r.VERDICT}`] !== r.EXIT) return `EXIT ${r.EXIT} for ${r.STATUS}/${r.VERDICT}`;
  if (!["ok", "pending", "incomplete", "unconfirmed", "by the next run"].includes(r.CLEANUP)) return "CLEANUP";
  if (!/^\d{8}T\d{6}Z$/.test(r.FINISHED)) return "FINISHED";
  return null;
}

async function fakePlatform() {
  const requests = [];
  const calls = [];
  const overrides = { claim: [], report: [], heartbeat: [] };
  const refuse = (status, code, extra = {}) => ({ status, json: { success: false, code, error: code, ...extra } });
  // The platform's ClaimedRequest: suite_ref always present, '' for the daily's suite.
  const view = (r) => ({ id: r.id, ref: r.ref, provider: r.provider, model: r.model, suite_ref: r.suite_ref ?? "", requested_by: r.requested_by, claim_token: r.claim_token, created_at: "2026-09-30T14:59:00Z", lease_expires_at: "2026-09-30T15:15:00Z" });
  const handle = {
    claim(b) {
      const mine = requests.find((r) => r.claim_token === b.claim_token);
      if (mine) return RANK[mine.status] === 4 ? refuse(409, "claim_token_used") : { status: 200, json: { request: view(mine) } };
      const held = requests.find((r) => [1, 2, 3].includes(RANK[r.status]));
      if (held) return refuse(409, "already_holding", { held: view(held) });
      const next = requests.find((r) => r.status === "queued");
      if (!next) return { status: 200, json: { request: null } };
      Object.assign(next, { status: "claimed", claim_token: b.claim_token });
      return { status: 200, json: { request: view(next) } };
    },
    report(b) {
      if (b.result) {
        const bad = resultError(b.result);
        if (bad) return refuse(400, "invalid_body", { error: `result: ${bad}` });
        if (b.result.STATUS !== b.status || b.result.ONDEMAND_ID !== b.id) return refuse(400, "invalid_body");
      }
      const r = requests.find((x) => x.id === b.id);
      if (!r) return refuse(404, "unknown_request");
      if (r.claim_token !== b.claim_token) return refuse(409, "not_held");
      const o = reportOutcome(r.status, b.status);
      if (o === "not_held") return refuse(409, "not_held");
      if (o === "conflict") return refuse(409, "already_terminal");
      if (o === "applied") { r.status = b.status; if (b.result) r.result = b.result; }
      return { status: 200, json: { outcome: o, status: r.status, lease_expires_at: RANK[r.status] === 4 ? null : "2026-09-30T15:15:00Z", summary: b.result ? (b.summary === null ? "absent" : "accepted") : null, summary_error: null } };
    },
    heartbeat(b) {
      const r = b.state === "busy" ? requests.find((x) => x.id === b.request_id) : null;
      const lease = b.state !== "busy" ? null : r && [1, 2, 3].includes(RANK[r.status]) && r.claim_token === b.claim_token ? "renewed" : "lost";
      return { status: 200, json: { ok: true, lease, lease_expires_at: lease === "renewed" ? "2026-09-30T15:15:00Z" : null } };
    },
  };
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const name = { "on-demand-worker-claim": "claim", "on-demand-worker-report": "report", "on-demand-worker-heartbeat": "heartbeat" }[req.url.replace(/^\/fn\//, "")];
      const body = JSON.parse(data);
      calls.push({ name, body, auth: req.headers.authorization });
      let answer;
      const o = overrides[name]?.shift();
      if (o === "drop") {
        // The platform did the work and the answer was lost (the VPN).
        handle[name](body);
        return req.socket.destroy();
      }
      if (o) answer = typeof o === "function" ? o(body) : o;
      else if (req.headers.authorization !== "Bearer worker-secret") answer = { status: 401, json: { error: "Unauthorized" } };
      else answer = handle[name](body);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests, calls, overrides,
    enqueue: (r) => requests.push({ ...r, status: "queued", claim_token: null }),
    of: (name) => calls.filter((c) => c.name === name).map((c) => c.body),
    close: () => new Promise((r) => server.close(r)),
  };
}

// ---------------------------------------------------------------------------
// The machine: the executor's fake one, with a systemctl that runs the unit
// ---------------------------------------------------------------------------

/**
 * The executor's fake machine, with systemctl replaced: `show` reads each unit's state
 * from a file (inactive when there is none), and `start` of the executor unit runs the
 * real run-on-demand.sh in the background, activating while it runs, inactive or
 * failed by its exit status -- the oneshot's states. With `run: false` a start is only
 * recorded.
 */
function machine({ run = true, ...opts } = {}) {
  const { env, collect } = setup({ request: null, ...opts });
  const dir = join(env.E2E_ONDEMAND_STATE, "..");
  const units = join(dir, "units");
  mkdirSync(units, { recursive: true });
  const starts = join(dir, "starts.log");
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`).join("\n");
  writeFileSync(join(env.HOME, ".local", "bin", "systemctl"), `#!/usr/bin/env bash
${exports}
case "$1" in
  show) unit="\${@: -1}"; cat ${q(units)}/"$unit" 2>/dev/null || echo inactive ;;
  start)
    echo "$*" >> ${q(starts)}
    ${run ? `echo activating > ${q(units)}/e2e-on-demand.service
    ( bash ${q(ONDEMAND)}; rc=$?; [ $rc = 0 ] && s=inactive || s=failed; echo $s > ${q(units)}/e2e-on-demand.service ) </dev/null >/dev/null 2>&1 &` : ":"}
    ;;
esac
exit 0
`, { mode: 0o755 });
  return {
    env, collect, dir,
    systemctl: join(env.HOME, ".local", "bin", "systemctl"),
    setUnit: (unit, state) => writeFileSync(join(units, unit), `${state}\n`),
    starts: () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").filter(Boolean) : []),
    unit: (u = "e2e-on-demand.service") => (existsSync(join(units, u)) ? readFileSync(join(units, u), "utf8").trim() : "inactive"),
  };
}

function worker(m, platform, { clock = null, token = "worker-secret" } = {}) {
  const t0 = Date.now();
  const lines = [];
  const w = new Worker({
    apiBase: platform.base, token, workerId: "qa",
    state: m.env.E2E_ONDEMAND_STATE, logDir: m.env.E2E_ONDEMAND_LOG_DIR, shadowState: m.env.E2E_SHADOW_STATE,
    systemctl: m.systemctl,
    now: clock ?? (() => WED_1500 + (Date.now() - t0)),
    log: (l) => lines.push(l),
  });
  w.lines = lines;
  return w;
}

async function until(w, cond, what, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await w.step();
    if (cond()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}:\n${w.lines.join("\n")}`);
}

// ---------------------------------------------------------------------------
// The happy path, against the real executor
// ---------------------------------------------------------------------------

test("a queued request is claimed, run by the executor, and its result forwarded verbatim", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ runSleep: 2 });
    p.enqueue(REQ());
    const w = worker(m, p);
    await until(w, () => p.requests[0].status === "done", "the terminal report");
    const r = m.collect(0);
    const onDisk = readFileSync(join(r.state, "results", `${REQ().id}.env`), "utf8");
    const terminal = p.of("report").find((b) => b.result);
    // Verbatim: every key and value of the file, nothing renamed, dropped or added.
    assert.deepEqual(terminal.result, kv(onDisk));
    assert.equal(terminal.result.VERDICT, "green");
    assert.equal(terminal.status, "done");
    assert.equal(terminal.claim_token, p.requests[0].claim_token);
    assert.equal(terminal.at, stampToIso(terminal.result.FINISHED));
    // The fake run leaves an empty results.json: a summary of nothing, counted.
    assert.deepEqual(terminal.summary, {
      totals: { passed: 0, failed: 0, flaky: 0, skipped: 0 }, duration_ms: 0, failures_by_spec: [], tests_by_spec: [],
    });
    // The executor ran the request as the platform handed it over.
    assert.equal(terminal.result.TARGET_REF, "release-1.13.0");
    assert.equal(terminal.result.PROVIDER, "anthropic");
    assert.equal(terminal.result.REQUESTED_BY, "victor@oriontech.me");
    // Progress, from the executor's own log: running carries the run id and the build's numbers.
    const running = p.of("report").find((b) => b.status === "running");
    assert.ok(running, `no running report:\n${w.lines.join("\n")}`);
    assert.equal(running.run_id, terminal.result.RUN_ID);
    assert.equal(running.target_version, "1.13.0");
    assert.equal(running.build_s, 300);
    assert.equal(running.target_sha, undefined, "the log has 12 characters of the SHA; running must not invent the rest");
    // Released, with a fresh token for the next claim.
    const s = JSON.parse(readFileSync(join(r.state, "worker", "state.json"), "utf8"));
    assert.equal(s.held, null);
    assert.notEqual(s.claim_token, terminal.claim_token);
    assert.equal(m.starts().length, 1);
    // Every call carried the contract version, the worker id and the secret.
    for (const c of p.calls) {
      assert.equal(c.body.contract_version, 1);
      assert.equal(c.body.worker_id, "qa");
      assert.equal(c.auth, "Bearer worker-secret");
    }
  } finally {
    await p.close();
  }
});

test("a red result and a refusal go as the executor wrote them, '' and all", async () => {
  for (const [opts, status, verdict] of [[{ runExit: 1 }, "done", "red"], [{ buildExit: 2, buildOut: "" }, "refused", ""]]) {
    const p = await fakePlatform();
    try {
      const m = machine(opts);
      p.enqueue(REQ());
      const w = worker(m, p);
      await until(w, () => p.requests[0].status === status, `${status}`);
      const terminal = p.of("report").find((b) => b.result);
      assert.equal(terminal.result.VERDICT, verdict);
      assert.equal(typeof terminal.result.EXIT, "string");
      // A red run ends the oneshot `failed`, not `inactive`: still forwarded.
      assert.equal(m.unit(), "failed");
    } finally {
      await p.close();
    }
  }
});

// ---------------------------------------------------------------------------
// When the result goes
// ---------------------------------------------------------------------------

test("a result on disk is not forwarded while the unit is in any running state", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    const w = worker(m, p);
    await w.step();
    assert.ok(p.requests[0].claim_token, "not claimed");
    mkdirSync(join(m.env.E2E_ONDEMAND_STATE, "results"), { recursive: true });
    writeFileSync(join(m.env.E2E_ONDEMAND_STATE, "results", `${REQ().id}.env`), `ONDEMAND_ID=${REQ().id}\nSTATUS=failed\nVERDICT=\nREASON=x\nEXIT=3\nCLEANUP=pending\nFINISHED=20260930T150500Z\n`);
    for (const st of [...UNIT_RUNNING_STATES, "unknown"]) {
      m.setUnit("e2e-on-demand.service", st);
      await w.step();
      assert.equal(p.of("report").filter((b) => b.result).length, 0, `forwarded while ${st}`);
    }
    m.setUnit("e2e-on-demand.service", "failed");
    await w.step();
    assert.equal(p.requests[0].status, "failed");
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// The claim token
// ---------------------------------------------------------------------------

test("the claim token is on disk before the claim, and a lost answer costs nothing", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    p.overrides.claim.push("drop");
    const w = worker(m, p);
    await w.step();
    // The platform claimed it; the worker never heard. The token it sent is on disk.
    const sent = p.of("claim")[0].claim_token;
    assert.equal(p.requests[0].claim_token, sent);
    assert.equal(JSON.parse(readFileSync(join(m.env.E2E_ONDEMAND_STATE, "worker", "state.json"), "utf8")).claim_token, sent);
    assert.equal(w.state.held, null);
    // The retry, by a NEW worker process on the same state, gets the same request back.
    const w2 = worker(m, p);
    w2.next.claim = 0;
    await w2.step();
    assert.equal(p.of("claim")[1].claim_token, sent);
    assert.equal(w2.state.held?.id, REQ().id);
    assert.equal(kv(readFileSync(join(m.env.E2E_ONDEMAND_STATE, "request.env"), "utf8")).ONDEMAND_ID, REQ().id);
  } finally {
    await p.close();
  }
});

test("already_holding is adopted with its token, and claim_token_used mints a new one", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    p.requests[0].status = "running";
    p.requests[0].claim_token = TOKEN; // held by a token this worker lost
    const w = worker(m, p);
    await w.step();
    assert.equal(w.state.held?.id, REQ().id);
    assert.equal(w.state.held.claim_token, TOKEN);
    assert.equal(w.state.claim_token, TOKEN);
    // Adopted, it heartbeats as the holder.
    w.next.heartbeat = 0;
    await w.step();
    assert.deepEqual(p.of("heartbeat").at(-1), { contract_version: 1, worker_id: "qa", state: "busy", request_id: REQ().id, claim_token: TOKEN });

    const p2 = await fakePlatform();
    try {
      const m2 = machine({ run: false });
      p2.enqueue({ ...REQ(), id: "od-20260930-00000001" });
      p2.requests[0].status = "done";
      p2.requests[0].claim_token = TOKEN;
      mkdirSync(join(m2.env.E2E_ONDEMAND_STATE, "worker"), { recursive: true });
      writeFileSync(join(m2.env.E2E_ONDEMAND_STATE, "worker", "state.json"), JSON.stringify({ claim_token: TOKEN, held: null }));
      p2.enqueue(REQ());
      const w2 = worker(m2, p2);
      await w2.step();
      assert.notEqual(w2.state.claim_token, TOKEN);
      await w2.step();
      assert.equal(w2.state.held?.id, REQ().id, "the new token did not claim");
    } finally {
      await p2.close();
    }
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// The daily has priority
// ---------------------------------------------------------------------------

test("the pause follows the executor's refusals, five minutes early", () => {
  const idle = { "e2e-daily.service": "inactive", "e2e-shadow.service": "inactive" };
  const pause = (nowMs, states = idle, shadowRequest = null) => pauseReason({ nowMs, states, shadowRequest });
  assert.equal(pause(at(3, 7, 24)), null);
  assert.match(pause(at(3, 7, 25)), /window/);
  assert.match(pause(at(1, 8, 39)), /window/);
  assert.equal(pause(at(5, 8, 40)), null);
  assert.equal(pause(at(6, 8, 0)), null, "Saturday has no daily");
  assert.equal(pause(at(0, 8, 0)), null, "Sunday has no daily");
  // Any hour, while the daily or the shadow runs: the oneshot's states, not is-active.
  for (const st of UNIT_RUNNING_STATES) {
    assert.match(pause(at(3, 15, 0), { ...idle, "e2e-daily.service": st }), /e2e-daily\.service/);
    assert.match(pause(at(3, 15, 0), { ...idle, "e2e-shadow.service": st }), /e2e-shadow\.service/);
  }
  assert.equal(pause(at(3, 15, 0), { ...idle, "e2e-daily.service": "failed" }), null, "a failed daily is not running");
  assert.match(pause(at(3, 15, 0), { ...idle, "e2e-daily.service": "unknown" }), /unknown/, "an unreadable state is not proof the daily is idle");
  // Today's shadow request; a stale one does not hold the lane.
  assert.match(pause(at(3, 15, 0), idle, "SHADOW_DATE=2026-09-30\nSHADOW_VERSION=1\n"), /shadow request/);
  assert.equal(pause(at(3, 15, 0), idle, "SHADOW_DATE=2026-09-29\n"), null);
});

test("paused, the worker heartbeats paused_for_daily and does not claim; holding, it stays busy", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    m.setUnit("e2e-daily.service", "activating");
    const w = worker(m, p);
    await w.step();
    assert.equal(p.of("claim").length, 0);
    assert.equal(p.of("heartbeat")[0].state, "paused_for_daily");
    // Inside the window by the clock alone, too.
    m.setUnit("e2e-daily.service", "inactive");
    const inWindow = worker(m, p, { clock: () => at(3, 7, 26) });
    await inWindow.step();
    assert.equal(p.of("claim").length, 0);

    // Holding a request whose run must be started again: busy, and no start until the daily is gone.
    const w2 = worker(m, p);
    await w2.step();
    assert.equal(m.starts().length, 1);
    m.setUnit("e2e-on-demand.service", "failed"); // the start came to nothing
    m.setUnit("e2e-daily.service", "activating");
    let t = WED_1500 + 10 * 60_000;
    const later = worker(m, p, { clock: () => t });
    await later.step();
    assert.equal(p.of("heartbeat").at(-1).state, "busy");
    assert.equal(m.starts().length, 1, "a recovery started beside the daily");
    m.setUnit("e2e-daily.service", "inactive");
    t += 1000;
    await later.step();
    assert.equal(m.starts().length, 2);
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// Recovery: held, the unit not running, no result
// ---------------------------------------------------------------------------

test("a request a killed run consumed is answered by a start with an empty slot", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ orphans: [[REQ().id, false]] });
    p.enqueue(REQ());
    p.requests[0].status = "running";
    p.requests[0].claim_token = TOKEN;
    mkdirSync(join(m.env.E2E_ONDEMAND_STATE, "worker"), { recursive: true });
    writeFileSync(join(m.env.E2E_ONDEMAND_STATE, "worker", "state.json"), JSON.stringify({ claim_token: TOKEN, held: { ...REQ(), claim_token: TOKEN, held_since: "2026-09-30T14:30:00Z", reported: "running", progress_lost: false, starts: 1, last_start_ms: 0 } }));
    const w = worker(m, p);
    await until(w, () => p.requests[0].status === "failed", "the orphan's answer");
    // Written again, the executor would refuse it as already answered and keep it as a
    // second unparsed copy: the answer is the same, the slot write is the defect.
    assert.deepEqual(m.collect(2).requests.sort(), [`${REQ().id}.env`, "unparsed-20260101T000000Z-1.env"], "the slot was written for a consumed request");
    assert.match(p.requests[0].result.REASON, /^interrupted/);
    assert.equal(p.requests[0].result.CLEANUP, "by the next run");
  } finally {
    await p.close();
  }
});

test("a claimed suite ref reaches the slot, through the worker's own state", async () => {
  // The slot is written from the state the claim was saved into, not from the claim:
  // a field the state leaves out is lost on the way, silently (the canary, 2026-10-09).
  // Through a restart too: the slot is rewritten from the state file alone.
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ({ suite_ref: "test/on-demand-suite-ref-canary" }));
    const w = worker(m, p, { clock: () => WED_1500 });
    await w.step();
    const slot = join(m.env.E2E_ONDEMAND_STATE, "request.env");
    assert.match(readFileSync(slot, "utf8"), /^ONDEMAND_SUITE_REF=test\/on-demand-suite-ref-canary$/m);
    const saved = JSON.parse(readFileSync(join(m.env.E2E_ONDEMAND_STATE, "worker", "state.json"), "utf8"));
    assert.equal(saved.held.suite_ref, "test/on-demand-suite-ref-canary", "the state file lost the suite ref");
  } finally {
    await p.close();
  }
});

test("a request still in the slot is started again, with backoff; one in nobody's hands is written again", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    let t = WED_1500;
    const w = worker(m, p, { clock: () => t });
    await w.step();
    assert.equal(m.starts().length, 1);
    const slot = join(m.env.E2E_ONDEMAND_STATE, "request.env");
    assert.equal(readFileSync(slot, "utf8"), requestEnv({ ...REQ(), claim_token: TOKEN }));
    // The executor's lock refused it (a run by hand): the unit ended, the request stayed.
    m.setUnit("e2e-on-demand.service", "failed");
    t += 30_000;
    await w.step();
    assert.equal(m.starts().length, 1, "started again before the first start had a minute");
    t += 31_000;
    await w.step();
    assert.equal(m.starts().length, 2);
    t += 61_000;
    await w.step();
    assert.equal(m.starts().length, 2, "the second retry did not wait twice as long");
    t += 60_000;
    await w.step();
    assert.equal(m.starts().length, 3);
    // Gone from the slot and never consumed (a crash between claim and write): written again.
    rmSync(slot);
    t += 5 * 60_000;
    await w.step();
    assert.equal(m.starts().length, 4);
    assert.equal(kv(readFileSync(slot, "utf8")).ONDEMAND_ID, REQ().id);
  } finally {
    await p.close();
  }
});

test("a slot holding somebody else's request is never started over", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    writeFileSync(join(m.env.E2E_ONDEMAND_STATE, "request.env"), "ONDEMAND_ID=hand-1\nONDEMAND_REF=release-1.13.0\n");
    p.enqueue(REQ());
    const w = worker(m, p);
    await w.step();
    await w.step();
    assert.equal(w.state.held?.id, REQ().id);
    assert.equal(m.starts().length, 0);
    assert.equal(kv(readFileSync(join(m.env.E2E_ONDEMAND_STATE, "request.env"), "utf8")).ONDEMAND_ID, "hand-1");
  } finally {
    await p.close();
  }
});

test("a slot written by somebody else between the check and the write is not replaced", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    // A dangling link reads as an empty slot to the check and as taken to the write:
    // the same two answers a request written by hand in between gives.
    const slot = join(m.env.E2E_ONDEMAND_STATE, "request.env");
    symlinkSync("hand-written-later.env", slot);
    p.enqueue(REQ());
    const w = worker(m, p);
    await w.step();
    await w.step();
    assert.equal(w.state.held?.id, REQ().id);
    assert.equal(m.starts().length, 0, "the unit was started over somebody else's slot");
    assert.equal(readlinkSync(slot), "hand-written-later.env", "the slot was replaced");
    assert.equal(existsSync(`${slot}.tmp`), false);
  } finally {
    await p.close();
  }
});

test("a worker restarted mid-run neither starts the unit again nor reports the same step twice", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ runSleep: 3 });
    p.enqueue(REQ());
    const w = worker(m, p);
    await until(w, () => p.of("report").some((b) => b.status === "running"), "running");
    const w2 = worker(m, p);
    await until(w2, () => p.requests[0].status === "done", "done");
    assert.equal(m.starts().length, 1);
    assert.equal(p.of("report").filter((b) => b.status === "running").length, 1);
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// The platform's answers
// ---------------------------------------------------------------------------

test("a 401 stops the worker, and nothing else does", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    const w = worker(m, p, { token: "wrong" });
    await assert.rejects(w.step(), FatalConfig);
    // A 5xx and a dropped connection are retried, not fatal.
    const ok = worker(m, p);
    p.overrides.heartbeat.push({ status: 503, json: {} });
    p.overrides.claim.push({ status: 502, json: {} });
    await ok.step();
    assert.ok(ok.next.claim > ok.cfg.now(), "no backoff after a 502");
  } finally {
    await p.close();
  }
});

test("a lost lease stops the progress reports, and the result still goes", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ runSleep: 2 });
    p.enqueue(REQ());
    const w = worker(m, p);
    await w.step();
    p.requests[0].status = "abandoned"; // the sweep, behind a VPN outage
    w.next.heartbeat = 0;
    await w.step();
    assert.equal(w.state.held.progress_lost, true);
    await until(w, () => p.requests[0].status === "done", "the result over abandoned");
    assert.deepEqual(p.of("report").filter((b) => !b.result), [], "progress was reported on an abandoned request");
  } finally {
    await p.close();
  }
});

test("a terminal 5xx is retried; already_terminal and a refused result release the request", async () => {
  const resultText = `ONDEMAND_ID=${REQ().id}\nSTATUS=failed\nVERDICT=\nREASON=x\nEXIT=3\nCLEANUP=ok\nFINISHED=20260930T150500Z\n`;
  for (const [answer, released] of [[{ status: 503, json: {} }, false], [{ status: 409, json: { success: false, code: "already_terminal", error: "" } }, true], [{ status: 400, json: { success: false, code: "invalid_body", error: "result.EXIT" } }, true]]) {
    const p = await fakePlatform();
    try {
      const m = machine({ run: false });
      p.enqueue(REQ());
      const w = worker(m, p);
      await w.step();
      writeFileSync(join(m.env.E2E_ONDEMAND_STATE, "results", `${REQ().id}.env`), resultText);
      m.setUnit("e2e-on-demand.service", "failed");
      p.overrides.report.push(answer);
      await w.step();
      assert.equal(w.state.held === null, released, `HTTP ${answer.status}: ${w.lines.join("\n")}`);
      if (!released) {
        w.next.report = 0;
        await w.step();
        assert.equal(p.requests[0].status, "failed", "the retry did not deliver");
      }
    } finally {
      await p.close();
    }
  }
});

test("a 413 resends the result with summary null", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    const w = worker(m, p);
    await w.step();
    p.overrides.report.push({ status: 413, json: { error: "Payload Too Large", statusCode: 413 } });
    await w.deliver(`ONDEMAND_ID=${REQ().id}\nSTATUS=refused\nVERDICT=\nREASON=x\nEXIT=2\nCLEANUP=ok\nFINISHED=20260930T150500Z\n`, { summary: { totals: { passed: 1, failed: 0, flaky: 0, skipped: 0 }, duration_ms: 1, failures_by_spec: [] } });
    const sent = p.of("report");
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0].summary, null);
    assert.equal(sent[1].summary, null);
    assert.equal(p.requests[0].status, "refused");
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// The request is data
// ---------------------------------------------------------------------------

test("the request.env the worker writes is one the executor parses back to the same fields", () => {
  const dir = makeTempDir("od-worker-");
  const fn = readFileSync(ONDEMAND, "utf8").match(/^ondemand_parse_request\(\) \{[\s\S]*?^\}$/m)[0];
  writeFileSync(join(dir, "parse.sh"), `${fn}\nondemand_parse_request "$(cat "$1")" || { echo "ERR=$OD_PARSE_ERR"; exit 1; }\nprintf 'id=%s\\nref=%s\\nprovider=%s\\nmodel=%s\\nby=%s\\nsuite=%s\\n' "$OD_ID" "$OD_REF" "$OD_PROVIDER" "$OD_MODEL" "$OD_BY" "$OD_SUITE_REF"\n`);
  // A platform from before the suite ref sends none: the line is written empty.
  for (const req of [REQ(), REQ({ provider: "", requested_by: "" }), REQ({ provider: "openai", model: "gpt-4o-mini", ref: "feat/x_y.z" }), REQ({ suite_ref: "fix/issue-2230-x" }), REQ({ suite_ref: "" })]) {
    writeFileSync(join(dir, "request.env"), requestEnv(req));
    const r = spawnSync("bash", [join(dir, "parse.sh"), join(dir, "request.env")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout);
    assert.deepEqual(kv(r.stdout), { id: req.id, ref: req.ref, provider: req.provider, model: req.model, by: req.requested_by, suite: req.suite_ref ?? "" });
  }
});

test("the worker and the executor agree on every suite ref: what one takes, the other takes", () => {
  // A ref the worker passes and the executor refuses would cost a claim; one the
  // executor would take and the worker refuses would refuse a good request.
  const dir = makeTempDir("od-worker-");
  const fn = readFileSync(ONDEMAND, "utf8").match(/^ondemand_parse_request\(\) \{[\s\S]*?^\}$/m)[0];
  writeFileSync(join(dir, "parse.sh"), `${fn}\nondemand_parse_request "$(cat "$1")" && echo ok || echo no\n`);
  for (const ref of ["", "main", "fix/issue-2230-x", "suite-1.12.5", "refs/tags/v1", "a_b.c", "v1.2.lockfile", "--upload-pack=x", "a..b", "a//b", "/a", "a/", "x.lock", ".x", "a/.x", "a.", "a./b", "a.lock/b", "a b", "a;b", "x".repeat(201)]) {
    const req = { ...REQ(), claim_token: TOKEN, suite_ref: ref };
    writeFileSync(join(dir, "request.env"), requestEnv(req));
    const exec = spawnSync("bash", [join(dir, "parse.sh"), join(dir, "request.env")], { encoding: "utf8" }).stdout.trim();
    const workerOk = claimedRequestError(req) === null;
    assert.equal(workerOk, exec === "ok", `${JSON.stringify(ref)}: worker ${workerOk ? "takes" : "refuses"}, executor says ${exec}`);
  }
});

test("a claimed request is checked field by field before it reaches the slot", () => {
  const ok = { ...REQ(), claim_token: TOKEN };
  assert.equal(claimedRequestError(ok), null);
  for (const [over, field] of [
    [{ id: "a/b" }, "id"], [{ id: "x".repeat(65) }, "id"], [{ ref: "a\nONDEMAND_PROVIDER=x" }, "ref"], [{ ref: "main;rm" }, "ref"],
    [{ provider: "Anthropic" }, "provider"], [{ model: "a b" }, "model"], [{ requested_by: "o'neil" }, "requested_by"],
    [{ claim_token: TOKEN.toUpperCase() }, "claim_token"], [{ provider: 7 }, "provider"],
    [{ ref: "a..b" }, "branch"], [{ ref: "a//b" }, "branch"], [{ ref: ".hidden" }, "branch"], [{ ref: "x.lock" }, "branch"], [{ ref: "a/./b" }, "branch"],
    [{ provider: "", model: "gpt-4o" }, "model needs provider"],
    [{ suite_ref: "a\nONDEMAND_REF=x" }, "suite_ref"], [{ suite_ref: 7 }, "suite_ref"], [{ suite_ref: "-x" }, "suite_ref"],
  ]) {
    assert.match(claimedRequestError({ ...ok, ...over }) ?? "", new RegExp(field), JSON.stringify(over));
  }
});

test("a claimed request the executor could not take is refused by the worker, and the refusal forwarded", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ({ ref: "a..b" }));
    const w = worker(m, p);
    await w.step();
    await w.step();
    assert.equal(m.starts().length, 0);
    assert.equal(existsSync(join(m.env.E2E_ONDEMAND_STATE, "request.env")), false);
    assert.equal(p.requests[0].status, "refused");
    assert.match(p.requests[0].result.REASON, /worker refused.*ref is not a branch name/);
    assert.equal(p.requests[0].result.EXIT, "2");
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

test("results are read verbatim: '' stays '', a value may hold '='", () => {
  assert.deepEqual(parseResult("ONDEMAND_ID=a\nVERDICT=\nREASON=x=y = z\nEXIT=1\n"), { ONDEMAND_ID: "a", VERDICT: "", REASON: "x=y = z", EXIT: "1" });
});

test("progress is read from this request's log only", () => {
  const log = "request: id=od-1 ref=main provider=<rotation>\nsuite at: abc suite\nbuilt: main @ 0123456789ab, version 1.13.0.dev4, 312s, as langflow-ondemand:0123456789ab\n=== run start 20260930T150102Z ===\n";
  assert.equal(readProgress(log, "od-2"), null);
  assert.equal(readProgress(log, "od-"), null, "an id prefix is not the id");
  assert.deepEqual(readProgress(log, "od-1"), { building: true, runId: "20260930T150102Z", version: "1.13.0.dev4", buildS: 312 });
  assert.deepEqual(readProgress("request: id=od-1 ref=main\n", "od-1"), { building: false, runId: null, version: null, buildS: null });
});

test("a report over the byte budget drops the summary, never the result", () => {
  const result = { ONDEMAND_ID: "od-1", STATUS: "done", VERDICT: "red", REASON: "r", EXIT: "1", CLEANUP: "ok", FINISHED: "20260930T150500Z", RUN_ID: "20260930T150102Z" };
  const held = { id: "od-1", claim_token: TOKEN };
  const big = { totals: { passed: 0, failed: 1, flaky: 0, skipped: 0 }, duration_ms: 1, failures_by_spec: [{ spec: "s", failures: [{ title: "t", http_status: null, first_error_line: "x".repeat(REPORT_MAX_BYTES) }] }] };
  const b = terminalBody({ workerId: "qa", held, result, summary: big, nowMs: WED_1500 });
  assert.equal(b.summary, null);
  assert.deepEqual(b.result, result);
  assert.equal(b.at, "2026-09-30T15:05:00Z");
  const small = terminalBody({ workerId: "qa", held, result, summary: { ...big, failures_by_spec: [] }, nowMs: WED_1500 });
  assert.notEqual(small.summary, null);
});

test("the configuration is required, and a missing piece is the exit that does not restart", () => {
  assert.throws(() => configFromEnv({}), /QA_ON_DEMAND_API_BASE and QA_ON_DEMAND_WORKER_TOKEN not set/);
  assert.throws(() => configFromEnv({ QA_ON_DEMAND_API_BASE: "http://api.example.com", QA_ON_DEMAND_WORKER_TOKEN: "t" }), /https/);
  assert.equal(configFromEnv({ QA_ON_DEMAND_API_BASE: "https://api.example.com/", QA_ON_DEMAND_WORKER_TOKEN: "t" }).apiBase, "https://api.example.com");
  const r = spawnSync(process.execPath, [WORKER], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 78, r.stderr);
  assert.match(r.stderr, /not set/);
});

test("the service stops on SIGTERM, and a 401 is exit 78", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    const env = { PATH: process.env.PATH, QA_ON_DEMAND_API_BASE: p.base, QA_ON_DEMAND_WORKER_TOKEN: "worker-secret", E2E_ONDEMAND_STATE: m.env.E2E_ONDEMAND_STATE, E2E_ONDEMAND_LOG_DIR: m.env.E2E_ONDEMAND_LOG_DIR, E2E_SHADOW_STATE: m.env.E2E_SHADOW_STATE };
    const { spawn } = await import("node:child_process");
    const run = (e) => new Promise((resolve) => {
      const c = spawn(process.execPath, [WORKER], { env: e });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("exit", (code) => resolve({ code, out }));
      setTimeout(() => c.kill("SIGTERM"), 1500);
    });
    const ok = await run(env);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /stopped/);
    assert.doesNotMatch(ok.out, /worker-secret/, "the secret reached the log");
    const bad = await run({ ...env, QA_ON_DEMAND_WORKER_TOKEN: "wrong" });
    assert.equal(bad.code, 78, bad.out);
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// Found in review
// ---------------------------------------------------------------------------

test("a claim answer lost just before the pause is claimed again through it, and waits for its end", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    p.overrides.claim.push("drop");
    let t = at(3, 7, 24) + 50_000;
    const w = worker(m, p, { clock: () => t });
    await w.step();
    assert.equal(w.state.held, null);
    assert.ok(p.requests[0].claim_token, "the platform did not hold it");
    t = at(3, 7, 26);
    await w.step();
    assert.equal(w.state.held?.id, REQ().id, "the lost claim was not retried inside the pause, so its lease would lapse unseen");
    assert.equal(p.of("heartbeat").at(-1).state, "paused_for_daily");
    assert.equal(m.starts().length, 0, "started inside the daily's window");
    w.next.heartbeat = 0;
    await w.step();
    assert.equal(p.of("heartbeat").at(-1).state, "busy");
    // An answered claim does not claim inside the pause.
    const p2 = await fakePlatform();
    try {
      let t2 = WED_1500;
      const w2 = worker(machine({ run: false }), p2, { clock: () => t2 });
      await w2.step();
      assert.equal(p2.of("claim").length, 1);
      t2 = at(3, 7, 30);
      w2.next.claim = 0;
      await w2.step();
      assert.equal(p2.of("claim").length, 1, "an answered claim kept claiming inside the pause");
    } finally {
      await p2.close();
    }
    t = at(3, 8, 41);
    await w.step();
    assert.equal(m.starts().length, 1);
  } finally {
    await p.close();
  }
});

test("a lease lost before a run took the request releases it unstarted, and empties the slot it wrote", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ());
    let t = WED_1500;
    const w = worker(m, p, { clock: () => t });
    await w.step();
    assert.equal(m.starts().length, 1);
    const slot = join(m.env.E2E_ONDEMAND_STATE, "request.env");
    assert.ok(existsSync(slot));
    m.setUnit("e2e-on-demand.service", "failed"); // the lock refused it; the request stayed
    p.requests[0].status = "abandoned";
    t += 16 * 60_000;
    w.next.heartbeat = 0;
    await w.step();
    assert.equal(w.state.held, null, w.lines.join("\n"));
    assert.equal(m.starts().length, 1, "an abandoned request was started");
    assert.equal(existsSync(slot), false, "left in the slot, it blocks every later start as another request's");
    // The next request is not wedged behind it.
    p.enqueue({ ...REQ(), id: "od-20260930-00000002" });
    w.next.claim = 0;
    await w.step();
    assert.equal(w.state.held?.id, "od-20260930-00000002");
    assert.equal(m.starts().length, 2);
  } finally {
    await p.close();
  }
});

test("a consumed request past the hold limit is still started, and released only when that start leaves nothing", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ orphans: [[REQ().id, false]] });
    p.enqueue(REQ());
    p.requests[0].status = "abandoned";
    p.requests[0].claim_token = TOKEN;
    mkdirSync(join(m.env.E2E_ONDEMAND_STATE, "worker"), { recursive: true });
    // Claimed three hours ago, lease lost, the run killed without its cleanup.
    const held = { ...REQ(), claim_token: TOKEN, held_since: "2026-09-30T12:00:00Z", reported: "running", progress_lost: true, starts: 1, last_start_ms: 0 };
    writeFileSync(join(m.env.E2E_ONDEMAND_STATE, "worker", "state.json"), JSON.stringify({ claim_token: TOKEN, held }));
    const w = worker(m, p);
    await until(w, () => p.requests[0].status === "failed", "the orphan's answer over abandoned");
    assert.match(p.requests[0].result.REASON, /^interrupted/);
    assert.equal(w.state.held, null);
  } finally {
    await p.close();
  }
  // The start past the limit came to nothing (the executor's lock held): released then.
  const p2 = await fakePlatform();
  try {
    const m = machine({ run: false, orphans: [[REQ().id, false]] });
    p2.enqueue(REQ());
    p2.requests[0].status = "abandoned";
    p2.requests[0].claim_token = TOKEN;
    mkdirSync(join(m.env.E2E_ONDEMAND_STATE, "worker"), { recursive: true });
    const held = { ...REQ(), claim_token: TOKEN, held_since: "2026-09-30T12:00:00Z", reported: "running", progress_lost: true, starts: 1, last_start_ms: 0 };
    writeFileSync(join(m.env.E2E_ONDEMAND_STATE, "worker", "state.json"), JSON.stringify({ claim_token: TOKEN, held }));
    let t = WED_1500;
    const w = worker(m, p2, { clock: () => t });
    await w.step();
    assert.equal(m.starts().length, 1, "a consumed request past the limit was released without a start");
    m.setUnit("e2e-on-demand.service", "failed");
    t += 119_000; // the second start's backoff is two minutes
    await w.step();
    assert.notEqual(w.state.held, null, "released before the start had its time");
    t += 2_000;
    await w.step();
    assert.equal(w.state.held, null, w.lines.join("\n"));
    assert.equal(m.starts().length, 1);
  } finally {
    await p2.close();
  }
});

test("a held request from the state file is checked again before it reaches the slot", async () => {
  const p = await fakePlatform();
  try {
    const m = machine({ run: false });
    p.enqueue(REQ({ ref: "a..b" }));
    p.requests[0].status = "claimed";
    p.requests[0].claim_token = TOKEN;
    mkdirSync(join(m.env.E2E_ONDEMAND_STATE, "worker"), { recursive: true });
    // A crash between saving the hold and writing the refusal, in an older order.
    writeFileSync(join(m.env.E2E_ONDEMAND_STATE, "worker", "state.json"), JSON.stringify({ claim_token: TOKEN, held: { ...REQ({ ref: "a..b" }), claim_token: TOKEN, held_since: "2026-09-30T14:59:00Z", reported: "claimed", progress_lost: false, starts: 0, last_start_ms: 0 } }));
    const w = worker(m, p);
    await w.step();
    await w.step();
    assert.equal(m.starts().length, 0);
    assert.equal(existsSync(join(m.env.E2E_ONDEMAND_STATE, "request.env")), false);
    assert.equal(p.requests[0].status, "refused");
  } finally {
    await p.close();
  }
});

// ---------------------------------------------------------------------------
// The suite summary goes with the result (phase 7)
// ---------------------------------------------------------------------------

const ok1 = [{ status: "passed", duration: 900, steps: [] }];
const specOf = (file, line, title, status, results) => ({ title, file, line, tags: ["@stable"], tests: [{ status, results }] });
const SUMMARY_REPORT = { stats: { duration: 1800 }, suites: [{ specs: [
  specOf("tests/a.spec.ts", 3, "passes", "expected", ok1),
  specOf("tests/a.spec.ts", 9, "fails", "unexpected", [{ status: "failed", duration: 900, steps: [], error: { message: "Error: boom" } }]),
] }] };

test("the worker counts the run its result names, and nothing else", () => {
  const state = makeTempDir("od-state-");
  const run = "20261004T133844Z";
  mkdirSync(join(state, "runs", run), { recursive: true });
  writeFileSync(join(state, "runs", run, "results.json"), JSON.stringify(SUMMARY_REPORT));
  const w = new Worker({ apiBase: "http://127.0.0.1:1", token: "t", workerId: "qa", state, logDir: state, shadowState: state, log: () => {} });
  assert.deepEqual(w.summaryOf({ RUN_ID: run }).totals, { passed: 1, failed: 1, flaky: 0, skipped: 0 });
  assert.equal(w.summaryOf({ STATUS: "refused" }), null, "a result with no run has no summary");
  assert.equal(w.summaryOf({ RUN_ID: "20261004T000000Z" }), null, "a run that left no results.json has none");
  assert.equal(w.summaryOf({ RUN_ID: "../../etc" }), null, "a RUN_ID outside its shape reads no file");
  // The suite runs in $STATE/wt: an absolute path there comes out as the daily writes it.
  const abs = { suites: [{ specs: [specOf(join(state, "wt", "tests", "a.spec.ts"), 3, "t", "expected", ok1)] }] };
  writeFileSync(join(state, "runs", run, "results.json"), JSON.stringify(abs));
  assert.equal(w.summaryOf({ RUN_ID: run }).tests_by_spec[0].spec, "tests/a.spec.ts");
});
