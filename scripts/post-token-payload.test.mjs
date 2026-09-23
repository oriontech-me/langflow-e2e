// Unit tests for the VM lane's token POST (#2017).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { OUTCOMES, classifyIngest, describeMerge, postTokenPayload } from "./post-token-payload.mjs";
import { MERGE_CODES } from "./merge-token-payload.mjs";
import { makeTempDir } from "./lib/tmp-dir.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO_ROOT, "scripts/post-token-payload.mjs");

const BLOCK = { traces: 1, total_tokens: 88, span_tokens: 88, mismatch_traces: 0, rows: [{ model: "m" }] };
const PAYLOAD = { version: 1, date: "2026-09-23", run_id: "vm-1", totals: { passed: 1 } };

/** A run directory with the files the real merge reads. `null` leaves a file out. */
function runDir({ block = BLOCK, payload = PAYLOAD } = {}) {
  const dir = makeTempDir("post-token-payload-");
  if (block !== null) {
    writeFileSync(path.join(dir, "tokens-block.json"), typeof block === "string" ? block : JSON.stringify(block));
  }
  if (payload !== null) {
    writeFileSync(path.join(dir, "payload.json"), typeof payload === "string" ? payload : JSON.stringify(payload));
  }
  return {
    dir,
    env: {
      TOKENS_SUMMARY_OUT: path.join(dir, "tokens-block.json"),
      TOKENS_DIR: path.join(dir, "all-tokens"),
      PAYLOAD_IN: path.join(dir, "payload.json"),
      PAYLOAD_OUT: path.join(dir, "payload-with-tokens.json"),
      QA_PLATFORM_ENDPOINT: "https://platform.invalid/runs",
      QA_E2E_AUTOMATION_TOKEN: "tok",
    },
  };
}

const respond = (status, body) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { fetchImpl, calls };
};

const quiet = () => {};

// ---------------------------------------------------------------------------
// The merge half — driven through the REAL merge, not a stub, so a verdict the
// merge can return and this script does not handle shows up here.
// ---------------------------------------------------------------------------

test("a run that captured nothing is a notice, and nothing is POSTed", async () => {
  const { env } = runDir({ block: null });
  const { fetchImpl, calls } = respond(200, {});
  const r = await postTokenPayload({ env, fetchImpl, log: quiet });
  assert.equal(r.outcome, "block_missing");
  assert.equal(r.level, "notice");
  assert.equal(calls.length, 0);
});

test("an unparseable block is spend LOST, never a run that captured nothing", async () => {
  const { env } = runDir({ block: "{not json" });
  const { fetchImpl, calls } = respond(200, {});
  const r = await postTokenPayload({ env, fetchImpl, log: quiet });
  assert.equal(r.outcome, "block_unparseable");
  assert.equal(r.level, "warn");
  assert.match(r.message, /LOST, not zero/);
  assert.equal(calls.length, 0);
});

test("a missing or unparseable payload says the tokens are discarded", async () => {
  for (const [payload, code] of [
    [null, "payload_missing"],
    ["{", "payload_unparseable"],
  ]) {
    const { env } = runDir({ payload });
    const { fetchImpl, calls } = respond(200, {});
    const r = await postTokenPayload({ env, fetchImpl, log: quiet });
    assert.equal(r.outcome, code);
    assert.match(r.message, /discarded/);
    assert.equal(calls.length, 0);
  }
});

test("every no-POST merge verdict has its own outcome, and nothing unknown reads as one of them", () => {
  for (const code of MERGE_CODES.filter((c) => c !== "merged")) {
    assert.equal(describeMerge(code).outcome, code, `${code} fell through to the default`);
    assert.ok(OUTCOMES.includes(code), `${code} is not a declared outcome`);
  }
  for (const code of [undefined, "", "merged", "some_future_code"]) {
    const d = describeMerge(code);
    assert.equal(d.outcome, "merge_unknown");
    assert.match(d.message, /UNKNOWN, not zero/);
  }
});

test("a merge that throws is UNKNOWN and POSTs nothing", async () => {
  const { env } = runDir();
  const { fetchImpl, calls } = respond(200, {});
  const merge = async () => {
    throw new Error("boom");
  };
  const r = await postTokenPayload({ env, merge, fetchImpl, log: quiet });
  assert.equal(r.outcome, "merge_unknown");
  assert.equal(calls.length, 0);
});

test("a payload-with-tokens left from an earlier invocation is never POSTed as this run's", async () => {
  // The gate is the file. Without clearing it first, a stale merged payload plus
  // a run that captured nothing would POST the old run's tokens.
  const { env } = runDir({ block: null });
  writeFileSync(env.PAYLOAD_OUT, JSON.stringify({ ...PAYLOAD, tokens: BLOCK }));
  const { fetchImpl, calls } = respond(200, {});
  const r = await postTokenPayload({ env, fetchImpl, log: quiet });
  assert.equal(r.outcome, "block_missing");
  assert.equal(calls.length, 0);
  assert.equal(existsSync(env.PAYLOAD_OUT), false);
});

test("a file the merge did not claim to write is not trusted", async () => {
  const { env } = runDir();
  const { fetchImpl, calls } = respond(200, {});
  const merge = async () => {
    writeFileSync(env.PAYLOAD_OUT, "{}");
    return { code: "block_missing" };
  };
  const r = await postTokenPayload({ env, merge, fetchImpl, log: quiet });
  assert.equal(r.outcome, "merge_unknown");
  assert.equal(calls.length, 0);
});

test("no endpoint or no token skips the POST and says so", async () => {
  for (const unset of ["QA_PLATFORM_ENDPOINT", "QA_E2E_AUTOMATION_TOKEN"]) {
    const { env } = runDir();
    const { fetchImpl, calls } = respond(200, {});
    const r = await postTokenPayload({ env: { ...env, [unset]: "" }, fetchImpl, log: quiet });
    assert.equal(r.outcome, "not_configured");
    assert.equal(calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// The POST half
// ---------------------------------------------------------------------------

test("the POST carries the merged payload, the bearer token and a JSON content type", async () => {
  const { env } = runDir();
  const { fetchImpl, calls } = respond(200, { tokens_status: "ingested", tokens_dropped: 0, tokens_received: 1 });
  const r = await postTokenPayload({ env, fetchImpl, log: quiet });
  assert.equal(r.outcome, "delivered");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, env.QA_PLATFORM_ENDPOINT);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.run_id, "vm-1", "the SAME run payload, so the platform matches the recorded run");
  assert.equal(sent.tokens.total_tokens, 88);
});

test("the response is kept as evidence when asked", async () => {
  const { env, dir } = runDir();
  const out = path.join(dir, "resp.json");
  const { fetchImpl } = respond(200, { tokens_status: "ingested", tokens_dropped: 0, tokens_received: 1 });
  await postTokenPayload({ env: { ...env, TOKEN_POST_RESPONSE_OUT: out }, fetchImpl, log: quiet });
  assert.equal(JSON.parse(readFileSync(out, "utf8")).tokens_status, "ingested");
});

test("a request that never completes is http_failed, not a crash", async () => {
  const { env } = runDir();
  const fetchImpl = async () => {
    throw new Error("ECONNREFUSED");
  };
  const r = await postTokenPayload({ env, fetchImpl, log: quiet });
  assert.equal(r.outcome, "http_failed");
});

test("HTTP 200 is not the verdict: each body shape is its own outcome", () => {
  const cases = [
    [500, { tokens_status: "ingested", tokens_dropped: 0 }, "http_failed"],
    [0, "", "http_failed"],
    [200, "", "status_absent"],
    [200, "<html>", "status_absent"],
    [200, "null", "status_absent"],
    [200, { status: "exists" }, "status_absent"],
    [200, { tokens_status: null }, "status_absent"],
    [200, { tokens_status: "rejected" }, "not_ingested"],
    [200, { tokens_status: "skipped" }, "not_ingested"],
    [200, { tokens_status: "failed" }, "not_ingested"],
    [200, { tokens_status: "ingested", tokens_dropped: 2, tokens_received: 5 }, "dropped"],
    // Absent is not zero: an ingested block with no dropped count is not delivery.
    [200, { tokens_status: "ingested", tokens_received: 5 }, "dropped"],
    [201, { tokens_status: "ingested", tokens_dropped: 0, tokens_received: 5 }, "delivered"],
  ];
  for (const [status, body, outcome] of cases) {
    const r = classifyIngest(status, typeof body === "string" ? body : JSON.stringify(body));
    assert.equal(r.outcome, outcome, `HTTP ${status} ${JSON.stringify(body)}`);
    assert.equal(r.level, outcome === "delivered" ? "ok" : "warn");
  }
});

test("OUTCOMES lists exactly the outcomes the module can reach", async () => {
  const seen = new Set();
  for (const code of [...MERGE_CODES, undefined]) seen.add(describeMerge(code).outcome);
  for (const [s, b] of [
    [500, ""],
    [200, ""],
    [200, '{"tokens_status":"rejected"}'],
    [200, '{"tokens_status":"ingested","tokens_dropped":1}'],
    [200, '{"tokens_status":"ingested","tokens_dropped":0}'],
  ]) {
    seen.add(classifyIngest(s, b).outcome);
  }
  const { env } = runDir();
  seen.add((await postTokenPayload({ env: { ...env, QA_PLATFORM_ENDPOINT: "" }, log: quiet })).outcome);
  assert.deepEqual([...seen].sort(), [...OUTCOMES].sort());
});

// ---------------------------------------------------------------------------
// The CLI, against a real HTTP server: the contract phase_publish reads.
// ---------------------------------------------------------------------------

function runCli(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stdout += d));
    child.on("close", (code) => resolve({ code, stdout }));
  });
}

test("the CLI POSTs to a real server, prints the outcome LAST, and exits 0", async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "exists", tokens_status: "ingested", tokens_dropped: 0, tokens_received: 1 }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { env } = runDir();
    const { port } = server.address();
    const r = await runCli({ ...env, QA_PLATFORM_ENDPOINT: `http://127.0.0.1:${port}/runs` });
    assert.equal(r.code, 0);
    assert.equal(received.length, 1);
    assert.equal(received[0].auth, "Bearer tok");
    assert.equal(JSON.parse(received[0].body).tokens.total_tokens, 88);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.at(-1), "post-token-payload: outcome=delivered");
  } finally {
    server.close();
  }
});

test("the CLI exits 0 on a failure outcome too — telemetry never fails the run", async () => {
  const { env } = runDir();
  // Port 9 on loopback: nothing listens, so the request is refused.
  const r = await runCli({ ...env, QA_PLATFORM_ENDPOINT: "http://127.0.0.1:9/runs" });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim().split("\n").at(-1), /^post-token-payload: outcome=http_failed$/);
});
