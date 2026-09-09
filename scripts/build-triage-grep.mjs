#!/usr/bin/env node
/**
 * Emits ONE `--grep` fragment selecting a third of the never-validated backlog,
 * for a `manual.yml` dispatch (`test_grep`). Design: §2.
 *
 *   node scripts/build-triage-grep.mjs --shards 3 --shard 1
 *
 * `build-grep-filter.mjs` passes a single fragment VERBATIM, so everything the
 * selection needs has to be inside this string: the non-capturing group and the
 * escaping. An unparenthesised alternation is not ANDed as a unit -- #1275,
 * where a dispatch silently ran 48 of 81 tests with nothing saying so.
 */
import fs from "fs";

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
 * Extracted
 * as its own pure function (rather than inlined in `main()`) so this refusal
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

function arg(argv, name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  const idx = argv.indexOf(`--${name}`);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : fallback;
}

function main(argv) {
  const baselinePath = arg(argv, "baseline", "tests/assets/triage/inherited-backlog-baseline.json");
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  checkTitleCollisions(baseline, baselinePath);
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
