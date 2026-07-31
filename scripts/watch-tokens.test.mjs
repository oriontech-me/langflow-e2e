// Unit tests for the token consumption poller (issue #1197).
// Run with: npm run test:scripts
//
// The backend is faked at the fetch boundary: these tests pin the two behaviours
// that decide whether the numbers are true — the duplicated span pair must not
// double-count (design §2.1), and a trace already seen must never be counted twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import realFs from "node:fs";
import { collectOnce, parseProbeLines, poll, summarize } from "./watch-tokens.mjs";

const SCRIPT = fileURLToPath(new URL("./watch-tokens.mjs", import.meta.url));

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const daily = () =>
  realFs.readFileSync(path.join(REPO_ROOT, ".github/workflows/daily-stable.yml"), "utf8");
const prValidation = () =>
  realFs.readFileSync(path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"), "utf8");
const manual = () =>
  realFs.readFileSync(path.join(REPO_ROOT, ".github/workflows/manual.yml"), "utf8");

// The exact span shape the spike measured: a component-level llm span with a null
// modelName carrying the SAME usage as the inner provider span.
const SPANS = [
  { name: "Chat Input", type: "chain", modelName: null, tokenUsage: null },
  {
    name: "Language Model",
    type: "llm",
    modelName: null,
    tokenUsage: { promptTokens: 40, completionTokens: 48, totalTokens: 88 },
  },
  {
    name: "ChatOpenAI gpt-4o-mini",
    type: "llm",
    modelName: "gpt-4o-mini",
    tokenUsage: { promptTokens: 40, completionTokens: 48, totalTokens: 88 },
  },
];

function fakeBackend({ traces, detail, failList = false }) {
  const calls = { list: 0, detail: 0 };
  const fetchImpl = async (url) => {
    if (url.includes("/monitor/traces/")) {
      calls.detail += 1;
      const id = url.split("/monitor/traces/")[1];
      const body = detail[id];
      if (!body) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => body };
    }
    calls.list += 1;
    if (failList) throw new Error("connect ECONNREFUSED");
    return { ok: true, status: 200, json: async () => ({ traces, total: traces.length }) };
  };
  return { fetchImpl, calls };
}

// flattenSpans/spanModelUsage moved to scripts/lib/token-spans.mjs and are
// tested there (#1197 re-review, finding A: that module is now shared with
// the attribution sidecar, so its rules are tested once, independent of
// either caller). This file keeps its collectOnce-level tests, which exercise
// spanModelUsage indirectly through fakeBackend's `detail` responses.

test("collectOnce emits one probe per new trace and records its trace total", async () => {
  const { fetchImpl, calls } = fakeBackend({
    traces: [{ id: "t1", flowId: "f1", startTime: "2026-07-31T13:35:38Z", status: "ok", totalTokens: 88 }],
    detail: { t1: { spans: SPANS } },
  });
  const seen = new Set();
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "Bearer t", seen });
  assert.equal(out.probes.length, 1);
  assert.equal(out.probes[0].trace_id, "t1");
  assert.equal(out.probes[0].flow_id, "f1");
  assert.equal(out.probes[0].total_tokens, 88);
  assert.deepEqual(out.probes[0].models[0].model, "gpt-4o-mini");
  assert.equal(calls.list, 1);
  assert.equal(calls.detail, 1);
});

// #1197 review, finding I3: a trace with no reported total must record `null`
// (unknown), never `0` — `aggregate()`'s spanTotal fallback exists precisely so
// this case is not silently priced as "the run spent nothing".
test("collectOnce emits total_tokens: null when the trace's own total is unknown, not 0", async () => {
  const { fetchImpl } = fakeBackend({
    traces: [{ id: "t1", flowId: "f1", startTime: "x", status: "ok" }], // no totalTokens field
    detail: { t1: { spans: SPANS } },
  });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen: new Set() });
  assert.equal(out.probes.length, 1);
  assert.equal(out.probes[0].total_tokens, null);
});

test("a trace already seen is not fetched or emitted again", async () => {
  const traces = [{ id: "t1", flowId: "f1", startTime: "x", status: "ok", totalTokens: 88 }];
  const { fetchImpl, calls } = fakeBackend({ traces, detail: { t1: { spans: SPANS } } });
  const seen = new Set();
  await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen });
  const second = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen });
  assert.equal(second.probes.length, 0);
  assert.equal(calls.detail, 1);
});

test("the detail cap bounds one tick, and what it dropped is reported", async () => {
  const traces = Array.from({ length: 5 }, (_, i) => ({
    id: `t${i}`,
    flowId: "f",
    startTime: "x",
    status: "ok",
    totalTokens: 1,
  }));
  const detail = Object.fromEntries(traces.map((t) => [t.id, { spans: SPANS }]));
  const { fetchImpl, calls } = fakeBackend({ traces, detail });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen: new Set(), detailCap: 2 });
  assert.equal(out.probes.length, 2);
  assert.equal(calls.detail, 2);
  assert.equal(out.deferred, 3);
});

test("a trace whose detail 404s (flow deleted mid-poll) is skipped, not fatal", async () => {
  const { fetchImpl } = fakeBackend({
    traces: [{ id: "gone", flowId: "f", startTime: "x", status: "ok", totalTokens: 5 }],
    detail: {},
  });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen: new Set() });
  assert.deepEqual(out.probes, []);
  assert.equal(out.errors.length, 1);
});

test("a 401 asks for an auth refresh instead of dying", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "stale", seen: new Set() });
  assert.equal(out.refreshAuth, true);
  assert.deepEqual(out.probes, []);
});

test("a wedged or dead backend produces an error, never a throw", async () => {
  const { fetchImpl } = fakeBackend({ traces: [], detail: {}, failList: true });
  const out = await collectOnce({ fetchImpl, base: "http://x", bearer: "b", seen: new Set() });
  assert.equal(out.probes.length, 0);
  assert.match(out.errors[0], /ECONNREFUSED/);
});

test("parseProbeLines skips a torn last line", () => {
  const probes = parseProbeLines('{"trace_id":"a","total_tokens":1}\n{"trace_id":"b"');
  assert.equal(probes.length, 1);
  assert.equal(probes[0].trace_id, "a");
});

// TOKENS_OUT becoming unwritable mid-run (ENOSPC, permissions, a bad path) must
// degrade the recorder, not crash it — the file's own header promises "always
// exits 0 / never throws out of a tick". Point TOKENS_OUT at a directory: on
// every platform node's fs targets, appendFileSync on a directory throws
// (EISDIR/EPERM), which is the same failure family as a disk going away.
test("an append failure is logged and the loop is not stopped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-out-"));
  const traces = [{ id: "t1", flowId: "f1", startTime: "x", status: "ok", totalTokens: 88 }];
  const { fetchImpl } = fakeBackend({ traces, detail: { t1: { spans: SPANS } } });
  const logs = [];
  const code = await poll({
    fetchImpl,
    env: {
      TOKENS_BASE_URL: "http://x",
      TOKENS_OUT: dir, // a directory, not a file
      TOKENS_INTERVAL_MS: "10",
      TOKENS_MAX_SECONDS: "0.15",
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.ok(
    logs.some((l) => /could not append a probe/.test(l)),
    `expected an append-failure log, got: ${JSON.stringify(logs)}`,
  );
});

// #1197 review, finding I4: a permanently unauthorized poller must not fail
// SILENTLY. Before the fix, `collectOnce` returning `refreshAuth: true` with an
// empty `errors[]` meant `poll()` logged nothing for that tick — a run where
// login() keeps failing (bad credentials, an auth endpoint that started
// rejecting mid-run) ends with "0 trace(s) recorded" and no clue why.
test("poll logs each unauthorized tick and names the streak in its final line", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/auto_login")) return { ok: true, status: 200, json: async () => ({}) }; // never yields a usable token
    return { ok: false, status: 401, json: async () => ({}) };
  };
  const logs = [];
  const code = await poll({
    fetchImpl,
    env: {
      TOKENS_BASE_URL: "http://x",
      TOKENS_OUT: join(mkdtempSync(join(tmpdir(), "tokens-auth-")), "probes.jsonl"),
      TOKENS_INTERVAL_MS: "5",
      TOKENS_MAX_SECONDS: "0.05",
    },
    log: (msg) => logs.push(msg),
  });
  assert.equal(code, 0);
  assert.ok(
    logs.some((l) => /unauthorized/i.test(l)),
    `expected an unauthorized log per tick, got: ${JSON.stringify(logs)}`,
  );
  const finalLine = logs[logs.length - 1];
  assert.match(finalLine, /0 trace\(s\) recorded/);
  assert.match(finalLine, /unauthorized/i, "the final line must name unauthorized as a candidate cause, not just '0 traces'");
});

// The entry-point guard (`if (import.meta.url === ...)`) only runs when the file
// is executed as the main module, which none of the tests above do — they all
// import the named exports. Spawn the real file to exercise that code path and
// confirm the process still exits 0, even pointed at a backend that refuses
// every connection. This does not force the try/catch's error branch: poll()
// is designed to never throw (every failure is caught and turned into a
// logged `errors[]` entry inside collectOnce/poll itself), so there is no fault
// this test can inject that would reach main()'s catch without mocking poll()
// internals directly — the wrapping is defense-in-depth for an unexpected
// throw, matching watch-backend.mjs's own untested catch branch in main().
test("the entry point exits 0 when run directly, even against an unreachable backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tokens-entry-"));
  const out = join(dir, "probes.jsonl");
  const child = spawn(process.execPath, [SCRIPT], {
    env: {
      ...process.env,
      TOKENS_BASE_URL: "http://127.0.0.1:1", // nothing listens here: connection refused
      TOKENS_OUT: out,
      TOKENS_INTERVAL_MS: "50",
      TOKENS_TIMEOUT_MS: "200",
      TOKENS_MAX_SECONDS: "0.3",
    },
    stdio: "ignore",
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(code, 0);
});

// --- summarize(): join, price, anomaly-check and append the run's history line ---
//
// The filesystem is faked at the readFile/listDir/writeFile/appendFile boundary
// (design's injected-I/O rule) so these tests run with no disk access at all.
// `throwAppend`/`throwWrite` arm a write-side failure — used to prove summarize()
// logs and still resolves 0 when the history append or the summary write itself
// fails (review round 1, #1197: those two guards were previously untested).
function fakeFs(files, { throwAppend = false, throwWrite = false } = {}) {
  const written = {};
  const appended = {};
  return {
    written,
    appended,
    readFile: (p) => {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p];
    },
    listDir: (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)),
    // Append, not overwrite (#1197 review, finding C1): GITHUB_STEP_SUMMARY is
    // append-only by GitHub's own documented contract, and the merge job's
    // `Report mid-run backend outages` step (#1030) writes to it BEFORE this
    // one runs. A plain overwrite would silently delete that section on
    // exactly the red days it matters.
    writeFile: (p, text) => {
      if (throwWrite) throw new Error("ENOSPC: no space left on device");
      written[p] = (written[p] || "") + text;
    },
    appendFile: (p, text) => {
      if (throwAppend) throw new Error("ENOSPC: no space left on device");
      appended[p] = (appended[p] || "") + text;
    },
  };
}

const PROBE_LINE = JSON.stringify({
  trace_id: "t1",
  flow_id: "f1",
  start_time: "2026-07-31T13:35:38Z",
  status: "ok",
  total_tokens: 88,
  models: [
    { model: "gpt-4o-mini", prompt_tokens: 40, completion_tokens: 48, total_tokens: 88, calls: 1 },
  ],
});
const ATTRIB_LINE = JSON.stringify({
  trace_id: "t1",
  flow_id: "f1",
  test: "agent suite",
  file: "tests-automations/regression/core-functionality/llm-agents/x.spec.ts",
});
const PRICES = JSON.stringify({ "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 } });

const baseEnv = {
  TOKENS_DIR: "all-tokens",
  TOKENS_HISTORY: "reports/token-history.jsonl",
  TOKENS_PRICES: "prices.json",
  TOKENS_SUMMARY_MD: "summary.md",
  WORKFLOW: "daily-stable",
  GITHUB_RUN_ID: "42",
  GITHUB_SERVER_URL: "https://github.com",
  GITHUB_REPOSITORY: "oriontech-me/langflow-e2e",
  LANGFLOW_IMAGE: "langflowai/langflow-nightly:latest",
  RUN_DATE: "2026-07-31",
  TESTS_TOTAL: "466",
};

test("summarize writes one history line joining probes with attribution", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "all-tokens/token-attrib-1.jsonl": `${ATTRIB_LINE}\n`,
    "prices.json": PRICES,
  });
  assert.equal(await summarize({ env: baseEnv, ...fs2, log: () => {} }), 0);
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(line.version, 1);
  assert.equal(line.workflow, "daily-stable");
  assert.equal(line.run_id, "42");
  assert.equal(line.totals.total_tokens, 88);
  assert.equal(line.by_spec.length, 1);
  assert.equal(line.unattributed.traces, 0);
  assert.match(fs2.written["summary.md"], /Token consumption/);
});

test("a run with zero traces writes NO history line and says why", async () => {
  const fs2 = fakeFs({ "prices.json": PRICES });
  assert.equal(await summarize({ env: baseEnv, ...fs2, log: () => {} }), 0);
  assert.equal(fs2.appended["reports/token-history.jsonl"], undefined);
  assert.match(fs2.written["summary.md"], /no traces recorded/i);
  // The absence must never read as "the run spent nothing".
  assert.doesNotMatch(fs2.written["summary.md"], /\$0\.00 total/);
  // #1197 review, finding I4: a permanently unauthorized poller also ends with
  // zero traces recorded — the "why" string must name that as a candidate
  // cause instead of only blaming tracing / no LLM call, which would send a
  // triager down the wrong path.
  assert.match(fs2.written["summary.md"], /authenticate/i);
});

// #1197 review, finding C1: the step summary is APPEND-only in GitHub's own
// contract. The merge job's `Report mid-run backend outages` step (#1030) runs
// before this one in the same job and appends its own section to
// GITHUB_STEP_SUMMARY — a plain overwrite here would silently delete that
// section on exactly the red days it matters.
test("the step summary is appended, never overwriting an earlier step's section (#1030's outage table)", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  fs2.written["summary.md"] = "## Mid-run backend outages\n\nShard 2 was wedged for 260s.\n";
  assert.equal(await summarize({ env: baseEnv, ...fs2, log: () => {} }), 0);
  assert.match(fs2.written["summary.md"], /Mid-run backend outages/, "the earlier step's section must survive");
  assert.match(fs2.written["summary.md"], /Token consumption/, "the new section must still be written");
});

test("a zero-test run (infra abort) writes no history line", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  const env = { ...baseEnv, TESTS_TOTAL: "0" };
  assert.equal(await summarize({ env, ...fs2, log: () => {} }), 0);
  assert.equal(fs2.appended["reports/token-history.jsonl"], undefined);
  assert.match(fs2.written["summary.md"], /zero tests/i);
});

// #1197 review, minor: `Number("")` is `0`, so an unset/empty TESTS_TOTAL used
// to be indistinguishable from a genuine "0" and got reported as an infra
// abort — even when real trace data existed and should have been priced.
test("an unset/empty TESTS_TOTAL is not mistaken for a zero-test run", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  const env = { ...baseEnv, TESTS_TOTAL: "" };
  assert.equal(await summarize({ env, ...fs2, log: () => {} }), 0);
  assert.ok(fs2.appended["reports/token-history.jsonl"], "real trace data must still be priced and recorded");
  assert.doesNotMatch(fs2.written["summary.md"], /zero tests/i);
});

test("an unpriced model makes the summary say the dollar figure is a floor", async () => {
  const probe = JSON.stringify({
    trace_id: "t9",
    flow_id: "f9",
    total_tokens: 1851,
    models: [
      { model: "gemini-flash-latest", prompt_tokens: 30, completion_tokens: 1821, total_tokens: 1851, calls: 1 },
    ],
  });
  const fs2 = fakeFs({ "all-tokens/token-probes-1.jsonl": `${probe}\n`, "prices.json": PRICES });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.deepEqual(line.unpriced_models, ["gemini-flash-latest"]);
  assert.match(fs2.written["summary.md"], /floor/i);
});

// #1197 review, finding I5: 2-decimal rounding renders a real sub-cent trace
// cost ($0.0000348 for 40 prompt / 48 completion gpt-4o-mini tokens) as "$0.00"
// in the per-model table — indistinguishable from a model that spent nothing.
test("per-model dollar figures use enough decimals to show sub-cent spend", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  assert.match(fs2.written["summary.md"], /\$0\.000035/, "must not round the model row to $0.00");
  assert.doesNotMatch(fs2.written["summary.md"], /\| `gpt-4o-mini` \| 1 \| 40 \| 48 \| \$0\.00 \|/);
});

// #1197 review, I5 follow-up (re-review): the per-model/spec/anomaly rows were
// fixed to sub-cent precision, but the two places a reader looks FIRST still
// used the 2-decimal `usd()` — the step summary's headline
// ("**N tokens** across M trace(s) — $0.00") and the `token summary: N
// tokens, $0.00` stdout line. A real run (this fixture: 40/48 gpt-4o-mini
// tokens, $0.0000348) rendered a $0.00 headline sitting directly above its
// own $0.000035 model row — a run total that reads as "nothing was spent",
// contradicted by the line beneath it. `usd()` must scale precision to
// magnitude too: readable (2 decimals) once the total clears a cent, enough
// decimals (6) to show a real value below that.
test("the headline and the stdout log report a sub-cent total honestly, not $0.00 (#1197 review, I5 follow-up)", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  const logs = [];
  await summarize({ env: baseEnv, ...fs2, log: (msg) => logs.push(msg) });
  assert.ok(
    fs2.written["summary.md"].includes("**88 tokens** across 1 trace(s) — $0.000035"),
    `expected the headline to show $0.000035, got: ${fs2.written["summary.md"]}`,
  );
  assert.ok(
    !fs2.written["summary.md"].includes("across 1 trace(s) — $0.00\n"),
    "the headline must not read as a bare $0.00 above a non-zero model row",
  );
  assert.ok(
    logs.some((l) => l.includes("token summary: 88 tokens, $0.000035")),
    `expected the stdout log to show $0.000035, got: ${JSON.stringify(logs)}`,
  );
  assert.ok(
    !logs.some((l) => /token summary: 88 tokens, \$0\.00(?!\d)/.test(l)),
    "the stdout log must not report the same run as a bare $0.00",
  );
});

// A $4.82 run must still read as "$4.82", not gain trailing zeros just
// because sub-cent runs now need more precision — the headline is meant to
// stay readable at ordinary scale.
test("the headline stays readable (2 decimals) once the total clears a cent", async () => {
  const bigPrices = JSON.stringify({ m: { inputPerMillion: 1000000, outputPerMillion: 1000000 } }); // $1/token
  const bigProbe = JSON.stringify({
    trace_id: "big1",
    flow_id: "f1",
    total_tokens: 4.82,
    models: [{ model: "m", prompt_tokens: 0, completion_tokens: 4.82, total_tokens: 4.82, calls: 1 }],
  });
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${bigProbe}\n`,
    "prices.json": bigPrices,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  assert.ok(
    fs2.written["summary.md"].includes("— $4.82"),
    `expected a readable $4.82 headline, got: ${fs2.written["summary.md"]}`,
  );
});

test("probe files from several shards are merged and deduped by trace", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "all-tokens/token-probes-2.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(line.totals.traces, 1);
});

// --- Finding A (#1197 re-review): a real daily-stable run (30647253368) proved
// 5 of 6 attributed traces never reached a `token-probes-*.jsonl` file at all —
// the poller's 15s tick lost the race against the flow (and its trace) being
// deleted seconds after the sidecar read it. Fixed by having the sidecar write
// the trace's own total + spans ALONGSIDE the attribution fields in the same
// token-attrib line, and having summarize() merge that into probesById too.

test("a trace the poller never saw still reaches totals and by_spec via the sidecar's own probe fields (finding A)", async () => {
  const sidecarOnly = JSON.stringify({
    trace_id: "781928a9",
    flow_id: "0fad1e0d",
    test: "causal control — unset max_tokens generates freely",
    file: "tests-automations/regression/core-functionality/llm-agents/agent-max-tokens.spec.ts",
    start_time: "2026-07-31T16:35:00Z",
    status: "ok",
    total_tokens: 5321,
    models: [
      { model: "gpt-4o-mini", prompt_tokens: 400, completion_tokens: 4921, total_tokens: 5321, calls: 1 },
    ],
  });
  const fs2 = fakeFs({
    // No token-probes file mentions this trace at all — the poller never saw it.
    "all-tokens/token-attrib-1.jsonl": `${sidecarOnly}\n`,
    "prices.json": PRICES,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(line.totals.traces, 1);
  assert.equal(line.totals.total_tokens, 5321);
  assert.equal(line.by_spec.length, 1);
  assert.equal(line.by_spec[0].total_tokens, 5321);
  assert.equal(line.unattributed.traces, 0, "the sidecar's own fields must attribute it, not strand it as unattributed");
});

test("a trace present in BOTH the poller's file and the sidecar's merged line is counted once (finding A)", async () => {
  const pollerLine = JSON.stringify({
    trace_id: "both-1",
    flow_id: "f1",
    start_time: "x",
    status: "ok",
    total_tokens: 88,
    models: [{ model: "gpt-4o-mini", prompt_tokens: 40, completion_tokens: 48, total_tokens: 88, calls: 1 }],
  });
  const mergedLine = JSON.stringify({
    trace_id: "both-1",
    flow_id: "f1",
    test: "agent suite",
    file: "a.spec.ts",
    start_time: "x",
    status: "ok",
    total_tokens: 88,
    models: [{ model: "gpt-4o-mini", prompt_tokens: 40, completion_tokens: 48, total_tokens: 88, calls: 1 }],
  });
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${pollerLine}\n`,
    "all-tokens/token-attrib-1.jsonl": `${mergedLine}\n`,
    "prices.json": PRICES,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(line.totals.traces, 1, "one trace, seen by two sources, must not be counted twice");
  assert.equal(line.totals.total_tokens, 88, "not 176 — the trace must not be double-counted");
});

test("summarize prefers whichever copy of a trace has a KNOWN total_tokens (finding A dedup)", async () => {
  const pollerLineUnknownTotal = JSON.stringify({
    trace_id: "dedup-1",
    flow_id: "f1",
    start_time: "x",
    status: "ok",
    total_tokens: null,
    models: [],
  });
  const mergedLineKnownTotal = JSON.stringify({
    trace_id: "dedup-1",
    flow_id: "f1",
    test: "agent suite",
    file: "a.spec.ts",
    start_time: "x",
    status: "ok",
    total_tokens: 200,
    models: [{ model: "gpt-4o-mini", prompt_tokens: 80, completion_tokens: 120, total_tokens: 200, calls: 1 }],
  });
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${pollerLineUnknownTotal}\n`,
    "all-tokens/token-attrib-1.jsonl": `${mergedLineKnownTotal}\n`,
    "prices.json": PRICES,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(line.totals.traces, 1);
  assert.equal(
    line.totals.total_tokens,
    200,
    "must prefer the copy with a KNOWN total (200), not the poller's null-total copy",
  );
});

// #1197 re-review (run 30651081641): bySpec is keyed by file + test — correctly,
// that is the fact table's grain — but the rendered step-summary table showed
// only `file`. Two different tests in the same spec file rendered as two
// identical-looking rows with different numbers, reading as a bug in the tool
// to a human looking at the artifact. Assert on the RENDERED TEXT (not the
// aggregation, which was already correct) that two same-file, different-title
// rows are distinguishable.
test("the by_spec table distinguishes two rows that share a file but differ in test title", async () => {
  const probeA = JSON.stringify({
    trace_id: "cap-1",
    flow_id: "f1",
    total_tokens: 941,
    models: [{ model: "gpt-4o-mini", prompt_tokens: 891, completion_tokens: 50, total_tokens: 941, calls: 1 }],
  });
  const attribA = JSON.stringify({
    trace_id: "cap-1",
    flow_id: "f1",
    test: "max_tokens=50 caps the response's output tokens",
    file: "tests-automations/regression/core-functionality/llm-agents/agent-max-tokens.spec.ts",
  });
  const probeB = JSON.stringify({
    trace_id: "free-1",
    flow_id: "f2",
    total_tokens: 4821,
    models: [{ model: "gpt-4o-mini", prompt_tokens: 421, completion_tokens: 4400, total_tokens: 4821, calls: 1 }],
  });
  const attribB = JSON.stringify({
    trace_id: "free-1",
    flow_id: "f2",
    test: "causal control — unset max_tokens generates freely",
    file: "tests-automations/regression/core-functionality/llm-agents/agent-max-tokens.spec.ts",
  });
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${probeA}\n${probeB}\n`,
    "all-tokens/token-attrib-1.jsonl": `${attribA}\n${attribB}\n`,
    "prices.json": PRICES,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const summary = fs2.written["summary.md"];
  // The aggregation grain is unchanged: two distinct by_spec rows.
  const historyLine = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(historyLine.by_spec.length, 2);
  // The RENDERED table must show each test's own title, not just the shared
  // file — that's the presentation defect. Both titles must appear in the
  // by_spec section, and the two rows must not be textually identical.
  assert.match(summary, /max_tokens=50 caps the response's output tokens/);
  assert.match(summary, /causal control — unset max_tokens generates freely/);
  const rows = summary
    .split("\n")
    .filter((l) => l.includes("agent-max-tokens.spec.ts") && l.includes("941"));
  // Sanity: exactly one row carries the 941-token trace's numbers.
  assert.equal(rows.length, 1);
});

test("anomalies land in the history line when the baseline supports them", async () => {
  const history = Array.from({ length: 5 }, () =>
    JSON.stringify({ totals: { usd_estimated: 0.000001 }, by_spec: [] }),
  ).join("\n");
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
    "reports/token-history.jsonl": `${history}\n`,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(line.anomalies.length, 1);
  assert.equal(line.anomalies[0].scope, "run");
  // #1197 re-review, Low: the anomaly branch's last `lines.push` is the 🔺
  // line with no trailing "" after it, so the rendered text used to end
  // without a newline. Harmless while this is the last writer in the job,
  // but the C1 fix made GITHUB_STEP_SUMMARY an append-mode target — a
  // missing terminator is a latent defect for whatever appends next.
  assert.ok(
    fs2.written["summary.md"].endsWith("\n"),
    "the summary text must be newline-terminated, even when the last section is an anomaly line",
  );
});

// #1197 review, finding I7: the anomaly baseline must be WINDOWED to a recent
// slice of history, not the whole all-time file. Otherwise a legitimate,
// sustained cost increase (deliberate suite growth) never raises the median —
// the old, cheap runs permanently outnumber the new ones — and the run-scope
// anomaly fires every day forever.
test("the anomaly baseline is windowed to recent history, not the whole all-time file", async () => {
  const prices = JSON.stringify({ m: { inputPerMillion: 1000000, outputPerMillion: 1000000 } }); // $1/token
  const probe = JSON.stringify({
    trace_id: "t1",
    flow_id: "f1",
    total_tokens: 6,
    models: [{ model: "m", prompt_tokens: 0, completion_tokens: 6, total_tokens: 6, calls: 1 }],
  });
  // 30 old, cheap lines (before the suite grew) followed by 20 recent lines at
  // the new, legitimately higher spend level. Un-windowed, the 30 old lines
  // dominate the median (old:1 outnumbers recent:5), and the run's $6 reads as
  // a 6x anomaly against a stale $1 baseline. Windowed to the last 20, the
  // baseline is the recent $5 level and $6 is unremarkable.
  const oldCheap = Array.from({ length: 30 }, () => JSON.stringify({ totals: { usd_estimated: 1 }, by_spec: [] }));
  const recentGrown = Array.from({ length: 20 }, () => JSON.stringify({ totals: { usd_estimated: 5 }, by_spec: [] }));
  const history = `${[...oldCheap, ...recentGrown].join("\n")}\n`;
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${probe}\n`,
    "prices.json": prices,
    "reports/token-history.jsonl": history,
  });
  await summarize({ env: baseEnv, ...fs2, log: () => {} });
  const line = JSON.parse(fs2.appended["reports/token-history.jsonl"].trim());
  assert.equal(
    line.anomalies.length,
    0,
    "windowed to the recent $5 baseline, a $6 run is not a 6x anomaly against the stale all-time $1 median",
  );
});

test("summarize never throws on a missing probe directory", async () => {
  const fs2 = fakeFs({ "prices.json": PRICES });
  assert.equal(await summarize({ env: { ...baseEnv, TOKENS_DIR: "nope" }, ...fs2, log: () => {} }), 0);
});

// --- TOKENS_SUPPRESS_HISTORY (#1183) ---
//
// pr-validation.yml and manual.yml run --summarize for the step-summary table
// but must never add a line to reports/token-history.jsonl: their per-run
// scope (a capped PR subset, an arbitrary manual dispatch) is not comparable
// to the daily's fixed @stable sweep, and mixing it in would corrupt the
// trend and the anomaly baseline. These tests pin: the write is suppressed,
// the read is suppressed too (so an existing history file cannot seed a false
// anomaly against a mismatched baseline), the suppression is logged, and it
// is stated in the step summary itself — never silently (#1012's rule).

test("TOKENS_SUPPRESS_HISTORY=1 writes no history line even though real trace data exists", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  const env = { ...baseEnv, TOKENS_SUPPRESS_HISTORY: "1" };
  const code = await summarize({ env, ...fs2, log: () => {} });
  assert.equal(code, 0);
  assert.equal(
    fs2.appended["reports/token-history.jsonl"],
    undefined,
    "the history file must not be written when suppression is set",
  );
  // The run's own numbers must still be priced and rendered — suppression only
  // affects the history file, not the step summary.
  assert.match(fs2.written["summary.md"], /\*\*88 tokens\*\*/);
});

test("TOKENS_SUPPRESS_HISTORY=1 logs why, so a suppressed write does not read as a silent bug", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  const env = { ...baseEnv, TOKENS_SUPPRESS_HISTORY: "1" };
  const logs = [];
  await summarize({ env, ...fs2, log: (msg) => logs.push(msg) });
  assert.ok(
    logs.some((l) => /TOKENS_SUPPRESS_HISTORY set/.test(l)),
    `expected a log line naming the suppression, got: ${JSON.stringify(logs)}`,
  );
});

test("TOKENS_SUPPRESS_HISTORY=1 states the suppression in the step summary itself", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  const env = { ...baseEnv, TOKENS_SUPPRESS_HISTORY: "1" };
  await summarize({ env, ...fs2, log: () => {} });
  assert.match(
    fs2.written["summary.md"],
    /History append suppressed/i,
    "a reader of the run's own step summary must not be left wondering why the history file did not change",
  );
});

// #1197 review, finding I7's windowing fix (the anomaly baseline must be a
// recent slice of history, not the whole all-time file) only matters when
// history is actually read. A PR/manual run's totals are not comparable to the
// daily's baseline AT ALL — a small subset's totals would read as a huge
// negative "anomaly" against the daily's full-sweep numbers on every single
// run — so suppression must skip the READ too, not only the write.
test("TOKENS_SUPPRESS_HISTORY=1 does not read the existing history file for the anomaly baseline either", async () => {
  const history = Array.from({ length: 5 }, () =>
    JSON.stringify({ totals: { usd_estimated: 0.000001 }, by_spec: [] }),
  ).join("\n");
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
    "reports/token-history.jsonl": `${history}\n`,
  });
  const env = { ...baseEnv, TOKENS_SUPPRESS_HISTORY: "1" };
  const logs = [];
  await summarize({ env, ...fs2, log: (msg) => logs.push(msg) });
  // No history line is appended (nothing to assert anomalies on), and no
  // anomaly line is rendered — proving the pre-existing (daily-scoped) history
  // was never consulted for this run's baseline.
  assert.equal(fs2.appended["reports/token-history.jsonl"], undefined);
  assert.doesNotMatch(fs2.written["summary.md"], /🔺/);
});

test("TOKENS_SUPPRESS_HISTORY is case-insensitive and accepts 'true' as well as '1'", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  const env = { ...baseEnv, TOKENS_SUPPRESS_HISTORY: "true" };
  await summarize({ env, ...fs2, log: () => {} });
  assert.equal(fs2.appended["reports/token-history.jsonl"], undefined);
});

test("TOKENS_SUPPRESS_HISTORY unset (or falsy) preserves the existing daily behaviour", async () => {
  const fs2 = fakeFs({
    "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`,
    "prices.json": PRICES,
  });
  assert.ok(await summarize({ env: { ...baseEnv, TOKENS_SUPPRESS_HISTORY: "0" }, ...fs2, log: () => {} }) === 0);
  assert.ok(
    fs2.appended["reports/token-history.jsonl"],
    "an explicit '0' must behave exactly like the knob being absent — the daily never sets it",
  );
});

test("a history-append failure is logged and summarize still resolves 0", async () => {
  const fs2 = fakeFs(
    { "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`, "prices.json": PRICES },
    { throwAppend: true },
  );
  const logs = [];
  const code = await summarize({ env: baseEnv, ...fs2, log: (msg) => logs.push(msg) });
  assert.equal(code, 0);
  assert.ok(
    logs.some((l) => /could not append the history line/.test(l)),
    `expected a history-append-failure log, got: ${JSON.stringify(logs)}`,
  );
});

test("a summary-write failure is logged and summarize still resolves 0", async () => {
  const fs2 = fakeFs(
    { "all-tokens/token-probes-1.jsonl": `${PROBE_LINE}\n`, "prices.json": PRICES },
    { throwWrite: true },
  );
  const logs = [];
  const code = await summarize({ env: baseEnv, ...fs2, log: (msg) => logs.push(msg) });
  assert.equal(code, 0);
  assert.ok(
    logs.some((l) => /could not write the step summary/.test(l)),
    `expected a summary-write-failure log, got: ${JSON.stringify(logs)}`,
  );
});

// --- Structural guard: is the daily workflow actually wired to this script? ---

// The wedge cannot be reproduced on demand and neither can a real token spend, so
// what CAN be asserted cheaply is that the wiring still exists — the same reason
// the health gate carries a structural guard (#1045).
test("the daily starts the token recorder before the test step and summarizes after", () => {
  const text = daily();
  const start = text.indexOf("node scripts/watch-tokens.mjs");
  // The bare `npx playwright test --grep "@stable"` prefix also matches the
  // `prep` job's `--list` step (it enumerates the same suite earlier in the
  // file), so anchor on the shard run's own flag to find the actual test step.
  const run = text.indexOf('npx playwright test --grep "@stable" --pass-with-no-tests');
  const summarize = text.indexOf("node scripts/watch-tokens.mjs --summarize");
  assert.ok(start > 0, "the daily no longer starts the token recorder");
  assert.ok(run > 0, "the daily no longer runs the @stable shard step");
  assert.ok(start < run, "the token recorder must start BEFORE the test step");
  assert.ok(summarize > run, "the summary must run after the tests");
});

// Renamed per #1197 review (finding C2c): this only proves the env var is SET
// on the @stable shard step — it says nothing about whether any spec actually
// calls the sidecar (that would need the spec itself to pass `attribution`,
// which is covered by agent-max-tokens.spec.ts, not by this workflow guard).
test("the @stable shard step sets TOKENS_ATTRIB (env wiring only, not proof the sidecar runs)", () => {
  assert.match(daily(), /TOKENS_ATTRIB:/);
});

// #1197 review, finding I9: the guard sliced from the FIRST occurrence of
// "Summarize token consumption" only — that's the SHARD step. A
// `continue-on-error: true` could be dropped from the MERGE-job step (the one
// that actually prices and writes the run's history line) and this guard would
// still pass. Check both occurrences: the shard's stop-and-collect step and the
// merge job's summarize step (renamed per the minor fix below — anchor on
// substrings unique to each so the rename doesn't collapse them to one match).
test("neither token step gates the run — the shard stop step AND the merge summary step", () => {
  const text = daily();
  const shardStep = text.indexOf("Stop and collect token consumption");
  const mergeStep = text.indexOf("Summarize token consumption");
  assert.ok(shardStep > 0, "the shard's stop-and-collect step must exist");
  assert.ok(mergeStep > 0, "the merge job's summarize step must exist");
  assert.notEqual(shardStep, mergeStep, "the two must be distinct steps, not the same match twice");
  for (const start of [shardStep, mergeStep]) {
    assert.match(text.slice(start, start + 400), /continue-on-error: true/);
  }
});

// --- Structural guard: pr-validation.yml and manual.yml wiring (#1183) ---
//
// Same rationale as the daily's own guard above: neither the wedge nor a real
// token spend can be reproduced on demand in a unit test, but the WIRING can
// be asserted cheaply, and a silent regression here (a step quietly dropped
// from a workflow edit) is exactly the failure mode these guards exist to
// catch.

test("pr-validation's E2E job starts the token recorder before the impacted-specs run and summarizes after, all steps continue-on-error", () => {
  const text = prValidation();
  const start = text.indexOf("node scripts/watch-tokens.mjs");
  // Anchor on the STEP HEADER, not the bare phrase — the recorder-start step's
  // own comment mentions "Run impacted specs" in prose (to explain why it
  // needs no separate `if`), which sits BEFORE the recorder actually starts
  // and would otherwise false-positive this guard.
  const run = text.indexOf("- name: Run impacted specs");
  const stop = text.indexOf("Stop and collect token consumption");
  const summarizeStep = text.indexOf("Summarize token consumption");
  assert.ok(start > 0, "pr-validation.yml no longer starts the token recorder");
  assert.ok(run > 0, "pr-validation.yml no longer runs the impacted specs step");
  assert.ok(stop > 0, "pr-validation.yml no longer stops/collects the token recorder");
  assert.ok(summarizeStep > 0, "pr-validation.yml no longer summarizes token consumption");
  assert.ok(start < run, "the token recorder must start BEFORE the impacted-specs run");
  assert.ok(stop > run, "the stop/collect step must come after the impacted-specs run");
  assert.ok(summarizeStep > stop, "the summary must run after the stop/collect step");
  for (const label of ["Start the token consumption recorder", "Stop and collect token consumption", "Summarize token consumption", "Upload token consumption"]) {
    const at = text.indexOf(label);
    assert.ok(at > 0, `pr-validation.yml is missing the "${label}" step`);
    assert.match(
      text.slice(at, at + 400),
      /continue-on-error: true/,
      `the "${label}" step must carry continue-on-error: true — it is diagnostic-only and must never gate the PR`,
    );
  }
});

test("pr-validation's impacted-specs step sets TOKENS_ATTRIB for the cleanup sidecar", () => {
  const text = prValidation();
  const run = text.indexOf("- name: Run impacted specs");
  const nextStep = text.indexOf("- name:", run + 1);
  assert.match(
    text.slice(run, nextStep > 0 ? nextStep : run + 2000),
    /TOKENS_ATTRIB:/,
    "TOKENS_ATTRIB must be set on the impacted-specs step, same as the daily's @stable run step",
  );
});

test("pr-validation's summarize step suppresses the history append (#1183)", () => {
  const text = prValidation();
  const summarizeStep = text.indexOf("- name: Summarize token consumption");
  const nextStep = text.indexOf("- name:", summarizeStep + 1);
  assert.match(
    text.slice(summarizeStep, nextStep > 0 ? nextStep : summarizeStep + 2000),
    /TOKENS_SUPPRESS_HISTORY:\s*"1"/,
    "pr-validation.yml must set TOKENS_SUPPRESS_HISTORY — a capped PR subset must never enter reports/token-history.jsonl's daily series",
  );
});

test("manual's e2e-docker job starts the token recorder before the test run and summarizes after, all steps continue-on-error", () => {
  const text = manual();
  const urlJobAt = text.indexOf("e2e-url:");
  const dockerJobText = text.slice(0, urlJobAt > 0 ? urlJobAt : text.length);
  const start = dockerJobText.indexOf("node scripts/watch-tokens.mjs");
  const exportAttrib = dockerJobText.indexOf("TOKENS_ATTRIB=token-attrib.jsonl");
  const run = dockerJobText.indexOf("Run tests and upload report");
  const stop = dockerJobText.indexOf("Stop and collect token consumption");
  const summarizeStep = dockerJobText.indexOf("Summarize token consumption");
  assert.ok(start > 0, "manual.yml's e2e-docker job no longer starts the token recorder");
  assert.ok(exportAttrib > 0, "manual.yml's e2e-docker job no longer exports TOKENS_ATTRIB");
  assert.ok(run > 0, "manual.yml's e2e-docker job no longer runs the test step");
  assert.ok(stop > 0, "manual.yml's e2e-docker job no longer stops/collects the token recorder");
  assert.ok(summarizeStep > 0, "manual.yml's e2e-docker job no longer summarizes token consumption");
  assert.ok(start < run, "the token recorder must start BEFORE the test run");
  assert.ok(exportAttrib < run, "TOKENS_ATTRIB must be exported BEFORE the test run consumes it");
  assert.ok(stop > run, "the stop/collect step must come after the test run");
  assert.ok(summarizeStep > stop, "the summary must run after the stop/collect step");
  for (const label of ["Start the token consumption recorder", "Stop and collect token consumption", "Summarize token consumption", "Upload token consumption"]) {
    const at = dockerJobText.indexOf(label);
    assert.ok(at > 0, `manual.yml's e2e-docker job is missing the "${label}" step`);
    assert.match(
      dockerJobText.slice(at, at + 400),
      /continue-on-error: true/,
      `the "${label}" step must carry continue-on-error: true — it is diagnostic-only and must never gate a dispatch`,
    );
  }
});

test("manual's summarize step (e2e-docker) suppresses the history append (#1183)", () => {
  const text = manual();
  const urlJobAt = text.indexOf("e2e-url:");
  const dockerJobText = text.slice(0, urlJobAt > 0 ? urlJobAt : text.length);
  const summarizeStep = dockerJobText.indexOf("- name: Summarize token consumption");
  const nextStep = dockerJobText.indexOf("- name:", summarizeStep + 1);
  assert.match(
    dockerJobText.slice(summarizeStep, nextStep > 0 ? nextStep : summarizeStep + 2000),
    /TOKENS_SUPPRESS_HISTORY:\s*"1"/,
    "manual.yml must set TOKENS_SUPPRESS_HISTORY — an arbitrary dispatch scope must never enter reports/token-history.jsonl's daily series",
  );
});

// The recorder polls TOKENS_BASE_URL, which defaults to localhost — e2e-docker's
// own service container, not the external instance e2e-url targets (#1183). A
// recorder started there would only ever log connection-refused errors, so this
// guard pins the omission itself: the recorder must exist ONLY inside the
// e2e-docker job's own text, never inside e2e-url's.
test("the token recorder is NOT wired into manual's e2e-url job (it targets an external Langflow, not localhost)", () => {
  const text = manual();
  const urlJobAt = text.indexOf("e2e-url:");
  assert.ok(urlJobAt > 0, "manual.yml no longer has an e2e-url job — this guard's premise is gone");
  const urlJobText = text.slice(urlJobAt);
  assert.doesNotMatch(
    urlJobText,
    /node scripts\/watch-tokens\.mjs/,
    "the token recorder must not be started in the e2e-url job — it targets an external Langflow, not the localhost the recorder polls",
  );
});
