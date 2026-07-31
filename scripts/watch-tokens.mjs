#!/usr/bin/env node
// In-run token consumption recorder (issue #1197).
//
// WHY THIS EXISTS
//
// The suite spends money on every run and measures none of it. Langflow already
// computes what each flow run cost in tokens — every trace's LLM spans carry
// tokenUsage and modelName — and throws it away: deleting a flow 404s its trace
// (measured, design §2, S4). Since the suite deletes every flow it creates, the
// only place the data can be read is DURING the run.
//
// MODES
//   (default)    poll until SIGTERM/SIGINT (or TOKENS_MAX_SECONDS), appending one
//                JSONL line per newly-seen trace to TOKENS_OUT
//   --summarize  join TOKENS_OUT with TOKENS_ATTRIB, price it, write the history
//                line and the step summary (see the summarize section)
//
// One request per tick: /api/v1/monitor/traces answers WITHOUT flow_id (S2), so the
// tick does not scale with the number of live flows. Detail fetches are capped per
// tick, because a burst of traces must not turn one tick into a hundred requests
// against the single backend whose saturation is already the suite's bottleneck
// (#817/#1048).
//
// DIAGNOSTIC ONLY. Always exits 0. A failed tick is a warning line; a failed run
// yields a summary that says so, never a number that reads as "nothing was spent".
//
// Pure, dependency-free ESM so CI runs it with plain `node` (no ts-node).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregate, parsePrices } from "./lib/token-cost.mjs";
import { detectAnomalies } from "./lib/token-anomaly.mjs";

const DEFAULTS = {
  base: "http://localhost:7860",
  out: "token-probes.jsonl",
  intervalMs: 15000,
  timeoutMs: 8000,
  maxSeconds: 3600,
  detailCap: 25,
};

// How many of the most recent `reports/token-history.jsonl` lines feed the
// anomaly baseline (#1197 review, finding I7). token-anomaly.mjs's
// detectAnomalies() is a pure median over whatever history it is given — it
// does not window itself — so this is enforced here, at the one call site.
const ANOMALY_HISTORY_WINDOW = 20;

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function flattenSpans(spans, acc = []) {
  for (const span of spans ?? []) {
    acc.push(span);
    if (span?.children) flattenSpans(span.children, acc);
  }
  return acc;
}

// Only spans that name their model. Langflow emits the component-level "Language
// Model" span with modelName === null carrying the SAME tokenUsage as the inner
// provider span, so counting every llm span doubles every call (design §2.1).
export function spanModelUsage(spans) {
  const byModel = new Map();
  for (const span of flattenSpans(spans)) {
    const model = typeof span?.modelName === "string" ? span.modelName : "";
    const usage = span?.tokenUsage;
    if (!model || !usage) continue;
    const prompt = Number(usage.promptTokens) || 0;
    const completion = Number(usage.completionTokens) || 0;
    const total = Number(usage.totalTokens) || prompt + completion;
    if (!prompt && !completion && !total) continue;
    const acc =
      byModel.get(model) ??
      { model, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
    acc.prompt_tokens += prompt;
    acc.completion_tokens += completion;
    acc.total_tokens += total;
    acc.calls += 1;
    byModel.set(model, acc);
  }
  return [...byModel.values()];
}

async function getJson(fetchImpl, url, bearer, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULTS.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: bearer ? { Authorization: bearer } : {},
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { unauthorized: true };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { body: await res.json() };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectOnce({
  fetchImpl,
  base,
  bearer,
  seen,
  detailCap = DEFAULTS.detailCap,
  timeoutMs = DEFAULTS.timeoutMs,
}) {
  const probes = [];
  const errors = [];
  let deferred = 0;

  const list = await getJson(fetchImpl, `${base}/api/v1/monitor/traces`, bearer, timeoutMs);
  if (list.unauthorized) return { probes, errors, deferred, refreshAuth: true };
  if (list.error) return { probes, errors: [list.error], deferred, refreshAuth: false };

  const traces = Array.isArray(list.body?.traces) ? list.body.traces : [];
  const fresh = traces.filter((t) => t?.id && !seen.has(t.id));
  const batch = fresh.slice(0, detailCap);
  deferred = fresh.length - batch.length;

  for (const trace of batch) {
    const detail = await getJson(
      fetchImpl,
      `${base}/api/v1/monitor/traces/${trace.id}`,
      bearer,
      timeoutMs,
    );
    if (detail.unauthorized) return { probes, errors, deferred, refreshAuth: true };
    if (detail.error) {
      // A 404 here is S4 happening live: the flow was deleted between the list and
      // this fetch. Mark it seen so the next tick does not retry a trace that is
      // gone for good, and let the summary count it in `unattributed`.
      seen.add(trace.id);
      errors.push(`trace ${trace.id}: ${detail.error}`);
      continue;
    }
    seen.add(trace.id);
    // `|| 0` used to put a ZERO where the value is unknown: a list item without
    // totalTokens recorded 0, which aggregate() then treated as finite and
    // authoritative — totals.total_tokens stayed 0 while by_model showed real
    // tokens, and the trace was flagged as a fake mismatch (#1197 review,
    // finding I3). Emit `null` instead: aggregate()'s spanTotal fallback (and
    // its `Number.isFinite` check on the raw value, not a coerced one — see
    // token-cost.mjs) then does the right thing.
    const traceTotal = Number(trace.totalTokens);
    probes.push({
      trace_id: trace.id,
      flow_id: trace.flowId ?? null,
      start_time: trace.startTime ?? null,
      status: trace.status ?? null,
      total_tokens: Number.isFinite(traceTotal) ? traceTotal : null,
      models: spanModelUsage(detail.body?.spans),
    });
  }
  return { probes, errors, deferred, refreshAuth: false };
}

export function parseProbeLines(text) {
  const probes = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec?.trace_id) probes.push(rec);
    } catch {
      // A torn last line is expected: the recorder is killed mid-append when the
      // job moves on. Skip it rather than failing the summary.
    }
  }
  return probes;
}

async function login(fetchImpl, base, timeoutMs) {
  const res = await getJson(fetchImpl, `${base}/api/v1/auto_login`, undefined, timeoutMs);
  const token = res.body?.access_token;
  return token ? `Bearer ${token}` : undefined;
}

export async function poll({ fetchImpl = fetch, env = process.env, log = console.log } = {}) {
  const base = (env.TOKENS_BASE_URL || DEFAULTS.base).replace(/\/$/, "");
  const out = env.TOKENS_OUT || DEFAULTS.out;
  const intervalMs = num(env.TOKENS_INTERVAL_MS, DEFAULTS.intervalMs);
  const timeoutMs = num(env.TOKENS_TIMEOUT_MS, DEFAULTS.timeoutMs);
  const maxSeconds = num(env.TOKENS_MAX_SECONDS, DEFAULTS.maxSeconds);
  const detailCap = num(env.TOKENS_DETAIL_CAP, DEFAULTS.detailCap);
  const deadline = Date.now() + maxSeconds * 1000;
  const seen = new Set();
  let bearer = await login(fetchImpl, base, timeoutMs);
  let stop = false;
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => (stop = true));

  let ticks = 0;
  let recorded = 0;
  // A permanently unauthorized poller used to produce NO diagnostic at all:
  // collectOnce() returns `refreshAuth: true` with an empty errors[], so the
  // per-tick error log below never fired, and a run where login() keeps
  // failing ended with "0 trace(s) recorded" and no clue why (#1197 review,
  // finding I4). Track the length of the CURRENT unauthorized streak so the
  // final line can name it — and reset on any tick that isn't unauthorized, so
  // a transient blip early in the run doesn't mislabel a healthy finish.
  let consecutiveAuthFailures = 0;
  while (!stop && Date.now() < deadline) {
    const tick = await collectOnce({ fetchImpl, base, bearer, seen, detailCap, timeoutMs });
    ticks += 1;
    if (tick.refreshAuth) {
      consecutiveAuthFailures += 1;
      log(
        `token watcher: unauthorized (401/403) — refreshing the login token ` +
          `(${consecutiveAuthFailures} consecutive tick(s))`,
      );
      bearer = await login(fetchImpl, base, timeoutMs);
    } else {
      consecutiveAuthFailures = 0;
    }
    for (const probe of tick.probes) {
      try {
        fs.appendFileSync(out, `${JSON.stringify(probe)}\n`);
        recorded += 1;
      } catch (error) {
        // Losing a probe line is preferable to killing the recorder: the summary
        // degrades, the run is unaffected.
        log(`token watcher: could not append a probe: ${error?.message || error}`);
      }
    }
    for (const error of tick.errors) log(`token watcher: ${error}`);
    if (tick.deferred) log(`token watcher: ${tick.deferred} trace(s) deferred to the next tick`);
    // Back off when the backend is not answering: the wedge (#922/#1048) must not
    // be hammered by a diagnostic.
    const wait = tick.errors.length && !tick.probes.length ? intervalMs * 2 : intervalMs;
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  // Name unauthorized in the final line whenever the run ENDED on an auth
  // failure streak — not just when zero traces were recorded, since a poller
  // that authenticated fine for an hour and then lost its token for the last
  // few ticks deserves the same visibility.
  const authSuffix = consecutiveAuthFailures
    ? ` (unauthorized on the last ${consecutiveAuthFailures} consecutive tick(s) — check TOKENS_BASE_URL / credentials, not tracing)`
    : "";
  log(`token watcher: ${recorded} trace(s) recorded over ${ticks} tick(s) → ${out}${authSuffix}`);
  return 0;
}

// Headline figure (the summary's own total line, and the matching stdout log
// line). Originally a fixed 2 decimals — readable at the usual run-total
// scale, but a single-trace run can legitimately total under a cent
// ($0.0000348 for one gpt-4o-mini call), and 2-decimal rounding rendered that
// as a bare "$0.00" sitting directly above its own non-zero per-model row
// ("**88 tokens** across 1 trace(s) — $0.00" over "$0.000035") — the same
// constraint finding I5 raised, just at the two places a reader looks FIRST
// (#1197 re-review). Scale precision to magnitude, same idea as
// `usdDetail` below: 2 decimals once the total clears a cent (so an ordinary
// $4.82 run still reads "$4.82", not "$4.820000"), 6 decimals under that (so
// a real sub-cent total doesn't read as zero).
const usd = (n) => {
  if (n === null || n === undefined) return "n/a";
  const decimals = Math.abs(n) < 0.01 ? 6 : 2;
  return `$${n.toFixed(decimals)}`;
};

// Detail-level $ figures (per-model, per-spec, anomaly lines): a single trace
// commonly costs a fraction of a cent ($0.000035 is a real value, not noise),
// and 2-decimal rounding renders that indistinguishable from a model that spent
// nothing — "🔺 run: $0.00 vs a $0.00 baseline (6×)" is a contradiction, not a
// report (#1197 review, finding I5). Scale precision to magnitude instead of
// picking one fixed decimal count: sub-cent amounts get 6 decimals (enough to
// show a real value), everything at or above a cent gets 4 (enough to show
// real cents-level differences without a wall of trailing zeros on ordinary
// run-level costs).
const usdDetail = (n) => {
  if (n === null || n === undefined) return "n/a";
  const decimals = Math.abs(n) < 0.01 ? 6 : 4;
  return `$${n.toFixed(decimals)}`;
};

// Injected I/O so the summarizer is unit-testable without a filesystem: CI passes
// none of these and gets the real fs.
const realIo = {
  readFile: (p) => fs.readFileSync(p, "utf8"),
  listDir: (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : []),
  // GITHUB_STEP_SUMMARY is append-only by GitHub's own documented contract: the
  // merge job's `Report mid-run backend outages` step (#1030) runs BEFORE this
  // one and appends its own section. `writeFileSync` would silently delete that
  // section on exactly the red days it matters (#1197 review, finding C1).
  writeFile: (p, text) => fs.appendFileSync(p, text),
  appendFile: (p, text) => fs.appendFileSync(p, text),
};

export async function summarize({
  env = process.env,
  readFile = realIo.readFile,
  listDir = realIo.listDir,
  writeFile = realIo.writeFile,
  appendFile = realIo.appendFile,
  log = console.log,
} = {}) {
  const dir = env.TOKENS_DIR || "all-tokens";
  const attribDir = env.TOKENS_ATTRIB_DIR || dir;
  const historyPath = env.TOKENS_HISTORY || "reports/token-history.jsonl";
  const summaryPath = env.TOKENS_SUMMARY_MD || env.GITHUB_STEP_SUMMARY;

  const read = (p) => {
    try {
      return readFile(p);
    } catch {
      return "";
    }
  };

  const probesById = new Map();
  for (const file of listDir(dir).filter((f) => f.includes("token-probes"))) {
    for (const probe of parseProbeLines(read(file))) probesById.set(probe.trace_id, probe);
  }
  const attributions = [];
  for (const file of listDir(attribDir).filter((f) => f.includes("token-attrib"))) {
    for (const rec of parseProbeLines(read(file))) attributions.push(rec);
  }

  const lines = [];
  // `Number("")` is `0`, so an unset/blank TESTS_TOTAL used to be
  // indistinguishable from a genuine "0" — reported as "the run executed zero
  // tests (infra abort)" even when real trace data existed and should have been
  // priced (#1197 review, minor fix). Treat a missing/empty value as UNKNOWN,
  // never as zero: only a literal "0" (or the run's own totalsTotal computing to
  // 0) counts as an infra abort.
  const rawTestsTotal = env.TESTS_TOTAL;
  const testsTotal =
    rawTestsTotal === undefined || rawTestsTotal === "" ? NaN : Number(rawTestsTotal);
  const zeroTestRun = Number.isFinite(testsTotal) && testsTotal === 0;

  if (!probesById.size || zeroTestRun) {
    // Both cases are silences, and a silence must never read as "nothing was spent"
    // (#1012's rule applied to cost). No history line is written either way: a
    // zero would enter the baseline and lower the bar for every future anomaly.
    //
    // The "no traces" branch used to name only two candidate causes — tracing
    // disabled, or no LLM call — which excluded the likeliest one on a run
    // where login() kept failing: `poll()` returns "0 trace(s) recorded" with
    // no other signal, and this message would blame tracing (#1197 review,
    // finding I4). Name a permanently unauthorized poller as a third candidate;
    // this file has no direct evidence either way, so it is named as a
    // possibility to check, the same way the other two are.
    const why = zeroTestRun
      ? "the run executed zero tests (infra abort) — no cost line written"
      : "no traces recorded — tracing may be disabled on the target (LANGFLOW_DEACTIVATE_TRACING), the poller could not authenticate (check TOKENS_BASE_URL / credentials — see the recorder's own log for consecutive 401/403 ticks), or the run made no LLM call";
    lines.push("## Token consumption", "", `⚠️ ${why}.`, "");
    writeSummary(writeFile, summaryPath, lines.join("\n"), log);
    log(`token summary: ${why}`);
    return 0;
  }

  let prices = {};
  try {
    prices = parsePrices(readFile(env.TOKENS_PRICES || "scripts/lib/model-prices.json"));
  } catch (error) {
    log(`token summary: price table unreadable (${error.message}) — reporting tokens only`);
  }

  const agg = aggregate({ probes: [...probesById.values()], attributions, prices });
  const history = parseHistory(read(historyPath));
  const runLine = {
    version: 1,
    date: env.RUN_DATE || new Date().toISOString().slice(0, 10),
    workflow: env.WORKFLOW || "unknown",
    run_id: env.GITHUB_RUN_ID || null,
    run_url:
      env.GITHUB_RUN_ID && env.GITHUB_REPOSITORY
        ? `${env.GITHUB_SERVER_URL || "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : null,
    langflow_image: env.LANGFLOW_IMAGE || null,
    totals: agg.totals,
    by_model: agg.byModel,
    by_spec: agg.bySpec,
    unattributed: agg.unattributed,
    unpriced_models: agg.unpricedModels,
    anomalies: [],
  };
  // token-anomaly.mjs computes a plain median over whatever `history` it is
  // given — it does NOT window to "the last N lines" itself (see that module's
  // own comment). Window HERE, at the call site: an all-time median stays
  // anchored to the run's cheapest early days for as long as the file exists,
  // so after deliberate suite growth the baseline never catches up and the
  // run-scope anomaly fires every day forever (#1197 review, finding I7).
  runLine.anomalies = detectAnomalies({ run: runLine, history: history.slice(-ANOMALY_HISTORY_WINDOW) });

  // Writing the history line is the summarizer's one durable side effect. Losing it
  // to a bad path/full disk must degrade the run's cost visibility, not the run
  // itself — same reasoning as poll()'s own appendFileSync guard above.
  try {
    appendFile(historyPath, `${JSON.stringify(runLine)}\n`);
  } catch (error) {
    log(`token summary: could not append the history line: ${error?.message || error}`);
  }

  const floor = agg.unpricedModels.length
    ? ` (a FLOOR — ${agg.unpricedModels.length} model(s) have no price entry: ${agg.unpricedModels.join(", ")})`
    : "";
  lines.push(
    "## Token consumption",
    "",
    `**${agg.totals.total_tokens.toLocaleString("en-US")} tokens** across ${agg.totals.traces} trace(s) — ${usd(agg.totals.usd_estimated)}${floor}`,
    "",
    "| Model | Calls | Prompt | Completion | Estimated |",
    "|---|---:|---:|---:|---:|",
    ...agg.byModel.map(
      (m) =>
        `| \`${m.model}\` | ${m.calls} | ${m.prompt_tokens} | ${m.completion_tokens} | ${usdDetail(m.usd_estimated)} |`,
    ),
    "",
    `Unattributed: ${agg.unattributed.traces} trace(s), ${agg.unattributed.total_tokens.toLocaleString("en-US")} tokens — ${agg.unattributed.reason}`,
    "",
  );
  if (agg.bySpec.length) {
    lines.push(
      "| Spec | Traces | Tokens | Estimated |",
      "|---|---:|---:|---:|",
      ...agg.bySpec
        .slice(0, 15)
        .map((s) => `| \`${s.file}\` | ${s.traces} | ${s.total_tokens} | ${usdDetail(s.usd_estimated)} |`),
      "",
    );
    if (agg.bySpec.length > 15) lines.push(`…and ${agg.bySpec.length - 15} more spec(s) in the history file.`, "");
  }
  if (agg.mismatches.length) {
    lines.push(
      `⚠️ ${agg.mismatches.length} trace(s) whose own total disagrees with the sum of their model spans — reported, not reconciled.`,
      "",
    );
  }
  for (const a of runLine.anomalies) {
    lines.push(
      `🔺 **${a.scope}** \`${a.key}\`: ${usdDetail(a.run_usd)} vs a ${usdDetail(a.baseline_usd)} baseline (${a.ratio}×).`,
    );
  }
  writeSummary(writeFile, summaryPath, lines.join("\n"), log);
  log(`token summary: ${agg.totals.total_tokens} tokens, ${usd(agg.totals.usd_estimated)}${floor}`);
  return 0;
}

// Writing the step summary is best-effort: a bad TOKENS_SUMMARY_MD path (or none —
// GITHUB_STEP_SUMMARY is unset outside CI) must not stop the summarizer, which is
// diagnostic-only by contract. `writeFile` APPENDS (see realIo.writeFile above) —
// never assume this is the only writer of the target path within the job, which
// is exactly why the text must be newline-terminated: whichever branch built
// `lines` can end on a section with no trailing blank entry (the anomaly loop's
// last push has none), and an un-terminated append here would run its content
// into whatever the NEXT job step appends after it (#1197 re-review, Low).
// Guaranteed here, once, rather than at every call site.
function writeSummary(writeFile, summaryPath, text, log) {
  if (!summaryPath) return;
  const terminated = text.endsWith("\n") ? text : `${text}\n`;
  try {
    writeFile(summaryPath, terminated);
  } catch (error) {
    log(`token summary: could not write the step summary: ${error?.message || error}`);
  }
}

export function parseHistory(text) {
  const lines = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line));
    } catch {
      // A hand-edited or truncated history line must not stop the summary; the file
      // is machine-written by contract (reports/README.md).
    }
  }
  return lines;
}

async function main() {
  try {
    const code = process.argv.includes("--summarize") ? await summarize() : await poll();
    return code === undefined ? 0 : code;
  } catch (error) {
    // Diagnostics never break the build.
    console.log(`token watcher: recorder error (ignored): ${error?.stack || error}`);
    return 0;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(await main());
}
