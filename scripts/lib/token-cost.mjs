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

export const UNATTRIBUTED_REASON =
  "spec not migrated to trackCreatedFlows (#1108), or its flow was deleted between two poller ticks";

export function loadPrices(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const prices = {};
  for (const [model, entry] of Object.entries(raw)) {
    if (model.startsWith("_")) continue; // "_comment"
    const input = Number(entry?.inputPerMillion);
    const output = Number(entry?.outputPerMillion);
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
    prices[model] = { inputPerMillion: input, outputPerMillion: output };
  }
  return prices;
}

export function usdFor(model, promptTokens, completionTokens, prices) {
  const price = prices?.[model];
  if (!price) return null;
  return (
    (Number(promptTokens) || 0) * (price.inputPerMillion / 1e6) +
    (Number(completionTokens) || 0) * (price.outputPerMillion / 1e6)
  );
}

export function aggregate({ probes = [], attributions = [], prices = {} } = {}) {
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

      const usd = usdFor(m.model, prompt, completion, prices);
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
    const traceTotal = Number(probe.total_tokens);
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
