// Unit tests for the tier-aware target resolver (issue #1184).
// Run with: npm run test:units
//
// What rides on this function: it decides which { provider, model } every
// parametrized LLM spec runs against — ~30 `@stable` tests across 17 files that
// used to each carry their own copy. Two failure directions, both expensive and
// both silent:
//
//  - Resolving MORE targets than before multiplies real paid inference across the
//    daily. The `MODEL_TEST_PROVIDER` sweep is exactly one such multiplier: 41
//    openai entries in the 2026-07-30 catalog.
//  - Resolving FEWER, or resolving a target with no provider, makes specs skip while
//    the run stays green — the #570 / #1012 failure this repo keeps re-learning.
//
// So the parity block below is the point of the file: for each of the five variants
// the copies had drifted into, assert the resolver reproduces what that variant
// produced. Everything else is the sharp edges.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  resolveTestTargets,
  type ModelRecord,
  type TestTarget,
} from "./test-targets";
import { makeTempDir } from "../../../scripts/lib/tmp-dir";

/** Shaped like a real models.json: settled model first per provider (collect-models
 * promotes it), with the rejected/unsuitable ones still listed behind it. */
const CATALOG: ModelRecord[] = [
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "openai", model: "gpt-image-1" },
  { provider: "openai", model: "text-embedding-3-small" },
  { provider: "anthropic", model: "claude-sonnet-5" },
  { provider: "anthropic", model: "claude-haiku-4-5" },
  { provider: "google", model: "gemini-2.5-flash" },
];

const NO_SKIPS = new Map<string, string>();

/** Every call site passes these seams; `env` defaults to process.env otherwise. */
function resolve(
  env: NodeJS.ProcessEnv,
  extra: Partial<Parameters<typeof resolveTestTargets>[0]> = {},
): TestTarget[] {
  return resolveTestTargets({
    tier: "tool-calling",
    env,
    models: CATALOG,
    skipReasons: NO_SKIPS,
    ...extra,
  });
}

const labels = (targets: TestTarget[]): string[] => targets.map((t) => t.label);

// ─── Parity with the five pre-#1184 variants ─────────────────────────────────

test("parity A/B: no env set resolves one model per provider, catalog order", () => {
  const targets = resolve({});
  assert.deepEqual(labels(targets), [
    "openai / gpt-4o-mini",
    "anthropic / claude-sonnet-5",
    "google / gemini-2.5-flash",
  ]);
  assert.deepEqual(
    targets.map((t) => t.options),
    [
      { provider: "openai", model: "gpt-4o-mini" },
      { provider: "anthropic", model: "claude-sonnet-5" },
      { provider: "google", model: "gemini-2.5-flash" },
    ],
  );
});

test("parity A/B: MODEL_TEST_ID resolves one target and infers its provider", () => {
  const targets = resolve({ MODEL_TEST_ID: "claude-haiku-4-5" });
  assert.deepEqual(labels(targets), ["anthropic / claude-haiku-4-5"]);
  assert.deepEqual(targets[0].options, {
    provider: "anthropic",
    model: "claude-haiku-4-5",
  });
});

test("parity D: requires vision skips the non-vision families", () => {
  // The vision copy excluded image/embedding models and preferred the settled one.
  const targets = resolve({}, { requires: "vision" });
  assert.deepEqual(labels(targets), [
    "openai / gpt-4o-mini",
    "anthropic / claude-sonnet-5",
    "google / gemini-2.5-flash",
  ]);
});

test("parity D: a provider with no vision model reports it instead of skipping blind", () => {
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: {},
    models: [{ provider: "openai", model: "gpt-image-1" }],
    skipReasons: NO_SKIPS,
  });
  assert.deepEqual(labels(targets), ["openai / (no vision model)"]);
  assert.equal(
    targets[0].skipReason,
    'Provider "openai" has no vision-capable model in models.json',
  );
});

test("parity E: the chat wording is preserved verbatim, not unified with vision", () => {
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "chat",
    env: {},
    models: [{ provider: "openai", model: "text-embedding-3-small" }],
    skipReasons: NO_SKIPS,
  });
  assert.deepEqual(labels(targets), ["openai / (no chat model)"]);
  assert.equal(
    targets[0].skipReason,
    'Provider "openai" has no chat model in models.json',
  );
});

test("vision prefers the SETTLED model over its own preference list (#964)", () => {
  // The assertion the first force-fail pass showed was missing. Settled-first is
  // only observable when the settled model IS capable and the preference list would
  // pick a different one — which is the #964 failure verbatim: the spec preferred a
  // hardcoded `gemini-*` alias over the model collect-models had actually validated,
  // and Google had retired the alias. Without this, dropping settled-first is a
  // silent behaviour change.
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: {},
    models: [
      { provider: "google", model: "gemini-3.5-flash" }, // settled, promoted to front
      { provider: "google", model: "gemini-flash-latest" }, // VISION_PREFS' first choice
    ],
    skipReasons: NO_SKIPS,
  });
  assert.deepEqual(labels(targets), ["google / gemini-3.5-flash"]);
});

test("vision falls back to VISION_PREFS only when the settled model cannot serve it", () => {
  // Settled model first and NOT vision-capable → the preference scan picks gpt-4o.
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: {},
    models: [
      { provider: "openai", model: "gpt-image-1" },
      { provider: "openai", model: "gpt-4.1-mini" },
      { provider: "openai", model: "gpt-4o" },
    ],
    skipReasons: NO_SKIPS,
  });
  assert.deepEqual(labels(targets), ["openai / gpt-4o"]);
});

// ─── The sharp edges ─────────────────────────────────────────────────────────

test("MODEL_TEST_PROVIDER alone SWEEPS the provider's catalog — documented, and the cost multiplier", () => {
  // This is the behaviour README / .env.example / CONTRIBUTING document, and the
  // reason select-pr-model-target.mjs never emits this variable without
  // MODEL_TEST_ID (#1169). If this assertion ever flips to a single target,
  // the docs and that script must change in the same commit.
  const targets = resolve({ MODEL_TEST_PROVIDER: "openai" });
  assert.deepEqual(labels(targets), [
    "openai / gpt-4o-mini",
    "openai / gpt-image-1",
    "openai / text-embedding-3-small",
  ]);
});

test("the pair MODEL_TEST_PROVIDER + MODEL_TEST_ID narrows to one — this is what pins a lane", () => {
  const targets = resolve({
    MODEL_TEST_PROVIDER: "openai",
    MODEL_TEST_ID: "gpt-4o-mini",
  });
  assert.deepEqual(labels(targets), ["openai / gpt-4o-mini"]);
});

test("a swept provider still honours the capability filter", () => {
  const targets = resolve({ MODEL_TEST_PROVIDER: "openai" }, { requires: "chat" });
  assert.deepEqual(labels(targets), ["openai / gpt-4o-mini"]);
});

test("a sweep whose capability filter empties a provider REPORTS it instead of vanishing", () => {
  // The review's worst finding: the filter could empty the list and the branch
  // returned [], so the spec declared zero tests, contributed nothing to the report,
  // and read green under --pass-with-no-tests. The same catalog must not be
  // "reported" on the default path and "invisible" on the sweep path (#570 / #1012).
  const catalog = [
    { provider: "openai", model: "text-embedding-3-small" },
    { provider: "openai", model: "gpt-image-1" },
  ];
  const swept = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: { MODEL_TEST_PROVIDER: "openai" },
    models: catalog,
    skipReasons: NO_SKIPS,
  });
  const byDefault = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: {},
    models: catalog,
    skipReasons: NO_SKIPS,
  });
  assert.deepEqual(labels(swept), ["openai / (no vision model)"]);
  assert.deepEqual(labels(swept), labels(byDefault), "the two paths must agree");
  assert.equal(
    swept[0].skipReason,
    'Provider "openai" has no vision-capable model in models.json',
  );
});

test("ALL_MODELS reports each emptied provider once, and keeps catalog order for the capable ones", () => {
  const catalog = [
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "openai", model: "gpt-4o" },
    { provider: "google", model: "gemini-embedding-001" },
  ];
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: { ALL_MODELS: "true" },
    models: catalog,
    skipReasons: NO_SKIPS,
  });
  assert.deepEqual(labels(targets), [
    "openai / gpt-4o-mini",
    "openai / gpt-4o",
    "google / (no vision model)",
  ]);
});

test("a sweep on a provider absent from the catalog REPORTS instead of running nothing", () => {
  // Round-2 review finding, and NOT introduced by #1184 — the pre-existing copies
  // filtered identically and had the same hole. Consolidating them is what made it
  // fixable in one place. Highly reachable: the catalog keys are lowercase while the
  // UI/testids use display casing, so `MODEL_TEST_PROVIDER=OpenAI` silently ran zero
  // tests and read green.
  for (const name of ["anthropic", "OpenAI"]) {
    const targets = resolveTestTargets({
      tier: "tool-calling",
      env: { MODEL_TEST_PROVIDER: name },
      models: [{ provider: "openai", model: "gpt-4o-mini" }],
      skipReasons: NO_SKIPS,
    });
    assert.equal(targets.length, 1, `${name} must report, not vanish`);
    assert.deepEqual(labels(targets), [`provider:${name} (not in catalog)`]);
    assert.match(targets[0].skipReason ?? "", /matches no model in models\.json/);
    assert.match(targets[0].skipReason ?? "", /present: openai/);
  }
});

test("the absent-provider report also fires with a capability filter set", () => {
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: { MODEL_TEST_PROVIDER: "anthropic" },
    models: [{ provider: "openai", model: "gpt-4o-mini" }],
    skipReasons: NO_SKIPS,
  });
  assert.equal(targets.length, 1);
  assert.match(targets[0].skipReason ?? "", /matches no model in models\.json/);
});

test("the unfit-pin reason points at the heuristic, since it matches on substrings", () => {
  // `gemini-2.5-flash-image` and `gpt-4o-image-preview` are excluded by NON_VISION
  // purely because their names contain "image", so an explicit pin of a genuinely
  // vision-capable model can be refused. The refusal is a reported skip, not a false
  // pass — but the message has to say the exclusion is a heuristic, or the reader is
  // told to "pin a vision-capable model" when they just did.
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: { MODEL_TEST_ID: "gemini-2.5-flash-image" },
    models: [{ provider: "google", model: "gemini-2.5-flash-image" }],
    skipReasons: NO_SKIPS,
  });
  assert.match(targets[0].skipReason ?? "", /name heuristic/);
  assert.match(targets[0].skipReason ?? "", /matches on substrings/);
});

test("a pinned MODEL_TEST_ID that cannot serve the capability is REPORTED, not run", () => {
  // The second review finding. The two capability specs had no MODEL_TEST_ID branch
  // at all, so they could never be handed an unfit model; gaining one without this
  // check would trade a silent skip for a misleading failure — a vision spec fed an
  // embedding model fails in a way that reads as a product regression (#570).
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: { MODEL_TEST_ID: "text-embedding-3-small" },
    models: [{ provider: "openai", model: "text-embedding-3-small" }],
    skipReasons: NO_SKIPS,
  });
  assert.equal(targets.length, 1);
  assert.match(targets[0].skipReason ?? "", /excluded from "vision"/);
  assert.match(targets[0].skipReason ?? "", /pin a vision-capable model/);
});

test("a pinned id that DOES serve the capability carries no skip reason", () => {
  const targets = resolve({ MODEL_TEST_ID: "gpt-4o-mini" }, { requires: "vision" });
  assert.equal(targets[0].skipReason, undefined);
});

test("an inactive provider outranks an unfit pinned model — it is the deeper reason", () => {
  const targets = resolveTestTargets({
    tier: "tool-calling",
    requires: "vision",
    env: { MODEL_TEST_ID: "text-embedding-3-small" },
    models: [{ provider: "openai", model: "text-embedding-3-small" }],
    skipReasons: new Map([["openai", "OpenAI key drained"]]),
  });
  assert.equal(targets[0].skipReason, "OpenAI key drained");
});

test("ALL_MODELS=true sweeps every provider", () => {
  const targets = resolve({ ALL_MODELS: "true" });
  assert.equal(targets.length, CATALOG.length);
});

test("MODEL_TEST_ID outranks MODEL_TEST_PROVIDER across providers", () => {
  // Behaviour change for the two copies that had no MODEL_TEST_ID branch, made
  // explicit so it is a decision and not a regression discovered later.
  const targets = resolve({
    MODEL_TEST_PROVIDER: "openai",
    MODEL_TEST_ID: "claude-sonnet-5",
  });
  assert.deepEqual(labels(targets), ["anthropic / claude-sonnet-5"]);
});

test("an id absent from the catalog returns a provider-less target AND warns", () => {
  // The silent-skip path (#570 / #1012). mcp-client-agent's copy took it without
  // printing anything, which is the one thing this must never do again.
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    const targets = resolve({ MODEL_TEST_ID: "gpt-9-imaginary" });
    assert.deepEqual(labels(targets), ["model:gpt-9-imaginary"]);
    assert.equal(targets[0].options.provider, undefined);
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not found in models\.json/);
});

test("an empty catalog falls back to the first configured provider AND warns", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  let targets: TestTarget[];
  try {
    targets = resolveTestTargets({
      tier: "tool-calling",
      env: {},
      models: [],
      skipReasons: NO_SKIPS,
    });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(labels(targets), ["provider:openai (fallback)"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /run collect-models\.spec\.ts first/);
});

test("skipReason from provider health reaches every target and outranks the capability reason", () => {
  const skips = new Map([["anthropic", "Anthropic key drained"]]);
  const targets = resolve({}, { skipReasons: skips });
  const anthropic = targets.find((t) => t.options.provider === "anthropic");
  assert.equal(anthropic?.skipReason, "Anthropic key drained");
  assert.equal(targets.find((t) => t.options.provider === "openai")?.skipReason, undefined);
});

test("an unreadable models.json THROWS — a missing file is a state, a corrupt one is undecidable", () => {
  // The first version of this file asserted the opposite (degrade to the fallback),
  // which was wrong in the direction this repo cares about: a corrupt catalog would
  // silently run the first-provider fallback — a different suite than intended —
  // while the report looked normal (#1035). The pre-#1184 copies threw here too
  // (`JSON.parse` with no `try`), so this is a restoration, not a new rule.
  const dir = makeTempDir("test-targets-");
  try {
    const bad = path.join(dir, "models.json");
    fs.writeFileSync(bad, "{ not json");
    assert.throws(() =>
      resolveTestTargets({
        tier: "tool-calling",
        env: {},
        skipReasons: NO_SKIPS,
        catalogPath: bad,
      }),
    );

    // A parseable payload of the wrong shape is equally undecidable.
    fs.writeFileSync(bad, JSON.stringify({ openai: "gpt-4o-mini" }));
    assert.throws(
      () =>
        resolveTestTargets({
          tier: "tool-calling",
          env: {},
          skipReasons: NO_SKIPS,
          catalogPath: bad,
        }),
      /must be an array of \{ provider, model \} records/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a MISSING models.json still degrades softly — the file is gitignored and the sweep is skippable", () => {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  let targets: TestTarget[];
  try {
    targets = resolveTestTargets({
      tier: "tool-calling",
      env: {},
      skipReasons: NO_SKIPS,
      catalogPath: path.join(os.tmpdir(), "definitely-absent-models.json"),
    });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(labels(targets), ["provider:openai (fallback)"]);
  assert.ok(warnings.some((w) => /models\.json not found/.test(w)));
});

// ─── Structural guard: the provider-contract layer must stay unpinnable ──────

test("provider-contract specs read neither pin variable — this is what #1185 relies on", () => {
  // core-functionality/model-provider/*-provider.spec.ts is the layer that keeps
  // multi-provider coverage once the daily pins the tool-calling tier. If one of
  // them starts reading MODEL_TEST_ID / MODEL_TEST_PROVIDER, the pin silently
  // narrows the contract layer too and the coverage argument in #1185 stops holding.
  const dir = path.join(
    __dirname,
    "../../tests-automations/regression/core-functionality/model-provider",
  );
  assert.ok(
    fs.existsSync(dir),
    `the provider-contract spec directory moved — update this guard, do not delete it: ${dir}`,
  );
  const specs = fs.readdirSync(dir).filter((f) => f.endsWith(".spec.ts"));
  assert.ok(specs.length >= 6, `expected the provider-contract specs, found ${specs.length}`);
  for (const spec of specs) {
    const source = fs.readFileSync(path.join(dir, spec), "utf-8");
    assert.doesNotMatch(
      source,
      /MODEL_TEST_ID|MODEL_TEST_PROVIDER/,
      `${spec} reads a pin variable — see #1185`,
    );
  }
});

// ─── ANY_COMPLETION_PROVIDER — local-model routing (#1187) ───────────────────
//
// The one tier this module acts on. Two directions to hold down, and they pull
// against each other:
//
//  - It must OUTRANK the pins, or it can never fire on the daily: #1185 emits
//    MODEL_TEST_ID + MODEL_TEST_PROVIDER into $GITHUB_ENV, which is global to the
//    run and reaches every parametrized spec.
//  - It must fire for NOTHING ELSE — not another tier, not a keyed provider, not a
//    missing model pin. Every rejection has to REPORT rather than fall through to
//    the hosted paths: falling through spends a paid call on a lane that asked for a
//    keyless one (possibly because its keys are dead) and reads green (#570/#1012).

/** Collect what the resolver warned while `fn` ran. */
function withWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: unknown) => void warnings.push(String(msg));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

const ROUTED_ENV = {
  ANY_COMPLETION_PROVIDER: "ollama",
  OLLAMA_TEST_MODEL: "llama3.2:1b",
};

test("routes an any-completion spec to the local provider, reading no catalog", () => {
  const targets = resolve(ROUTED_ENV, { tier: "any-completion" });
  assert.deepEqual(labels(targets), ["ollama / llama3.2:1b"]);
  assert.deepEqual(targets[0].options, { provider: "ollama", model: "llama3.2:1b" });
  assert.equal(targets[0].skipReason, undefined);
});

test("routing reads no catalog at all — an EMPTY models.json still resolves the local target", () => {
  // The lane this exists for is the one where every hosted key is dead, and
  // collect-models leaves an empty catalog exactly then. If routing depended on the
  // catalog it would fall back to `provider:openai (fallback)` on the very run it
  // was meant to rescue.
  const targets = resolve(ROUTED_ENV, { tier: "any-completion", models: [] });
  assert.deepEqual(labels(targets), ["ollama / llama3.2:1b"]);
});

test("routing leaves every other tier on the hosted paths", () => {
  for (const tier of ["none", "tool-calling", "provider-contract"] as const) {
    const targets = resolve(ROUTED_ENV, { tier });
    assert.deepEqual(
      labels(targets),
      ["openai / gpt-4o-mini", "anthropic / claude-sonnet-5", "google / gemini-2.5-flash"],
      `tier "${tier}" must ignore ANY_COMPLETION_PROVIDER`,
    );
  }
});

test("routing is inert when the variable is unset — the default path is untouched", () => {
  const targets = resolve({ OLLAMA_TEST_MODEL: "llama3.2:1b" }, { tier: "any-completion" });
  assert.deepEqual(labels(targets), [
    "openai / gpt-4o-mini",
    "anthropic / claude-sonnet-5",
    "google / gemini-2.5-flash",
  ]);
});

test("routing OUTRANKS MODEL_TEST_ID and says so — #1185's pin is global to the run", () => {
  const { result: targets, warnings } = withWarnings(() =>
    resolve(
      { ...ROUTED_ENV, MODEL_TEST_ID: "claude-haiku-4-5", MODEL_TEST_PROVIDER: "anthropic" },
      { tier: "any-completion" },
    ),
  );
  assert.deepEqual(labels(targets), ["ollama / llama3.2:1b"]);
  assert.ok(
    warnings.some((w) => /overrides the model pin/.test(w) && /claude-haiku-4-5/.test(w)),
    `the overridden pin must be named, never silent: ${JSON.stringify(warnings)}`,
  );
});

test("ALL_MODELS is overridden too, and named", () => {
  const { result: targets, warnings } = withWarnings(() =>
    resolve({ ...ROUTED_ENV, ALL_MODELS: "true" }, { tier: "any-completion" }),
  );
  assert.deepEqual(labels(targets), ["ollama / llama3.2:1b"]);
  assert.ok(warnings.some((w) => /ALL_MODELS=true/.test(w)));
});

test("a missing OLLAMA_TEST_MODEL is REPORTED, never guessed and never fallen through", () => {
  const { result: targets, warnings } = withWarnings(() =>
    resolve({ ANY_COMPLETION_PROVIDER: "ollama" }, { tier: "any-completion" }),
  );
  assert.equal(targets.length, 1);
  assert.equal(targets[0].label, "provider:ollama (routed)");
  assert.deepEqual(targets[0].options, {}, "no provider ⇒ the spec skips, it does not run hosted");
  assert.match(targets[0].skipReason ?? "", /OLLAMA_TEST_MODEL is not/);
  assert.ok(warnings.some((w) => /OLLAMA_TEST_MODEL/.test(w)));
});

test("an unknown provider name is reported with the known set", () => {
  const { result: targets } = withWarnings(() =>
    resolve({ ANY_COMPLETION_PROVIDER: "llamacpp" }, { tier: "any-completion" }),
  );
  assert.equal(targets[0].label, "provider:llamacpp (routed)");
  assert.match(targets[0].skipReason ?? "", /not a provider this suite knows/);
  assert.match(targets[0].skipReason ?? "", /ollama/);
});

test("a KEYED provider is rejected and pointed at MODEL_TEST_PROVIDER", () => {
  // Accepting it would make "the any-completion tier is routed" say nothing about
  // whether the run spends money — the entire point of the variable.
  const { result: targets } = withWarnings(() =>
    resolve(
      { ANY_COMPLETION_PROVIDER: "openai", OLLAMA_TEST_MODEL: "llama3.2:1b" },
      { tier: "any-completion" },
    ),
  );
  assert.equal(targets[0].label, "provider:openai (routed)");
  assert.match(targets[0].skipReason ?? "", /API-key provider/);
  assert.match(targets[0].skipReason ?? "", /MODEL_TEST_PROVIDER/);
});

test("a routed provider carries its providers.json skip reason like any other", () => {
  const targets = resolve(ROUTED_ENV, {
    tier: "any-completion",
    skipReasons: new Map([["ollama", "ollama inactive: instance unreachable"]]),
  });
  assert.equal(targets[0].skipReason, "ollama inactive: instance unreachable");
});
