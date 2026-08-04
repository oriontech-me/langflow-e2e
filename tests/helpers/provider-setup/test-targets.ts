// The one resolver that decides which { provider, model } targets a parametrized
// LLM spec runs against (issue #1184).
//
// ## Why this exists
//
// Until now `getTestTargets()` was **copy-pasted into 17 spec files**, and the copies
// had drifted into five variants — three of them semantically different, not just
// cosmetically:
//
//  - 14 specs carried the canonical shape (a `MODEL_TEST_ID` branch, a
//    `MODEL_TEST_PROVIDER` sweep, `ALL_MODELS`, and a first-per-provider dedup);
//    4 of those differed only in a warning string and blank lines.
//  - `mcp/client/mcp-client-agent.spec.ts` returned a target with
//    `provider: undefined` on the not-in-catalog path **with no warning at all**,
//    and had lost the empty-catalog warning too — the silent-skip failure #570 and
//    #1012 exist to prevent, on the one copy that announced nothing.
//  - `agent-multimodal-image-input.spec.ts` and `agent-markdown-output.spec.ts`
//    had **no `MODEL_TEST_ID` branch**, resolved a capability-filtered model
//    (vision / chat) instead of the catalog's first entry, and made
//    `MODEL_TEST_PROVIDER` *narrow* to one model rather than sweep.
//
// The last one was live: PR #1170 pins the PR lane by emitting `MODEL_TEST_PROVIDER`
// and `MODEL_TEST_ID` as a pair, and the vision copy ignored the id outright. It
// happened to run the intended model anyway, because `collect-models` promotes the
// settled model to `models.json[0]` and the vision resolver prefers index 0 — an
// accident of promotion, not a pin. That is the same latent coupling #1169 recorded.
//
// So the copies were not just duplication: they were 17 independent answers to
// "which model does this spec run", and a model-selection policy could not be
// changed without editing all of them and hoping none was missed.
//
// ## Two axes, not one
//
// `tier` says **what kind of target a lane should give this spec** — it is the
// vocabulary #1185 (pin the daily) and #1187 (route to Ollama) branch on. `requires`
// says **which model within a provider** satisfies the spec's assertion. They are
// orthogonal: `agent-multimodal-image-input` needs a real agent *and* a
// vision-capable model.
//
// `tier` was declared inert by #1184 and stayed that way until #1187, which acts on
// exactly one value: `any-completion`. See `ANY_COMPLETION_PROVIDER` below. The other
// three tiers still only record intent.
//
// ## Env precedence — unchanged, and load-bearing
//
// The order below is what `README.md`, `.env.example` and `CONTRIBUTING.md` already
// document, and it is preserved exactly (#1184's parity requirement):
//
//   MODEL_TEST_ID       → one target, that model (provider inferred from the catalog)
//   MODEL_TEST_PROVIDER → EVERY model that provider exposes  ← a sweep, not a filter
//   ALL_MODELS=true     → every model of every provider
//   (none set)          → one model per provider
//
// ## `ANY_COMPLETION_PROVIDER` sits ABOVE all four, and only for one tier (#1187)
//
// It routes `tier: "any-completion"` to a keyless local provider (today: `ollama`),
// and it deliberately OUTRANKS the pins. That inversion is the whole mechanism, not
// an oversight: #1185's weekday rotation emits `MODEL_TEST_ID` + `MODEL_TEST_PROVIDER`
// into `$GITHUB_ENV`, which is global to the run and reaches every parametrized spec
// alike. If the pin won, a routed spec would run the pinned hosted model and the
// routing could never take effect on the very lane it exists for. The two variables
// answer different questions — the pin says *which hosted provider this run uses*,
// the routing says *this spec needs no hosted provider at all* — so the narrower
// statement wins. An overridden pin is announced (`console.warn`), never silent
// (#1012), and the override is scoped to the one tier: every other tier reads the
// pins exactly as before.
//
// Two specs did not implement that order and now do, which is the point of the
// consolidation rather than a side effect: the vision and markdown copies gain the
// `MODEL_TEST_ID` branch they lacked. The one behaviour that genuinely changes for
// them is the cross-provider case — `MODEL_TEST_ID` naming a model that belongs to a
// provider other than `MODEL_TEST_PROVIDER`. They used to ignore the id and run the
// provider's own model; now the id wins and its provider is inferred, because that is
// what "highest priority" means everywhere else in the suite.
//
// `MODEL_TEST_PROVIDER` widening is **intentional documented behaviour**, not the bug
// #1169 called a trap. It is how a developer sweeps one provider locally. It is a
// footgun only when a lane emits it *without* `MODEL_TEST_ID` expecting a narrow run,
// which is precisely why `scripts/select-pr-model-target.mjs` never emits one without
// the other. Narrowing it here instead would contradict three documents and change 15
// specs; that trade was weighed for #1184 and declined.
import * as fs from "fs";
import * as path from "path";
import { providerConfigMap, type Provider } from "./provider-config";
import { providerSkipReasons } from "./provider-health";
import { ollamaTestModel } from "./ollama-endpoint";

/**
 * What a lane owes this spec. Consumed by lane-level policy (#1185, #1187), not here.
 *
 * - `none` — the spec makes no inference at all (provider modals, invalid-key UI,
 *   model toggles). A paid call added to such a spec later is a defect, not a cost.
 * - `any-completion` — any model that returns text; the assertion is plumbing, not
 *   model quality. The tier #1187 routes to a local model.
 *
 *   **The test is "does any assertion depend on the model CHOOSING to comply", not
 *   "is the reply's content read".** #1187 used the second wording and it admitted a
 *   spec that fails ~40 % of the time: `agent-system-prompt` reads the reply only for
 *   a sentinel the instruction told the model to include, which sounds like plumbing
 *   and is adherence — measured 9/15 through the Agent on `llama3.2:1b` while the same
 *   model, called directly with the same prompt, complied 10/10. So the reply may be
 *   read (`agent-context-id-*` runs the agent and reads nothing of what it says) and a
 *   sentinel may be asserted, as long as its presence is produced by Langflow or by
 *   the test, never by the model deciding to obey. Anything the model must *choose* to
 *   do — comply with an instruction, echo a token on request, attempt a tool call,
 *   keep going after a tool error — is `tool-calling`, whatever the assertion looks at.
 *
 *   Two consequences worth knowing before declaring this tier:
 *
 *    - **Evidence must be the spec on the lane.** A direct model probe measures a
 *      different system: the Agent wraps the instruction in tool-calling scaffolding
 *      and a small model spends its reply on that. 10/10 direct vs 60 % through the
 *      Agent is the same model, same prompt (#1187).
 *    - **N/N gating cannot certify a stochastic model.** At p=0.60, the "3/3, no
 *      retries" gate passes with probability ≈22 % — which is how the pilot was
 *      adopted. Record the measured rate over a stated N instead; a spec that is not
 *      ~100 % does not belong in this tier at all.
 *
 *   The declaration is per FILE, not per test: one `resolveTestTargets()` call feeds
 *   the `describe` parametrization, so a file holding even one model-dependent test
 *   cannot be routed. That is why `agent-tool-name-validation` stays `tool-calling`
 *   although its first test makes no model call (#1187).
 * - `tool-calling` — the assertion *is* model capability: tool selection, structured
 *   output, iteration caps. Needs a capable hosted model.
 * - `provider-contract` — this spec exists to exercise *that* provider specifically
 *   (`core-functionality/model-provider/*-provider.spec.ts`). Never narrowed by a
 *   lane pin: those specs read neither pin variable today, and a unit test in
 *   `test-targets.test.ts` fails if one starts to. That independence is what lets
 *   #1185 pin the daily without losing multi-provider coverage.
 */
export type ModelTier =
  | "none"
  | "any-completion"
  | "tool-calling"
  | "provider-contract";

/** Which model *within* a provider satisfies the spec. Omit when any model will do. */
export type ModelCapability = "vision" | "chat";

export interface ModelRecord {
  provider: string;
  model: string;
}

/**
 * Structurally compatible with `LoadSimpleAgentOptions` from `tests/pages`, declared
 * locally so `helpers/` does not depend on `pages/`.
 */
export interface TestTargetOptions {
  provider?: Provider;
  model?: string;
}

export interface TestTarget {
  label: string;
  options: TestTargetOptions;
  skipReason?: string;
}

export interface ResolveTestTargetsOptions {
  /**
   * What the spec needs from a lane. Every migrated agent spec was `tool-calling`
   * until #1187; two are now `any-completion` (`agent-context-id-continuity`,
   * `agent-context-id-isolation`).
   */
  tier: ModelTier;
  /** Capability filter within a provider. Omit for "any model this provider lists". */
  requires?: ModelCapability;
  /** Seam for unit tests, matching `providerSkipReasons`' convention. */
  env?: NodeJS.ProcessEnv;
  /** Seam for unit tests: `undefined` reads the catalog from disk. */
  models?: ModelRecord[];
  /** Seam for unit tests. */
  skipReasons?: Map<string, string>;
  /** Seam for unit tests. */
  catalogPath?: string;
}

const MODELS_PATH = path.join(__dirname, "data", "models.json");

// Model families that cannot serve a chat completion. Verbatim from
// agent-markdown-output.spec.ts.
const NON_CHAT = /embedding|tts|audio|whisper|realtime|image|moderation|search/i;

// Same, plus the families that are chat-capable but not vision-capable. Verbatim
// from agent-multimodal-image-input.spec.ts.
const NON_VISION =
  /gemma|embedding|tts|audio|whisper|realtime|image|customtools|moderation|search/i;

// Fallback preference per provider, used only when the settled model is not
// vision-usable. Alias/undated patterns only — a hardcoded dated id goes stale the
// moment the provider retires it (#886, #964). Verbatim from the vision spec.
const VISION_PREFS: Record<string, RegExp[]> = {
  openai: [/^gpt-4o-mini$/, /^gpt-4o$/, /^gpt-4\.1(-mini)?$/, /gpt-4o/, /^gpt-5.*mini$/, /^gpt-5/],
  google: [/^gemini-flash-latest$/, /gemini.*flash/, /gemini/],
  anthropic: [/^claude-3-5-sonnet/, /^claude-3-5-haiku/, /^claude-3-7/, /claude-3\.?5/, /claude-3/, /claude/],
};

const CAPABILITY_EXCLUDES: Record<ModelCapability, RegExp> = {
  chat: NON_CHAT,
  vision: NON_VISION,
};

// The `(no … model)` label fragment, kept byte-identical to the pre-#1184 copies:
// it reaches the test title, and a test title is the test's identity in
// `results.json`, `spec-durations.json` and the `@stable` auto-removal path.
// Renaming one silently orphans its history.
const CAPABILITY_MISSING_LABEL: Record<ModelCapability, string> = {
  chat: "(no chat model)",
  vision: "(no vision model)",
};

// Verbatim from each copy — the two specs worded this differently ("no chat model"
// vs "no vision-capable model") and parity is cheaper than picking a winner.
const CAPABILITY_MISSING_REASON: Record<ModelCapability, (p: string) => string> = {
  chat: (p) => `Provider "${p}" has no chat model in models.json`,
  vision: (p) => `Provider "${p}" has no vision-capable model in models.json`,
};

function readCatalog(jsonPath: string = MODELS_PATH): ModelRecord[] {
  if (!fs.existsSync(jsonPath)) {
    console.warn("models.json not found — run collect-models.spec.ts first.");
    return [];
  }
  // A MISSING file is a legitimate state — the sweep was skipped, or this is a fresh
  // clone (the file is gitignored). A file that EXISTS but cannot be parsed is
  // undecidable, and degrading it to the first-provider fallback would run a
  // different suite than the one intended while reporting as normal (#1035). The
  // pre-#1184 copies threw here too (`JSON.parse` with no `try`), so failing loud
  // restores that rather than inventing it.
  const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  if (!Array.isArray(parsed)) {
    throw new Error(
      `${jsonPath} must be an array of { provider, model } records, got ` +
        `${parsed === null ? "null" : typeof parsed}`,
    );
  }
  return parsed as ModelRecord[];
}

function modelsOf(provider: string, models: ModelRecord[]): string[] {
  return models.filter((m) => m.provider === provider).map((m) => m.model);
}

/**
 * The model of `provider` that satisfies `requires`, or `undefined` when it has none.
 *
 * **Settled-first (#964).** `collect-models` probes the catalog with real calls and
 * promotes the model it actually validated to the front of that provider's entries,
 * while still listing the ones it rejected. Preferring a hardcoded id over that
 * settled model pins a model nobody validated — the vision spec asked for
 * `^gemini-2.5-flash$` first, which Google had retired. So: take the settled model,
 * and fall back to the preference scan only when it cannot serve the capability.
 *
 * With no `requires`, this is the catalog's first entry for that provider — which is
 * exactly what the canonical copies' first-per-provider dedup produced.
 */
function resolveModel(
  provider: string,
  models: ModelRecord[],
  requires?: ModelCapability,
): string | undefined {
  const providerModels = modelsOf(provider, models);
  if (!requires) return providerModels[0];

  const exclude = CAPABILITY_EXCLUDES[requires];
  const settled = providerModels[0];
  if (settled && !exclude.test(settled)) return settled;

  const candidates = providerModels.filter((m) => !exclude.test(m));
  if (requires === "vision") {
    for (const pref of VISION_PREFS[provider] ?? [/.*/]) {
      const hit = candidates.find((m) => pref.test(m));
      if (hit) return hit;
    }
  }
  return candidates[0];
}

function targetFor(
  provider: string,
  models: ModelRecord[],
  skipReasons: Map<string, string>,
  requires?: ModelCapability,
): TestTarget {
  const model = resolveModel(provider, models, requires);
  if (model === undefined) {
    // Only reachable with a capability filter: providers are derived from the
    // catalog, so every one of them has at least one entry.
    const capability = requires as ModelCapability;
    return {
      label: `${provider} / ${CAPABILITY_MISSING_LABEL[capability]}`,
      options: { provider: provider as Provider, model },
      skipReason:
        skipReasons.get(provider) ?? CAPABILITY_MISSING_REASON[capability](provider),
    };
  }
  return {
    label: `${provider} / ${model}`,
    options: { provider: provider as Provider, model },
    skipReason: skipReasons.get(provider),
  };
}

/**
 * The local target for a routed `any-completion` spec, or `undefined` when routing
 * does not apply (#1187).
 *
 * Every rejection returns a REPORTED target rather than falling through to the
 * hosted paths. Falling through would be the worse failure of the two: the lane
 * asked for a local model — because its keys may be dead, which is the resilience
 * argument the issue rests on — and quietly spending a hosted call instead is both
 * the cost this exists to avoid and a green run that proves the wrong thing (#570 /
 * #1012). A reported skip says which knob is wrong.
 *
 * The model cannot be inferred here. `models.json` comes from `collect-models`,
 * which sweeps the keyed providers only, so a routed provider never appears in the
 * catalog — and Ollama's model list is the LIVE instance's `GET /api/tags`, not a
 * static catalog. Hence the pin (`OLLAMA_TEST_MODEL`) is required, and its absence
 * is reported instead of guessed: a name this suite invents is a name the instance
 * may not serve, and that surfaces as `MODEL_NOT_AVAILABLE` mid-spec.
 */
function resolveRoutedTarget(
  tier: ModelTier,
  env: NodeJS.ProcessEnv,
  skipReasons: Map<string, string>,
): TestTarget | undefined {
  const routed = env.ANY_COMPLETION_PROVIDER;
  if (!routed || tier !== "any-completion") return undefined;

  const label = `provider:${routed} (routed)`;
  const report = (reason: string): TestTarget => {
    console.warn(reason);
    return { label, options: {}, skipReason: reason };
  };

  if (!(routed in providerConfigMap)) {
    return report(
      `ANY_COMPLETION_PROVIDER="${routed}" is not a provider this suite knows ` +
        `(known: ${Object.keys(providerConfigMap).join(", ")}) — nothing would have run.`,
    );
  }
  const provider = routed as Provider;
  const config = providerConfigMap[provider];
  // Keyed providers are rejected on purpose: routing exists to reach a model that
  // needs no credit, and `MODEL_TEST_PROVIDER` already narrows to a hosted one. A
  // variable that silently accepted both would make "the any-completion tier is
  // routed" say nothing about whether the run spends money.
  if (config.credential !== "base-url") {
    return report(
      `ANY_COMPLETION_PROVIDER="${routed}" is an API-key provider, and this variable ` +
        `routes the any-completion tier to a KEYLESS local one (credential: ` +
        `"base-url"). To narrow the tier to a hosted provider use MODEL_TEST_PROVIDER.`,
    );
  }

  const model = ollamaTestModel(env);
  if (!model) {
    return report(
      `ANY_COMPLETION_PROVIDER="${routed}" is set but OLLAMA_TEST_MODEL is not — the ` +
        `model cannot be inferred (a routed provider is absent from models.json, and ` +
        `Ollama's list is the live instance). Set OLLAMA_TEST_MODEL to a tag the ` +
        `instance serves.`,
    );
  }

  if (env.MODEL_TEST_ID || env.MODEL_TEST_PROVIDER || env.ALL_MODELS === "true") {
    console.warn(
      `ANY_COMPLETION_PROVIDER="${routed}" overrides the model pin for this ` +
        `any-completion spec (ignoring ` +
        [
          env.MODEL_TEST_ID && `MODEL_TEST_ID="${env.MODEL_TEST_ID}"`,
          env.MODEL_TEST_PROVIDER && `MODEL_TEST_PROVIDER="${env.MODEL_TEST_PROVIDER}"`,
          env.ALL_MODELS === "true" && "ALL_MODELS=true",
        ]
          .filter(Boolean)
          .join(", ") +
        `). The tier declares it needs no hosted provider; the pin only says which ` +
        `hosted one the run would have used (#1187).`,
    );
  }

  return {
    label: `${provider} / ${model}`,
    options: { provider, model },
    // A FORWARD SEAM, not a live gate — and saying so is the point, because the
    // line reads like health enforcement. `providerSkipReasons()` is built only
    // from the `inactive` records in `providers.json`, and this same change takes
    // keyless providers out of the `collect-models` sweep on purpose, so nothing
    // can ever put `ollama` in that map today; the unit test that exercises this
    // branch has to inject one. It is wired anyway so a future keyless health
    // signal lands here instead of being added as a second, divergent check —
    // but do not read it as the reason an unreachable instance is caught. That
    // is `setupOllama`, which FAILS with `OLLAMA_PROVIDER_UNREACHABLE` rather
    // than routing the misconfiguration through a skip.
    skipReason: skipReasons.get(provider),
  };
}

/**
 * Resolve the targets a parametrized spec should run against.
 *
 * Replaces the 17 in-spec copies of `getTestTargets()`. With no env set the returned
 * list is identical to what each copy produced — asserted in `test-targets.test.ts`,
 * because a change here silently re-parametrizes ~30 `@stable` tests.
 */
export function resolveTestTargets(opts: ResolveTestTargetsOptions): TestTarget[] {
  const env = opts.env ?? process.env;
  const skipReasons = opts.skipReasons ?? providerSkipReasons();
  const allModels = opts.models ?? readCatalog(opts.catalogPath);
  const { requires } = opts;

  // 0. ANY_COMPLETION_PROVIDER — routes this tier to a keyless local model, above
  //    the pins. Reads no catalog: a routed provider is not in one (#1187).
  const routed = resolveRoutedTarget(opts.tier, env, skipReasons);
  if (routed) return [routed];

  // 1. MODEL_TEST_ID — highest documented priority. An explicit id is honoured as
  //    given: the caller asked for that model, so `requires` is not second-guessed.
  if (env.MODEL_TEST_ID) {
    const model = env.MODEL_TEST_ID;
    const record = allModels.find((m) => m.model === model);
    // An explicitly pinned id is honoured as given rather than silently swapped for
    // a capable one — but a model that cannot serve the declared capability must be
    // REPORTED, not run. A vision spec handed a non-vision model fails in a way that
    // reads as a product regression, which is the #570 trap. The pre-#1184 vision and
    // markdown copies could not hit this because they had no MODEL_TEST_ID branch at
    // all; gaining one without this check would trade a silent skip for a misleading
    // failure.
    const unfit =
      requires && CAPABILITY_EXCLUDES[requires].test(model)
        ? `MODEL_TEST_ID="${model}" is excluded from "${requires}" by the name ` +
          `heuristic in test-targets.ts. Pinned explicitly, so it is reported rather ` +
          `than silently replaced. Either pin a ${requires}-capable model, drop ` +
          `MODEL_TEST_ID to let the resolver pick one, or — if this model really does ` +
          `serve ${requires} — fix the heuristic: it matches on substrings, so a name ` +
          `containing "image" or "search" is excluded even when the model is capable.`
        : undefined;
    if (!record) {
      // Never silent: this path returns a target with NO provider, which makes the
      // spec skip while the run stays green (#570 / #1012).
      console.warn(
        `MODEL_TEST_ID="${model}" not found in models.json — provider cannot be inferred. ` +
          `Run collect-models.spec.ts first, or set MODEL_TEST_PROVIDER.`,
      );
      return [{ label: `model:${model}`, options: { model }, skipReason: unfit }];
    }
    const provider = record.provider as Provider;
    return [
      {
        label: `${provider} / ${model}`,
        options: { provider, model },
        // A dead provider outranks an unfit model: it is the more fundamental
        // reason the target cannot run.
        skipReason: skipReasons.get(provider) ?? unfit,
      },
    ];
  }

  // 2. No catalog at all — fall back to the first configured provider and say why.
  //    Without this a missing models.json parametrizes nothing and the spec vanishes
  //    from the report rather than reporting a reason.
  if (allModels.length === 0) {
    const fallback = Object.keys(providerConfigMap)[0] as Provider;
    console.warn("models.json not found or empty — run collect-models.spec.ts first.");
    return [
      {
        label: `provider:${fallback} (fallback)`,
        options: { provider: fallback },
        skipReason: skipReasons.get(fallback),
      },
    ];
  }

  // 3. MODEL_TEST_PROVIDER — sweep that provider's whole catalog. Documented
  //    behaviour (README / .env.example / CONTRIBUTING): "run all models for a
  //    provider". Capability-filtered when the spec declared one, so a vision spec
  //    sweeping openai does not try to send an image to an embedding model.
  // 4. ALL_MODELS=true — the same sweep across every provider.
  const sweepProvider = env.MODEL_TEST_PROVIDER;
  if (sweepProvider || env.ALL_MODELS === "true") {
    const scoped = allModels.filter((m) =>
      sweepProvider ? m.provider === sweepProvider : true,
    );

    // A sweep scoped to a provider the catalog does not contain resolved to ZERO
    // targets, silently, on every path — the spec declared no tests and read green.
    // This one is NOT new in #1184: the pre-existing copies filtered the same way and
    // had the same hole. Consolidating them is what makes it fixable in one place.
    //
    // It is very reachable. `MODEL_TEST_PROVIDER` is a bare string nothing validates,
    // and the catalog keys are lowercase (`openai`) while the UI and the testids use
    // display casing (`provider-item-OpenAI`) — so `MODEL_TEST_PROVIDER=OpenAI` is a
    // natural typo that silently ran nothing. A provider whose key is not configured
    // is also legitimately absent from the catalog, so this reports rather than
    // throws: a typo must not take all 17 specs down, but it must not read as a pass
    // either (#570 / #1012).
    if (sweepProvider && scoped.length === 0) {
      const present = Array.from(new Set(allModels.map((m) => m.provider)));
      const reason =
        `MODEL_TEST_PROVIDER="${sweepProvider}" matches no model in models.json ` +
        `(present: ${present.join(", ") || "none"}) — nothing would have run. Names are ` +
        `lowercase catalog keys, not display names.`;
      console.warn(reason);
      return [
        {
          label: `provider:${sweepProvider} (not in catalog)`,
          options: {},
          skipReason: reason,
        },
      ];
    }
    const exclude = requires ? CAPABILITY_EXCLUDES[requires] : undefined;
    const capable = scoped.filter((m) => (exclude ? !exclude.test(m.model) : true));
    const targets: TestTarget[] = capable.map((m) => ({
      label: `${m.provider} / ${m.model}`,
      options: { provider: m.provider as Provider, model: m.model },
      skipReason: skipReasons.get(m.provider),
    }));

    // A provider the capability filter emptied must still produce a REPORTED target,
    // exactly as the default path below does. Without this it simply vanishes from the
    // sweep: zero tests declared for that spec, nothing in the report, and green under
    // `--pass-with-no-tests` — the silent-skip failure #570 and #1012 exist to prevent.
    // The same catalog must not be "reported" on one code path and "invisible" on
    // another. Appended rather than interleaved so the capable targets keep catalog
    // order, which is what the pre-#1184 copies produced.
    if (exclude) {
      for (const provider of Array.from(new Set(scoped.map((m) => m.provider)))) {
        if (capable.some((m) => m.provider === provider)) continue;
        targets.push(targetFor(provider, scoped, skipReasons, requires));
      }
    }
    return targets;
  }

  // 5. Default — one model per provider present in the catalog.
  const providers = Array.from(new Set(allModels.map((m) => m.provider)));
  return providers.map((provider) => targetFor(provider, allModels, skipReasons, requires));
}
