// Unit tests for the token cost aggregation (issue #1197).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { usdFor, aggregate, parsePrices, loadPrices } from "./token-cost.mjs";

const PRICES = {
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

const probe = (over = {}) => ({
  trace_id: "t1",
  flow_id: "f1",
  start_time: "2026-07-31T13:35:38.000Z",
  status: "ok",
  total_tokens: 88,
  models: [
    { model: "gpt-4o-mini", prompt_tokens: 40, completion_tokens: 48, total_tokens: 88, calls: 1 },
  ],
  ...over,
});

test("usdFor prices per million input and output tokens", () => {
  // 40/1e6 * 0.15 + 48/1e6 * 0.6 = 0.000006 + 0.0000288
  assert.equal(usdFor("gpt-4o-mini", 40, 48, PRICES), 0.0000348);
});

test("usdFor returns null for a model absent from the table — never 0", () => {
  assert.equal(usdFor("gemini-flash-latest", 30, 1821, PRICES), null);
});

test("aggregate attributes a trace to the spec that created its flow", () => {
  const out = aggregate({
    probes: [probe()],
    attributions: [{ trace_id: "t1", flow_id: "f1", test: "agent suite", file: "a.spec.ts" }],
    prices: PRICES,
  });
  assert.equal(out.bySpec.length, 1);
  assert.equal(out.bySpec[0].test, "agent suite");
  assert.equal(out.bySpec[0].total_tokens, 88);
  assert.equal(out.unattributed.traces, 0);
  assert.equal(out.totals.total_tokens, 88);
});

test("an unattributed trace is counted in the bucket, never dropped", () => {
  const out = aggregate({ probes: [probe()], attributions: [], prices: PRICES });
  assert.equal(out.bySpec.length, 0);
  assert.equal(out.unattributed.traces, 1);
  assert.equal(out.unattributed.total_tokens, 88);
  // Reworded per #1197 review (finding C2b): the reason must name the two REAL
  // causes — cleanup() not passing `attribution`, or a flow deleted between
  // ticks — not the retired "not migrated to trackCreatedFlows (#1108)" excuse,
  // which would send a triager to wait on a migration that changes nothing.
  assert.match(out.unattributed.reason, /cleanup\(\)/);
  assert.match(out.unattributed.reason, /did not pass attribution/);
  assert.doesNotMatch(out.unattributed.reason, /trackCreatedFlows/);
  // The bucket is part of the run total, so a consumer that ignores bySpec still sums right.
  assert.equal(out.totals.total_tokens, 88);
});

// #1197 review, finding I3: a list item whose trace has no `totalTokens` must
// fall back to the span sum, never silently read as "the run spent nothing".
test("a probe with total_tokens: null falls back to the span sum, not 0 (#1197 review, I3)", () => {
  const out = aggregate({
    probes: [probe({ total_tokens: null })],
    attributions: [],
    prices: PRICES,
  });
  assert.equal(out.totals.total_tokens, 88, "must use the span sum, not Number(null) === 0");
  // An unknown trace total disagreeing with the span sum is not a real
  // disagreement — it must not be reported as a mismatch.
  assert.equal(out.mismatches.length, 0);
});

test("an unpriced model keeps its tokens, gets null dollars and is named", () => {
  const out = aggregate({
    probes: [
      probe({
        trace_id: "t2",
        total_tokens: 1851,
        models: [
          {
            model: "gemini-flash-latest",
            prompt_tokens: 30,
            completion_tokens: 1821,
            total_tokens: 1851,
            calls: 1,
          },
        ],
      }),
    ],
    attributions: [],
    prices: PRICES,
  });
  assert.deepEqual(out.unpricedModels, ["gemini-flash-latest"]);
  assert.equal(out.byModel[0].total_tokens, 1851);
  assert.equal(out.byModel[0].usd_estimated, null);
  // The run total is a FLOOR when something is unpriced, never inflated by a 0.
  assert.equal(out.totals.usd_estimated, 0);
});

test("byModel sums calls across traces of the same model", () => {
  const out = aggregate({
    probes: [probe(), probe({ trace_id: "t3" })],
    attributions: [],
    prices: PRICES,
  });
  assert.equal(out.byModel.length, 1);
  assert.equal(out.byModel[0].calls, 2);
  assert.equal(out.byModel[0].total_tokens, 176);
});

test("a trace total that disagrees with its span sum is reported, not silently preferred", () => {
  const out = aggregate({
    probes: [probe({ total_tokens: 500 })],
    attributions: [],
    prices: PRICES,
  });
  assert.equal(out.mismatches.length, 1);
  assert.deepEqual(out.mismatches[0], { trace_id: "t1", trace_total: 500, span_total: 88 });
  // The trace's own total wins for the run total (design §2.1) — but visibly.
  assert.equal(out.totals.total_tokens, 500);
});

test("a trace with no model spans still counts its tokens", () => {
  const out = aggregate({
    probes: [probe({ models: [] })],
    attributions: [],
    prices: PRICES,
  });
  assert.equal(out.totals.total_tokens, 88);
  assert.equal(out.byModel.length, 0);
});

// parsePrices() is the validation step loadPrices() runs after fs.readFileSync +
// JSON.parse — split out so a caller with its own I/O (the summarizer's injected
// readFile) can apply the identical rules without going through this module's
// hardcoded fs access (review round 1, #1197).
test("parsePrices keeps a valid entry, skips the _comment key, and drops a non-numeric price", () => {
  const raw = JSON.stringify({
    _comment: "USD per 1M tokens",
    "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    "broken-model": { inputPerMillion: "not-a-number", outputPerMillion: 0.6 },
  });
  const prices = parsePrices(raw);
  assert.deepEqual(prices, {
    "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  });
  assert.equal(prices["broken-model"], undefined);
});

// #1197 review, finding I6: the price table must cover the model ids the suite
// actually resolves against a real Langflow, or anomaly detection (which keys
// entirely on usd_estimated) cannot see that provider's spikes at all.
//
// Resolved through usdFor() at a representative date, not by reading
// `.inputPerMillion` off `prices[model]` directly (#1211): claude-sonnet-5 now
// carries dated bands (an array), not a flat rate, so a raw property read
// would no longer reflect what a real run actually gets priced at.
test("the shipped price table covers the models measured against Langflow 1.12.0.dev10 (#1197 review, I6)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  const REPRESENTATIVE_DATE = "2026-07-31";
  for (const model of [
    "gpt-4o-mini",
    "gpt-4o",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-opus-5",
    "gemini-2.5-flash",
    "gemini-flash-latest",
    // #1197 re-review, finding B: gemini-3.5-flash was the run's largest
    // consumer (13 calls / 14,690 tokens on run 30647253368) and had no
    // price entry — the headline printed a FLOOR with `n/a` on the biggest row.
    "gemini-3.5-flash",
  ]) {
    const usd = usdFor(model, 1, 1, prices, REPRESENTATIVE_DATE);
    assert.ok(Number.isFinite(usd), `${model} must resolve to a numeric price on ${REPRESENTATIVE_DATE}`);
  }
});

// --- #1211: two-phase lookup (exact, then longest-substring-first) ---

test("usdFor still resolves an exact key match unchanged, even when a shorter substring of it also matches (#1211)", () => {
  const prices = {
    "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  };
  // Exact key wins outright — no substring resolution ever runs for it.
  assert.equal(usdFor("gpt-4o-mini", 40, 48, prices), 0.0000348);
  assert.equal(usdFor("gpt-4o", 40, 48, prices), 40 * (2.5 / 1e6) + 48 * (10.0 / 1e6));
});

test("usdFor resolves a dated/preview model id to its family via substring match (#1211)", () => {
  const prices = { "claude-opus-4": { inputPerMillion: 5, outputPerMillion: 25 } };
  // 40*(5/1e6) + 48*(25/1e6) = 0.0002 + 0.0012 = 0.0014
  assert.equal(usdFor("claude-opus-4-20250514", 40, 48, prices), 40 * (5 / 1e6) + 48 * (25 / 1e6));
});

test("usdFor resolves a short alias to a longer key that contains it (#1211)", () => {
  const prices = { "gemini-2.5-flash-lite-preview": { inputPerMillion: 0.1, outputPerMillion: 0.4 } };
  // "gemini-2.5-flash-lite-preview".includes("gemini-2.5-flash") is true — the
  // shorter alias is CONTAINED BY the longer, more specific key.
  assert.equal(usdFor("gemini-2.5-flash", 40, 48, prices), 40 * (0.1 / 1e6) + 48 * (0.4 / 1e6));
});

// The core hazard the issue names: gpt-4o-mini-search-preview matches BOTH
// gpt-4o and gpt-4o-mini. Picking gpt-4o (the shorter substring) overstates
// the call 16x. Candidates must sort longest-first — declared in both key
// orders below to prove the result does not depend on object iteration order.
for (const [label, prices] of [
  [
    "gpt-4o declared first",
    {
      "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
      "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    },
  ],
  [
    "gpt-4o-mini declared first",
    {
      "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
      "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
    },
  ],
]) {
  test(`usdFor picks the longer, more specific "gpt-4o-mini" key over "gpt-4o" regardless of declaration order (${label}) (#1211)`, () => {
    // 1000 prompt + 1000 completion tokens:
    //   gpt-4o-mini: 1000/1e6*0.15 + 1000/1e6*0.6 = 0.00075
    //   gpt-4o:      1000/1e6*2.5  + 1000/1e6*10  = 0.0125   (16.67x higher)
    const usd = usdFor("gpt-4o-mini-search-preview", 1000, 1000, prices);
    const gptMiniRate = 1000 / 1e6 * 0.15 + 1000 / 1e6 * 0.6;
    assert.equal(
      usd,
      gptMiniRate,
      `expected the gpt-4o-mini rate (~$0.00075); a value near $0.0125 means the shorter "gpt-4o" key won instead (got ${usd})`,
    );
  });
}

test("usdFor returns null (never a guess) when no exact or substring match exists (#1211)", () => {
  const prices = { "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 } };
  assert.equal(usdFor("mystery-model-9000", 10, 10, prices), null);
});

// --- #1211: dated price bands ---

const DATED = {
  "claude-sonnet-5": [
    { since: "2026-01-01", inputPerMillion: 2.0, outputPerMillion: 10.0 },
    { since: "2026-09-01", inputPerMillion: 3.0, outputPerMillion: 15.0 },
  ],
};

test("usdFor selects the price band effective on the given date, before and after a `since` boundary (#1211)", () => {
  // Before the boundary: the introductory $2/$10 band applies.
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 0, DATED, "2026-08-31"), 2.0);
  // On/after the boundary: the standard $3/$15 band takes over.
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 0, DATED, "2026-09-01"), 3.0);
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 0, DATED, "2026-12-25"), 3.0);
});

test("a model whose dated bands do not cover the run's date returns null, never the newest band by default (#1211)", () => {
  // A run dated before the EARLIEST recorded band: silently falling back to the
  // newest ($3/$15) band would misprice a call from before that rate is known
  // to have existed. Honest answer: unknown, same as an unpriced model.
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 1_000_000, DATED, "2025-06-01"), null);
});

test("aggregate() threads the run date through to usdFor and names a band-uncovered model in unpriced_models (#1211)", () => {
  const out = aggregate({
    probes: [
      probe({
        trace_id: "t5",
        total_tokens: 20,
        models: [{ model: "claude-sonnet-5", prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, calls: 1 }],
      }),
    ],
    attributions: [],
    prices: DATED,
    date: "2025-06-01", // before the earliest band
  });
  assert.deepEqual(out.unpricedModels, ["claude-sonnet-5"]);
  assert.equal(out.totals.total_tokens, 20, "tokens are still counted even though the dollars are unknown");
});

test("parsePrices supports a dated-bands array, keeping a valid band and dropping an invalid one (#1211)", () => {
  const raw = JSON.stringify({
    "claude-sonnet-5": [
      { since: "2026-01-01", inputPerMillion: 2.0, outputPerMillion: 10.0 },
      { since: "2026-09-01", inputPerMillion: "not-a-number", outputPerMillion: 15.0 },
    ],
  });
  const prices = parsePrices(raw);
  assert.deepEqual(prices["claude-sonnet-5"], [
    { since: "2026-01-01", inputPerMillion: 2.0, outputPerMillion: 10.0 },
  ]);
});

test("parsePrices drops a model entirely when every one of its dated bands is invalid (#1211)", () => {
  const raw = JSON.stringify({
    "broken-dated-model": [{ since: "2026-01-01", inputPerMillion: "nope", outputPerMillion: "nope" }],
  });
  const prices = parsePrices(raw);
  assert.equal(prices["broken-dated-model"], undefined);
});

// The shipped table's own claim (#1211): claude-sonnet-5 carries the
// introductory $2/$10 rate through 2026-08-31 as the dated fact it is, then
// the standard $3/$15 rate from 2026-09-01 — not a flat, permanently
// conservative $3/$15 that a maintainer cannot tell is current vs. stale.
test("the shipped table records claude-sonnet-5's introductory rate through 2026-08-31, reverting to standard after (#1211)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 0, prices, "2026-08-31"), 2.0);
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 0, prices, "2026-09-01"), 3.0);
});
