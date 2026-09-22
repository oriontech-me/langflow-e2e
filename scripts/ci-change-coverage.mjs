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
 * ACTIONABLE instruction, and from the day it shipped (2026-07-30, #1159) it told
 * the reviewer to dispatch a workflow without ever checking that the workflow CAN be
 * dispatched. Measured on PR #1608, a change to `scripts/coverage-summary.ts`:
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
 * So the triggers are read from the YAML the reference graph already comes from, and
 * the advice is rendered HERE rather than composed in the workflow. Six answers,
 * worded separately because ONE diff mixes them — a change to
 * `scripts/stable-tests.ts` names daily-stable (dispatchable), weekly-stable
 * (disabled) and update-coverage-summary (no trigger) at once, so flipping the whole
 * message on its worst member would withhold the one dispatch that does work:
 *
 *   yes         → dispatch it, as before;
 *   absent      → not on the default branch yet, so a dispatch answers 404;
 *   off         → disabled in the Actions tab, so a dispatch answers 422;
 *   no          → no `workflow_dispatch` trigger at all;
 *   unknown     → the `on:` block could not be read;
 *   unverified  → this PR edits that very file, and the copy read is not the one
 *                 GitHub resolves against.
 *
 * `bucket()` tests them in that order, which is by CERTAINTY rather than by severity.
 * `absent` and `off` are answers about the DEFAULT BRANCH — `off` from the Actions
 * listing, `absent` from the listing or the base tree, neither of them from the copy
 * on this branch — so they hold whatever the trigger read said, and a workflow known
 * to be off is reported as off even when its `on:` block was unreadable. Everything
 * below them is DERIVED from the trigger read, so `unverified` outranks all of it:
 * when the read did not come from the deciding copy, "it has no trigger" is as
 * unfounded as "it has one".
 *
 * The last two are DOUBTS, and the distinction is load-bearing. Only the established
 * answers license the closing "nothing in CI can prove this change before merge";
 * folding a doubt into it is exactly what #1012 forbids, and both directions have
 * been live here — `unknown` asserting the conclusion, and `no` claiming a PR that
 * REMOVES the trigger had definitively broken dispatch.
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
 * "Absent" is the load-bearing word, and it is why the listing has a FLOOR: absence
 * from it is read as "not on the default branch", so an EMPTY listing is not a weak
 * signal but a confident 404 claim about every workflow at once — measured, a
 * zero-byte file produced three of them about three workflows that are all on `main`.
 * `gh` can exit 0 having written nothing, so exit status is not the guard.
 *
 * AND THE TRIGGER THAT COUNTS IS THE ONE ON THE DEFAULT BRANCH
 *
 * GitHub resolves `workflow_dispatch` from the DEFAULT branch, not from the ref you
 * dispatch. This repo already records that, in a file this very parser reads
 * (`issue-contract-guard.yml`: "GitHub requires a workflow_dispatch workflow to
 * exist on the DEFAULT branch before it can be dispatched at all (API 404s
 * otherwise), so this could NOT validate the very PR that introduced it").
 *
 * Reading the PR head's YAML would therefore have reproduced #1609 on the two diffs
 * most likely to hit it: a PR that ADDS a workflow (dispatch answers 404) and a PR
 * that ADDS `workflow_dispatch` to an existing one — which is #1609's own Option B,
 * so the next PR against it would have been handed, verbatim, the warning #1609 was
 * filed about. `--base-root` therefore points at the DEFAULT BRANCH's `.github` tree
 * and the triggers come from there; the reference graph still comes from the head,
 * because the graph must reflect the wiring the PR proposes.
 *
 * The lane passes `github.event.repository.default_branch` rather than the PR base
 * because that is the semantically right input, NOT because a live hole was closed:
 * `pr-validation.yml` is `on: pull_request: branches: [main]`, and that filter is on
 * the base, so this lane can never see a PR whose base is not the default. The two
 * are the same value by construction here — the switch is against a future edit to
 * that trigger, and reading it as a fixed bug would overstate it.
 *
 * Without `--base-root` the branch copy is used and any named workflow the PR
 * CHANGED is reported unverified. Only those, because those are the ones the PR can
 * be held responsible for — a workflow that moved on the default branch since the
 * fork point is also read stale here and carries no caveat, which is a real though
 * much smaller gap and the price of not caveating every instruction (#1252).
 *
 * The two sources of "is it on the default branch" — the Actions listing and the
 * base tree — DISAGREE in exactly one case: a workflow this PR adds that has already
 * registered itself with Actions, which its own `pull_request` run does. So ABSENCE
 * from either wins over presence in the other; reading that presence as an answer is
 * a `Dispatch` for a 404.
 *
 * Run:
 *   git diff --name-only … | node scripts/ci-change-coverage.mjs --stdin --format=json
 *   node scripts/ci-change-coverage.mjs .github/actions/wait-for-backend/action.yml
 *   … --workflow-states=/tmp/wf-states.tsv   # `path<TAB>state`, from the Actions API
 *   … --base-root=/tmp/base-ci               # the DEFAULT branch's `.github` tree
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

import { buildImporterGraph } from "./impacted-specs-by-import.mjs";

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

// `/` is IN the tail (issue #1979). Without it the match stopped at the first path
// separator, so `scripts/lib/stable-tests.ts` was captured as `scripts/lib` — a token
// no changed path can ever equal — and the real file matched nothing, leaving the
// verdict at `none`: "the diff touches no CI surface at all". Measured over the real
// `.github/`, widening it takes the token set from 47 to 51: the five `scripts/lib/**`
// paths appear and the directory token `scripts/lib` goes, which is the right trade
// because a directory is never a changed FILE. Three inert keys are unchanged and stay
// inert — two are a real filename followed by a sentence-ending period (the `.` in this
// class absorbs it), one is the literal `scripts/x` out of this file's own prose. Those
// periods are NOT what keeps a unit test out: `UNIT_TEST` below does that, as its live
// sibling `daily-matrix-provider-keys.test.mjs` shows — a real token, resolving to
// `none`. Belt and braces, not a single point of failure.
const SCRIPT_REF = /(?:^|[^\w/])(scripts\/[A-Za-z0-9._/-]+)/g;

/** A unit test — covered by `npm run test:scripts`, never CI wiring. */
const UNIT_TEST = /\.test\.(mjs|mts|ts|js)$/;
const LOCAL_ACTION_REF = /\.\/\.github\/actions\/([A-Za-z0-9._-]+)/g;

const matchAll = (text, re) => [...String(text).matchAll(re)].map((m) => m[1]);

/** The one event that makes `gh workflow run <wf> --ref <branch>` possible. */
export const DISPATCH_TRIGGER = "workflow_dispatch";

/**
 * Drop a YAML comment from one line, leaving quoted `#` alone.
 *
 * Not cosmetic: `issue-contract-guard.yml`'s `on:` block is mostly comment, and one
 * of those lines contains the token `workflow_dispatch` in prose. A grep for the
 * token would read that as a live trigger — and the same grep over `nightly.yml`,
 * whose `schedule:` is commented out, would read a dead trigger as live. Both are
 * answers this must not give.
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
 * exactly that: the four shapes Actions accepts — an `on:` block, an `on: [a, b]`
 * flow list, an `on: a` scalar, and a `- a` sequence (indented OR at column 0, which
 * YAML allows for a block's items and which a first draft rejected) — with the `on:`
 * key and each event name optionally quoted; anything else is `null`, with the
 * reason attached.
 * Every failure mode found so far degrades to `null` rather than to a wrong boolean,
 * which is the direction that matters: a wrong `true` is #1609 again. Measured
 * against all 18 workflows in this repo: 18 decided, 0 unknown, pinned below.
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
  // deeper (`branches:`, `types:`) is that event's detail.
  const events = [];
  let indent = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = stripComment(lines[i]);
    if (!line.trim()) continue;
    const width = line.length - line.trimStart().length;
    // A block's items may sit at the PARENT's indentation, so a sequence under a
    // column-0 `on:` is legal at column 0 too. That is the only shape that survives
    // a width of zero; anything else there is the next top-level key.
    const seqItem = /^-\s/.test(line);
    if (width === 0 && !(seqItem && (indent === null || indent === 0))) break;
    if (indent === null) indent = width;
    if (width > indent) continue;
    if (width < indent) break;
    // Quoted keys are accepted: `"workflow_dispatch":` is what Actions reads, and
    // rejecting it would report a dispatchable workflow as unreadable.
    const key = /^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/.exec(line);
    if (key) {
      events.push(key[1]);
      continue;
    }
    // A `-` item at the block's own indentation is legal YAML for BOTH shapes, and
    // the colon tells them apart: `- push` is an item of `on:` itself (an event),
    // `- cron: "0 5 * * *"` is a mapping item belonging to the key above it.
    const item = /^\s*-\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/.exec(line);
    if (item) {
      events.push(item[1]);
      continue;
    }
    if (/^\s*-\s/.test(line)) continue;
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
 * An EMPTY listing is `null`, not an empty map, and the floor is load-bearing rather
 * than tidy: absence from this listing is read as "not on the default branch", so an
 * empty map is not a weak signal, it is a confident claim that EVERY workflow is
 * missing — measured, a zero-byte file produced three `answers 404 until this merges`
 * sentences about three workflows that are all on `main`. `gh` can exit 0 having
 * written nothing, so exit status is not the guard. Same rule as `snapshotCatalog`'s
 * `--min-categories`: a wrong baseline is permanent and silent.
 *
 * @returns {Map<string, boolean>|null} path → enabled, or null for no listing at all
 */
export function parseWorkflowStates(text) {
  const states = new Map();
  for (const line of String(text).split("\n")) {
    const [file, state] = line.split("\t");
    if (!file || !state) continue;
    states.set(file.trim(), state.trim() === "active");
  }
  // The floor counts WORKFLOW rows, not rows. The API's `dynamic/…` entries (4 of
  // the 22 this repo's listing returns) can never match a key, so a listing holding
  // only those would clear a `size > 0` floor and then report every real workflow as
  // absent — the same false 404, one notch up.
  const workflows = [...states.keys()].filter((f) => f.startsWith(".github/workflows/"));
  return workflows.length > 0 ? states : null;
}

/**
 * Build the reference graph from the YAML itself.
 *
 * @param {{workflows: Map<string,string>, actions: Map<string,string>,
 *          baseWorkflows?: Map<string,string>|null,
 *          scriptFiles?: Map<string,string>|null}} sources
 *   workflows keyed by repo-relative path, actions keyed by ACTION NAME.
 *   `baseWorkflows` is the DEFAULT branch's copy of the same workflows; when given, the
 *   triggers are read from it, because that is the copy GitHub resolves a dispatch
 *   against. The reference graph always comes from `workflows` (the head).
 *   `scriptFiles` is `scripts/**` keyed by repo-relative path; when given, a changed
 *   file also counts as CI surface if some NAMED script imports it, transitively.
 */
export function buildCiReferences({ workflows, actions, baseWorkflows = null, scriptFiles = null }) {
  const actionScripts = new Map();
  for (const [name, text] of actions) {
    actionScripts.set(name, new Set(matchAll(text, SCRIPT_REF)));
  }

  // Triggers come from the base copy when there is one. A workflow the head has and
  // the base does not was ADDED by this PR, so Actions does not know it yet — left
  // out of the map, which is how `classifyCiChange` tells that apart from "we never
  // looked".
  const triggerSources = baseWorkflows ?? workflows;
  const workflowDispatch = new Map();
  for (const [file, text] of triggerSources) {
    workflowDispatch.set(file, workflowDispatchability(text));
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

  // module → every script that imports it, transitively. The regex above only ever
  // sees what the YAML SPELLS, and a shared module is spelled nowhere: of the 24
  // `scripts/lib/**` files this now reaches, **5 are named** under `.github/` and the
  // other **19 only by import** (#1979), so a fix confined to the regex would have
  // covered a fifth of them. `scripts/lib/spec-path.mjs` is the sharp case — the one
  // normaliser two lanes must agree on, whose own doc says a near-miss there
  // "corroborates nothing, exempts nothing and is invisible" — and it is one of the 19.
  //
  // This is the same indirection `uses:` already gets, one level further in, and it
  // reuses `impacted-specs-by-import.mjs`'s resolver rather than a second copy: those
  // three functions take a file map keyed by repo-relative path and are root-agnostic,
  // so nothing about them was tests-specific.
  const scriptImporters = scriptFiles ? buildImporterGraph(scriptFiles) : null;

  return {
    workflowScripts,
    workflowActions,
    actionScripts,
    workflowDispatch,
    scriptImporters,
    // Whether `workflowDispatch` reflects the copy GitHub will actually resolve.
    triggersFromBase: Boolean(baseWorkflows),
  };
}

/**
 * Every script that reaches `file` by import, transitively, excluding `file` itself.
 *
 * Breadth-first with a `seen` set. Defensive rather than observed: measured over all
 * 182 source files under `scripts/`, the real importer graph has NO cycle today and
 * an unguarded walk terminates for every one of them. It is kept because the shape
 * that loops is cheap to introduce and expensive to diagnose — a cycle among a file's
 * importers that does not pass back through the file itself, where the
 * `importer === file` skip cannot break it, and where a walk does not fail the step,
 * it hangs it.
 */
export function importersOf(refs, file) {
  const reached = new Set();
  if (!refs.scriptImporters) return reached;
  const queue = [file];
  // A hard bound as well as the `seen` set, because the two failure modes are not the
  // same thing to live with. The `seen` set makes the walk terminate; the bound makes
  // a walk that DOESN'T terminate fail LOUDLY instead of spinning — in CI a step that
  // burns its whole budget and reports nothing, and in the unit lane a file that hangs
  // at `0 pass / 0 fail`. A synchronous loop is not interruptible, so `node:test`'s own
  // `timeout` cannot turn that into a red test either: measured, it does not fire.
  // Every node can enter the queue at most once, so the graph's size is a true ceiling
  // and this can only ever fire on a guard that is already broken.
  let budget = refs.scriptImporters.size + 1;
  while (queue.length > 0) {
    if (budget-- <= 0) {
      throw new Error(`importersOf walked past ${refs.scriptImporters.size} nodes from ${file} — the cycle guard is broken`);
    }
    const current = queue.shift();
    for (const importer of refs.scriptImporters.get(current) ?? []) {
      if (importer === file || reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }
  return reached;
}

/**
 * Workflows OTHER THAN THE PR LANE that reach a given action or script.
 *
 * The exclusion was the doc comment's claim and not the code's behaviour, which was
 * inert while this was only ever called for a surface the PR lane does not reach. It
 * stopped being inert when a file became able to be canary AND dispatch at once: the
 * PR lane turned up in the list of workflows to dispatch before merging, which is a
 * lane that has already run.
 */
function workflowsReaching(refs, { action, script }) {
  const hits = [];
  for (const [file, used] of refs.workflowActions) {
    if (file !== PR_LANE && action && used.has(action)) hits.push(file);
  }
  for (const [file, scripts] of refs.workflowScripts) {
    if (file !== PR_LANE && script && scripts.has(script) && !hits.includes(file)) hits.push(file);
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
      // Both halves here too. A shared action is the commonest thing in this repo to
      // be used by the PR lane AND by three other lanes — `wait-for-backend` is used
      // by four — and the canary branch dropped every one of them, so the diff that
      // MOTIVATED this whole classifier (#1045 rewired four workflows onto one action)
      // named none of the lanes it changed. This is the rule the file states at the
      // verdict line, applied where it was claimed to already hold.
      const users = workflowsReaching(refs, { action: actionName });
      users.forEach((w) => dispatch.add(w));
      if (prActions.has(actionName)) {
        canary = true;
        const also = users.length ? `, and by ${users.join(", ")}` : "";
        reasons.push(`.github/actions/${actionName} is used by the PR lane${also}`);
      } else {
        reasons.push(
          users.length
            ? `.github/actions/${actionName} is used by ${users.join(", ")}, not by the PR lane`
            : `.github/actions/${actionName} is referenced by NO workflow — dead action, or a reference this script cannot see`,
        );
      }
      continue;
    }

    // A script is CI surface only if some workflow or action actually runs it —
    // directly, or THROUGH a script that does. `scripts/foo.test.mjs` and a helper
    // nothing invokes are still not: nobody imports a test file, and a module only a
    // test imports has no named importer, so both keep falling through to `none`.
    // A unit test is never CI WIRING, whatever a YAML comment happens to spell. Two
    // of them are named under `.github/` today — `daily-matrix-provider-keys.test.mjs`
    // and `sync-model-prices.test.mjs`, both in prose explaining what pins what — so
    // on `main` a change to either already resolves to `dispatch`, contradicting the
    // rule stated right below. That was inert while imports were not followed; it is
    // not any more, because such a file would drag its whole import closure in with
    // it (measured: `lib/tmp-dir.mjs`, imported by nothing else, arrived as
    // `dispatch` through exactly that route). These files are covered by
    // `npm run test:scripts`, which the PR lane runs as its own gate, so booting
    // Langflow for one proves nothing it does not already know.
    const named = (f) => !UNIT_TEST.test(f) && [...refs.workflowScripts.values()].some((s) => s.has(f));
    // The entry points a change to `file` reaches — the UNION of the two routes, not
    // the first one that answers. `scripts/lib/stable-tests.ts` is both: named by
    // `update-coverage-summary.yml`'s `paths:` filter AND imported by
    // `scripts/stable-tests.ts`, which two other lanes run. Preferring the direct
    // route named one workflow and dropped the others, which is the under-report this
    // issue is about wearing a smaller hat.
    const viaImport = [...importersOf(refs, file)].filter(named);
    const entryPoints = [...new Set([...(named(file) ? [file] : []), ...viaImport])].sort();
    if (entryPoints.length === 0) continue;
    ciFiles.push(file);
    // Both halves, always — the top-level rule this file already states for workflows
    // and actions ("canary wins over dispatch, and the dispatch advice SURVIVES") was
    // not being applied here. Measured: `scripts/reconcile-stable-orphans.ts` went
    // `dispatch` → `canary` and lost "Dispatch stable-orphan-reconcile.yml" entirely,
    // and `scripts/lib/stable-tests.ts` reached the canary while naming ZERO of the
    // four workflows it affects — the under-report this issue is about, one level in.
    const onPrLane = entryPoints.some((entry) => prScripts.has(entry));
    const users = [...new Set(entryPoints.flatMap((entry) => workflowsReaching(refs, { script: entry })))].sort();
    users.forEach((w) => dispatch.add(w));
    const route = viaImport.length > 0 ? ` (reached through ${viaImport.sort().join(", ")})` : "";
    const alsoDispatch = users.length > 0 ? `, and by ${users.join(", ")}` : "";
    if (onPrLane) {
      canary = true;
      // `directly` is stated ALONGSIDE the import route, not replaced by it:
      // `impacted-specs-by-import.mjs` is invoked by name AND imported by two other
      // named scripts, and naming only the indirection read as if it were not. The
      // predicate is `prScripts`, not `named`: `named` asks whether ANY workflow
      // spells the file, and this sentence is about THE PR LANE — with `named` it
      // claimed the PR lane ran `reconcile-stable-orphans.ts` directly, which
      // `pr-validation.yml` does not mention at all.
      const direct = prScripts.has(file) ? " directly or through an action it uses" : "";
      reasons.push(`${file} is run by the PR lane${direct}${route}${alsoDispatch}`);
    } else {
      // Symmetrically: a file another lane runs BY NAME and also reaches by import
      // should not read as though only the indirection got it there.
      const direct = named(file) ? " directly" : "";
      reasons.push(`${file} is run${direct} by ${users.join(", ")}, not by the PR lane${route}`);
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
    dispatchTargets: dispatchWorkflows.map((workflow) => {
      const read = refs.workflowDispatch?.get(workflow);
      // Two independent sources can answer "is this on the default branch" — the
      // Actions listing, and the base tree. ABSENCE from either is definitive, so
      // absence WINS: the two disagree exactly when a workflow this PR adds has
      // already registered itself with Actions (its own `pull_request` run does
      // that), and reading that as presence is a `Dispatch` for a 404. `true` needs
      // every available source to have found it; neither available is `null`.
      const evidence = [
        states ? states.has(workflow) : null,
        refs.triggersFromBase ? Boolean(read) : null,
      ].filter((e) => e !== null);
      const onDefaultBranch = evidence.length === 0 ? null : evidence.every(Boolean);
      return {
        workflow,
        ...(read ?? {
          dispatchable: null,
          triggers: null,
          note: "the workflow's YAML was not among the sources this ran over",
        }),
        // `null` when no state was supplied: not known to be off, which is the one
        // place this fails OPEN — see the header.
        enabled: states?.has(workflow) ? states.get(workflow) : null,
        onDefaultBranch,
        // True when the trigger answer came from the head and this PR edits that
        // file, so the copy GitHub resolves against is NOT the one that was read.
        triggersUnverified: !refs.triggersFromBase && changed.includes(workflow),
      };
    }),
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
  // A CANARY can carry dispatch targets too, and withholding them was the other half
  // of the swallow: `scripts/reconcile-stable-orphans.ts` used to produce
  // "Dispatch stable-orphan-reconcile.yml on this branch before merging" and, once it
  // became canary-reachable, produced `advice: null` — a strict LOSS against the
  // behaviour before any of this. The canary proves this lane boots; it says nothing
  // about the other lanes the same diff reaches, so their instruction still has to be
  // printed. `none` has nothing to say by definition.
  if (!result || (result.verdict !== "dispatch" && result.verdict !== "canary")) {
    return { annotation: null, summaryLines: [] };
  }
  if (result.verdict === "canary" && (result.dispatchTargets ?? result.dispatchWorkflows ?? []).length === 0) {
    return { annotation: null, summaryLines: [] };
  }

  const targets =
    result.dispatchTargets ??
    (result.dispatchWorkflows ?? []).map((workflow) => ({
      workflow,
      dispatchable: null,
      triggers: null,
      note: "this verdict predates the dispatchability check",
    }));
  // One bucket per target, first match wins — the order is by how CERTAIN the answer
  // is, so a workflow known to be off is reported as off even when its triggers were
  // unreadable, rather than losing the one fact that WAS established.
  const bucket = (t) => {
    // `absent` and `off` are answers about the DEFAULT BRANCH — `off` from the
    // Actions listing, `absent` from the listing or the base tree, neither of them
    // from the copy on this branch — so they hold whatever the trigger read said,
    // and they go first. Everything below is DERIVED from that read, so `unverified`
    // outranks all of it: when the read did not come from the copy GitHub resolves,
    // "it has no trigger" is as unfounded as "it has one". A first draft tested `no`
    // ahead of `unverified` and therefore reported a PR that REMOVES the trigger as
    // definitively undispatchable — the same inversion in the other direction, and
    // `no` licenses the closing conclusion where a doubt must not.
    if (t.onDefaultBranch === false) return "absent";
    if (t.enabled === false) return "off";
    if (t.triggersUnverified) return "unverified";
    if (t.dispatchable === false) return "no";
    if (t.dispatchable !== true) return "unknown";
    return "yes";
  };
  const of = (name) => targets.filter((t) => bucket(t) === name);
  const yes = of("yes").map((t) => t.workflow);
  const absent = of("absent");
  const off = of("off");
  const no = of("no");
  const unknown = of("unknown");
  const unverified = of("unverified");
  // Only the answers that ESTABLISH a workflow cannot be dispatched license the
  // closing "nothing in CI can prove this". `unknown` and `unverified` are doubts,
  // and folding a doubt into a conclusion is exactly what the header forbids (#1012).
  const blocked = [...absent, ...off, ...no];

  const onCanary = result.verdict === "canary";
  const sentences = [
    onCanary
      ? "The canary proves THIS lane boots; it does not exercise the other lanes this diff reaches."
      : `CI-only change to ${list(result.ciFiles ?? [])}, which THIS lane does not run — nothing here proves it works.`,
  ];
  if (yes.length > 0) sentences.push(`Dispatch ${list(yes)} on this branch before merging (#1159).`);
  for (const t of absent) {
    sentences.push(
      `${t.workflow} does not exist on the default branch yet — GitHub resolves ${DISPATCH_TRIGGER} from there, so dispatching it answers 404 until this merges.`,
    );
  }
  for (const t of off) {
    sentences.push(
      `${t.workflow} is DISABLED in Actions, so dispatching it answers 422 whatever its YAML says.`,
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
  for (const t of unverified) {
    // Worded over the DOUBT, not over what the branch copy happens to say: this
    // bucket holds a PR that adds the trigger and a PR that removes it alike, and
    // naming either reading would be the thing that is not known.
    sentences.push(
      `This PR edits ${t.workflow}, and GitHub resolves ${DISPATCH_TRIGGER} from the default branch rather than from this one — confirm there whether it is dispatchable; the copy on this branch is not the one that decides.`,
    );
  }
  // The closing claim is about the WHOLE change, so every named workflow has to be
  // established — not merely every ESTABLISHED one. Excluding the doubts from
  // `blocked` was only half the rule: with one `no` beside one `unknown`, `blocked`
  // is non-empty and `yes` is empty, and the sentence fired while a named workflow
  // may well have been dispatchable. Each per-target line is careful to scope itself
  // ("nothing in CI proves THIS PART"); this one cannot be, so it needs silence
  // whenever anything is unresolved.
  // …and never on a canary, where something in CI demonstrably did run.
  if (!onCanary && yes.length === 0 && blocked.length > 0 && unknown.length === 0 && unverified.length === 0) {
    sentences.push(
      "Nothing in CI can prove this change before merge: rely on the unit lanes and local verification, and watch the post-merge run (#1609).",
    );
  }

  const summaryLines = [];
  if (yes.length > 0) {
    summaryLines.push(
      onCanary
        ? "- ⚠️ **the diff also reaches a lane the canary cannot exercise.** Dispatch before merging:"
        : "- ⚠️ **CI-only change with no runtime coverage here** — the changed surface belongs to another lane. Dispatch before merging:",
      ...yes.map((wf) => `  - \`${wf}\``),
    );
  }
  for (const t of absent) {
    summaryLines.push(
      `- ⛔ **\`${t.workflow}\` is not on the default branch yet** — GitHub resolves \`${DISPATCH_TRIGGER}\` from there, so dispatching it answers 404 until this merges (#1609).`,
    );
  }
  for (const t of off) {
    summaryLines.push(
      `- ⛔ **\`${t.workflow}\` is disabled in Actions** — dispatching a disabled workflow answers 422 whatever its YAML says. Re-enable it first, or treat this surface as proven only after merge (#1609).`,
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
  for (const t of unverified) {
    summaryLines.push(
      `- ❔ **\`${t.workflow}\` — this PR edits it**, and GitHub resolves \`${DISPATCH_TRIGGER}\` from the default branch, not from this one. The copy on this branch does not decide; confirm there before relying on the advice above (#1609).`,
    );
  }

  return { annotation: sentences.join(" "), summaryLines };
}

// ---------- CLI ----------

/**
 * @param withScripts read `scripts/**` too. False for the DEFAULT-branch tree, which
 *   the lane materialises with `git archive … .github/workflows` and therefore has no
 *   `scripts/` at all — reading it there printed a `could not read scripts/` warning
 *   on every run, stating the opposite of the verdict beside it, over a map only
 *   `.workflows` is taken from anyway.
 */
function readCiSources(root = ".", { withScripts = true } = {}) {
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
  return { workflows, actions, scriptFiles: withScripts ? readScriptFiles(root) : null };
}

/**
 * `scripts/**` as a path → source map, for the importer graph (#1979).
 *
 * Unreadable OR EMPTY both warn and return `null`. The warning is the whole point:
 * `null` and an empty Map are behaviourally identical downstream — both build no
 * graph, so every import-only change resolves to `none` — so a floor that only
 * changed the return value would have been a no-op wearing the language of a guard.
 * What has to differ is that the reader is TOLD, because `none` on this path reads as
 * "there is no CI surface here" rather than "this could not be worked out" (#1012).
 */
function readScriptFiles(root = ".") {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Same skips as `readSuiteFiles`, its sibling in `impacted-specs-by-import.mjs`:
      // a vendored dependency is not this repo's CI surface, and walking one is slow
      // enough to matter in a step budgeted at five minutes.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(full);
      else if (/\.(mjs|mts|ts|js)$/.test(entry.name)) {
        files.set(path.relative(root, full).split(path.sep).join("/"), fs.readFileSync(full, "utf8"));
      }
    }
  };
  let reason = null;
  try {
    walk(path.join(root, "scripts"));
    if (files.size === 0) reason = "it holds no source files";
  } catch (error) {
    reason = error.message;
  }
  if (reason === null) return files;
  process.stderr.write(
    `::warning::ci-change-coverage could not read scripts/ (${reason}); a change reached only by import will resolve to 'none'.\n`,
  );
  return null;
}

/** A flag's value, or `null` with the degradation announced rather than silent. */
function emptyFlag(arg, flag) {
  const value = arg.slice(flag.length);
  if (value) return value;
  process.stderr.write(`::warning::ci-change-coverage: ${flag} was given no value; continuing without it.\n`);
  return null;
}

function main(argv) {
  const args = argv.slice(2);
  let format = "text";
  let root = ".";
  let statesFile = null;
  let baseRoot = null;
  const changed = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--stdin") {
      changed.push(...fs.readFileSync(0, "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    } else if (a.startsWith("--format=")) format = a.slice(9);
    else if (a === "--root") root = args[++i];
    // An EMPTY value degrades and SAYS SO. `""` is falsy, so a bare `--base-root=`
    // used to switch the whole default-branch read off without a word — silence,
    // which is the one direction this file's header forbids. Same shape #1812
    // records for `declared-stable-specs`, failing the other way.
    else if (a.startsWith("--workflow-states=")) statesFile = emptyFlag(a, "--workflow-states=");
    else if (a.startsWith("--base-root=")) baseRoot = emptyFlag(a, "--base-root=");
    else if (!a.startsWith("--")) changed.push(a);
    else {
      process.stderr.write(`::error::ci-change-coverage: unknown argument ${a}\n`);
      process.exit(2);
    }
  }

  // The DEFAULT branch's copy of the workflows — the one GitHub resolves a dispatch
  // against. Best-effort like the states file: absent, the triggers come from the
  // branch and any named workflow the PR edits is reported unverified rather than
  // promised. Failing the lane over it would be the wrong trade for a caveat.
  let baseWorkflows = null;
  if (baseRoot) {
    try {
      const read = readCiSources(baseRoot, { withScripts: false }).workflows;
      // Same floor as the states listing, for the same reason: an empty base tree
      // would read as "the default branch has no workflows at all", i.e. a 404
      // claim about every one of them.
      if (read.size === 0) throw new Error("it contains no workflows");
      baseWorkflows = read;
    } catch (error) {
      process.stderr.write(
        `::warning::ci-change-coverage could not read the base .github at ${baseRoot} (${error.message}); trigger answers will come from this branch instead.\n`,
      );
    }
  }

  let refs;
  try {
    refs = buildCiReferences({ ...readCiSources(root), baseWorkflows });
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
      if (!states) throw new Error("it lists no workflows");
    } catch (error) {
      process.stderr.write(
        `::warning::ci-change-coverage could not read ${statesFile} (${error.message}); a workflow disabled in Actions will not be flagged.\n`,
      );
      states = null;
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
