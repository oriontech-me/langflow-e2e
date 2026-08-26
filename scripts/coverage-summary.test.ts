import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "path";
import { execFileSync } from "child_process";
import { renderCoverageTable, type Counts, type ModuleConfig } from "./coverage-summary";

// The generator's first unit test (#1607). It had none: the script exported
// nothing, so the table the roadmap and leadership read — regenerated on every
// push to `main` by update-coverage-summary.yml — was covered by neither unit
// lane. Assertions are on the RENDERED OUTPUT, never on the shape of the code
// (#1226: a guard that pins a spelling pins no behaviour).

const c = (validated: number, needsValidation: number, partial: number, notAutomated: number): Counts =>
  ({ validated, needsValidation, partial, notAutomated });

const mod = (label: string, excludeFromTotal = false): ModuleConfig =>
  ({ label, sectionStart: `## ${label}`, ...(excludeFromTotal ? { excludeFromTotal } : {}) });

test("an excluded module keeps its own row, with its real counts", () => {
  // The work must stay visible: 19 files and 62 tests do not vanish because the
  // lane was declined. Only the denominator changes.
  const rows = renderCoverageTable(
    [mod("oss"), mod("ent", true)],
    [c(10, 2, 0, 1), c(0, 56, 9, 6)],
  );
  const entRow = rows.find(r => r.includes("| ent"))!;
  assert.ok(entRow, "the excluded module must still have a row");
  assert.match(entRow, /\| 71 \| 0 \| 56 \| 9 \| 6 \|/);
});

test("an excluded module is absent from the TOTAL", () => {
  const rows = renderCoverageTable(
    [mod("oss"), mod("ent", true)],
    [c(10, 2, 0, 1), c(0, 56, 9, 6)],
  );
  const total = rows.find(r => r.includes("TOTAL"))!;
  // 13, not 84: the excluded module's 71 bullets are out of the denominator.
  assert.match(total, /\*\*13\*\*/);
  assert.match(total, /10 \(77%\)/);
});

test("the total row NAMES what it excludes — the exclusion is never silent", () => {
  // The half that matters. A silent exclusion is how the number starts lying
  // again the day the decision reverses (the mode=count lesson, #1252).
  const total = renderCoverageTable(
    [mod("oss"), mod("ent", true)],
    [c(10, 2, 0, 1), c(0, 56, 9, 6)],
  ).find(r => r.includes("TOTAL"))!;
  assert.match(total, /excludes/i);
  assert.match(total, /ent/);
});

test("with nothing excluded the total counts every module, and says nothing extra", () => {
  // The no-op guarantee: this change must be invisible until a module opts in.
  const rows = renderCoverageTable([mod("a"), mod("b")], [c(1, 1, 0, 0), c(2, 0, 0, 0)]);
  const total = rows.find(r => r.includes("TOTAL"))!;
  assert.match(total, /\*\*4\*\*/);
  assert.equal(/excludes/i.test(total), false, "no exclusion note when nothing is excluded");
  assert.match(total, /\| \*\*TOTAL\*\* \|/);
});

test("excluding every module reports zero rather than dividing by zero", () => {
  const total = renderCoverageTable([mod("a", true)], [c(3, 1, 0, 0)]).find(r => r.includes("TOTAL"))!;
  assert.match(total, /\*\*0\*\*/);
  assert.doesNotMatch(total, /NaN/);
});

test("module rows and counts stay aligned by index", () => {
  // A zip bug here would silently attribute one module's numbers to another —
  // invisible in a table that always renders.
  const rows = renderCoverageTable(
    [mod("first"), mod("second")],
    [c(1, 0, 0, 0), c(0, 0, 0, 9)],
  );
  assert.match(rows.find(r => r.includes("| first"))!, /\| 1 \| 1 \| 0 \| 0 \| 0 \|/);
  assert.match(rows.find(r => r.includes("| second"))!, /\| 9 \| 0 \| 0 \| 0 \| 9 \|/);
});

test("the exclusion note uses the module KEY, not its whole em-dashed label", () => {
  // The fixture this file first used was `label: "ent"` — a shape the real
  // MODULES array never contains. Every real label is "`dir/` — Description",
  // and splicing the whole thing into a sentence that already has an em-dash
  // renders "TOTAL (OSS — excludes `enterprise/` — Enterprise-only Surfaces)".
  const total = renderCoverageTable(
    [mod("`oss/` — Open Source"), mod("`enterprise/` — Enterprise-only Surfaces", true)],
    [c(10, 2, 0, 1), c(0, 56, 9, 6)],
  ).find(r => r.includes("TOTAL"))!;
  assert.match(total, /excludes `enterprise\/`\)/);
  assert.doesNotMatch(total, /Enterprise-only Surfaces\)/);
});

test("two excluded modules are both named, comma-separated", () => {
  const total = renderCoverageTable(
    [mod("`a/` — A", true), mod("`b/` — B", true), mod("`c/` — C")],
    [c(1, 0, 0, 0), c(1, 0, 0, 0), c(5, 0, 0, 0)],
  ).find(r => r.includes("TOTAL"))!;
  assert.match(total, /excludes `a\/`, `b\/`\)/);
  assert.match(total, /\*\*5\*\*/);
});

test("importing the module does NOT run the generator", () => {
  // The defect this pins was live for one commit: making the script importable
  // left `main()` bare at module scope, so merely LOADING it rewrote a tracked
  // file — on every `npm run test:units`, CI included. A unit lane that mutates
  // the repo as a side effect of importing is worse than no lane.
  //
  // Asserted on the child's STDOUT, not on the checklist's bytes. The first
  // version of this test compared the file before and after and could not fail:
  // with the guard removed, the import at the top of THIS file has already run
  // the generator by the time the test reads its baseline, so the baseline is
  // the rewritten content and the child then finds nothing to do. Reading the
  // output also means the test writes nothing at all.
  //
  // Behavioural on purpose rather than grepping the source for `require.main` —
  // a guard that pins a spelling pins no behaviour (#1226).
  const repoRoot = path.resolve(__dirname, "..");
  const out = execFileSync(
    process.execPath,
    ["--require", "ts-node/register", "-e", "require('./scripts/coverage-summary.ts')"],
    { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(
    out.trim(),
    "",
    `importing coverage-summary.ts ran the generator (it printed: ${out.trim()}) — the entry point is unguarded`,
  );
});
