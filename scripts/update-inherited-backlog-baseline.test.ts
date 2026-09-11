// Unit tests for the inherited-backlog baseline writer (issue #1769, Task 3).
// Run with: npm run test:units
//
// The wave needs a fixed target and the ownership guard (a later task) needs a
// set of specs that are ALLOWED to be unowned -- both read the committed
// `tests/assets/triage/inherited-backlog-baseline.json`. Most of this is
// covered via the pure parts (`renderBaseline`, `diffBaseline`,
// `formatParseRefusal`): the rest of `main()`'s IO -- reading the real corpus,
// writing the file -- is exercised by actually running the script (see the
// task report for the write / --check / drift-detection transcript), the same
// split `update-component-catalog-baseline.test.ts` uses for its own writer.
// The `--min-specs` validation tests near the bottom are the one exception --
// they spawn the real script (`main()` is not exported, matching every other
// `.ts` script under `scripts/`), because what they cover is exit-code and
// stderr behaviour that a pure-function call cannot observe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as path from "path";
import { renderBaseline, diffBaseline, formatParseRefusal } from "./update-inherited-backlog-baseline";
import { assertNoWarnings, type Backlog } from "./lib/inherited-backlog";
import type { DeclaredTest } from "./lib/stable-tests";

function spec(relativePath: string, tier: "T1" | "T2" = "T2") {
  return {
    relativePath, tier, hasMirroredDoc: tier === "T1", hasIdScopedCleanup: false,
    tests: [{ title: "t", modifier: "", tags: ["@release"], line: 1 }],
  };
}
const backlog = (specs: ReturnType<typeof spec>[]): Backlog =>
  ({ specs, testCount: specs.length, titleCollisions: [] });

test("renderBaseline is deterministic and newline-terminated", () => {
  const a = renderBaseline(backlog([spec("b/y.spec.ts"), spec("a/x.spec.ts")]));
  const b = renderBaseline(backlog([spec("a/x.spec.ts"), spec("b/y.spec.ts")]));
  assert.equal(a, b);
  assert.ok(a.endsWith("\n"));
  assert.ok(a.indexOf('"a/x.spec.ts"') < a.indexOf('"b/y.spec.ts"'));
});

// Finding A6. `classifyBacklog` sorts its spec list by CODE UNITS
// (`[...byFile.keys()].sort()`); this writer re-sorted the same list with
// `localeCompare`. They agree on today's 55 paths, but this is a committed
// artifact whose `--check` compares exact bytes and `localeCompare` is
// ICU-dependent -- so one camelCase directory, on a machine whose Node carries
// a different ICU, is a `--check` failure nobody can reproduce.
//
// Case is the measured disagreement: code units put `A` (65) before `a` (97),
// ICU folds case and orders the lowercase path first. This fixture is the ONLY
// thing distinguishing the two comparators, since every other axis agrees.
test("renderBaseline sorts by code units, not by locale", () => {
  const rendered = renderBaseline(backlog([spec("api/x.spec.ts"), spec("Api/x.spec.ts")]));
  assert.ok(
    rendered.indexOf('"Api/x.spec.ts"') < rendered.indexOf('"api/x.spec.ts"'),
    "uppercase sorts first by code unit; localeCompare would put `api/` first",
  );
  // Stated as the property rather than only as the fixture's outcome.
  assert.equal("Api/x.spec.ts".localeCompare("api/x.spec.ts") > 0, true,
    "the fixture is only meaningful while the two comparators really disagree on it");
});

test("renderBaseline carries no timestamp", () => {
  // A generated-at field would make every regeneration a diff, which is how a
  // committed baseline stops being reviewable.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(renderBaseline(backlog([spec("a/x.spec.ts")]))));
});

test("diffBaseline names added, removed and retiered specs", () => {
  const committed = JSON.parse(renderBaseline(backlog([spec("a/x.spec.ts"), spec("b/y.spec.ts")])));
  const d = diffBaseline(committed, backlog([spec("a/x.spec.ts", "T1"), spec("c/z.spec.ts")]));
  assert.deepEqual(d.added, ["c/z.spec.ts"]);
  assert.deepEqual(d.removed, ["b/y.spec.ts"]);
  assert.deepEqual(d.changed, ["a/x.spec.ts"]);
});

test("a missing committed baseline reports every spec as added", () => {
  const d = diffBaseline(null, backlog([spec("a/x.spec.ts")]));
  assert.deepEqual(d.added, ["a/x.spec.ts"]);
  assert.deepEqual(d.removed, []);
});

// ─── Ruling P8 -- collectBacklog()'s parse-warning throw must not escape main()
// as a raw stack trace. `collectBacklog()` intentionally takes no injectable
// dependency (Task 2), and there are zero parse warnings in the corpus today,
// so `main()`'s try/catch around it is exercised here via the pure formatter
// it delegates to rather than by forcing a real warning through the AST walk
// -- the same choice Task 2 made for `assertNoWarnings` itself.

test("formatParseRefusal names the failure in the floor's own voice", () => {
  // The input is the message `assertNoWarnings` REALLY throws, taken from the
  // function itself rather than transcribed. The transcription it replaces
  // quoted `collectTaggedTests() reported 1 parse warning(s)`, which nothing
  // can produce since the #1746 reconciliation (`db7a580e`) replaced that
  // walker's suite-level warnings array with the per-declaration
  // `DeclaredTest.unparseableTags`. What this pins -- the prefix and the
  // em-dash join -- was never wrong, but a fixture quoting a message no code
  // path emits is one stale read away from being taken for the contract, and
  // a hand-copied literal can go stale again. Deriving it cannot.
  const bad: DeclaredTest = {
    title: "one", relativePath: "a/x.spec.ts", line: 1, tags: [],
    stable: false, fixme: false, modifier: "", unparseableTags: true,
    grepTitle: "one",
  };
  const stderr = console.error;
  console.error = () => {};   // assertNoWarnings prints the offending lines
  let thrown = "";
  try {
    assertNoWarnings([bad]);
  } catch (e) {
    thrown = (e as Error).message;
  } finally {
    console.error = stderr;
  }
  assert.match(thrown, /^collectBacklog\(\): collectDeclaredTests\(\) reported 1 declaration\(s\)/);
  assert.equal(
    formatParseRefusal(new Error(thrown)),
    "[triage-baseline] refusing: the AST parser could not fully read the corpus — " + thrown,
  );
});

test("formatParseRefusal handles a non-Error throw", () => {
  assert.equal(
    formatParseRefusal("boom"),
    "[triage-baseline] refusing: the AST parser could not fully read the corpus — boom",
  );
});

// ─── Review finding (Task 3) -- `--min-specs` must validate its value ────────
// `Number(minArg.split("=")[1])` on a malformed `--min-specs` value -- empty,
// non-numeric, or negative -- used to yield `NaN` or a value
// `current.specs.length < minSpecs` could never be true for, so the floor
// silently no-opped instead of refusing: exactly the failure mode
// `update-component-catalog-baseline.ts`'s `parseNumericArg` (now shared via
// `./lib/numeric-arg`) already closes for `--min-categories`.
//
// `main()` is not exported -- no `.ts` script under `scripts/` exports or
// unit-tests its own `main()` (`update-component-catalog-baseline.test.ts`
// itself stops at `parseNumericArg` and never touches `numericArg` or
// `main()`) -- and this fix is specifically about exit-code and stderr
// behaviour, which a call to a pure function cannot observe. So these spawn
// the real script through `ts-node/register` and read its exit status and
// stderr back, the same technique `playwright.config.test.ts` and
// `remove-stable-from-failures.test.ts` use to exercise a script's actual
// CLI/process behaviour without exporting or restructuring its entry point.
// That also means this exercises the REAL `parseNumericArg`, not a synthetic
// Error standing in for it.
//
// `--check` is passed alongside the bad `--min-specs` value as a second,
// belt-and-braces guard: today the bad value is caught and returns before
// `collectBacklog()` or any file IO runs at all, but even if that ordering
// ever changed, `--check` mode never reaches `fs.writeFileSync` -- so these
// tests cannot touch the committed baseline either way.

const SCRIPT = path.join(__dirname, "update-inherited-backlog-baseline.ts");

function runWithMinSpecs(value: string): { status: number | null; stderr: string } {
  const run = spawnSync(
    process.execPath,
    ["--require", "ts-node/register", SCRIPT, "--check", `--min-specs=${value}`],
    { encoding: "utf-8" },
  );
  return { status: run.status, stderr: run.stderr };
}

test("an empty --min-specs value is refused, not silently disabled", () => {
  const { status, stderr } = runWithMinSpecs("");
  assert.equal(status, 1);
  assert.match(stderr, /\[triage-baseline\] refusing: --min-specs was given no value/);
});

test("a non-numeric --min-specs value is refused, not silently disabled", () => {
  const { status, stderr } = runWithMinSpecs("nope");
  assert.equal(status, 1);
  assert.match(
    stderr,
    /\[triage-baseline\] refusing: --min-specs must be a non-negative number, got: nope/,
  );
});

test("a negative --min-specs value is refused, not silently disabled", () => {
  const { status, stderr } = runWithMinSpecs("-1");
  assert.equal(status, 1);
  assert.match(
    stderr,
    /\[triage-baseline\] refusing: --min-specs must be a non-negative number, got: -1/,
  );
});
