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
const HELPER_TS = "scripts/lib/tmp-dir.ts";
/** This file holds the offending spelling as a fixture, so it cannot scan itself. */
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

/** Every `*.test.mjs` / `*.test.ts` under the directories both unit lanes read. */
function testFiles(dir = REPO_ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (/\.test\.(mjs|ts)$/.test(entry.name)) out.push(full.slice(REPO_ROOT.length));
  }
  return out;
}

test("no unit test names mkdtempSync — the directory it makes is the one nothing removes", () => {
  const offenders = [];
  let scanned = 0;

  for (const file of testFiles()) {
    if (file === SELF) continue;
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
  // because it looks exactly like compliance.
  assert.ok(scanned > 50, `only ${scanned} test file(s) scanned — the sweep no longer reaches the unit lanes`);
});

test("the two copies of the helper stay in step", () => {
  // They are a deliberate duplication — the root tsconfig is `"module": "commonjs"`
  // and Node 20 cannot `require()` an ESM `.mjs`, so a `.ts` test cannot reach the
  // `.mjs` copy at all. Pinned rather than trusted: a name added to one and not the
  // other is how the duplication stops being a copy.
  const names = (file) =>
    [...readFileSync(join(REPO_ROOT, file), "utf8").matchAll(/export function (\w+)/g)].map((m) => m[1]).sort();

  assert.deepEqual(names(HELPER_MJS), names(HELPER_TS));
  assert.deepEqual(names(HELPER_MJS), ["makeTempDir", "removeAllTempDirs"]);

  // And both say WHY they are duplicated, so the next reader does not "fix" it.
  for (const file of [HELPER_MJS, HELPER_TS]) {
    assert.match(readFileSync(join(REPO_ROOT, file), "utf8"), /commonjs/i, `${file} does not record why the copy exists`);
  }
});
