import type { PipelineState } from './types.ts'

const CLI = 'npx tsx .claude/skills/langflow-e2e-issue-deterministic/pipeline/cli.ts'

export function instructionFor(s: PipelineState): string {
  const n = s.issue
  const done = (step: string, ev = '{}') =>
    `When done: ${CLI} complete ${n} ${step} --evidence-json '${ev}'`

  switch (s.phase) {
    case 'INTAKE':
      return [
        `Issue #${n} loaded: "${s.issueData?.title}" (milestone: ${s.issueData?.milestone ?? 'none'}, body format ${s.issueData?.bodyFormat}).`,
        `Restate to the user in PT-BR what the issue asks. Do not touch code.`,
        done('INTAKE', '{"restated":true}'),
      ].join('\n')

    case 'CLASSIFY':
      return [
        s.type
          ? `Heuristic classification: ${s.type} (${s.classification?.justification}). Confirm it with the user.`
          : `No heuristic matched. Classify the issue yourself using the 6-type table in the langflow-e2e-issues skill and record a justification.`,
        done('CLASSIFY', s.type ? '{"confirmed":true}' : '{"type":"<type>","justification":"<why>"}'),
      ].join('\n')

    case 'SPECIFY': {
      if (s.type === 'file-watcher') {
        return [
          `Read the issue's listed upstream commits. Enumerate the affected spec files from its --grep table — no new spec doc needed for this type.`,
          done('SPECIFY', '{"affectedSpecs":["tests/..."],"userConfirmed":true}'),
        ].join('\n')
      }
      const common = [
        `Invoke the langflow-e2e skill (Skill tool) — it owns the SDD workflow and authoring conventions.`,
        `Grep its references/authoring-conventions.md for any mechanism before hand-rolling it.`,
      ]
      if (s.type === 'validate-promote') {
        return [
          `Locate the EXISTING spec/test this issue promotes. Audit force-failability BEFORE trusting any green baseline (dead assertions, if-visible guards, silent early returns — hardening is in scope).`,
          `Author a spec doc only if missing.`,
          ...common,
          done('SPECIFY', '{"specDoc":"docs/<path>.md","userConfirmed":true,"existingSpec":"tests/<path>.spec.ts"}'),
        ].join('\n')
      }
      return [
        `Author the spec doc under docs/ mirroring the test path. Body format ${s.issueData?.bodyFormat}: map its fields per the langflow-e2e-issues field tables.`,
        `Format-A issues are thin: derive a CONCRETE Validation criterion (a distinctive observable) yourself and confirm it with the user — never ship the issue's vagueness.`,
        ...common,
        `Do NOT create or edit any .spec.ts yet — the pipeline blocks IMPLEMENT until this step completes.`,
        done('SPECIFY', '{"specDoc":"docs/<path>.md","userConfirmed":true}'),
      ].join('\n')
    }

    case 'PLAN':
      return [
        `Plan the test design: POM/helper reuse, tags (≥1 cross-cutting + ≥1 functional), fixtures import from tests/fixtures/fixtures.ts, live-testid scouting via playwright-cli (never invent selectors).`,
        `Agent/provider specs: run collect-models first, set model strategy in .env, plan --workers=1 runs; read the area-local CLAUDE.md.`,
        done('PLAN', '{"design":"<one-paragraph summary>"}'),
      ].join('\n')

    case 'DEBUG':
      return [
        `Root-cause before fixing. Invoke superpowers:systematic-debugging.`,
        `Decide the verdict with evidence per the langflow-e2e-issues taxonomy: test-defect | langflow-regression | product-changed | transient-saturation | cross-worker-wiper.`,
        `Any verdict other than test-defect: STOP and present evidence to the user; their decision goes in evidence.decision.`,
        done('DEBUG', '{"verdict":"<verdict>","summary":"<root cause>","decision":"<required unless test-defect>"}'),
      ].join('\n')

    case 'IMPLEMENT':
      return [
        `Implement per the confirmed spec doc. New helper/POM as real code → invoke superpowers:test-driven-development.`,
        `Known limitations (e.g. local --trace=on hangs on template-family specs): see the langflow-e2e-issues skill — don't rediscover them.`,
        done('IMPLEMENT', '{"files":["tests/<path>.spec.ts"]}'),
      ].join('\n')

    case 'VALIDATE':
      return [
        `Mechanical validation ran (see status above): nightly check, --retries=0 burst parsed from JSON stats, typecheck, lint, backend-error scan, QA-CHECKLIST diff rules.`,
        `Fix whatever is red and re-run ${CLI} next ${n}. Update the QA-CHECKLIST bullet (bullets only — generated blocks are enforced).`,
        `Extra targets beyond the git diff: ${CLI} next ${n} --spec <path> or --grep <pattern>.`,
        done('VALIDATE'),
      ].join('\n')

    case 'FORCE_FAIL':
      return [
        `Force-fail every test() in the touched spec files (list in status). For each: add a mutation WITH the marker comment "// FF-MUTATION", then run:`,
        `${CLI} ff-run ${n} --file <spec> --test "<exact title>" --mutation "<what you changed>"`,
        `The command runs playwright --grep on that title and only records the entry if it FAILS. Serial files: mutate one test at a time. Then revert all mutations; the gate verifies no FF-MUTATION marker remains and requires a final green run (next runs it).`,
        done('FORCE_FAIL'),
      ].join('\n')

    case 'REPORT': {
      const lines = [
        `Write the PT-BR report: (1) what the issue is about; (2) what was done, with real output and resolved nightly; (3) the REQUIRED per-test table (skeleton in status — fill "O que faz" / "O que valida" with concrete observables) + one FF: line per mutation; (4) end with the manual --debug run command.`,
      ]
      if (s.type === 'file-watcher') {
        lines.push(`File-watcher: no drift ⇒ close the issue with an evidence comment (the pipeline fast-exits to DONE, no PR); drift fixed ⇒ continue to PR authorization as usual.`)
      }
      lines.push(done('REPORT', '{"reported":true}'))
      return lines.join('\n')
    }

    case 'AWAIT_PR_AUTH':
      return [
        `Report is delivered. WAIT. Do NOT run gh pr create, commit, or push.`,
        `Only when the user explicitly authorizes ("abre o PR" or similar), run:`,
        `${CLI} authorize-pr ${n} --quote "<their exact words>"`,
      ].join('\n')

    case 'PR':
      return [
        `Authorized. Follow langflow-e2e/references/pr-guide.md: branch type/issue-NNN-desc, Conventional-Commit title with (#${n}), body with "Closes #${n}" + the correct template + the REAL Validation block.`,
        `The complete gate fetches the REAL PR body via "gh pr view" and verifies branch name, Closes line, and roadmap label mechanically against it.`,
        `Post-merge: verify the issue actually closed (edited-Fixes GitHub quirk) and delete the branch.`,
        done('PR', '{"prUrl":"<url>"}'),
      ].join('\n')

    case 'DISPATCH':
      return [
        `This is a triage dispatcher, not a fix — CONTRIBUTING § Triage protocol governs and outranks this skill. Shallow & descriptive: open one dedicated issue per problem in order hard-failure → flake → skip, dedup against open issues, and do NOT fix anything on this branch.`,
        `hard-failure vs recurrent-flake vs transient vs wiper here is a routing bucket noted DESCRIPTIVELY — never a closing verdict. The verdict + evidence framework runs on the dedicated issues (DEBUG phase), not here. If the mass-failure guard tripped, add one descriptive call — was the day environmental? — and only if NOT, remove @stable manually from the real hard failures.`,
        done('DISPATCH', '{"createdIssues":["#NNN"]}'),
      ].join('\n')

    case 'DONE': return `Pipeline for #${n} is DONE.`
    case 'DISPATCHED': return `Triage #${n} dispatched — work the created issues separately.`
    case 'ABORTED': return `Pipeline for #${n} was aborted: ${s.abortReason}`
    default: return `No instruction for phase ${s.phase}.`
  }
}
