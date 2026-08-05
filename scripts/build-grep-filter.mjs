#!/usr/bin/env node
/**
 * Composes the single `--grep` filter a lane hands to Playwright (issue #1275).
 *
 * WHY THIS EXISTS AT ALL
 *
 * Playwright honours exactly ONE `--grep`, so a lane that wants "tag AND name" — or
 * "@destructive AND whatever the dispatch asked for" — has to AND its filters itself,
 * which it does with a chain of lookaheads: each fragment must match somewhere in the
 * test's title, and all of them must match.
 *
 * WHY IT IS A SCRIPT AND NOT INLINE SHELL
 *
 * Four lanes built that chain by interpolating each fragment straight into the
 * lookahead, unparenthesised:
 *
 *   ARGS+=(--grep "(?=.*${TEST_TAG})(?=.*${TEST_GREP})")
 *
 * Alternation has the lowest precedence inside a group, so a fragment containing `|`
 * does not go in as a unit — it splits the lookahead. `test_tag=@stable` with
 * `test_grep=@agents|@model-provider` produced:
 *
 *   (?=.*@stable)(?=.*@agents|@model-provider)
 *
 * whose second lookahead reads as `(?=(?:.*@agents)|(?:@model-provider))`. Measured on
 * the suite at the time of the fix:
 *
 *   (?=.*@stable)(?=.*(?:@agents|@model-provider))   81 tests / 37 files
 *   (?=.*@stable)(?=.*@agents|@model-provider)       48 tests / 26 files
 *   (?=.*@stable)(?=.*@agents)                       48 tests / 26 files  <- identical
 *
 * The broken form is byte-identical in selection to asking for `@agents` alone: the run
 * is silently NARROWER than the dispatch asked for, and the summary reports success
 * over the smaller set (#1012's rule). It cost real coverage during the 1.11.2rc3
 * release validation.
 *
 * WHY IT NARROWS — the mechanism is positional, and worth stating precisely, because
 * the obvious reading ("the second branch has to match at position 0") is wrong and
 * makes the bug look like it could never match anything. Lookaheads are zero-width, so
 * every lookahead in the chain is evaluated at the SAME starting position, and the
 * engine is free to try every position in the string. A `.*`-prefixed branch is
 * position-insensitive; a bare branch like `@model-provider` is not — it pins the
 * starting position to where that token literally begins, and every OTHER lookahead
 * must then match from that same position onward. So the broken filter really asks:
 * "@model-provider appears somewhere, AND @stable appears AT OR AFTER it."
 *
 * Which is unsatisfiable in this suite, for a reason that has nothing to do with the
 * regex: `@stable` is declared FIRST in essentially every `tag:` array (55 specs are
 * `["@stable", "@regression", "@components"]`, and so on), so a functional tag always
 * comes after it. Hence the measured 48 vs 81.
 *
 * Two consequences of that mechanism, both of which the tests pin. It is ORDER
 * DEPENDENT, so the same defect can also leave the selection accidentally correct — a
 * title where the alternated token happens to precede the other filter's token still
 * matches, which is why a fixture has to assert both orderings or it will pass against
 * the broken form. And it is not purely a narrowing bug in general: the coupling
 * constrains WHERE each filter may match, so a fragment matching the file path — which
 * Playwright includes in the grep target, ahead of the tags — behaves differently again
 * (`--grep model-provider` hits `core-functionality/model-provider/`). None of that is
 * worth reasoning about per dispatch; the fix removes the coupling entirely.
 *
 * Wrapping each fragment is a one-character-per-side change, so the temptation was to
 * fix it in the YAML and pin it with a regex over the workflow text. That is the guard
 * #1226 already showed does not hold: a regex asserting the built string contains
 * `(?=.*(?:${TEST_GREP}))` passes just as happily when someone swaps `TEST_GREP` for
 * `TEST_TAG`, because it pins a SPELLING, not a behaviour. Here the assertions are
 * about SELECTION — `buildGrepFilter({tag: "@stable", grep: "@agents|@model-provider"})`
 * is compiled and run against real test titles, and the test fails if the
 * `@model-provider` title stops matching. Same trade `render-impacted-summary.mjs`,
 * `resolve-echo-endpoint.mjs` and `wait-for-backend.mjs` already made.
 *
 * WHAT IT GUARANTEES
 *
 * - Every fragment is ANDed as a UNIT: an alternation, a group, a quantified atom, all
 *   go in whole. `(?:…)` is non-capturing, so it cannot renumber a backreference the
 *   caller wrote inside its own fragment.
 * - A single fragment is passed VERBATIM, exactly as the lanes did before, so the
 *   overwhelmingly common `--grep @stable` path is untouched by this change.
 * - An invalid fragment is refused HERE, naming which one and why, instead of reaching
 *   Playwright as a composed string whose error message points at the composition.
 * - No fragments means NO filter (empty output) — never an empty regex, which matches
 *   every test and would turn a narrowed dispatch into a full-suite run.
 *
 * Usage (a lane reads the composed filter, empty output = pass no --grep at all):
 *   FILTER="$(node scripts/build-grep-filter.mjs --tag="$TEST_TAG" --grep="$TEST_GREP")"
 *   FILTER="$(node scripts/build-grep-filter.mjs --require=@destructive --tag="$TEST_TAG" --grep="$TEST_GREP")"
 *
 * Exits 1 with the cause on stderr when a fragment is not a valid regex.
 */

/**
 * Wraps one fragment so it is ANDed as a unit.
 *
 * `(?:…)` rather than `(…)`: a capturing wrapper would shift the numbering of any
 * group the caller wrote, silently breaking a fragment like `(foo|bar)\1`.
 */
function lookahead(fragment) {
  return `(?=.*(?:${fragment}))`;
}

/**
 * Composes the `--grep` value for a lane.
 *
 * @param {object} [options]
 * @param {string} [options.tag]     The `test_tag` dispatch input (e.g. `@stable`).
 * @param {string} [options.grep]    The `test_grep` dispatch input (a name/regex filter).
 * @param {string[]} [options.require] Fragments the lane always requires, ANDed ahead of
 *   the dispatch inputs (the destructive lane's `@destructive`). Ordered first so the
 *   printed filter reads as "this lane, narrowed by the dispatch".
 * @returns {string|null} The filter, or `null` when there is nothing to filter on.
 */
export function buildGrepFilter({ tag = "", grep = "", require = [] } = {}) {
  // Whitespace-only is absent, not a fragment: a dispatch form's untouched text input
  // can arrive as " ", and `(?=.*(?: ))` would silently require a literal space in
  // every title — a narrowing nobody asked for.
  const fragments = [...require, tag, grep]
    .map((fragment) => String(fragment ?? "").trim())
    .filter((fragment) => fragment.length > 0);

  for (const fragment of fragments) {
    try {
      new RegExp(fragment);
    } catch (error) {
      throw new Error(
        `not a valid regex: ${JSON.stringify(fragment)} — ${error.message}`,
      );
    }
  }

  if (fragments.length === 0) return null;

  // One fragment needs no composition, and passing it through unchanged keeps the
  // `--grep @stable` lanes on exactly the string they used before this script existed.
  if (fragments.length === 1) return fragments[0];

  return fragments.map(lookahead).join("");
}

/**
 * Parses `--key=value` args. Repeated `--require` accumulates; anything else is a
 * single value. An unknown flag is refused rather than ignored — a typo'd `--tags`
 * would otherwise drop the tag and widen the run.
 */
export function parseArgs(argv) {
  const options = { tag: "", grep: "", require: [] };

  for (const arg of argv) {
    const match = /^--([a-z-]+)=(.*)$/s.exec(arg);
    if (!match) throw new Error(`unrecognised argument: ${JSON.stringify(arg)}`);

    const [, key, value] = match;
    if (key === "tag") options.tag = value;
    else if (key === "grep") options.grep = value;
    else if (key === "require") options.require.push(value);
    else throw new Error(`unrecognised option: --${key}`);
  }

  return options;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  try {
    const filter = buildGrepFilter(parseArgs(process.argv.slice(2)));
    // No filter prints nothing, so `FILTER="$(…)"` is empty and the caller's
    // `[ -n "$FILTER" ]` decides not to pass --grep at all.
    if (filter !== null) process.stdout.write(`${filter}\n`);
  } catch (error) {
    process.stderr.write(`build-grep-filter: ${error.message}\n`);
    process.exit(1);
  }
}
