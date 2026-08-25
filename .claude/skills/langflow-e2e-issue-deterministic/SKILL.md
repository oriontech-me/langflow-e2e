---
name: langflow-e2e-issue-deterministic
description: >-
  Deterministic variant of langflow-e2e-issues. Use when the user asks to work a
  GitHub issue from oriontech-me/langflow-e2e in DETERMINISTIC MODE — e.g.
  "resolve issue #493 no modo determinístico", "roda a issue #520 determinístico",
  "usa o langflow-e2e-issue-deterministic", "issue deterministic/pipeline". A
  TypeScript state machine owns phase order, gates, and evidence; you only do the
  judgment work each emitted instruction asks for. Coexists with
  langflow-e2e-issues (future benchmark).
---

# Langflow E2E — Deterministic Issue Pipeline

The state machine at `pipeline/cli.ts` (this directory) drives one issue
end-to-end. You do not decide what comes next — the CLI does.

## Language rule

Talk to the user in PT-BR; every artifact (code, spec docs, commit/PR/issue
text, branch names) in English. Repo rule — `CLAUDE.md`.

## The loop (only behavior of this skill)

```bash
PIPE="npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts"
$PIPE next <NNN>          # run this first and after every completed step
```

`next <NNN> --no-assign ''` skips self-assignment at INTAKE (e.g. for dry runs).

1. Run `next`. Read the status lines and the instruction it prints.
2. Do EXACTLY what the instruction says — including invoking the companion
   skills it names (`langflow-e2e`, `playwright-cli`,
   `superpowers:systematic-debugging`, `superpowers:test-driven-development`).
3. When the instruction's work is done, run the `complete` command it printed,
   with truthful `--evidence-json`. If the gate rejects, fix and repeat.
4. Repeat until `DONE` / `DISPATCHED`.

Other commands, only when the situation calls for them:

```bash
$PIPE escalate <NNN> debug --reason "…"   # behavior looks broken, any phase
$PIPE ff-run <NNN> --file <spec> --test "<title>" --mutation "<desc>"
$PIPE artifacts <NNN> --run <workflow-run-id> [--filter "<test title>"]
$PIPE repro-run <NNN> --spec <path> [--grep "<title>"] [--runs 10]   # DEBUG only
$PIPE next <NNN> --spec <spec>             # VALIDATE/FORCE_FAIL: one file, one instance
$PIPE status <NNN>
$PIPE metrics <NNN>                        # benchmark data
$PIPE abort <NNN> --reason "…"
$PIPE authorize-pr <NNN> --quote "<user's exact words>"   # ONLY after explicit user authorization
```

`artifacts` downloads the failing run's `playwright-json-daily-<run>` blob and
prints each attempt's status, duration and error — the first thing to read on a
daily-failure issue, before any theory. `repro-run` measures the **pre-fix**
rate of a flake on the unmodified spec (it refuses a dirty spec file).

## Hard rules

- **Tests exist to catch real Langflow regressions, never to go green**: the
  job is to find genuine product breakage. Never weaken an assertion, loosen a
  selector, add a wait, retry, or catch, or narrow scope just to make a spec
  pass — if the test fails because Langflow behaves wrong, that's the finding;
  report it (escalate to DEBUG), don't paper over it. A test engineered to
  always pass is worse than no test.
- **Always force-fail**: the FORCE_FAIL phase is never skipped or waived — every
  `test()` in every touched `.spec.ts` gets a verified red run + revert proof
  (gate 3). No "the test obviously works" exception; if there's a spec change,
  it gets force-failed.
- **A run that executed NOTHING is refused, never counted** (#1593). Zero
  `expected`/`unexpected`/`flaky` used to satisfy every green predicate, so the
  classifier called it `clean` and a phase could close having run nothing. It is
  now `no-evidence` and stops the phase naming the cause. The route that
  produces it is real and tempting: running a lane-selected spec **without** its
  lane flag makes `grepInvert` select zero tests, and the run goes green. Set
  `PW_SERVING_IDENTITY` / `PW_ENTERPRISE` / `PW_DESTRUCTIVE`; never drop the flag
  to make a gate pass. (A `playwright.config.ts` `grepInvert` cannot be widened
  by a CLI `--grep`.)
- **Multi-instance issues close one FILE at a time, not one PHASE at a time.**
  When the touched specs need different Langflow configurations — a lane
  variant, an `@enterprise`/`@governance` matrix, a fail-closed row — point
  `PLAYWRIGHT_BASE_URL` at the container one file needs and give VALIDATE and
  FORCE_FAIL that file alone:

  ```bash
  PLAYWRIGHT_BASE_URL=http://localhost:7893 PW_SERVING_IDENTITY=1 \
    npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts \
    next <NNN> --spec tests/.../end-user-identity-isolation.spec.ts
  ```

  Both phases accumulate per target across invocations, so the phase closes when
  every touched spec has its own evidence — measured on the instance it needs.
  Before #1593 only VALIDATE had this shape and FORCE_FAIL ran every file
  against one instance, which is why #1583 had to finish through the prose
  orchestrator.
- **VALIDATE's burst IS the determinism evidence — don't re-run it by hand.**
  The VALIDATE phase already runs the spec `BURST` times (default 3) at
  `--retries=0 --workers=1`, caches the clean runs, and gates on
  `BURST` unexpected-free/flaky-free results. Those `run i/BURST …` lines ARE
  the determinism proof to report. Do NOT hand-run extra `npx playwright test`
  bursts before or after VALIDATE to "double-check" — it re-runs the same
  slow spec for zero added signal (a real session ran a spec ~10× this way).
  Scout runs to design/debug are fine; redundant confirmation bursts are not.
  Need more/fewer runs? Set `PIPELINE_BURST`, don't loop manually.
- **An environment abort is not a spec result.** A run whose every failure
  carries an infra signature (`/api/v1/auto_login` timeout, `socket hang up`,
  connection refused — the wedged-backend class measured in #1074) is recorded
  **void** and re-run; it counts neither as a failure nor as one of the clean
  burst runs. Never "fix" a spec against one, and never report it as a defect.
  Repeated voids stop the phase naming the **instance** as the blocker: restart
  it, don't loosen the test. `PIPELINE_MAX_INFRA_VOIDS` (default 3) tunes the cap.
- **A flake issue needs its PRE-fix rate.** Run `repro-run` on the unmodified
  spec BEFORE changing anything; DEBUG will not complete without it. VALIDATE's
  clean burst is not evidence on its own — at an 8 %-per-run flake, three green
  runs is the expected outcome of doing nothing (#1060). If the baseline never
  reproduces, prove the mechanism another way and say how in
  `evidence.mechanismProof`.
- **One verdict per symptom row.** A dedicated issue's table can list failures
  with different causes; #1060's second row was another issue's `auto_login`
  timeout, not the defect being fixed. Each row gets its own verdict, and a row
  another issue owns carries `ownedBy:"#NNNN"` and must be named in the PR body.
- **Lifting a quarantine is a deliverable, and it is gated.** If the issue
  quarantined a test, VALIDATE fails while a `test.fixme` survives in a touched
  spec — and, when the issue asks for the tag back, while a quarantined title
  lacks `@stable`.
- **Never bypass the CLI**: no `gh pr create`, no commit/push, no phase
  skipping, no editing files under `.claude/issue-pipeline/`.
- **The branch carries this issue's files and nothing else.** The PR gate diffs
  against `origin/main`; a rebase onto a local `main` that a parallel session
  already committed to drags their work into your PR (#1060 — caught by hand).
  Fix it with `git rebase --onto origin/main <their-commit> <your-branch>`.
- **A red CI check is fixed or justified in writing, never ignored.** The PR
  gate takes `ciVerdict: green | ambient-red`; `ambient-red` requires the URL of
  a PR comment naming the cause, the evidence that it is ambient, and why
  merging is still the right call.
- **Never fabricate evidence**: `userConfirmed: true` only after the user
  actually confirmed in chat; `--quote` only with words the user actually said.
  Runner-written keys (runs/typecheck/lint/nightly/qaDiff/ff/finalGreen) are
  ignored if you pass them — don't try.
- **If the pipeline errors or its instruction contradicts reality** (e.g. the
  issue premise died upstream), stop and report to the user — don't improvise
  around the state machine.
- Force-fail mutations must carry a `// FF-MUTATION` comment — `ff-run`
  refuses to record without it, and the revert gate greps for it.
- **Scouting leaves residue — clean it before leaving the phase**: delete any
  flow created during a PLAN scout (id from the URL, DELETE via API) and any
  throwaway scout `.spec.ts` (the burst scan excludes `scout-*`/`*-tmp` globs
  as a backstop, but the file shouldn't survive the phase).
- **The REPORT phase output always ends with two user-required items**
  (besides whatever the phase instruction asks): a per-test step-by-step of
  what each touched/created test does and validates (concrete observables,
  not intents), and the copy-paste run command for the touched spec(s) —
  env overrides, `--workers=1 --retries=0`, expected outcome — plus the
  `--debug` variant. The user runs the spec before authorizing the PR.
- **Every touched spec that creates flows ships id-scoped cleanup — always
  delete the flow at the end, never pollute the instance.** Audit `afterEach`
  + `deleteFlow` on ANY spec you touch (fixes/promotions included — legacy
  specs predate the rule); check the orphan count via `GET /api/v1/flows/`
  before REPORT and purge what the file leaked. Patterns + behavioral-FF
  contract: `langflow-e2e/references/authoring-conventions.md` → Flow
  cleanup. The user had to ask on #503 and #597 — never a third time.

## Which orchestrator — this (deterministic) vs `langflow-e2e-issues` (prose)

Both drive an issue → PR with the same 6 types and hard gates; they differ in HOW
the process is enforced:

- **this skill** — a TypeScript state machine (`pipeline/cli.ts`) owns phase
  order, gates, and evidence; you do only the judgment each instruction asks for.
  **Default for wave issues** (benchmark concluded). Pick it when you want the
  process enforced in code.
- **`langflow-e2e-issues` (prose)** — the same workflow as readable prose. Best
  for family-clone specs and daily-failure triage, or when the pipeline's
  rigidity gets in the way.

Both delegate test authoring to `langflow-e2e`.

## Changing the pipeline itself

`pipeline/` is 2.8k lines of TypeScript that owns every gate. It has its own
lane — `npm run test:pipeline` (119 tests + `tsc -p` against the pipeline's own
tsconfig), wired into `pr-validation.yml`. Run it before and after any edit.

It needs a separate runner from `npm run test:units`: the pipeline imports with
explicit `.ts` extensions under `moduleResolution: bundler`, which
`ts-node/register` cannot load, so the lane uses `tsx`. Until #1593 there was no
lane at all — `test:units` globs `.`, `scripts/` and `tests/`; `test:scripts`
globs `.claude/skills` but only `*.test.mjs`; and the root tsconfig's `include`
stops at `scripts/**`.

Put the decision in a **pure function** with a test on its output, not in the
phase block. #1226's lesson applies here directly: a guard that pins a spelling
does not pin a behaviour, and the FORCE_FAIL defect #1593 fixed lived in a loop
body no test could reach. `finalGreenTargets` and `checkFinalGreenCoverage` are
the shape to copy.

## Boundaries

This skill is versioned in the repo (`.claude/skills/`) and shared with the team
— keep it accurate and English-only. Runtime state lives in git-ignored
`.claude/issue-pipeline/issue-NNN.json` (never commit it, never hand-edit it).
Domain conventions live in `langflow-e2e` (+ its references) and
`langflow-e2e-issues`; instructions point there. Process lives here.
