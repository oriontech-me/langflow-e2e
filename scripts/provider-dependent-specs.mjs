#!/usr/bin/env node
/**
 * Decides two things a PR lane must not confuse (issue #1216):
 *
 *   1. does the impacted set need the `Collect models` sweep to RUN?
 *   2. is any impacted spec going to be run WITHOUT a provider it needs?
 *
 * WHY THIS EXISTS
 *
 * `pr-validation.yml` answered only the first, with an inline shell loop, and the
 * second silently resolved to "run it anyway". PR #1152 changed one helper
 * (`tests/helpers/flows/rename-flow.ts`); the import graph correctly pulled in all
 * 7 of its callers, `needs_models` came back **false**, `Collect models` was
 * SKIPPED — and `core-components/agent-component-regression.spec.ts` then ran with
 * no provider configured and died on
 *
 *   expect(getByTestId('value-dropdown-model_model')).toBeVisible()  -> not found
 *
 * That test is `@stable` and green in `daily-stable.yml`, where the sweep runs. So
 * the lane produced a red that had nothing to do with the diff, and a reviewer had
 * to reconstruct the attribution by hand — the unattributed-red class #1012 and
 * #980 exist to prevent.
 *
 * The old rule asked "does this spec RESOLVE a model", not "does it need a provider
 * configured at all". `agent-component-regression` matches none of the markers — it
 * never resolves a target — yet the field it asserts on only renders once a
 * provider exists. Tags answer the real question declaratively, and every test in
 * this suite is required to carry them.
 *
 * THE TWO VERDICTS, AND WHY THEY ARE NOT ONE
 *
 * Forcing the sweep for every provider-dependent spec would re-couple unrelated
 * PRs to provider key health, which is exactly what #915/#910/#911 cost and what
 * the `needs_models` gate was built to stop (`Collect models` is a HARD gate on a
 * normal PR run). Excluding them all would silently drop coverage. So the verdict
 * turns on what the PR is ABOUT:
 *
 *   - a provider-dependent spec the PR **changed itself** ⇒ force the sweep. The PR
 *     is about that spec; gating it on key health is correct, and skipping it would
 *     mean the PR ran nothing that covers its own diff.
 *   - a provider-dependent spec pulled in because something it IMPORTS changed
 *     ⇒ EXCLUDE it and say so. The daily covers it with a real provider; running it
 *     bare here produces a red that misinforms.
 *
 * "changed itself" comes from the PR's changed-file list, NOT from
 * `impacted-specs-by-import.mjs`'s `.direct`. That field holds every **depth-1
 * importer**, so for #1152 — a one-helper diff — all 7 callers were `direct`,
 * including the agent spec. Reading it as "the PR changed this" made the verdict
 * force the sweep for exactly the case this exists to fix, and it survived a
 * hand-built fixture (`direct: []`) that the real resolver never emits. The unit
 * lane now feeds it the resolver's ACTUAL output so that cannot recur.
 *
 * When the exclusion would empty the run list entirely, the sweep is forced
 * instead. Decoupling from key health is worth a spec's coverage, never worth ALL
 * of it: an empty list skips the E2E job, and a lane that runs nothing is not a
 * cheaper green, it is no evidence at all (#1012).
 *
 * A DELIBERATE ASYMMETRY, stated because it will look like an oversight
 *
 * A spec that CONSUMES the sweep's output (`models.json`, the resolvers) still
 * forces the sweep even when only transitively impacted — unchanged from before.
 * Those specs fail at setup without it, and they have always been in scope here;
 * excluding them would remove coverage that exists today. Whether that asymmetry
 * should collapse — helper PRs never gating on key health — is a separate decision,
 * not one to make silently inside a bug fix.
 *
 * Run:
 *   node scripts/impacted-specs-by-import.mjs --format=json … > impacted.json
 *   node scripts/provider-dependent-specs.mjs --stdin --changed-file=changed.txt \\
 *     < impacted.json
 *   … --canary   (a CI-only run; forces the sweep, excludes nothing)
 *
 * Exit codes: 0 = a verdict was produced; 2 = it could not be (bad flag, malformed
 * input, unreadable spec). A guard that cannot decide must never read as "nothing
 * to do" — same rule as `ci-change-coverage` and `resolve-echo-endpoint`.
 *
 * Dependency-free ESM; covered by `npm run test:scripts`.
 */

import * as fs from "node:fs";

/** Areas whose every spec drives a completion, so the sweep is unconditional. */
export const ALWAYS_LLM_AREAS = [
  "tests/tests-automations/regression/core-functionality/llm-agents/",
  "tests/tests-automations/regression/core-functionality/model-provider/",
];

/**
 * References that mean the spec CONSUMES the sweep's output.
 *
 * Kept as the same list the inline shell carried, so this change cannot alter the
 * existing verdict for any spec: these catch the cross-area consumers (the mcp
 * client agent specs, the loop-component regression, the ui-ux message-history
 * spec that reaches the resolvers through `initialGPTsetup` — #946).
 */
export const MODEL_DATA_MARKERS = [
  "resolveTestTargets",
  "SimpleAgentTemplatePage",
  "provider-setup",
  "models\\.json",
  "MODEL_TEST_ID",
  "initialGPTsetup",
  "setupOpenAI",
  "resolveGptModel",
  "resolveGeminiModel",
];

/**
 * Tags that mean the spec needs a provider CONFIGURED, whether or not it resolves
 * a model id.
 *
 * `@agents` and `@model-provider` are the suite's own declaration of "this exercises
 * a provider" (see CLAUDE.md's functional tag table), and every test is required to
 * be tagged — which is what makes this declarative instead of another denylist to
 * maintain. `@playground` is NOT here: a playground spec can assert UI without a
 * completion, and including it would force the sweep on a large, mostly LLM-free
 * area.
 */
export const PROVIDER_TAGS = ["@agents", "@model-provider"];

const MARKER_RE = new RegExp(MODEL_DATA_MARKERS.join("|"));

/** Raised for anything that leaves the verdict unknown. */
export class UndecidableError extends Error {}

/**
 * Classify one spec from its path and source.
 *
 * @returns `consumesModelData` — needs the sweep's OUTPUT (fails at setup without
 *   it); `providerDependent` — needs a provider configured at all; `isStable` —
 *   carries `@stable`, so the run summary can tally what actually runs rather than
 *   reusing a count scoped to a different set (#1226); `reasons` — why, in words fit
 *   for a run summary.
 *
 * Note the tag scan is FILE-scoped, not `test()`-scoped: one `@agents` test marks the
 * whole file provider-dependent, so its provider-free tests are excluded with it.
 * That errs on the safe side — the alternative is running a test bare against no
 * provider, which is the defect #1216 exists to end — and no spec in the suite mixes
 * the two today. Revisit here if one starts to.
 */
export function classifySpec(file, source) {
  if (typeof source !== "string") {
    throw new UndecidableError(`unreadable spec: ${file}`);
  }
  const reasons = [];

  const area = ALWAYS_LLM_AREAS.find((prefix) => file.startsWith(prefix));
  if (area) reasons.push(`lives in ${area}`);

  const marker = MARKER_RE.exec(source);
  if (marker) reasons.push(`references ${marker[0]}`);

  const consumesModelData = Boolean(area || marker);

  const tags = PROVIDER_TAGS.filter((tag) => source.includes(tag));
  if (tags.length > 0) reasons.push(`tagged ${tags.join(" ")}`);

  return {
    consumesModelData,
    providerDependent: consumesModelData || tags.length > 0,
    isStable: source.includes("@stable"),
    reasons,
  };
}

/**
 * Decide the sweep and the run list for one impacted set.
 *
 * @param selected     specs the lane would run (post-cap).
 * @param changedSpecs spec files the PR CHANGED. Required — must be an array, even
 *                     an empty one. Defaulting it would fail open on coverage: with
 *                     no changed specs every provider-dependent spec looks
 *                     transitive and gets excluded, which is the opposite of this
 *                     file's own "undecidable, never LLM-free" rule.
 * @param read         `(file) => source`; injected so the unit lane needs no fixtures
 *                     on disk. Must return a string, or the verdict is undecidable.
 * @param canary       a CI-only run, which forces the sweep for its own reasons (#1159).
 */
export function decideProviderCoverage({
  selected,
  changedSpecs,
  read,
  canary = false,
}) {
  if (!Array.isArray(selected)) {
    throw new UndecidableError("selected must be an array");
  }
  if (!Array.isArray(changedSpecs)) {
    throw new UndecidableError(
      "changedSpecs must be an array (pass [] explicitly — defaulting it would " +
        "silently exclude every provider-dependent spec)",
    );
  }
  if (typeof read !== "function") {
    throw new UndecidableError("read must be a function");
  }

  const changed = new Set(changedSpecs);
  const classified = selected.map((file) => ({
    file,
    isChanged: changed.has(file),
    ...classifySpec(file, read(file)),
  }));
  const classifiedByFile = new Map(classified.map((spec) => [spec.file, spec]));

  const forced = classified.filter(
    (spec) => spec.consumesModelData || (spec.isChanged && spec.providerDependent),
  );

  const providerDependent = classified.filter((spec) => spec.providerDependent);

  // Excluding EVERY selected spec would leave the lane with nothing to run, and an
  // E2E job that runs nothing is not a cheaper green — it is no evidence at all.
  // Decoupling from provider key health is worth one spec's coverage, never worth
  // all of it, so the sweep is forced instead (#1012).
  const wouldRunNothing =
    selected.length > 0 && providerDependent.length === selected.length;

  // The canary forces the sweep so the post-sweep health gate has something to
  // gate (#1159); with the sweep running, nothing needs excluding.
  const needsModels = canary || forced.length > 0 || wouldRunNothing;

  const excluded = needsModels
    ? []
    : providerDependent.map((spec) => ({ file: spec.file, reasons: spec.reasons }));

  const excludedFiles = new Set(excluded.map((spec) => spec.file));
  const run = selected.filter((file) => !excludedFiles.has(file));
  return {
    needsModels,
    canary,
    run,
    // `@stable` among what actually RUNS, counted here because this function already
    // holds every selected spec's source — so the summary needs no `grep` in the YAML
    // (the `grep -q … 2>/dev/null` #1216 removed from that step) and no count scoped
    // to a different set. `stableSelected` from the resolver is over `selected`, i.e.
    // POST-cap, while the resolution line's total is PRE-cap; pairing them read as a
    // breakdown of a number it was not about (#1226).
    stableRun: run.filter((file) => classifiedByFile.get(file)?.isStable).length,
    excluded,
    forcedBy: forced.map((spec) => ({
      file: spec.file,
      isChanged: spec.isChanged,
      reasons: spec.reasons,
    })),
    // Why the sweep is on when no individual spec demanded it — so the summary can
    // say "otherwise this lane would have run nothing" instead of leaving a reader
    // to infer it.
    forcedToAvoidEmptyRun: !canary && forced.length === 0 && wouldRunNothing,
  };
}

/**
 * The `::warning::` line for an exclusion.
 *
 * Its whole job is to keep a reviewer from reading the shortened run as full
 * coverage — the same rule the cap and the suite-wide signal already follow
 * (#1012). It names the specs, why they were dropped, and where they ARE covered.
 */
export function formatExclusionWarning(excluded) {
  const names = excluded.map((spec) => spec.file).join(", ");
  return (
    `${excluded.length} impacted spec(s) need a provider configured but were pulled ` +
    `in only transitively, and this PR's lane skips the Collect models sweep — so ` +
    `they were NOT run here rather than run bare and reported as a failure of this ` +
    `diff (#1216): ${names}. They are covered by daily-stable.yml, which sweeps ` +
    `providers; dispatch manual.yml on this branch to run them against one now.`
  );
}

// ---------- CLI ----------

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    throw new UndecidableError("could not read stdin");
  }
}

/** Spec paths out of a changed-file list. The suite's specs are `*.spec.ts`. */
export function changedSpecsFrom(changedFiles) {
  return changedFiles
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".spec.ts"));
}

export function main(
  argv,
  {
    read = (file) => fs.readFileSync(file, "utf8"),
    readFile = (file) => fs.readFileSync(file, "utf8"),
    stdin = readStdin,
  } = {},
) {
  const args = argv.slice(2);
  const changedFlag = args.find((arg) => arg.startsWith("--changed-file="));
  const unknown = args.filter(
    (arg) =>
      !["--stdin", "--canary", "--format=json"].includes(arg) &&
      arg !== changedFlag,
  );
  if (unknown.length > 0 || !args.includes("--stdin") || !changedFlag) {
    process.stderr.write(
      "usage: provider-dependent-specs.mjs --stdin --changed-file=<path> " +
        "[--canary] [--format=json]\n",
    );
    return 2;
  }

  let impacted;
  try {
    impacted = JSON.parse(stdin());
  } catch (error) {
    process.stderr.write(`::error::malformed impacted-specs JSON: ${error}\n`);
    return 2;
  }

  // The PR's own changed files, NOT `impacted.direct` — that field is every
  // depth-1 IMPORTER, so reading it as "the PR changed this" forces the sweep for
  // precisely the helper-only diff this exists to fix (#1216's own first attempt).
  let changedSpecs;
  try {
    // `slice`, not `split("=")[1]`: a path containing `=` would be truncated, and
    // the failure would be "could not read the changed-file list" pointing at a
    // path the caller never passed (#1226).
    changedSpecs = changedSpecsFrom(
      readFile(changedFlag.slice(changedFlag.indexOf("=") + 1)),
    );
  } catch (error) {
    process.stderr.write(`::error::could not read the changed-file list: ${error}\n`);
    return 2;
  }

  let verdict;
  try {
    verdict = decideProviderCoverage({
      selected: impacted.selected,
      changedSpecs,
      canary: args.includes("--canary"),
      // A spec that cannot be read is UNDECIDABLE, never "LLM-free": defaulting to
      // false there is how a provider-dependent spec would run bare again.
      read: (file) => {
        try {
          return read(file);
        } catch {
          throw new UndecidableError(`could not read ${file}`);
        }
      },
    });
  } catch (error) {
    process.stderr.write(`::error::provider-coverage verdict failed: ${error}\n`);
    return 2;
  }

  if (args.includes("--format=json")) {
    // The warning TEXT ships inside the JSON so the workflow echoes it instead of
    // re-writing it in shell: the wording is what keeps a shortened run from
    // reading as full coverage, and it is unit-tested here, not there.
    process.stdout.write(
      JSON.stringify(
        {
          ...verdict,
          warning:
            verdict.excluded.length > 0
              ? formatExclusionWarning(verdict.excluded)
              : "",
        },
        null,
        2,
      ) + "\n",
    );
    return 0;
  }

  if (verdict.excluded.length > 0) {
    process.stderr.write(`::warning::${formatExclusionWarning(verdict.excluded)}\n`);
  }
  process.stdout.write(
    `needs_models=${verdict.needsModels}\nspecs=${verdict.run.join(" ")}\n`,
  );
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith("provider-dependent-specs.mjs")) {
  process.exit(main(process.argv));
}
