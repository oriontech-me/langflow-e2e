#!/usr/bin/env node
/**
 * Decides whether a spec selection needs a browser installed at all (#1507).
 *
 * Playwright launches a browser only for tests that use the `page`, `context`
 * or `browser` fixtures. A spec that uses only `request` is an HTTP client:
 * everything under `regression/enterprise/` today, plus several API specs.
 * PR #1506 spent 26 minutes installing Chromium for seven such tests, twice,
 * and both runs had to be cancelled — the install is the single slowest step in
 * the lane and it is unconditional.
 *
 * The direction of caution is the opposite of `destructive-only-selection.mjs`.
 * There, "runnable" was the safe default because skipping a lane loses coverage
 * silently. Here the dangerous answer is a wrong SKIP: a browser-free verdict on
 * a selection that actually opens a browser fails the run with a launch error
 * that names nothing. So every ambiguity resolves to "install":
 *
 *   - a spec that cannot be read           => install
 *   - a spec with no recognisable fixtures => install
 *   - an empty selection                   => install
 *
 * Only a selection where EVERY spec is positively identified as browser-free
 * skips the install, and the workflow additionally forces the install whenever
 * `Collect models` runs (that spec drives a browser) or on a canary run.
 *
 * Usage:
 *   node scripts/browser-required-selection.mjs --specs "a.spec.ts b.spec.ts"
 *   node scripts/browser-required-selection.mjs --specs "…" --format=json
 *
 * Prints `true` / `false` (browser required), or the JSON verdict.
 */

import { readFileSync } from "node:fs";

/**
 * A destructured fixture list on an async callback: `async ({ page })`,
 * `async ({ request, page })`, and the multi-line spellings prettier produces.
 * Covers `test(...)`, `test.beforeEach(...)` and `test.step(...)` alike, because
 * what matters is whether ANY callback in the file asks for a browser fixture.
 */
const FIXTURE_CALLBACK_RE = /async\s*\(\s*\{([^}]*)\}/g;
const BROWSER_FIXTURES = ["page", "context", "browser"];

/**
 * `true` when the source positively asks for a browser fixture, `false` when it
 * positively asks for none, and `null` when nothing recognisable was found —
 * which the caller must treat as "install", never as "skip".
 */
export function usesBrowser(source) {
  const lists = [...source.matchAll(FIXTURE_CALLBACK_RE)].map((match) => match[1]);
  if (lists.length === 0) return null;

  for (const list of lists) {
    // Word boundaries: a fixture called `requestPage` or a property named
    // `pageSize` must not read as the `page` fixture.
    const names = list.split(",").map((entry) => entry.split(":")[0].trim());
    if (names.some((name) => BROWSER_FIXTURES.includes(name))) return true;
  }
  return false;
}

/**
 * @param specs     spec paths, as the workflow's `$SPECS` splits them
 * @param readSpec  reads a spec's source; throws when it cannot
 * @returns `{ browserRequired, browserFree, undecidable, browserUsing }`
 */
export function classifySelection(specs, readSpec) {
  const browserFree = [];
  const browserUsing = [];
  const undecidable = [];

  for (const spec of specs) {
    let verdict;
    try {
      verdict = usesBrowser(readSpec(spec));
    } catch {
      // Unreadable is undecidable, and undecidable installs. This never fails
      // the step: a selection this script cannot classify still runs, it just
      // pays for the browser it might need.
      undecidable.push(spec);
      continue;
    }
    if (verdict === true) browserUsing.push(spec);
    else if (verdict === false) browserFree.push(spec);
    else undecidable.push(spec);
  }

  return {
    browserRequired:
      specs.length === 0 || browserUsing.length > 0 || undecidable.length > 0,
    browserFree,
    browserUsing,
    undecidable,
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
  const verdict = classifySelection(list, (spec) => readFileSync(spec, "utf8"));

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
  } else {
    process.stdout.write(`${verdict.browserRequired}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
