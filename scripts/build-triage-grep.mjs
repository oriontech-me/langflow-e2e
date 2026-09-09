#!/usr/bin/env node
/**
 * Emits ONE `--grep` fragment selecting a third of the never-validated backlog,
 * for a `manual.yml` dispatch (`test_grep`). Design: §2.
 *
 *   node scripts/build-triage-grep.mjs --shards 3 --shard 1
 *   node scripts/build-triage-grep.mjs --verify          # every shard, set-exact
 *
 * `build-grep-filter.mjs` passes a single fragment VERBATIM, so everything the
 * selection needs has to be inside this string: the non-capturing group and the
 * escaping. An unparenthesised alternation is not ANDed as a unit -- #1275,
 * where a dispatch silently ran 48 of 81 tests with nothing saying so.
 */
import fs from "fs";
import { execFileSync } from "node:child_process";

const META = /[.*+?^${}()|[\]\\]/g;

/**
 * Escapes `title` for embedding in a regex alternation AND anchors it so it can
 * only match Playwright's OWN test title, never a fragment of something else
 * that happens to sit alongside it in the real grep target.
 *
 * Playwright's `--grep` does not match the isolated test title: it matches
 * `TestCase._grepTitleWithTags()`, which space-joins the FILE's relative path,
 * every enclosing `describe` title, the test's own title, and finally its own
 * tags (`node_modules/playwright/lib/common/test.js`) — e.g.
 *   "core-components/saveComponents.spec.ts save component tests saving a
 *    canvas component as a template makes it reusable from the sidebar
 *    @stable @regression @components @ui-ux"
 * An unanchored title collides in that string two different ways, measured
 * against this suite. (1) A short title is a literal substring of an unrelated
 * KEBAB-CASE FILE PATH (`"save"` inside `save-flow-as-template.spec.ts`) or of
 * an unrelated word (`"save"` inside "must be SAVEd") — `\b` does not close
 * this, since `-` is a non-word character and `\bsave\b` still matches at the
 * letter/hyphen transition inside `save-flow-as-template`. Anchoring on
 * whitespace-or-string-edge instead of \w/\W closes it: every segment
 * Playwright joins is delimited by exactly one literal space, and neither a
 * path nor a single word ever contains one internally.
 * (2) That alone is not enough: `"save"` is ALSO the literal first word of the
 * unrelated `describe("save component tests", …)` above, which whitespace
 * anchoring on both sides does not exclude (it is a standalone, space-bounded
 * word right there). What actually distinguishes "this is the test's own
 * title" from "this is a describe title, and the real test title is still to
 * come" is what FOLLOWS the match to the end of the string: after the test's
 * own title, only its own `@tag` tokens can appear (zero or more); after a
 * describe title there is always more plain text (a nested describe, or the
 * test title itself, neither of which starts with `@`). Requiring the tail to
 * be `(\s@\S*)*$` — nothing but space-`@token` pairs through to the end —
 * is exactly that distinction, and rejects the describe-title occurrence.
 *
 * Verified empirically with `--list` (Task 4 §Step 4): whitespace-only
 * anchoring cut the false-positive sum from 106 to 97 (over the baseline's 92)
 * on the real suite; the trailing tag-tail anchor here closes the rest.
 */
export function escapeTitle(title) {
  const escaped = String(title).replace(META, "\\$&");
  return `(?<=^|\\s)${escaped}(?=(?:\\s@\\S*)*$)`;
}

export function baselineTitles(baseline) {
  const titles = (baseline?.specs ?? []).flatMap((s) => (s.tests ?? []).map((t) => t.title));
  return [...new Set(titles)].sort();
}

export function shardTitles(titles, shards, shard) {
  const n = Number(shards);
  const i = Number(shard);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--shards must be a positive integer, got ${shards}`);
  if (!Number.isInteger(i) || i < 1 || i > n) throw new Error(`--shard must be in 1..${n}, got ${shard}`);
  // Contiguous slices over a sorted list: the partition is reproducible from the
  // baseline alone, so a re-dispatch of "shard 2" selects the same tests.
  const size = Math.ceil(titles.length / n);
  return titles.slice((i - 1) * size, i * size);
}

export function buildFragment(titles) {
  if (!titles.length) {
    throw new Error(
      "refusing to emit an empty fragment: it compiles to a regex matching every test, " +
        "which would turn a narrowed dispatch into a full-suite run",
    );
  }
  return `(?:${titles.join("|")})`;
}

/**
 * Refuses (by throwing) when `baseline.titleCollisions` is non-empty.
 *
 * A recorded collision means two different declarations in the underlying suite
 * carry the exact same title text -- and the field records BOTH classes of that
 * (`Backlog.titleCollisions` in `scripts/lib/inherited-backlog.ts`), because no
 * amount of anchoring on a single title string can tell two identically-titled
 * tests apart:
 *
 *  - one in scope and one OUT of scope: the fragment pulls a test outside the
 *    92-test population into the measurement;
 *  - both IN scope: `baselineTitles` dedupes them into one alternative, so the
 *    fragment still selects both tests, and the table then renders two
 *    identical rows whose observations are folded into a single verdict -- a
 *    green one able to mask a red one. This class was invisible to the field
 *    until the final fix wave; the docstring here claimed to cover it, which is
 *    how it stayed invisible.
 *
 * Extracted as its own pure function (rather than inlined in `main()`) so this refusal
 * is unit-testable directly, the same way the other two mandated refusals
 * already are via `shardTitles` and `buildFragment` -- `main()` is CLI-only
 * glue and is not exercised by `node --test`.
 *
 * Returns the (empty) collision list when there is nothing to refuse.
 */
export function checkTitleCollisions(baseline, baselinePath = "the baseline") {
  const collisions = baseline?.titleCollisions ?? [];
  if (collisions.length) {
    throw new Error(
      `refusing: ${collisions.length} title collision(s) recorded in ` +
        `${baselinePath}. A colliding title would pull an out-of-scope test into the measurement:\n  ` +
        collisions.join("\n  "),
    );
  }
  return collisions;
}

// ─── --verify: the selection compared as a SET, not as a count ───────────────
//
// Ruling P14's own words are that "92 can be reached by dropping some and
// adding others", so the controller verified SET-exactness — twice, by hand —
// while both committed verification steps still prescribed the weaker check
// ("the three counts sum to 92 with no shard at 0"). This mode is that
// verification as one command, so the runbook stops asking for the check the
// ruling refuted.
//
// The comparison is over `spec::title` PAIRS rather than titles, which is the
// whole point: a title selected in the WRONG file shows up as one extra plus
// one missing, where a title-only comparison would call it a match.

/** Playwright's `rootDir` is `tests/`, so a listed file is prefixed with this. */
const REGRESSION_PREFIX = "tests-automations/regression/";

/** `spec::title`, the comparison key. Two tests can only collide on it if they collide. */
export const pairKey = (spec, title) => `${spec}::${title}`;

/**
 * Every `{spec, title}` pair a `playwright test --list --reporter=json` report
 * selected, with the spec path normalised to the baseline's own
 * `relativePath` (relative to `regression/`, not to Playwright's `rootDir`).
 *
 * Deduped: a suite listed under more than one project yields the same pair
 * once per project, and the question here is which TESTS were selected.
 */
export function listedPairs(listReport) {
  const pairs = new Set();
  const walk = (suites) => {
    for (const suite of suites ?? []) {
      for (const sp of suite.specs ?? []) {
        const file = String(sp.file ?? suite.file ?? "");
        const spec = file.startsWith(REGRESSION_PREFIX) ? file.slice(REGRESSION_PREFIX.length) : file;
        pairs.add(pairKey(spec, sp.title));
      }
      walk(suite.suites);
    }
  };
  walk(listReport?.suites);
  return pairs;
}

/** Every `spec::title` the baseline declares — the WANTED set. */
export function baselinePairs(baseline) {
  const pairs = new Set();
  for (const s of baseline?.specs ?? []) {
    for (const t of s.tests ?? []) pairs.add(pairKey(s.relativePath, t.title));
  }
  return pairs;
}

/** How many missing/extra pairs to name before eliding, and printing the count. */
export const VERIFY_NAME_CAP = 20;

/**
 * Compares what the shards selected against what the baseline wants.
 *
 * `perShard` is one selected-pair Set per shard, in shard order. A shard that
 * selected NOTHING is called out on its own: an empty selection is a green
 * `manual.yml` dispatch that measures nothing, and it can hide inside a correct
 * total if another shard over-selects by the same amount — which is exactly the
 * arithmetic the count check cannot see.
 */
export function verifySelection(baseline, perShard) {
  const wanted = baselinePairs(baseline);
  const selected = new Set(perShard.flatMap((s) => [...s]));
  const missing = [...wanted].filter((p) => !selected.has(p)).sort();
  const extra = [...selected].filter((p) => !wanted.has(p)).sort();
  const counts = perShard.map((s) => s.size);
  const emptyShards = counts.flatMap((n, i) => (n === 0 ? [i + 1] : []));
  return {
    ok: missing.length === 0 && extra.length === 0 && emptyShards.length === 0,
    wanted: wanted.size,
    selected: selected.size,
    counts,
    emptyShards,
    missing,
    extra,
  };
}

/** The verdict as lines — `ok` or not, always naming what it found. */
export function verifyReportLines(v) {
  const head =
    `${v.wanted} wanted / ${v.selected} selected / ${v.missing.length} missing / ` +
    `${v.extra.length} extra; shards ${v.counts.join("/")}`;
  if (v.ok) return [`[triage-grep] verified set-exact: ${head}`];
  const lines = [`[triage-grep] SELECTION IS NOT SET-EXACT: ${head}`];
  if (v.emptyShards.length) {
    lines.push(
      `  shard(s) ${v.emptyShards.join(", ")} selected NOTHING — a dispatch of one is a green run ` +
        "that measures nothing, and the counts can still sum correctly",
    );
  }
  for (const [label, list] of [["missing (wanted, not selected)", v.missing], ["extra (selected, not wanted)", v.extra]]) {
    if (!list.length) continue;
    lines.push(`  ${list.length} ${label}:`);
    for (const p of list.slice(0, VERIFY_NAME_CAP)) lines.push(`    - ${p}`);
    if (list.length > VERIFY_NAME_CAP) {
      lines.push(`    - … and ${list.length - VERIFY_NAME_CAP} more not listed here`);
    }
  }
  return lines;
}

function arg(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
}

/** Every `--<name> <value>` / `--<name>=<value>` occurrence, in order. */
function argAll(argv, name) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
    if (a.startsWith(`--${name}=`)) out.push(a.split("=").slice(1).join("="));
  });
  return out;
}

/**
 * `playwright test --list --reporter=json` for one fragment, parsed.
 *
 * Thin glue on purpose — the comparison above is the part with tests. Two
 * measured details: `--list` runs nothing, so this needs no Langflow instance
 * and no provider key; and stderr is FULL of module-load noise from the specs
 * ("models.json not found — run collect-models.spec.ts first", once per spec),
 * so it is captured and only shown when the run actually fails.
 */
function listSelection(fragment) {
  let stdout;
  try {
    stdout = execFileSync(
      "npx",
      ["playwright", "test", "--list", "--reporter=json", "--grep", fragment],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
    );
  } catch (err) {
    const tail = String(err.stderr ?? "").trim().split("\n").slice(-5).join("\n");
    throw new Error(`\`playwright test --list\` failed (exit ${err.status}). Last stderr lines:\n${tail}`);
  }
  return JSON.parse(stdout);
}

function runVerify(argv, baseline, baselinePath) {
  const shards = Number(arg(argv, "shards", "3"));
  const preCaptured = argAll(argv, "list-json");
  if (preCaptured.length && preCaptured.length !== shards) {
    // Fail rather than silently verify a subset: a missing report would read as
    // a shard that selected nothing, i.e. the exact false verdict this mode
    // exists to produce loudly.
    throw new Error(
      `--verify got ${preCaptured.length} --list-json report(s) for ${shards} shard(s); ` +
        "pass one per shard, in shard order",
    );
  }
  const perShard = [];
  for (let i = 1; i <= shards; i++) {
    const fragment = buildFragment(shardTitles(baselineTitles(baseline), shards, i).map(escapeTitle));
    const report = preCaptured.length
      ? JSON.parse(fs.readFileSync(preCaptured[i - 1], "utf8"))
      : listSelection(fragment);
    perShard.push(listedPairs(report));
  }
  const verdict = verifySelection(baseline, perShard);
  const out = verifyReportLines(verdict).join("\n");
  if (verdict.ok) {
    console.log(`${out}\n  (against ${baselinePath})`);
    return 0;
  }
  console.error(out);
  return 1;
}

function main(argv) {
  const baselinePath = arg(argv, "baseline", "tests/assets/triage/inherited-backlog-baseline.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  checkTitleCollisions(baseline, baselinePath);
  if (argv.includes("--verify")) return runVerify(argv, baseline, baselinePath);
  const titles = shardTitles(baselineTitles(baseline), arg(argv, "shards", "3"), arg(argv, "shard", "1"));
  process.stdout.write(`${buildFragment(titles.map(escapeTitle))}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`[triage-grep] ${err.message}`);
    process.exit(1);
  }
}
