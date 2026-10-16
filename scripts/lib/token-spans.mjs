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
//   - a span that names its model and reports ALL-ZERO usage is an UNMEASURED
//     call, not a free one (#2288). An LLM call always reads at least one prompt
//     token, so a zero means the provider's usage never reached the trace. Measured
//     2026-10-16 on 1.13.0.dev35 and dev44: every Azure AI Foundry span
//     (`AzureAIOpenAIApiChatModel gpt-5.6-sol`) reports {0, 0, 0}, because Langflow
//     sets `stream_usage` only for OpenAI and Anthropic. These calls are counted in
//     `unmeasured`, never folded into `models` as zeros and never dropped unseen.
//   - the provider is read from the span's LangChain CLASS when that class names
//     one (`spanProvider`), because the model id alone cannot: `gpt-5.6-sol` is
//     both an OpenAI id and the Foundry deployment the rotation runs (#2287).
//
// This module is the ONE place each rule is allowed to live. Pure: no I/O,
// no env, no clock — like scripts/lib/token-cost.mjs and token-anomaly.mjs.

export function flattenSpans(spans, acc = []) {
  for (const span of spans ?? []) {
    acc.push(span);
    if (span?.children) flattenSpans(span.children, acc);
  }
  return acc;
}

// The LangChain class Langflow puts first in an llm span's name ("ChatOpenAI
// gpt-4o-mini"), mapped to the BILLING provider in model-prices.json's vocabulary.
// Each entry was read off a real trace on 1.13.0.dev44 (2026-10-16), not assumed;
// a class absent here answers null and the price table decides, as before #2288.
const SPAN_CLASS_PROVIDERS = {
  ChatOpenAI: "openai",
  ChatAnthropic: "anthropic",
  ChatGoogleGenerativeAI: "google",
  AzureAIOpenAIApiChatModel: "azure",
};

/** The billing provider an llm span's class names, or null when it names none here. */
export function spanProvider(span) {
  const name = typeof span?.name === "string" ? span.name : "";
  const cls = name.split(" ", 1)[0];
  return Object.hasOwn(SPAN_CLASS_PROVIDERS, cls) ? SPAN_CLASS_PROVIDERS[cls] : null;
}

// One accumulator per (model, provider): the same id billed by two accounts in one
// trace stays two entries. `provider` is set only when the span's class names one,
// so an entry with no known class keeps exactly the pre-#2288 shape.
function accumulate(map, model, provider, fields) {
  const key = `${model}\u0000${provider ?? ""}`;
  const acc = map.get(key) ?? { model, ...(provider ? { provider } : {}), ...fields };
  map.set(key, acc);
  return acc;
}

// Only spans that name their model. Langflow emits the component-level "Language
// Model" span with modelName === null carrying the SAME tokenUsage as the inner
// provider span, so counting every llm span doubles every call (design §2.1).
// A named span with all-zero usage is not counted here: see `spanUnmeasured`.
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
    const acc = accumulate(byModel, model, spanProvider(span), {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      calls: 0,
    });
    acc.prompt_tokens += prompt;
    acc.completion_tokens += completion;
    acc.total_tokens += total;
    acc.calls += 1;
  }
  return [...byModel.values()];
}

// The calls whose usage never reached the trace: a named span whose usage object is
// present and all zero (#2288). A span with NO usage object is not one of them --
// that is the shape of a span Langflow never filled, which the spike measured on
// non-provider spans and which counting would turn into phantom calls.
export function spanUnmeasured(spans) {
  const byModel = new Map();
  for (const span of flattenSpans(spans)) {
    const model = typeof span?.modelName === "string" ? span.modelName : "";
    const usage = span?.tokenUsage;
    if (!model || !usage) continue;
    const prompt = Number(usage.promptTokens) || 0;
    const completion = Number(usage.completionTokens) || 0;
    const total = Number(usage.totalTokens) || 0;
    if (prompt || completion || total) continue;
    accumulate(byModel, model, spanProvider(span), { calls: 0 }).calls += 1;
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
//
// `unmeasured` is present only when a call's usage was missing (#2288), so every
// probe written before it, and every probe of a fully measured trace, keeps its shape.
export function buildProbe(trace, spans) {
  const traceTotal = Number(trace?.totalTokens);
  const unmeasured = spanUnmeasured(spans);
  return {
    trace_id: trace?.id ?? null,
    flow_id: trace?.flowId ?? null,
    start_time: trace?.startTime ?? null,
    status: trace?.status ?? null,
    total_tokens: Number.isFinite(traceTotal) ? traceTotal : null,
    models: spanModelUsage(spans),
    ...(unmeasured.length ? { unmeasured } : {}),
  };
}
