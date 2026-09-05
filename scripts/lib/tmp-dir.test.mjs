// The self-removing temp directory, and the guard that keeps it the only spelling
// (issue #1732).
//
// Two halves, and the structural one is what stops the leak coming back. The
// behavioural tests prove the sweep works; they cannot prove the 26th test file
// will use it. A rule that "the name `mkdtempSync` does not appear" is crisply
// checkable, which "does this file clean up somewhere" is not — 25 of the 36 files
// that leaked all *looked* fine in review. It matches the NAME rather than the
// call because the first version matched only the call, and a mechanical rewrite
// left the import behind in two files: half-converted, invisible here, and
// invisible to `npm run lint` too, where `no-unused-vars` is only a warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeTempDir, removeAllTempDirs } from "./tmp-dir.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HELPER_MJS = "scripts/lib/tmp-dir.mjs";
const HELPER_TYPES = "scripts/lib/tmp-dir.d.mts";
/**
 * This file holds the offending spelling as a fixture, so it cannot scan itself.
 * Matched by SUFFIX, not by exact path: an identical copy reached through another
 * checkout is still this file, and skipping it by full path is what made the walk
 * report its own sibling as an offender.
 */
const SELF = "scripts/lib/tmp-dir.test.mjs";

// ---------- behaviour ----------

test("makeTempDir creates a real directory and removeAllTempDirs takes it away", () => {
  const dir = makeTempDir("tmp-dir-unit-");
  assert.ok(statSync(dir).isDirectory());
  writeFileSync(join(dir, "a.txt"), "x");

  removeAllTempDirs();
  assert.equal(existsSync(dir), false, "the sweep must remove a NON-EMPTY directory");
});

test("the sweep is idempotent, and survives a caller that already cleaned up", () => {
  const dir = makeTempDir("tmp-dir-unit-");
  execFileSync(process.execPath, ["-e", `require("node:fs").rmSync(${JSON.stringify(dir)}, {recursive:true})`]);
  // A test that removes its own directory mid-run is doing nothing wrong; the
  // sweep uses `force`, so removing it twice must not throw.
  assert.doesNotThrow(() => removeAllTempDirs());
  assert.doesNotThrow(() => removeAllTempDirs());
});

test("the sweep runs on process exit — which is what makes it unforgettable", () => {
  // The whole design rests on this: the caller registers nothing, and `node --test`
  // gives each test file its own child process, so "process exit" means "this file
  // is done". Proven by exiting a real process, not by asserting the listener.
  const helper = join(REPO_ROOT, HELPER_MJS);
  const dir = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { makeTempDir } from ${JSON.stringify(helper)};
       process.stdout.write(makeTempDir("tmp-dir-exit-"));`,
    ],
    { encoding: "utf8" },
  ).trim();

  assert.match(dir, /tmp-dir-exit-/);
  assert.equal(existsSync(dir), false, "the child exited and its directory outlived it");
});

test("a directory the sweep cannot remove costs a leak, never a failed run", () => {
  // Best effort by design. A throw here would turn the fix for a leak into a new
  // way to redden a run that otherwise passed.
  const dir = makeTempDir("tmp-dir-unit-");
  mkdirSync(join(dir, "nested"), { recursive: true });
  assert.doesNotThrow(() => removeAllTempDirs());
});

// ---------- the guard ----------

/**
 * Exactly the roots the three lanes glob — NOT a full-tree walk.
 *
 * The first version recursed everything under the repo root, and this repo puts
 * whole checkouts at `.claude/worktrees/<branch>/`. From the main checkout it
 * scanned 267 files, 137 of them on other people's branches, and reported 95
 * offenders — two of which were the SIBLING COPY of this very file, whose plain
 * text mentions of the name only escape via `SELF`, an exact path the copy cannot
 * match. CI (a fresh clone, no worktrees) stayed green throughout: the same
 * CI-green / local-red inversion this whole change exists to correct.
 *
 * Deriving the roots from the lanes also makes the floor below mean something.
 */
const SCAN_ROOTS = ["scripts", "tests", ".claude/skills"];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a root that does not exist is caught by the floor, not here
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.(mjs|ts)$/.test(entry.name)) out.push(full.slice(REPO_ROOT.length));
  }
  return out;
}

/** Every `*.test.mjs` / `*.test.ts` the three unit lanes actually run. */
function testFiles() {
  const out = [];
  // `test:units` globs root-level `*.test.ts` too (playwright.config.test.ts).
  for (const entry of readdirSync(REPO_ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /\.test\.ts$/.test(entry.name)) out.push(entry.name);
  }
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), out);
  return out;
}

test("no unit test names mkdtempSync — the directory it makes is the one nothing removes", () => {
  const offenders = [];
  const files = testFiles();
  let scanned = 0;

  for (const file of files) {
    if (file.endsWith(SELF)) continue;
    scanned += 1;
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    // Comments are blanked, not deleted, so the line number stays honest (#1222).
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/(^|[^:\w])\/\/.*$/gm, (m, prefix) => prefix + m.slice(prefix.length).replace(/[^\n]/g, " "));

    // The NAME, not just the call. The first version matched `mkdtempSync\s*\(`
    // and a mechanical rewrite left the import behind in two files — half-converted,
    // and invisible to both this guard and `npm run lint` (`no-unused-vars` is a
    // warning here, so CI stayed green). "The name does not appear" is the stricter
    // rule and it is no harder to check.
    for (const match of code.matchAll(/\bmkdtempSync\b/g)) {
      const line = code.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these tests name mkdtempSync — use makeTempDir() from scripts/lib/tmp-dir instead, and drop the import:\n  ${offenders.join(
      "\n  ",
    )}`,
  );

  // A sweep that finds no test files passes, and would keep passing after a
  // directory rename — the guard's own failure mode, and the one it cannot report
  // because it looks exactly like compliance. A bare count does not pin that: move
  // this file one directory down and `REPO_ROOT` resolves to `scripts/`, which
  // alone holds 57 files, so any threshold under that passes with every file under
  // `tests/` — the biggest leaker included — silently out of scope.
  //
  // So the floor names one file per region the lanes glob. Losing a region becomes
  // a failure that says which one.
  for (const anchor of [
    "playwright.config.test.ts", //            root-level, test:units
    "scripts/watch-upstream-areas.test.mjs", // scripts, test:scripts
    "tests/helpers/flows/token-attribution.test.ts", // tests, test:units — 4480 dirs, the worst offender
    ".claude/skills/langflow-e2e-issue-deterministic/pipeline/state.test.ts", // test:pipeline
  ]) {
    assert.ok(
      files.includes(anchor),
      `${anchor} was not scanned — the sweep no longer reaches the region it anchors (scanned ${scanned})`,
    );
  }
});

test("the declaration file describes the implementation it stands for", () => {
  // There is ONE implementation now; what can still drift is its `.d.mts`. The two
  // directions fail differently, and only one of them is loud: a name the `.mjs`
  // gains and the `.d.mts` does not is a compile error for the first `.ts` caller,
  // while a name the `.d.mts` declares and the `.mjs` does not have typechecks
  // clean and is `undefined` at run time.
  const exported = (file, re) => [...readFileSync(join(REPO_ROOT, file), "utf8").matchAll(re)].map((m) => m[1]).sort();

  const impl = exported(HELPER_MJS, /export function (\w+)/g);
  const declared = exported(HELPER_TYPES, /export declare function (\w+)/g);

  assert.deepEqual(declared, impl, "the .d.mts and the .mjs disagree about what is exported");
  assert.deepEqual(impl, ["makeTempDir", "removeAllTempDirs"]);
});

test("the exit sweep is proven against the module every lane actually loads", () => {
  // The `.ts` twin this replaced had ZERO behavioural coverage, and it was the copy
  // the biggest leaker used: deleting its exit hook would have leaked the whole
  // `test:units` lane with every test green. One implementation is what makes the
  // proof above cover all three lanes — asserted here so the twin cannot come back
  // without someone noticing this test no longer says what it claims.
  assert.equal(existsSync(join(REPO_ROOT, "scripts/lib/tmp-dir.ts")), false, "a second implementation is back");
  for (const file of ["tests/helpers/flows/token-attribution.test.ts", "playwright.config.test.ts"]) {
    assert.match(
      readFileSync(join(REPO_ROOT, file), "utf8"),
      /from "[^"]*tmp-dir\.mjs"/,
      `${file} does not load the implementation the exit-sweep test proves`,
    );
  }
});
