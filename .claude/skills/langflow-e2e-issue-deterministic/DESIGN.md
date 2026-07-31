# Design — langflow-e2e-issue-deterministic (2026-07-07)

Deterministic sibling of the `langflow-e2e-issues` skill. A TypeScript state-machine
CLI owns the issue-resolution process (order, gates, evidence); Claude does only the
judgment work inside each step. The two skills coexist — a future benchmark will
compare them, so the pipeline records per-step metrics from day one.

## Goals

1. **Determinism of process** — phase order, hard gates, and evidence verification are
   code, not prose the model may drift from. The model never decides "what's next".
2. **No duplication of domain knowledge** — SDD conventions, verdict taxonomies, and
   hard-won lessons stay in `langflow-e2e` / `langflow-e2e-issues` and their
   references. Step instructions POINT to them.
3. **Benchmarkability** — every run leaves a machine-readable metrics trail
   (timestamps, run counts, retries per step) comparable against manual skill runs.

## Non-goals

- Autonomy (no Agent SDK; the pipeline runs inside the Claude Code session).
- Replacing `langflow-e2e-issues` — coexistence (benchmark concluded: this variant
  is the default for wave issues, prose for family-clones/triage).

## Layout

```
.claude/skills/langflow-e2e-issue-deterministic/
├── SKILL.md            # thin driver: loop next → work → complete until DONE
├── DESIGN.md           # this document
└── pipeline/
    ├── cli.ts          # command parse + dispatch: next|complete|status|abort|metrics|authorize-pr
    ├── state.ts        # state machine (valid transitions), persistence, metrics
    ├── classify.ts     # deterministic issue-type heuristics (labels/title/body)
    ├── gates.ts        # per-step evidence verifiers
    ├── runners.ts      # wrappers: gh CLI (JSON), playwright (--reporter=json), tsc, eslint, git
    └── steps/          # instruction text emitted by `next`, one module per phase
```

Run state (one file per issue): `.claude/issue-pipeline/issue-NNN.json`.
Executed with `npx tsx` (repo devDeps; tsx fetched on demand). Not part of repo CI.

## State machine

```
INTAKE → CLASSIFY → SPECIFY → PLAN → IMPLEMENT → VALIDATE → FORCE_FAIL → REPORT → AWAIT_PR_AUTH → PR → DONE
                        ↑ fix type inserts DEBUG before IMPLEMENT
                        ↑ daily-failure triage exits early at DISPATCHED
```

DEBUG is also reachable as an **escalation from any phase**: whenever observed
behavior looks broken (reproduction fails, previously-green spec fails, backend
errors), Claude requests `escalate <NNN> debug --reason "…"`; the pipeline parks the
current phase, runs the DEBUG verdict flow (taxonomy owned by `langflow-e2e-issues`),
and any verdict other than *test-defect* pauses for a user decision before resuming.

Type variations (same 6 classes as the prose skill):

| Type | Deviation from the spine |
|---|---|
| new-spec | full spine |
| validate-&-promote | SPECIFY = locate existing spec + force-failability audit; create spec doc only if missing |
| daily-failure triage | dispatcher: CLASSIFY → fan out dedicated issues → terminal state `DISPATCHED` (no PR) |
| fix (dedicated) | DEBUG step (root-cause verdict: test-defect / langflow-regression / transient / cross-worker-wiper / product-changed) before IMPLEMENT; verdicts ≠ test-defect pause the pipeline for a user decision |
| community regression | spine, plus severity-order check at INTAKE |
| file-watcher | SPECIFY requires `evidence.affectedSpecs` (non-empty array enumerated from the issue's `--grep` table) + `evidence.userConfirmed` — no new spec doc; REPORT fast-exits to `DONE` when the working diff is clean after `complete REPORT` (no drift ⇒ close the issue, nothing to PR; drift fixed ⇒ normal PR path via AWAIT_PR_AUTH) |

## Command surface

```
npx tsx pipeline/cli.ts next 493                    # validate state, run mechanical work, emit exact next instruction
npx tsx pipeline/cli.ts complete 493 <step> --evidence <args>
npx tsx pipeline/cli.ts escalate 493 debug --reason "…"   # park current phase, enter DEBUG from anywhere
npx tsx pipeline/cli.ts artifacts 493 --run <run-id> [--filter "<title>"]   # per-attempt status/error from the failing run's own JSON artifact
npx tsx pipeline/cli.ts repro-run 493 --spec <path> [--grep "<title>"] [--runs 10]   # DEBUG only: PRE-fix flake rate on the unmodified spec
npx tsx pipeline/cli.ts status 493
npx tsx pipeline/cli.ts abort 493 --reason "…"
npx tsx pipeline/cli.ts metrics 493                 # benchmark summary (JSON)
npx tsx pipeline/cli.ts authorize-pr 493 --quote "<user's authorizing phrase>"
```

`next` is idempotent: re-running neither advances state nor corrupts it; mechanical
work already done is detected from recorded evidence and skipped. `complete` for a
step other than the current one errors, naming the expected step.

## Division of labor

**Code (deterministic):**
- INTAKE: `gh issue view --json`, milestone + roadmap-linkage check (off-wave ⇒ require
  an approved exception label: follow-up / `daily-failure` / `community`),
  `--add-assignee @me`, and **body-format detection** — format A (wave deliverable:
  Type / Spec file / Checklist bullets / Depends on / Done when) vs format B
  (test-automation template: What to test / Preconditions / Steps / Expected concrete
  result / Type / Non-obvious behaviors / Reference). Parsed fields are stored in
  state; the SPECIFY instruction maps them per the prose skill's field tables, and
  for thin format-A issues it explicitly requires deriving a concrete Validation
  criterion (never shipping the issue's vagueness). `Depends on #NNN` is checked
  merged before proceeding.
- CLASSIFY: heuristics over labels/title/body (label `daily-failure` → triage;
  "Validate & promote" in title → promote; `test-automation` label → new-spec; etc.).
  Ambiguous ⇒ instruction asks Claude to classify; the justification is stored in state.
- VALIDATE preconditions and checks, all mechanical:
  - **latest-nightly check** — compare the running instance's version against the
    current `langflowai/langflow-nightly` tag before any burst counts as evidence;
  - playwright with `--reporter=json`, pass/fail decided by parsing `stats`
    (never grepping interleaved output), `--workers=1` for agent-area specs;
  - **zero `🚨 Backend Error`** — scan the run's captured stdout for the fixture's
    marker; any hit fails the gate (CONTRIBUTING checklist item 4);
  - `npm run typecheck` and `npm run lint` exit codes (the two PR-CI gates);
  - **QA-CHECKLIST bullet check** — the touched bullet contains the spec path and the
    right status symbol, and the diff does NOT touch the auto-generated blocks
    (Coverage Summary table, Coverage Summary Note, `Phase 0 — Validated`).
- FORCE_FAIL: enumerate `test()` titles in every touched `.spec.ts` (regex over the
  file); require one FF entry per title, each with red-run stats; verify revert via
  `git diff` free of mutation markers plus one final green run.
- Gates (see below), state persistence, metrics.

**Claude (judgment, guided by the instruction `next` emits):**
- Spec-doc authoring — instruction says to invoke the `langflow-e2e` skill (SDD owner).
- Ambiguous classification, with recorded justification.
- Root-cause work in DEBUG — instruction points to `superpowers:systematic-debugging`
  and the verdict taxonomy in `langflow-e2e-issues`.
- Test authoring, live-selector scouting via `playwright-cli`; new helper/POM as real
  code ⇒ instruction points to `superpowers:test-driven-development`.
- Designing each force-fail mutation.
- Writing the PT-BR report (code generates the table skeleton from parsed test titles;
  the instruction requires the `FF:` lines and ends with the manual `--debug` run command).

Step instructions never duplicate known limitations (e.g. local `--trace=on` hangs on
Simple Agent–template and other specs) — they point to the relevant section of the
prose skill / `langflow-e2e` references instead.

## Hard gates (all enforced in `gates.ts`)

1. **Spec-first**: entering IMPLEMENT fails if `git diff --name-only` shows a modified
   `.spec.ts` before SPECIFY completed with evidence = existing spec-doc path + a
   user-confirmation flag.
2. **Green means parsed green**: VALIDATE completes only with a `--retries=0` burst
   whose JSON stats show 0 failed; the run command, stats, and nightly version are
   stored as evidence.
3. **FF coverage**: FORCE_FAIL completes only when every enumerated `test()` in the
   touched files has a verified red run + revert proof.
4. **PR authorization**: PR state is unreachable until `authorize-pr` records the
   user's explicit quote. `complete report` lands in AWAIT_PR_AUTH and the emitted
   instruction says: report and WAIT.
5. **One issue per branch**: `next` errors if the current branch's state file belongs
   to a different issue.
6. **Pre-PR checklist (mechanical)** — mirrors the repo's PR review checklist: spec
   doc exists under `docs/` mirroring the test path, with all mandatory sections
   filled (**What this test validates**, **Tags**, **Validation criterion**,
   **External dependencies**) and `Last validated` matching the current release
   cycle; branch matches `type/issue-NNN-desc` (never `main`); PR body contains
   `Closes #NNN` and the correct template; `roadmap` label present for wave issues.
   Post-merge instruction: verify the issue actually closed (the edited-`Fixes`
   GitHub quirk) and delete the branch.
7. **Environment aborts are void, not verdicts** (#1082): `classifyRun` splits a
   run into `clean | infra-void | real-failure` from its failure messages. A run
   whose every failure carries an infra signature (`/api/v1/auto_login` timeout,
   `socket hang up`, connection refused) is re-run and counted as neither; past
   `PIPELINE_MAX_INFRA_VOIDS` (3) the phase stops naming the instance. A failure
   the classifier cannot read stays a real failure — it can never silence a red.
8. **Pre-fix flake rate** (#1082): for a flake-shaped issue, DEBUG completes only
   with a `repro-run` baseline (≥5 runs on the unmodified spec) — or, when the
   defect never reproduced, an explicit `evidence.mechanismProof`. Three clean
   VALIDATE runs do not distinguish a fix from luck at single-digit flake rates.
9. **One verdict per symptom row** (#1082): every `spec.ts:line` row in the
   issue's table needs its own verdict; a row owned by another issue carries
   `ownedBy:"#NNNN"` and must be referenced in the PR body.
10. **Quarantine lift** (#1082): when the issue quarantined a test, VALIDATE
    fails while a `test.fixme` survives in a touched spec, and (when the issue
    asks for it) while a quarantined title lacks `@stable`. Correspondingly,
    FORCE_FAIL requires red runs only for *runnable* titles — a muted test
    cannot be force-failed, and demanding it would deadlock the phase.
11. **Branch purity + CI verdict** (#1082): the PR gate diffs
    `origin/main..HEAD` against the files SPECIFY/IMPLEMENT recorded (plus
    `QA-CHECKLIST.md`), failing closed when the base ref cannot be resolved; and
    it requires `ciVerdict: green | ambient-red`, where `ambient-red` must carry
    the URL of a justification comment that actually exists on the PR.

## State file

`.claude/issue-pipeline/issue-NNN.json`, schema versioned (`version: 1`), following
the repo's `reports/README.md` versioning convention (additive = no bump):

```jsonc
{
  "version": 1,
  "issue": 493,
  "type": "new-spec",
  "phase": "VALIDATE",
  "branch": "test/issue-493-…",
  "startedAt": "…",
  "steps": {
    "INTAKE":   { "startedAt": "…", "completedAt": "…", "evidence": { /* per-step */ } },
    "VALIDATE": { "startedAt": "…", "attempts": 2, "evidence": { "stats": { "expected": 6, "unexpected": 0 } } }
  },
  "classification": { "by": "heuristic|claude", "justification": "…" }
}
```

`metrics` reads this and emits per-step wall-clock, attempt counts, and totals — the
benchmark contract against the prose skill.

## Error handling

- Invalid transition → exit 1 with expected step named; state untouched.
- Mechanical failure (gh/playwright/tsc non-zero) → recorded as attempt, instruction
  re-emitted; after 3 failed attempts of the same mechanical action the instruction
  escalates to the user instead of looping.
- `abort` closes the run with a reason (kept for benchmark honesty — aborted runs count).
- Corrupt/missing state file → refuse to guess; instruct re-`next` from INTAKE or manual fix.

## Testing the pipeline itself

Pure parts (state transitions, classify heuristics, stats parsing, FF enumeration)
get `node:test` unit tests run manually via `npx tsx --test pipeline/*.test.ts`.
Not wired into repo CI (private code). Runners are thin enough to leave untested;
their failures surface as recorded attempts.

## SKILL.md contract (driver)

Frontmatter description triggers on the same phrases as the prose skill plus
"pipeline"/"determinístico". Body is short:

1. PT-BR with the user; English artifacts (repo rule).
2. Loop: run `next <NNN>` → do exactly what the instruction says (including invoking
   the named companion skills) → `complete <step> --evidence …` → repeat.
3. Never bypass the CLI: no `gh pr create`, no phase-skipping, no editing the state file.
4. If the pipeline errors or the instruction conflicts with reality, stop and report —
   don't improvise around the state machine.

## Boundaries

The skill code (this doc, `SKILL.md`, `pipeline/*.ts`, tests) is versioned in
`.claude/skills/` and shared with the team. Per-issue **run state**
(`.claude/issue-pipeline/issue-NNN.json`) stays git-ignored — it's local runtime,
never committed or hand-edited. Domain conventions remain owned by `langflow-e2e`
and its references; this pipeline encodes process only.
