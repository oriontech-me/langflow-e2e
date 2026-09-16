// Unit tests for the `@stable` ownership CLI (issue #1770).
// Run with: npm run test:units
//
// The verdict itself is pinned in `scripts/lib/stable-ownership.test.ts`. This
// file covers what the CLI decides on its own, and each item fails silently if
// it breaks:
//
//   * WHERE the baseline comes from. On the PR lane it is read from the BASE
//     ref: read from the working tree, a PR could regenerate it and hide the
//     very spec it adds. That is asserted end to end below, not by spelling.
//   * The diff → spec mapping severity turns on.
//   * The fail-closed exits: an unreadable baseline, a failed diff, a failed
//     issue lookup.
//   * The annotation volume: the frozen baseline is ONE notice, not one per
//     spec — GitHub keeps ten per step and drops the rest without saying so.
//   * The two lanes' wiring, which no unit test can execute, pinned structurally.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import {
  annotationLines,
  exemptSpecsFrom,
  parseBaselineSpecs,
  run,
  specsFromDiffNames,
  type OwnershipDeps,
} from "./check-stable-ownership";
import { OWNERSHIP_ISSUE_TITLE, ownershipReport } from "./lib/stable-ownership";
import { REPO_ROOT } from "./lib/stable-tests";
import type { RawIssue } from "./reconcile-stable-orphans";

const baselineJson = (...specs: string[]) =>
  JSON.stringify({ version: 1, specs: specs.map((relativePath) => ({ relativePath, tests: [] })), testCount: 0, titleCollisions: [] });

test("the diff maps to regression-relative spec paths, and nothing else", () => {
  const specs = specsFromDiffNames([
    "tests/tests-automations/regression/ui-ux/a.spec.ts",
    "tests/tests-automations/regression/api/flows/b.spec.ts",
    "tests/tests-automations/smoke/c.spec.ts",
    "tests/helpers/flows/d.ts",
    "docs/ui-ux/a.md",
    "",
  ]);
  assert.deepEqual([...specs].sort(), ["api/flows/b.spec.ts", "ui-ux/a.spec.ts"]);
});

test("the baseline parser returns its spec paths and refuses a shape it cannot read", () => {
  assert.deepEqual(parseBaselineSpecs(baselineJson("a/x.spec.ts", "b/y.spec.ts"), "f"), ["a/x.spec.ts", "b/y.spec.ts"]);
  // An empty baseline is the legitimate end state of the triage wave.
  assert.deepEqual(parseBaselineSpecs(baselineJson(), "f"), []);
  assert.throws(() => parseBaselineSpecs("{nope", "f"), /not valid JSON/);
  assert.throws(() => parseBaselineSpecs(JSON.stringify({ version: 1 }), "f"), /"specs" array/);
  // Read as "no baseline", a malformed entry would turn every spec into a new
  // one — a PR-lane failure on every PR, for a reason no author caused.
  assert.throws(() => parseBaselineSpecs(JSON.stringify({ specs: [{ tier: "T2" }] }), "f"), /relativePath/);
});

test("declarations collapse to one exemption per spec, keeping every reason", () => {
  const map = exemptSpecsFrom([
    { spec: "a/x.spec.ts", title: "t1", reason: "first" },
    { spec: "a/x.spec.ts", title: "t2", reason: "second" },
    { spec: "b/y.spec.ts", title: "t3", reason: "only" },
  ]);
  assert.equal(map.size, 2);
  assert.match(map.get("a/x.spec.ts")!, /first/);
  assert.match(map.get("a/x.spec.ts")!, /second/);
  assert.equal(map.get("b/y.spec.ts"), "only");
});

test("annotations: one error per failure, one warning per warning, ONE notice for the whole baseline", () => {
  const report = ownershipReport({
    backlogSpecs: ["n/new.spec.ts", "d/drift.spec.ts", ...Array.from({ length: 12 }, (_, i) => `base/b${i}.spec.ts`), "o/owned.spec.ts"],
    baselineSpecs: Array.from({ length: 12 }, (_, i) => `base/b${i}.spec.ts`),
    exemptSpecs: new Map(),
    trackers: { "o/owned.spec.ts": [{ number: 5 }] },
    changedSpecs: new Set(["n/new.spec.ts"]),
  });
  const lines = annotationLines(report);
  assert.equal(lines.filter((l) => l.startsWith("::error")).length, 1);
  assert.equal(lines.filter((l) => l.startsWith("::warning")).length, 1);
  const notices = lines.filter((l) => l.startsWith("::notice"));
  assert.equal(notices.length, 1, "the baseline must not spend GitHub's ten-annotation budget");
  assert.match(notices[0], /12 spec/);
  assert.ok(!lines.some((l) => l.includes("o/owned.spec.ts")), "a settled spec is not annotated");
  assert.ok(lines.some((l) => l.includes("tests/tests-automations/regression/n/new.spec.ts")), "the error points at the file");
});

test("annotation text is escaped, so a detail cannot break the workflow command", () => {
  const report = ownershipReport({
    backlogSpecs: ["n/new.spec.ts"],
    baselineSpecs: [],
    exemptSpecs: new Map(),
    trackers: null,
    lookupError: "line one\nline two 100%",
  });
  const [line] = annotationLines(report);
  assert.ok(!line.includes("\n"), "a raw newline ends the command early");
  assert.match(line, /%0A/);
  assert.match(line, /100%25/);
});

// ─── run(), end to end over injected IO ─────────────────────────────────────

interface Captured { out: string[]; err: string[]; githubOutput: string[]; summary: string[]; files: Record<string, string> }

function deps(over: Partial<OwnershipDeps>, cap: Captured): OwnershipDeps {
  return {
    backlogSpecs: () => ["base/old.spec.ts", "new/added.spec.ts"],
    readBaseline: (ref) => (ref ? baselineJson("base/old.spec.ts") : baselineJson("base/old.spec.ts", "new/added.spec.ts")),
    readExemptions: () => JSON.stringify({ exemptions: [] }),
    fetchIssues: (): RawIssue[] => [],
    changedFiles: () => ["tests/tests-automations/regression/new/added.spec.ts"],
    env: {},
    log: (s) => cap.out.push(s),
    error: (s) => cap.err.push(s),
    writeFile: (f, s) => {
      cap.files[f] = s;
    },
    appendGithubOutput: (s) => cap.githubOutput.push(s),
    appendStepSummary: (s) => cap.summary.push(s),
    ...over,
  };
}
const fresh = (): Captured => ({ out: [], err: [], githubOutput: [], summary: [], files: {} });

// THE bypass. The working tree's baseline already lists the added spec — the
// author ran `npm run triage:baseline` — and the base ref's does not. Reading the
// working tree would make the new spec a quiet notice.
test("on the PR lane a new spec fails even when the PR regenerated the baseline to include it", () => {
  const cap = fresh();
  const code = run(["--base-ref", "origin/main"], deps({}, cap));
  assert.equal(code, 1);
  assert.ok(cap.out.some((l) => /unowned-new/.test(l) && l.includes("new/added.spec.ts")));
});

test("the same spec is not a failure once an open issue names it", () => {
  const cap = fresh();
  const code = run(["--base-ref", "origin/main"], deps({
    fetchIssues: () => [{ number: 88, title: "Track new/added.spec.ts", html_url: "u" }],
  }, cap));
  assert.equal(code, 0);
});

test("the ownership report issue itself never counts as the owner", () => {
  const cap = fresh();
  const code = run(["--base-ref", "origin/main"], deps({
    fetchIssues: () => [{ number: 99, title: OWNERSHIP_ISSUE_TITLE, body: "new/added.spec.ts", html_url: "u" }],
  }, cap));
  assert.equal(code, 1);
});

test("without a base ref (the daily) the working-tree baseline is read and nothing is a diff failure", () => {
  const cap = fresh();
  let refSeen: string | undefined = "unset";
  const code = run([], deps({
    readBaseline: (ref) => {
      refSeen = ref;
      return baselineJson("base/old.spec.ts");
    },
    changedFiles: () => {
      throw new Error("the daily has no diff and must not ask for one");
    },
  }, cap));
  assert.equal(refSeen, undefined);
  assert.equal(code, 0, "an unowned spec outside the baseline is a warning on the daily, not a failure");
  assert.ok(cap.out.some((l) => /unowned-new/.test(l) && l.includes("new/added.spec.ts")), "and it is still reported");
});

test("a failed issue lookup exits 1 and says so in the output flags", () => {
  const cap = fresh();
  const code = run([], deps({
    env: { GITHUB_OUTPUT: "/dev/null" },
    fetchIssues: () => {
      throw new Error("HTTP 502: Bad Gateway\nmore detail");
    },
  }, cap));
  assert.equal(code, 1);
  const out = cap.githubOutput.join("\n");
  assert.match(out, /tracker_lookup_failed=true/);
  assert.match(out, /HTTP 502/);
});

test("an unreadable baseline or a failed diff is a broken run, not an empty one", () => {
  const cap = fresh();
  assert.equal(run([], deps({ readBaseline: () => { throw new Error("ENOENT"); } }, cap)), 1);
  assert.ok(cap.err.some((l) => /baseline/i.test(l)));

  const cap2 = fresh();
  assert.equal(run(["--base-ref", "origin/main"], deps({ changedFiles: () => { throw new Error("bad revision"); } }, cap2)), 1);
  assert.ok(cap2.err.some((l) => /diff/i.test(l)));
});

test("in Actions it writes the flags, the title and the body, and appends the body to the step summary", () => {
  const cap = fresh();
  run(["--markdown", "out.md", "--json", "out.json"], deps({
    env: { GITHUB_OUTPUT: "/tmp/x", GITHUB_STEP_SUMMARY: "/tmp/y", GITHUB_ACTIONS: "true" },
  }, cap));
  const out = cap.githubOutput.join("\n");
  assert.match(out, /has_findings=true/);
  assert.ok(out.includes(`issue_title=${OWNERSHIP_ISSUE_TITLE}`));
  assert.match(out, /summary_md<</);
  assert.ok(cap.summary.join("\n").includes("new/added.spec.ts"));
  assert.ok(cap.files["out.md"].includes("new/added.spec.ts"));
  assert.equal(JSON.parse(cap.files["out.json"]).rows.length, 2);
  assert.ok(cap.out.some((l) => l.startsWith("::")), "annotations are emitted inside Actions");
});

// ─── Wiring, pinned structurally ────────────────────────────────────────────

const workflow = (name: string) => fs.readFileSync(path.join(REPO_ROOT, ".github/workflows", name), "utf-8");

/** The YAML block of one job, from its key to the next top-level job key. */
function jobBlock(wf: string, job: string): string {
  const start = wf.search(new RegExp(`^  ${job}:\\s*$`, "m"));
  assert.notEqual(start, -1, `job "${job}" exists`);
  const rest = wf.slice(start + 1);
  const next = rest.search(/^  [a-z][a-z0-9-]*:\s*$/m);
  return next === -1 ? wf.slice(start) : wf.slice(start, start + 1 + next);
}

/** The YAML of one step, from its `- name:` to the next step. */
function stepBlock(block: string, needle: string): string {
  const at = block.indexOf(needle);
  assert.notEqual(at, -1, `a step containing ${needle}`);
  const start = block.lastIndexOf("\n      - ", at);
  const end = block.indexOf("\n      - ", at);
  return block.slice(start, end === -1 ? undefined : end);
}

test("the PR lane runs the guard against the base ref, and its failure fails the job", () => {
  const job = jobBlock(workflow("pr-validation.yml"), "checklist-guard");
  const step = stepBlock(job, "check-stable-ownership");
  assert.match(step, /--base-ref\s+"?origin\/\$BASE_REF"?/);
  assert.match(step, /GH_TOKEN:/);
  assert.doesNotMatch(step, /continue-on-error/, "the failing case is the author's own diff");
  // It needs the base ref fetched and the full history for the three-dot diff.
  assert.match(job, /fetch-depth:\s*0/);
});

test("the daily runs the guard in its own job, never fails the run, and never spells the title", () => {
  const wf = workflow("daily-stable.yml");
  assert.ok(!wf.includes(OWNERSHIP_ISSUE_TITLE), "the title comes from the script's output, never a second copy");
  const job = jobBlock(wf, "stable-ownership");
  assert.match(job, /continue-on-error:\s*true/, "an observation must not redden a green daily (#980)");
  assert.doesNotMatch(job, /^\s{4}needs:/m, "it reads the ASTs and live issues, not the run report, so it runs every day");
  assert.doesNotMatch(job, /^\s{4}container:/m, "the Playwright image ships no `gh`, which the issue lookup shells out to");
  assert.match(job, /issues:\s*write/);
  const check = stepBlock(job, "check-stable-ownership");
  assert.doesNotMatch(check, /--base-ref/, "the daily has no diff; the base ref is the PR lane's");
  // An outage decides nothing about ownership and must not overwrite the report.
  const publish = stepBlock(job, "Open or refresh");
  assert.match(publish, /tracker_lookup_failed == 'false'/);
  const close = stepBlock(job, "Close the ownership report");
  assert.match(close, /has_findings == 'false'/);
  assert.match(close, /tracker_lookup_failed == 'false'/);
});
