// Unit tests for the token cost aggregation (issue #1197).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    // §7.2: added after 2026-08-03 proved an unpriced haiku silences the whole
    // Anthropic provider — it is the cost-preferred model, so it is the one that
    // most needs to resolve.
    "claude-haiku-4-5",
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

// §7.2: `claude-haiku-4-5` is what `resolveClaudeModel("haiku")` selects in
// anthropic-provider.spec.ts, and CANDIDATE_PREFS.anthropic leads with it — the
// one entry in that map chosen for PRICE rather than compatibility
// (collect-models.ts:148-155). It had no price entry, so on 2026-08-03 an entire
// provider's spend priced to nothing: four Anthropic tests passed, at least three
// real Claude completions ran, and `by_model` carried no Claude row at all.
//
// Rate verified 2026-08-03 against Anthropic's published pricing page: $1/$5 per
// MTok, which also matches the figure already written down at
// collect-models.ts:150-152.
test("the shipped table prices claude-haiku-4-5 at exactly $1/$5 per MTok (§7.2)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  // One million prompt tokens and one million completion tokens: the USD figure
  // IS the per-MTok pair, so this asserts the rate itself rather than a rounding
  // of it.
  const usd = usdFor("claude-haiku-4-5", 1_000_000, 1_000_000, prices, "2026-08-03");
  assert.equal(usd, 6, "1 MTok in + 1 MTok out must price at $1 + $5");
});

// #1211's substring resolution, exercised on haiku rather than only on sonnet.
// Langflow reports whatever id the provider returns, which for a snapshot build
// is the dated form — so the family key has to catch it or the verified rate
// above never applies to a real run.
test("a dated claude-haiku-4-5 snapshot resolves to the family band (§ Testing 12)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  const flat = usdFor("claude-haiku-4-5", 1_000_000, 1_000_000, prices, "2026-08-03");
  const dated = usdFor("claude-haiku-4-5-20251001", 1_000_000, 1_000_000, prices, "2026-08-03");
  assert.equal(dated, flat, "the dated snapshot must price identically to its family key");
});

// Both directions (§7.2.1). The fix must not become a blanket Claude fallback:
// `claude-fable-5` sits in the collected catalog at $10/$50 — ten times haiku,
// twice opus-5 — and CANDIDATE_PREFS.anthropic falls through to raw catalog order
// when neither haiku nor sonnet is present. Pricing it at haiku's rate would be a
// 10x understatement reported as exact.
test("an unpriced Claude id stays unpriced — no blanket family fallback (§7.2.1)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  assert.equal(
    usdFor("claude-fable-5", 1_000_000, 1_000_000, prices, "2026-08-03"),
    null,
    "claude-fable-5 has no entry and must resolve to null, not to a sibling's rate",
  );
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

// A genuinely SAFE "short alias contained by a longer key" case: the leftover
// (the dated suffix) is version/alias noise, not a different product. This
// replaces an earlier version of this test that used
// `gemini-2.5-flash-lite-preview` as the longer key — that leftover is
// `-lite-preview`, and "lite" names a cheaper, DIFFERENT product tier, not an
// alias of the same one. Matching on it was exactly the critical defect a
// review round on this issue caught: a real Lite id would have silently
// resolved to its non-Lite sibling's (higher) rate. Fixed below by requiring
// the leftover suffix to be recognizable version/alias noise (see
// isAllowedSuffix's own comment).
test("usdFor resolves a short alias to a longer key that contains it, when the leftover is dated/alias noise (#1211)", () => {
  const prices = { "gpt-4o-2024-08-06": { inputPerMillion: 0.1, outputPerMillion: 0.4 } };
  // "gpt-4o-2024-08-06".startsWith("gpt-4o") is true, leftover "-2024-08-06" is
  // an all-digit date — accepted noise, not a different product.
  assert.equal(usdFor("gpt-4o", 40, 48, prices), 40 * (0.1 / 1e6) + 48 * (0.4 / 1e6));
});

// --- #1211 (review round 2): the substring pass must not absorb a TIER
// suffix into its parent's rate. `gemini-2.5-flash-lite` is a real, priced-
// lower SKU, not an alias of `gemini-2.5-flash` — before this fix,
// `gemini-2.5-flash-lite`.startsWith("gemini-2.5-flash") produced a
// confidently wrong number (the non-Lite rate) instead of the honest `null`
// this issue set out to produce. Asserted against the REAL SHIPPED TABLE
// (scripts/lib/model-prices.json), not an isolated fixture, because the
// defect is specifically about what ships, and the ids below are real
// entries in tests/helpers/provider-setup/data/models.json that
// collect-models can rotate onto.
test("usdFor never absorbs a Lite tier suffix into its non-Lite parent's rate — the shipped table (#1211 review round 2)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  const nonLiteUsd = usdFor("gemini-2.5-flash", 1000, 1000, prices, "2026-07-31");
  for (const liteId of [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash-lite-preview-09-2025",
    "gemini-3.5-flash-lite",
  ]) {
    const usd = usdFor(liteId, 1000, 1000, prices, "2026-07-31");
    assert.notEqual(
      usd,
      nonLiteUsd,
      `${liteId} must not resolve to the non-Lite gemini-2.5-flash rate (${nonLiteUsd})`,
    );
    assert.ok(Number.isFinite(usd), `${liteId} must resolve to its own priced Lite rate now that the table carries it`);
  }
});

// A tier id deliberately absent from the table (not added as part of this
// fix): the honest outcome is null + named unpriced, never a guessed price
// derived from a sibling.
test("a tier id absent from the table returns null and is named unpriced, never inferred from a sibling (#1211 review round 2)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  // gpt-4o-nano does not exist in the shipped table (nor in reality, at time
  // of writing) — "nano" is a tier word, so it must never resolve via
  // "gpt-4o"'s rate.
  assert.equal(usdFor("gpt-4o-nano", 10, 10, prices, "2026-07-31"), null);
  const out = aggregate({
    probes: [
      probe({
        trace_id: "t-nano",
        total_tokens: 20,
        models: [{ model: "gpt-4o-nano", prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, calls: 1 }],
      }),
    ],
    attributions: [],
    prices,
    date: "2026-07-31",
  });
  assert.deepEqual(out.unpricedModels, ["gpt-4o-nano"]);
});

// Tier/size/family words must be refused as a leftover even when they are the
// ONLY candidate that substring-matches (the exact failure mode the review
// found) — pinned directly against isAllowedSuffix's contract via usdFor,
// covering every word the review named.
for (const tierWord of ["lite", "mini", "nano", "pro", "max", "opus", "sonnet", "haiku"]) {
  test(`usdFor refuses a leftover naming the tier/family word "${tierWord}", never absorbing it into the parent's rate (#1211 review round 2)`, () => {
    const prices = { "base-model": { inputPerMillion: 1, outputPerMillion: 1 } };
    assert.equal(usdFor(`base-model-${tierWord}`, 10, 10, prices), null);
  });
}

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

// Minor (review round 2): bands need not be authored in chronological order
// in the JSON — selectBand() must sort them itself, not trust file order.
test("selectBand sorts bands itself — a `since` band listed BEFORE an earlier one in the file still resolves correctly (#1211 review round 2)", () => {
  const outOfOrder = {
    "claude-sonnet-5": [
      // The later (2026-09-01) band is declared FIRST here, on purpose.
      { since: "2026-09-01", inputPerMillion: 3.0, outputPerMillion: 15.0 },
      { since: "2026-01-01", inputPerMillion: 2.0, outputPerMillion: 10.0 },
    ],
  };
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 0, outOfOrder, "2026-08-31"), 2.0);
  assert.equal(usdFor("claude-sonnet-5", 1_000_000, 0, outOfOrder, "2026-09-01"), 3.0);
});

// Minor (review round 2): an equal-length tie between two candidate keys must
// resolve lexically, never by which one the price table happened to declare
// first. Constructed so BOTH keys are genuinely valid (equal-length, allowed
// -digit-suffix) matches for the SAME short model id — "ccc" is the ALIAS
// contained by both "ccc-111" and "ccc-222" (7 chars each, leftover "-111" /
// "-222", both all-digit and therefore allowed noise) — declared in both
// orders to prove the winner is lexical ("ccc-111"), not declaration order.
for (const [label, prices] of [
  [
    "ccc-111 declared first",
    {
      "ccc-111": { inputPerMillion: 1, outputPerMillion: 1 },
      "ccc-222": { inputPerMillion: 9, outputPerMillion: 9 },
    },
  ],
  [
    "ccc-222 declared first",
    {
      "ccc-222": { inputPerMillion: 9, outputPerMillion: 9 },
      "ccc-111": { inputPerMillion: 1, outputPerMillion: 1 },
    },
  ],
]) {
  test(`usdFor's equal-length tie-break is lexical ("ccc-111" over "ccc-222"), not declaration order (${label}) (#1211 review round 2)`, () => {
    const usd = usdFor("ccc", 10, 10, prices);
    assert.equal(usd, 10 * (1 / 1e6) + 10 * (1 / 1e6), `expected the lexically-first "ccc-111" rate, got ${usd}`);
  });
}

// Structural guard (review round 2, minor): this module is pure by design —
// no clock reads. A `Date.now()` or `new Date()` call here would break the
// scripts' unit-test determinism the same way it would in
// scripts/wait-for-backend.mjs (which carries the same class of guard in its
// own test file).
test("token-cost.mjs never reads the clock — no Date.now() or new Date() call (#1211 review round 2)", () => {
  const src = readFileSync(new URL("./token-cost.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Date\.now\(\)/, "token-cost.mjs must not call Date.now() — dates are passed in as arguments");
  assert.doesNotMatch(src, /new Date\(/, "token-cost.mjs must not call new Date() — dates are passed in as arguments");
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

// §4.3 (fix round 2): `costs` are the sidecar's own cost records — ONE per
// recordTokenAttribution call, i.e. one per teardown. One record per call is what
// makes a plain sum correct; the previous per-FLOW field forced a reduction over
// distinct flow_id AND still measured the wrong thing (a flow with no traces wrote
// no line and so cost nothing on paper, and summing per-flow elapsed over-reported
// by roughly the flow count because the flows run concurrently).
test("aggregate sums attrib_ms across cost records and reports how many teardowns paid it (§4.3)", () => {
  const costs = [
    { kind: "attrib_cost", flows: 3, attrib_ms: 214, test: "a", file: "x.spec.ts" },
    { kind: "attrib_cost", flows: 1, attrib_ms: 86, test: "b", file: "y.spec.ts" },
  ];
  const result = aggregate({ probes: [probe()], attributions: [], costs, prices: PRICES, date: "2026-08-03" });
  assert.equal(result.attrib_ms, 300, "a plain sum — one record per call, so nothing is double-counted");
  // Without the call count a reader cannot tell 300ms across 2 teardowns from 300ms
  // across 200 of them, and the total's size mostly reflects how many specs ran.
  assert.equal(result.attrib_calls, 2);
});

test("aggregate reports attrib_ms and attrib_calls of 0 when no cost record exists", () => {
  const result = aggregate({ probes: [probe()], attributions: [], prices: PRICES, date: "2026-08-03" });
  assert.equal(result.attrib_ms, 0);
  assert.equal(result.attrib_calls, 0);
});

// A record with no usable figure must count toward NEITHER, or the average silently
// drifts: a denominator that includes a record contributing nothing to the numerator
// reports a cheaper teardown than really happened.
test("a cost record with no numeric attrib_ms counts toward neither the total nor the call count", () => {
  const costs = [
    { kind: "attrib_cost", flows: 1, attrib_ms: 50 },
    { kind: "attrib_cost", flows: 1 },
    { kind: "attrib_cost", flows: 1, attrib_ms: null },
    { kind: "attrib_cost", flows: 1, attrib_ms: "80" },
  ];
  const result = aggregate({ probes: [probe()], attributions: [], costs, prices: PRICES, date: "2026-08-03" });
  assert.equal(result.attrib_ms, 50);
  assert.equal(result.attrib_calls, 1);
});

// The property this whole change rests on: a cost record carries no trace_id and no
// total_tokens, so it can never enter the token figures. Asserted by DIFFERENCE — the
// same fixture with and without the cost record must agree on every token field —
// because that is the claim, not merely that some individual number looks right.
test("a cost record perturbs no token figure — totals, by_model, by_spec, unattributed all identical (§4.3)", () => {
  const probes = [probe(), probe({ trace_id: "t2", flow_id: "f2", total_tokens: 12 })];
  const attributions = [
    { trace_id: "t1", flow_id: "f1", test: "agent suite", file: "a.spec.ts" },
  ];
  const args = { probes, attributions, prices: PRICES, date: "2026-08-03" };

  const without = aggregate(args);
  const with_ = aggregate({
    ...args,
    costs: [{ kind: "attrib_cost", flows: 4, attrib_ms: 999, test: "some spec", file: "z.spec.ts" }],
  });

  assert.deepEqual(with_.totals, without.totals);
  assert.deepEqual(with_.byModel, without.byModel);
  assert.deepEqual(with_.bySpec, without.bySpec);
  assert.deepEqual(with_.unattributed, without.unattributed);
  assert.deepEqual(with_.mismatches, without.mismatches);
  assert.deepEqual(with_.unpricedModels, without.unpricedModels);
  // ...and the only difference is the cost itself.
  assert.equal(without.attrib_ms, 0);
  assert.equal(with_.attrib_ms, 999);
  assert.equal(with_.attrib_calls, 1);
  // Its test/file must NOT become a by_spec row: a teardown is not a spec that spent
  // tokens, and bySpec is keyed off probes, never off these records.
  assert.equal(
    with_.bySpec.some((r) => r.file === "z.spec.ts"),
    false,
    "a cost record must never appear as a spending spec",
  );
});
