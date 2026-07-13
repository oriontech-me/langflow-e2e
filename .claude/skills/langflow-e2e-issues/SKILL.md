---
name: langflow-e2e-issues
description: >-
  Use when the task is to work a GitHub issue from this repo's roadmap wave
  milestone (oriontech-me/langflow-e2e) — e.g. "resolve issue #493", "pega a
  próxima issue da Wave 1", "trabalha a milestone 5", "promote the provider
  specs to @stable". Drives one issue end-to-end: intake and classify it,
  resolve it via the langflow-e2e SDD workflow, run and validate the tests, and
  open the PR only after explicit user authorization. Handles new-spec,
  validate-&-promote-@stable, and daily-failure/fix issue types.
---

# Langflow E2E — Issue Handling

Wrapper workflow that takes **one GitHub issue** from this repo's current wave
milestone and drives it to a ready-to-review PR. It is an orchestrator: the
actual test authoring, running, and PR conventions come from the sibling
`langflow-e2e` skill — **invoke that skill first** and reuse its SDD method and
references. This skill only adds the issue-lifecycle wrapper around it.

Repo: `oriontech-me/langflow-e2e`. Milestone 5 = `Wave 1 — Agents & providers`.
Milestones rotate — never hardcode a wave; resolve the current one live.

## Which orchestrator — this (prose) vs `langflow-e2e-issue-deterministic`

Two skills drive an issue → PR. Same 6 issue types, same hard gates; they differ
in HOW the process is enforced:

- **`langflow-e2e-issue-deterministic`** — a TypeScript state machine owns phase
  order, gates, and evidence. **Default for wave issues** (benchmark concluded).
  Prefer it when you want the process enforced in code.
- **this skill (prose)** — the human-readable workflow. Best for family-clone
  specs and daily-failure triage, or when the deterministic pipeline's rigidity
  gets in the way. Both delegate authoring to `langflow-e2e`.

If unsure and the user didn't specify, the deterministic variant is the default
for wave work; use this prose skill for triage/family-clone tasks.

## Language rule (always)

Talk to the user in **Portuguese (PT-BR)**; produce every technical artifact
(test code, spec docs, commit/PR/issue text, branch names) in **English**. Repo
rule — see `CLAUDE.md`.

## Hard gates (non-negotiable)

- **Spec-first.** Never write or edit a `.spec.ts` before its spec doc under
  `docs/` exists and is confirmed with the user. Inherited from `langflow-e2e`.
- **Never open a PR, commit, or push on your own.** Do the work, run validation,
  report it, and **wait**. Only run `gh pr create` / push when the user
  explicitly says so ("abre o PR", "manda o PR", "open the PR").
- **One issue at a time.** Assign yourself, finish it, then pick the next — no
  batching multiple issues into one branch/PR.
- **Report faithfully.** Show real test output; say what was skipped or is still
  flaky; never claim green without the run. **Confirm the result from the run's
  final `N passed`/`N failed` summary + duration before reporting** — a premature
  `Monitor` event or a grep of `\r`-interleaved / multi-run output mis-parses and
  has produced false "all passed" reports. If you already told the user a result
  and later find it wrong, correct it explicitly. (How to read output:
  `langflow-e2e` → Running tests.)
- **Every final report ends with (user rule, asked explicitly):**
  1. a **step-by-step of what each touched/created test does and validates**
     (per-test table or list: setup → action → concrete observables asserted);
  2. the **copy-paste run command** for the touched spec(s) — including any
     env overrides needed locally, `--workers=1 --retries=0`, and the expected
     outcome ("N passed, ~Xs") — plus the `--debug` variant. The user runs the
     spec himself before authorizing the PR; a report without these two items
     is incomplete.

## Companion skills — invoke when needed

This skill orchestrates; it delegates the actual work to other skills via the
Skill tool. Reach for them whenever the phase calls for it:

- **`langflow-e2e`** (always, phase 3) — owns the SDD test-authoring workflow,
  conventions, spec-doc anatomy, tags, running commands, and its own references
  (`authoring-conventions.md`, `team-workflow.md`, `pr-guide.md`). This skill is
  a thin wrapper over it.
- **`playwright-cli`** — drive a **live browser** to scout real testids/handles
  (never invent selectors) or debug/heal a flaky step. Use in PLAN and when a
  `fix`/`daily-failure` issue needs live reproduction.
- **`superpowers:systematic-debugging`** — for `fix` / `daily-failure` /
  file-watcher issues: root-cause before proposing a fix.
- **`superpowers:test-driven-development`** — when the resolution builds a new
  helper/POM as real code (not just a `.spec.ts`).

Prefer an existing repo skill over improvising. If none fits and the task is
non-trivial, say so rather than guessing.

## Workflow

Track every phase with TodoWrite. **Phase 0 invokes the `langflow-e2e` skill**
(via the Skill tool) — its SDD phases (SPECIFY → PLAN → TASKS → IMPLEMENT →
VERIFY) do the resolution; the phases below wrap them.

### 1 — INTAKE

Pick or receive the issue, then load it:

```bash
gh issue list --repo oriontech-me/langflow-e2e --milestone "Wave 1 — Agents & providers" --state open
gh issue view <NNN> --repo oriontech-me/langflow-e2e --comments
```

Assign yourself while it's in progress:

```bash
gh issue edit <NNN> --repo oriontech-me/langflow-e2e --add-assignee @me
```

Read the issue title + body fully. **The body is the input contract for the
spec.** Repo issues come in **two body formats** — recognise which one:

**A — Wave deliverable** (auto-generated `roadmap` issues, the common case in a
wave milestone; e.g. #492). Terse pointer format — map its fields:

| Field | Feeds into |
|---|---|
| **Type** (Create new spec / Validate & promote / …) | drives CLASSIFY below. |
| **Spec file** / **Spec doc** | exact paths to create/edit — use them verbatim. |
| **Checklist bullets** (`§N.N — …`) | the `QA-CHECKLIST.md` bullet(s) to flip to `[x]`. |
| **Depends on** #NNN | a blocker — confirm it's merged before starting. |
| **Done when** | the acceptance criteria (spec + `@stable` + doc + bullet). |

This format is thin: it names *what* but rarely gives concrete Steps or a
sharp observable. **You must derive the concrete Validation criterion yourself**
(what specific, distinctive output proves the behavior — e.g. #492's per-run
sentinel), then confirm it in the spec doc with the user. Don't ship a vague
assertion just because the issue was vague.

**Verify the surface EXISTS live before authoring the spec doc.** A thin
issue also encodes an unverified assumption about WHERE the behavior lives.
For provider issues, run the surface triage from
`langflow-e2e/references/provider-playbook.md` (Settings UI search + `GET
/api/v1/models/providers` + component source in the container — the three
diverge on 1.11) BEFORE writing the doc; for any other issue, spend the same
~5 minutes confirming the named page/field/component exists on the running
nightly. #499's spec doc assumed the keyed-Settings shape and was rewritten
mid-flight when the scout found Groq absent from the Settings UI.

**Family-sibling rule (first-mover cost).** If a merged spec of the same
shape exists (provider family, agent-param family, …), START from its
skeleton and source-dive the target for deviations — the deviations, not the
skeleton, are where the new asserts live. #500 shipped in ~12 min this way
vs ~40 min for first-mover #499.

**B — Test-automation template** (`.github/ISSUE_TEMPLATE/test-automation.md`;
human/community-authored). Rich format — map its fields:

| Field | Feeds into |
|---|---|
| **What to test** (`should … when …`) | the `test(...)` name — copy the intent verbatim. |
| **Preconditions** | spec-doc setup / fixtures. |
| **Steps** | the `test.step()` sequence. |
| **Expected concrete result** | the spec's **Validation criterion** — prove *this* observable, never a vague "modal opens". |
| **Type** (UI / API / Agent-LLM / MCP) | area under `regression/<area>/` + tags (Agent-LLM → `@agents`, `--workers=1`, collect-models). |
| **Non-obvious behaviors** | edge conditions / timing to encode. |
| **Reference** | linked issue/PR — carry into the PR body. |

Restate to the user in PT-BR what the issue asks and which type you classified
it as, before touching code.

### 2 — CLASSIFY

| Type | Signal in title/body/labels | Resolution path |
|---|---|---|
| **new-spec** | `test-automation` label, "Create `<name>.spec.ts` — …" | Full SDD: author spec doc → build POM/helpers → write `.spec.ts` → tag → validate. |
| **validate-&-promote** | "Validate & promote …", "Promote … to `@stable`" | The spec/test usually **already exists** — locate it. Validate it runs green (see Promotion below), then add `@stable`. Author a spec doc only if missing. |
| **daily-failure triage** | `daily-failure` label, "triage", lists multiple removed tests | **Dispatch only — `CONTRIBUTING.md` → *Triage protocol* governs and outranks this skill.** Shallow & descriptive: read the run, fan out one **dedicated issue per problem** in order **hard-failure → flake → skip**, note environment signals *descriptively — never as a verdict*, dedup against open issues, then **close the triage**. Do NOT reach a verdict, "prove on 3 environments", or fix anything here — `triage-verdicts.md` runs on the **dedicated issues** this spawns, not on the triage. If the mass-failure guard tripped, the one extra deliverable is a *descriptive* environmental call deciding whether to manually remove `@stable` from the real hard failures. |
| **fix (dedicated)** | "Fixes #…", single hard-failure/flake | `systematic-debugging` → root-cause → fix → prove N clean `--retries=0` runs → **restore `@stable`** via PR on resolve. |
| **community regression** | `community` label (+ `high`/`medium`/`low`) | Lives outside the wave milestone; work in severity order. Becomes a named `@regression` spec + `QA-CHECKLIST.md` bullet. |
| **file-watcher** | opened by `file-watcher.yml`, lists upstream commits + a `--grep` table | Read the listed commits, run the indicated tests, fix any drift, close the issue (`CONTRIBUTING.md` § file-watcher). |

**Failure triage — decide with evidence before "fixing" anything (on a DEDICATED
issue).** Not every failing test means the test is wrong; the verdict routes the
work. **This applies when working a dedicated `fix` / `community` / `file-watcher`
issue — NOT the daily-failure triage dispatcher**, which stays shallow and
descriptive per `CONTRIBUTING.md` → *Triage protocol* (see the CLASSIFY row
above); the verdicts run on the dedicated issues a triage spawns, never on the
triage itself. Whenever a failure/behavior looks broken — in the issue body,
during reproduction, or on a previously-green spec — read
**`references/triage-verdicts.md`** and classify into one of the six
verdicts before touching code:

1. **Test defect** → fix the test (spec doc first).
2. **Langflow regression (confirmed live)** → flag with reproduction
   evidence, wait for the user; never silently weaken the test.
3. **Product changed intentionally** → not-implementable / re-scope closure
   (steelman every trigger path first).
4. **Transient (CI saturation)** → prove on 3 environments; restore @stable
   with no test change. *(Concluded on the dedicated issue, never at triage.)*
5. **Cross-worker destructive cleanup** → fix the WIPER (hunt transitively
   through POMs), never the victim.
6. **Stale "confirmed bug"** → reproduce on the live nightly FIRST; if fixed,
   ship a normal passing test, never a test.fail gate.

The reference also covers: reading a daily flaky's artifacts (JSON artifact →
report zip → stdout/error-context), why scout passes don't validate a spec
(only --retries=0 bursts of the real .spec.ts count), and the
non-deterministic-observable pivot rule (3 failed assert designs ⇒ find a
deterministic observable of the same backend contract).

**Roadmap linkage is mandatory.** Wave issues carry `roadmap` and belong to a
milestone. Off-wave work needs an approved exception (follow-up / `daily-failure`
/ `community`) — no exception issue ⇒ it belongs to the current wave
(`ROADMAP.md` → Intake, `CLAUDE.md` → What to work on). Confirm the linkage
before starting.

### 3 — RESOLVE (delegate to `langflow-e2e`)

Invoke the `langflow-e2e` skill and follow its SDD flow for the classified type.
Do not duplicate its conventions here — it owns:

- spec-doc anatomy, tag rules (≥1 cross-cutting + ≥1 functional), fixture import
  (`tests/fixtures/fixtures.ts`, never `@playwright/test`), POM/helper reuse,
  live-testid scouting via `playwright-cli` — see its
  `references/authoring-conventions.md`. **Before hand-rolling any mechanism
  in the first draft (flow-id capture, cleanup, waits, playground runs), grep
  `authoring-conventions.md` for it** — known traps (e.g. the transient canvas
  flow id) are already encoded there; re-deriving them costs a debug cycle
  per trap (#490 paid this for the flow id despite the #505 lesson).
- For agent/provider specs (most of Wave 1): collect provider data first
  (`npx playwright test tests/collect-models.spec.ts`), set the model strategy
  in `.env`, run agent specs with `--workers=1`. Read the area-local `CLAUDE.md`
  under `core-functionality/llm-agents/` or `model-provider/` before writing.

**Promotion path detail (validate-&-promote issues):** find the existing spec,
run it clean **multiple times with `--retries=0`** on the fresh nightly; only
when it's demonstrably stable do you add `@stable` to the `test(...)` call
(never hand-edit the generated `QA-CHECKLIST.md` blocks — the tag drives them).

**Audit force-failability BEFORE trusting a green baseline.** A passing run
does not validate a spec that cannot fail. Read each test for: dead assertions
(`expect(x || true).toBe(true)`), whole bodies inside `if (visible) { … }`
guards, and silent early-return chains (`if (!found) return`) — all of these
"pass" when the UI is gone or the API errors. Real case (#505): 17/19 baseline
green, but ~12 tests had no failure path — two "passed" while logging
`skipping`, and an API test "passed" on a 422. Promoting those would blind the
daily-stable workflow on that surface. **Hardening weak tests is a legitimate
part of a validate-&-promote issue's scope** — replace every conditional bypass
with a hard assertion against live-scouted testids (or an explicit `test.skip`
with a reason, for missing provider keys only), then burst and promote.

### 4 — RUN & VALIDATE

Confirm the instance is on the **latest nightly** first (see `langflow-e2e` →
"confirm the instance is on the latest nightly"). Then run the target and the
validation checklist from `CONTRIBUTING.md`:

```bash
npx playwright test tests/tests-automations/regression/<path>.spec.ts --workers=1
npm run typecheck && npm run lint     # the two PR-CI gates
```

1. `--trace=on`; steps match screenshots.  2. force a failure — no false
positive.  3. walk `--debug`.  4. zero `🚨 Backend Error`.  5. update the
`QA-CHECKLIST.md` **bullet** (append the spec path, set the status symbol).
Capture the resolved nightly version for the PR Validation block.

**Force-fail is MANDATORY and EXECUTED — for every test in scope, before the
report.** Not on request, not "the asserts look hard": run at least one
mutation per `test()` that is new, modified, promoted, restored, or sharing
the touched file, and watch it FAIL. Rules learned the hard way (#550, #518,
#519 — the user had to ask every time):
- **Scope = the whole file you touched**, even tests whose logic you didn't
  change — a cleanup/helper edit can silently defuse a sibling's assert.
- **Serial files skip siblings after a failure** — run each test's mutation
  isolated (`--grep "<title>"`), or the first FF masks the rest.
- **Helpers/cleanup get behavioral FF too**: mutate the mechanism and observe
  the effect (tracker collecting nothing → leak count > 0; scoped delete
  reverted to delete-all → seeded SURVIVOR dies). A pre-fix run that fails is
  itself valid FF evidence for the fix (the old code IS the mutation).
- **Prove the revert**: `grep` the diff for mutation markers (0 hits) + one
  final green run. Report the FF results as the `FF:` lines — a report
  without executed force-fails is not a validated report.

**Known limitation — `--trace=on` HANGS locally beyond the template family.**
Reproduced on a plain blank-flow spec too (#518: >7min vs ~17s normal), so
treat any local `--trace=on` run exceeding ~3× normal duration as the hang —
kill it, note it, and rely on `--retries=0` bursts + force-fail + adversarial
runs; CI's trace-on-first-retry still captures usable traces for these specs.
**Known limitation — `--trace=on` HANGS Simple Agent–template specs.** On the
current stack, tracing any spec that loads the Simple Agent template (heavy
ReactFlow canvas) hangs the run indefinitely (>600s; reproduced on merged
`agent-max-iterations.spec.ts` too — #490). Don't burn time retrying: skip
checklist item 1 for that family, note the limitation in the PR Validation
block, and cover step-verification via green `--retries=0` runs + force-fail
mutations + `playwright-cli` scout snapshots instead.

**Time-box diagnostics with a control experiment.** A validation/diagnostic
run that exceeds ~3× the spec's normal duration is a signal, not a wait: kill
it and run the SAME flag/steps against an established merged spec first. If
the control also fails, the problem is environmental — stop debugging your
spec. (In #490, retrying the author spec with a doubled timeout cost 10 min;
the control run answered the question in one shot.)

### 5 — REPORT & (on authorization) PR

Report to the user in PT-BR, in this order:
1. **What the issue is about** — restate the behavior/bug the issue asks to cover.
2. **What you did to resolve it** — spec doc, test design, any bug found &
   fixed, real test output, resolved nightly version, what's still open.
3. **Test summary table (REQUIRED)** — one row per `test()` in the spec, so the
   user validates coverage at a glance without reading the code:

   | # | Teste | O que faz | O que valida (observável concreto) |
   |---|---|---|---|

   - **Teste**: the `test()` title (English, verbatim).
   - **O que faz**: the setup + action in one sentence (PT-BR).
   - **O que valida**: the concrete assertion/observable — the exact thing
     that fails if the behavior regresses (counts, message regex, API value),
     never a vague "works correctly".
   - After the table, one `FF:` line per verified force-fail mutation, so the
     user also sees *how* each test was proven falsifiable.
4. **End with the manual run command in Playwright debug mode**, e.g.:
   ```bash
   npx playwright test tests/tests-automations/regression/<path>.spec.ts --workers=1 --debug
   ```
   (add `--grep "<title>"` / `MODEL_TEST_ID=…` when narrowing to one case).

Then **wait**.

Only when the user authorizes, follow `langflow-e2e/references/pr-guide.md`:

- branch `type/issue-NNN-desc` (never `main`); Conventional-Commit title
  `test(<area>): <what> (#NNN)` for new specs, `fix(<scope>): … (#NNN)` for fixes.
- PR body closes the issue: include `Closes #NNN`, the correct template
  (new-test vs fix/flake), and the **real** Validation block — no unproven checks.
- apply the `roadmap` label (already on wave issues); after merge, **delete the
  branch**.

## Red flags — STOP

- About to write a `.spec.ts` and no confirmed spec doc exists → back to SPECIFY.
- About to `gh pr create` / push without the user saying so → stop, report & wait.
- Adding `@stable` without N clean `--retries=0` runs on fresh nightly → not validated.
- Reporting "concluído" without an EXECUTED force-fail for every test in scope → not validated; run the mutations first.
- Handling a second issue on the same branch → one issue per branch.
- Inventing a testid/selector → scout the live DOM with `playwright-cli`.
- Editing the generated `QA-CHECKLIST.md` tables by hand → edit bullets / tags only.
- **Reporting on ANY spec that creates flows without flow cleanup verified**
  → every touched spec ships id-scoped `afterEach` cleanup
  (authoring-conventions → Flow cleanup), the orphan count is checked via
  `GET /api/v1/flows/` before the report, and leaked orphans are purged.
  Applies to fixes/promotions of legacy specs too, not just new specs — the
  user had to ask on #503 and #597; never a third time.

## Boundaries

**`CONTRIBUTING.md` is the repository's convention and outranks this skill.**
Skills are tools that assist; the convention is the rule. On any conflict
between a skill instruction and `CONTRIBUTING.md`, follow `CONTRIBUTING.md` and
fix the skill. Concretely: the daily-failure **triage issue** follows
`CONTRIBUTING.md` → *Triage protocol* (dispatch — shallow, descriptive); the
verdicts framework in `references/triage-verdicts.md` is for the **dedicated
issues** it spawns, not for the triage.

This skill is versioned in the repo (`.claude/skills/`) and shared with the team
— keep it accurate and English-only, like any tracked file. It orchestrates; the
`langflow-e2e` skill and its references (`authoring-conventions.md`,
`team-workflow.md`, `pr-guide.md`) hold the authoritative conventions — read
them, don't restate them.
