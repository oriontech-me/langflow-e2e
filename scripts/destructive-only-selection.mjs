#!/usr/bin/env node
/**
 * Decides whether an impacted-spec selection contains ANYTHING the normal PR
 * lane can run — i.e. whether every selected spec carries a LANE SELECTOR that
 * `playwright.config.ts` grep-inverts out of a normal run: `@destructive`, or
 * `@enterprise` since #1483.
 *
 * Why this exists. `playwright.config.ts` `grepInvert`s `/@destructive/` out of
 * every normal run (#1010), and `pr-validation.yml` runs the impacted set twice:
 * once normally, then once more with `PW_DESTRUCTIVE=1 --grep @destructive
 * --pass-with-no-tests`. When EVERY selected spec is destructive the first run
 * matches nothing, and `npx playwright test` exits 1 with `Error: No tests
 * found.` — so the job goes red on a lane detail while the destructive step that
 * follows reports the specs passing. Measured on PR #1494: `13 passed (10.2s)`
 * in the destructive step of a job whose verdict was `fail`.
 *
 * It had never fired because the suite's only `@destructive` spec until then
 * (`core-functionality/project-management/folder-deletion-integrity.spec.ts`)
 * carries non-destructive tests in the same file, so the selection always held
 * something the normal lane could run.
 *
 * The two selectors share the symptom and differ in the remedy, so the verdict
 * reports them separately. A destructive-only selection IS executed — by the
 * `PW_DESTRUCTIVE=1` step that follows. An enterprise-only selection is executed
 * by nobody: those specs need a Langflow Enterprise instance the runner does not
 * have, so skipping the normal lane is right and calling the PR covered is not.
 *
 * The fix is NOT a blanket `--pass-with-no-tests` on the normal run: that would
 * also swallow a selection of paths that no longer exist, which is a real defect
 * this lane should keep catching. Instead the workflow asks this script, up
 * front, whether the normal lane is expected to match nothing, and skips that
 * step — loudly — only in that case.
 *
 * Conservative by construction: every ambiguity resolves to "runnable", which
 * preserves today's behaviour. The failure this must never produce is the
 * opposite one — declaring a selection destructive-only when it holds runnable
 * tests would skip the normal lane and lose their coverage silently.
 *
 * Usage:
 *   node scripts/destructive-only-selection.mjs --specs "a.spec.ts b.spec.ts"
 *   node scripts/destructive-only-selection.mjs --specs "…" --format=json
 *
 * Prints `true` / `false` (or the JSON verdict). Exits 2 when a listed spec
 * cannot be read: an unreadable spec is UNDECIDABLE, and defaulting it either
 * way is how #1216's silent-default class of bug reaches the lane again.
 */

import { readFileSync } from "node:fs";

/**
 * Every `tag: [ … ]` array in a spec's source.
 *
 * `[^\]]*` spans newlines, so a multi-line array matches — the same shape
 * `provider-dependent-specs.mjs` relies on. Tags are read from a `tag:` array,
 * never from anywhere in the file: the loose substring test counts a `@destructive`
 * written in a comment, which is exactly how a runnable spec would get skipped.
 */
const TAG_ARRAY_RE = /tag:\s*\[[^\]]*\]/g;
const DESTRUCTIVE = "@destructive";
/**
 * The second lane selector (#1483). `@enterprise` is grep-inverted out of the
 * normal run for the same reason `@destructive` is, so it produces the same
 * "No tests found" red — but the two are NOT interchangeable downstream: the
 * workflow runs the destructive specs in a following step, while an Enterprise
 * spec needs an instance this runner does not have and is therefore executed by
 * NOBODY. Skipping the normal lane for it is still correct; reporting it as
 * covered would not be, which is why the two lists stay separate.
 */
const ENTERPRISE = "@enterprise";

/**
 * True when this source declares at least one tag array and EVERY one of them
 * carries `@destructive`.
 *
 * A file with no tag array at all is reported runnable rather than undecidable.
 * The repo requires every test to be tagged, so this should not happen — and if
 * it does, running the normal lane is the outcome that cannot lose coverage.
 *
 * Known conservative gap: Playwright merges a `test.describe(…, { tag })` into
 * the tags of the tests inside it, and this counts arrays independently. A file
 * whose `@destructive` lives only on the describe (or only on the tests, with an
 * untagged describe array present) reads as runnable, so the lane behaves as it
 * does today. That direction is safe; the reverse would not be.
 */
export function isDestructiveOnlySource(source) {
  return everyTagArrayCarries(source, DESTRUCTIVE);
}

/** The `@enterprise` counterpart — same rule, same conservative defaults. */
export function isEnterpriseOnlySource(source) {
  return everyTagArrayCarries(source, ENTERPRISE);
}

function everyTagArrayCarries(source, tag) {
  const arrays = source.match(TAG_ARRAY_RE);
  if (!arrays || arrays.length === 0) return false;
  return arrays.every((array) => array.includes(tag));
}

/**
 * Classify a selection.
 *
 * @param specs     spec paths, as the workflow's `$SPECS` splits them
 * @param readSpec  reads a spec's source; throws when it cannot (injected so the
 *                  unit tests never touch the filesystem)
 * @returns `{ destructiveOnly, excludedOnly, destructive, enterprise, runnable }`
 */
export function classifySelection(specs, readSpec) {
  const destructive = [];
  const enterprise = [];
  const runnable = [];

  for (const spec of specs) {
    let source;
    try {
      source = readSpec(spec);
    } catch (error) {
      throw new Error(
        `cannot read selected spec "${spec}" (${error.message}) — an unreadable spec is undecidable, not runnable`,
      );
    }
    if (isDestructiveOnlySource(source)) destructive.push(spec);
    else if (isEnterpriseOnlySource(source)) enterprise.push(spec);
    else runnable.push(spec);
  }

  return {
    // An EMPTY selection is not destructive-only. The job's own `has_specs`
    // gate already skips the E2E job in that case, and answering `true` here
    // would skip the normal lane for a reason that has nothing to do with tags.
    // Kept as it was: "the destructive step covers everything selected".
    destructiveOnly: specs.length > 0 && runnable.length === 0 && enterprise.length === 0,
    // The gate the normal run gets skipped on — true whenever NOTHING selected
    // can run there, whichever lane took it.
    excludedOnly: specs.length > 0 && runnable.length === 0,
    destructive,
    enterprise,
    runnable,
  };
}

function parseArgs(argv) {
  const args = { specs: "", format: "value" };
  for (const arg of argv) {
    if (arg.startsWith("--specs=")) args.specs = arg.slice("--specs=".length);
    else if (arg === "--specs") args.specsNext = true;
    else if (arg.startsWith("--format=")) args.format = arg.slice("--format=".length);
    else if (args.specsNext) {
      args.specs = arg;
      args.specsNext = false;
    }
  }
  return args;
}

function main() {
  const { specs, format } = parseArgs(process.argv.slice(2));
  const list = specs.split(/\s+/).filter(Boolean);

  let verdict;
  try {
    verdict = classifySelection(list, (spec) => readFileSync(spec, "utf8"));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } else {
    process.stdout.write(`${verdict.excludedOnly}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
