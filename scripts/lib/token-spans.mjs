// Shared span/probe logic for the token consumption monitor (issue #1197).
//
// Both the poller (scripts/watch-tokens.mjs, plain dependency-free ESM) and the
// attribution sidecar (tests/helpers/flows/token-attribution.ts, TypeScript,
// dynamically `import()`s this file — see the comment at its call site for why)
// build a probe from the SAME two API responses: `GET /api/v1/monitor/traces`
// (the trace's own reported total) and `GET /api/v1/monitor/traces/{id}` (its
// per-model spans). They must apply the SAME two rules, or the two paths'
// totals silently disagree (#1197 re-review, finding A):
//
//   - only `modelName`-bearing spans count. Langflow emits the component-level
//     "Language Model" span with modelName === null carrying the SAME
//     tokenUsage as the inner provider span, so counting every llm span
//     doubles every call (design §2.1).
//   - the trace's own `totalTokens` is authoritative when present and finite;
//     otherwise `null`, never `0` (#1197 review, finding I3) — a `null` lets
//     `aggregate()`'s spanTotal fallback (scripts/lib/token-cost.mjs) do the
//     right thing instead of silently reading "unknown" as "spent nothing".
//
// This module is the ONE place either rule is allowed to live. Pure: no I/O,
// no env, no clock — like scripts/lib/token-cost.mjs and token-anomaly.mjs.

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

// Build the exact probe shape every writer of a token-probes-style JSONL line
// uses — `{trace_id, flow_id, start_time, status, total_tokens, models}` —
// from a trace list item (`GET /api/v1/monitor/traces` / `?flow_id=`) and its
// detail spans (`GET /api/v1/monitor/traces/{id}` → `.spans`, or `undefined`
// when that fetch failed or was never attempted — `flattenSpans`/`spanModelUsage`
// both treat a missing spans array as "no spans", i.e. `models: []`, which is
// the correct degradation rather than a special case).
export function buildProbe(trace, spans) {
  const traceTotal = Number(trace?.totalTokens);
  return {
    trace_id: trace?.id ?? null,
    flow_id: trace?.flowId ?? null,
    start_time: trace?.startTime ?? null,
    status: trace?.status ?? null,
    total_tokens: Number.isFinite(traceTotal) ? traceTotal : null,
    models: spanModelUsage(spans),
  };
}
