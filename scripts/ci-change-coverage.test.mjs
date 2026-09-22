// Unit tests for the CI-only change classifier (issue #1159).
//
// Two halves. The synthetic ones pin the decision rules; the ones against the
// REAL repo pin the two things that make the canary worth having — that its specs
// still exist and still qualify, and that `pr-validation.yml` actually consumes
// the verdict. A canary wired to a renamed spec, or a verdict nothing reads,
// would restore the silent `skipping` this issue is about.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { makeTempDir } from "./lib/tmp-dir.mjs";

import {
  CANARY_SPECS,
  PR_LANE,
  buildCiReferences,
  classifyCiChange,
  importersOf,
  dispatchAdvice,
  parseWorkflowStates,
  readWorkflowTriggers,
  workflowDispatchability,
} from "./ci-change-coverage.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// A miniature .github: the PR lane uses one action, another lane uses a second.
// Each workflow carries a real `on:` block, because since #1609 the verdict's
// wording depends on it — a fixture without one would exercise only the
// "triggers unreadable" branch and pin none of the advice.
const FIXTURE = {
  workflows: new Map([
    [
      PR_LANE,
      `on:
  pull_request:
    branches: [main]

steps:
  - uses: ./.github/actions/setup-playwright
  - uses: ./.github/actions/wait-for-backend
  - run: node scripts/impacted-specs-by-import.mjs --stdin`,
    ],
    [
      ".github/workflows/daily-stable.yml",
      `on:
  schedule:
    - cron: "0 8 * * 1-5"
  workflow_dispatch:

steps:
  - uses: ./.github/actions/auto-remove-stable
  - run: node scripts/partition-shards.mjs matrix
  - uses: ./.github/actions/wait-for-backend`,
    ],
    // The #1609 case: a lane that runs a script, and that no branch can dispatch.
    [
      ".github/workflows/update-coverage-summary.yml",
      `on:
  push:
    branches: [main]

steps:
  - run: npx ts-node scripts/coverage-summary.ts`,
    ],
    // A workflow whose triggers this cannot read at all.
    [
      ".github/workflows/opaque.yml",
      `steps:
  - run: node scripts/opaque-only.mjs`,
    ],
  ]),
  actions: new Map([
    ["setup-playwright", "runs:\n  steps:\n    - run: npx playwright install"],
    ["wait-for-backend", "runs:\n  steps:\n    - run: node scripts/wait-for-backend.mjs"],
    ["auto-remove-stable", "runs:\n  steps:\n    - run: npx ts-node scripts/remove-stable-from-failures.ts"],
  ]),
};

const refs = buildCiReferences(FIXTURE);
const classify = (...changed) => classifyCiChange({ changed, refs });

// A miniature `scripts/` for the importer graph (#1979). Only the shapes that decide
// a verdict: a lib module two named scripts reach, a module only a TEST imports, a
// cycle, and a test file the YAML happens to name.
const SCRIPT_FILES = new Map([
  [
    "scripts/partition-shards.mjs",
    `import { norm } from "./lib/spec-path.mjs";\nimport { b } from "./lib/cycle-b.mjs";`,
  ],
  ["scripts/impacted-specs-by-import.mjs", `import { norm } from "./lib/spec-path.mjs";`],
  ["scripts/lib/spec-path.mjs", "export const norm = (s) => s;"],
  ["scripts/lib/only-a-test-imports-me.mjs", "export const x = 1;"],
  ["scripts/orphan-helper.test.mjs", `import { x } from "./lib/only-a-test-imports-me.mjs";`],
  // A cycle AMONG THE IMPORTERS of the start file, which is the only shape that
  // actually loops: `leaf` is imported by `ring-a`, and `ring-a` ↔ `ring-b` import
  // each other, so neither the cycle nor the walk passes back through `leaf` and the
  // `importer === file` skip cannot break it. A first draft put the start file inside
  // the cycle, where that skip terminates the walk on its own — so the test passed
  // with the `seen` set deleted, pinning the guard it was named for not at all.
  ["scripts/lib/leaf.mjs", "export const leaf = 1;"],
  ["scripts/lib/ring-a.mjs", `import { leaf } from "./leaf.mjs";\nimport { b } from "./ring-b.mjs";`],
  ["scripts/lib/ring-b.mjs", `import { a } from "./ring-a.mjs";`],
  ["scripts/partition-shards-ring.mjs", `import { a } from "./lib/ring-a.mjs";`],
]);
const importRefs = buildCiReferences({ ...FIXTURE, scriptFiles: SCRIPT_FILES });
const classifyWithImports = (...changed) => classifyCiChange({ changed, refs: importRefs });

// ── Reference graph ─────────────────────────────────────────────────────────

test("a workflow reaches a script THROUGH the action it uses", () => {
  // The indirection #1045 shipped: `wait-for-backend.mjs` is named nowhere in
  // pr-validation.yml, only inside the action. A direct-refs-only graph would
  // have classified that change as `none` and skipped the lane again.
  assert.ok(refs.workflowScripts.get(PR_LANE).has("scripts/wait-for-backend.mjs"));
  assert.ok(refs.workflowScripts.get(PR_LANE).has("scripts/impacted-specs-by-import.mjs"));
  assert.ok(!refs.workflowScripts.get(PR_LANE).has("scripts/partition-shards.mjs"));
});

// ── canary ──────────────────────────────────────────────────────────────────

test("a change to the PR lane's own workflow runs the canary", () => {
  const r = classify(PR_LANE);
  assert.equal(r.verdict, "canary");
  assert.deepEqual(r.canarySpecs, CANARY_SPECS);
});

test("a change to an action the PR lane uses runs the canary", () => {
  const r = classify(".github/actions/wait-for-backend/action.yml");
  assert.equal(r.verdict, "canary");
  assert.match(r.reasons.join(" "), /used by the PR lane/);
});

test("a change to a script the PR lane reaches through an action runs the canary", () => {
  const r = classify("scripts/wait-for-backend.mjs");
  assert.equal(r.verdict, "canary");
});

test("canary wins over dispatch, and the dispatch advice survives", () => {
  // The #1045 diff exactly: an action this lane uses PLUS another lane's workflow.
  const r = classify(".github/actions/wait-for-backend/action.yml", ".github/workflows/daily-stable.yml");
  assert.equal(r.verdict, "canary");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
});

// ── dispatch ────────────────────────────────────────────────────────────────

test("another lane's workflow yields dispatch naming that workflow", () => {
  const r = classify(".github/workflows/daily-stable.yml");
  assert.equal(r.verdict, "dispatch");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
  assert.deepEqual(r.canarySpecs, [], "a canary here would imply coverage it cannot give");
});

test("an action only another lane uses yields dispatch naming its users", () => {
  const r = classify(".github/actions/auto-remove-stable/action.yml");
  assert.equal(r.verdict, "dispatch");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
});

test("a script only another lane runs yields dispatch, not a canary", () => {
  const r = classify("scripts/partition-shards.mjs");
  assert.equal(r.verdict, "dispatch");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
});

test("an action no workflow references is reported rather than passed over", () => {
  const r = classify(".github/actions/orphan/action.yml");
  assert.match(r.reasons.join(" "), /referenced by NO workflow/);
  assert.deepEqual(r.ciFiles, [".github/actions/orphan/action.yml"]);
});

// ── none ────────────────────────────────────────────────────────────────────

test("a non-CI diff is silent — no verdict, no noise", () => {
  const r = classify("docs/foo.md", "ROADMAP.md", "tests/helpers/ui/click.ts");
  assert.equal(r.verdict, "none");
  assert.deepEqual(r.ciFiles, []);
  assert.deepEqual(r.reasons, []);
});

test("a script no workflow runs is not CI surface", () => {
  // Test files and unreferenced helpers under scripts/ are covered by the unit
  // lanes; treating them as CI surface would boot a Langflow for nothing.
  const r = classify("scripts/wait-for-backend.test.mjs", "scripts/some-local-helper.mjs");
  assert.equal(r.verdict, "none");
  assert.deepEqual(r.ciFiles, []);
});

// ── A script in a subdirectory (#1979) ──────────────────────────────────────

test("a subdirectory path is captured whole, not truncated at the first slash", () => {
  // `SCRIPT_REF` excluded `/` from the tail, so `scripts/lib/stable-tests.ts` was
  // captured as `scripts/lib` — a token no changed path can equal — and the file
  // matched nothing. Asserted on the GRAPH, since that is where the loss happened.
  const r = buildCiReferences({
    workflows: new Map([[PR_LANE, "steps:\n  - run: node scripts/lib/deep/thing.mjs"]]),
    actions: new Map(),
  });
  assert.ok(r.workflowScripts.get(PR_LANE).has("scripts/lib/deep/thing.mjs"));
  assert.ok(!r.workflowScripts.get(PR_LANE).has("scripts/lib"), "the directory token is not a file");
});

test("a module reached only by IMPORT is CI surface, and the route is named", () => {
  // The bigger half of #1979 and the one the regex cannot fix: measured on this repo,
  // of the 24 `scripts/lib/**` files it reaches, 5 are spelled under `.github/` and
  // the other 19 only through an import.
  const r = classifyWithImports("scripts/lib/spec-path.mjs");
  assert.equal(r.verdict, "canary", "the PR lane imports it through impacted-specs-by-import");
  assert.deepEqual(r.ciFiles, ["scripts/lib/spec-path.mjs"]);
  assert.match(r.reasons.join(" "), /reached through scripts\/impacted-specs-by-import\.mjs/);
});

test("the same module without the import graph falls back to silence", () => {
  // Back-compat, and the measurement that justifies the graph: with `scriptFiles`
  // absent the verdict is exactly what `main` gives today.
  assert.equal(classify("scripts/lib/spec-path.mjs").verdict, "none");
});

test("both routes count — a file named AND imported names every workflow it reaches", () => {
  // `scripts/lib/stable-tests.ts` is both: named by `update-coverage-summary.yml`'s
  // `paths:` filter and imported by `scripts/stable-tests.ts`, which two other lanes
  // run. Preferring the direct route named one workflow and dropped the rest.
  const files = new Map([
    ["scripts/partition-shards.mjs", `import { t } from "./lib/shared.ts";`],
    ["scripts/lib/shared.ts", "export const t = 1;"],
  ]);
  const r = classifyCiChange({
    changed: ["scripts/lib/shared.ts"],
    refs: buildCiReferences({
      workflows: new Map([
        [".github/workflows/daily-stable.yml", "on:\n  workflow_dispatch:\nsteps:\n  - run: node scripts/partition-shards.mjs"],
        [".github/workflows/other.yml", "on:\n  workflow_dispatch:\nsteps:\n  - run: cat scripts/lib/shared.ts"],
      ]),
      actions: new Map(),
      scriptFiles: files,
    }),
  });
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml", ".github/workflows/other.yml"]);
});

test("a unit test is never CI wiring, even when a workflow names it", () => {
  // Two are named under `.github/` today, in prose explaining what pins what, and on
  // `main` a change to either resolves to `dispatch` — contradicting this script's own
  // rule. Inert while imports were not followed; not any more, since such a file would
  // drag its whole import closure in with it.
  const r = buildCiReferences({
    workflows: new Map([
      [".github/workflows/daily-stable.yml", "on:\n  workflow_dispatch:\n# Pinned by scripts/gate.test.mjs"],
    ]),
    actions: new Map(),
    scriptFiles: new Map([
      ["scripts/gate.test.mjs", `import { x } from "./lib/only-for-the-test.mjs";`],
      ["scripts/lib/only-for-the-test.mjs", "export const x = 1;"],
    ]),
  });
  assert.equal(classifyCiChange({ changed: ["scripts/gate.test.mjs"], refs: r }).verdict, "none");
  assert.equal(
    classifyCiChange({ changed: ["scripts/lib/only-for-the-test.mjs"], refs: r }).verdict,
    "none",
    "and it must not drag its imports in either",
  );
});

test("the walk's budget is a NODE count — one shared module with many leaves is not a cycle", () => {
  // The shape that broke the first bound, and the commonest thing a consolidation
  // refactor produces: one module, N importers that nothing imports. `buildImporterGraph`
  // returns module → importers, so its `.size` counts only modules that ARE imported
  // (1 here) while the queue holds importers (2) — neither population bounds the other,
  // and on this repo they are 71 against 115. Bounded on `.size`, this healthy ACYCLIC
  // graph threw "the cycle guard is broken", which in the lane is a red, unmergeable PR
  // whose only diagnostic names the wrong cause.
  const files = new Map([
    ["scripts/lib/shared.mjs", "export const shared = 1;"],
    ["scripts/leaf-one.mjs", `import { shared } from "./lib/shared.mjs";`],
    ["scripts/leaf-two.mjs", `import { shared } from "./lib/shared.mjs";`],
  ]);
  const r = buildCiReferences({
    workflows: new Map([
      [PR_LANE, "on:\n  pull_request:\nsteps:\n  - run: node scripts/leaf-one.mjs"],
    ]),
    actions: new Map(),
    scriptFiles: files,
  });
  assert.ok(
    r.scriptImporters.size < files.size,
    "the premise: fewer imported MODULES than files, which is what made `.size` unsound",
  );
  assert.deepEqual(
    [...importersOf(r, "scripts/lib/shared.mjs")].sort(),
    ["scripts/leaf-one.mjs", "scripts/leaf-two.mjs"],
  );
  assert.equal(classifyCiChange({ changed: ["scripts/lib/shared.mjs"], refs: r }).verdict, "canary");
});

test("a module only a test imports stays silent — and the graph DID see the importer", () => {
  // Asserting the two verdicts alone pins nothing: both are `none` before this change
  // and after, so the test passed under every mutation including deleting the
  // `.filter(named)` it exists for. What makes it a test is the premise — the importer
  // graph found the test file and the `named` predicate is what rejected it.
  assert.deepEqual(
    [...importersOf(importRefs, "scripts/lib/only-a-test-imports-me.mjs")],
    ["scripts/orphan-helper.test.mjs"],
    "the graph must SEE the importer; the verdict then turns on it not being wiring",
  );
  assert.equal(classifyWithImports("scripts/lib/only-a-test-imports-me.mjs").verdict, "none");
  assert.equal(classifyWithImports("scripts/orphan-helper.test.mjs").verdict, "none");
});

test("a cycle AMONG THE IMPORTERS terminates, and the file is not its own importer", () => {
  // Defensive rather than observed: the real `scripts/` graph has no cycle today
  // (measured over all 182 source files — an unguarded walk terminates for every
  // one), so this pins a guard against a shape the repo does not currently have.
  // Which makes the fixture the whole test: the cycle must NOT pass through the start
  // file, because there `importer === file` already breaks the walk and the `seen`
  // set is never exercised.
  //
  // Deleting the guard used to WEDGE this file rather than redden it — the lane passes
  // no `--test-timeout`, so it reported `0 pass / 0 fail` and burned the step's budget,
  // and `node:test`'s own `timeout` option cannot preempt a synchronous loop (measured:
  // it does not fire). Hence the hard bound inside `importersOf`, which turns the same
  // deletion into a thrown error here and a failed step in CI.
  assert.deepEqual(
    [...importersOf(importRefs, "scripts/lib/leaf.mjs")].sort(),
    ["scripts/lib/ring-a.mjs", "scripts/lib/ring-b.mjs", "scripts/partition-shards-ring.mjs"],
  );
  assert.ok(
    !importersOf(importRefs, "scripts/lib/ring-a.mjs").has("scripts/lib/ring-a.mjs"),
    "a file must not be reported as its own importer",
  );
});

test("against the live repo, the path #1609's own table names is no longer silence", () => {
  // The measurement that opened #1979: `verdict: none` — "the diff touches no CI
  // surface at all" — for a file `update-coverage-summary.yml` lists in its `paths:`.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: "scripts/lib/stable-tests.ts\n" },
  );
  const result = JSON.parse(out);
  assert.notEqual(result.verdict, "none", "silence is the failure this issue is about");
  assert.deepEqual(result.ciFiles, ["scripts/lib/stable-tests.ts"]);
});

test("the base tree is not searched for scripts/, so no PR gets a false warning", () => {
  // The lane builds the default-branch tree with `git archive … .github/workflows`, so
  // it has no `scripts/` by construction. Reading it there printed
  // "could not read scripts/ … will resolve to 'none'" on EVERY run whose diff touches
  // `.github/` or `scripts/` — which is every run this classifier exists for — and the
  // verdict printed immediately after was routinely reached through the import graph,
  // so the annotation stated the opposite of what happened. Only `.workflows` is taken
  // from that read at all.
  const base = makeTempDir("cc-basetree-");
  fs.mkdirSync(path.join(base, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(base, ".github/workflows/daily-stable.yml"), "on:\n  workflow_dispatch:\njobs: {}\n");
  const r = cli(
    ["--root", REPO_ROOT, "--format=json", `--base-root=${base}`, "--stdin"],
    "scripts/lib/spec-path.mjs\n",
  );
  assert.equal(r.status, 0);
  assert.notEqual(r.json.verdict, "none", "the import graph still answers");
  assert.doesNotMatch(r.stderr, /could not read scripts\//, `false warning: ${r.stderr}`);
});

test("an unreadable scripts/ degrades OUT LOUD and keeps the direct half working", () => {
  // Best-effort like the other two optional inputs, and for the same reason: an empty
  // file map builds an empty graph, which resolves every indirect change to `none` —
  // the silence this issue is about, reported as a clean verdict (#1012).
  const tmp = makeTempDir("cc-noscripts-");
  fs.mkdirSync(path.join(tmp, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, ".github/workflows/daily-stable.yml"),
    "on:\n  workflow_dispatch:\nsteps:\n  - run: node scripts/partition-shards.mjs",
  );
  const r = cli(["--root", tmp, "--format=json", "--stdin"], "scripts/partition-shards.mjs\n");
  assert.equal(r.status, 0);
  assert.equal(r.json.verdict, "dispatch", "the directly-named half must survive");
  assert.match(r.stderr, /::warning::.*could not read scripts\/.*resolve to 'none'/);
});

test("against the live repo, a module reached ONLY by import is not silence", () => {
  // The assertion #1979 asked for by name, and the one the synthetic tests cannot
  // give: "the failure here is precisely that a synthetic fixture would have used
  // whatever spelling the test author had in mind (#1226)". Measured — making
  // `readScriptFiles`' walk non-recursive reverts all 19 import-only lib modules to
  // `none`, i.e. undoes the headline fix, and every synthetic test stays green.
  //
  // `spec-path.mjs` is the case worth naming: it is the one normaliser
  // `report-backend-outages.mjs` and `remove-stable-from-failures.ts` must agree on,
  // and its own entry says a near-miss there "corroborates nothing, exempts nothing
  // and is invisible". It is spelled in no workflow at all.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: "scripts/lib/spec-path.mjs\n" },
  );
  const result = JSON.parse(out);
  assert.notEqual(result.verdict, "none");
  assert.deepEqual(result.ciFiles, ["scripts/lib/spec-path.mjs"]);
  assert.match(result.reasons.join(" "), /reached through /, "the indirection must be named, not implied");
  // The premise, asserted over EVERY workflow rather than the one the verdict happens
  // to name first: the result names daily-stable AND weekly-stable, so checking one of
  // them established a fraction of the claim it was written to establish.
  // Actions too, not just workflows: `workflowScripts` folds an action's own `scripts/`
  // references into every workflow that `uses:` it, so a path spelled only in an action
  // is still "named" and the premise would be false by a route this never looked down.
  const ciText = [];
  const collect = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collect(p);
      else if (/\.ya?ml$/.test(e.name)) ciText.push([path.relative(REPO_ROOT, p), fs.readFileSync(p, "utf8")]);
    }
  };
  collect(path.join(REPO_ROOT, ".github"));
  const spellsIt = ciText.filter(([, text]) => text.includes("lib/spec-path")).map(([f]) => f);
  assert.deepEqual(spellsIt, [], "the premise: nothing under .github/ spells this path — only the import graph reaches it");
});

test("a canary RENDERS its dispatch targets, and does not claim the run proved them", () => {
  // Fixing the verdict's data was only half of it: `dispatchAdvice` early-returned on
  // anything but `dispatch`, and the lane printed `.advice` only in the `dispatch`
  // case — so `scripts/reconcile-stable-orphans.ts`, which used to produce "Dispatch
  // stable-orphan-reconcile.yml", produced `advice: null` once it became
  // canary-reachable. A strict loss against the behaviour before any of this.
  const r = classifyWithImports("scripts/wait-for-backend.mjs", "scripts/partition-shards.mjs");
  assert.equal(r.verdict, "canary");
  const { annotation, summaryLines } = dispatchAdvice(r);
  assert.match(annotation, /Dispatch \.github\/workflows\/daily-stable\.yml on this branch/);
  assert.match(annotation, /The canary proves THIS lane boots/);
  assert.doesNotMatch(
    annotation,
    /nothing here proves it works|Nothing in CI can prove/,
    "something in CI demonstrably ran — only the OTHER lanes went unexercised",
  );
  assert.match(summaryLines.join("\n"), /the diff also reaches a lane the canary cannot exercise/);
});

test("a canary with no other lane involved says nothing extra", () => {
  const r = classify(PR_LANE);
  assert.equal(r.verdict, "canary");
  assert.deepEqual(r.dispatchWorkflows, []);
  assert.equal(dispatchAdvice(r).annotation, null);
});

test("a shared ACTION names every other lane that uses it", () => {
  // The #1045 diff, which is what this whole classifier was built for: one action,
  // four lanes. The canary branch dropped all of them, so the verdict for the very
  // change it exists to cover named none of the lanes it changed — while the commit
  // that fixed the script branch justified itself as "the rule this file already
  // states for workflows AND actions".
  const r = classify(".github/actions/wait-for-backend/action.yml");
  assert.equal(r.verdict, "canary");
  assert.deepEqual(r.dispatchWorkflows, [".github/workflows/daily-stable.yml"]);
  assert.match(r.reasons.join(" "), /used by the PR lane, and by \.github\/workflows\/daily-stable\.yml/);
});

test("against the live repo, 'directly' is claimed of the PR LANE alone", () => {
  // The DISCRIMINATING input, which the synthetic cases are not: a file another lane
  // names by hand and the PR lane reaches only by import. `pr-validation.yml` never
  // mentions `reconcile-stable-orphans.ts`; `stable-orphan-reconcile.yml` runs it.
  // With the predicate as `named(file)` — "does SOME workflow spell it" — the reason
  // claimed the PR lane ran it directly, and the whole file stayed green.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: "scripts/reconcile-stable-orphans.ts\n" },
  );
  const reason = JSON.parse(out).reasons.join(" ");
  assert.match(reason, /is run by the PR lane \(also reached through /);
  assert.doesNotMatch(reason, /PR lane directly/, "pr-validation.yml does not name this file");
});

test("against the live repo, no WORKFLOW LIST is ever qualified as 'directly'", () => {
  // Two attempts at this clause, two over-claims. `named(file)` asked whether SOME
  // workflow spells the file and attached the word to ALL of them
  // (`report-backend-outages.mjs`: "run directly by daily-stable, weekly-stable",
  // where weekly-stable reaches it only by import). `users.every(…)` closed that half
  // and left the other: `workflowScripts` is a raw token scan over the YAML PLUS the
  // actions it uses, so "directly" was still false for 8 live files — five reached
  // only through an action, three whose sole occurrence of the token is a `#` comment.
  // `served-version.mjs` was one of them, and the assertion certifying the previous
  // fix pinned that false statement.
  //
  // So the clause is gone: this sentence lists WORKFLOWS, and a per-workflow route
  // needs a per-workflow sentence.
  const reasonFor = (file) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
        { input: `${file}\n` },
      ),
    ).reasons.join(" ");
  for (const file of [
    "scripts/report-backend-outages.mjs",
    "scripts/lib/served-version.mjs",
    "scripts/auto-remove-commit-paths.mjs",
    "scripts/build-grep-filter.mjs",
  ]) {
    assert.doesNotMatch(reasonFor(file), /run directly by/, `over-claims "directly" for ${file}`);
  }
  // The route is still named, and as ONE of the ways in rather than the only one.
  assert.match(reasonFor("scripts/lib/served-version.mjs"), /also reached through scripts\/resolve-served-version\.mjs/);
});

test("'directly' is claimed of the PR LANE, not of any workflow at all", () => {
  // The predicate was `named(file)` — "does ANY workflow spell it" — under a sentence
  // about the PR lane. Live case: `pr-validation.yml` does not mention
  // `reconcile-stable-orphans.ts` anywhere, and the reason said it ran it directly.
  const r = classifyWithImports("scripts/lib/spec-path.mjs");
  const reason = r.reasons.join(" ");
  assert.match(reason, /is run by the PR lane \(also reached through /);
  assert.doesNotMatch(reason, /PR lane directly/, "no workflow spells this path at all");
  // …and a file the PR lane really does invoke by name keeps the clause.
  assert.match(
    classifyWithImports("scripts/impacted-specs-by-import.mjs").reasons.join(" "),
    /is run by the PR lane directly or through an action it uses/,
  );
});

test("an EMPTY scripts/ warns as loudly as an unreadable one", () => {
  // The floor returned `null` and said nothing, which is indistinguishable downstream
  // from having no graph — so the reader saw `none` and no reason for it.
  const tmp = makeTempDir("cc-emptyscripts-");
  fs.mkdirSync(path.join(tmp, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "scripts/lib"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "scripts/lib/data.json"), "{}");
  fs.writeFileSync(
    path.join(tmp, ".github/workflows/daily-stable.yml"),
    "on:\n  workflow_dispatch:\nsteps:\n  - run: node scripts/lib/data.json",
  );
  const r = cli(["--root", tmp, "--format=json", "--stdin"], "scripts/lib/data.json\n");
  assert.equal(r.status, 0);
  assert.match(r.stderr, /could not read scripts\/ \(it holds no source files\)/);
});

test("against the live repo, the canary does not swallow the dispatch advice", () => {
  // A file can be both, and `scripts/reconcile-stable-orphans.ts` is: the PR lane
  // reaches it through `check-stable-ownership.ts`, and `stable-orphan-reconcile.yml`
  // runs it by name. Preferring the canary dropped that instruction entirely —
  // `advice: null`, `dispatchWorkflows: []` — which is the top-level rule this file
  // already states ("canary wins over dispatch, and the dispatch advice SURVIVES")
  // not being applied one level in.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: "scripts/reconcile-stable-orphans.ts\n" },
  );
  const result = JSON.parse(out);
  assert.equal(result.verdict, "canary");
  assert.ok(
    result.dispatchWorkflows.includes(".github/workflows/stable-orphan-reconcile.yml"),
    `the dispatch advice vanished: ${JSON.stringify(result.dispatchWorkflows)}`,
  );
  assert.ok(!result.dispatchWorkflows.includes(PR_LANE), "the PR lane is not a workflow to dispatch — it just ran");
});

test("against the live repo, a unit test named in a workflow comment is still silence", () => {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: "scripts/daily-matrix-provider-keys.test.mjs\n" },
  );
  assert.equal(JSON.parse(out).verdict, "none");
});

// ── Reading a workflow's triggers (#1609) ───────────────────────────────────

const triggers = (text) => readWorkflowTriggers(text).events;

test("the block form yields the event keys, not their detail", () => {
  assert.deepEqual(
    triggers(`name: x
on:
  push:
    branches: [main]
    paths:
      - "scripts/**"
  workflow_dispatch:
    inputs:
      ref:
        required: false

jobs:
  build:
    steps:
      - run: echo on:`),
    ["push", "workflow_dispatch"],
    "`branches:`/`inputs:` are detail, and `jobs:` is out of the block entirely",
  );
});

test("the flow-list and scalar forms are read too", () => {
  assert.deepEqual(triggers("on: [push, workflow_dispatch]"), ["push", "workflow_dispatch"]);
  assert.deepEqual(triggers("on: workflow_dispatch"), ["workflow_dispatch"]);
  assert.deepEqual(triggers('"on": [push]'), ["push"]);
  assert.deepEqual(triggers("on:\n  - push\n  - workflow_dispatch"), ["push", "workflow_dispatch"]);
  assert.deepEqual(triggers("on: [\n  push,\n  workflow_dispatch,\n]"), ["push", "workflow_dispatch"]);
  // A block's items may sit at the PARENT's indentation, so this is the same shape
  // at column 0 — legal YAML, and rejected by the first draft, which stopped at the
  // first width-0 line as if it were the next top-level key.
  assert.deepEqual(triggers("on:\n- push\n- workflow_dispatch\n\njobs:\n  x: {}"), ["push", "workflow_dispatch"]);
  // Quoted event names in a block, which Actions accepts and a strict key regex
  // reported as unreadable.
  assert.deepEqual(triggers('on:\n  "workflow_dispatch":\n  push:'), ["workflow_dispatch", "push"]);
  // A sequence at its KEY's own indentation is that key's value, not a sibling
  // event — the colon is what tells the two `-` shapes apart.
  assert.deepEqual(triggers('on:\n  schedule:\n  - cron: "0 5 * * *"\n  workflow_dispatch:'), [
    "schedule",
    "workflow_dispatch",
  ]);
});

test("a commented-out trigger is not a trigger, and a comment naming one is not either", () => {
  // Both shapes are live in this repo, and a grep for the token gets both wrong in
  // opposite directions: `nightly.yml` has its `schedule:` commented out, and
  // `issue-contract-guard.yml`'s `on:` block explains `workflow_dispatch` in prose
  // eleven lines before declaring it.
  assert.deepEqual(
    triggers(`on:
  # schedule:
  #   - cron: "0 3 * * *"
  workflow_dispatch:`),
    ["workflow_dispatch"],
  );
  assert.deepEqual(
    triggers(`on:
  # NOTE: a workflow_dispatch workflow must exist on the default branch first.
  push:
    branches: [main]`),
    ["push"],
    "a comment mentioning the token must not read as a declared trigger",
  );
});

test("triggers that cannot be read are UNKNOWN, with the reason attached", () => {
  for (const text of ["jobs:\n  build:\n    steps: []", "on:\n", "on: [unterminated"]) {
    const read = readWorkflowTriggers(text);
    assert.equal(read.events, null);
    assert.ok(read.note && read.note.length > 0, `no reason recorded for: ${JSON.stringify(text)}`);
  }
});

test("dispatchability has three states, and the unreadable one is not 'probably yes'", () => {
  assert.equal(workflowDispatchability("on: [push, workflow_dispatch]").dispatchable, true);
  assert.equal(workflowDispatchability("on:\n  push:\n    branches: [main]").dispatchable, false);
  assert.equal(workflowDispatchability("jobs: {}").dispatchable, null);
  // The triggers travel with the verdict: the honest message names what it DOES run on.
  assert.deepEqual(workflowDispatchability("on:\n  push:\n    branches: [main]").triggers, ["push"]);
});

// ── The advice a reviewer reads (#1609) ─────────────────────────────────────

const adviceFor = (...changed) => dispatchAdvice(classify(...changed));

test("a dispatchable workflow still gets the imperative it always got", () => {
  const { annotation, summaryLines } = adviceFor("scripts/partition-shards.mjs");
  assert.match(annotation, /Dispatch \.github\/workflows\/daily-stable\.yml on this branch before merging/);
  assert.match(summaryLines.join("\n"), /Dispatch before merging:/);
});

test("a workflow with no workflow_dispatch is never told to be dispatched", () => {
  // The issue's own acceptance criterion, asserted on the OUTPUT rather than on a
  // grep of the YAML (#1226): PR #1608 was told to dispatch a workflow that is
  // `on: push: [main]`, and following that instruction returns HTTP 422.
  const { annotation, summaryLines } = adviceFor("scripts/coverage-summary.ts");
  assert.doesNotMatch(annotation, /Dispatch/, `still prescribes a dispatch: ${annotation}`);
  assert.doesNotMatch(summaryLines.join("\n"), /Dispatch before merging/);
  assert.match(annotation, /cannot be dispatched on a branch/);
  assert.match(annotation, /no workflow_dispatch trigger \(runs on: push\)/);
  // …and it must say what IS true, not merely withhold the false instruction.
  assert.match(annotation, /Nothing in CI can prove this change before merge/);
});

test("a mixed diff dispatches what it can and is honest about the rest", () => {
  // Not hypothetical: `scripts/stable-tests.ts` is run by daily-stable, which is
  // dispatchable, AND by update-coverage-summary, which has no trigger (and by
  // weekly-stable, which carries the trigger but is disabled, so it 422s too).
  // Flipping the whole message on the worst member would withhold the one dispatch
  // that does work; leaving it alone loses the correction.
  const { annotation } = adviceFor("scripts/partition-shards.mjs", "scripts/coverage-summary.ts");
  assert.match(annotation, /Dispatch \.github\/workflows\/daily-stable\.yml on this branch/);
  assert.match(annotation, /update-coverage-summary\.yml cannot be dispatched on a branch/);
  // Asserted on the IMPERATIVE SENTENCE, not with a regex spanning the whole
  // annotation. A first draft used `/Dispatch [^.]*update-coverage-summary/`, which
  // can never match anything this renders — every workflow name starts with `.`, so
  // `[^.]*` cannot reach one — and a mutation emitting a `Dispatch` sentence per
  // target, undispatchable ones included, passed it.
  const imperative = annotation.split(". ").filter((s) => s.startsWith("Dispatch "));
  assert.equal(imperative.length, 1, `expected exactly one imperative, got: ${annotation}`);
  assert.doesNotMatch(imperative[0], /update-coverage-summary/);
});

test("a workflow whose triggers are unreadable is reported as unknown, not as either answer", () => {
  const { annotation, summaryLines } = adviceFor("scripts/opaque-only.mjs");
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.doesNotMatch(annotation, /cannot be dispatched/);
  assert.match(annotation, /Could not read the triggers of \.github\/workflows\/opaque\.yml/);
  assert.match(annotation, /no top-level `on:` key/, "the reason must travel with the verdict");
  assert.match(summaryLines.join("\n"), /trigger list unreadable/);
  // A doubt must not be folded into the undispatchable answer's CONCLUSION either.
  // "Nothing in CI can prove this" is a claim the unknown bucket has not earned, and
  // the header promises exactly that it is never folded into either answer (#1012).
  assert.doesNotMatch(annotation, /Nothing in CI can prove this change before merge/);
});

test("a verdict that predates the check degrades to unknown rather than to the old imperative", () => {
  // `render-impacted-summary.mjs` is handed the classifier's JSON from a file. A
  // payload without `dispatchTargets` is a payload nothing confirmed, so it must
  // not resurrect the instruction this issue removed.
  const { annotation } = dispatchAdvice({
    verdict: "dispatch",
    ciFiles: ["scripts/x.mjs"],
    dispatchWorkflows: [".github/workflows/daily-stable.yml"],
  });
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.match(annotation, /Could not read the triggers/);
});

test("no advice where there is nothing to dispatch — but a canary WITH targets speaks", () => {
  // The title used to read "no advice at all on the verdicts that are not `dispatch`",
  // which passed only because its one canary case has zero dispatch targets — and
  // stated as the pinned contract exactly the behaviour this branch reversed.
  for (const r of [classify(PR_LANE), classify("docs/foo.md"), null]) {
    const { annotation, summaryLines } = dispatchAdvice(r);
    assert.equal(annotation, null);
    assert.deepEqual(summaryLines, []);
  }
  const canaryWithTargets = classify(".github/actions/wait-for-backend/action.yml");
  assert.equal(canaryWithTargets.verdict, "canary");
  assert.match(dispatchAdvice(canaryWithTargets).annotation, /Dispatch \.github\/workflows\/daily-stable\.yml/);
});

// ── The other way to 422: disabled in Actions (#1609) ───────────────────────

test("workflow states are read from the Actions API's own TSV, junk rows ignored", () => {
  const states = parseWorkflowStates(
    [
      ".github/workflows/daily-stable.yml\tactive",
      ".github/workflows/weekly-stable.yml\tdisabled_manually",
      ".github/workflows/x.yml\tdisabled_inactivity",
      // The API also returns app-provided entries, which are not workflow paths.
      "dynamic/agents/copilot-pull-request-reviewer\tactive",
      "",
      "no-tab-here",
    ].join("\n"),
  );
  assert.equal(states.get(".github/workflows/daily-stable.yml"), true);
  assert.equal(states.get(".github/workflows/weekly-stable.yml"), false);
  assert.equal(states.get(".github/workflows/x.yml"), false, "only `active` can be dispatched");
  assert.equal(states.get("no-tab-here"), undefined);
});

test("a workflow disabled in Actions is not told to be dispatched, however good its YAML", () => {
  // `weekly-stable.yml` really is `disabled_manually` and really is named by this
  // verdict (it runs `scripts/stable-tests.ts`), so a YAML-only answer would have
  // closed #1609 while still prescribing a 422 by the other route.
  const states = new Map([[".github/workflows/daily-stable.yml", false]]);
  const r = classifyCiChange({ changed: ["scripts/partition-shards.mjs"], refs, states });
  const { annotation, summaryLines } = dispatchAdvice(r);
  assert.equal(r.dispatchTargets[0].dispatchable, true, "the trigger is there…");
  assert.equal(r.dispatchTargets[0].enabled, false, "…and the workflow is off");
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.match(annotation, /is DISABLED in Actions, so dispatching it answers 422/);
  assert.match(annotation, /Nothing in CI can prove this change before merge/);
  assert.match(summaryLines.join("\n"), /is disabled in Actions/);
});

test("an unfetched state list falls back to the trigger rather than caveating everything", () => {
  // The one place this deliberately fails OPEN: a workflow carrying the trigger is
  // dispatchable unless someone disabled it, and caveating every instruction over a
  // lookup that usually succeeds is the noise that gets warnings ignored (#1252).
  const r = classifyCiChange({ changed: ["scripts/partition-shards.mjs"], refs, states: null });
  assert.equal(r.dispatchTargets[0].enabled, null, "unknown, not assumed on");
  assert.match(dispatchAdvice(r).annotation, /Dispatch \.github\/workflows\/daily-stable\.yml/);
});

const cli = (args, input) => {
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), ...args], {
    input,
    encoding: "utf8",
  });
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
};

test("the CLI actually applies a state file — the flag is not decoration", () => {
  // The whole "disabled in Actions" half reaches the reader through this one
  // argument, and nothing exercised it end to end: `states: null` in the classify
  // call, and an off-by-one in the flag's `slice`, both survived the entire suite.
  const tmp = makeTempDir("cc-states-");
  const file = path.join(tmp, "wf-states.tsv");
  fs.writeFileSync(file, ".github/workflows/daily-stable.yml\tdisabled_manually\n");
  try {
    const { json } = cli(["--root", REPO_ROOT, "--format=json", `--workflow-states=${file}`, "--stdin"], "scripts/partition-shards.mjs\n");
    assert.equal(json.verdict, "dispatch");
    assert.match(json.advice, /daily-stable\.yml is DISABLED in Actions/);
    assert.doesNotMatch(json.advice, /Dispatch \.github\/workflows\/daily-stable/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a state file that cannot be read warns and still produces a verdict", () => {
  // Best-effort: losing the state lookup must not fail the lane, and must not be
  // silent either (#1012) — the warning is asserted, because deleting it left every
  // test green.
  const r = cli(
    ["--root", REPO_ROOT, "--format=json", "--workflow-states=/nonexistent/wf-states.tsv", "--stdin"],
    "scripts/partition-shards.mjs\n",
  );
  assert.equal(r.status, 0);
  assert.equal(r.json.verdict, "dispatch");
  assert.match(r.stderr, /::warning::.*could not read \/nonexistent\/wf-states\.tsv/);
});

test("the CLI reads the triggers from the BASE tree, not from this branch", () => {
  // GitHub resolves `workflow_dispatch` from the default branch, so a PR that ADDS
  // the trigger — #1609's own Option B — must not be told to dispatch a workflow it
  // is only now making dispatchable.
  //
  // The fixture is deliberately the MIRROR of the real tree: `main`'s
  // `update-coverage-summary.yml` has no `workflow_dispatch`, so a base copy that
  // HAS one can only produce `dispatchable: true` by being the copy that was read.
  // A base fixture matching the head would agree with the bug and pin nothing —
  // measured: with both copies triggerless, deleting the base preference left this
  // green.
  const tmp = makeTempDir("cc-base-");
  const dir = path.join(tmp, ".github/workflows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "update-coverage-summary.yml"),
    "on:\n  workflow_dispatch:\n  push:\n    branches: [main]\njobs: {}\n",
  );
  const { json } = cli(
    ["--root", REPO_ROOT, "--format=json", `--base-root=${tmp}`, "--stdin"],
    "scripts/coverage-summary.ts\n",
  );
  assert.equal(json.verdict, "dispatch");
  const target = json.dispatchTargets.find((t) => t.workflow.endsWith("update-coverage-summary.yml"));
  assert.equal(target.dispatchable, true, "the head copy, which has no trigger, must not be the one read");
  assert.deepEqual(target.triggers, ["workflow_dispatch", "push"]);
  assert.equal(target.onDefaultBranch, true);
});

test("a workflow the PR ADDS is reported as absent from the default branch, not dispatched", () => {
  // `gh workflow run` answers 404 for a workflow that is not on the default branch,
  // and the base tree is how this knows. In-memory, because what is under test is
  // the CLASSIFICATION — the on-disk `--base-root` path has its own CLI test above.
  const refsWithNewLane = buildCiReferences({
    workflows: new Map([
      [PR_LANE, FIXTURE.workflows.get(PR_LANE)],
      [".github/workflows/new-lane.yml", "on:\n  workflow_dispatch:\n\nsteps:\n  - run: node scripts/partition-shards.mjs"],
    ]),
    actions: FIXTURE.actions,
    baseWorkflows: new Map([[PR_LANE, FIXTURE.workflows.get(PR_LANE)]]),
  });
  const r = classifyCiChange({ changed: [".github/workflows/new-lane.yml"], refs: refsWithNewLane });
  assert.equal(r.dispatchTargets[0].onDefaultBranch, false);
  const { annotation } = dispatchAdvice(r);
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.match(annotation, /does not exist on the default branch yet/);
  assert.match(annotation, /answers 404 until this merges/);
});

test("a flag given no value degrades OUT LOUD, never silently", () => {
  // `""` is falsy, so a bare `--base-root=` used to switch the whole default-branch
  // read off without a word — the one direction this script's header forbids.
  const r = cli(
    ["--root", REPO_ROOT, "--format=json", "--base-root=", "--workflow-states=", "--stdin"],
    "scripts/coverage-summary.ts\n",
  );
  assert.equal(r.status, 0, "an empty value degrades; it is not a usage error");
  assert.equal(r.json.verdict, "dispatch");
  assert.match(r.stderr, /--base-root= was given no value/);
  assert.match(r.stderr, /--workflow-states= was given no value/);
});

test("a base tree that cannot be read warns and still produces a verdict", () => {
  // The sibling of the `--workflow-states` warning, and it shipped unpinned: wrapping
  // this `stderr.write` in `if (0)` left the whole suite green. Best-effort must not
  // mean silent (#1012).
  const r = cli(["--root", REPO_ROOT, "--format=json", "--base-root=/nonexistent/base", "--stdin"], "scripts/partition-shards.mjs\n");
  assert.equal(r.status, 0);
  assert.equal(r.json.verdict, "dispatch");
  assert.match(r.stderr, /::warning::.*could not read the base \.github at \/nonexistent\/base/);
});

test("an EMPTY listing is no listing — it must not claim every workflow is missing", () => {
  // Absence from the states listing is read as "not on the default branch", so an
  // empty map is not a weak signal: measured before the floor, a zero-byte file
  // produced three `answers 404 until this merges` sentences about three workflows
  // that are all on `main`. `gh` can exit 0 having written nothing.
  assert.equal(parseWorkflowStates(""), null);
  assert.equal(parseWorkflowStates("no-tab-rows-only\n\n"), null);
  const tmp = makeTempDir("cc-empty-");
  const file = path.join(tmp, "wf-states.tsv");
  fs.writeFileSync(file, "");
  const r = cli(["--root", REPO_ROOT, "--format=json", `--workflow-states=${file}`, "--stdin"], "scripts/stable-tests.ts\n");
  assert.match(r.stderr, /::warning::.*lists no workflows/);
  assert.doesNotMatch(r.json.advice, /does not exist on the default branch/);
  assert.match(r.json.advice, /Dispatch/, "falling back to the trigger is the whole point of the floor");
});

test("an empty base tree is refused for the same reason", () => {
  const tmp = makeTempDir("cc-emptybase-");
  fs.mkdirSync(path.join(tmp, ".github/workflows"), { recursive: true });
  const r = cli(["--root", REPO_ROOT, "--format=json", `--base-root=${tmp}`, "--stdin"], "scripts/stable-tests.ts\n");
  assert.match(r.stderr, /::warning::.*contains no workflows/);
  assert.doesNotMatch(r.json.advice, /does not exist on the default branch/);
});

test("a PR that REMOVES the trigger is a doubt, not a definitive 'no'", () => {
  // The mirror of the added-trigger case, and the ladder got it wrong first: `no` was
  // tested before `unverified`, so a head copy with the trigger deleted was reported
  // as established fact — from the copy GitHub does not resolve — and `no` licenses
  // the closing conclusion where a doubt must not.
  const headWithoutTrigger = new Map(FIXTURE.workflows);
  headWithoutTrigger.set(
    ".github/workflows/daily-stable.yml",
    "on:\n  schedule:\n    - cron: \"0 8 * * 1-5\"\n\nsteps:\n  - run: node scripts/partition-shards.mjs matrix",
  );
  const headRefs = buildCiReferences({ workflows: headWithoutTrigger, actions: FIXTURE.actions });
  const r = classifyCiChange({ changed: [".github/workflows/daily-stable.yml"], refs: headRefs });
  const { annotation } = dispatchAdvice(r);
  assert.equal(r.dispatchTargets[0].dispatchable, false, "the branch copy really has no trigger");
  assert.doesNotMatch(annotation, /cannot be dispatched on a branch/, "…but that is not what GitHub reads");
  assert.match(annotation, /the copy on this branch is not the one that decides/);
  assert.doesNotMatch(annotation, /Nothing in CI can prove this change before merge/);
});

test("a doubt never licenses the closing conclusion — both doubts, alone or mixed", () => {
  // `unknown` is pinned above; `unverified` was not, and adding it to `blocked`
  // survived the suite. The header states the rule for both.
  for (const r of [classify("scripts/opaque-only.mjs"), classifyCiChange({ changed: [".github/workflows/daily-stable.yml"], refs })]) {
    assert.doesNotMatch(dispatchAdvice(r).annotation, /Nothing in CI can prove this change before merge/);
  }
  // Excluding the doubts from `blocked` was only HALF the rule, and feeding this
  // pure-doubt sets could not see the other half: one `no` beside one `unknown`
  // leaves `blocked` non-empty and `yes` empty, and the sentence fired — asserted
  // over the whole change while a named workflow may well have been dispatchable.
  // Every per-target line scopes itself ("nothing in CI proves THIS PART"); this one
  // cannot, so anything unresolved must silence it.
  const mixed = classify("scripts/coverage-summary.ts", "scripts/opaque-only.mjs");
  const { annotation } = dispatchAdvice(mixed);
  assert.match(annotation, /cannot be dispatched on a branch/, "the `no` target is still named");
  assert.match(annotation, /Could not read the triggers/, "and so is the doubt");
  assert.doesNotMatch(annotation, /Nothing in CI can prove this change before merge/);
});

test("the ACTIONS LISTING can establish absence on its own", () => {
  // With no base tree — the `git archive` failure path — the listing is the only
  // source of `absent`, and that direction was pinned by nothing: deleting the
  // listing from `evidence`, or replacing it with a constant `true`, both left the
  // suite at 48 green. The sibling test below covers the base-tree direction; its
  // name promised both.
  const r = classifyCiChange({
    changed: [".github/workflows/daily-stable.yml"],
    refs,
    states: new Map([[".github/workflows/update-coverage-summary.yml", true]]),
  });
  assert.equal(r.dispatchTargets[0].onDefaultBranch, false, "the listing does not name it");
  const { annotation } = dispatchAdvice(r);
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.match(annotation, /does not exist on the default branch yet/);
});

test("the empty-listing floor counts WORKFLOW rows, not rows", () => {
  // The API also returns `dynamic/…` entries for app-provided workflows — 4 of the
  // 22 rows in this repo's listing. They can never match a key, so a listing holding
  // only those would clear a `size > 0` floor and then report every real workflow as
  // absent: the same false 404, one notch up.
  assert.equal(parseWorkflowStates("dynamic/agents/copilot-pull-request-reviewer\tactive"), null);
  assert.ok(parseWorkflowStates(".github/workflows/x.yml\tactive\ndynamic/y\tactive"));
});

test("a workflow known to be OFF is reported as off even when its triggers are unreadable", () => {
  // The certainty ordering the buckets exist for: the Actions state is about the
  // default branch by construction, so it holds whatever the trigger read said.
  // Measured unpinned: moving `unknown` above `off` left the suite green.
  const states = new Map([[".github/workflows/opaque.yml", false]]);
  const r = classifyCiChange({ changed: ["scripts/opaque-only.mjs"], refs, states });
  assert.equal(r.dispatchTargets[0].dispatchable, null, "the triggers really are unreadable");
  const { annotation } = dispatchAdvice(r);
  assert.match(annotation, /opaque\.yml is DISABLED in Actions/);
  assert.doesNotMatch(annotation, /Could not read the triggers/);
});

test("absence from EITHER source wins over presence in the other", () => {
  // They disagree exactly when a workflow this PR adds has already registered itself
  // with Actions — its own `pull_request` run does that — and reading that as
  // presence is a `Dispatch` for a 404.
  const head = new Map(FIXTURE.workflows);
  head.set(".github/workflows/new-lane.yml", "on:\n  workflow_dispatch:\n\nsteps:\n  - run: node scripts/partition-shards.mjs");
  const r = classifyCiChange({
    changed: [".github/workflows/new-lane.yml"],
    refs: buildCiReferences({ workflows: head, actions: FIXTURE.actions, baseWorkflows: FIXTURE.workflows }),
    states: new Map([[".github/workflows/new-lane.yml", true]]),
  });
  assert.equal(r.dispatchTargets[0].onDefaultBranch, false, "the base tree's absence is definitive");
  assert.match(dispatchAdvice(r).annotation, /does not exist on the default branch yet/);
});

test("with no base tree, a workflow the PR edits is unverified rather than promised", () => {
  // The degraded path: without the base copy the trigger answer came from the
  // branch, and for a file this PR changes that is not what GitHub will resolve.
  // ONLY those — every other workflow is the same file on both sides.
  const r = classifyCiChange({ changed: [".github/workflows/daily-stable.yml"], refs });
  assert.equal(r.dispatchTargets[0].triggersUnverified, true);
  const { annotation, summaryLines } = dispatchAdvice(r);
  assert.doesNotMatch(annotation, /Dispatch/);
  assert.match(annotation, /GitHub resolves workflow_dispatch from the default branch rather than from this one/);
  assert.match(summaryLines.join("\n"), /this PR edits it/);
  // …and a workflow the PR did NOT touch keeps its plain imperative.
  assert.match(dispatchAdvice(classify("scripts/partition-shards.mjs")).annotation, /Dispatch/);
});

test("dispatchability rides on the verdict, per named workflow", () => {
  const r = classify("scripts/coverage-summary.ts", "scripts/partition-shards.mjs");
  assert.deepEqual(
    r.dispatchTargets.map((t) => [t.workflow, t.dispatchable]),
    [
      [".github/workflows/daily-stable.yml", true],
      [".github/workflows/update-coverage-summary.yml", false],
    ],
  );
  assert.deepEqual(r.dispatchWorkflows, r.dispatchTargets.map((t) => t.workflow), "the two lists must agree");
});

// ── The real repo ───────────────────────────────────────────────────────────

test("every canary spec exists, is @stable, and needs no provider model", () => {
  // The three properties that make the canary usable: it exists (or the CLI
  // aborts), it is validated, and it never depends on provider key health — a
  // canary that skips on a drained key proves nothing (#915/#910/#911).
  const LLM = /resolveTestTargets|SimpleAgentTemplatePage|provider-setup|models\.json|MODEL_TEST_ID|initialGPTsetup|setupOpenAI|resolveGptModel|resolveGeminiModel/;
  for (const spec of CANARY_SPECS) {
    const file = path.join(REPO_ROOT, spec);
    assert.ok(fs.existsSync(file), `canary spec missing: ${spec}`);
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /@stable/, `canary spec is not @stable: ${spec}`);
    assert.doesNotMatch(source, LLM, `canary spec depends on collect-models output: ${spec}`);
    assert.doesNotMatch(source, /@destructive/, `canary spec is destructive: ${spec}`);
  }
});

test("the canary covers both the API and the browser", () => {
  // API-only would leave a broken Chromium launch to the next daily; UI-only
  // would not prove the backend answers. Both halves are the point.
  assert.ok(CANARY_SPECS.some((s) => s.includes("/api/")), "no API spec in the canary");
  assert.ok(
    CANARY_SPECS.some((s) => !s.includes("/api/")),
    "no UI spec in the canary — a broken browser launch would not be caught",
  );
});

test("against the live .github, the #1045 diff would have run the canary", () => {
  // The regression that opened #1159: this exact diff merged with the E2E lane
  // reporting `skipping`.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: ".github/actions/wait-for-backend/action.yml\nscripts/wait-for-backend.mjs\n.github/workflows/pr-validation.yml\n" },
  );
  const result = JSON.parse(out);
  assert.equal(result.verdict, "canary");
  assert.deepEqual(result.canarySpecs, CANARY_SPECS);
});

test("against the live .github, a daily-only diff asks for a dispatch", () => {
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: ".github/workflows/daily-stable.yml\n" },
  );
  const result = JSON.parse(out);
  assert.equal(result.verdict, "dispatch");
  assert.ok(result.dispatchWorkflows.includes(".github/workflows/daily-stable.yml"));
});

test("against the live .github, PR #1608's diff no longer prescribes a 422", () => {
  // The measurement that opened #1609, replayed: `scripts/coverage-summary.ts` is
  // run only by `update-coverage-summary.yml`, which is `on: push: [main]`.
  const out = execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--root", REPO_ROOT, "--format=json", "--stdin"],
    { input: "scripts/coverage-summary.ts\n" },
  );
  const result = JSON.parse(out);
  assert.equal(result.verdict, "dispatch");
  assert.ok(result.dispatchWorkflows.includes(".github/workflows/update-coverage-summary.yml"));
  assert.doesNotMatch(result.advice, /Dispatch/, `still prescribes a dispatch: ${result.advice}`);
  assert.match(result.advice, /cannot be dispatched on a branch/);
});

test("every workflow in this repo has a DECIDABLE trigger list", () => {
  // The parser is text over YAML, so a new `on:` spelling would degrade the advice
  // to "could not read the triggers" — honest, and useless. Measured when #1609
  // shipped: 18 workflows, 18 decided, 0 unknown. This is what notices the 19th.
  const dir = path.join(REPO_ROOT, ".github/workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, "no workflows found — the guard would pass vacuously");
  const unreadable = files
    .map((f) => [f, workflowDispatchability(fs.readFileSync(path.join(dir, f), "utf8"))])
    .filter(([, d]) => d.dispatchable === null)
    .map(([f, d]) => `${f}: ${d.note}`);
  assert.deepEqual(unreadable, [], `readWorkflowTriggers cannot read:\n  ${unreadable.join("\n  ")}`);
});

test("an unknown flag exits 2 — undecidable must not read as 'no CI change'", () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, [path.join(REPO_ROOT, "scripts/ci-change-coverage.mjs"), "--nope"], {
        stdio: "pipe",
      }),
    (error) => error.status === 2,
  );
});

// ── The lane must consume the verdict ───────────────────────────────────────

test("pr-validation.yml runs the classifier and substitutes the canary specs", () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, PR_LANE), "utf8");
  assert.match(text, /node scripts\/ci-change-coverage\.mjs --stdin --format=json/);
  // Only when the import graph found nothing — a CI change that DOES touch specs
  // must still run those specs, not the canary.
  assert.match(text, /if \[ "\$TOTAL" -eq 0 \]; then/);
  assert.match(text, /SPECS=\$\(jq -r '\.canarySpecs \| join\(" "\)'/);
  // Both verdicts have to reach the reader; a silent canary is the same bug in a
  // new costume (#1012's no-silent-caps rule).
  assert.match(text, /::warning::CI-only change to a surface THIS lane runs/);
  // The dispatch sentence is RENDERED by the classifier and printed verbatim. It
  // was composed here with `jq` until #1609, and what it composed was an
  // instruction that 422s — a defect no regex over this file could have caught,
  // which is #1226's whole finding. What this still has to pin is the WIRING.
  // Printed on BOTH verdicts, gated on `.advice` being non-null rather than on the
  // verdict, so a canary carrying dispatch targets does not silently drop them.
  assert.match(text, /ADVICE=\$\(jq -r '\.advice \/\/ empty' \/tmp\/ci-coverage\.json\)/);
  assert.match(text, /if \[ -n "\$ADVICE" \]; then echo "::warning::\$ADVICE"; fi/);
  assert.doesNotMatch(
    text.slice(text.indexOf("case \"$VERDICT\" in"), text.indexOf("esac")),
    /\.advice/,
    "the advice must not be printed from inside the verdict case — that is what dropped it on a canary",
  );
  assert.doesNotMatch(
    text,
    /Dispatch \$\(jq -r '\.dispatchWorkflows/,
    "the workflow must not compose the dispatch advice again — it cannot see the triggers",
  );
  // A classifier that cannot decide must fail the step, not degrade to "skip".
  assert.match(text, /CI-change classification failed/);
});

test("the lane supplies both facts the repository cannot, and has the scope to read them", () => {
  // Two things the working tree cannot answer (#1609): which workflows are turned ON
  // in Actions, and what the DEFAULT branch's copy of a workflow declares. Producing
  // them and then not passing them is the shape that matters — measured, dropping
  // both flags from the invocation left every other assertion here green.
  const text = fs.readFileSync(path.join(REPO_ROOT, PR_LANE), "utf8");
  assert.match(text, /actions\/workflows" --paginate/, "the Actions state is never fetched");
  assert.match(text, /STATES="--workflow-states=\/tmp\/wf-states\.tsv"/);
  // The DEFAULT branch, not `$BASE_REF`: GitHub resolves `workflow_dispatch` there,
  // and the two coincide only while every PR targets the default.
  assert.match(text, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(text, /git archive -o \/tmp\/base-ci\.tar "origin\/\$DEFAULT_BRANCH" \.github\/workflows/);
  assert.match(text, /BASE_CI="--base-root=\/tmp\/base-ci"/);
  // `[\s\S]`, not `[^\n]`, and the distinction is not cosmetic: the sibling
  // `$CANARY_FLAG` assertion below spans line continuations, and a `[^\n]` version of
  // this one would fail the day someone wraps this invocation — reporting "invoked
  // without the two inputs" for a reformat. What must hold is that both reach THIS
  // script's command line.
  assert.match(
    text,
    /ci-change-coverage\.mjs[\s\S]{0,200}?\$STATES[\s\S]{0,60}?\$BASE_CI/,
    "the classifier is invoked without the two inputs the step just produced",
  );
  assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  const detectSpecs = text.slice(text.indexOf("\n  detect-specs:"), text.indexOf("\n      - id: diff"));
  assert.ok(detectSpecs.length > 0 && detectSpecs.length < text.length, "the job slice is degenerate");
  assert.match(detectSpecs, /permissions:[\s\S]*actions: read/, "detect-specs cannot read the workflow states");
  assert.match(detectSpecs, /permissions:[\s\S]*contents: read/, "an explicit block must keep checkout working");
});

test("a canary run performs the sweep, so the health gate is actually exercised", () => {
  // The hole this closes: the canary specs need no model data, so the ordinary
  // needs_models rule would skip `Collect models` — and the post-collect-models
  // health gate with it, since that step is `if: needs_models`. A canary meant to
  // cover #1045 would have skipped #1045's action.
  const text = fs.readFileSync(path.join(REPO_ROOT, PR_LANE), "utf8");
  // The invariant is "a canary forces the sweep". Where it is EXPRESSED moved in
  // #1216: the needs_models decision left this workflow's inline shell for
  // `scripts/provider-dependent-specs.mjs`, which forces it on `--canary` (asserted
  // directly in that script's own unit lane). What this file must still pin is the
  // WIRING — that the workflow actually tells the script when the run is a canary,
  // since a dropped flag would silently restore the #1045 hole this test exists for.
  assert.match(
    text,
    /CANARY_FLAG="--canary"/,
    "the canary must still force the sweep — see provider-dependent-specs.mjs",
  );
  // Matched loosely across the invocation's line continuations: what must hold is
  // that `$CANARY_FLAG` reaches THIS script's command line, not the exact order of
  // its other flags.
  assert.match(
    text,
    /provider-dependent-specs\.mjs[\s\S]{0,240}?\$CANARY_FLAG/,
    "the canary flag must reach the verdict script",
  );
  assert.match(text, /canary: \$\{\{ steps\.diff\.outputs\.canary \}\}/, "the canary flag is not a job output");
  // …and neither consequence of forcing the sweep may block a CI-only PR.
  assert.match(
    text,
    /continue-on-error: \$\{\{ needs\.detect-specs\.outputs\.canary == 'true' \}\}/,
    "Collect models stays fatal on a canary run — a drained key would block a CI-only PR",
  );
  assert.match(
    text,
    /PREFLIGHT_SKIP_CREDENTIALS: \$\{\{ needs\.detect-specs\.outputs\.needs_models == 'true' && needs\.detect-specs\.outputs\.canary != 'true'/,
    "the credential pre-flight is still enforced on a canary run",
  );
});
