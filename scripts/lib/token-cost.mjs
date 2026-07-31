// Pricing and aggregation for the token consumption monitor (issue #1197).
//
// Pure functions only: no I/O, no env, no clock. The poller and the summarizer own
// those. That is what lets the whole cost surface be unit-tested without a backend.
//
// Two rules from the design (§2.1, §3.1) live here and nowhere else:
//   - a model absent from the price table yields NULL dollars and is named, never 0;
//   - the run total comes from the trace's own totalTokens, because Langflow reports
//     the same usage twice per call (component span + provider span) and summing
//     spans would double-count. A disagreement between the two is REPORTED.
import fs from "node:fs";

// Reworded per #1197 review (finding C2b): the previous text blamed a spec "not
// migrated to trackCreatedFlows (#1108)", which is no longer the live cause now
// that the sidecar's one call site (agent-max-tokens.spec.ts) passes
// `attribution` — a triager reading that string would wait on a migration that
// does nothing to turn attribution on. Name the two causes that actually put a
// trace here: the spec's own `cleanup()` call did not pass `attribution` (most
// specs, by design — the sidecar is opt-in per #1197), or the flow was deleted
// between two poller ticks before the sidecar could read its trace (#1197 §S4).
export const UNATTRIBUTED_REASON =
  "the spec's cleanup() did not pass attribution (most specs don't, by design), or its flow was deleted between two poller ticks";

// Pure validation step, split out from loadPrices() so a caller with its own I/O
// (the summarizer's injected readFile, in particular) can reuse the exact same
// rules without going through this module's hardcoded fs.readFileSync. Takes the
// RAW file text (not a pre-parsed object) so both callers do the same JSON.parse.
//
// A model's value is one of two shapes (#1211):
//   - a FLAT rate:   { inputPerMillion, outputPerMillion }               — the
//     common case, kept exactly as-is so a maintainer never has to wrap an
//     ordinary one-rate model in an array just to satisfy the schema, and so
//     a model priced this way sees no behaviour change from before #1211.
//   - DATED bands:   [{ since, inputPerMillion, outputPerMillion }, …]    — a
//     rate that changed over time (a promotional rate, a price correction).
//     `since` is a "YYYY-MM-DD" string; usdFor() picks the band effective on
//     the caller's date. Each band is validated the same way a flat rate is
//     (drop a non-numeric rate); a model whose bands are ALL invalid is
//     dropped entirely, same policy as an invalid flat rate.
export function parsePrices(raw) {
  const parsed = JSON.parse(raw);
  const prices = {};
  for (const [model, entry] of Object.entries(parsed)) {
    if (model.startsWith("_")) continue; // "_comment"
    if (Array.isArray(entry)) {
      const bands = entry
        .map((band) => ({
          since: typeof band?.since === "string" ? band.since : null,
          inputPerMillion: Number(band?.inputPerMillion),
          outputPerMillion: Number(band?.outputPerMillion),
        }))
        .filter((band) => Number.isFinite(band.inputPerMillion) && Number.isFinite(band.outputPerMillion));
      if (bands.length) prices[model] = bands;
      continue;
    }
    const input = Number(entry?.inputPerMillion);
    const output = Number(entry?.outputPerMillion);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    prices[model] = { inputPerMillion: input, outputPerMillion: output };
  }
  return prices;
}

export function loadPrices(filePath) {
  return parsePrices(fs.readFileSync(filePath, "utf8"));
}

// Normalizes a raw price-table VALUE (flat rate or dated-bands array) into an
// array of bands. A flat rate becomes a single band with `since: null`,
// meaning "always effective" — selectBand() below treats it as the fallback
// when no dated band covers the requested date.
function toBands(entry) {
  return Array.isArray(entry) ? entry : [{ since: null, ...entry }];
}

// Selects the band effective on `date` ("YYYY-MM-DD"): the DATED band with
// the latest `since` that is still <= date, falling back to the undated
// ("always") band when one exists. Returns null when NEITHER applies — a
// model whose dated bands do not cover `date` (the run predates the earliest
// recorded rate) is reported unknown, never guessed. Silently reusing the
// newest band would misprice a run from before that rate is known to have
// existed, and there is no honest way to tell "priced" from "assumed" after
// the fact (#1211 — the same "never a stand-in for unknown" rule #1012
// applies to prices applies here to dates).
//
// Pure: takes `date` as an argument, never reads a clock (design constraint —
// a `Date.now()` call in this module would break the scripts' unit-test
// determinism).
function selectBand(bands, date) {
  const dated = bands
    .filter((band) => band.since)
    .sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0)); // latest since first
  if (date) {
    for (const band of dated) {
      if (band.since <= date) return band;
    }
  }
  return bands.find((band) => !band.since) ?? null;
}

// Resolves a model id to its price bands: an EXACT key match first (#1211 —
// "no behaviour change for a model already priced by an exact key" is a
// stated done-when, so this branch never falls through to substring logic),
// then a substring match in both directions — a dated/preview/latest id
// CONTAINS its family key (`claude-opus-4-20250514` ⊃ `claude-opus-4`), and a
// short alias can be CONTAINED BY a longer, more specific key
// (`gemini-2.5-flash` ⊂ `gemini-2.5-flash-lite-preview`).
//
// Candidates are sorted LONGEST-KEY-FIRST — never object/iteration order —
// so the most specific match always wins: `gpt-4o-mini-search-preview`
// matches both `gpt-4o` and `gpt-4o-mini`; picking the shorter `gpt-4o` would
// overstate that call 16x (#1211). The same hazard applies to
// `gpt-4`/`gpt-4.1`, `claude-sonnet-4`/`claude-sonnet-4-6`, and
// `gemini-2.5-flash`/`gemini-2.5-flash-lite`. A tie in key length falls back
// to a plain lexical sort so the result never depends on which key the price
// table happened to declare first.
function resolveBands(model, prices) {
  if (!model || !prices) return null;
  if (prices[model]) return toBands(prices[model]);
  const candidates = Object.keys(prices)
    .filter((key) => model.includes(key) || key.includes(model))
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return candidates.length ? toBands(prices[candidates[0]]) : null;
}

export function usdFor(model, promptTokens, completionTokens, prices, date) {
  const bands = resolveBands(model, prices);
  if (!bands) return null;
  const band = selectBand(bands, date);
  if (!band) return null;
  return (
    (Number(promptTokens) || 0) * (band.inputPerMillion / 1e6) +
    (Number(completionTokens) || 0) * (band.outputPerMillion / 1e6)
  );
}

// `date` ("YYYY-MM-DD") is passed straight to usdFor()'s band selection
// (#1211) — the caller (watch-tokens.mjs's summarize()) passes the SAME value
// that lands on the history line's own `date` field, so a line's USD and its
// date can never disagree. Omitted, a model priced only by dated bands
// resolves to unpriced rather than guessing a band.
export function aggregate({ probes = [], attributions = [], prices = {}, date } = {}) {
  const byTrace = new Map();
  for (const a of attributions) {
    if (a?.trace_id) byTrace.set(a.trace_id, a);
  }

  const models = new Map();
  const specs = new Map();
  const unpriced = new Set();
  const mismatches = [];

  const totals = {
    traces: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    usd_estimated: 0,
  };
  const unattributed = {
    traces: 0,
    total_tokens: 0,
    usd_estimated: 0,
    reason: UNATTRIBUTED_REASON,
  };

  for (const probe of probes) {
    if (!probe?.trace_id) continue;
    totals.traces += 1;

    let spanTotal = 0;
    let traceUsd = 0;
    for (const m of probe.models ?? []) {
      const prompt = Number(m.prompt_tokens) || 0;
      const completion = Number(m.completion_tokens) || 0;
      const total = Number(m.total_tokens) || prompt + completion;
      spanTotal += total;
      totals.prompt_tokens += prompt;
      totals.completion_tokens += completion;

      const usd = usdFor(m.model, prompt, completion, prices, date);
      if (usd === null) unpriced.add(m.model);
      else traceUsd += usd;

      const acc =
        models.get(m.model) ??
        {
          model: m.model,
          calls: 0,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          usd_estimated: usd === null ? null : 0,
        };
      acc.calls += Number(m.calls) || 1;
      acc.prompt_tokens += prompt;
      acc.completion_tokens += completion;
      acc.total_tokens += total;
      if (acc.usd_estimated !== null && usd !== null) acc.usd_estimated += usd;
      models.set(m.model, acc);
    }

    // The trace's own total is authoritative for the run (§2.1). When the two
    // disagree, say so — a silent preference would hide a Langflow change in how
    // spans are emitted.
    //
    // Read the RAW value, not `Number(probe.total_tokens)`: the poller emits a
    // literal JSON `null` when the trace's own total is unknown (#1197 review,
    // finding I3), and `Number(null)` coerces to `0` — a finite number — before
    // `Number.isFinite` ever sees it, which would silently treat "unknown" as
    // "the run spent nothing" and flag every such trace as a fake mismatch
    // against its real span sum. `Number.isFinite` on the raw value rejects
    // `null` (and a missing/undefined field) without coercion, so both correctly
    // fall through to `spanTotal` below.
    const traceTotal = probe.total_tokens;
    const runTotal = Number.isFinite(traceTotal) ? traceTotal : spanTotal;
    if (Number.isFinite(traceTotal) && traceTotal !== spanTotal) {
      mismatches.push({ trace_id: probe.trace_id, trace_total: traceTotal, span_total: spanTotal });
    }
    totals.total_tokens += runTotal;
    totals.usd_estimated += traceUsd;

    const attribution = byTrace.get(probe.trace_id);
    if (!attribution) {
      unattributed.traces += 1;
      unattributed.total_tokens += runTotal;
      unattributed.usd_estimated += traceUsd;
      continue;
    }
    const key = `${attribution.file}::${attribution.test}`;
    const spec =
      specs.get(key) ??
      { test: attribution.test, file: attribution.file, traces: 0, total_tokens: 0, usd_estimated: 0 };
    spec.traces += 1;
    spec.total_tokens += runTotal;
    spec.usd_estimated += traceUsd;
    specs.set(key, spec);
  }

  return {
    totals,
    byModel: [...models.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    bySpec: [...specs.values()].sort((a, b) => b.total_tokens - a.total_tokens),
    unattributed,
    unpricedModels: [...unpriced].sort(),
    mismatches,
  };
}
