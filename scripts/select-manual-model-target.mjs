#!/usr/bin/env node
/**
 * Resolves what `manual.yml`'s `provider` input asked for into the environment the
 * parametrized LLM specs read (#1186).
 *
 * ## Why this lane needs an input at all
 *
 * Multi-provider used to be the **default, by omission**: with no `MODEL_TEST_ID` /
 * `MODEL_TEST_PROVIDER` set, `resolveTestTargets()` returns one model per active
 * provider. Nobody requested it — you got it unless a lane opted out. Then both
 * scheduled lanes opted out: `pr-validation.yml` pins openai (#1169 / PR #1170) and
 * `daily-stable.yml` rotates one provider per weekday (#1185 / PR #1207). So there is
 * no lane left that runs multi-provider, and until this script there was no way to ask
 * for one short of editing a workflow file.
 *
 * The rotation bounds the detection window for a provider-specific regression, but not
 * as tightly as #1185's "≤3 days" reads. That figure is the *intra-week* gap; the
 * schedule is Mon-Fri only, so the real per-provider latency is:
 *
 *   openai     Mon, Thu  → ≤4 days (Thu → Mon)
 *   anthropic  Tue, Fri  → ≤4 days (Fri → Tue)
 *   google     Wed       → ≤7 days
 *
 * `google` runs once a week, and google is the provider of #963 (`mcp-client-agent`
 * returning "Message empty." on gemini while the tool fires). That gap is what this
 * escape hatch exists for.
 *
 * Those are BEST cases, not bounds: `selectDailyModelTarget` advances past an inactive
 * provider, so a Wednesday with a dry google key gives google no coverage that week and
 * pushes its latency past 14 days. The rotation is right to advance (#980) — it just
 * means the numbers above are what the schedule promises when every key is healthy.
 *
 * ## The four values
 *
 *   auto        one model per active provider — today's behaviour, emits NOTHING.
 *   openai      \
 *   anthropic    > pin to that provider's SETTLED model, as a pair.
 *   google      /
 *   all-models  ALL_MODELS=true — every model of every provider, a deliberate sweep.
 *
 * The three pinnable providers are exactly the ones this lane can run: `run-e2e`
 * forwards `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GOOGLE_API_KEY` and nothing
 * else, and a parametrized spec calls `hasProviderEnvKeys()` and skips itself when its
 * own key is absent (#967). Pinning to `groq` would therefore skip every spec while
 * the run read green. Adding a provider here means adding its key to `run-e2e` too —
 * the structural test below fails if the list and the workflow's `choice` options
 * drift apart.
 *
 * ## Why a script and not two `env:` lines
 *
 * Both reasons are inherited verbatim from `select-pr-model-target.mjs`, and both fail
 * as a *green run*:
 *
 * 1. **The variables are a pair.** `MODEL_TEST_PROVIDER` alone does not narrow the
 *    run — the provider branch of `resolveTestTargets()` skips the first-per-provider
 *    dedup and sweeps that provider's entire catalog (41 openai entries on
 *    2026-07-30). This never emits one without the other.
 * 2. **The model must be the SETTLED one.** A hardcoded id fails silently the day the
 *    CI project loses access: the resolver warns `not found in models.json`, returns a
 *    target with no provider, the spec skips and the run stays green (#570 / #1012).
 *    `providers.json` records what `collect-models` actually probed; read that.
 *
 * ## Why a request this cannot honour FAILS here, unlike the two sibling lanes
 *
 * `select-pr-model-target.mjs` and `select-daily-model-target.mjs` decline to pin and
 * let their lane fall back to the costlier multi-provider run. That is #980's trade:
 * on a *scheduled* lane, losing the day's coverage costs more than the spend, and
 * nobody asked for a specific provider — the pin is an optimisation the lane applies
 * to itself.
 *
 * Here the input **is the request.** A dispatch that says `anthropic` is asking "does
 * this break on anthropic", and a dry anthropic key makes that question unanswerable.
 * Falling back would spend 3x on a different question and report success — exactly the
 * shape #1012 forbids. Failing costs one re-dispatch and no scheduled coverage,
 * because this lane is never scheduled. So:
 *
 *   honoured                       → exit 0
 *   requested selection impossible → exit 1 with an `::error::` naming the cause
 *   payload undecidable            → exit 2 (#1035)
 *
 * `auto` never takes the exit-1 path: it emits nothing and needs no file, so the
 * default dispatch has no decision-path failure mode. (The *step* still runs — a broken
 * import or a missing `node_modules` fails it like any other step; what is guaranteed is
 * that no state of `providers.json` / `models.json` can.)
 *
 * ## `auto` is guarded too, because "emits nothing" is not the property that matters
 *
 * The property a dispatcher relies on is "`auto` delivers multi-provider", and that one
 * is NOT free. `collect-models` writes `models.json` at the very END of its Settings
 * sweep, so a sweep that throws part-way (the #922/#927 wedge, a broken Model Providers
 * page) leaves no catalog at all — and `Collect models` is `continue-on-error` on this
 * lane. In that state `resolveTestTargets()` takes its empty-catalog branch and returns
 * **one** target, `provider:openai (fallback)`, whose `skipReason` is `undefined`
 * (`readProviderHealth()` returns null on an absent file, so the skip map is empty).
 * OpenAI's key IS forwarded on this lane, so nothing skips: ~30 parametrized agent tests
 * run one provider and the job is green.
 *
 * That is the release-gate dispatch reporting multi-provider coverage it did not have —
 * the shape #1012 forbids, in the one branch a "reads nothing" argument would exempt. So
 * `auto` reads both files **for reporting only** (never failing on either) and warns when
 * the fan-out it is about to get is not the one that was asked for.
 *
 * **Both files, and the second one is the likelier failure.** Counting the catalog's
 * providers answers "how many did `collect-models` list", not "how many will run": the
 * resolver takes its targets from `models.json` and then attaches `providerSkipReasons()`
 * from `providers.json`, so a provider the probe recorded `inactive` still yields a target
 * — one that `test.skip()`s. And the two files disagree by construction, not by accident:
 * `collectAll()` scrapes the model lists in step 2 and validates the keys in step 3, so
 * `models.json` mirrors the Langflow catalog rather than the validation. That is how a
 * capped Google key left all 36 google models in the catalog (#1029). A catalog-only count
 * would print "Resolves 3 target(s)" for a dispatch where two of the three skip — the same
 * overstatement as the absent-catalog case, reached by the route this account has actually
 * been down three times (#772 openai, #1029 google, #1169 anthropic). So the count, the
 * warning and the printed line are all over the **runnable** targets, and the skipped ones
 * are named with the reason `collect-models` recorded.
 *
 * Reading `providers.json` here is **fail-open**, mirroring `readProviderHealth()`: absent
 * or unparseable means "no health signal", the skip map is empty and nothing skips, so
 * those providers are reported as runnable (with a warning that the fan-out is unverified)
 * rather than assumed dead. Assuming the opposite would be the same overstatement pointing
 * the other way.
 *
 * All of it warns rather than fails, because this value is also the default and a default
 * dispatch must not depend on the sweep.
 *
 * Run:
 *   node scripts/select-manual-model-target.mjs --selection anthropic
 *
 * `--selection` rather than `--provider`: it takes the workflow's `provider` input
 * verbatim, including `auto` and `all-models`, which are not provider names. The
 * sibling script's `--provider` means a real provider and the two sit side by side.
 *
 * Side effect: appends the resolved variables to `$GITHUB_ENV` when there are any.
 * Always prints the decision as JSON on stdout.
 */
import * as fs from "fs";
import {
  readProvidersFile,
  // Named for the lane that first needed it (#1169); it really answers
  // "is this provider usable, and what model did collect-models settle on".
  selectPrModelTarget as selectSettledTarget,
} from "./select-pr-model-target.mjs";

/** The values `--selection` accepts beyond a provider name. */
export const AUTO = "auto";
export const ALL_MODELS = "all-models";

/**
 * Providers this lane can pin to. Kept in sync with `manual.yml`'s `choice` options
 * and with the keys `run-e2e` forwards — both asserted structurally.
 */
export const PIN_PROVIDERS = ["openai", "anthropic", "google"];

const DEFAULT_PROVIDERS_FILE =
  "tests/helpers/provider-setup/data/providers.json";
const DEFAULT_MODELS_FILE = "tests/helpers/provider-setup/data/models.json";

const HELP = `Usage: node scripts/select-manual-model-target.mjs [options]

  --selection VALUE      manual.yml's \`provider\` input, verbatim:
                         ${[AUTO, ...PIN_PROVIDERS, ALL_MODELS].join(" | ")}
                         (default: ${AUTO})
  --providers-file PATH  providers.json written by collect-models
                         (default: ${DEFAULT_PROVIDERS_FILE})
  --models-file PATH     models.json written by collect-models
                         (default: ${DEFAULT_MODELS_FILE})
  -h, --help             this text
`;

/**
 * Why the *decision* is shared but the *message* is not — the same split
 * `select-daily-model-target.mjs` makes, for the same reason.
 *
 * `selectSettledTarget` ends its reason with the PR lane's remedy: "the lane keeps its
 * default per-provider parametrization". On this lane that sentence is FALSE — the
 * dispatch fails instead. A log line contradicting what the run did is worse than no
 * line, so the message is composed here from the record while the verdict (`ok`) and
 * the payload validation stay shared. Composed rather than sliced out of the shared
 * reason string, because the useful half (`collect-models reported: …`) sits in the
 * tail a split would drop.
 * @param {Array<{provider: string, status: string, error?: string}>} providers
 * @param {string} provider
 * @returns {string}
 */
function declineReason(providers, provider) {
  const record = providers.find((r) => r.provider === provider);
  if (!record) {
    return (
      `provider "${provider}" is absent from providers.json (present: ` +
      `${providers.map((r) => r.provider).join(", ") || "none"})`
    );
  }
  return (
    `provider "${provider}" probed "${record.status}" — collect-models reported: ` +
    `${record.error ?? "no error message"}`
  );
}

/**
 * Read the catalog without ever failing, for the `auto` path. Every unhappy state is a
 * status rather than a throw: the default dispatch must not depend on a sweep that is
 * `continue-on-error`, but it must also not claim a fan-out it will not get.
 * @param {() => { models: unknown, missing: boolean }} readModels
 * @returns {{ status: "ok"|"missing"|"empty"|"unreadable", models: Array<{provider: string, model: string}> }}
 */
function readCatalogSafely(readModels) {
  let payload;
  try {
    payload = readModels();
  } catch {
    return { status: "unreadable", models: [] };
  }
  if (payload.missing) return { status: "missing", models: [] };
  if (!Array.isArray(payload.models)) return { status: "unreadable", models: [] };
  return { status: payload.models.length ? "ok" : "empty", models: payload.models };
}

/**
 * The health signal `auto` needs, read without ever failing — and FAIL-OPEN, mirroring
 * `readProviderHealth()`: an absent or unparseable providers.json means "no signal", so
 * `providerSkipReasons()` returns an empty map and nothing skips at run time. Reporting
 * that state as "everything is skipped" would be as wrong as the overstatement this
 * exists to fix, in the other direction.
 * @param {() => { providers: unknown, missing: boolean }} readProviders
 * @returns {{ status: "ok"|"absent", skipReasons: Map<string, string> }}
 */
function readHealthSafely(readProviders) {
  let payload;
  try {
    payload = readProviders();
  } catch {
    return { status: "absent", skipReasons: new Map() };
  }
  if (payload.missing || !Array.isArray(payload.providers)) {
    return { status: "absent", skipReasons: new Map() };
  }
  const skipReasons = new Map();
  for (const record of payload.providers) {
    if (!record || typeof record.provider !== "string") continue;
    if (record.status === "inactive") {
      // Shape kept close to `inactiveReason()` in provider-health.ts — the message the
      // specs themselves print when they skip — without importing a TypeScript module
      // into this `.mjs` lane.
      skipReasons.set(
        record.provider,
        record.error ?? `probed "${record.status}", no error message recorded`,
      );
    }
  }
  return { status: "ok", skipReasons };
}

/**
 * The one warning that belongs to this lane and no other: `manual.yml` is the only
 * workflow that can set BOTH `any_completion_provider` (#1187) and `provider` (#1186),
 * and `resolveTestTargets()` makes the routing OUTRANK the pin for every spec declaring
 * `tier: "any-completion"` — deliberately, since the pin only says which hosted provider
 * the run would have used while the tier says it needs no hosted provider at all.
 *
 * The specs announce that override themselves (`console.warn`), but only in the
 * Playwright log, one line per routed spec, long after the dispatch is committed. This
 * lane's whole argument is that a dispatch which cannot be honoured as asked must say so
 * where the dispatcher is looking — so a selection that is partially overridden is
 * reported here too, at the step that resolved it.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} selection
 * @returns {string[]} zero or one warning
 */
function routedTierWarnings(env, selection) {
  const routed = env.ANY_COMPLETION_PROVIDER;
  if (!routed) return [];
  return [
    `any_completion_provider="${routed}" is set alongside provider="${selection}", and ` +
      `routing OUTRANKS the pin for every spec declaring tier: "any-completion" ` +
      `(#1187): those specs run the local keyless model, NOT ${
        selection === ALL_MODELS ? "the sweep" : selection
      }. Deliberate — the tier needs no hosted provider — but it means this dispatch ` +
      `does not answer "${selection}" for that tier. Dispatch without the routing to ` +
      `cover it`,
  ];
}

/**
 * The targets `auto` will actually resolve: the catalog's FIRST entry per provider,
 * which is what `resolveTestTargets()`' default branch produces (`collect-models`
 * promotes the settled model to the front, #570/#964). The *models* are derived from
 * `models.json` and never from `providers.json` — the catalog is the file the resolver
 * reads, so a model computed from the other one could disagree with the run.
 *
 * `skipReason` comes from providers.json because the resolver reads BOTH: it takes the
 * targets from the catalog and then attaches `providerSkipReasons()` to each one, so a
 * provider present in the catalog but recorded `inactive` produces a target that
 * `test.skip()`s. And the two files disagree routinely — `models.json` mirrors the
 * Langflow catalog, not the validation (`collect-models` collects the model lists in its
 * step 2 and only validates the keys in step 3), which is why a capped Google key left
 * all 36 google models in the catalog on run 30374528125 (#1029). Counting those as
 * coverage is the same overstatement as claiming a fan-out with no catalog at all: the
 * log would promise three providers while two of them skip.
 * @param {Array<{provider: string, model: string}>} models
 * @param {Map<string, string>} skipReasons
 * @returns {Array<{provider: string, model: string, skipReason?: string}>}
 */
function autoFanout(models, skipReasons = new Map()) {
  const seen = new Map();
  for (const record of models) {
    if (!record || typeof record.provider !== "string") continue;
    if (!seen.has(record.provider)) seen.set(record.provider, record.model);
  }
  return [...seen].map(([provider, model]) => {
    const skipReason = skipReasons.get(provider);
    // The key is added only when there IS one: an `undefined` property would make every
    // runnable target structurally different from the `{ provider, model }` record the
    // typedef documents.
    return skipReason === undefined
      ? { provider, model }
      : { provider, model, skipReason };
  });
}

/**
 * @typedef {object} ManualTargetDecision
 * @property {boolean} ok            the request was honoured
 * @property {string} mode           the selection, verbatim
 * @property {string[]} env          `KEY=value` lines to export (empty for `auto`)
 * @property {string|null} provider  the pinned provider, when pinning
 * @property {string|null} model     the settled model, when pinning
 * @property {Array<{provider: string, model: string, skipReason?: string}>} fanout
 *   what `auto` will resolve, each target carrying the reason it will skip when
 *   providers.json records its provider `inactive`; empty on every other mode
 * @property {string|null} reason    why the request could not be honoured
 * @property {string[]} warnings     deviations worth printing on a honoured request
 */

/**
 * Decide what a `--selection` resolves to.
 *
 * Reading is injected rather than done here so the decision stays pure and every
 * branch is unit-testable without a filesystem.
 *
 * @param {string} selection
 * @param {{ readProviders: () => { providers: unknown, missing: boolean },
 *           readModels: () => { models: unknown, missing: boolean },
 *           env?: NodeJS.ProcessEnv }} io
 * @returns {ManualTargetDecision}
 * @throws {Error} when a payload it needs is unreadable, when a reader is missing, or
 *   when the selection is not one of the documented values — all undecidable, not
 *   "nothing to pin" (#1035).
 */
export function selectManualModelTarget(selection, io = {}) {
  const known = [AUTO, ...PIN_PROVIDERS, ALL_MODELS];
  if (!known.includes(selection)) {
    // A value the workflow's `choice` list cannot produce means the two drifted, or
    // someone called this by hand. Either way, resolving it to `auto` would run a
    // multi-provider sweep while the dispatch summary said something else.
    throw new Error(
      `--selection="${selection}" is not one of: ${known.join(", ")}`,
    );
  }

  // Both readers are required on every path, checked before branching. `auto` swallows a
  // reader that THROWS on purpose (an unreadable file is a state, not a bug), and an
  // absent seam would be swallowed the same way — reported as "models.json cannot be
  // parsed" when the real fault is a caller that forgot to wire the reader. A
  // programming error must reach exit 2 with its own name on it.
  for (const seam of ["readProviders", "readModels"]) {
    if (typeof io[seam] !== "function") {
      throw new Error(
        `io.${seam} must be a function — the decision reads both files and cannot ` +
          `substitute a default for either`,
      );
    }
  }
  const env = io.env ?? {};

  if (selection === AUTO) {
    // No file is REQUIRED — no state of either file can fail this path. Both are still
    // read, because "emits nothing" is not the property a dispatcher relies on:
    // "delivers multi-provider" is, and it fails in two directions. An absent catalog
    // collapses the fan-out to a single fallback target; a catalog whose providers
    // providers.json records `inactive` resolves targets that all skip. See the header.
    const { status, models } = readCatalogSafely(io.readModels);
    const health = readHealthSafely(io.readProviders);
    const fanout = autoFanout(models, health.skipReasons);
    const runnable = fanout.filter((t) => t.skipReason === undefined);
    const skipped = fanout.filter((t) => t.skipReason !== undefined);
    const collapsed =
      `so resolveTestTargets() takes its empty-catalog branch and every parametrized ` +
      `spec resolves ONE "provider:openai (fallback)" target with no skip reason — ` +
      `this dispatch will NOT deliver multi-provider coverage, and openai's key is ` +
      `forwarded here so nothing will skip to make that visible`;
    const warnings = [];
    if (status === "missing") {
      warnings.push(
        `models.json does not exist (collect-models is continue-on-error on this lane ` +
          `and writes the catalog only at the END of its sweep), ${collapsed}`,
      );
    } else if (status === "empty") {
      warnings.push(`models.json is empty — every provider probe failed, ${collapsed}`);
    } else if (status === "unreadable") {
      warnings.push(
        `models.json cannot be parsed, so the fan-out cannot be verified here. The ` +
          `specs read the same file and fail loudly on it (readCatalog throws), which ` +
          `is the honest outcome — but this dispatch is not going to run`,
      );
    } else if (runnable.length < 2) {
      // Counted over the RUNNABLE targets, not the catalog's providers. Both halves of
      // the gap read as multi-provider when counted the other way: a catalog with one
      // provider, and a catalog with three of which two are recorded `inactive`. The
      // second is the one the account has actually been in (#772 openai, #1029 google,
      // #1169 anthropic), and it is the one the previous count could not see.
      warnings.push(
        `"auto" is single-provider in practice on this dispatch: ${runnable.length} of ` +
          `${fanout.length} catalog provider(s) can run` +
          `${runnable.length ? ` (${runnable.map((t) => t.provider).join(", ")})` : ""}` +
          `${
            skipped.length
              ? `, and ${skipped.length} resolve(s) a target that test.skip()s because ` +
                `providers.json records it inactive — ` +
                `${skipped.map((t) => `${t.provider}: ${t.skipReason}`).join("; ")}`
              : ` — the others are absent from the catalog, so their probe failed`
          }. A release-gate dispatch expecting multi-provider coverage should read this ` +
          `as the sweep having partially failed`,
      );
    } else if (skipped.length) {
      // Still multi-provider, so not the failure above — but the fan-out is smaller than
      // the catalog, and the line the CLI prints must not imply otherwise.
      warnings.push(
        `${skipped.length} of ${fanout.length} catalog provider(s) will resolve a target ` +
          `that test.skip()s (providers.json records them inactive) — ` +
          `${skipped.map((t) => `${t.provider}: ${t.skipReason}`).join("; ")}. This ` +
          `dispatch still covers ${runnable.length} providers, so it is multi-provider, ` +
          `just narrower than the catalog suggests`,
      );
    }
    if (status === "ok" && health.status === "absent") {
      // Fail-open, exactly as the specs do: no health signal means nothing skips. Worth
      // one line, because the fan-out above is then unverified against the probe — a
      // provider whose key is dead is counted as runnable and will fail live instead.
      warnings.push(
        `providers.json is absent or unparseable, so the fan-out above is the raw ` +
          `catalog: providerSkipReasons() returns an empty map, nothing will skip, and a ` +
          `provider whose credential is dead will fail live rather than skip. Reported ` +
          `rather than assumed-skipped, which is what the specs do (#1029)`,
      );
    }
    return {
      ok: true,
      mode: AUTO,
      env: [],
      provider: null,
      model: null,
      fanout,
      reason: null,
      warnings,
    };
  }

  if (selection === ALL_MODELS) {
    const { models, missing } = io.readModels();
    if (missing) {
      return {
        ok: false,
        mode: ALL_MODELS,
        env: [],
        provider: null,
        model: null,
        fanout: [],
        reason:
          `models.json does not exist — collect-models did not write it, so ` +
          `ALL_MODELS=true would sweep an EMPTY catalog: the resolver falls back to ` +
          `a single "(fallback)" target per spec, not to every model. That is the ` +
          `opposite of the sweep this dispatch asked for`,
        warnings: [],
      };
    }
    if (!Array.isArray(models)) {
      throw new Error(
        `models.json must be an array of { provider, model } records, got ` +
          `${models === null ? "null" : typeof models}`,
      );
    }
    if (models.length === 0) {
      return {
        ok: false,
        mode: ALL_MODELS,
        env: [],
        provider: null,
        model: null,
        fanout: [],
        reason:
          `models.json is empty — every provider probe failed, so ALL_MODELS=true ` +
          `has nothing to sweep and each spec would resolve one "(fallback)" target`,
        warnings: [],
      };
    }
    // Per-record validation, not just the array shape: everything below counts and
    // names providers, so one malformed entry would either crash with a bare
    // `Cannot read properties of null` or quietly land `undefined` in the sweep-size
    // warning this dispatch is meant to read before spending an hour.
    for (const [i, record] of models.entries()) {
      if (record === null || typeof record !== "object") {
        throw new Error(
          `models.json[${i}] must be an object, got ` +
            `${record === null ? "null" : typeof record}`,
        );
      }
      for (const field of ["provider", "model"]) {
        if (typeof record[field] !== "string" || record[field] === "") {
          throw new Error(`models.json[${i}] has no "${field}"`);
        }
      }
    }
    const providers = Array.from(new Set(models.map((m) => m.provider)));
    return {
      ok: true,
      mode: ALL_MODELS,
      // ALL_MODELS alone, deliberately: it is not half of a pair, it is the sweep
      // switch. Adding MODEL_TEST_PROVIDER here would narrow the very sweep it asked
      // for, and MODEL_TEST_ID would collapse it to one model.
      env: ["ALL_MODELS=true"],
      provider: null,
      model: null,
      fanout: [],
      reason: null,
      warnings: [
        ...routedTierWarnings(env, ALL_MODELS),
        `ALL_MODELS=true resolves up to ${models.length} target(s) across ` +
          `${providers.length} provider(s) (${providers.join(", ")}) per parametrized ` +
          `spec — the two that declare a "requires" capability ` +
          `(agent-multimodal-image-input, agent-markdown-output) sweep a ` +
          `capability-filtered SUBSET, so the run's test count is NOT this number times ` +
          `the spec count. It is still the most expensive shape this lane can run: ~30 ` +
          `parametrized agent test() declarations against a catalog this size is ` +
          `thousands of multi-turn agent runs, well past the job's 90-minute timeout ` +
          `unless test_tag/test_grep narrows it. Narrow the dispatch`,
      ],
    };
  }

  // A provider pin. `selectSettledTarget` validates the payload shape and answers
  // "usable, and what did it settle on" — shared with the two other lanes so none of
  // them can drift on what `active` means.
  const { providers, missing } = io.readProviders();
  if (missing) {
    return {
      ok: false,
      mode: selection,
      env: [],
      provider: selection,
      model: null,
      fanout: [],
      reason:
        `providers.json does not exist — collect-models did not write it (it is ` +
        `continue-on-error on this lane), so there is no settled model to pin to. ` +
        `Nothing can honour "${selection}" for this dispatch`,
      warnings: [],
    };
  }
  // Throws on a malformed payload — deliberately not caught: undecidable is exit 2,
  // not a quiet fallback.
  const attempt = selectSettledTarget(providers, { provider: selection });
  if (!attempt.ok) {
    return {
      ok: false,
      mode: selection,
      env: [],
      provider: selection,
      model: null,
      fanout: [],
      reason:
        `${declineReason(providers, selection)}. This dispatch asked for ` +
        `"${selection}" specifically, and a run on the other providers would answer ` +
        `a different question while reporting success (#1012). Re-dispatch with ` +
        `provider=auto for multi-provider, or fix the credential first`,
      warnings: [],
    };
  }

  return {
    ok: true,
    mode: selection,
    // Both variables, always together — MODEL_TEST_PROVIDER on its own makes the
    // resolver skip the per-provider dedup and sweep that provider's whole catalog.
    env: [
      `MODEL_TEST_ID=${attempt.model}`,
      `MODEL_TEST_PROVIDER=${attempt.provider}`,
    ],
    provider: attempt.provider,
    model: attempt.model,
    fanout: [],
    reason: null,
    warnings: routedTierWarnings(env, selection),
  };
}

/**
 * Reads models.json. A missing file is a legitimate state on this lane — the sweep is
 * `continue-on-error` — not a crash. Mirrors `readProvidersFile`.
 * @returns {{ models: unknown, missing: boolean }}
 */
export function readModelsFile(modelsFile, { readFile, exists } = {}) {
  const fileExists = exists ?? ((p) => fs.existsSync(p));
  const read = readFile ?? ((p) => fs.readFileSync(p, "utf-8"));

  if (!fileExists(modelsFile)) return { models: null, missing: true };
  return { models: JSON.parse(read(modelsFile)), missing: false };
}

function parseArgs(argv) {
  const args = {
    selection: AUTO,
    providersFile: DEFAULT_PROVIDERS_FILE,
    modelsFile: DEFAULT_MODELS_FILE,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "-h" || flag === "--help") {
      args.help = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--selection") args.selection = value;
    else if (flag === "--providers-file") args.providersFile = value;
    else if (flag === "--models-file") args.modelsFile = value;
    else throw new Error(`unknown flag: ${flag}`);
    i++;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`::error::select-manual-model-target: ${error.message}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  // An empty `--selection` is what a workflow_dispatch sends when the input is
  // absent (an older dispatch of a newer workflow, or a re-run of a queued one).
  // Treating it as `auto` keeps the pre-#1186 behaviour rather than failing a
  // dispatch nobody parameterized.
  const selection = args.selection === "" ? AUTO : args.selection;

  let decision;
  try {
    decision = selectManualModelTarget(selection, {
      readProviders: () => readProvidersFile(args.providersFile),
      readModels: () => readModelsFile(args.modelsFile),
      // Read for ONE reason: `ANY_COMPLETION_PROVIDER` is set at job level on this lane
      // and outranks whatever this step resolves, for one tier (#1187).
      env: process.env,
    });
  } catch (error) {
    // Fail loud (#1035): a payload or a value this cannot read must not resolve to
    // "run whatever the default is" while the dispatch summary says otherwise.
    process.stderr.write(`::error::select-manual-model-target: ${error.message}\n`);
    process.exit(2);
  }

  for (const warning of decision.warnings) {
    process.stderr.write(`::warning::select-manual-model-target: ${warning}\n`);
  }

  if (!decision.ok) {
    // Exit 1, not a fallback: see the header. The dispatch asked a specific
    // question, and this lane is never scheduled, so failing costs a re-dispatch
    // instead of a day of coverage.
    process.stderr.write(`::error::select-manual-model-target: ${decision.reason}\n`);
    process.stdout.write(`${JSON.stringify(decision)}\n`);
    process.exit(1);
  }

  if (decision.env.length && process.env.GITHUB_ENV) {
    fs.appendFileSync(process.env.GITHUB_ENV, `${decision.env.join("\n")}\n`);
  }

  if (decision.mode === AUTO) {
    // States what the two files say WILL happen, not what the default is supposed to do:
    // they diverge exactly when the sweep failed, which is the case the ::warning::
    // above covers. The skipped targets are named on the same line rather than left to
    // the warning — a count that includes them reads as coverage, and this line is the
    // one a dispatcher screenshots.
    const runnable = decision.fanout.filter((t) => t.skipReason === undefined);
    const skipped = decision.fanout.filter((t) => t.skipReason !== undefined);
    process.stderr.write(
      `provider=auto — the parametrized specs keep their default fan-out, one model ` +
        `per provider in the catalog. ${
          runnable.length
            ? `Runs ${runnable.length} target(s): ` +
              `${runnable.map((t) => `${t.provider} / ${t.model}`).join(", ")}.`
            : `NONE will run — see the warning above.`
        }${
          skipped.length
            ? ` Skips ${skipped.length} (recorded inactive): ` +
              `${skipped.map((t) => t.provider).join(", ")}.`
            : ""
        } This is the only lane that still runs multi-provider (#1186).\n`,
    );
  } else if (decision.mode === ALL_MODELS) {
    process.stderr.write(
      `provider=all-models — ALL_MODELS=true exported; every parametrized spec runs ` +
        `once per model in the catalog.\n`,
    );
  } else {
    process.stderr.write(
      `provider=${decision.provider} — pinned to ${decision.model} (settled by ` +
        `collect-models). Only this provider's variants run in this dispatch.\n`,
    );
  }

  process.stdout.write(`${JSON.stringify(decision)}\n`);
  process.exit(0);
}
