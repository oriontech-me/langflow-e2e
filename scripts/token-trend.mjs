#!/usr/bin/env node
// Read reports/token-history.jsonl as a TREND, which raw totals cannot be read as.
// Run with: npm run tokens:trend
//
// #1300 item 4 asked for "a stated read once there are five consecutive lines with
// no instrument change between them — the mean, the range, and whether the anomaly
// detector's baseline is behaving". Two things had to be settled before that read
// could mean anything, and both came out of the data rather than out of theory.
//
// 1. THE RAW TOTAL IS NOT A SPEND RATE. It tracks how much of the suite ran. The
//    three lines on file when this was written go 8,741 → 67,099 → 2,592 tokens, a
//    26x spread, and the low one is not a cheap day: it is 2026-08-05, a run
//    degraded by 24 failures and 27 skips that made 4 LLM calls. Per LLM CALL the
//    same three lines are 728 / 1,289 / 635 — a 2x spread. The denominator is
//    already on every line (`by_model[].calls`), so this needs no new field and no
//    change to the instrument, which matters because a change to the instrument is
//    what restarts the window being waited for.
//
// 2. TOKENS AND DOLLARS DO NOT HAVE THE SAME EXPOSURE, so one rule for both is
//    wrong in one direction or the other. A token count is MEASURED — it survives
//    a pricing edit untouched. A dollar figure is COMPUTED at run time from
//    scripts/lib/model-prices.json, so a row added or repriced inside the window
//    makes two lines answer different questions. Applied to the same three lines:
//    all three are comparable in tokens (the instrument changes between them were
//    the attrib_* fields and pricing), and none of them are comparable in dollars.
//    Treating the whole line as poisoned would have discarded the figure that was
//    fine, which is #1252's mistake in a different file.
//
// WHAT THIS CANNOT SEE, and therefore refuses to assert. The only instrument
// changes visible in the data are the two SHAPE flags (`attrib_ms`/`attrib_calls`,
// added #1217; `by_provider`, added #1300) and the `version` field. Everything else
// is invisible: a repricing, a change to how totals are summed, the dedup rule,
// TOKENS_DETAIL_CAP, the poll interval. So BOTH rates need a claim the reader makes
// — `--measurement-stable` for tokens, `--prices-stable` for dollars — and neither
// defaults to true. An earlier version required a claim for dollars only, which
// left the token rate asserting a stability nothing had checked. Fail-closed, per
// the rule the rest of the repo's verdict scripts follow: an unverified comparison
// is not a comparison (#1012).
//
// `npm run tokens:trend` passes no flags, so the npm entry point always refuses;
// pass them through with `npm run tokens:trend -- --measurement-stable`.

import fs from "node:fs";

export const MIN_WINDOW = 5; // token-anomaly.mjs's minBaseline — the read and the detector agree

// Everything about a line that decides whether it can be compared to its
// neighbour, plus the figures the read is over. `calls` is summed from by_model
// rather than read from a field, because there is no field: it is the only
// denominator the schema already carries.
// A figure the schema promises as a NUMBER. `Number()` alone is not enough:
// `Number(null)` is 0 and passes `isFinite`, so a null slipped through as a
// measured zero — the same trap this module fixes elsewhere, one level down.
const figure = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function describeLine(line) {
  // UNDECIDABLE, not zero, when the denominator cannot be read. `by_model` absent,
  // empty, or carrying a non-numeric `calls` used to collapse to `calls: 0`, which
  // this module then announced as "recorded no LLM call" — a line with 152 traces
  // reported as a quiet day. That is the exact #1012/#1252 rule this file invokes
  // three times, broken in its own denominator.
  const models = Array.isArray(line.by_model) ? line.by_model : null;
  const callCounts = models?.map((m) => figure(m?.calls));
  const calls = callCounts && callCounts.every((n) => n !== null) ? callCounts.reduce((a, b) => a + b, 0) : null;

  // SPAN-derived, to match the denominator. `totals.total_tokens` is
  // trace-authoritative and the two legitimately differ (reports/README.md:
  // "reconcile against by_model, never against totals"), so dividing one by the
  // other mixes bases — measured at 2.05% on the 2026-08-05 line. Note what does
  // NOT explain that gap: `mismatches` is ABSENT from every history line (the
  // summarizer never writes it; only the POSTed block carries `mismatch_traces`),
  // so there is no per-line signal to reconcile against at all. An earlier version
  // of this comment cited "an empty mismatches[]" as evidence, which was invented
  // — the field is not there to be empty. The raw total is reported, as itself,
  // below.
  const modelTokens = models?.map((m) => figure(m?.total_tokens));
  const spanTokens = modelTokens && modelTokens.every((n) => n !== null) ? modelTokens.reduce((a, b) => a + b, 0) : null;
  // Undecidable in the NUMERATOR too. The first pass at this rule fixed the
  // denominator and left `Number(…) || 0` one line above, so a corrupt
  // `total_tokens` still produced a MEASURED rate of 0 — and a measured zero is
  // the one value #1252 says an unreadable entry must never become.
  const tokens = figure(line.totals?.total_tokens);
  const usd = line.totals?.usd_estimated;
  return {
    date: line.date,
    run_id: line.run_id,
    workflow: line.workflow,
    traces: figure(line.totals?.traces) ?? 0,
    specs: (line.by_spec ?? []).length,
    calls,
    tokens,
    spanTokens,
    usd: typeof usd === "number" ? usd : null,
    // Unpriced models make the line's dollars a FLOOR, so they are excluded from a
    // dollar mean for the same reason a skipped file is excluded from a duration
    // table: it is not a low number, it is a partial one.
    priced: (line.unpriced_models ?? []).length === 0,
    tokensPerCall: calls > 0 && spanTokens !== null ? spanTokens / calls : null,
    usdPerCall: calls > 0 && typeof usd === "number" ? usd / calls : null,
    // The instrument shape this file can actually observe. Two lines whose shapes
    // differ came from different summarizers; two whose shapes agree MIGHT still
    // differ in pricing, which is why the dollar read needs an explicit claim.
    version: line.version ?? null,
    shape: [
      line.attrib_calls === undefined ? "no-attrib" : "attrib",
      line.by_provider === undefined ? "no-provider" : "provider",
    ].join("+"),
  };
}

// The longest run of lines, ending at the newest, that share one observable shape.
// Ending at the newest is deliberate: an older stable stretch is history, and the
// question being asked is whether TODAY's series can be read.
export function trailingWindow(described) {
  if (!described.length) return [];
  const shape = described[described.length - 1].shape;
  let start = described.length;
  while (start > 0 && described[start - 1].shape === shape) start -= 1;
  return described.slice(start);
}

function stats(values) {
  const usable = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!usable.length) return null;
  const sorted = [...usable].sort((a, b) => a - b);
  return {
    n: usable.length,
    mean: usable.reduce((a, b) => a + b, 0) / usable.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

// A line that recorded no LLM call has no rate to contribute and is excluded from
// the mean rather than counted as a zero — a zero here would drag the rate down
// exactly the way an unmeasured file's 0 s dragged the duration table (#1252).
// The longest run of lines, ending at the newest, that share a shape AND carry a
// rate. "Five CONSECUTIVE lines, and a line that measured nothing is not one of
// them" is what reports/README.md promises; counting five rated lines ANYWHERE
// inside a longer shape run is a different, weaker statement, and the two coincide
// only at exactly five lines — which is the only case the tests used to cover.
function trailingRated(window) {
  let start = window.length;
  while (start > 0 && window[start - 1].tokensPerCall !== null) start -= 1;
  return window.slice(start);
}

export function readTrend(lines, { pricesStable = false, measurementStable = false } = {}) {
  const described = lines.map(describeLine);
  const window = trailingWindow(described);
  const rated = trailingRated(window);
  const dollarLines = rated.filter((l) => l.priced);

  const gaps = [];
  if (window.length < MIN_WINDOW) {
    gaps.push(
      `only ${window.length} consecutive line(s) share the current instrument shape ` +
        `(${described[described.length - 1]?.shape ?? "n/a"}); ${MIN_WINDOW} are needed. ` +
        "token-anomaly.mjs also reports NO anomaly below this count, so every " +
        "`anomalies: []` so far is empty by construction, not a verdict.",
    );
  }
  if (window.length !== rated.length) {
    const unrated = window.length - rated.length;
    gaps.push(
      `${unrated} line(s) in the window carry no rate (no LLM call recorded, or an unreadable ` +
        "by_model), which breaks the consecutive run — the streak is counted from the newest " +
        "line backwards and stops at the first of them",
    );
  }
  // The asymmetric half, and the reason it is stated rather than assumed: the shape
  // string is two flags over field PRESENCE, so a change to what is measured — how
  // totals are summed, the dedup rule, TOKENS_DETAIL_CAP, the poll interval, even a
  // `version` bump — leaves the shape identical and the window looking clean. This
  // file cannot see any of it. Neither claim defaults to true.
  if (!measurementStable) {
    gaps.push(
      "the TOKEN rate is unverified for measurement drift: the shape check only sees whether " +
        "`attrib_*` and `by_provider` are present, so a change to how tokens are summed or " +
        "captured is invisible here. Re-run with --measurement-stable after confirming no PR " +
        "touched scripts/watch-tokens.mjs or scripts/lib/token-cost.mjs in the window.",
    );
  }
  if (!pricesStable) {
    gaps.push(
      "no dollar trend: this file records no pricing version, so a repriced row inside " +
        "the window is invisible here. Re-run with --prices-stable after confirming no PR " +
        "touched scripts/lib/model-prices.json in the window.",
    );
  } else if (dollarLines.length !== rated.length) {
    gaps.push(`${rated.length - dollarLines.length} line(s) have unpriced models — their dollars are a FLOOR, excluded`);
  }
  // Scoped to the WINDOW, and a hard gate rather than advice. Computing it over
  // the whole file raised the warning for a version change safely outside the
  // window while leaving `readable: true` for one INSIDE it — advisory on the one
  // instrument change this file can actually observe, while the unobservable
  // `--measurement-stable` claim was the hard gate. That is the fail-closed logic
  // backwards.
  const versions = new Set(window.map((l) => l.version));
  const mixedVersions = versions.size > 1;
  if (mixedVersions) gaps.push(`the window mixes schema versions (${[...versions].join(", ")}) — compare within one`);

  return {
    lines: described,
    window,
    rated,
    // The headline figure. Per CALL, never the raw total: the raw total measures
    // how much of the suite ran that day.
    tokensPerCall: stats(rated.map((l) => l.tokensPerCall)),
    usdPerCall: pricesStable ? stats(dollarLines.map((l) => l.usdPerCall)) : null,
    // Over the WINDOW, not over `rated`: this figure is explicitly "how much of the
    // suite ran", and a run with no LLM call is a legitimate — indeed the most
    // informative — data point for that question. Only the RATE excludes it.
    rawTokens: stats(window.map((l) => l.tokens)),
    readable: rated.length >= MIN_WINDOW && measurementStable && !mixedVersions,
    gaps,
  };
}

export function render(trend) {
  const out = ["# token-history trend (#1300 item 4)", ""];
  // The VERDICT comes first when there is no rate to quote. #1226's lesson was
  // "counts before caveats", and applying it literally here put a
  // copy-pasteable `962 (range 635–1289)` above a line saying it is not a rate —
  // the figure this tool exists to withhold, rendered as its headline. When the
  // read IS supported the counts lead, as that lesson intends.
  if (!trend.readable) {
    out.push(
      "> ⚠️ **NOT a rate.** The figures below are provisional and must not be quoted as a trend.",
      ...trend.gaps.map((gap) => `> - ${gap}`),
      "",
    );
  }
  // `span tokens` is a column rather than an internal: without it the row does not
  // reconcile — 2,592 ÷ 4 is 648, while `tokens/call` reads 635, because the rate
  // divides SPAN tokens (2,540) by span calls. A table a reader cannot check by
  // arithmetic invites them to assume one of the two numbers is wrong.
  out.push("| date | run | specs | calls | tokens (trace) | span tokens | tokens/call | usd/call | shape |");
  out.push("|---|---|---:|---:|---:|---:|---:|---:|---|");
  const inWindow = new Set(trend.window.map((l) => l.run_id));
  for (const l of trend.lines) {
    const mark = inWindow.has(l.run_id) ? "" : " _(outside window)_";
    out.push(
      `| ${l.date}${mark} | ${l.run_id} | ${l.specs} | ${l.calls ?? "?"} | ${l.tokens ?? "?"} | ` +
        `${l.spanTokens ?? "?"} | ${l.tokensPerCall === null ? "—" : Math.round(l.tokensPerCall)} | ` +
        `${l.usdPerCall === null ? "—" : `$${l.usdPerCall.toFixed(5)}`} | ${l.shape} |`,
    );
  }
  out.push("");
  const fmt = (s, digits, prefix = "") =>
    s ? `${prefix}${s.mean.toFixed(digits)} (range ${prefix}${s.min.toFixed(digits)}–${prefix}${s.max.toFixed(digits)}, n=${s.n})` : "—";
  // The per-line usd/call stays even when the aggregate is withheld — it is this
  // run's own arithmetic, not a trend — but it says so, because printing a dollar
  // column under a "no dollar trend" verdict is the same relocation of the problem
  // the aggregate fix was for.
  if (!trend.usdPerCall) {
    out.push(
      "",
      "_The `usd/call` column is each run's own figure. No dollar TREND is computed — see the " +
        "verdict above; `--prices-stable` is what unlocks the aggregate._",
    );
  }
  const label = trend.readable ? "" : " _(provisional — see above)_";
  out.push(`**Tokens per LLM call:** ${fmt(trend.tokensPerCall, 0)}${label}`);
  out.push(`**USD per LLM call:** ${fmt(trend.usdPerCall, 5, "$")}${label}`);
  out.push(`**Raw tokens per run:** ${fmt(trend.rawTokens, 0)} — how much of the suite ran, not a spend rate`);
  out.push("");
  if (trend.readable) {
    out.push("✅ The window supports quoting a token rate.");
    for (const gap of trend.gaps) out.push(`- ${gap}`);
  }
  return out.join("\n");
}

export function main(argv = process.argv.slice(2), { readFile = fs.readFileSync, log = console.log } = {}) {
  const file = argv.find((a) => !a.startsWith("--")) ?? "reports/token-history.jsonl";
  const pricesStable = argv.includes("--prices-stable");
  const measurementStable = argv.includes("--measurement-stable");
  let raw;
  try {
    raw = readFile(file, "utf8");
  } catch (error) {
    log(`token-trend: cannot read ${file} (${error.message})`);
    return 1;
  }
  const lines = [];
  // A malformed line is REFUSED, naming it. Parsing without a catch differed from
  // the two sibling failures for no reason: those return 1 with a message, this
  // threw an uncaught SyntaxError. And skipping it would be worse than either —
  // silently shortening the window is how a read gets quoted over data that was
  // never there.
  for (const [index, text] of raw.split("\n").entries()) {
    if (!text.trim()) continue;
    try {
      lines.push(JSON.parse(text));
    } catch (error) {
      log(`token-trend: ${file}:${index + 1} is not valid JSON (${error.message}) — refusing to read a partial series`);
      return 1;
    }
  }
  if (!lines.length) {
    log(`token-trend: ${file} has no lines — nothing to read`);
    return 1;
  }
  log(render(readTrend(lines, { pricesStable, measurementStable })));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
