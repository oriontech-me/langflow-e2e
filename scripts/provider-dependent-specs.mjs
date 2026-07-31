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
 *   - a provider-dependent spec that the PR **changed directly** ⇒ force the sweep.
 *     The PR is about that spec; gating it on key health is correct, and skipping
 *     it would mean the PR ran nothing that covers its own diff.
 *   - a provider-dependent spec pulled in only **transitively** (a helper changed)
 *     ⇒ EXCLUDE it and say so. The daily covers it with a real provider; running it
 *     bare here produces a red that misinforms.
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
 *   node scripts/provider-dependent-specs.mjs --stdin < impacted.json
 *   node scripts/provider-dependent-specs.mjs --stdin --canary < impacted.json
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
 *   it); `providerDependent` — needs a provider configured at all; `reasons` — why,
 *   in words fit for a run summary.
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
    reasons,
  };
}

/**
 * Decide the sweep and the run list for one impacted set.
 *
 * @param selected specs the lane would run (post-cap).
 * @param direct   specs the PR changed itself.
 * @param read     `(file) => source`; injected so the unit lane needs no fixtures
 *                 on disk. Must return a string, or the verdict is undecidable.
 * @param canary   a CI-only run, which forces the sweep for its own reasons (#1159).
 */
export function decideProviderCoverage({
  selected,
  direct = [],
  read,
  canary = false,
}) {
  if (!Array.isArray(selected) || !Array.isArray(direct)) {
    throw new UndecidableError("selected and direct must be arrays");
  }
  if (typeof read !== "function") {
    throw new UndecidableError("read must be a function");
  }

  const directSet = new Set(direct);
  const classified = selected.map((file) => ({
    file,
    isDirect: directSet.has(file),
    ...classifySpec(file, read(file)),
  }));

  const forced = classified.filter(
    (spec) => spec.consumesModelData || (spec.isDirect && spec.providerDependent),
  );

  // The canary forces the sweep so the post-sweep health gate has something to
  // gate (#1159); with the sweep running, nothing needs excluding.
  const needsModels = canary || forced.length > 0;

  const excluded = needsModels
    ? []
    : classified
        .filter((spec) => spec.providerDependent)
        .map((spec) => ({ file: spec.file, reasons: spec.reasons }));

  const excludedFiles = new Set(excluded.map((spec) => spec.file));
  return {
    needsModels,
    canary,
    run: selected.filter((file) => !excludedFiles.has(file)),
    excluded,
    forcedBy: forced.map((spec) => ({
      file: spec.file,
      isDirect: spec.isDirect,
      reasons: spec.reasons,
    })),
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

export function main(argv, { read = (file) => fs.readFileSync(file, "utf8") } = {}) {
  const args = argv.slice(2);
  const unknown = args.filter(
    (arg) => !["--stdin", "--canary", "--format=json"].includes(arg),
  );
  if (unknown.length > 0 || !args.includes("--stdin")) {
    process.stderr.write(
      "usage: provider-dependent-specs.mjs --stdin [--canary] [--format=json]\n",
    );
    return 2;
  }

  let impacted;
  try {
    impacted = JSON.parse(readStdin());
  } catch (error) {
    process.stderr.write(`::error::malformed impacted-specs JSON: ${error}\n`);
    return 2;
  }

  let verdict;
  try {
    verdict = decideProviderCoverage({
      selected: impacted.selected,
      direct: impacted.direct,
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
