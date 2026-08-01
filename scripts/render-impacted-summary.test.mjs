// Unit tests for the run-summary renderer (issue #1226).
// Run with: npm run test:scripts
//
// These assert on OUTPUT, which is the whole reason this code left the workflow. The
// three wrong figures #1226 is about all shipped with every gate green, because the
// only thing guarding them was a regex hunting for a variable name in the YAML — and
// each of those regexes was then shown to miss its own mutation (swap `$RUN_COUNT` for
// `$TOTAL` on the printed line; hoist the caveats above the counts). A guard that pins
// a spelling does not pin a behaviour.
//
// So every test below asks the two questions a reviewer asks of the summary: what is
// the number, and what is it above.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

import {
  UnrenderableError,
  countSpecs,
  renderSummary,
} from "./render-impacted-summary.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const REGRESSION = "tests/tests-automations/regression/";
const AGENT = `${REGRESSION}core-components/agent-component-regression.spec.ts`;
const EDIT = `${REGRESSION}core-functionality/project-management/edit-flow-name.spec.ts`;
const RUN = `${REGRESSION}flow-functionality/run-flow.spec.ts`;

/** Index of the first caveat bullet, i.e. where the qualifying prose starts. */
const firstCaveatAt = (lines) =>
  lines.findIndex((line) => /^- (⚠️|🔑|🐤)/.test(line));
const at = (lines, needle) => lines.findIndex((line) => line.includes(needle));

// ---------- countSpecs ----------

test("the run count is the length of the list handed to Playwright", () => {
  assert.equal(countSpecs(""), 0);
  assert.equal(countSpecs("a.spec.ts"), 1);
  assert.equal(countSpecs("a.spec.ts b.spec.ts c.spec.ts"), 3);
  // A trailing newline or doubled space must not invent a spec.
  assert.equal(countSpecs("a.spec.ts  b.spec.ts\n"), 2);
  assert.throws(() => countSpecs(undefined), UnrenderableError);
});

// ---------- the count itself ----------

test("an excluded spec is NOT counted as executed — #1226's opening complaint", () => {
  // The lane resolved 7, the verdict removed 1, so 6 run. Printing 7 here is the
  // defect the issue was opened about, and it is what a `**$TOTAL**` slip produces.
  const lines = renderSummary({
    specs: [EDIT, RUN].join(" "),
    impacted: { specs: new Array(7).fill("x"), direct: new Array(7).fill("x"), dropped: [] },
    provider: { run: [EDIT, RUN], stableRun: 2, excluded: [{ file: AGENT, reasons: ["tagged @agents"] }] },
  });
  assert.match(lines.join("\n"), /- running in this PR: \*\*2\*\*/);
  assert.doesNotMatch(lines.join("\n"), /- running in this PR: \*\*7\*\*/);
});

test("a canary run reports what it runs, not the import graph's zero", () => {
  // `TOTAL` is 0 by definition on a CI-only diff — no spec imports a workflow — while
  // three canary specs do run. The old line said 0.
  const canarySpecs = ["a.spec.ts", "b.spec.ts", "c.spec.ts"];
  const lines = renderSummary({
    specs: canarySpecs.join(" "),
    impacted: { specs: [], direct: [], dropped: [] },
    provider: { run: [], stableRun: 0, excluded: [] },
    ciCoverage: { verdict: "canary", canarySpecs },
    canary: true,
  });
  assert.match(lines.join("\n"), /- running in this PR: \*\*3\*\*/);
  // And the `@stable` tally is OMITTED rather than published as a 0 the verdict never
  // measured: on a canary the run list came from `ci-change-coverage.mjs`.
  assert.doesNotMatch(lines.join("\n"), /running in this PR:.*@stable/);
});

test("a capped run reports the 20 that run, not the 237 resolved", () => {
  const specs = new Array(20).fill(0).map((_, i) => `s${i}.spec.ts`);
  const lines = renderSummary({
    specs: specs.join(" "),
    impacted: {
      specs: new Array(237).fill("x"),
      direct: new Array(237).fill("x"),
      dropped: new Array(217).fill("d.spec.ts"),
      fullSuite: true,
    },
    provider: { run: specs, stableRun: 19, excluded: [] },
    cap: "20",
  });
  const text = lines.join("\n");
  assert.match(text, /- resolved by import graph: \*\*237\*\*/);
  assert.match(text, /- running in this PR: \*\*20\*\* \(of which `@stable`: 19\)/);
});

// ---------- the ORDER, which is the other half of #1226 ----------

test("the counts come before every caveat that qualifies them", () => {
  // Appending caveats as they occurred put the cap's 217 bullets ABOVE the run count
  // (line 223 of 225 on a suite-wide diff), which answers #1226 in letter only.
  const specs = new Array(20).fill(0).map((_, i) => `s${i}.spec.ts`);
  const lines = renderSummary({
    specs: specs.join(" "),
    impacted: {
      specs: new Array(237).fill("x"),
      direct: new Array(237).fill("x"),
      dropped: new Array(217).fill("d.spec.ts"),
      fullSuite: true,
    },
    provider: {
      run: specs,
      stableRun: 19,
      excluded: [{ file: AGENT, reasons: ["tagged @agents"] }],
      forcedToAvoidEmptyRun: false,
    },
    cap: "20",
  });
  const runAt = at(lines, "- running in this PR:");
  assert.ok(runAt > 0, "the run count is present");
  assert.ok(
    runAt < firstCaveatAt(lines),
    `the run count (line ${runAt}) must precede the first caveat (line ${firstCaveatAt(lines)})`,
  );
  // Concretely: near the top, not buried under the dropped list.
  assert.ok(runAt <= 3, `the run count is line ${runAt}, not ~223`);
});

test("the heading opens the summary and the counts follow it immediately", () => {
  const lines = renderSummary({
    specs: "a.spec.ts",
    impacted: { specs: ["a"], direct: ["a"], dropped: [] },
    provider: { run: ["a.spec.ts"], stableRun: 1, excluded: [] },
  });
  assert.equal(lines[0], "### Impacted specs");
  assert.equal(lines[1], "");
  assert.match(lines[2], /^- resolved by import graph:/);
  assert.match(lines[3], /^- running in this PR:/);
});

// ---------- every caveat still gets said (#1012's rule) ----------

test("each caveat survives the move out of the workflow", () => {
  const specs = ["a.spec.ts"];
  const text = renderSummary({
    specs: specs.join(" "),
    impacted: {
      specs: new Array(30).fill("x"),
      direct: new Array(30).fill("x"),
      dropped: ["dropped-one.spec.ts"],
      fullSuite: true,
    },
    provider: {
      run: specs,
      stableRun: 1,
      excluded: [{ file: AGENT, reasons: ["tagged @agents"] }],
      forcedBy: [{ file: "mcp.spec.ts", isChanged: false }],
      forcedToAvoidEmptyRun: true,
    },
    cap: "20",
  }).join("\n");
  assert.match(text, /suite-wide change/);
  assert.match(text, /capped at `20`.*1 impacted specs were NOT run/s);
  assert.match(text, /dropped-one\.spec\.ts/);
  assert.match(text, /NOT run.*tagged @agents/s);
  assert.match(text, /daily-stable\.yml/);
  assert.match(text, /provider sweep \*\*required\*\* by/);
  assert.match(text, /mcp\.spec\.ts` \(consumes the sweep output\)/);
  assert.match(text, /provider sweep forced/);
});

test("a changed spec is labelled as such in the forced-by list", () => {
  const text = renderSummary({
    specs: AGENT,
    impacted: { specs: ["x"], direct: ["x"], dropped: [] },
    provider: { run: [AGENT], stableRun: 1, excluded: [], forcedBy: [{ file: AGENT, isChanged: true }] },
  }).join("\n");
  assert.match(text, /\(changed by this PR\)/);
});

test("the dispatch verdict names the workflows instead of implying coverage", () => {
  const text = renderSummary({
    specs: "",
    impacted: { specs: [], direct: [], dropped: [] },
    provider: { run: [], stableRun: 0, excluded: [] },
    ciCoverage: { verdict: "dispatch", dispatchWorkflows: ["daily-stable.yml"] },
  }).join("\n");
  assert.match(text, /no runtime coverage here/);
  assert.match(text, /daily-stable\.yml/);
});

// ---------- the failure path (the regression buffering introduced) ----------

test("a missing provider verdict degrades the summary instead of erasing it", () => {
  // Buffering the caveats meant an aborted verdict produced a 0-BYTE summary, where
  // the append-as-you-go version had left 223 lines standing. Measured on a
  // `fixtures.ts` diff. So a null verdict must still print what it can, and name the
  // gap rather than let a short summary read as a clean one.
  const lines = renderSummary({
    specs: "",
    impacted: {
      specs: new Array(237).fill("x"),
      direct: new Array(237).fill("x"),
      dropped: new Array(217).fill("d.spec.ts"),
      fullSuite: true,
    },
    provider: null,
    cap: "20",
  });
  const text = lines.join("\n");
  assert.match(text, /- resolved by import graph: \*\*237\*\*/);
  assert.match(text, /suite-wide change/);
  assert.match(text, /217 impacted specs were NOT run/);
  assert.match(text, /provider-coverage verdict did not complete/);
  assert.ok(lines.length > 220, "the caveats it can still establish are not lost");
  // With no verdict there is no honest `@stable` tally, so none is printed.
  assert.doesNotMatch(text, /running in this PR:.*@stable/);
});

test("bad input is unrenderable, never a partial summary", () => {
  assert.throws(() => renderSummary({ specs: "", impacted: null }), UnrenderableError);
  assert.throws(
    () => renderSummary({ specs: "", impacted: { specs: [] } }),
    UnrenderableError,
    "a missing `direct` must not render as 0 transitive",
  );
});

// ---------- the CLI, and the workflow's use of it ----------

const CLI = path.join(REPO_ROOT, "scripts/render-impacted-summary.mjs");

test("the CLI renders from files and exits 2 on anything undecidable", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "render-summary-"));
  const impacted = path.join(dir, "impacted.json");
  const provider = path.join(dir, "provider.json");
  try {
    writeFileSync(
      impacted,
      JSON.stringify({ specs: ["a", "b"], direct: ["a", "b"], dropped: [] }),
    );
    writeFileSync(
      provider,
      JSON.stringify({ run: ["a.spec.ts"], stableRun: 1, excluded: [] }),
    );

    const ok = spawnSync(
      process.execPath,
      [CLI, `--impacted=${impacted}`, `--provider=${provider}`, "--specs=a.spec.ts"],
      { encoding: "utf8" },
    );
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /- running in this PR: \*\*1\*\* \(of which `@stable`: 1\)/);

    // An absent provider file is a legitimate state (the verdict aborted).
    const degraded = spawnSync(
      process.execPath,
      [CLI, `--impacted=${impacted}`, "--provider=/nonexistent.json", "--specs="],
      { encoding: "utf8" },
    );
    assert.equal(degraded.status, 0, degraded.stderr);
    assert.match(degraded.stdout, /verdict did not complete/);

    // A malformed one is not.
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, "{ nope");
    assert.equal(
      spawnSync(process.execPath, [CLI, `--impacted=${impacted}`, `--provider=${bad}`, "--specs="], { encoding: "utf8" }).status,
      2,
    );
    // Nor is a missing required flag, an unreadable impacted file, or a bad flag.
    assert.equal(spawnSync(process.execPath, [CLI, "--specs="], { encoding: "utf8" }).status, 2);
    assert.equal(
      spawnSync(process.execPath, [CLI, "--impacted=/nonexistent.json", "--specs="], { encoding: "utf8" }).status,
      2,
    );
    assert.equal(
      spawnSync(process.execPath, [CLI, `--impacted=${impacted}`, "--specs=", "--bogus"], { encoding: "utf8" }).status,
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-validation renders the summary through this script, once, with the final list", () => {
  // Structural, and deliberately narrow: everything about WHAT the summary says is
  // asserted above, on output. What the workflow still has to get right is that it
  // calls this at all, hands it `$SPECS` (the list it exports, after the provider
  // verdict re-derives it) and does not also hand-write summary lines beside it.
  const workflow = readFileSync(
    path.join(REPO_ROOT, ".github/workflows/pr-validation.yml"),
    "utf8",
  );
  const code = workflow
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.match(code, /--specs="\$SPECS"/, "the renderer gets the exported run list");
  // No hand-written summary bullets left behind: the only writer is the renderer.
  const bullets = code.match(/echo "- .*GITHUB_STEP_SUMMARY/g) ?? [];
  assert.deepEqual(bullets, [], "summary lines must come from the renderer, not echoes");

  // TWO invocations, and the distinction matters — an earlier version of this test used
  // `indexOf` and matched the wrong one:
  //   1. the degraded render inside the verdict's failure branch, which necessarily
  //      comes BEFORE the run list is re-derived and passes no `--provider`;
  //   2. the normal render, which must come AFTER.
  const calls = [...code.matchAll(/node scripts\/render-impacted-summary\.mjs/g)].map(
    (m) => m.index,
  );
  assert.equal(calls.length, 2, "one normal render, one degraded render on verdict failure");
  const rederiveAt = code.indexOf("SPECS=$(jq -r '.run | join(\" \")'");
  assert.ok(rederiveAt > 0, "the run list is re-derived from the verdict");
  assert.ok(calls[0] < rederiveAt, "the degraded render belongs to the failure branch");
  assert.ok(calls[1] > rederiveAt, "the normal render runs after the run list is final");
  // Only the normal one reads the verdict; the degraded one cannot, since its whole
  // premise is that the verdict did not produce a file.
  const providerFlags = [...code.matchAll(/--provider=\/tmp\/provider\.json/g)];
  assert.equal(providerFlags.length, 1, "only the normal render passes --provider");
  assert.ok(providerFlags[0].index > rederiveAt);
});
