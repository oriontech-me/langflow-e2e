---
name: langflow-e2e-triage
description: >-
  Use when the task is to triage a daily E2E run and dispatch follow-up issues
  from oriontech-me/langflow-e2e — "triaga o daily", "faz a triagem da última
  run vermelha", "trabalha a umbrella #744", "abre as issues do daily-failure".
  Reads the latest red daily-stable run, groups failures by root cause, dedups
  against open issues, and orchestrates dedicated issue creation behind a
  propose-confirm gate.
---

# Langflow E2E — Daily Triage Dispatcher

Automates the **daily-run triage dispatcher** role a human analyst performs
today (`CONTRIBUTING.md` → *Triage protocol*): reads the latest red
`daily-stable.yml` run, groups failures by root cause, deduplicates against
open issues, and orchestrates creation/enrichment of the **dedicated
follow-up issues** — then closes the umbrella triage issue.

This skill is the **producer** of the dedicated issues that the sibling
`langflow-e2e-issues` / `langflow-e2e-issue-deterministic` skills later
**consume** to drive to a fix PR. No overlap: **triage dispatches, resolution
fixes.** This skill never investigates a failure's root cause — it reads a
run, groups symptoms, and opens issues that direct someone else to
investigate. It is **non-mutating by default**: it never edits test code as a
side effect of opening issues. The single exception is **quarantining** a
recurrent flake as prevention (hard failures are already auto-removed by the
workflow), and that happens **only behind its own explicit authorization**
(see the hard gate) — never bundled into issue creation, and it never restores
a tag. **Quarantine = remove `@stable` AND add `test.fixme(...)`** (not tag
removal alone — see the hard gate for why).

Repo: `oriontech-me/langflow-e2e`.

## Language rule (always)

Talk to the user in **Portuguese (PT-BR)**; produce every GitHub artifact
(issue titles, bodies, comments, labels) in **English**. Repo rule — see
`CLAUDE.md`.

## Hard gates (non-negotiable)

- **Propose → confirm → create.** Never run `gh issue create`, `gh issue
  edit`, `gh issue comment`, or `gh issue close` before the user has seen the
  consolidated plan (Phase 6) and explicitly said to proceed (e.g. "pode
  abrir"). Do all analysis and grouping first; the gate is the only thing
  standing between plan and execution — don't erode it by creating "just the
  obvious one" early.
- **Quarantine: separate gate, never inadvertent.** Quarantining a broken test
  is **prevention** — a **mandatory part of the triage**, but a code-mutating
  action that is **never a side effect of opening issues**: it needs its **own
  explicit authorization**, distinct from the issue-dispatch approval, with the
  **exact diff (`spec:line`) shown first**. **Quarantine = remove `@stable` AND
  add `test.fixme(<reason + issue #>)`, always together** — tag removal alone
  only stops the daily, so the test keeps going red on the impacted-specs gate
  (file-diff selected, not tag-filtered — #871); `test.fixme` skips it in every
  context. Full mechanism + why: `references/issue-templates.md` →
  *Quarantine mechanism*. Hard failures are already auto-removed by the workflow
  (tag only); only **recurrent flakes** are quarantined here (never automatic).
  The skill **never restores** either edit and never touches test *logic*, spec
  docs, or `QA-CHECKLIST.md` — un-`fixme` + restore-`@stable` is the dedicated
  issue's deliverable.
- **The triage does not close until the tags are gone.** The umbrella is closed
  only after every criterion-required removal is **verified done** (tag absent
  on `main` / its removal PR open and linked). If a removal was not authorized
  or not completed, leave the umbrella **open** and report exactly what is
  pending — never close on a half-done triage.
- **Report faithfully.** Everything reported — panorama counts, recurrence,
  guard state, dedup matches — comes from the dataset the CLI emits or from
  live `gh` output. Never invent a count, a recurrence, or a signature; if the
  dataset is silent on something (e.g. no `results.json` was supplied so
  per-skip detail is thin), say so instead of guessing.

## Companion skills — invoke when needed

- **`playwright-cli`** — drive a **live browser** to disambiguate grouping
  when the failure signature alone doesn't make it clear whether two failures
  share a root cause (e.g. confirm both specs hang on the same locator on the
  current nightly before folding them into one issue).
- **`superpowers:systematic-debugging`** — **not used here.** Triage stays
  **shallow and descriptive** by design; root-causing a failure is the job of
  the dedicated issue's future assignee (via `langflow-e2e-issues` /
  `-deterministic`), not this skill. Reaching for systematic-debugging inside
  a triage session is a sign you've crossed from dispatching into resolving —
  stop and hand off instead.

## Workflow

Track every phase with TodoWrite. Protocol order is **HARD FAILURES → FLAKES
→ SKIPS**, per `CONTRIBUTING.md` → *Triage protocol*, which this skill
mirrors and never overrides.

### Phase 0 — REFRESH

`reports/daily-history.jsonl` is committed to `main` **at the end** of the
`daily-stable.yml` run. If you triage the same day the run finished, the
latest line may not be on your local `main` yet.

```bash
git checkout main && git pull
```

Do this before running the CLI, every time — a stale checkout silently
triages yesterday's run.

### Phase 1 — INTAKE

Run the deterministic dataset builder:

```bash
node .claude/skills/langflow-e2e-triage/scripts/build-triage-dataset.mjs
```

It auto-discovers the latest red daily-stable run from
`reports/daily-history.jsonl`, cross-references 30-day flake recurrence,
detects the mass-failure guard, matches the umbrella `[Daily Failure]` issue
via `gh issue list --label daily-failure`, and prints a normalized `Dataset`
JSON: `run{run_id,run_url,date,langflow_image,duration_ms}`,
`umbrella_issue`, `guard_tripped`, `totals`, `hard_failures[]`, `flakes[]`
(each carrying `provider`/`model`, `recurrence`, and an `actionable` flag),
`provider_wide_clusters[]`, `skips[]`. Flags: `--run <id>` triages a specific
past run; `--results <json>` backfills provider labels + per-skip reasons.

**Citing recurrence faithfully:** cite `recurrence.count` / `recurrence.dates`
— they count only **same-signature** (same-cause) occurrences ("recurrent 3× on
07-13/15/16"). `recurrence.total_count` / `total_dates` also count the same
test's *different*-cause hits — context only; never quote them as the recurrence
figure (it overstates same-cause recurrence). `actionable` = `same_signature`
(≥ 2 same-signature hits).

If a local Playwright report exists for that run (downloaded or already on
disk), pass it for richer per-skip detail — the history file only carries
skip totals, not the per-test reason:

```bash
node .claude/skills/langflow-e2e-triage/scripts/build-triage-dataset.mjs --results results.json
```

Other flags: `--history <path>` (default `reports/daily-history.jsonl`),
`--window <days>` (default `30`, the recurrence window).

Read the full dataset before doing anything else. Then report the panorama
to the user in PT-BR: run id/date/image, **X hard failures / Y actionable
flakes (of Z total flakes) / W skips**, whether the **guard tripped** (and at
what count), and any **`provider_wide_clusters`** (same provider failing across
≥2 spec files — a descriptive hint the cause is environment/package, e.g. a
missing `langchain-<provider>`, not per-test rot; #899). This is the shared
frame of reference for every phase below.

### Phase 2 — DEDUP

Before proposing any new issue, check what's already open:

```bash
gh issue list --repo oriontech-me/langflow-e2e --state open --label daily-failure
```

For each candidate cluster (a hard-failure group, an actionable flake, an
unexpected skip), match its subject (symptom + area) against this list:

- **Match found** → mark the cluster **enrich** — it will get a comment on
  the existing issue, not a new one.
- **No match** → mark the cluster **create**.

This dedup pass happens before Phase 3–5 lock in the grouping, since knowing
"this already has a home" can change how aggressively you group new
occurrences under it.

### Phase 3 — GROUP (hard failures)

**Check `provider_wide_clusters` first:** when a cluster is flagged
`provider_wide`, treat that whole provider variant as **one** candidate cluster
(the shared cause is likely a package/environment gap for that provider) rather
than splitting it across per-symptom buckets — this is the #899 fix for the
misgrouping that hid #898's `langchain-google-genai` cause.

Then cluster the rest of `hard_failures[]` by root cause: **same normalized
error signature + same area + same failure symptom → one issue.** Don't open one
issue per failing spec by default — a shared root cause is one problem, not N.
Worked example: **#751** covers three specs under one "execution never completes"
issue because all shared the same timeout-waiting-for-completion shape, even
though the literal locator differed.

When `guard_tripped` is true the day is a mass-failure day (mostly collateral).
**Split the clusters:** **cross-day-recurrent** ones (same test+signature on
other non-adjacent dailies — durable) are created/enriched as usual;
**today-only collateral** is **noted, not filed** (aggregated with counts) and
recorded in the umbrella's closing comment — the umbrella still **closes** at
the end of triage (Phase 7). `@stable` is **kept** on everything. Full rule + wording: `references/issue-templates.md` →
*Guard-Tripped Rule*.

### Phase 4 — FLAKES

Only flakes with `actionable: true` (same `error_signature` recurring within
the window — the dataset already computed this) become dedicated issues. A
flake with `actionable: false` (a first occurrence, or a different signature
each time) is **only noted** in the panorama — the retry budget absorbs
single-run noise, and opening an issue for it would be triage noise of its
own.

For each actionable flake, the test must be **quarantined as prevention** (so it
stops running everywhere until it is worked) — part of the triage, not a
deferred follow-up. Quarantine = **remove `@stable` + add `test.fixme`**
together (see the hard gate + `references/issue-templates.md` → *Quarantine
mechanism*). But it is a code change: **record the exact spec path + line here**
and carry it into the plan (Phase 6) as its own row; it is executed only in
Phase 7, behind its **own authorization** with the diff shown (never restore it
here). The dedicated issue then carries **un-`fixme` + restore `@stable`** as an
explicit deliverable.

### Phase 5 — SKIPS

Only an **unexpected skip**, or one whose reason isn't already tracked by an
open issue, gets a dedicated issue. A known/intentional skip already linked
to an open issue is just noted in the panorama, not re-opened.

### Phase 6 — PLAN + GATE

Assemble everything from Phases 2–5 into one consolidated table and present
it to the user in PT-BR:

| # | Cluster (symptom/area) | Kind | Action | Target |
|---|---|---|---|---|
| 1 | ... | hard-failure / flake / skip | create / enrich / note | new issue title, or existing #NNN |

Below the table, list the **quarantines the triage requires** (remove `@stable`
+ add `test.fixme`) as a separate block — one line per recurrent flake
(`spec/path.spec.ts:line`). Hard failures are auto-removed by the workflow, so
do **not** list them.

Then **wait for explicit approval of the issue plan** ("pode abrir" or
equivalent). This approval covers issue create/enrich/close **only** — it does
**not** authorize any `@stable` removal; each removal gets its own confirmation
in Phase 7. Do not create, comment, close, or edit anything until the user
responds. If the user asks for changes to the grouping or wording, revise the
plan and present it again — the gate re-applies to the revised plan too.

### Phase 7 — EXECUTE (post-approval only)

Only after the user approves the plan:

1. For each **create** row: build the body with
   `renderDedicatedIssueBody()` from `scripts/lib/triage-core.mjs` — do **not**
   compose the Markdown by hand. The renderer owns section order, the
   provenance line and the canonical deliverables; it refuses a cluster with a
   missing `error_signature`, and `renderDedicatedIssueTitle()` refuses a title
   built from the run id instead of the umbrella number. Then run
   `assertDedicatedIssueBody(body, { throwOnError: true })` before
   `gh issue create`, and apply the area-label mapping in
   `references/issue-templates.md`.
2. For each **enrich** row: `gh issue comment` on the matched existing issue,
   per the same reference's *Enrich vs Create Rule*. Match on the **normalized
   signature**, not on a description of the symptom.
3. **Quarantines — separate authorization, one at a time.** For each recurrent
   flake in the removals block: show the **exact diff** (drop `@stable` **and**
   wrap the test as `test.fixme(<reason + issue #>)`, at `spec:line`) and ask
   for a **distinct** confirmation (e.g. "pode colocar o teste X em
   quarentena?"). Only on an explicit yes, open the quarantine PR (branch off
   `main`, apply both edits, reference the dedicated issue — un-`fixme` +
   restore is that issue's deliverable, never done here). If the user declines
   or defers, **do not edit** — record it as still pending. (Hard failures were
   already auto-removed by the workflow; on a guard-tripped mass-failure day
   nothing is quarantined here.)
4. Comment on the umbrella issue linking every dedicated issue just
   created/enriched (so the umbrella's history stays a readable index).
5. **Close the umbrella only when the triage is truly complete:** every needed
   dedicated issue created/enriched **and** every criterion-required `@stable`
   removal **verified done** (tag absent on `main`, or its removal PR open and
   linked). If any required removal is still pending (not authorized, not
   opened), **leave the umbrella open** and tell the user exactly what remains
   — never close on a half-done triage. Only when all are satisfied:
   `gh issue close <umbrella_issue>`.
   **A guard-tripped run is not an exception:** the umbrella closes there too,
   with the day's noted-not-filed collateral (Phase 3) listed in the closing
   comment. The standing record is `reports/daily-history.jsonl` — recurrence is
   recomputed from it on every triage, so a collateral cluster that persists is
   re-detected and filed by a later run's triage without an issue left open.

Report back to the user in PT-BR with the final list of issue numbers/URLs
created or enriched, each quarantine PR opened (and any quarantine left
pending), and whether the umbrella was closed or intentionally left open.

## Headless / CI mode

When invoked with a `--phase` argument (from
`.github/workflows/triage-dispatch.yml`, running via
`anthropics/claude-code-action@v1`), the skill runs **non-interactively**. The
human gate here is **not** an `AskUserQuestion` — it is a GitHub issue comment.
Two rules override the interactive flow:

- **Never call `AskUserQuestion`** and never block on human input. The CI job
  has no interactive channel; a prompt would hang the run.
- **Never edit code.** The CI job runs with `--allowedTools "Read,Bash"` (no
  `Edit`/`Write`) and `contents: read`. Quarantine is therefore **out of the
  automated path** — it stays a manual/local PR (list it, never do it here).

The invocation may carry the umbrella issue number as `--issue <n>` (manual
`workflow_dispatch`). When `--issue` is absent (the `workflow_run` auto-trigger),
**self-discover** the umbrella: use the umbrella the Phase-1 dataset already
matched (`gh issue list --repo oriontech-me/langflow-e2e --state open --label
daily-failure`). If no open umbrella is found, post nothing and stop with a
logged note.

### `--phase propose` (scheduled, unattended)

Run **Phase 0–6** exactly as documented, with one substitution at Phase 6:
instead of presenting the plan and waiting for "pode abrir", **post the plan as
a comment on the umbrella issue** and stop.

- **Per-skip reasons:** the `workflow_run` job downloads the daily's
  `results.json` (best-effort). In Phase 1, pass `--results results.json` when
  present so Phase 5 sees real per-skip reasons; if absent, run history-only and
  **say so** in the proposal ("per-skip detail unavailable — totals only").
- Build the same Phase-6 table plus the quarantine block.
- Post it with `gh issue comment <n>`, whose **first line is the exact marker**
  `<!-- triage-proposal -->` so Phase execute finds it deterministically.
- End the comment with: *"A triage-team member: reply `pode abrir` on this
  issue to create/enrich the dedicated issues. Quarantines listed above are
  manual/local TODOs — they are NOT performed by the automation."*
- Then **STOP**. Create nothing, enrich nothing, close nothing, edit nothing.

**Always leave an observable trace — never a silent no-op.** Propose must end
by posting exactly one comment on the umbrella, whatever the outcome. A silent
run is indistinguishable from a broken post, so every terminal path posts:

- **Actionable clusters found** → post the full plan comment (the marker
  `<!-- triage-proposal -->` case above).
- **Nothing new to triage** (Phase-2 dedup shows every cluster already has a
  dedicated issue, or the run's umbrella is already closed/triaged) → post a
  one-line note `<!-- triage-proposal -->` + "Nothing new to triage — every
  cluster from run `<run_id>` is already dispatched." and stop.
- **No red run found, or the history is stale** → post a one-line
  "Nothing to triage — no red run found / history stale." note and stop.
- **Guard-tripped mass-failure day** → still post the plan (durable cross-day
  clusters as create/enrich rows; today-only collateral as **note** rows), and
  state descriptively that the guard tripped (count + threshold) and that
  `@stable` was left in place. The umbrella still closes at the end of triage,
  carrying the collateral in its closing comment (Phase 3 + Phase 7; guard rule
  in `references/issue-templates.md`).

### `--phase execute` (triggered by an approved "pode abrir" comment)

The workflow's `if:` gate already verified the approval (open umbrella,
`daily-failure` label, phrase present, whitelisted commenter) — treat the
trigger itself as the authorization; do not re-ask.

- Read the **latest** `<!-- triage-proposal -->` comment on the umbrella
  (`gh issue view <n> --json comments`). Act on that reviewed plan — do not
  silently re-derive a different one. If **no** `<!-- triage-proposal -->`
  comment exists on the umbrella, do **not** re-derive a plan — post a short
  comment ("No triage proposal found on this issue — run `--phase propose`
  first.") and stop.
- Re-run the **Phase 2 dedup** pass before creating, so a re-approval enriches
  instead of duplicating.
- Run **Phase 7 steps 1, 2, 4, 5** (create / enrich / link-on-umbrella /
  close-if-complete). **Skip step 3** (quarantine — manual/local).
- **Umbrella closure:** close only if the triage is complete **and** no
  criterion-required quarantine is pending. If a recurrent-flake quarantine is
  required, leave the umbrella **open** and post a checklist comment listing the
  pending manual/local quarantines (`spec/path.spec.ts:line`), so a human
  finishes them locally.
- Post a final comment summarizing the issues created/enriched and the umbrella
  state (closed, or left open with N pending removals).

## Relationship to sibling skills

- **`langflow-e2e-triage`** (this skill) — **producer**: turns one red daily
  run into dedicated follow-up issues and, as prevention, quarantines recurrent
  flakes (behind its own gate). It never investigates a root cause, fixes a
  test, or restores a quarantine — restoration is the consumer's deliverable.
- **`langflow-e2e-issues`** / **`langflow-e2e-issue-deterministic`** —
  **consumers**: pick up a dedicated issue this skill spawned and drive it to
  a fix PR (their `daily-failure triage` classify-row explicitly says
  dispatch-only issues route back here; a **dedicated** `fix` issue is what
  they resolve).
- Neither this skill nor its output ever asserts a verdict on cause — that
  classification happens on the dedicated issue, during resolution, per
  `references/triage-verdicts.md` in the sibling skills.

## Pointers

- **`references/issue-templates.md`** — the canonical dedicated-issue
  template (title format, sections, worked example from #751), the
  directory→`area:` label map, the flake-signal block, the enrich-vs-create
  rule, and the guard-tripped rule. Read it before drafting any issue body —
  don't freehand the structure.
- **`CONTRIBUTING.md` → *Triage protocol — working the triage issue*** — the
  canonical human protocol this skill automates. On any conflict between this
  SKILL.md and `CONTRIBUTING.md`, follow `CONTRIBUTING.md` and fix the skill.
