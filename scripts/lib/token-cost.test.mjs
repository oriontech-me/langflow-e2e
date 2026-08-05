// Unit tests for the token cost aggregation (issue #1197).
// Run with: npm run test:scripts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  usdFor,
  aggregate,
  parsePrices,
  loadPrices,
  resolvePriceKey,
  resolveProvider,
  normalizeSpecPath,
  UNATTRIBUTED_REASON,
} from "./token-cost.mjs";

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
    // Added 2026-08-04: reported by run 30920300880 from the Azure AI Foundry
    // provider spec, where 584 unpriced tokens made the whole run a floor.
    "gpt-5-mini",
  ]) {
    const usd = usdFor(model, 1, 1, prices, REPRESENTATIVE_DATE);
    assert.ok(Number.isFinite(usd), `${model} must resolve to a numeric price on ${REPRESENTATIVE_DATE}`);
  }
});

// The Azure AI Foundry deployment. Its id in the trace is the PORTAL DEPLOYMENT
// NAME an operator typed, not an identity the API vouches for -- so this row
// prices a name, and these three tests pin the parts that can go wrong.
//
// Rate verified 2026-08-04 against OpenAI's published pricing ($0.25/$2.00 per
// MTok) and cross-checked against Azure, which lists the same figures.
test("the shipped table prices gpt-5-mini at exactly $0.25/$2.00 per MTok", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  // One MTok each way, so the USD figure IS the per-MTok pair rather than a
  // rounding of it -- same construction as the haiku test below.
  const usd = usdFor("gpt-5-mini", 1_000_000, 1_000_000, prices, "2026-08-04");
  assert.equal(usd, 2.25, "1 MTok in + 1 MTok out must price at $0.25 + $2.00");
});

// The exact row that made run 30920300880 a floor. Worth pinning as itself
// because it shows why a floor is not "roughly right": these 584 tokens are 7%
// of that run's tokens and about 60% of its cost, since gpt-5-mini's output rate
// is 3.3x gpt-4o-mini's.
test("the row that made run 30920300880 a floor now prices exactly", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  const usd = usdFor("gpt-5-mini", 51, 533, prices, "2026-08-04");
  // Same ASSOCIATION as usdFor's own expression -- `tokens * (rate / 1e6)`, not
  // `tokens * rate / 1e6`. The two differ in the last bit of a double
  // (…4999999999998 vs …5), and the first version of this assertion used the
  // wrong one and failed. Writing the expected value as a decimal literal would
  // have the same problem; matching the association is what makes it exact.
  assert.equal(usd, 51 * (0.25 / 1e6) + 533 * (2.0 / 1e6));
  assert.ok(usd > 0.001, "the run's previously-unpriced share is over a tenth of a cent");
});

// The tier rule, in the direction that costs money. `gpt-5` is a PREFIX of
// `gpt-5-mini`, so without the suffix gate a bare `gpt-5` deployment -- or a
// `gpt-5-nano` one -- would inherit Mini's rate. Both are different SKUs at
// different prices, and an operator can name a Foundry deployment either thing.
// Nano is the dangerous one: it is CHEAPER than Mini, so inheriting would
// overstate, while a bare gpt-5 is dearer and would understate. Neither may
// resolve.
test("a sibling gpt-5 tier does not inherit gpt-5-mini's rate", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  for (const id of ["gpt-5", "gpt-5-nano", "gpt-5-pro"]) {
    assert.equal(
      resolvePriceKey(id, prices),
      null,
      `${id} is a different tier and must stay unpriced rather than take gpt-5-mini's rate`,
    );
  }
  // The dated/alias forms of the SAME tier must still resolve, or the verified
  // rate above never reaches a real run.
  assert.equal(resolvePriceKey("gpt-5-mini-2026-08-01", prices), "gpt-5-mini");
  // And the new key must not have disturbed the openai family already here.
  assert.equal(resolvePriceKey("gpt-4o", prices), "gpt-4o");
  assert.equal(resolvePriceKey("gpt-4o-mini", prices), "gpt-4o-mini");
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
  // The vehicle was `claude-fable-5` until #1255 item 4 priced it (§7.2.1's own
  // published table). The PROPERTY under test is unchanged and is not about that id:
  // a Claude id with no entry must resolve to null rather than inherit a sibling's
  // rate. `claude-sonnet-9` is a plausible future id that no key here is a prefix of.
  assert.equal(
    usdFor("claude-sonnet-9", 1_000_000, 1_000_000, prices, "2026-08-03"),
    null,
    "an unpriced Claude id must resolve to null, not to a sibling's rate",
  );
  // And the id that used to stand in for it is now priced at its published rate,
  // not at a sibling's: $10/$50, which is neither haiku's nor opus-5's.
  assert.equal(usdFor("claude-fable-5", 1_000_000, 1_000_000, prices, "2026-08-03"), 60);
});

// #1255 item 4: the nine Anthropic ids §7.2.1 named are priced, at its rates.
//
// rankCandidates falls through to raw catalog order when neither /haiku/ nor /sonnet/
// validates (collect-models.ts:157-161), so every id below is reachable and an
// unpriced one turns its whole run's cost into a floor. The rates are §7.2.1's own
// published table (sourced 2026-08-03), pinned here so a later edit to
// model-prices.json cannot quietly move one of them onto a sibling's rate — which is
// what the substring resolver would do if a key were deleted.
//
// The list is written out rather than derived from the collected catalog:
// tests/helpers/provider-setup/data/models.json is GITIGNORED (generated by
// collect-models), so a test that reads it passes on a dev box that ran the sweep and
// ENOENTs in the unit lane — measured, on this PR's first CI run. The catalog sweep
// below covers that angle where the file exists, and says so where it does not.
//
// Google is deliberately NOT priced the same way: 28 of its 36 catalog ids are
// image / video / TTS / robotics / gemma models with no per-MTok text rate to record,
// and inventing one is worse than the honest null this module exists to produce
// (§2.1). Its three text ids the rotation can actually select are all priced.
const ANTHROPIC_PUBLISHED = {
  "claude-fable-5": [10, 50],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-opus-4-5": [5, 25],
  "claude-opus-4-1": [15, 75],
  "claude-opus-4-20250514": [15, 75],
  "claude-sonnet-4-5": [3, 15],
  "claude-sonnet-4-20250514": [3, 15],
};

test("the nine Anthropic ids of §7.2.1 are priced at their published rates (#1255 item 4)", () => {
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  for (const [model, [input, output]] of Object.entries(ANTHROPIC_PUBLISHED)) {
    assert.equal(resolvePriceKey(model, prices), model, `${model} must be priced by its own key`);
    // One MTok in and one MTok out, so the assertion reads as the published pair.
    assert.equal(
      usdFor(model, 1_000_000, 1_000_000, prices, "2026-08-04"),
      input + output,
      `${model} must price at $${input}/$${output} per MTok`,
    );
  }
});

test("no Anthropic id in the collected catalog is unpriced — skipped when the catalog is absent", (t) => {
  // The catalog is a collect-models artifact and is gitignored, so this cannot be a
  // gate. It is still worth running where it CAN run: on a dev box after a sweep it is
  // the only thing that sees an Anthropic id the published list above does not know
  // about. Skipped loudly rather than passing silently when the file is not there
  // (#1012 — an unevaluated check is unknown, never clean).
  const catalogPath = new URL("../../tests/helpers/provider-setup/data/models.json", import.meta.url);
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
  } catch {
    t.skip("no models.json — run `npx playwright test tests/collect-models.spec.ts` to produce it");
    return;
  }
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  const unpriced = catalog
    .filter((entry) => entry.provider === "anthropic")
    .map((entry) => entry.model)
    .filter((model) => resolvePriceKey(model, prices) === null);
  assert.deepEqual(
    unpriced,
    [],
    `unpriced Anthropic ids are reachable through rankCandidates' raw-order fall-through: ${unpriced.join(", ")}`,
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
// recordTokenAttribution call. That is one per teardown ONLY on the batch-attributing
// `cleanup()` path; the ~132 `@stable` specs that call `deleteFlow` once per id write
// one record per flow, so `attrib_calls` counts calls and not teardowns, and the sum
// is the honest figure rather than any derived average. One record per call is what
// makes a plain sum correct; the previous per-FLOW field forced a reduction over
// distinct flow_id AND still measured the wrong thing (a flow with no traces wrote
// no line and so cost nothing on paper, and summing per-flow elapsed over-reported
// by roughly the flow count because the flows run concurrently).
test("aggregate sums attrib_ms across cost records and reports how many calls paid it (§4.3)", () => {
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

// #1217 §5.3: the platform's e2e_test_token_usage.price_key records WHICH table
// key priced a row. resolveBands() already computes it and discards it; these
// tests pin the extracted function to the resolver's real behaviour, including
// the two refusals that exist to stop a wrong number (#1211).
const KEYS = {
  "gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gemini-2.5-flash": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "claude-opus-4": { inputPerMillion: 15, outputPerMillion: 75 },
};

test("resolvePriceKey returns the exact key when the model is priced by name", () => {
  assert.equal(resolvePriceKey("gpt-4o-mini", KEYS), "gpt-4o-mini");
});

test("resolvePriceKey resolves a dated id to its family key", () => {
  assert.equal(resolvePriceKey("claude-opus-4-20250514", KEYS), "claude-opus-4");
});

test("resolvePriceKey prefers the longest matching key", () => {
  // Matches both gpt-4o (leftover "-mini-search-preview", refused) and
  // gpt-4o-mini (leftover "-search-preview", allowed).
  assert.equal(resolvePriceKey("gpt-4o-mini-search-preview", KEYS), "gpt-4o-mini");
});

test("resolvePriceKey refuses a separately-priced tier suffix", () => {
  // "-lite" is a real cheaper tier, not alias noise (#1211). Pricing it at the
  // non-Lite rate is worse than admitting we cannot price it.
  assert.equal(resolvePriceKey("gemini-2.5-flash-lite", KEYS), null);
});

test("resolvePriceKey returns null for an unknown family", () => {
  assert.equal(resolvePriceKey("mistral-large", KEYS), null);
});

test("resolvePriceKey returns null on missing arguments", () => {
  assert.equal(resolvePriceKey("", KEYS), null);
  assert.equal(resolvePriceKey("gpt-4o", null), null);
});

test("usdFor is unchanged by the resolvePriceKey extraction", () => {
  // The refactor's whole risk is a behaviour change in pricing. Pin the three
  // paths that matter: exact key, substring family, refused suffix.
  assert.equal(usdFor("gpt-4o-mini", 1_000_000, 0, KEYS), 0.15);
  assert.equal(usdFor("claude-opus-4-20250514", 1_000_000, 0, KEYS), 15);
  assert.equal(usdFor("gemini-2.5-flash-lite", 1_000_000, 0, KEYS), null);
});

// #1217 §5.3: bySpecModel is the row shape e2e_ingest_run_tokens destructures.
// Its identity must match the DB's unique index — (run_id, COALESCE(test_key,''),
// model) — so one row per (spec_path, title_path, model) and exactly ONE
// unattributed row per model. See 20260803130200_e2e_test_token_usage.sql:83.
const P = { "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 } };

const twoModelProbe = (traceId, over = {}) => ({
  trace_id: traceId,
  flow_id: "f1",
  start_time: "2026-08-03T13:00:00.000Z",
  status: "ok",
  total_tokens: 300,
  models: [
    { model: "gpt-4o-mini", prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, calls: 2 },
    { model: "gemini-3.5-flash", prompt_tokens: 60, completion_tokens: 40, total_tokens: 100, calls: 1 },
  ],
  ...over,
});

test("bySpecModel crosses spec and model, and carries the price key", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1")],
    attributions: [{ trace_id: "t1", file: "a.spec.ts", test: "does a thing" }],
    prices: P,
  });
  const rows = [...agg.bySpecModel].sort((x, y) => x.model.localeCompare(y.model));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    spec_path: "a.spec.ts",
    title_path: "does a thing",
    model: "gemini-3.5-flash",
    price_key: null,
    calls: 1,
    prompt_tokens: 60,
    completion_tokens: 40,
    total_tokens: 100,
  });
  assert.deepEqual(rows[1], {
    spec_path: "a.spec.ts",
    title_path: "does a thing",
    model: "gpt-4o-mini",
    price_key: "gpt-4o-mini",
    calls: 2,
    prompt_tokens: 100,
    completion_tokens: 100,
    total_tokens: 200,
  });
});

test("bySpecModel accumulates repeat traces of the same spec and model", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1"), twoModelProbe("t2")],
    attributions: [
      { trace_id: "t1", file: "a.spec.ts", test: "does a thing" },
      { trace_id: "t2", file: "a.spec.ts", test: "does a thing" },
    ],
    prices: P,
  });
  const row = agg.bySpecModel.find((r) => r.model === "gpt-4o-mini");
  assert.equal(agg.bySpecModel.length, 2, "two traces of one spec must not make four rows");
  assert.equal(row.calls, 4);
  assert.equal(row.total_tokens, 400);
});

test("bySpecModel keeps two different tests in the same file apart", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1"), twoModelProbe("t2")],
    attributions: [
      { trace_id: "t1", file: "a.spec.ts", test: "first" },
      { trace_id: "t2", file: "a.spec.ts", test: "second" },
    ],
    prices: P,
  });
  const titles = agg.bySpecModel.filter((r) => r.model === "gpt-4o-mini").map((r) => r.title_path).sort();
  assert.deepEqual(titles, ["first", "second"]);
});

test("unattributed traces collapse to ONE row per model with null identity", () => {
  // The DB's unique index treats two NULL test_keys as the SAME row
  // (COALESCE(test_key,'')), so emitting two would not duplicate — the live
  // ingest upserts and keeps the LAST, counting the loser in `rows_dropped`.
  // One of the two numbers would be silently discarded (#1253 review, finding 7).
  const agg = aggregate({
    probes: [twoModelProbe("t1"), twoModelProbe("t2")],
    attributions: [],
    prices: P,
  });
  assert.equal(agg.bySpecModel.length, 2);
  for (const row of agg.bySpecModel) {
    assert.equal(row.spec_path, null);
    assert.equal(row.title_path, null);
  }
  const row = agg.bySpecModel.find((r) => r.model === "gpt-4o-mini");
  assert.equal(row.calls, 4);
  assert.equal(row.total_tokens, 400);
});

test("an attributed and an unattributed trace of the same model stay separate rows", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1"), twoModelProbe("t2")],
    attributions: [{ trace_id: "t1", file: "a.spec.ts", test: "named" }],
    prices: P,
  });
  const mini = agg.bySpecModel.filter((r) => r.model === "gpt-4o-mini");
  assert.equal(mini.length, 2);
  assert.deepEqual(
    mini.map((r) => r.spec_path).sort((a, b) => String(a).localeCompare(String(b))),
    [null, "a.spec.ts"].sort((a, b) => String(a).localeCompare(String(b))),
  );
});

test("spanTokens is the span-derived total, independent of the trace totals", () => {
  // G3: trace-authoritative vs span-derived are two numbers and neither wins.
  // This probe's own total (300) disagrees with its spans (200+100=300 here, so
  // make one disagree deliberately).
  const agg = aggregate({
    probes: [twoModelProbe("t1", { total_tokens: 999 })],
    attributions: [],
    prices: P,
  });
  assert.equal(agg.spanTokens, 300, "spans sum to 300 regardless of the trace's claim");
  assert.equal(agg.totals.total_tokens, 999, "the trace's own total stays authoritative");
  assert.equal(agg.mismatches.length, 1, "and the disagreement is named");
});

test("spanTokens falls back to prompt+completion when a span omits its total", () => {
  const agg = aggregate({
    probes: [
      {
        trace_id: "t1",
        models: [{ model: "gpt-4o-mini", prompt_tokens: 7, completion_tokens: 3, calls: 1 }],
      },
    ],
    attributions: [],
    prices: P,
  });
  assert.equal(agg.spanTokens, 10);
});

test("bySpecModel is empty when there are no probes", () => {
  const agg = aggregate({ probes: [], attributions: [], prices: P });
  assert.deepEqual(agg.bySpecModel, []);
  assert.equal(agg.spanTokens, 0);
});

// #1255 item 2: the row identity must depend only on what aggregate() was handed.
//
// The DB keys a row on (run_id, COALESCE(test_key,''), model), so a row whose
// spec_path/title_path are null IS the unattributed bucket. An attribution record
// that carries a trace_id but no file/test used to key on the literal text
// "null" + NUL + "null" + NUL — a DIFFERENT producer key for the SAME DB identity.
// The live ingest upserts and keeps the last, counting the loser in `rows_dropped`,
// so one of the two numbers would be silently discarded. resolveTestAttribution()
// makes that record impossible today, but it is a TypeScript helper two modules
// away that this pure ESM module cannot see.

test("an attribution with no file/test does not open a SECOND unattributed row", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1"), twoModelProbe("t2")],
    // t1 has no attribution at all; t2 has a record that names neither field.
    attributions: [{ trace_id: "t2" }],
    prices: P,
  });
  const mini = agg.bySpecModel.filter((r) => r.model === "gpt-4o-mini");
  assert.equal(
    mini.length,
    1,
    "two producer rows on one DB identity — the ingest would keep one and count the " +
      `other in rows_dropped: ${JSON.stringify(mini)}`,
  );
  assert.equal(mini[0].spec_path, null);
  assert.equal(mini[0].title_path, null);
  // And no token is lost to the merge: both traces' spans land in the one row.
  assert.equal(mini[0].total_tokens, 400);
  assert.equal(mini[0].calls, 4);
});

test("an attribution with a file but no test is not credited to that file", () => {
  // Half an identity is not an identity: the DB's test_key is
  // md5(normalize(spec_path) || '::' || title_path), which a null title_path makes
  // NULL — i.e. the unattributed bucket. Stamping the spec_path onto that row would
  // make it read as a real measurement of a file, with no test to point at.
  const agg = aggregate({
    probes: [twoModelProbe("t1")],
    attributions: [{ trace_id: "t1", file: "a.spec.ts" }],
    prices: P,
  });
  for (const row of agg.bySpecModel) {
    assert.equal(row.spec_path, null, "a file without a test must not name the row");
    assert.equal(row.title_path, null);
  }
});

test("an empty-string test is treated as no identity, not as a real one", () => {
  // resolveTestAttribution already refuses an empty title upstream; this pins that
  // aggregate() does not depend on it having done so.
  const agg = aggregate({
    probes: [twoModelProbe("t1")],
    attributions: [{ trace_id: "t1", file: "a.spec.ts", test: "" }],
    prices: P,
  });
  assert.deepEqual(
    agg.bySpecModel.map((r) => [r.spec_path, r.title_path]),
    agg.bySpecModel.map(() => [null, null]),
  );
});

test("a fully identified attribution is still credited exactly as before", () => {
  // The guard above must not cost a real attribution its name — the regression this
  // change could plausibly introduce.
  const agg = aggregate({
    probes: [twoModelProbe("t1")],
    attributions: [{ trace_id: "t1", file: "a.spec.ts", test: "does a thing" }],
    prices: P,
  });
  const mini = agg.bySpecModel.find((r) => r.model === "gpt-4o-mini");
  assert.equal(mini.spec_path, "a.spec.ts");
  assert.equal(mini.title_path, "does a thing");
});

// ─── #1255 item 4: the producer's row identity is the DB's ───────────────────
//
// The DB keys on md5(e2e_normalize_spec_path(spec_path) || '::' || title_path). A
// producer key finer than that is the dangerous direction: two producer rows on one
// DB identity do not duplicate — the live ingest upserts, keeps the LAST, and counts
// the loser in `rows_dropped`, so one of the two numbers is discarded in silence.

test("normalizeSpecPath mirrors e2e_normalize_spec_path, including its pass-throughs", () => {
  assert.equal(normalizeSpecPath("tests-automations/a.spec.ts"), "tests/tests-automations/a.spec.ts");
  assert.equal(normalizeSpecPath("tests/tests-automations/a.spec.ts"), "tests/tests-automations/a.spec.ts");
  // NULL and '' are returned untouched by the SQL function; a `tests/` prefix on
  // either would invent a path out of an absence.
  assert.equal(normalizeSpecPath(null), null);
  assert.equal(normalizeSpecPath(""), "");
  assert.equal(normalizeSpecPath(undefined), undefined);
});

test("two spellings of one spec path merge into the single row the DB will file them under (#1255 item 4)", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1"), twoModelProbe("t2")],
    attributions: [
      { trace_id: "t1", file: "a.spec.ts", test: "does a thing" },
      { trace_id: "t2", file: "tests/a.spec.ts", test: "does a thing" },
    ],
    prices: P,
  });
  const mini = agg.bySpecModel.filter((r) => r.model === "gpt-4o-mini");
  assert.equal(
    mini.length,
    1,
    "both normalize to tests/a.spec.ts, so the ingest would keep one and count the " +
      `other in rows_dropped: ${JSON.stringify(mini)}`,
  );
  // Summed here, which is the arithmetic the DB cannot do once one row has been dropped.
  assert.equal(mini[0].total_tokens, 400);
  assert.equal(mini[0].calls, 4);
  // The stored value stays the RAW spelling the merged row was opened with.
  assert.equal(mini[0].spec_path, "a.spec.ts");
});

test("a different spec path still keys a different row — the merge is normalization, not collapse", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1"), twoModelProbe("t2")],
    attributions: [
      { trace_id: "t1", file: "a.spec.ts", test: "does a thing" },
      { trace_id: "t2", file: "b.spec.ts", test: "does a thing" },
    ],
    prices: P,
  });
  const paths = agg.bySpecModel
    .filter((r) => r.model === "gpt-4o-mini")
    .map((r) => r.spec_path)
    .sort();
  assert.deepEqual(paths, ["a.spec.ts", "b.spec.ts"]);
});

// ─── #1255 item 4: the unattributed bucket and its rows measure one population ──

test("a half-identified trace lands in the unattributed bucket, not in a null::null bySpec row", () => {
  const agg = aggregate({
    probes: [twoModelProbe("t1")],
    attributions: [{ trace_id: "t1", file: "a.spec.ts" }], // file, no test
    prices: P,
  });
  assert.equal(agg.unattributed.traces, 1, "its ROW is already unattributed; its trace must be too");
  assert.equal(agg.unattributed.total_tokens, 300);
  assert.deepEqual(
    agg.bySpec,
    [],
    `a spec row keyed "null::null" is a spec nobody can open: ${JSON.stringify(agg.bySpec)}`,
  );
});

test("unattributed.span_tokens is what the null-identity rows sum to, and total_tokens stays trace-authoritative", () => {
  // The trace reports 500; its spans add up to 300. §2.1 makes the trace's own total
  // authoritative for the run, and a row can only ever be built from spans.
  const agg = aggregate({
    probes: [twoModelProbe("t1", { total_tokens: 500 })],
    attributions: [],
    prices: P,
  });
  assert.equal(agg.unattributed.total_tokens, 500, "trace-authoritative");
  assert.equal(agg.unattributed.span_tokens, 300, "span sum");
  const rowSum = agg.bySpecModel
    .filter((r) => r.spec_path === null)
    .reduce((n, r) => n + r.total_tokens, 0);
  assert.equal(rowSum, agg.unattributed.span_tokens, "the rows must reconcile against span_tokens");
  assert.equal(agg.mismatches.length, 1, "and the gap is the mismatch the block already reports");
});

test("unattributed.span_tokens equals total_tokens when no trace in the bucket mismatches", () => {
  const agg = aggregate({ probes: [twoModelProbe("t1")], attributions: [], prices: P });
  assert.equal(agg.unattributed.total_tokens, 300);
  assert.equal(agg.unattributed.span_tokens, 300);
  assert.equal(agg.mismatches.length, 0);
});

test("the unattributed reason names the UI-delete path the hook cannot see (#1255 item 4)", () => {
  // The 1.6% residue measured on run 30867978556. A cause absent from this string
  // reads as a cause that does not exist.
  assert.match(UNATTRIBUTED_REASON, /through the UI/);
  assert.match(aggregate({ probes: [probe()], prices: PRICES }).unattributed.reason, /through the UI/);
});

// --- by_provider: the axis #1183 owed and this schema did not record (#1300 gap 1) ---
//
// The whole point of these tests is that the provider is READ, never derived. The
// rejected alternative — an id-prefix rule — gets every model in the shipped table
// right and gets `gpt-5-mini` wrong, because that row prices an Azure AI Foundry
// deployment (#1281): a prefix rule would fold its spend into the openai lanes'
// row, and those are different accounts.

// Two openai models, one anthropic, and the Azure deployment whose id looks openai.
// Rates are the shipped ones so a reader can check a figure by hand.
const MULTI = {
  "gpt-4o-mini": { provider: "openai", inputPerMillion: 0.15, outputPerMillion: 0.6 },
  "gpt-4o": { provider: "openai", inputPerMillion: 2.5, outputPerMillion: 10 },
  "claude-haiku-4-5": { provider: "anthropic", inputPerMillion: 1, outputPerMillion: 5 },
  "gpt-5-mini": { provider: "azure", inputPerMillion: 0.25, outputPerMillion: 2 },
};

const spanOf = (model, prompt, completion) => ({
  model,
  prompt_tokens: prompt,
  completion_tokens: completion,
  total_tokens: prompt + completion,
  calls: 1,
});

const multiProbe = (models, over = {}) => ({
  trace_id: "t1",
  flow_id: "f1",
  status: "ok",
  total_tokens: models.reduce((n, m) => n + m.total_tokens, 0),
  models,
  ...over,
});

test("parsePrices keeps a declared provider on a flat entry and on every band", () => {
  const prices = parsePrices(
    JSON.stringify({
      flat: { provider: "openai", inputPerMillion: 1, outputPerMillion: 2 },
      banded: [
        { since: "2026-01-01", provider: "anthropic", inputPerMillion: 2, outputPerMillion: 10 },
        { since: "2026-09-01", provider: "anthropic", inputPerMillion: 3, outputPerMillion: 15 },
      ],
    }),
  );
  assert.equal(prices.flat.provider, "openai");
  assert.deepEqual(
    prices.banded.map((b) => b.provider),
    ["anthropic", "anthropic"],
  );
});

// The shape guard for every caller that predates #1300: an entry with no
// `provider` must parse to exactly the object it parsed to before, not to one
// carrying `provider: undefined` (a different object under deepStrictEqual).
test("parsePrices omits the provider key entirely when none is declared", () => {
  const prices = parsePrices(JSON.stringify({ x: { inputPerMillion: 1, outputPerMillion: 2 } }));
  assert.deepEqual(prices, { x: { inputPerMillion: 1, outputPerMillion: 2 } });
  assert.ok(!("provider" in prices.x));
});

test("parsePrices treats a blank provider as absent, matching sync-model-prices' rejection", () => {
  const prices = parsePrices(JSON.stringify({ x: { provider: "   ", inputPerMillion: 1, outputPerMillion: 2 } }));
  assert.ok(!("provider" in prices.x));
  assert.equal(resolveProvider("x", prices, "2026-08-05"), null);
});

test("resolveProvider reads the declared provider, through the same key resolution as the price", () => {
  assert.equal(resolveProvider("gpt-4o-mini", MULTI, "2026-08-05"), "openai");
  // Resolved by substring, exactly like usdFor: a dated snapshot inherits its
  // family's row, so it must inherit that row's provider too.
  assert.equal(resolveProvider("claude-haiku-4-5-20260101", MULTI, "2026-08-05"), "anthropic");
});

test("resolveProvider keeps the Azure deployment out of openai's bucket (#1281)", () => {
  // The one case that makes an id-prefix rule wrong rather than merely fragile.
  assert.equal(resolveProvider("gpt-5-mini", MULTI, "2026-08-05"), "azure");
  assert.equal(resolveProvider("gpt-4o", MULTI, "2026-08-05"), "openai");
});

test("resolveProvider returns null for a model the price table does not resolve — never a guess", () => {
  assert.equal(resolveProvider("some-new-model", MULTI, "2026-08-05"), null);
  assert.equal(resolveProvider("", MULTI, "2026-08-05"), null);
  assert.equal(resolveProvider("gpt-4o-mini", {}, "2026-08-05"), null);
});

test("resolveProvider picks the band effective on the date when bands disagree (a model that changed accounts)", () => {
  const migrated = {
    m: [
      { since: "2026-01-01", provider: "openai", inputPerMillion: 1, outputPerMillion: 2 },
      { since: "2026-06-01", provider: "azure", inputPerMillion: 1, outputPerMillion: 2 },
    ],
  };
  assert.equal(resolveProvider("m", migrated, "2026-05-31"), "openai");
  assert.equal(resolveProvider("m", migrated, "2026-06-01"), "azure");
});

test("a date no band covers still reports the provider when every band agrees — unpriced is not unattributed", () => {
  // #1211 refuses to GUESS a rate for a date it has no band for. Who bills the
  // model is a different question, and this table answers it unambiguously.
  const banded = {
    m: [{ since: "2026-06-01", provider: "anthropic", inputPerMillion: 1, outputPerMillion: 2 }],
  };
  assert.equal(usdFor("m", 10, 10, banded, "2026-01-01"), null, "the rate is genuinely unknown");
  assert.equal(resolveProvider("m", banded, "2026-01-01"), "anthropic", "the account is not");
});

test("a date no band covers reports NO provider when the bands disagree about it", () => {
  const migrated = {
    m: [
      { since: "2026-06-01", provider: "openai", inputPerMillion: 1, outputPerMillion: 2 },
      { since: "2026-07-01", provider: "azure", inputPerMillion: 1, outputPerMillion: 2 },
    ],
  };
  assert.equal(resolveProvider("m", migrated, "2026-01-01"), null);
});

test("an effective band that declares no provider answers null — the fallback is for NO band, not a silent one", () => {
  // Found in review of #1300: the fallback used to fire on any absent provider,
  // so an effective band that says nothing borrowed a sibling band's account —
  // reporting a provider the row that priced these tokens does not name, which
  // is the one property resolveProvider() exists to hold.
  const partial = {
    m: [
      { since: "2026-01-01", provider: "azure", inputPerMillion: 1, outputPerMillion: 1 },
      { since: "2026-09-01", inputPerMillion: 1, outputPerMillion: 1 },
    ],
  };
  assert.equal(usdFor("m", 1e6, 0, partial, "2026-09-15"), 1, "the later band IS effective and prices the row");
  assert.equal(resolveProvider("m", partial, "2026-09-15"), null, "so its silence is the answer, not azure");
  assert.equal(resolveProvider("m", partial, "2026-05-01"), "azure", "the earlier band still answers for its own dates");
});

test("byProvider breaks a tie lexically, so a history line's row order cannot move on its own", () => {
  // Two providers with identical totals: without the tie-break the order falls
  // out of which span the trace listed first, and this value is appended to
  // reports/token-history.jsonl and diffed across runs.
  const prices = {
    a1: { provider: "zeta", inputPerMillion: 1, outputPerMillion: 1 },
    b1: { provider: "alpha", inputPerMillion: 1, outputPerMillion: 1 },
    c1: { inputPerMillion: 1, outputPerMillion: 1 },
  };
  const span = (model) => ({ model, calls: 1, prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 });
  const order = (models) =>
    aggregate({
      probes: [{ trace_id: "t", total_tokens: 100 * models.length, models: models.map(span) }],
      prices,
    }).byProvider.map((p) => p.provider);

  assert.deepEqual(order(["a1", "b1", "c1"]), ["alpha", "zeta", null]);
  assert.deepEqual(order(["c1", "b1", "a1"]), ["alpha", "zeta", null], "input order does not reach the output");
});

test("byProvider rolls the models up by who billed them, keeping azure its own row", () => {
  const agg = aggregate({
    probes: [
      multiProbe([spanOf("gpt-4o-mini", 100, 100), spanOf("gpt-4o", 100, 100)]),
      multiProbe([spanOf("claude-haiku-4-5", 100, 100)], { trace_id: "t2" }),
      multiProbe([spanOf("gpt-5-mini", 100, 100)], { trace_id: "t3" }),
    ],
    prices: MULTI,
    date: "2026-08-05",
  });
  const byProvider = Object.fromEntries(agg.byProvider.map((p) => [p.provider, p]));
  assert.deepEqual(Object.keys(byProvider).sort(), ["anthropic", "azure", "openai"]);
  assert.equal(byProvider.openai.calls, 2, "both openai models land in one row");
  assert.equal(byProvider.openai.total_tokens, 400);
  assert.deepEqual(byProvider.openai.models, ["gpt-4o", "gpt-4o-mini"], "sorted, and named");
  assert.equal(byProvider.azure.total_tokens, 200, "the Foundry deployment is NOT openai spend");
  // 100/1e6*0.15 + 100/1e6*0.6 + 100/1e6*2.5 + 100/1e6*10
  assert.equal(byProvider.openai.usd_estimated.toFixed(6), (0.000015 + 0.00006 + 0.00025 + 0.001).toFixed(6));
});

test("byProvider sums to the same tokens as byModel — both are span-derived", () => {
  const agg = aggregate({
    probes: [
      multiProbe([spanOf("gpt-4o-mini", 40, 48), spanOf("claude-haiku-4-5", 10, 20)]),
      multiProbe([spanOf("gpt-4o-mini", 5, 5)], { trace_id: "t2" }),
    ],
    prices: MULTI,
    date: "2026-08-05",
  });
  const sum = (rows) => rows.reduce((n, r) => n + r.total_tokens, 0);
  assert.equal(sum(agg.byProvider), sum(agg.byModel));
  assert.equal(sum(agg.byProvider), agg.spanTokens, "so it reconciles against span_tokens, not totals");
  const usdSum = (rows) => rows.reduce((n, r) => n + r.usd_estimated, 0);
  assert.equal(usdSum(agg.byProvider).toFixed(10), usdSum(agg.byModel).toFixed(10));
});

test("a model with no provider lands in a null bucket that NAMES its ids, never folded into a neighbour", () => {
  const agg = aggregate({
    probes: [multiProbe([spanOf("gpt-4o-mini", 10, 10), spanOf("brand-new-model", 30, 30)])],
    prices: MULTI,
    date: "2026-08-05",
  });
  const unknown = agg.byProvider.find((p) => p.provider === null);
  assert.ok(unknown, "an unresolvable provider is its own bucket");
  assert.deepEqual(unknown.models, ["brand-new-model"]);
  assert.equal(unknown.total_tokens, 60);
  assert.equal(unknown.usd_estimated, null, "unpriced stays null dollars, never 0");
  assert.equal(agg.byProvider.find((p) => p.provider === "openai").total_tokens, 20);
});

test("a provider bucket mixing a priced and a band-uncovered model reports null, not a partial sum", () => {
  // The only path that can mix inside ONE bucket: both models are anthropic, one
  // has no band for this date. A partial sum in a table row reads as that
  // provider's spend; null plus the named ids is the honest answer.
  const mixed = {
    "claude-haiku-4-5": { provider: "anthropic", inputPerMillion: 1, outputPerMillion: 5 },
    "claude-future": [{ since: "2026-09-01", provider: "anthropic", inputPerMillion: 1, outputPerMillion: 5 }],
  };
  const agg = aggregate({
    probes: [multiProbe([spanOf("claude-haiku-4-5", 10, 10), spanOf("claude-future", 10, 10)])],
    prices: mixed,
    date: "2026-08-05",
  });
  assert.equal(agg.byProvider.length, 1);
  assert.equal(agg.byProvider[0].provider, "anthropic");
  assert.equal(agg.byProvider[0].usd_estimated, null);
  assert.deepEqual(agg.byProvider[0].models, ["claude-future", "claude-haiku-4-5"]);
  assert.deepEqual(agg.unpricedModels, ["claude-future"], "and the cause is named as usual");
});

test("byProvider is sorted by tokens and is empty when nothing was captured", () => {
  const agg = aggregate({
    probes: [multiProbe([spanOf("gpt-4o-mini", 1, 1), spanOf("claude-haiku-4-5", 50, 50)])],
    prices: MULTI,
    date: "2026-08-05",
  });
  assert.deepEqual(
    agg.byProvider.map((p) => p.provider),
    ["anthropic", "openai"],
  );
  assert.deepEqual(aggregate({ probes: [], prices: MULTI }).byProvider, []);
});

test("byProvider carries a plain array, not a Set — it goes straight onto a history line", () => {
  const agg = aggregate({ probes: [probe()], prices: PRICES, date: "2026-08-05" });
  const roundTripped = JSON.parse(JSON.stringify(agg.byProvider));
  assert.deepEqual(roundTripped, agg.byProvider, "a Set would stringify to {} and lose the ids");
});

// The guard that keeps `unknown` from being the normal answer. sync-model-prices.mjs
// already refuses to build a payload from an entry with no provider, but that only
// runs on the sync lane; this asserts the same requirement over the SHIPPED table,
// which is what every run's provider rollup reads.
test("every entry and every band of the shipped price table declares a provider", () => {
  const raw = JSON.parse(readFileSync(new URL("./model-prices.json", import.meta.url), "utf8"));
  for (const [model, entry] of Object.entries(raw)) {
    if (model.startsWith("_")) continue;
    for (const band of Array.isArray(entry) ? entry : [entry]) {
      assert.ok(
        typeof band?.provider === "string" && band.provider.trim(),
        `${model}: every entry (and band) needs a provider, or its spend rolls up as "unknown"`,
      );
    }
  }
});

test("no model the suite actually measured rolls up as an unknown provider", () => {
  // The same id list #1197's finding I6 pinned for prices, asked of the provider
  // axis: a model that resolves a price but no provider is a half-filled row.
  const prices = loadPrices(new URL("./model-prices.json", import.meta.url));
  for (const model of [
    "gpt-4o-mini",
    "gpt-4o",
    "gpt-5-mini",
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "gemini-flash-latest",
    "gemini-3.5-flash",
  ]) {
    assert.ok(resolveProvider(model, prices, "2026-08-05"), `${model} must roll up to a named provider`);
  }
  // And the axes stay distinct: the Foundry deployment is not openai spend.
  assert.equal(resolveProvider("gpt-5-mini", prices, "2026-08-05"), "azure");
});
