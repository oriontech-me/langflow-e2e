#!/usr/bin/env node
/**
 * Decides what runtime coverage a CI-ONLY change gets on a PR (issue #1159).
 *
 * WHY THIS EXISTS
 *
 * `impacted-specs-by-import.mjs` answers "which specs import the changed files".
 * For a diff confined to `.github/**` or `scripts/**` the honest answer is NONE —
 * nothing under `tests/` imports a workflow — so `pr-validation.yml` reported
 * `Impacted specs: 0` and skipped its E2E lane. The change then merged having
 * proven that it PARSES, never that it RUNS.
 *
 * That is not hypothetical. PR #1157 (#1045) extracted the post-collect-models
 * health gate into `.github/actions/wait-for-backend` and rewired four workflows
 * onto it; every check was green, the E2E lane was `skipping`, and the action had
 * executed nowhere at merge time. A bad `uses:` path, a missing input or an absent
 * interpreter would have surfaced first as the next daily failing in a step
 * unrelated to any spec — the attribution problem that gate exists to prevent,
 * reintroduced one layer up.
 *
 * This script is the other half of the question: given the changed paths, does the
 * PR lane itself run the thing that changed?
 *
 *   canary    yes — the PR lane's own wiring changed (its workflow, an action it
 *             uses, or a script it reaches). Run a tiny fixed spec set so the lane
 *             boots Langflow and walks pre-flight → health gate → Playwright for
 *             real. This is the verdict that would have covered #1045.
 *   dispatch  no — the changed surface belongs to another lane (daily-stable,
 *             manual, nightly…). A PR canary cannot exercise it, so name the
 *             workflows to dispatch instead of implying coverage.
 *   none      the diff touches no CI surface at all (docs, ROADMAP): nothing to
 *             say, and nothing to run.
 *
 * The reachability is DERIVED from the YAML, never hardcoded: a workflow's
 * `scripts/x` references and its `uses: ./.github/actions/y`, plus each action's
 * own `scripts/x`. A new action wired into pr-validation is covered the day it
 * lands, with no table to maintain — the maintenance cost that made the
 * path→lane mapping alternative unattractive in #1159.
 *
 * Run:
 *   git diff --name-only … | node scripts/ci-change-coverage.mjs --stdin --format=json
 *   node scripts/ci-change-coverage.mjs .github/actions/wait-for-backend/action.yml
 *
 * Exit codes: 0 = a verdict was produced; 2 = the script could not decide (bad
 * flag, unreadable .github, a canary spec that no longer exists). A guard that
 * cannot decide must never look like "nothing to do" — same rule as
 * `resolve-echo-endpoint` and `select-dedicated-issues`.
 *
 * Dependency-free ESM; covered by `npm run test:scripts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The lane a pull request actually runs. */
export const PR_LANE = ".github/workflows/pr-validation.yml";

/**
 * The canary. Three specs, chosen so a green run means the lane WORKS end to end
 * rather than that a spec passed:
 *   - two API specs prove the container booted, credentials/pre-flight resolved,
 *     the health gate let the run through, and the backend answers;
 *   - one UI spec proves Chromium launches and renders — the half an API-only
 *     canary would miss.
 * All three are `@stable`, LLM-free (so the canary never depends on provider key
 * health — the #915/#910/#911 class), create no flow (nothing to clean up), and
 * are among the shortest specs in the suite.
 */
export const CANARY_SPECS = [
  "tests/tests-automations/regression/api/flows/api-health-check.spec.ts",
  "tests/tests-automations/regression/api/flows/api-version.spec.ts",
  "tests/tests-automations/regression/ui-ux/settings-theme-toggle.spec.ts",
];

const SCRIPT_REF = /(?:^|[^\w/])(scripts\/[A-Za-z0-9._-]+)/g;
const LOCAL_ACTION_REF = /\.\/\.github\/actions\/([A-Za-z0-9._-]+)/g;

const matchAll = (text, re) => [...String(text).matchAll(re)].map((m) => m[1]);

/**
 * Build the reference graph from the YAML itself.
 *
 * @param {{workflows: Map<string,string>, actions: Map<string,string>}} sources
 *   workflows keyed by repo-relative path, actions keyed by ACTION NAME.
 */
export function buildCiReferences({ workflows, actions }) {
  const actionScripts = new Map();
  for (const [name, text] of actions) {
    actionScripts.set(name, new Set(matchAll(text, SCRIPT_REF)));
  }

  const workflowScripts = new Map();
  const workflowActions = new Map();
  for (const [file, text] of workflows) {
    const used = new Set(matchAll(text, LOCAL_ACTION_REF));
    workflowActions.set(file, used);
    const scripts = new Set(matchAll(text, SCRIPT_REF));
    // A workflow reaches a script THROUGH an action too — that indirection is
    // exactly how #1045 shipped (`wait-for-backend.mjs` is named nowhere in
    // pr-validation.yml, only in the action it uses).
    for (const name of used) {
      for (const s of actionScripts.get(name) ?? []) scripts.add(s);
    }
    workflowScripts.set(file, scripts);
  }

  return { workflowScripts, workflowActions, actionScripts };
}

/** Workflows (other than the PR lane) that reach a given action or script. */
function workflowsReaching(refs, { action, script }) {
  const hits = [];
  for (const [file, used] of refs.workflowActions) {
    if (action && used.has(action)) hits.push(file);
  }
  for (const [file, scripts] of refs.workflowScripts) {
    if (script && scripts.has(script) && !hits.includes(file)) hits.push(file);
  }
  return hits.sort();
}

/**
 * Classify a set of changed paths.
 *
 * @returns {{verdict: 'canary'|'dispatch'|'none', ciFiles: string[],
 *            canarySpecs: string[], dispatchWorkflows: string[], reasons: string[]}}
 */
export function classifyCiChange({ changed, refs }) {
  const ciFiles = [];
  const reasons = [];
  const dispatch = new Set();
  let canary = false;

  const prActions = refs.workflowActions.get(PR_LANE) ?? new Set();
  const prScripts = refs.workflowScripts.get(PR_LANE) ?? new Set();

  for (const file of changed) {
    const isWorkflow = file.startsWith(".github/workflows/");
    const actionName = /^\.github\/actions\/([^/]+)\//.exec(file)?.[1];
    const isScript = file.startsWith("scripts/");
    if (!isWorkflow && !actionName && !isScript) continue;

    if (isWorkflow) {
      ciFiles.push(file);
      if (file === PR_LANE) {
        canary = true;
        reasons.push(`${file} IS the PR lane — its own wiring changed`);
      } else {
        dispatch.add(file);
        reasons.push(`${file} governs another lane; a PR canary cannot exercise it`);
      }
      continue;
    }

    if (actionName) {
      ciFiles.push(file);
      if (prActions.has(actionName)) {
        canary = true;
        reasons.push(`.github/actions/${actionName} is used by the PR lane`);
      } else {
        const users = workflowsReaching(refs, { action: actionName });
        users.forEach((w) => dispatch.add(w));
        reasons.push(
          users.length
            ? `.github/actions/${actionName} is used by ${users.join(", ")}, not by the PR lane`
            : `.github/actions/${actionName} is referenced by NO workflow — dead action, or a reference this script cannot see`,
        );
      }
      continue;
    }

    // A script is CI surface only if some workflow or action actually runs it.
    // `scripts/foo.test.mjs` and a helper nothing invokes are not.
    const referenced = [...refs.workflowScripts.values()].some((s) => s.has(file));
    if (!referenced) continue;
    ciFiles.push(file);
    if (prScripts.has(file)) {
      canary = true;
      reasons.push(`${file} is run by the PR lane (directly or through an action it uses)`);
    } else {
      const users = workflowsReaching(refs, { script: file });
      users.forEach((w) => dispatch.add(w));
      reasons.push(`${file} is run by ${users.join(", ")}, not by the PR lane`);
    }
  }

  // `canary` wins over `dispatch`: running the PR lane's own wiring is strictly
  // more than warning about it, and the dispatch advice is still printed.
  const verdict = canary ? "canary" : dispatch.size > 0 ? "dispatch" : "none";
  return {
    verdict,
    ciFiles: [...new Set(ciFiles)].sort(),
    canarySpecs: canary ? [...CANARY_SPECS] : [],
    dispatchWorkflows: [...dispatch].sort(),
    reasons,
  };
}

// ---------- CLI ----------

function readCiSources(root = ".") {
  const workflows = new Map();
  const wfDir = path.join(root, ".github/workflows");
  for (const entry of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    workflows.set(`.github/workflows/${entry}`, fs.readFileSync(path.join(wfDir, entry), "utf8"));
  }

  const actions = new Map();
  const acDir = path.join(root, ".github/actions");
  if (fs.existsSync(acDir)) {
    for (const entry of fs.readdirSync(acDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(acDir, entry.name, "action.yml");
      if (fs.existsSync(file)) actions.set(entry.name, fs.readFileSync(file, "utf8"));
    }
  }
  return { workflows, actions };
}

function main(argv) {
  const args = argv.slice(2);
  let format = "text";
  let root = ".";
  const changed = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--stdin") {
      changed.push(...fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    } else if (a.startsWith("--format=")) format = a.slice(9);
    else if (a === "--root") root = args[++i];
    else if (!a.startsWith("--")) changed.push(a);
    else {
      process.stderr.write(`::error::ci-change-coverage: unknown argument ${a}\n`);
      process.exit(2);
    }
  }

  let refs;
  try {
    refs = buildCiReferences(readCiSources(root));
  } catch (error) {
    process.stderr.write(`::error::ci-change-coverage could not read .github (${error.message}). Treating as undecidable, not as "no CI change".\n`);
    process.exit(2);
  }

  const result = classifyCiChange({ changed, refs });

  // A canary that points at a renamed spec would run NOTHING while reporting a
  // verdict — the silent-coverage bug this script exists to remove. Fail loud.
  if (result.verdict === "canary") {
    const missing = result.canarySpecs.filter((s) => !fs.existsSync(path.join(root, s)));
    if (missing.length > 0) {
      process.stderr.write(
        `::error::the canary set references ${missing.length} spec(s) that no longer exist: ${missing.join(", ")}. Update CANARY_SPECS in scripts/ci-change-coverage.mjs.\n`,
      );
      process.exit(2);
    }
  }

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const reason of result.reasons) process.stderr.write(`  ${reason}\n`);
  process.stdout.write(`${result.verdict}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("ci-change-coverage.mjs")) {
  main(process.argv);
}
