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
// TOKENS_SUPPRESS_HISTORY=1 (#1183): --summarize still renders the step-summary
// table, but skips reading AND writing reports/token-history.jsonl entirely.
// For pr-validation.yml / manual.yml — lanes whose per-run scope (a capped PR
// subset, an arbitrary manual dispatch) is not comparable to the daily's fixed
// @stable sweep, so mixing it into that one series would corrupt the trend and
// the anomaly baseline. Never silent about it: both the log and the step
// summary say the append was suppressed and why.
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
// flattenSpans/spanModelUsage/buildProbe moved to lib/token-spans.mjs (#1197
// re-review, finding A) so the attribution sidecar (a TypeScript file under
// tests/helpers/) can import the SAME rules instead of reimplementing the
// anti-double-count logic. Re-exported below for backward compatibility with
// existing direct imports of this module (scripts/watch-tokens.test.mjs).
import { flattenSpans, spanModelUsage, buildProbe } from "./lib/token-spans.mjs";

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

// Re-exported from lib/token-spans.mjs — see the import comment above.
export { flattenSpans, spanModelUsage };

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
    // buildProbe (lib/token-spans.mjs) is the ONE place that decides how a
    // trace + its spans become a probe — including the total_tokens: null
    // rule for an unknown total (#1197 review, finding I3) and the
    // modelName-bearing-spans-only rule (design §2.1). The attribution
    // sidecar (tests/helpers/flows/token-attribution.ts) builds its own
    // recovered probes through the SAME function (#1197 re-review, finding A)
    // — this is not the only caller.
    probes.push(buildProbe(trace, detail.body?.spans));
  }
  return { probes, errors, deferred, refreshAuth: false };
}

function parseJsonLines(text) {
  const records = [];
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A torn last line is expected: the recorder is killed mid-append when the
      // job moves on. Skip it rather than failing the summary.
    }
  }
  return records;
}

export function parseProbeLines(text) {
  return parseJsonLines(text).filter((rec) => rec?.trace_id);
}

// The token-attrib file carries TWO record shapes, and this is why it is not read
// through parseProbeLines (§4.3, fix round 2):
//
//   - attribution lines, which carry a `trace_id` (and, since finding A, the
//     trace's own probe fields alongside);
//   - the sidecar's own COST records — `kind: "attrib_cost"`, one per
//     `recordTokenAttribution` call (one per teardown only for a
//     batch-attributing `cleanup()`; one per flow on the far more common
//     per-id `deleteFlow` path — see the comment on `attrib_ms`/`attrib_calls`
//     below), carrying no trace_id at all.
//
// parseProbeLines filters on `trace_id`, so it would drop every cost record on the
// floor and the teardown cost would silently never reach the history line. Keep both
// shapes here; summarize() splits them explicitly, immediately.
export function parseAttribLines(text) {
  return parseJsonLines(text).filter((rec) => rec?.trace_id || rec?.kind === "attrib_cost");
}

// Split the token-attrib file's two record shapes apart. A cost record is NOT an
// attribution: it names no trace, and leaving one in `attributions` would put a
// phantom entry in aggregate()'s `byTrace` map and let a teardown be mistaken for a
// spec that spent nothing.
//
// A pure function with its own test, deliberately (§4.3, fix round 3). Inlined in
// summarize() the EXCLUSION was untestable — a cost record left in `attributions` is
// invisible downstream, because aggregate() happens to guard on `trace_id` — so the
// test that claimed to cover it could only ever observe the collection. Exported so
// the exclusion itself can be asserted directly.
export function splitAttribRecords(records = []) {
  const attributions = [];
  const costs = [];
  for (const rec of records) {
    if (rec?.kind === "attrib_cost") costs.push(rec);
    else attributions.push(rec);
  }
  return { attributions, costs };
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

// Escapes a `|` so an arbitrary test title cannot shred a markdown table row —
// unlike `file`, which is a path this repo controls, `test` is a title a spec
// author wrote and could, in principle, contain a pipe.
const cell = (text) => String(text ?? "").replace(/\|/g, "\\|");

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
  const summaryOutPath = env.TOKENS_SUMMARY_OUT;
  // Measurement-only lanes (#1183 — pr-validation.yml, manual.yml). Those lanes
  // want the step-summary table (so the run's own spend is visible) but must
  // NEVER add a line to reports/token-history.jsonl: that file is the daily's
  // series, one line per FULL @stable sweep, and its anomaly baseline
  // (detectAnomalies() above) is a plain median over recent entries. A PR's
  // scope is whatever subset of specs the import graph selected for THAT PR
  // (capped, often zero LLM specs at all) and a manual dispatch's scope is
  // whatever tag/grep was chosen — neither is comparable to the daily's fixed
  // sweep, so writing either into the same series would corrupt the trend and
  // silently poison every anomaly check that follows. Skips the read too (not
  // just the write): comparing a bounded PR/manual run's totals against the
  // daily's own baseline would produce a false anomaly on nearly every run.
  const suppressHistory = /^(1|true)$/i.test(env.TOKENS_SUPPRESS_HISTORY || "");

  const read = (p) => {
    try {
      return readFile(p);
    } catch {
      return "";
    }
  };

  const probesById = new Map();
  // A trace can now be seen by TWO independent sources (#1197 re-review,
  // finding A): the poller's own tick, and the attribution sidecar's own
  // detail fetch (run moments before the flow — and its trace — 404s away,
  // design §2/S4). A trace present in both must be counted exactly once, and
  // when the two copies disagree on whether the total is known, the one that
  // actually captured it wins — never let a copy that missed it (total_tokens:
  // null) clobber a copy that didn't, regardless of which file is read first.
  const mergeProbe = (probe) => {
    if (!probe?.trace_id) return;
    const existing = probesById.get(probe.trace_id);
    if (!existing || (existing.total_tokens === null && probe.total_tokens !== null)) {
      probesById.set(probe.trace_id, probe);
    }
  };
  for (const file of listDir(dir).filter((f) => f.includes("token-probes"))) {
    for (const probe of parseProbeLines(read(file))) mergeProbe(probe);
  }
  const attributions = [];
  // The sidecar's own COST records (§4.3) share the token-attrib file with the
  // attribution lines. splitAttribRecords() separates them EXPLICITLY — see its own
  // comment for why that split is a tested function rather than an inline branch.
  const costs = [];
  for (const file of listDir(attribDir).filter((f) => f.includes("token-attrib"))) {
    const split = splitAttribRecords(parseAttribLines(read(file)));
    costs.push(...split.costs);
    for (const rec of split.attributions) {
      attributions.push(rec);
      // The sidecar now writes the trace's own total + spans ALONGSIDE the
      // attribution fields in the same line (finding A), so an attributed
      // trace's tokens no longer depend on the poller's own tick landing
      // before the flow is deleted. `"total_tokens" in rec` (not just
      // truthiness — the value is legitimately `null` when the sidecar's own
      // detail fetch failed) distinguishes a merged probe+attribution line
      // from an older, attribution-only line that never carried these fields.
      if ("total_tokens" in rec) mergeProbe(rec);
    }
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

  // Computed ONCE and threaded to both aggregate()'s date-scoped band selection
  // (#1211) and the history line's own `date` field below — the two must never
  // disagree, or a dated model's USD would be priced against a different date
  // than the one the line claims it ran on.
  const runDate = env.RUN_DATE || new Date().toISOString().slice(0, 10);
  const agg = aggregate({ probes: [...probesById.values()], attributions, costs, prices, date: runDate });
  const history = suppressHistory ? [] : parseHistory(read(historyPath));
  const runLine = {
    version: 1,
    date: runDate,
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
    // §4.3: what the attribution sidecar COST this run — the price, on the same
    // line as the benefit it bought. Without it the ceiling is a claim in a doc
    // comment that nobody can check against a real run.
    //
    // **Both fields are DEFINED in `reports/README.md`'s `token-history.jsonl`
    // row** — what they measure, what they do not, and the trap in dividing one by
    // the other. Not restated here: the field appeared in four places with four
    // copies of the same paragraph, and four copies drift.
    //
    // The only rule that belongs at THIS site: copy both from `agg`, never
    // re-derive either from `attributions`.
    attrib_ms: agg.attrib_ms,
    attrib_calls: agg.attrib_calls,
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
  //
  // Suppressed deliberately on measurement-only lanes (#1183, see the
  // `suppressHistory` comment above) — logged here rather than silently
  // skipped, so a reader of the run log is never left wondering why the file
  // did not change (#1012's "never silently" rule applied to this knob).
  if (suppressHistory) {
    log(
      "token summary: TOKENS_SUPPRESS_HISTORY set — history line NOT written " +
        "(this lane's scope is not comparable to reports/token-history.jsonl's " +
        "daily series, #1183)",
    );
  } else {
    try {
      appendFile(historyPath, `${JSON.stringify(runLine)}\n`);
    } catch (error) {
      log(`token summary: could not append the history line: ${error?.message || error}`);
    }
  }

  // §5.2: the block the merge step folds into payload.json and re-POSTs. Field
  // names are the INGEST RPC's, not this module's -- the authority is
  // quality-platform's 20260803130300_e2e_ingest_run_tokens.sql, which
  // destructures exactly `traces`, `total_tokens`, `span_tokens`,
  // `mismatch_traces` and `rows[]`. Everything else here (unattributed,
  // attrib_*) is accepted and ignored until the platform reads it (§6.3).
  //
  // Written ONLY on a run that captured something: this code sits below the
  // zero-capture early return on purpose. A block of zeros would clamp the run's
  // token columns to 0, which is indistinguishable from a run that genuinely
  // spent nothing -- the distinction that table exists to keep.
  if (summaryOutPath) {
    const block = {
      traces: agg.totals.traces,
      total_tokens: agg.totals.total_tokens,
      span_tokens: agg.spanTokens,
      mismatch_traces: agg.mismatches.length,
      unattributed: agg.unattributed,
      attrib_ms: agg.attrib_ms,
      attrib_calls: agg.attrib_calls,
      rows: agg.bySpecModel,
    };
    try {
      writeFile(summaryOutPath, JSON.stringify(block));
    } catch (error) {
      log(`token summary: could not write the tokens block: ${error?.message || error}`);
    }
  }

  const floor = agg.unpricedModels.length
    ? ` (a FLOOR — ${agg.unpricedModels.length} model(s) have no price entry: ${agg.unpricedModels.join(", ")})`
    : "";
  lines.push(
    "## Token consumption",
    "",
    `**${agg.totals.total_tokens.toLocaleString("en-US")} tokens** across ${agg.totals.traces} trace(s) — ${usd(agg.totals.usd_estimated)}${floor}`,
    "",
  );
  if (suppressHistory) {
    // Same "never silently" rule as the log line above (#1012), stated where a
    // human reading the run's own step summary — not just its raw log — would
    // otherwise wonder why reports/token-history.jsonl did not change.
    lines.push(
      "_History append suppressed for this lane (`TOKENS_SUPPRESS_HISTORY`) — " +
        "this run's numbers are a per-run measurement only, not part of " +
        "`reports/token-history.jsonl`'s daily trend/anomaly series (#1183)._",
      "",
    );
  }
  lines.push(
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
      // bySpec is keyed by file + test (#1197 re-review, run 30651081641) —
      // rendering only `file` made two different tests in the same spec file
      // print as two identical-looking rows with different numbers, reading
      // as a bug in the tool to a human looking at the artifact. Keep the
      // file first (it's what a reader greps for) with the test title on its
      // own line beneath, via `<br>` (GitHub renders raw HTML inside a table
      // cell) — a second "Test" column would double the table's width at
      // this repo's typical file-path length. Grain, history shape, and sort
      // order are all unchanged; this is a rendering-only fix.
      ...agg.bySpec
        .slice(0, 15)
        .map(
          (s) =>
            `| \`${s.file}\`<br>${cell(s.test)} | ${s.traces} | ${s.total_tokens} | ${usdDetail(s.usd_estimated)} |`,
        ),
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
