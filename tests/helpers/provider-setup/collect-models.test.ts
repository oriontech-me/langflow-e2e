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
  classifyWaitFailure,
  COLLECTOR_STALL_PREFIX,
  formatBudgetSpend,
  formatSaveBusyFailure,
  isCollectorStallReason,
  NO_MODELS_COLLECTED,
  planConfiguredWait,
  planCredentialWait,
  planIdleWait,
  planSaveWait,
  sweepSaveBudgetMs,
  rankCandidates,
  resolveRequiredProviders,
  validateProviderWithFallback,
  waitForButtonIdle,
  waitForToggleChecked,
  type ProviderRecord,
  confirmEnabledOnServer,
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

// ─── waitForButtonIdle / formatSaveBusyFailure (#1355) ────────────────────────
//
// The incident these cover: `Collect models` failed twice in a row with
// `locator.click: Timeout 20000ms exceeded` on a `Save` button the log itself
// showed as `aria-busy="true" aria-disabled="true"` — the PREVIOUS provider's
// validation still in flight. The click's own actionability wait is capped
// below the ~35s a Google validation takes, so a slow-but-healthy save read as
// a broken button, and the error named the wrong step.
//
// Driven with an injected clock and a fake locator: the real failure needs a
// funded key and a slow backend, neither of which a unit lane has. What IS
// unit-testable is the decision — when the wait gives up, and what it reports.

/** A locator whose attribute/enabled readings are scripted per poll. */
function fakeButton(states: Array<{ ariaBusy?: string | null; ariaDisabled?: string | null; enabled?: boolean }>) {
  let poll = -1;
  const at = () => states[Math.min(poll, states.length - 1)] ?? {};
  return {
    reads: () => poll + 1,
    getAttribute: async (name: string) => {
      // aria-busy is read first in each poll, so advance the cursor there.
      if (name === "aria-busy") poll += 1;
      const s = at();
      return name === "aria-busy" ? (s.ariaBusy ?? null) : (s.ariaDisabled ?? null);
    },
    isEnabled: async () => at().enabled ?? true,
  };
}

/** A clock that only advances when the code under test sleeps. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

test("#1355: an already-idle button is answered on the first poll, without sleeping", async () => {
  const clock = fakeClock();
  const verdict = await waitForButtonIdle(fakeButton([{}]), { ...clock, timeoutMs: 60_000 });
  assert.equal(verdict.idle, true);
  assert.equal(verdict.polls, 1);
  assert.equal(verdict.waitedMs, 0, "a ready button must not cost the caller any wall clock");
});

test("#1355: a busy button that settles is waited out rather than failed", async () => {
  const clock = fakeClock();
  const button = fakeButton([
    { ariaBusy: "true", ariaDisabled: "true" },
    { ariaBusy: "true", ariaDisabled: "true" },
    {},
  ]);
  const verdict = await waitForButtonIdle(button, { ...clock, timeoutMs: 60_000, pollMs: 250 });
  assert.equal(verdict.idle, true);
  assert.equal(verdict.polls, 3);
  assert.equal(verdict.waitedMs, 500, "two sleeps of 250ms — this is the ~35s validation being ridden out");
});

test("#1355: a button busy past the deadline gives up and reports WHY, naming the provider", async () => {
  const clock = fakeClock();
  const verdict = await waitForButtonIdle(fakeButton([{ ariaBusy: "true", ariaDisabled: "true" }]), {
    ...clock,
    timeoutMs: 1_000,
    pollMs: 250,
  });
  assert.equal(verdict.idle, false);
  assert.equal(verdict.ariaBusy, "true");

  const message = formatSaveBusyFailure("anthropic", verdict);
  assert.match(message, /provider "anthropic"/);
  assert.match(message, /aria-busy\s+true/);
  assert.match(message, /still BUSY/);
  assert.match(
    message,
    /PREVIOUS provider's/,
    "the whole point of the message: the busy button is a symptom of the provider before it",
  );
});

// ─── What the failure message is ALLOWED to claim (#1385) ────────────────────
//
// Both verdict lines were wrong on run 31373880200, in opposite directions, on
// the same sweep. Shard 2 printed `aria-busy true … still BUSY` for a wait that
// had been clipped to 30.0s of its 60s ceiling; shards 3 and 4 printed
// `(absent)/(absent)/enabled false … a state this helper does not model` and
// sent the reader to the panel markup. That second state is reproducible in one
// step — it is the Save button with an EMPTY key field (measured on
// 1.12.0.dev22; with the key typed the same button is actionable on poll 1).

/** The verdict for google exactly as run 31373880200 shard 4 measured it. */
const GOOGLE_20260810 = {
  idle: false,
  ariaBusy: null,
  ariaDisabled: null,
  enabled: false,
  waitedMs: 30_100,
  polls: 117,
};

test("#1385: a wait the BUDGET shortened says so, and claims nothing about the markup", () => {
  const message = formatSaveBusyFailure("google", GOOGLE_20260810, {
    grantedMs: 30_000,
    ceilingMs: 60_000,
    remainingBudgetMs: 30_000,
    spentBefore: [
      { provider: "openai", ms: 4_000 },
      { provider: "anthropic", ms: 176_000 },
    ],
    keyFieldChars: 0,
  });

  assert.match(message, /BUDGET, not the panel/);
  assert.match(message, /shortened to 30\.0s of its\n\s+60\.0s ceiling/);
  assert.match(message, /"anthropic" 176\.0s/, "the collateral is unreadable without naming who spent it");
  assert.doesNotMatch(
    message,
    /does not model/,
    "the shipped message pointed at the panel markup for a wait that was never given its ceiling",
  );
  assert.doesNotMatch(message, /still BUSY/);
});

test("#1385: the budget verdict OUTRANKS the empty key field", () => {
  // Both were true on 2026-08-10. Only one of them is a claim this sweep can
  // support: with 30s of a 60s ceiling, the wait never established anything
  // about the field either.
  const message = formatSaveBusyFailure("google", GOOGLE_20260810, {
    grantedMs: 30_000,
    ceilingMs: 60_000,
    remainingBudgetMs: 30_000,
    spentBefore: [{ provider: "anthropic", ms: 176_000 }],
    keyFieldChars: 0,
  });
  assert.match(message, /BUDGET, not the panel/);
  assert.doesNotMatch(message, /API-key field is EMPTY/);
  assert.match(message, /key field\s+0 character\(s\)/, "still REPORTED, just not made the verdict");
});

test("#1385: a full-ceiling wait on an empty key field names the field, not the markup", () => {
  const message = formatSaveBusyFailure("google", GOOGLE_20260810, {
    grantedMs: 60_000,
    ceilingMs: 60_000,
    remainingBudgetMs: 300_000,
    spentBefore: [{ provider: "anthropic", ms: 20_000 }],
    keyFieldChars: 0,
  });
  assert.match(message, /API-key field is EMPTY/);
  assert.match(message, /did not reach the field/);
  assert.doesNotMatch(message, /does not model/);
});

test("#1385: an unreadable key field is UNKNOWN, and cannot become the empty-field verdict", () => {
  // #1012's rule: a field nobody could read is not a field that was empty.
  const message = formatSaveBusyFailure("google", GOOGLE_20260810, {
    grantedMs: 60_000,
    ceilingMs: 60_000,
    remainingBudgetMs: 300_000,
    spentBefore: [],
    keyFieldChars: null,
  });
  assert.match(message, /unreadable — unknown, not empty/);
  assert.doesNotMatch(message, /API-key field is EMPTY/);
  assert.match(message, /does not model/, "no supportable claim left — the last resort is the right one here");
});

test("#1385: a populated field, a full ceiling and a busy button still get the #1355 verdict", () => {
  const message = formatSaveBusyFailure(
    "google",
    { idle: false, ariaBusy: "true", ariaDisabled: "true", enabled: false, waitedMs: 60_000, polls: 240 },
    {
      grantedMs: 60_000,
      ceilingMs: 60_000,
      remainingBudgetMs: 300_000,
      spentBefore: [{ provider: "anthropic", ms: 20_000 }],
      keyFieldChars: 108,
    },
  );
  assert.match(message, /still BUSY/);
  assert.match(message, /PREVIOUS provider's/);
  assert.doesNotMatch(message, /BUDGET, not the panel/);
});

test("#1385: with no context at all the message is exactly the #1355 one", () => {
  // The context is optional so the helper stays callable from anywhere; a caller
  // that has nothing to add must not be made to invent it.
  const message = formatSaveBusyFailure("google", GOOGLE_20260810);
  assert.match(message, /does not model/);
  assert.doesNotMatch(message, /key field/);
  assert.doesNotMatch(message, /wait granted/);
});

test("#1385: the spend ledger renders who took the budget, and states an empty one", () => {
  assert.equal(
    formatBudgetSpend([
      { provider: "openai", ms: 4_000 },
      { provider: "anthropic", ms: 176_000 },
    ]),
    '"openai" 4.0s, "anthropic" 176.0s',
  );
  assert.match(
    formatBudgetSpend([]),
    /first provider of the sweep/,
    "an empty ledger is a finding, not an empty string",
  );
});

test("#1355: aria-disabled alone is not idle, and reads as the not-modelled state", async () => {
  const clock = fakeClock();
  const verdict = await waitForButtonIdle(fakeButton([{ ariaDisabled: "true" }]), {
    ...clock,
    timeoutMs: 500,
    pollMs: 250,
  });
  assert.equal(verdict.idle, false);
  const message = formatSaveBusyFailure("google", verdict);
  assert.match(message, /not busy, but not actionable/);
  assert.doesNotMatch(message, /still BUSY/);
});

test("#1355: clean aria attributes with a really-disabled button is still not idle", async () => {
  const clock = fakeClock();
  const verdict = await waitForButtonIdle(fakeButton([{ enabled: false }]), {
    ...clock,
    timeoutMs: 500,
    pollMs: 250,
  });
  assert.equal(
    verdict.idle,
    false,
    "aria-disabled is advisory markup and isEnabled() reads the real state — either alone blocks the click",
  );
  assert.equal(verdict.enabled, false);
});

test("#1355: a zero timeout still OBSERVES once instead of reporting a state it never read", async () => {
  const clock = fakeClock();
  const button = fakeButton([{ ariaBusy: "true" }]);
  const verdict = await waitForButtonIdle(button, { ...clock, timeoutMs: 0, pollMs: 250 });
  assert.equal(verdict.polls, 1, "#1012: an unobserved state is unknown, never clean");
  assert.equal(verdict.idle, false);
  assert.equal(verdict.ariaBusy, "true");
});

// ─── waitForToggleChecked (#1355, second half) ────────────────────────────────
//
// The measured cause behind the busy Save: enabling a model is a WRITE, and the
// collector enables every model of every provider. With a funded OpenAI key the
// panel exposes 41 visible models where a drained key exposed none worth
// toggling, so one provider went from ~0 writes to 41 against a backend the
// lanes run with LANGFLOW_WORKERS=1 — and the NEXT provider's Save queued behind
// them and never settled. Confirming each toggle is what serialises them.

/** A toggle whose `aria-checked` readings are scripted per poll. */
function fakeToggle(readings: Array<string | null>) {
  let i = -1;
  return {
    getAttribute: async () => {
      i += 1;
      return readings[Math.min(i, readings.length - 1)] ?? null;
    },
  };
}

test("#1355: a toggle already checked confirms on the first poll, without sleeping", async () => {
  const clock = fakeClock();
  const result = await waitForToggleChecked(fakeToggle(["true"]), { ...clock, timeoutMs: 5_000 });
  assert.equal(result.checked, true);
  assert.equal(result.polls, 1);
  assert.equal(result.waitedMs, 0, "the healthy path must not add wall clock per model");
});

test("#1355: a toggle that lands a moment later is waited out, serialising the write", async () => {
  const clock = fakeClock();
  const result = await waitForToggleChecked(fakeToggle(["false", "false", "true"]), {
    ...clock,
    timeoutMs: 5_000,
    pollMs: 100,
  });
  assert.equal(result.checked, true);
  assert.equal(result.polls, 3);
  assert.equal(result.waitedMs, 200);
});

test("#1355: a toggle that never confirms gives up at its own timeout and says so", async () => {
  const clock = fakeClock();
  const result = await waitForToggleChecked(fakeToggle(["false"]), {
    ...clock,
    timeoutMs: 500,
    pollMs: 100,
  });
  assert.equal(result.checked, false);
  assert.ok(result.waitedMs >= 500, "must not return before its own deadline");
});

// ─── classifyWaitFailure (#1370) ─────────────────────────────────────────────
//
// The incident: on run 31188034419 attempt 2 the spec hit its own 5-minute
// timeout, the context closed, and the two pending post-Save waits — one of
// 180s, one of 60s — both rejected at once. Their `.catch(() => null)` /
// `.catch(() => false)` reported that as two MEASURED negatives, 12 ms apart,
// at most 15.2s after the click. The log therefore said "no credential write
// observed within 180s" about a wait that never ran, which is why the question
// the issue asked ("is 180s simply short?") could not be answered from it.
//
// The strings below are VERBATIM from a live Playwright probe of both surfaces
// (`page.waitForResponse` and `locator.waitFor`), not from memory: an aborted
// wait rejects with a plain `Error`, an expired one with a `TimeoutError`.

/** What Playwright throws when the context closes under a pending wait. */
const ABORTED_RESPONSE = Object.assign(
  new Error("page.waitForResponse: Target page, context or browser has been closed"),
  { name: "Error" },
);
const ABORTED_LOCATOR = Object.assign(
  new Error("locator.waitFor: Target page, context or browser has been closed"),
  { name: "Error" },
);

/** What it throws when the deadline genuinely passes. */
const EXPIRED_RESPONSE = Object.assign(
  new Error('page.waitForResponse: Timeout 800ms exceeded while waiting for event "response"'),
  { name: "TimeoutError" },
);
const EXPIRED_LOCATOR = Object.assign(new Error("locator.waitFor: Timeout 800ms exceeded."), {
  name: "TimeoutError",
});

test("#1370: a wait cut short by the closing context is ABORTED, never an expiry", () => {
  // The whole defect in one assertion: reading this as `expired` is what printed
  // "no credential write observed within 180s" 12 ms after the previous warning.
  assert.equal(classifyWaitFailure(ABORTED_RESPONSE).kind, "aborted");
  assert.equal(classifyWaitFailure(ABORTED_LOCATOR).kind, "aborted");
});

test("#1370: a genuine deadline is EXPIRED on both wait surfaces", () => {
  assert.equal(classifyWaitFailure(EXPIRED_RESPONSE).kind, "expired");
  assert.equal(classifyWaitFailure(EXPIRED_LOCATOR).kind, "expired");
});

test("#1370: the aborted case is matched by MESSAGE, because its name is a plain Error", () => {
  // Keying on `name` alone is the tempting shortcut and it fails here: a closed
  // context does not produce a TimeoutError, so `name !== "TimeoutError"` would
  // have to mean "aborted", which would then swallow every unrecognised error
  // as a confident claim about the page closing.
  assert.equal(ABORTED_RESPONSE.name, "Error");
  assert.equal(classifyWaitFailure(ABORTED_RESPONSE).kind, "aborted");
});

test("#1370: an unrecognised failure is UNKNOWN — neither a measurement nor a cause", () => {
  const verdict = classifyWaitFailure(new Error("net::ERR_CONNECTION_RESET at http://localhost:7860"));
  assert.equal(verdict.kind, "unknown", "#1012: an unevaluated wait is unknown, never clean and never negative");
  assert.match(verdict.detail, /ERR_CONNECTION_RESET/, "an unknown must never be anonymous");
});

test("#1370: a non-Error rejection does not crash the classifier", () => {
  assert.equal(classifyWaitFailure("something odd").kind, "unknown");
  assert.equal(classifyWaitFailure(undefined).kind, "unknown");
});

test("#1370: the detail is the FIRST line, so a Playwright call log does not flood the warning", () => {
  const noisy = Object.assign(
    new Error(
      "locator.waitFor: Timeout 60000ms exceeded.\nCall log:\n  - waiting for getByRole('button')\n  - locator resolved to <button>",
    ),
    { name: "TimeoutError" },
  );
  assert.equal(classifyWaitFailure(noisy).detail, "locator.waitFor: Timeout 60000ms exceeded.");
});

// ─── planSaveWait (#1370) ────────────────────────────────────────────────────
//
// The arithmetic nobody did: 180s (credential write) + 60s (configured state) +
// 15s (toggles) is 255s spent on ONE provider inside a 300s test timeout. The
// ceilings were each sized against a measurement and none against the only clock
// that can end the run. Attempt 2 died at exactly 5 minutes; attempt 3 survived
// the same stall with 3s to spare.

// Every case below passes `reservePerProviderMs: 30_000` EXPLICITLY. It was the
// default when #1370 shipped and #1385 has since raised it to 60s, so pinning it
// here keeps these tests replaying the incident they were written from rather
// than silently re-deriving against whatever today's constant is. The live
// defaults get their own replay at the bottom of the #1385 block.
const RESERVE_1370 = { reservePerProviderMs: 30_000 };

test("#1370: the FIRST provider of three cannot spend the whole budget", () => {
  // 210s budget, two providers still to come, 30s reserved for each: 150s, not
  // the 180s ceiling. That gap is the mechanism, not a rounding artifact — the
  // ceiling is what ONE wait may cost, the budget is what the sweep may cost,
  // and before #1370 only the first of those existed.
  const plan = planSaveWait({
    ceilingMs: 180_000,
    remainingMs: 210_000,
    providersLeftAfterThis: 2,
    ...RESERVE_1370,
  });
  assert.deepEqual(plan, {
    wait: true,
    timeoutMs: 150_000,
    ceilingMs: 180_000,
    shortenedByBudget: true,
  });
});

test("#1370: the ceiling still binds when the budget is ample", () => {
  const plan = planSaveWait({
    ceilingMs: 180_000,
    remainingMs: 600_000,
    providersLeftAfterThis: 2,
    ...RESERVE_1370,
  });
  assert.deepEqual(
    plan,
    { wait: true, timeoutMs: 180_000, ceilingMs: 180_000, shortenedByBudget: false },
    "a wait must never outlive its own ceiling",
  );
});

test("#1370: the ceiling is capped by what the budget can still afford", () => {
  // anthropic has already spent most of the sweep; the last provider is what the
  // reserve protects.
  const plan = planSaveWait({
    ceilingMs: 180_000,
    remainingMs: 100_000,
    providersLeftAfterThis: 1,
    ...RESERVE_1370,
  });
  assert.deepEqual(
    plan,
    { wait: true, timeoutMs: 70_000, ceilingMs: 180_000, shortenedByBudget: true },
    "100s minus a 30s reserve for the one still to come",
  );
});

test("#1370: the LAST provider reserves nothing and may spend the remainder", () => {
  const plan = planSaveWait({
    ceilingMs: 180_000,
    remainingMs: 40_000,
    providersLeftAfterThis: 0,
    ...RESERVE_1370,
  });
  assert.deepEqual(plan, {
    wait: true,
    timeoutMs: 40_000,
    ceilingMs: 180_000,
    shortenedByBudget: true,
  });
});

test("#1370: an exhausted budget SKIPS the wait instead of shortening it to zero", () => {
  // Load-bearing: Playwright reads `timeout: 0` as NO timeout, so an exhausted
  // budget arriving as a number would wait forever — the exact opposite of the
  // budget's purpose. The discriminated result makes that unreachable.
  const plan = planSaveWait({
    ceilingMs: 180_000,
    remainingMs: 30_000,
    providersLeftAfterThis: 1,
    ...RESERVE_1370,
  });
  assert.equal(plan.wait, false);
  assert.match((plan as { reason: string }).reason, /budget is down to 30s/);
  assert.match((plan as { reason: string }).reason, /1 provider\(s\) still to configure/);
});

test("#1370: no reachable input yields a zero or negative timeout", () => {
  // The property, not one example: whatever the budget state, either the wait is
  // refused or it carries a timeout Playwright will honour as a deadline. The
  // share is swept too (#1385) — a fraction is a second way to reach zero.
  for (const remainingMs of [-50_000, 0, 1, 4_999, 5_000, 29_999, 210_000, 450_000]) {
    for (const providersLeftAfterThis of [0, 1, 2, 5]) {
      for (const shareOfRemaining of [undefined, 1, 0.5, 0.1, 0]) {
        const plan = planSaveWait({
          ceilingMs: 180_000,
          remainingMs,
          providersLeftAfterThis,
          shareOfRemaining,
        });
        if (plan.wait) {
          assert.ok(
            plan.timeoutMs >= 5_000,
            `remaining=${remainingMs} left=${providersLeftAfterThis} share=${shareOfRemaining} ` +
              `produced timeoutMs=${plan.timeoutMs}`,
          );
        }
      }
    }
  }
});

test("#1370: the two waits share one budget — 180 + 60 can no longer both be spent", () => {
  // The 255s-in-a-300s-test arithmetic, replayed. The credential wait takes its
  // full ceiling on the second of three providers, and the configured-state wait
  // that follows is then bounded by what is left rather than by its own 60s.
  const budget = { remainingMs: 210_000 };
  const credential = planSaveWait({
    ceilingMs: 180_000,
    remainingMs: budget.remainingMs,
    providersLeftAfterThis: 1,
    ...RESERVE_1370,
  });
  assert.equal(credential.wait, true);
  budget.remainingMs -= (credential as { timeoutMs: number }).timeoutMs;

  const configured = planSaveWait({
    ceilingMs: 60_000,
    remainingMs: budget.remainingMs,
    providersLeftAfterThis: 1,
    ...RESERVE_1370,
  });
  assert.equal(configured.wait, false, "30s left, all of it reserved for the provider still to come");

  const spent = 210_000 - budget.remainingMs;
  assert.ok(spent <= 180_000, `one provider must not be able to spend 240s of a 210s budget, spent ${spent}`);
});

// ─── The share cap and the collateral stall (#1385) ──────────────────────────
//
// #1370's reserve answers "will the NEXT provider have anything left". It cannot
// answer "will THIS provider's own remaining waits", and on 2026-08-10 that gap
// cost google every one of its 30s: the Save-idle wait — the one wait that is
// about the PREVIOUS provider, not this one — spent the whole reserve before a
// Save was ever clicked, so google was recorded as a stall having never been
// configured, on 3 of 4 shards.

test("#1385: the idle wait cannot spend a provider's whole allowance on the previous one", () => {
  // google's exact position on run 31373880200: last provider, 30s left.
  const withoutShare = planSaveWait({
    ceilingMs: 60_000,
    remainingMs: 30_000,
    providersLeftAfterThis: 0,
  });
  assert.deepEqual(
    withoutShare,
    { wait: true, timeoutMs: 30_000, ceilingMs: 60_000, shortenedByBudget: true },
    "the shipped behaviour: every remaining millisecond goes to waiting on anthropic",
  );

  const withShare = planSaveWait({
    ceilingMs: 60_000,
    remainingMs: 30_000,
    providersLeftAfterThis: 0,
    shareOfRemaining: 0.5,
  });
  assert.equal(withShare.wait, true);
  assert.equal((withShare as { timeoutMs: number }).timeoutMs, 15_000);
});

test("#1385: the share narrows a wait, it never widens one past its ceiling", () => {
  const plan = planSaveWait({
    ceilingMs: 60_000,
    remainingMs: 450_000,
    providersLeftAfterThis: 0,
    shareOfRemaining: 0.5,
  });
  assert.equal((plan as { timeoutMs: number }).timeoutMs, 60_000, "half of 450s is 225s — the ceiling still binds");
  assert.equal((plan as { shortenedByBudget: boolean }).shortenedByBudget, false);
});

test("#1385: a plan reports whether the BUDGET shortened it, not just the number", () => {
  // The flag is what lets the failure message separate "this button is broken"
  // from "this wait was never given the time to find out".
  const full = planSaveWait({ ceilingMs: 60_000, remainingMs: 450_000, providersLeftAfterThis: 0 });
  assert.equal((full as { shortenedByBudget: boolean }).shortenedByBudget, false);

  const clipped = planSaveWait({ ceilingMs: 60_000, remainingMs: 40_000, providersLeftAfterThis: 0 });
  assert.equal((clipped as { shortenedByBudget: boolean }).shortenedByBudget, true);
  assert.equal((clipped as { ceilingMs: number }).ceilingMs, 60_000, "the plan carries what it WOULD have had");
});

test("#1385: only the IDLE wait is share-capped — the write that configures a provider is not", () => {
  // Pins the call site, not the arithmetic: `planSaveWait` cannot tell which of
  // the three waits it is serving, so dropping the share at the call site would
  // pass every test above it. 40s left, last provider, nothing reserved.
  const idle = planIdleWait(40_000, 0);
  const credential = planCredentialWait(40_000, 0);
  const configured = planConfiguredWait(40_000, 0);

  assert.equal((idle as { timeoutMs: number }).timeoutMs, 20_000, "half — the previous provider's overhang");
  assert.equal((credential as { timeoutMs: number }).timeoutMs, 40_000, "all of it — this is the wait that saves");
  assert.equal((configured as { timeoutMs: number }).timeoutMs, 40_000);
});

test("#1385: the live ceilings are the measured ones, not the ones that were exceeded", () => {
  // A ceiling reachable only through a plan, so the numbers cannot drift apart
  // from the call site. 180s sat in the middle of the observed anthropic
  // distribution (largest success 176.2s, two shards past 180s).
  const ample = 10 * 60 * 1000;
  assert.equal((planCredentialWait(ample, 0) as { ceilingMs: number }).ceilingMs, 240_000);
  assert.equal((planIdleWait(ample, 0) as { ceilingMs: number }).ceilingMs, 60_000);
  assert.equal((planConfiguredWait(ample, 0) as { ceilingMs: number }).ceilingMs, 60_000);
  assert.equal(sweepSaveBudgetMs, 450_000);
});

test("#1385: the live reserve is a whole PASS per remaining provider, not one wait", () => {
  // Only observable where it binds — with 450s of budget it usually does not, so
  // a near-exhausted state is what pins it. 100s left with one provider to come:
  // 60s is held back, so this wait may have 40s. At #1370's 30s reserve it would
  // be 70s, which is the arithmetic that left google unable to click Save at all.
  const plan = planCredentialWait(100_000, 1);
  assert.equal(
    (plan as { timeoutMs: number }).timeoutMs,
    40_000,
    "the provider still to come needs idle + write + configured-state, not just a write",
  );
});

test("#1385: run 31373880200 replayed on the LIVE defaults — google keeps a usable allowance", () => {
  // The whole incident, in the arithmetic that produced it, driven through the
  // functions the sweep itself calls. anthropic takes its full credential
  // ceiling; the question is what google has left afterwards. Lowering
  // SWEEP_SAVE_BUDGET_MS, the reserve or the ceilings fails HERE rather than on
  // a shard three days later.
  const budget = { remainingMs: sweepSaveBudgetMs };

  // openai — fast in every run measured (~5s write), with two providers to come.
  budget.remainingMs -= 5_000;

  // anthropic: spends its entire ceiling and still leaves the sweep solvent.
  const anthropic = planCredentialWait(budget.remainingMs, 1);
  assert.equal(anthropic.wait, true);
  assert.equal(
    (anthropic as { timeoutMs: number }).timeoutMs,
    240_000,
    "a slow anthropic must reach its full ceiling — 176.2s succeeded once and 180s was exceeded twice",
  );
  budget.remainingMs -= (anthropic as { timeoutMs: number }).timeoutMs;

  // google's idle wait — the one that got 30s and spent all of it on 2026-08-10.
  const googleIdle = planIdleWait(budget.remainingMs, 0);
  assert.equal(googleIdle.wait, true);
  assert.equal(
    (googleIdle as { timeoutMs: number }).timeoutMs,
    60_000,
    "google's Save-idle wait gets its FULL ceiling even after anthropic spends 240s",
  );
  budget.remainingMs -= (googleIdle as { timeoutMs: number }).timeoutMs;

  // …and google's own credential write, which never happened at all on 3 of 4
  // shards, still comfortably clears its measured 10.5–18.8s cost.
  const googleWrite = planCredentialWait(budget.remainingMs, 0);
  assert.equal(googleWrite.wait, true);
  assert.ok(
    (googleWrite as { timeoutMs: number }).timeoutMs >= 60_000,
    `google's credential write must not be squeezed by a stalling anthropic; got ` +
      `${(googleWrite as { timeoutMs: number }).timeoutMs}ms`,
  );
});

test("#1385: the sweep budget fits inside the pre-flight's own test timeout", () => {
  // The constraint #1370 got backwards. The budget is only meaningful if the
  // test outlives it, and `tests/collect-models.spec.ts` is now what guarantees
  // that — 12 minutes against ~450s of waits plus the ~90s of build axis,
  // navigation, toggle sweeps, key probes and file writes.
  const PREFLIGHT_TIMEOUT_MS = 12 * 60 * 1000;
  const NON_WAIT_RESERVE_MS = 90_000;
  assert.ok(
    sweepSaveBudgetMs + NON_WAIT_RESERVE_MS < PREFLIGHT_TIMEOUT_MS,
    `${sweepSaveBudgetMs}ms of waits plus ${NON_WAIT_RESERVE_MS}ms of everything else must fit in ` +
      `${PREFLIGHT_TIMEOUT_MS}ms, or the budget is decorative and the test timeout is the real bound`,
  );

  const spec = fs.readFileSync(path.join(__dirname, "../../collect-models.spec.ts"), "utf-8");
  assert.match(
    spec,
    /test\.setTimeout\(12 \* 60 \* 1000\)/,
    "the spec must set the timeout this budget was sized against — the config default is 5 minutes",
  );
});

// ─── The collector-stall verdict (#1370) ─────────────────────────────────────

test("#1370: a collector stall is recognisable, and a key verdict is not mistaken for one", () => {
  assert.equal(isCollectorStallReason(`${COLLECTOR_STALL_PREFIX}no credential write answered within 180s`), true);
  assert.equal(isCollectorStallReason(NO_MODELS_COLLECTED), false);
  assert.equal(
    isCollectorStallReason("Incorrect API key provided: sk-proj-***"),
    false,
    "a dead key must keep failing the env-keyed step",
  );
  assert.equal(isCollectorStallReason(null), false);
  assert.equal(isCollectorStallReason(undefined), false);
});

test("#1370: a Save that never went idle becomes a stall, and cannot launder into a billing warning", async () => {
  // Found on this fix's own first CI run: anthropic's write was still in flight
  // when google's turn came, google's Save never became actionable inside its
  // own fixed 60s, and `waitForButtonIdle`'s caller THREW — ending the sweep
  // over one provider's backend cost, which is the defect this issue is about.
  // It is now recorded as a stall, and this pins both halves of what that has to
  // mean: recognisable as a collector stall, and NOT downgradable to the
  // transient billing/quota warning, which would make it disappear on every lane.
  const clock = fakeClock();
  const verdict = await waitForButtonIdle(fakeButton([{ ariaBusy: "true", ariaDisabled: "true" }]), {
    ...clock,
    timeoutMs: 60_000,
    pollMs: 250,
  });
  assert.equal(verdict.idle, false);

  const recorded = `${COLLECTOR_STALL_PREFIX}${formatSaveBusyFailure("google", verdict)}`;
  assert.equal(isCollectorStallReason(recorded), true);
  assert.equal(
    BILLING_OR_QUOTA.test(recorded),
    false,
    `a busy Save must not classify as a billing/quota outage, got: ${recorded}`,
  );
});

test("#1370: the empty-candidates path still produces the exact string the stall verdict replaces", async () => {
  // The link between the two files is a string comparison, so this pins that
  // `validateProviderWithFallback` keeps emitting the literal `collectProviders`
  // matches on. Reword one side only and the stall verdict silently stops
  // firing — the provider goes back to failing as a "key/account/config problem".
  const { validate } = fakeValidator("anthropic", new Map());
  const result = await quiet(() => validateProviderWithFallback("anthropic", [], validate));
  assert.equal(result.error, NO_MODELS_COLLECTED);
});

// ─── resolveRequiredProviders (#1370) ────────────────────────────────────────

test("#1370: unset requires every provider this run has a key for — today's behaviour", () => {
  assert.deepEqual(resolveRequiredProviders(undefined, ["openai", "anthropic", "google"]), {
    required: ["openai", "anthropic", "google"],
    unrecognised: [],
  });
  assert.deepEqual(resolveRequiredProviders("", ["openai"]), { required: ["openai"], unrecognised: [] });
  assert.deepEqual(resolveRequiredProviders("   ", ["openai"]), { required: ["openai"], unrecognised: [] });
});

test("#1370: the PR lane requires only the provider it pins itself to", () => {
  // A stalled anthropic changes no spec that lane runs — it pins openai
  // (#1169) — and yet it used to exit this pre-flight non-zero and cost the PR
  // its entire E2E run.
  assert.deepEqual(resolveRequiredProviders("openai", ["openai", "anthropic", "google"]), {
    required: ["openai"],
    unrecognised: [],
  });
});

test("#1370: a typo is reported, never silently required-nothing", () => {
  // The failure mode this guards: `openai ` misspelt filters to an empty
  // `required`, the gate matches nothing, and it is gone with every check green.
  const verdict = resolveRequiredProviders("openia", ["openai", "anthropic"]);
  assert.deepEqual(verdict.required, []);
  assert.deepEqual(verdict.unrecognised, ["openia"]);
});

test("#1370: naming a provider whose secret is unset is reported the same way", () => {
  // Indistinguishable from a typo at this layer, and it must be: a lane that
  // requires openai on a run with no OPENAI_API_KEY has a broken configuration,
  // not a satisfied gate.
  assert.deepEqual(resolveRequiredProviders("openai", ["anthropic"]), {
    required: [],
    unrecognised: ["openai"],
  });
});

test("#1370: separators and case do not change the selection", () => {
  assert.deepEqual(
    resolveRequiredProviders(" OpenAI, anthropic ", ["openai", "anthropic", "google"]).required,
    ["openai", "anthropic"],
  );
  assert.deepEqual(resolveRequiredProviders("openai google", ["openai", "google"]).required, [
    "openai",
    "google",
  ]);
});

test("#1355: waitedMs is what lets the caller bound the SUM, not just each write", async () => {
  // The per-item timeout never sees the total. 41 toggles each taking 5s would
  // spend 205s and blow the spec's own 5-minute budget, so the caller subtracts
  // `waitedMs` from an aggregate budget — this asserts the field it needs to do
  // that is real, and measured, not a constant.
  const clock = fakeClock();
  const slow = await waitForToggleChecked(fakeToggle(["false", "false", "true"]), {
    ...clock,
    timeoutMs: 5_000,
    pollMs: 250,
  });
  const fast = await waitForToggleChecked(fakeToggle(["true"]), { ...fakeClock(), timeoutMs: 5_000 });
  assert.equal(slow.waitedMs, 500);
  assert.equal(fast.waitedMs, 0);
  assert.ok(slow.waitedMs > fast.waitedMs, "a slow confirmation must cost the budget more than a fast one");
});

// --- #1649: the toggle confirmation was reading the OPTIMISTIC client cache ---
//
// `waitForToggleChecked` polls `aria-checked`, and `useModelToggleQueue` flips that
// synchronously at click time via `queryClient.setQueryData` — before any request
// leaves the browser. Measured on 1.12.0.dev44: all 36 clicks reported "confirmed"
// while the POST only went out at t=8132 ms. So a write that never reaches the
// server is indistinguishable from one that lands, the #1355 shortfall warning
// cannot fire, and the next spec inherits a provider it believes is fully enabled.
// The server is the only source that settles it, and it is read ONCE after the
// batch has flushed — polling it during the write was measured stalling a
// single-worker backend (`apiRequestContext.get: Timeout 20000ms exceeded`).
test("a server that answered confirms every model the loop expected", () => {
  const v = confirmEnabledOnServer({ "gpt-4o": true, "gpt-4o-mini": true }, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(v.kind, "confirmed");
  if (v.kind === "confirmed") assert.equal(v.expected, 2);
});

test("a write that never landed is a SHORTFALL naming the models, not a pass", () => {
  const v = confirmEnabledOnServer({ "gpt-4o": true, "gpt-4o-mini": false }, [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
  ]);
  assert.equal(v.kind, "shortfall");
  if (v.kind === "shortfall") {
    assert.deepEqual(v.missing, ["gpt-4o-mini", "gpt-4.1"]);
    assert.equal(v.enabled, 1);
    assert.equal(v.expected, 3);
    assert.match(v.message, /1 of 3/);
    assert.match(v.message, /gpt-4o-mini/);
    assert.match(v.message, /#1649/);
  }
});

test("a model missing from the response entirely counts as NOT enabled", () => {
  // Absence is not `true`. The endpoint lists every model of a configured
  // provider, so a key the loop expected and the response does not carry means
  // the write did not land — the exact state the optimistic read hid.
  const v = confirmEnabledOnServer({ "gpt-4o": true }, ["gpt-4o", "gpt-4o-mini"]);
  assert.equal(v.kind, "shortfall");
  if (v.kind === "shortfall") assert.deepEqual(v.missing, ["gpt-4o-mini"]);
});

test("a server that did not answer is UNAVAILABLE, never a silent confirmation", () => {
  // #1012: an unevaluated check is unknown, not clean. Reporting `confirmed` here
  // would be the same false green the optimistic read produced.
  const v = confirmEnabledOnServer(undefined, ["gpt-4o"]);
  assert.equal(v.kind, "unavailable");
  if (v.kind === "unavailable") assert.match(v.message, /could not be confirmed/i);
});

test("expecting nothing is confirmed, not unavailable — there was nothing to write", () => {
  const v = confirmEnabledOnServer(undefined, []);
  assert.equal(v.kind, "confirmed");
});
