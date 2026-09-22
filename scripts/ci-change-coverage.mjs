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
 * NAMING A WORKFLOW IS NOT THE SAME AS NAMING A REMEDY (issue #1609)
 *
 * The `dispatch` verdict's whole job is to convert an unprovable skip into an
 * ACTIONABLE instruction, and for its first year it told the reviewer to dispatch
 * a workflow without ever checking that the workflow CAN be dispatched. Measured
 * on PR #1608, a change to `scripts/coverage-summary.ts`:
 *
 *   ::warning::… Dispatch .github/workflows/update-coverage-summary.yml on this
 *   branch before merging (#1159).
 *   $ gh workflow run update-coverage-summary.yml --ref <branch>
 *   HTTP 422: Workflow does not have 'workflow_dispatch' trigger
 *
 * That workflow is `on: push: branches: [main]`. The prescribed remedy cannot be
 * performed on any branch, ever — so the reviewer either burns time discovering
 * the 422 or, more likely, assumes someone else will handle it and merges. Advice
 * nobody can act on is indistinguishable from silence (#1092's lesson, one costume
 * over).
 *
 * So the triggers are read from the same YAML the reference graph already comes
 * from, and the advice is rendered HERE rather than composed in the workflow. The
 * trigger read has three answers, and they are worded separately because a single
 * diff mixes them — a change to `scripts/stable-tests.ts` names daily-stable and
 * weekly-stable, which carry the trigger, alongside update-coverage-summary, which
 * does not:
 *
 *   dispatchable   → dispatch it, as before;
 *   undispatchable → say what is true instead, and say that nothing in CI proves
 *                    this before merge;
 *   unknown        → the `on:` block could not be read. Reported as unknown, never
 *                    folded into either answer (#1012) — a workflow this cannot
 *                    classify must not be silently promised as dispatchable, and
 *                    must not lose a dispatch that would have worked.
 *
 * THE TRIGGER IS NOT THE ONLY WAY TO 422
 *
 * A workflow turned off in the Actions tab answers `HTTP 422: Cannot trigger a
 * workflow_dispatch on a disabled workflow` however good its YAML is, and FOUR of
 * this repo's workflows are `disabled_manually` today — `weekly-stable.yml` among
 * them, which the verdict really does name (it runs `scripts/stable-tests.ts`).
 * A YAML-only answer would have closed #1609 while still prescribing a 422 by the
 * other route.
 *
 * That state is not in the repository, so the workflow fetches it and passes it in
 * (`--workflow-states`, one `path<TAB>state` per line). Absent, it is UNKNOWN and
 * the advice falls back to the trigger alone — deliberately fail-open on this half,
 * unlike the trigger half: a workflow carrying `workflow_dispatch` is dispatchable
 * unless someone disabled it, so caveating every instruction over a lookup that
 * usually succeeds is the noise that gets warnings ignored (#1252). Only a state
 * positively read as non-active changes the wording.
 *
 * Run:
 *   git diff --name-only … | node scripts/ci-change-coverage.mjs --stdin --format=json
 *   node scripts/ci-change-coverage.mjs .github/actions/wait-for-backend/action.yml
 *   … --workflow-states=/tmp/wf-states.json   # `path<TAB>state`, from the Actions API
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

/** The one event that makes `gh workflow run <wf> --ref <branch>` possible. */
export const DISPATCH_TRIGGER = "workflow_dispatch";

/**
 * Drop a YAML comment from one line, leaving quoted `#` alone.
 *
 * Not cosmetic: `issue-contract-guard.yml`'s `on:` block carries eleven comment
 * lines, one of which contains the token `workflow_dispatch` in prose. A grep for
 * the token would read a commented-out trigger as a live one — and the same grep
 * over `nightly.yml`, whose `schedule:` is commented out, would read a dead
 * trigger as live. Both are answers this must not give.
 */
function stripComment(line) {
  let out = "";
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    out += c;
  }
  return out;
}

/**
 * The events a workflow declares, read from its YAML text.
 *
 * Text, not a parser, because this repo's scripts are dependency-free by rule and
 * no YAML library is installed. That bounds what it can promise, so it promises
 * exactly that: the three spellings Actions accepts (`on:` block, `on: [a, b]`
 * flow list, `on: a` scalar — each optionally quoted), and `null` for anything
 * else, with the reason attached. Measured against all 18 workflows in this repo:
 * 18 decided, 0 unknown.
 *
 * @returns {{events: string[]|null, note?: string}}
 */
export function readWorkflowTriggers(text) {
  const lines = String(text).split("\n");
  const start = lines.findIndex((l) => /^(?:on|"on"|'on')\s*:/.test(l));
  if (start === -1) return { events: null, note: "no top-level `on:` key" };
  const head = stripComment(lines[start]).replace(/^(?:on|"on"|'on')\s*:/, "").trim();

  // `on: [push, workflow_dispatch]`, possibly spread over several lines.
  if (head.startsWith("[")) {
    let flow = head;
    for (let i = start + 1; !flow.includes("]") && i < lines.length; i += 1) {
      flow += ` ${stripComment(lines[i]).trim()}`;
    }
    if (!flow.includes("]")) return { events: null, note: "unterminated `on: [ ... ]` list" };
    const events = flow
      .slice(flow.indexOf("[") + 1, flow.indexOf("]"))
      .split(",")
      .map((e) => e.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    return events.length ? { events } : { events: null, note: "empty `on: [ ]` list" };
  }

  // `on: workflow_dispatch`
  if (head) {
    const name = head.replace(/^["']|["']$/g, "");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      ? { events: [name] }
      : { events: null, note: `unrecognised inline \`on:\` value (${head})` };
  }

  // Block form. Events are the keys at the block's own indentation; anything
  // deeper (`branches:`, `types:`, a `- cron:` item) is that event's detail.
  const events = [];
  let indent = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = stripComment(lines[i]);
    if (!line.trim()) continue;
    const width = line.length - line.trimStart().length;
    if (width === 0) break; // the next top-level key
    if (indent === null) indent = width;
    if (width > indent) continue;
    if (width < indent) break;
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (key) {
      events.push(key[1]);
      continue;
    }
    const item = /^\s*-\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/.exec(line);
    if (item) {
      events.push(item[1]);
      continue;
    }
    return { events: null, note: `unrecognised line in the \`on:\` block: ${line.trim()}` };
  }
  return events.length ? { events } : { events: null, note: "`on:` block declares no events" };
}

/**
 * Can `gh workflow run <workflow> --ref <branch>` fire this workflow?
 *
 * Three states on purpose. `null` is not "probably yes": a workflow whose triggers
 * could not be read is reported as unreadable, because promising a dispatch that
 * 422s is the defect this exists to remove and withholding one that would have
 * worked costs real pre-merge coverage.
 *
 * @returns {{dispatchable: boolean|null, triggers: string[]|null, note?: string}}
 */
export function workflowDispatchability(text) {
  const { events, note } = readWorkflowTriggers(text);
  if (!events) return { dispatchable: null, triggers: null, note };
  return { dispatchable: events.includes(DISPATCH_TRIGGER), triggers: events };
}

/**
 * Parse `path<TAB>state` lines — the Actions API's own answer, as the workflow
 * fetches it:
 *
 *   gh api repos/{owner}/{repo}/actions/workflows --paginate \
 *     --jq '.workflows[] | .path + "\t" + .state'
 *
 * Only `active` can be dispatched; `disabled_manually`, `disabled_inactivity` and
 * `disabled_fork` all 422. Rows that are not workflow paths (the API also returns
 * `dynamic/...` entries for app-provided workflows) simply never match a key.
 *
 * @returns {Map<string, boolean>} path → enabled
 */
export function parseWorkflowStates(text) {
  const states = new Map();
  for (const line of String(text).split("\n")) {
    const [file, state] = line.split("\t");
    if (!file || !state) continue;
    states.set(file.trim(), state.trim() === "active");
  }
  return states;
}

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
  const workflowDispatch = new Map();
  for (const [file, text] of workflows) {
    workflowDispatch.set(file, workflowDispatchability(text));
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

  return { workflowScripts, workflowActions, actionScripts, workflowDispatch };
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
 * @param states optional `Map<path, enabled>` from the Actions API; absent leaves
 *               every workflow's enabled state unknown (see the header).
 * @returns {{verdict: 'canary'|'dispatch'|'none', ciFiles: string[],
 *            canarySpecs: string[], dispatchWorkflows: string[],
 *            dispatchTargets: {workflow: string, dispatchable: boolean|null,
 *                              enabled: boolean|null, triggers: string[]|null,
 *                              note?: string}[],
 *            reasons: string[]}}
 */
export function classifyCiChange({ changed, refs, states = null }) {
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
  const dispatchWorkflows = [...dispatch].sort();
  return {
    verdict,
    ciFiles: [...new Set(ciFiles)].sort(),
    canarySpecs: canary ? [...CANARY_SPECS] : [],
    dispatchWorkflows,
    // Every named workflow carries whether it can actually BE dispatched (#1609).
    // A workflow the reference graph knows but whose triggers were never read is
    // `null` here, not `true` — the same absent-means-unknown rule the CLI applies
    // to `.github` it cannot read at all.
    dispatchTargets: dispatchWorkflows.map((workflow) => ({
      workflow,
      ...(refs.workflowDispatch?.get(workflow) ?? {
        dispatchable: null,
        triggers: null,
        note: "the workflow's YAML was not among the sources this ran over",
      }),
      // `null` when no state was supplied: not known to be off, which is the one
      // place this fails OPEN — see the header.
      enabled: states?.has(workflow) ? states.get(workflow) : null,
    })),
    reasons,
  };
}

// ---------- advice ----------

const list = (items) => items.join(", ");

/**
 * Turn the verdict into the words a reviewer reads, in both shapes the lane needs.
 *
 * One renderer, because the two surfaces used to compose their own: the `::warning::`
 * was built inline in `pr-validation.yml` with `jq`, which is exactly where #1226
 * established that a guard pinning a SPELLING cannot pin a BEHAVIOUR. The assertions
 * on this are about output — given a workflow with no `workflow_dispatch`, the message
 * does not tell anyone to dispatch it.
 *
 * @param result `classifyCiChange`'s return value.
 * @returns {{annotation: string|null, summaryLines: string[]}}
 */
export function dispatchAdvice(result) {
  if (!result || result.verdict !== "dispatch") return { annotation: null, summaryLines: [] };

  const targets =
    result.dispatchTargets ??
    (result.dispatchWorkflows ?? []).map((workflow) => ({
      workflow,
      dispatchable: null,
      triggers: null,
      note: "this verdict predates the dispatchability check",
    }));
  // Four buckets, because there are two independent ways to 422 and one way not to
  // know. `enabled === false` outranks a present trigger: the YAML is right and the
  // dispatch still fails.
  const yes = targets.filter((t) => t.dispatchable === true && t.enabled !== false).map((t) => t.workflow);
  const off = targets.filter((t) => t.dispatchable === true && t.enabled === false);
  const no = targets.filter((t) => t.dispatchable === false);
  const unknown = targets.filter((t) => t.dispatchable !== true && t.dispatchable !== false);
  const blocked = [...off, ...no, ...unknown];

  const sentences = [
    `CI-only change to ${list(result.ciFiles ?? [])}, which THIS lane does not run — nothing here proves it works.`,
  ];
  if (yes.length > 0) sentences.push(`Dispatch ${list(yes)} on this branch before merging (#1159).`);
  for (const t of off) {
    sentences.push(
      `${t.workflow} has a ${DISPATCH_TRIGGER} trigger but is DISABLED in Actions, so dispatching it answers 422.`,
    );
  }
  for (const t of no) {
    sentences.push(
      `${t.workflow} cannot be dispatched on a branch — it has no ${DISPATCH_TRIGGER} trigger (runs on: ${list(t.triggers ?? [])}).`,
    );
  }
  for (const t of unknown) {
    sentences.push(
      `Could not read the triggers of ${t.workflow} (${t.note ?? "no reason recorded"}) — confirm it is dispatchable before relying on this.`,
    );
  }
  if (yes.length === 0 && blocked.length > 0) {
    sentences.push(
      "Nothing in CI can prove this change before merge: rely on the unit lanes and local verification, and watch the post-merge run (#1609).",
    );
  }

  const summaryLines = [];
  if (yes.length > 0) {
    summaryLines.push(
      "- ⚠️ **CI-only change with no runtime coverage here** — the changed surface belongs to another lane. Dispatch before merging:",
      ...yes.map((wf) => `  - \`${wf}\``),
    );
  }
  for (const t of off) {
    summaryLines.push(
      `- ⛔ **\`${t.workflow}\` is disabled in Actions** — it declares \`${DISPATCH_TRIGGER}\`, but dispatching a disabled workflow answers 422. Re-enable it first, or treat this surface as proven only after merge (#1609).`,
    );
  }
  for (const t of no) {
    summaryLines.push(
      `- ⛔ **\`${t.workflow}\` cannot be dispatched on a branch** — no \`${DISPATCH_TRIGGER}\` trigger (runs on: ${(t.triggers ?? []).map((e) => `\`${e}\``).join(", ")}). Nothing in CI proves this part before merge: rely on the unit lanes and local verification, and watch the post-merge run (#1609).`,
    );
  }
  for (const t of unknown) {
    summaryLines.push(
      `- ❔ **\`${t.workflow}\` — trigger list unreadable** (${t.note ?? "no reason recorded"}). Confirm it is dispatchable before relying on the advice above (#1609).`,
    );
  }

  return { annotation: sentences.join(" "), summaryLines };
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
  let statesFile = null;
  const changed = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--stdin") {
      changed.push(...fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    } else if (a.startsWith("--format=")) format = a.slice(9);
    else if (a === "--root") root = args[++i];
    else if (a.startsWith("--workflow-states=")) statesFile = a.slice(18);
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

  // Best-effort by design: a state file the lane could not fetch (no `actions: read`,
  // a rate limit) leaves every workflow's state unknown and the advice falls back to
  // the trigger alone. Unreadable is NOT silent, though — it prints, because a
  // dispatch instruction for a disabled workflow is the defect this half removes.
  let states = null;
  if (statesFile) {
    try {
      states = parseWorkflowStates(fs.readFileSync(statesFile, "utf8"));
    } catch (error) {
      process.stderr.write(
        `::warning::ci-change-coverage could not read ${statesFile} (${error.message}); a workflow disabled in Actions will not be flagged.\n`,
      );
    }
  }

  const result = classifyCiChange({ changed, refs, states });

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

  // The annotation ships IN the verdict so the workflow prints it rather than
  // composing it (#1226): `echo "::warning::$(jq -r '.advice' …)"`. Null on every
  // verdict but `dispatch`, which is what keeps the canary branch unchanged.
  const advice = { ...result, advice: dispatchAdvice(result).annotation };

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(advice, null, 2)}\n`);
    return;
  }
  for (const reason of result.reasons) process.stderr.write(`  ${reason}\n`);
  process.stdout.write(`${result.verdict}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("ci-change-coverage.mjs")) {
  main(process.argv);
}
