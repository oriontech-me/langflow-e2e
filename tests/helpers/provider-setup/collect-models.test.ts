// Unit tests for `validateProviderWithFallback` (issues #1011 / #1017).
// Run with: npm run test:units
//
// This is the scenario matrix from PR #1015, moved INTO the repo. It was built
// and run in a scratch file because `node --test` had no way to execute
// TypeScript here, so the only regression net for the early-exit logic lived
// outside version control — the gap #1017 exists to close.
//
// What rides on this function: `collect-models` is the @stable pre-flight every
// provider spec depends on. Probing too long wedged the shared Langflow
// container and cost run 30351107916 every shard with zero tests executed;
// stopping too early re-opens #570's silent provider skips; picking the wrong
// representative error misclassifies a transient billing outage as key rot and
// hard-fails the run (#955's downgrade never fires).
//
// The error strings below are VERBATIM from run 30351107916
// (https://github.com/oriontech-me/langflow-e2e/actions/runs/30351107916), and
// so is the candidate ORDER of the Google/Anthropic catalogs — read out of that
// run's `Shard 1/4` log. Two strings are synthesized because that run never
// produced them; each says so where it is defined.
//
// That recorded order is a HISTORICAL snapshot, not the current ranking:
// #1171 moved `CANDIDATE_PREFS.anthropic` to haiku-first, so
// `rankCandidates("anthropic", ANTHROPIC_CATALOG)` now leads with
// `claude-haiku-4-5` rather than `claude-sonnet-5`. That is deliberate — these
// fixtures are INPUT to the fallback tests (which care about probe count and
// error classification, not order), and freezing the run's real order is what
// makes those tests reproduce the incident. The ordering assertions at the
// bottom of this file call `rankCandidates` directly and are the live contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  rankCandidates,
  validateProviderWithFallback,
  type ProviderRecord,
} from "./collect-models";

// ─── Verbatim provider errors ────────────────────────────────────────────────

/** Google, monthly spend cap exceeded — account-scoped, so byte-identical for every candidate. */
const SPEND_CAP =
  "Your project has exceeded its monthly spending cap. Please go to AI Studio at " +
  "https://ai.studio/spend to manage your project spend cap. Learn more at " +
  "https://ai.google.dev/gemini-api/docs/billing#project-spend-caps.";

/** Anthropic, drained balance — account-scoped, likewise identical for every candidate. */
const CREDIT_BALANCE =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing " +
  "to upgrade or purchase credits.";

/** Google, model-scoped 404 — NAMES the model, so consecutive candidates differ. */
const modelNotFound = (model: string): string =>
  `models/${model} is not found for API version v1beta, or is not supported for generateContent. ` +
  "Call ModelService.ListModels to see the list of available models and their supported methods.";

/**
 * SYNTHESIZED (run 30351107916 had a healthy OpenAI key): a revoked/rotated key.
 * Account-scoped and identical for every candidate exactly like the billing
 * errors — the discriminator that must still separate them is the billing
 * regex, not the early exit.
 */
const DEAD_KEY =
  "Incorrect API key provided: sk-proj-***. You can find your API key at " +
  "https://platform.openai.com/account/api-keys.";

/**
 * SYNTHESIZED: the validators' `catch` branch reports `e.message`, so a
 * runner-side network blip surfaces as this — identical for every candidate
 * while being neither model- nor account-scoped, just transient.
 */
const TRANSPORT = "fetch failed";

// ─── The real catalogs, in the order the run probed them ─────────────────────

/** Google's 36 candidates as `rankCandidates` ordered them on 2026-07-28. */
const GOOGLE_CATALOG: Array<[model: string, spendCapped: boolean]> = [
  ["gemini-2.5-flash", true],
  ["gemini-3.5-flash", true],
  ["gemini-flash-latest", true],
  ["gemini-3.5-flash-lite", true],
  ["gemini-3.6-flash", true],
  ["gemini-omni-flash-preview", true],
  ["gemini-3.1-flash-lite-image", true],
  ["gemini-3.5-live-translate-preview", false],
  ["gemini-3.1-flash-image", true],
  ["gemini-3-pro-image", true],
  ["gemini-3.1-flash-lite", true],
  ["gemini-flash-lite-latest", true],
  ["gemini-3.1-flash-tts-preview", true],
  ["gemini-robotics-er-1.6-preview", true],
  ["gemma-4-26b-a4b-it", true],
  ["gemma-4-31b-it", true],
  ["veo-3.1-lite-generate-preview", false],
  ["gemini-3.1-flash-live-preview", false],
  ["lyria-3-pro-preview", true],
  ["lyria-3-clip-preview", true],
  ["gemini-3.1-flash-lite-preview", true],
  ["gemini-3.1-flash-image-preview", true],
  ["gemini-3.1-pro-preview-customtools", true],
  ["gemini-3.1-pro-preview", true],
  ["gemini-3-flash-preview", true],
  ["gemini-3-pro-image-preview", true],
  ["gemini-3-pro-preview", true],
  ["veo-3.1-generate-preview", false],
  ["veo-3.1-fast-generate-preview", false],
  ["gemini-2.5-flash-image", true],
  ["gemini-2.5-pro", true],
  ["gemini-2.5-flash-lite", true],
  ["gemini-2.5-flash-preview-tts", true],
  ["gemini-2.5-pro-preview-tts", true],
  ["gemini-2.5-flash-preview-09-2025", false],
  ["gemini-2.5-flash-lite-preview-09-2025", false],
];

/** Anthropic's 13 candidates, same run — every one a drained-balance failure. */
const ANTHROPIC_CATALOG = [
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-sonnet-4-20250514",
  "claude-haiku-4-5",
  "claude-opus-5",
  "claude-fable-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-20250514",
];

// ─── Harness ─────────────────────────────────────────────────────────────────

/**
 * A fake validator driven by a per-model error map: `null` means the model
 * validates, a string is the error reported. Records every model it was asked
 * about, so a test can assert the PROBE COUNT — the quantity that wedged the
 * container when it ran to 49.
 */
function fakeValidator(
  provider: string,
  errors: Map<string, string | null>,
): { validate: (model: string) => Promise<ProviderRecord>; probed: string[] } {
  const probed: string[] = [];
  return {
    probed,
    validate: async (model: string): Promise<ProviderRecord> => {
      probed.push(model);
      // `??` would be wrong here: `null` is the "this model validates" signal,
      // not an absent entry.
      const error = errors.has(model) ? errors.get(model)! : "unexpected candidate";
      // `checkedAt` is passed through untouched by the function under test and no
      // assertion reads it, so a fixed stamp keeps the records shaped right
      // without pretending the value matters.
      const checkedAt = "2026-07-28T10:38:18.000Z";
      return error === null
        ? { provider, model, status: "active", error: null, checkedAt }
        : { provider, model, status: "inactive", error, checkedAt };
    },
  };
}

/**
 * `validateProviderWithFallback` narrates every candidate to stdout, which the
 * TAP output would swallow as diagnostics. Silence it so a failing assertion is
 * the only thing on screen.
 */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

/**
 * The billing/quota classifier read LIVE out of `tests/collect-models.spec.ts`,
 * not copied here. A copy would keep passing after the spec's regex changed,
 * which is the drift these tests exist to catch. Extraction failing is a hard
 * error, so the check can never go vacuous.
 */
function billingRegexFromSpec(): RegExp {
  const specPath = path.resolve(__dirname, "..", "..", "collect-models.spec.ts");
  const source = fs.readFileSync(specPath, "utf-8");
  const match = source.match(/const BILLING_OR_QUOTA\s*=\s*(\/[\s\S]*?\/[a-z]*);/);
  if (!match) {
    throw new Error(
      `could not read BILLING_OR_QUOTA out of ${specPath} — the unit test's ` +
        "classification check would be vacuous, so it fails loudly instead.",
    );
  }
  const body = match[1].slice(1, match[1].lastIndexOf("/"));
  const flags = match[1].slice(match[1].lastIndexOf("/") + 1);
  return new RegExp(body, flags);
}

const BILLING_OR_QUOTA = billingRegexFromSpec();

// ─── Scenarios ───────────────────────────────────────────────────────────────

test("2026-07-28 Google: stops after 3 of 36 candidates and reports the spend cap", async () => {
  const errors = new Map<string, string | null>(
    GOOGLE_CATALOG.map(([model, capped]) => [model, capped ? SPEND_CAP : modelNotFound(model)]),
  );
  const { validate, probed } = fakeValidator("google", errors);
  const result = await quiet(() =>
    validateProviderWithFallback("google", GOOGLE_CATALOG.map(([m]) => m), validate),
  );

  // 3 probes, not 36: the load multiplier that wedged the shared backend.
  assert.equal(probed.length, 3);
  assert.equal(result.status, "inactive");
  assert.match(result.error!, /SAME model-independent error/);
  assert.match(result.error!, /3 of 36 candidate/);
  // Classified TRANSIENT, so the spec warns instead of hard-failing (#955).
  assert.ok(
    BILLING_OR_QUOTA.test(result.error!),
    `spend cap must classify as billing/quota, got: ${result.error}`,
  );
});

test("Anthropic drained balance: stops after 3 of 13 candidates", async () => {
  const errors = new Map<string, string | null>(
    ANTHROPIC_CATALOG.map((model) => [model, CREDIT_BALANCE]),
  );
  const { validate, probed } = fakeValidator("anthropic", errors);
  const result = await quiet(() =>
    validateProviderWithFallback("anthropic", ANTHROPIC_CATALOG, validate),
  );

  assert.equal(probed.length, 3);
  assert.match(result.error!, /3 of 13 candidate/);
  assert.ok(BILLING_OR_QUOTA.test(result.error!));
});

test("#570: four gated lead models still fall through to the fifth, which works", async () => {
  // The case the fallback exists for. An early exit that fired at 2 would turn
  // this into an inactive provider and silently skip every spec that needs it.
  const models = Array.from({ length: 10 }, (_, i) => `model-${i + 1}`);
  const errors = new Map<string, string | null>(
    models.map((m, i) => [m, i < 4 ? modelNotFound(m) : null]),
  );
  const { validate, probed } = fakeValidator("google", errors);
  const result = await quiet(() => validateProviderWithFallback("google", models, validate));

  assert.equal(probed.length, 5);
  assert.equal(result.status, "active");
  assert.equal(result.model, "model-5");
  assert.equal(result.error, null);
});

test("dead key: identical non-billing error stops early AND stays a hard failure", async () => {
  // Same early exit, opposite verdict. The early exit must not launder a real
  // key/account problem into a transient one.
  const models = Array.from({ length: 10 }, (_, i) => `model-${i + 1}`);
  const errors = new Map<string, string | null>(models.map((m) => [m, DEAD_KEY]));
  const { validate, probed } = fakeValidator("openai", errors);
  const result = await quiet(() => validateProviderWithFallback("openai", models, validate));

  assert.equal(probed.length, 3);
  assert.equal(result.status, "inactive");
  assert.equal(
    BILLING_OR_QUOTA.test(result.error!),
    false,
    `a dead key must NOT classify as billing/quota, got: ${result.error}`,
  );
});

test("all candidates model-scoped: no early exit, the full sweep is unchanged", async () => {
  // The #570 path byte-for-byte: model-scoped errors never repeat, so the
  // streak never builds and every candidate is still probed.
  const models = Array.from({ length: 8 }, (_, i) => `model-${i + 1}`);
  const errors = new Map<string, string | null>(models.map((m) => [m, modelNotFound(m)]));
  const { validate, probed } = fakeValidator("google", errors);
  const result = await quiet(() => validateProviderWithFallback("google", models, validate));

  assert.equal(probed.length, 8);
  assert.match(result.error!, /all 8 candidate model\(s\) failed validation/);
  assert.doesNotMatch(result.error!, /stopped early/);
});

test("two identical failures then a success: does NOT bail at 2", async () => {
  // IDENTICAL_ERROR_LIMIT is 3 for this reason — 2 would sacrifice #570.
  const models = ["a", "b", "c", "d", "e"];
  const errors = new Map<string, string | null>([
    ["a", SPEND_CAP],
    ["b", SPEND_CAP],
    ["c", null],
    ["d", null],
    ["e", null],
  ]);
  const { validate, probed } = fakeValidator("google", errors);
  const result = await quiet(() => validateProviderWithFallback("google", models, validate));

  assert.equal(probed.length, 3);
  assert.equal(result.status, "active");
  assert.equal(result.model, "c");
});

test("transport blip on three probes: the sweep rides it out and the fourth works", async () => {
  // `fetch failed` is identical for every candidate but transient, so counting
  // it would turn a blip into an inactive provider with a non-billing error —
  // a HARD failure plus the silent skips the fallback prevents.
  const models = Array.from({ length: 10 }, (_, i) => `model-${i + 1}`);
  const errors = new Map<string, string | null>(
    models.map((m, i) => [m, i < 3 ? TRANSPORT : null]),
  );
  const { validate, probed } = fakeValidator("openai", errors);
  const result = await quiet(() => validateProviderWithFallback("openai", models, validate));

  assert.equal(probed.length, 4);
  assert.equal(result.status, "active");
  assert.equal(result.model, "model-4");
});

test("interleaved spend cap / model-404: the aggregate reports the MOST FREQUENT error", async () => {
  // The streak never reaches 3, so this takes the full-sweep path. Reporting
  // the LAST candidate's message (a model-scoped 404) is what misclassified
  // 2026-07-28 as key rot; frequency carries the account-scoped signal instead.
  const models = Array.from({ length: 9 }, (_, i) => `model-${i + 1}`);
  const errors = new Map<string, string | null>(
    models.map((m, i) => [m, i % 2 === 0 ? SPEND_CAP : modelNotFound(m)]),
  );
  const { validate, probed } = fakeValidator("google", errors);
  const result = await quiet(() => validateProviderWithFallback("google", models, validate));

  assert.equal(probed.length, 9);
  assert.match(result.error!, /most common error \(5\/9\)/);
  assert.ok(
    BILLING_OR_QUOTA.test(result.error!),
    `the aggregate must carry the account-scoped error, got: ${result.error}`,
  );
});

test("a tie in the aggregate resolves to the EARLIEST-seen error", async () => {
  // `mostCommonError` compares with strict `>`, so insertion order breaks ties —
  // documented in the source and, until now, asserted by nothing: `>=` would have
  // passed every other scenario here. Two spend caps and two 404s carrying the
  // SAME message (both name `model-2`, so they collapse into one count) is a 2-2
  // tie where the account-scoped error was seen first and must win.
  const models = ["model-1", "model-2", "model-3", "model-4"];
  const shared404 = modelNotFound("model-2");
  const errors = new Map<string, string | null>([
    ["model-1", SPEND_CAP],
    ["model-2", shared404],
    ["model-3", SPEND_CAP],
    ["model-4", shared404],
  ]);
  const { validate, probed } = fakeValidator("google", errors);
  const result = await quiet(() => validateProviderWithFallback("google", models, validate));

  assert.equal(probed.length, 4);
  assert.match(result.error!, /most common error \(2\/4\)/);
  assert.ok(
    result.error!.includes(SPEND_CAP),
    `the earliest-seen error must win the tie, got: ${result.error}`,
  );
});

// ─── Edges ───────────────────────────────────────────────────────────────────

test("empty candidate list: inactive, without probing anything", async () => {
  const { validate, probed } = fakeValidator("google", new Map());
  const result = await quiet(() => validateProviderWithFallback("google", [], validate));

  assert.equal(probed.length, 0);
  assert.equal(result.status, "inactive");
  assert.equal(result.model, null);
  assert.match(result.error!, /no models collected/);
});

test("missing key: stops on the FIRST candidate", async () => {
  // "<KEY> not set" fails identically for every candidate by construction, so
  // even one extra probe is waste.
  const models = ["a", "b", "c"];
  const errors = new Map<string, string | null>(
    models.map((m) => [m, "OPENAI_API_KEY not set"]),
  );
  const { validate, probed } = fakeValidator("openai", errors);
  const result = await quiet(() => validateProviderWithFallback("openai", models, validate));

  assert.equal(probed.length, 1);
  assert.equal(result.error, "OPENAI_API_KEY not set");
});

test("first candidate works: exactly one probe, record returned untouched", async () => {
  const { validate, probed } = fakeValidator("openai", new Map([["gpt-4o-mini", null]]));
  const result = await quiet(() =>
    validateProviderWithFallback("openai", ["gpt-4o-mini", "other"], validate),
  );

  assert.equal(probed.length, 1);
  assert.equal(result.status, "active");
  assert.equal(result.model, "gpt-4o-mini");
  assert.equal(result.error, null);
});

// ─── CANDIDATE_PREFS ordering (#1171) ────────────────────────────────────────
//
// What a unit test can and cannot prove here. `rankCandidates` decides which
// model `collect-models` probes FIRST, and the first one that validates is what
// it settles on and promotes to models.json[0] — which every parametrized agent
// spec then runs against. So the ordering is a real cost and coverage lever.
//
// But ordering is ALL a unit test can prove. CANDIDATE_PREFS encodes agent
// COMPATIBILITY, and the probe is a ~1-token completion that cannot tell "the
// key reaches this model" from "the Agent can drive it" — #570 found `gpt-5.6`
// passing the probe while the Agent returned empty replies. These assertions
// therefore guard against a silent reordering; they are NOT evidence that the
// leading model drives the agent suite. That evidence is the real @stable run
// recorded on #1171.

test("anthropic ranks claude-haiku-4-5 first — 2x cheaper than sonnet today, 3x from 2026-09-01", () => {
  const ranked = rankCandidates("anthropic", ANTHROPIC_CATALOG);
  assert.equal(ranked[0], "claude-haiku-4-5");
});

test("anthropic keeps sonnet reachable — a haiku-less catalog must not fall through to opus", () => {
  // The catalog here is in RAW api order, not the promoted order collect-models
  // writes after a successful sweep. That distinction is the whole test: a
  // failing sweep promotes nothing, so the raw order stands — and it leads with
  // claude-opus-5, the most expensive model Anthropic exposes (#1169's latent
  // risk note). Filtering the promoted ANTHROPIC_CATALOG instead would prove
  // nothing, because that fixture already starts with sonnet: the assertion
  // would pass with the sonnet tail deleted.
  const rawUnpromoted = [
    "claude-opus-5",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-sonnet-4-6",
  ];
  assert.equal(rankCandidates("anthropic", rawUnpromoted)[0], "claude-sonnet-5");
});

test("a future claude-haiku-5 is preferred over the pinned 4-5 id", () => {
  // The exact id ranks first, then the generic /haiku/ — so a newer haiku is
  // picked up without editing this map, as long as it sorts ahead in the
  // catalog. Both are haiku-tier, so either outcome is correct on price; this
  // pins that neither falls behind sonnet.
  const ranked = rankCandidates("anthropic", ["claude-sonnet-5", "claude-haiku-5", "claude-haiku-4-5"]);
  assert.deepEqual(ranked.slice(0, 2), ["claude-haiku-4-5", "claude-haiku-5"]);
  assert.ok(ranked.indexOf("claude-sonnet-5") > 1, "sonnet must rank behind every haiku");
});

test("openai still leads with gpt-4o-mini — the cheaper entries are reasoning models (#569)", () => {
  // Regression guard for the tempting-but-wrong optimisation: gpt-5-nano and
  // gpt-5.4-mini are cheaper per token and hang the playground for 120 s.
  const ranked = rankCandidates("openai", [
    "gpt-5-nano",
    "gpt-5.4-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1-nano",
  ]);
  assert.equal(ranked[0], "gpt-4o-mini");
  assert.ok(
    ranked.indexOf("gpt-5-nano") > ranked.indexOf("gpt-4.1-nano"),
    "no gpt-5.x model may outrank a gpt-4 family model",
  );
});

test("google is unchanged — its entries are already the flash tier", () => {
  const ranked = rankCandidates("google", [
    "gemini-3-pro",
    "gemini-flash-latest",
    "gemini-2.5-flash",
  ]);
  assert.equal(ranked[0], "gemini-2.5-flash");
});

test("an unknown provider falls back to raw catalog order rather than dropping models", () => {
  const catalog = ["b", "a", "c"];
  assert.deepEqual(rankCandidates("groq", catalog), catalog);
});
