// The self-removing temp directory, and the guard that keeps it the only spelling
// (issue #1732).
//
// Two halves, and the structural one is what stops the leak coming back. The
// behavioural tests prove the sweep works; they cannot prove the 26th test file
// will use it. A rule that "the name `mkdtemp` does not appear" is crisply
// checkable, which "does this file clean up somewhere" is not — 25 of the 36 files
// that leaked all *looked* fine in review. It matches the NAME rather than the
// call because the first version matched only the call, and a mechanical rewrite
// left the import behind in two files: half-converted, invisible here, and
// invisible to `npm run lint` too, where `no-unused-vars` is only a warning.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

test(
  "a directory the sweep cannot remove costs a leak, never a failed run",
  // Root removes anything, so the fixture below cannot be built there.
  { skip: process.getuid?.() === 0 ? "running as root — EACCES cannot be provoked" : false },
  () => {
    // Best effort by design. A throw here would turn the fix for a leak into a new
    // way to redden a run that otherwise passed.
    //
    // The fixture has to be something `rmSync` GENUINELY cannot remove, and the
    // first version of this test was not: it used a nested subdirectory, which
    // `{ recursive: true }` takes away without complaint. So it asserted
    // `doesNotThrow` against a sweep that never had anything to throw about —
    // deleting the `try/catch` from `removeAllTempDirs` left it green, which is the
    // same "names in step, behaviour not" shape that the `.ts` twin had.
    //
    // A NON-EMPTY directory with no write bit is the smallest thing that really
    // fails, because unlinking needs write permission on the PARENT of what is
    // being unlinked. An empty one would not do — its own parent is still writable,
    // which is why `run-e2e.test.mjs`'s `0o500` fixtures sweep away fine.
    const dir = makeTempDir("tmp-dir-unit-");
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "trapped.txt"), "x");
    chmodSync(locked, 0o500);
    try {
      // Pin the fixture itself. Without this the test can go vacuous again in
      // silence, which is exactly how it got here.
      assert.throws(
        () => rmSync(dir, { recursive: true, force: true }),
        { code: "EACCES" },
        "the fixture is removable after all — the assertion below would prove nothing",
      );
      assert.doesNotThrow(() => removeAllTempDirs());
    } finally {
      // The sweep gave up on this directory and then forgot it, so nothing else
      // will come back for it.
      chmodSync(locked, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

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

test("no unit test names mkdtemp — the directory it makes is the one nothing removes", () => {
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
    //
    // And the whole FAMILY, not one spelling of it: `fs.mkdtemp` (callback) and
    // `fs.promises.mkdtemp` leak exactly the same directory, and a guard that names
    // only the sync one reads as coverage while leaving two doors open. Zero test
    // files use either today, so widening costs nothing now and is the only moment
    // it ever will.
    for (const match of code.matchAll(/\bmkdtemp(?:Sync)?\b/g)) {
      const line = code.slice(0, match.index).split("\n").length;
      offenders.push(`${file}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these tests name mkdtemp/mkdtempSync — use makeTempDir() from scripts/lib/tmp-dir instead, and drop the import:\n  ${offenders.join(
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

test("the `require(esm)` floor this helper needs is the Node every lane installs", () => {
  // This helper is the repo's only ESM module a CommonJS lane imports: the root
  // tsconfig is `"module": "commonjs"`, so `ts-node/register` emits `require()` for
  // `tmp-dir.mjs`, and `require(esm)` only exists from Node 20.19. That floor is
  // declared in `package.json` — but `engines` is advisory, npm does not enforce it
  // without `engine-strict`, and nothing was checking that CI installs a Node above
  // it. A pin of `node-version: "20.9"` would take out all three unit lanes at once
  // with `ERR_REQUIRE_ESM` in 37 files and no line anywhere naming the cause.
  //
  // So the floor is checked against the pins rather than restated in prose. A value
  // this cannot decide is an offender too — degrading to "probably fine" is how the
  // pin drifts below the floor unnoticed (#1012).
  const engines = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).engines?.node ?? "";
  const floor = /^>=\s*(\d+)\.(\d+)/.exec(engines);
  assert.ok(floor, `package.json declares no ">=major.minor" engines.node floor (got ${JSON.stringify(engines)})`);
  const [floorMajor, floorMinor] = [Number(floor[1]), Number(floor[2])];

  /** `undefined` when the value is one this cannot decide. */
  const satisfies = (raw) => {
    const value = raw.trim().replace(/^["']|["']$/g, "");
    // A bare major installs the newest release of that line, so it clears any floor
    // inside it. Anything more specific is compared outright.
    if (/^\d+$/.test(value)) return Number(value) >= floorMajor;
    const exact = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(value);
    if (!exact) return undefined;
    const [major, minor] = [Number(exact[1]), Number(exact[2])];
    return major !== floorMajor ? major > floorMajor : minor >= floorMinor;
  };

  const yamlFiles = [];
  for (const root of [".github/workflows", ".github/actions"]) {
    const stack = [join(REPO_ROOT, root)];
    while (stack.length) {
      let entries;
      try {
        entries = readdirSync(stack.pop(), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(entry.parentPath ?? entry.path, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (/\.ya?ml$/.test(entry.name)) yamlFiles.push(full);
      }
    }
  }

  const offenders = [];
  let pins = 0;
  for (const file of yamlFiles) {
    const text = readFileSync(file, "utf8");
    const where = file.slice(REPO_ROOT.length);
    for (const match of text.matchAll(/^\s*node-version:\s*(\S.*?)\s*$/gm)) {
      pins += 1;
      const verdict = satisfies(match[1]);
      const line = text.slice(0, match.index).split("\n").length;
      if (verdict === undefined) offenders.push(`${where}:${line} — cannot decide ${match[1]} against ${engines}`);
      else if (!verdict) offenders.push(`${where}:${line} — ${match[1]} is below ${engines}`);
    }
  }

  assert.deepEqual(offenders, [], `these Node pins do not clear the engines floor:\n  ${offenders.join("\n  ")}`);

  // A sweep that finds nothing passes, and would keep passing after a rename — the
  // same failure mode the region anchors below guard against.
  assert.ok(pins >= 10, `only ${pins} node-version pins found — the scan no longer reaches .github/`);

  // The half that actually matters: the lanes that RUN the unit tests are the ones
  // that execute `require(esm)`, so those files must carry a pin rather than take
  // whatever Node the runner image happens to ship.
  //
  // Anchored on `run:` and not on the text, because this repo writes the lane names
  // into its prose constantly — six comments plus a composite action's `description`
  // block name `npm run test:scripts` without executing it, and matching those made
  // the first version of this fail on `file-watcher.yml`, a workflow that runs no
  // Node at all.
  const runsUnitLane = (text) => {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const step = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[i]);
      if (!step) continue;
      const [, indent, inline] = step;
      const body = [];
      if (inline && !/^[|>][-+\d]*$/.test(inline)) body.push(inline);
      else {
        // A block scalar: everything indented deeper than the `run:` key itself.
        for (let j = i + 1; j < lines.length; j += 1) {
          if (lines[j].trim() === "") continue;
          if (/^\s*/.exec(lines[j])[0].length <= indent.length) break;
          body.push(lines[j]);
        }
      }
      // A `run: |` body is shell, and this repo comments its shell as densely as its
      // YAML — `run-e2e/action.yml` explains #1275 inside a block that runs no unit
      // lane at all. Dropped rather than blanked: nothing here reports a line number.
      const code = body.filter((line) => !line.trim().startsWith("#"));
      if (code.some((line) => /npm run test:(?:units|scripts|pipeline)\b/.test(line))) return true;
    }
    return false;
  };

  // Checked per JOB, not per file, and that distinction is the whole assertion. At
  // file granularity, deleting the unit lane's own `node-version` still passed —
  // `pr-validation.yml` carries five pins and the other four kept the file looking
  // compliant while the job that runs `require(esm)` silently fell back to whatever
  // Node the runner image ships. Found by mutating this guard rather than by reading
  // it, which is the same way the fixture two tests up turned out to be vacuous.
  const jobs = (where, text) => {
    const lines = text.split("\n");
    const starts = [];
    let inJobs = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^jobs:\s*$/.test(lines[i])) inJobs = true;
      else if (inJobs && /^\S/.test(lines[i])) inJobs = false;
      else if (inJobs && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) starts.push(i);
    }
    // A composite action has no `jobs:` — the file itself is the unit of work.
    if (!starts.length) return [{ name: where, text }];
    return starts.map((start, n) => ({
      name: `${where} job ${lines[start].trim().replace(/:$/, "")}`,
      text: lines.slice(start, starts[n + 1] ?? lines.length).join("\n"),
    }));
  };

  let laneJobs = 0;
  for (const file of yamlFiles) {
    const text = readFileSync(file, "utf8");
    for (const job of jobs(file.slice(REPO_ROOT.length), text)) {
      if (!runsUnitLane(job.text)) continue;
      laneJobs += 1;
      assert.match(
        job.text,
        /^\s*node-version:/m,
        `${job.name} runs a unit lane but pins no node-version — the require(esm) floor is undeclared where it is exercised`,
      );
    }
  }
  assert.ok(laneJobs > 0, "no job was found running a unit lane — the `run:` scan stopped reaching them");
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
