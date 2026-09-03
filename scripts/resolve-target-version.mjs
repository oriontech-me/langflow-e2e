#!/usr/bin/env node
/**
 * Decides which Langflow the VM lane SHOULD be testing, from what `git ls-remote`
 * reports about the upstream repository.
 *
 * ## Why this exists
 *
 * The daily compares a VM verdict with the Actions one. That comparison is only
 * about the environment if both sides run the same product — and nothing enforced
 * that. The Actions lane pulls `langflowai/langflow-nightly:latest`, and that image
 * is NOT built from `main`: upstream's `nightly_build.yml` resolves the newest
 * `release-X.Y.Z` branch and checks that out. Meanwhile a source clone on the target
 * sits wherever someone last left it — on 2026-09-02 that was `release-1.12.0`,
 * a full release cycle behind the `1.13.0.dev0` the CI was testing.
 *
 * Every difference between those two arrives in the divergence list as "a real
 * failure only Actions saw", which is a changelog wearing an environment's clothes.
 *
 * ## The rule, which is upstream's and not ours
 *
 *   git ls-remote --heads 'refs/heads/release-*' | grep '^release-[0-9]+\.[0-9]+\.[0-9]+$'
 *     | sort -V | tail -1
 *
 * That is verbatim what `nightly_build.yml` runs. Two consequences this script is
 * built around:
 *
 *   1. NEVER `main`. `main` is only where the workflow file lives.
 *   2. The answer MOVES on its own. Between 2026-09-01 and 09-02 it went from
 *      release-1.12.0 to release-1.13.0 with nobody editing anything, so a branch
 *      written into a script is the next `release-1.12.0` left behind.
 *
 * ## Why the tag beats the branch head
 *
 * Each nightly build leaves a tag: `v1.13.0.dev0` points at the exact commit the
 * published image was built from. The branch head has usually moved on by hours
 * (12 of them, the day this was written), so checking out the tag gives parity of
 * COMMIT with the image the CI ran, while the branch head only gives parity of
 * cycle. The tag also carries the version string the instance will report, which
 * makes the comparison exact instead of approximate.
 *
 * When no matching tag is found the branch head is still the right answer — it is
 * the same cycle — but the caller is told, because "same cycle" and "same commit"
 * are different claims and only one of them supports an exact comparison.
 *
 * ## Usage
 *
 *   git ls-remote --heads --tags https://github.com/langflow-ai/langflow > refs.txt
 *   node scripts/resolve-target-version.mjs --refs-file refs.txt
 *
 * Output (stdout, JSON): { ok, branch, cycle, version, ref, sha, strategy, warnings, error }
 */

import { readFileSync } from "node:fs";

const HELP = `usage: resolve-target-version.mjs --refs-file <path>
       resolve-target-version.mjs --compare <expected> <actual> <strategy>

  --refs-file PATH   output of \`git ls-remote --heads --tags <repo>\` ("-" for stdin)
  --compare E A S    what the target SHOULD serve, what it did, and which strategy
                     resolved the first — prints "<match>\t<reason>" on stdout
  --help             this text
`;

const RELEASE_BRANCH = /^refs\/heads\/release-(\d+)\.(\d+)\.(\d+)$/;
// The nightly tag: v<cycle>.dev<n>. The `^{}` suffix marks the PEELED entry of an
// annotated tag — the commit the tag actually points at. ls-remote prints both lines
// for an annotated tag, and taking the unpeeled one hands the caller the tag OBJECT's
// sha, which `git checkout` accepts and `git rev-parse HEAD` then reports as a
// different commit than the image was built from.
const NIGHTLY_TAG = /^refs\/tags\/v(\d+)\.(\d+)\.(\d+)\.dev(\d+)(\^\{\})?$/;

/** Numeric, not lexicographic: 1.9.0 sorts BELOW 1.12.0, which a string compare inverts. */
function compareTriples(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

export function resolveTargetVersion(refsText) {
  const warnings = [];
  const branches = [];
  const tags = new Map(); // "cycle.devN" -> { triple, dev, sha, peeled }

  for (const line of String(refsText).split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;

    const branch = ref.match(RELEASE_BRANCH);
    if (branch) {
      branches.push({ triple: [+branch[1], +branch[2], +branch[3]], ref, sha });
      continue;
    }

    const tag = ref.match(NIGHTLY_TAG);
    if (tag) {
      const triple = [+tag[1], +tag[2], +tag[3]];
      const dev = +tag[4];
      const peeled = Boolean(tag[5]);
      const key = `${triple.join(".")}.dev${dev}`;
      const previous = tags.get(key);
      // A peeled entry always wins over the unpeeled one for the same tag.
      if (!previous || (peeled && !previous.peeled)) tags.set(key, { triple, dev, sha, peeled });
    }
  }

  if (branches.length === 0) {
    return {
      ok: false,
      error:
        "no refs/heads/release-X.Y.Z branch in the listing. That is the rule upstream's nightly_build.yml uses to pick what it builds, so without one there is nothing to follow — and falling back to `main` would test something the CI never tests.",
      warnings,
    };
  }

  branches.sort((a, b) => compareTriples(a.triple, b.triple));
  const branch = branches[branches.length - 1];
  const cycle = branch.triple.join(".");

  const candidates = [...tags.entries()]
    .filter(([, t]) => compareTriples(t.triple, branch.triple) === 0)
    .sort((a, b) => a[1].dev - b[1].dev);

  if (candidates.length === 0) {
    warnings.push(
      `no v${cycle}.devN tag was published for ${branch.ref.replace("refs/heads/", "")} yet, so the branch head is the best available answer. That is parity of CYCLE, not of commit: the head may be hours ahead of whatever image the CI is running, and the instance will report "${cycle}" rather than a .devN string.`,
    );
    return {
      ok: true,
      branch: branch.ref.replace("refs/heads/", ""),
      cycle,
      version: cycle,
      ref: branch.ref.replace("refs/heads/", ""),
      sha: branch.sha,
      strategy: "branch-head",
      warnings,
    };
  }

  const [key, tag] = candidates[candidates.length - 1];
  return {
    ok: true,
    branch: branch.ref.replace("refs/heads/", ""),
    cycle,
    version: key,
    ref: `v${key}`,
    sha: tag.sha,
    strategy: "nightly-tag",
    warnings,
  };
}

/**
 * Is what the target actually served the thing it should have been?
 *
 * Deliberately two verdicts rather than one. Under `nightly-tag` the expected string
 * is exact and anything else is a mismatch. Under `branch-head` the instance reports
 * the plain cycle (`1.13.0`) while the CI's image reports a `.devN` of the same
 * cycle — comparing those as strings would report a mismatch on a correctly placed
 * clone, which is the false alarm that teaches people to ignore this check.
 */
export function compareVersions(expected, actual, strategy) {
  if (!actual) return { match: "unknown", reason: "the target reported no version" };
  if (!expected) return { match: "unknown", reason: "no expected version was resolved" };
  if (strategy === "nightly-tag") {
    return expected === actual
      ? { match: "yes", reason: `exact: ${actual}` }
      : { match: "no", reason: `expected ${expected} (the commit the CI's image was built from), the target served ${actual}` };
  }
  const cycleOf = (v) => String(v).split(".").slice(0, 3).join(".");
  return cycleOf(expected) === cycleOf(actual)
    ? { match: "cycle", reason: `same cycle (${cycleOf(actual)}), exact commit not pinned` }
    : { match: "no", reason: `expected cycle ${cycleOf(expected)}, the target served ${actual}` };
}

function parseArgs(argv) {
  const args = { refsFile: null, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--refs-file") args.refsFile = argv[++i];
    // Three positionals rather than three flags: the caller is bash inside a
    // pipeline, and every extra flag there is another quoting mistake waiting.
    else if (a === "--compare") args.compare = [argv[++i], argv[++i], argv[++i]];
    else if (a === "--help" || a === "-h") args.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`::error::resolve-target-version: ${args.error}\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.compare) {
    const [expected, actual, strategy] = args.compare;
    const r = compareVersions(expected, actual, strategy);
    process.stdout.write(`${r.match}\t${r.reason}\n`);
    return 0;
  }
  if (!args.refsFile) {
    process.stderr.write(`::error::resolve-target-version: --refs-file is required\n${HELP}`);
    return 2;
  }
  const text = args.refsFile === "-" ? readFileSync(0, "utf8") : readFileSync(args.refsFile, "utf8");
  const decision = resolveTargetVersion(text);
  process.stdout.write(JSON.stringify(decision) + "\n");
  // A resolution that failed is still printed, for the caller to quote; the exit code
  // is what says whether it is usable.
  return decision.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
