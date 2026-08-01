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
import { execFileSync } from "node:child_process";

import {
  CANARY_SPECS,
  PR_LANE,
  buildCiReferences,
  classifyCiChange,
} from "./ci-change-coverage.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// A miniature .github: the PR lane uses one action, another lane uses a second.
const FIXTURE = {
  workflows: new Map([
    [
      PR_LANE,
      `steps:
  - uses: ./.github/actions/setup-playwright
  - uses: ./.github/actions/wait-for-backend
  - run: node scripts/impacted-specs-by-import.mjs --stdin`,
    ],
    [
      ".github/workflows/daily-stable.yml",
      `steps:
  - uses: ./.github/actions/auto-remove-stable
  - run: node scripts/partition-shards.mjs matrix
  - uses: ./.github/actions/wait-for-backend`,
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
  assert.match(text, /Dispatch \$\(jq -r '\.dispatchWorkflows/);
  // A classifier that cannot decide must fail the step, not degrade to "skip".
  assert.match(text, /CI-change classification failed/);
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
