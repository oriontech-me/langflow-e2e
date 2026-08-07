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
  formatSaveBusyFailure,
  isCollectorStallReason,
  NO_MODELS_COLLECTED,
  planSaveWait,
  rankCandidates,
  resolveRequiredProviders,
  validateProviderWithFallback,
  waitForButtonIdle,
  waitForToggleChecked,
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

test("#1370: the FIRST provider of three cannot spend the whole budget", () => {
  // 210s budget, two providers still to come, 30s reserved for each: 150s, not
  // the 180s ceiling. That gap is the mechanism, not a rounding artifact — the
  // ceiling is what ONE wait may cost, the budget is what the sweep may cost,
  // and before #1370 only the first of those existed.
  const plan = planSaveWait({ ceilingMs: 180_000, remainingMs: 210_000, providersLeftAfterThis: 2 });
  assert.deepEqual(plan, { wait: true, timeoutMs: 150_000 });
});

test("#1370: the ceiling still binds when the budget is ample", () => {
  const plan = planSaveWait({ ceilingMs: 180_000, remainingMs: 600_000, providersLeftAfterThis: 2 });
  assert.deepEqual(plan, { wait: true, timeoutMs: 180_000 }, "a wait must never outlive its own ceiling");
});

test("#1370: the ceiling is capped by what the budget can still afford", () => {
  // anthropic has already spent most of the sweep; the last provider is what the
  // reserve protects.
  const plan = planSaveWait({ ceilingMs: 180_000, remainingMs: 100_000, providersLeftAfterThis: 1 });
  assert.deepEqual(plan, { wait: true, timeoutMs: 70_000 }, "100s minus a 30s reserve for the one still to come");
});

test("#1370: the LAST provider reserves nothing and may spend the remainder", () => {
  const plan = planSaveWait({ ceilingMs: 180_000, remainingMs: 40_000, providersLeftAfterThis: 0 });
  assert.deepEqual(plan, { wait: true, timeoutMs: 40_000 });
});

test("#1370: an exhausted budget SKIPS the wait instead of shortening it to zero", () => {
  // Load-bearing: Playwright reads `timeout: 0` as NO timeout, so an exhausted
  // budget arriving as a number would wait forever — the exact opposite of the
  // budget's purpose. The discriminated result makes that unreachable.
  const plan = planSaveWait({ ceilingMs: 180_000, remainingMs: 30_000, providersLeftAfterThis: 1 });
  assert.equal(plan.wait, false);
  assert.match((plan as { reason: string }).reason, /budget is down to 30s/);
  assert.match((plan as { reason: string }).reason, /1 provider\(s\) still to configure/);
});

test("#1370: no reachable input yields a zero or negative timeout", () => {
  // The property, not one example: whatever the budget state, either the wait is
  // refused or it carries a timeout Playwright will honour as a deadline.
  for (const remainingMs of [-50_000, 0, 1, 4_999, 5_000, 29_999, 210_000]) {
    for (const providersLeftAfterThis of [0, 1, 2, 5]) {
      const plan = planSaveWait({ ceilingMs: 180_000, remainingMs, providersLeftAfterThis });
      if (plan.wait) {
        assert.ok(
          plan.timeoutMs >= 5_000,
          `remaining=${remainingMs} left=${providersLeftAfterThis} produced timeoutMs=${plan.timeoutMs}`,
        );
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
  });
  assert.equal(credential.wait, true);
  budget.remainingMs -= (credential as { timeoutMs: number }).timeoutMs;

  const configured = planSaveWait({
    ceilingMs: 60_000,
    remainingMs: budget.remainingMs,
    providersLeftAfterThis: 1,
  });
  assert.equal(configured.wait, false, "30s left, all of it reserved for the provider still to come");

  const spent = 210_000 - budget.remainingMs;
  assert.ok(spent <= 180_000, `one provider must not be able to spend 240s of a 210s budget, spent ${spent}`);
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
