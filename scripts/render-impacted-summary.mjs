#!/usr/bin/env node
/**
 * Renders the `detect-specs` step's GitHub run summary (issue #1226).
 *
 * WHY THIS IS A SCRIPT AND NOT SHELL
 *
 * This block lived in `pr-validation.yml` as inline shell, and the numbers it prints
 * were wrong three times in a row — each time with every gate green, because the only
 * thing guarding them was a regex looking for a variable name in the YAML:
 *
 *   1. `running in this PR: **$((TOTAL - DROPPED))**` counted a provider-excluded spec
 *      as executed (#1226's opening complaint);
 *   2. the same line read `0` on a canary run, where `TOTAL` is 0 by definition while
 *      three specs do run;
 *   3. the `@stable` tally beside it was scoped to `selected` (post-cap) while the
 *      total was `.specs` (pre-cap), so the pair read as one breakdown of two sets.
 *
 * Each fix added another regex over the workflow text, and each of those regexes was
 * then shown to miss its own mutation: swapping `$RUN_COUNT` for `$TOTAL` on the
 * printed line, or hoisting the caveats above the counts, both passed. A guard that
 * pins a spelling cannot pin a behaviour.
 *
 * So the rendering moved here, where the assertions are about OUTPUT: given a verdict
 * that excluded one spec, the summary says 6 and says it above the caveats. That is
 * the same trade `wait-for-backend.mjs`, `ci-change-coverage.mjs`,
 * `resolve-echo-endpoint.mjs` and `provider-dependent-specs.mjs` already made, and
 * that the very step this replaces states as its own rule: "Logic and wording live in
 * the script so `npm run test:scripts` covers them".
 *
 * WHAT IT GUARANTEES
 *
 * - The run count is the length of the list actually handed to Playwright. It is
 *   passed in as `--specs`, not recomputed from anything, so it cannot drift from the
 *   list the workflow exports.
 * - The counts come FIRST, before every caveat that qualifies them. Appending caveats
 *   as they occurred put the cap's dropped list — 217 bullets on a suite-wide change —
 *   above the figure a reviewer opens the summary for.
 * - A missing provider verdict degrades instead of erasing: the resolution line and
 *   the caveats it can still establish are printed, with the gap named. Before this,
 *   an aborted verdict left a 0-byte summary where the buffered caveats used to
 *   survive.
 *
 * Run:
 *   node scripts/render-impacted-summary.mjs --impacted=/tmp/impacted.json \
 *     --specs="$SPECS" [--provider=/tmp/provider.json] [--ci-coverage=/tmp/cc.json] \
 *     [--canary] [--cap=20]
 *
 * Exit codes: 0 = rendered; 2 = could not (bad flag, unreadable/malformed input). A
 * summary this cannot build must fail the step, not print a partial one that reads as
 * complete — same rule as every other guard here.
 *
 * Dependency-free ESM; covered by `npm run test:scripts`.
 */

import * as fs from "node:fs";

/** Raised for anything that leaves the summary unrenderable. */
export class UnrenderableError extends Error {}

/** `a.spec.ts b.spec.ts` → 2. The one number the whole file exists to get right. */
export function countSpecs(specs) {
  if (typeof specs !== "string") {
    throw new UnrenderableError("--specs must be a string (pass an empty one)");
  }
  return specs.split(/\s+/).filter(Boolean).length;
}

/**
 * Build the summary as an array of lines.
 *
 * Split from the CLI so the unit lane asserts on the OUTPUT — what the number is, and
 * what it sits above — rather than on how the workflow spells a variable.
 *
 * @param specs     the final run list, exactly as handed to Playwright.
 * @param impacted  `impacted-specs-by-import.mjs`'s JSON.
 * @param provider  `provider-dependent-specs.mjs`'s JSON, or null when the verdict
 *                  did not produce one (its step aborts on an undecidable input).
 * @param ciCoverage `ci-change-coverage.mjs`'s JSON, or null when the diff reached a
 *                  spec and the classifier never ran.
 * @param canary    this run executes the fixed canary set (#1159).
 * @param cap       `IMPACTED_SPEC_CAP`, for the cap caveat's wording.
 */
export function renderSummary({
  specs,
  impacted,
  provider = null,
  ciCoverage = null,
  canary = false,
  cap = null,
}) {
  if (!impacted || typeof impacted !== "object") {
    throw new UnrenderableError("impacted must be an object");
  }
  const total = impacted.specs?.length;
  const dropped = impacted.dropped ?? [];
  const direct = impacted.direct?.length;
  if (typeof total !== "number" || typeof direct !== "number") {
    throw new UnrenderableError("impacted is missing `specs` or `direct`");
  }

  const runCount = countSpecs(specs);

  // --- the counts, first, always ---
  const lines = [
    "### Impacted specs",
    "",
    `- resolved by import graph: **${total}** (${direct} direct, ${total - direct} transitive)`,
  ];

  // `@stable` is reported only where it is TRUE of the number beside it. The resolver's
  // `stableSelected` is over `selected` (post-cap) and the provider verdict can shorten
  // that again, so the tally comes from the verdict's `stableRun`, over the run list.
  // On a canary the run list came from `ci-change-coverage.mjs`, which the verdict never
  // saw — so `stableRun` is 0 there as an artefact of provenance, and saying nothing
  // beats publishing that 0.
  const stableNote =
    !canary && provider && typeof provider.stableRun === "number"
      ? ` (of which \`@stable\`: ${provider.stableRun})`
      : "";
  lines.push(`- running in this PR: **${runCount}**${stableNote}`);

  // --- then every caveat that qualifies them ---
  if (canary) {
    const canarySpecs = ciCoverage?.canarySpecs ?? [];
    lines.push(
      "- 🐤 **CI-only change** — no spec imports it, so the lane runs the canary to prove the wiring boots:",
      ...canarySpecs.map((file) => `  - \`${file}\``),
      "  This proves the lane RUNS, not that the changed behaviour is correct.",
    );
  } else if (ciCoverage?.verdict === "dispatch") {
    lines.push(
      "- ⚠️ **CI-only change with no runtime coverage here** — the changed surface belongs to another lane. Dispatch before merging:",
      ...(ciCoverage.dispatchWorkflows ?? []).map((wf) => `  - \`${wf}\``),
    );
  }

  if (impacted.fullSuite === true) {
    lines.push(
      "- ⚠️ **suite-wide change** — every spec is impacted; the PR run is a subset. Dispatch `manual.yml` on this branch for the full suite.",
    );
  }

  if (dropped.length > 0) {
    lines.push(
      `- ⚠️ capped at \`${cap ?? "IMPACTED_SPEC_CAP"}\` — **${dropped.length} impacted specs were NOT run**:`,
      ...dropped.map((file) => `  - \`${file}\``),
    );
  }

  if (provider === null) {
    // Degrade, never erase. The buffered version this replaces produced a 0-byte
    // summary when the verdict aborted, losing caveats that used to survive because
    // they had already been appended.
    lines.push(
      "- ⚠️ **the provider-coverage verdict did not complete**, so this summary cannot say whether a spec needing a provider was excluded. See the step log; the job is failing for that reason.",
    );
    return lines;
  }

  const excluded = provider.excluded ?? [];
  if (excluded.length > 0) {
    lines.push(
      `- ⚠️ **${excluded.length} impacted spec(s) NOT run** — they need a provider configured, were pulled in only transitively, and this lane skips the models sweep (#1216):`,
      ...excluded.map(
        (spec) => `  - \`${spec.file}\` (${(spec.reasons ?? []).join(", ")})`,
      ),
      "  Covered by `daily-stable.yml`; dispatch `manual.yml` on this branch to run them against a provider now.",
    );
  }

  const forcedBy = provider.forcedBy ?? [];
  if (forcedBy.length > 0) {
    lines.push(
      "- 🔑 provider sweep **required** by:",
      ...forcedBy.map(
        (spec) =>
          `  - \`${spec.file}\`${spec.isChanged ? " (changed by this PR)" : " (consumes the sweep output)"}`,
      ),
    );
  }

  if (provider.forcedToAvoidEmptyRun === true) {
    lines.push(
      "- 🔑 provider sweep forced: every impacted spec needs a provider, so excluding them would have left nothing to run.",
    );
  }

  return lines;
}

// ---------- CLI ----------

const FLAGS = ["--impacted=", "--specs=", "--provider=", "--ci-coverage=", "--cap="];

export function main(argv, { readFile = (f) => fs.readFileSync(f, "utf8") } = {}) {
  const args = argv.slice(2);
  const value = (name) => {
    const found = args.find((arg) => arg.startsWith(name));
    return found === undefined ? undefined : found.slice(found.indexOf("=") + 1);
  };
  const unknown = args.filter(
    (arg) => arg !== "--canary" && !FLAGS.some((flag) => arg.startsWith(flag)),
  );
  const impactedPath = value("--impacted=");
  const specs = value("--specs=");
  if (unknown.length > 0 || !impactedPath || specs === undefined) {
    process.stderr.write(
      "usage: render-impacted-summary.mjs --impacted=<path> --specs=<list> " +
        "[--provider=<path>] [--ci-coverage=<path>] [--canary] [--cap=N]\n",
    );
    return 2;
  }

  /** Required input: unreadable or malformed is a hard stop, never a partial render. */
  const required = (path) => {
    try {
      return JSON.parse(readFile(path));
    } catch (error) {
      throw new UnrenderableError(`could not read ${path}: ${error.message}`);
    }
  };
  /** Optional input: absent is a legitimate state, malformed is not. */
  const optional = (path) => {
    if (!path) return null;
    let text;
    try {
      text = readFile(path);
    } catch {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new UnrenderableError(`malformed ${path}: ${error.message}`);
    }
  };

  let lines;
  try {
    lines = renderSummary({
      specs,
      impacted: required(impactedPath),
      provider: optional(value("--provider=")),
      ciCoverage: optional(value("--ci-coverage=")),
      canary: args.includes("--canary"),
      cap: value("--cap=") ?? null,
    });
  } catch (error) {
    process.stderr.write(`::error::could not render the run summary: ${error}\n`);
    return 2;
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("render-impacted-summary.mjs")
) {
  process.exit(main(process.argv));
}
