# Opening a PR — repo conventions

> **Hard gate: never open a PR on your own.** Do the work, run the validation,
> report it, and **wait**. Only run `gh pr create` when the user explicitly says
> so ("abre o PR", "manda o PR", "open the PR"). Committing/pushing follows the
> same rule — branch and stage locally, push only when asked.

Conventions analyzed from merged PRs (#457, #507, #509, …).

## Branch naming

`type/short-kebab-desc`, or `type/issue-NNN-desc` when it closes an issue. Types
match the commit type: `feat/`, `fix/`, `chore/`, `docs/`, `test/`. Examples:
`test/ui-ux-edit-sticky-note-text`,
`fix/issue-464-tool-mode-build-completion-ui-anchor`. **Never work on `main`.**

## Commit & PR title

Conventional Commits `type(scope): summary` — imperative, lowercase, no trailing
period. Scope is the area (`provider-setup`, `ci`, `ui-ux`, `triage`,
`checklist`…). New-test PRs use `test(<area>): <what>`. Append ` (#NNN)` when it
closes an issue. Squash-merge makes the merge commit = PR title + `(#NNN)`.

## PR body — new-test template (mirrors #457)

```markdown
Closes the `[ ] <item>` gap in `QA-CHECKLIST.md` § <section> — and why it's a
distinct journey from any sibling spec that looks similar.

## 1. Covered tests
| # | Test | What it validates |
|---|------|-------------------|
| 1 | `<exact test title>` | <observable behavior + the regression it catches> |

## 2. How the test was built
- Setup approach (e.g. blank flow via API vs UI, and why).
- **Live-confirmed selectors** (testids verified in the DOM — note any stale ones avoided).
- Commit/interaction mechanism for the tricky steps.
- Assertion rationale (why this check proves the behavior).

## 3. Dependencies
- LLM / provider / API-key needs (or "none — pure UI").
- Execution mode: parallel-safe or `--workers=1` serial, and why.
```

## PR body — fix/flake template (mirrors #507)

```markdown
**Fixes #NNN.**

## Problem
<what failed, with flake history: which runs/dates, how many consecutive, root cause>.

## Fix
<what changed and why; call out rejected alternatives explicitly>.

## Scope note
<what behavior/assertions stayed unchanged>.

## Validation (nightly <version>, `--retries=0`)
- typecheck ✅ · eslint ✅ · anti-pattern checklist ✅
- N clean runs, no flake ✅
- force-fail ✅ · `--trace=on` ✅ · zero `🚨 Backend Error` ✅
```

## Before requesting the PR

Run `npm run typecheck` and `npm run lint` (the two PR-CI gates) and the
validation checklist. Put the **real** results in the **Validation** block —
never claim a check passed without its output.

## PR conflicts on QA-CHECKLIST.md

The generated blocks (Coverage Summary / Phase 0) conflict whenever two PRs
regenerate them — a frequent, expected collision. NEVER hand-merge them:
rebase onto `origin/main`, take **main's** version of `QA-CHECKLIST.md`
(`git checkout --theirs` during rebase), re-run `npm run coverage:summary`
(your spec's tags re-enter the block), verify your spec's tag survived the
rebase, then `git push --force-with-lease`. GitHub takes ~15s to recompute
`mergeable` after the push.

## After merge

Delete the branch. Set yourself as assignee while the issue is in progress.
Apply `Roadmap` / `Community` / `daily-failure` labels per the team workflow.
