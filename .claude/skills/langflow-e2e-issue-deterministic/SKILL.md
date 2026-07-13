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
$PIPE status <NNN>
$PIPE metrics <NNN>                        # benchmark data
$PIPE abort <NNN> --reason "…"
$PIPE authorize-pr <NNN> --quote "<user's exact words>"   # ONLY after explicit user authorization
```

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
- **Never bypass the CLI**: no `gh pr create`, no commit/push, no phase
  skipping, no editing files under `.claude/issue-pipeline/`.
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

## Boundaries

This skill is versioned in the repo (`.claude/skills/`) and shared with the team
— keep it accurate and English-only. Runtime state lives in git-ignored
`.claude/issue-pipeline/issue-NNN.json` (never commit it, never hand-edit it).
Domain conventions live in `langflow-e2e` (+ its references) and
`langflow-e2e-issues`; instructions point there. Process lives here.
