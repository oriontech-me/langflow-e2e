# Team skills (`.claude/skills/`)

Homegrown Claude Code skills versioned in this repo so the team shares and updates
them. Everything else under `.claude/` (run state, local settings, caches) stays
git-ignored — only the skills below are tracked.

## The skills

| Skill | Role |
|---|---|
| **langflow-e2e** | Foundation. Langflow domain expert + Spec-Driven (SDD) test-authoring engine. Owns all conventions (see its `references/`). Every test-authoring detail lives here. |
| **langflow-e2e-issues** | Prose orchestrator — wraps `langflow-e2e` to drive one GitHub issue → PR (intake, classify, 6 issue types, PR authorization). Best for family-clone specs and daily-failure triage. |
| **langflow-e2e-issue-deterministic** | Deterministic orchestrator — a TypeScript state machine (`pipeline/cli.ts`) owns phase order, gates, and evidence. **Default for wave issues.** Same lifecycle as the prose variant, enforced in code. |
| **langflow-e2e-triage** | Daily-run triage dispatcher — reads the latest red `daily-stable.yml` run, groups failures by root cause, dedups against open issues, and opens dedicated follow-up issues behind a propose-confirm gate. **Producer** of the issues the two orchestrators above **consume**. |
| **langflow-e2e-infra** | Infrastructure layer. Owns CI workflows, `scripts/`, `playwright.config.ts`, and run-history/reporting; two modes — **audit** (continuous-improvement scan → propose `qa-infra` issues) and **resolve** (`qa-infra` issue → PR). Both behind a propose-confirm gate. Delegates any `tests/` edit to `langflow-e2e`; consumes the `qa-infra` issues `langflow-e2e-triage` produces. |

The two orchestrators intentionally coexist (benchmark). Each SKILL.md opens with a
"which orchestrator to use" note. Both delegate test authoring to `langflow-e2e`.
`langflow-e2e-triage` sits upstream of both: it dispatches issues, it never fixes them.

## Prerequisites — external skills these invoke

The skills call the following via the Skill tool. They are **not** vendored in this
repo — install them in your Claude Code environment or the invocations will fail:

- **`playwright-cli`** — drives a live browser for scouting real testids and
  debugging flaky steps (referenced heavily across all three). Install from the
  Claude Code skill marketplace.
- **`superpowers`** plugin — provides `superpowers:systematic-debugging`,
  `superpowers:test-driven-development`, `superpowers:executing-plans`,
  `superpowers:subagent-driven-development`. Install the superpowers plugin.

If a skill instruction says to invoke one of these and it's missing, install it
rather than improvising around it.

## Running the deterministic pipeline's tests

```bash
npx tsx --test .claude/skills/langflow-e2e-issue-deterministic/pipeline/*.test.ts
npx tsc --noEmit -p .claude/skills/langflow-e2e-issue-deterministic/pipeline/tsconfig.json
```

These run via `tsx` (repo devDep) and are independent of the repo's own
`typecheck`/`lint` (both scoped to `tests/`), so they never affect PR CI.

## Editing rule

Keep everything here accurate and **English-only**, like any tracked repo file
(root `CLAUDE.md`). Domain conventions are centralized in `langflow-e2e/references/`
— update them there, don't restate them in the orchestrators.
