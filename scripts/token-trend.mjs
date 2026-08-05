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
//    same three lines are 728 / 1,290 / 648 — a 2x spread. The denominator is
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
// WHAT THIS CANNOT SEE, and therefore refuses to assert: this file records no
// instrument version, so a pricing change inside the window is invisible here. The
// two shape changes that ARE visible are used (`attrib_ms`/`attrib_calls`, added
// #1217; `by_provider`, added #1300), and the dollar trend is withheld unless the
// caller states the window is pricing-stable with --prices-stable. Fail-closed, per
// the same rule the rest of the repo's verdict scripts follow: an unverified
// comparison is not a comparison (#1012).

import fs from "node:fs";

export const MIN_WINDOW = 5; // token-anomaly.mjs's minBaseline — the read and the detector agree

// Everything about a line that decides whether it can be compared to its
// neighbour, plus the figures the read is over. `calls` is summed from by_model
// rather than read from a field, because there is no field: it is the only
// denominator the schema already carries.
export function describeLine(line) {
  const calls = (line.by_model ?? []).reduce((sum, m) => sum + (Number(m.calls) || 0), 0);
  const tokens = Number(line.totals?.total_tokens) || 0;
  const usd = line.totals?.usd_estimated;
  return {
    date: line.date,
    run_id: line.run_id,
    workflow: line.workflow,
    traces: Number(line.totals?.traces) || 0,
    specs: (line.by_spec ?? []).length,
    calls,
    tokens,
    usd: typeof usd === "number" ? usd : null,
    // Unpriced models make the line's dollars a FLOOR, so they are excluded from a
    // dollar mean for the same reason a skipped file is excluded from a duration
    // table: it is not a low number, it is a partial one.
    priced: (line.unpriced_models ?? []).length === 0,
    tokensPerCall: calls > 0 ? tokens / calls : null,
    usdPerCall: calls > 0 && typeof usd === "number" ? usd / calls : null,
    // The instrument shape this file can actually observe. Two lines whose shapes
    // differ came from different summarizers; two whose shapes agree MIGHT still
    // differ in pricing, which is why the dollar read needs an explicit claim.
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
export function readTrend(lines, { pricesStable = false } = {}) {
  const described = lines.map(describeLine);
  const window = trailingWindow(described);
  const rated = window.filter((l) => l.tokensPerCall !== null);
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
    gaps.push(`${window.length - rated.length} line(s) in the window recorded no LLM call and carry no rate`);
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

  return {
    lines: described,
    window,
    // The headline figure. Per CALL, never the raw total: the raw total measures
    // how much of the suite ran that day.
    tokensPerCall: stats(rated.map((l) => l.tokensPerCall)),
    usdPerCall: pricesStable ? stats(dollarLines.map((l) => l.usdPerCall)) : null,
    rawTokens: stats(rated.map((l) => l.tokens)),
    readable: window.length >= MIN_WINDOW && rated.length >= MIN_WINDOW,
    gaps,
  };
}

export function render(trend) {
  const out = ["# token-history trend (#1300 item 4)", ""];
  out.push("| date | run | specs | calls | tokens | tokens/call | usd/call | shape |");
  out.push("|---|---|---:|---:|---:|---:|---:|---|");
  const inWindow = new Set(trend.window.map((l) => l.run_id));
  for (const l of trend.lines) {
    const mark = inWindow.has(l.run_id) ? "" : " _(outside window)_";
    out.push(
      `| ${l.date}${mark} | ${l.run_id} | ${l.specs} | ${l.calls} | ${l.tokens} | ` +
        `${l.tokensPerCall === null ? "—" : Math.round(l.tokensPerCall)} | ` +
        `${l.usdPerCall === null ? "—" : `$${l.usdPerCall.toFixed(5)}`} | ${l.shape} |`,
    );
  }
  out.push("");
  const fmt = (s, digits, prefix = "") =>
    s ? `${prefix}${s.mean.toFixed(digits)} (range ${prefix}${s.min.toFixed(digits)}–${prefix}${s.max.toFixed(digits)}, n=${s.n})` : "—";
  out.push(`**Tokens per LLM call:** ${fmt(trend.tokensPerCall, 0)}`);
  out.push(`**USD per LLM call:** ${fmt(trend.usdPerCall, 5, "$")}`);
  out.push(`**Raw tokens per run:** ${fmt(trend.rawTokens, 0)} — how much of the suite ran, not a spend rate`);
  out.push("");
  out.push(
    trend.readable
      ? "✅ The window is long enough to quote a token rate from."
      : "⚠️ NOT yet a rate. Quoting a mean from this window would overstate what the series supports.",
  );
  for (const gap of trend.gaps) out.push(`- ${gap}`);
  return out.join("\n");
}

export function main(argv = process.argv.slice(2), { readFile = fs.readFileSync, log = console.log } = {}) {
  const file = argv.find((a) => !a.startsWith("--")) ?? "reports/token-history.jsonl";
  const pricesStable = argv.includes("--prices-stable");
  let raw;
  try {
    raw = readFile(file, "utf8");
  } catch (error) {
    log(`token-trend: cannot read ${file} (${error.message})`);
    return 1;
  }
  const lines = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  if (!lines.length) {
    log(`token-trend: ${file} has no lines — nothing to read`);
    return 1;
  }
  log(render(readTrend(lines, { pricesStable })));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
