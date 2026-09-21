import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const WF = ".github/workflows/refresh-coverage-matrix.yml";
const yml = readFileSync(WF, "utf8");

test("the workflow_run trigger names a workflow that actually exists", () => {
  // A workflow_run pointing at a name nothing declares never fires, and says nothing when it
  // doesn't — the refresh would silently stop seeing test health. Caught exactly that way once.
  const referenced = [...yml.matchAll(/workflows:\s*\[([^\]]+)\]/g)]
    .flatMap(m => m[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")));
  assert.ok(referenced.length > 0, "expected a workflow_run trigger");

  const declared = readdirSync(".github/workflows")
    .filter(f => /\.ya?ml$/.test(f))
    .map(f => readFileSync(`.github/workflows/${f}`, "utf8").match(/^name:\s*(.+)$/m)?.[1]?.trim())
    .filter(Boolean);

  for (const name of referenced) {
    assert.ok(declared.includes(name), `workflow_run references "${name}", which no workflow declares. Declared: ${declared.join(" | ")}`);
  }
});

test("the refresh runs before the feed check, and the check is not allowed to fail softly", () => {
  const refresh = yml.indexOf("npm run coverage:refresh");
  const check = yml.indexOf("npm run coverage:feed -- --check");
  assert.ok(refresh > 0 && check > refresh, "the feed check must follow the refresh");
  // The check step must NOT be continue-on-error: a feed disagreeing with data.json serves the
  // dashboard numbers nobody can reproduce, which is the one failure worth reddening the job for.
  const checkStep = yml.slice(yml.lastIndexOf("- name:", check), check);
  assert.ok(!/continue-on-error:\s*true/.test(checkStep), "the feed check must not be continue-on-error");
});

test("the platform POST cannot redden the job, and skips loudly when unconfigured", () => {
  const post = yml.indexOf("POST the matrix to the QA Platform");
  assert.ok(post > 0);
  const step = yml.slice(post, yml.indexOf("- name: Summary"));
  assert.match(step, /continue-on-error:\s*true/, "a platform outage must not fail a job whose product already succeeded");
  assert.match(step, /::warning::.*not configured/, "an unconfigured endpoint must say so rather than pass silently");
  assert.match(step, /--data @docs\/coverage-heatmap\/dashboard-feed\.json/, "the POST body must be the documented feed itself");
});

test("the commit-back is guarded against recursion and against losing a push race", () => {
  assert.match(yml, /\[skip ci\]/, "the auto-commit must carry [skip ci]");
  assert.match(yml, /!contains\(github\.event\.head_commit\.message, '\[skip ci\]'\)/, "and the job must skip its own commit");
  assert.match(yml, /for attempt in 1 2 3 4 5/, "a bare push loses the fast-forward race — retry by recomputing");
  assert.match(yml, /concurrency:/, "two concurrent refreshes would race on the same commit-back");
});

test("no workflow expression is interpolated into a run: body", () => {
  // Substitution happens before bash parses the line, so a value containing a quote or a
  // semicolon breaks out of the string. This repo already had to fix exactly that shape in
  // nightly.yml's test_grep. Inputs reach a script through `env`, never through `${{ }}` in run:.
  // Pinned as an ABSENCE because the unsafe idiom returns by copy-paste, not by edit.
  const lines = yml.split("\n");
  const offenders = [];
  let inRun = false, runIndent = 0;
  for (const [i, line] of lines.entries()) {
    const run = line.match(/^(\s*)run:\s*\|/);
    if (run) { inRun = true; runIndent = run[1].length; continue; }
    if (inRun) {
      const indent = line.search(/\S/);
      if (line.trim() && indent <= runIndent) { inRun = false; }
      else if (/\$\{\{/.test(line)) offenders.push(`${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], `expressions interpolated into run: — route them through env instead`);
});

test("the push-retry recovers onto the branch it is running on, never a hardcoded main", () => {
  // This loop was modelled on update-coverage-summary.yml, which can hardcode `main` because it
  // only triggers on a push to main. This workflow also takes a workflow_dispatch, which can
  // target any branch — and a hardcoded `git reset --hard origin/main` there DISCARDS that
  // branch's commits and pushes the result over it. Destructive, and silent until it fires.
  assert.doesNotMatch(yml, /git reset --hard origin\/main/, "recovery must not hardcode main");
  assert.doesNotMatch(yml, /git fetch origin main\b/, "fetch must not hardcode main");
  assert.match(yml, /git reset --hard "origin\/\$BRANCH"/, "recovery resets onto the run's own branch");
  assert.match(yml, /BRANCH:\s*\$\{\{[^}]*github\.ref_name[^}]*\}\}/, "BRANCH must be derived from the event");
});
