// Unit tests for the token cost aggregation (issue #1197).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { usdFor, aggregate, parsePrices } from "./token-cost.mjs";

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
  assert.match(out.unattributed.reason, /trackCreatedFlows/);
  // The bucket is part of the run total, so a consumer that ignores bySpec still sums right.
  assert.equal(out.totals.total_tokens, 88);
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
