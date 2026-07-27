# Decision — Regression Ledger (`REGRESSIONS.md`)

**Date:** 2026-07-17 · **Shared with the team:** 2026-07-27
**Status:** Active — `REGRESSIONS.md` is live at the repo root and carries the
regressions listed below. Curation is mandatory (`CONTRIBUTING.md`) and CI
guards the indicator against drift.
**Owner:** Rafael

---

## The problem

The suite's core value is catching **real Langflow regressions** — product
breakage a green run would never prove. Today that value is invisible, because
the evidence is scattered across three places that each lose part of it:

- **Ad-hoc markdown at the repo root** (`LANGFLOW-BUG-*.md`, `ISSUE-*.md`) —
  no shared schema, no index, no count.
- **`reports/daily-history.jsonl`** — records only run outcomes (green/red). It
  cannot distinguish a real product regression from a flake or an
  environment-saturation failure.
- **The deterministic pipeline** — classifies a `langflow-regression` verdict
  per issue (`evidence.decision`), but that signal stays trapped inside one
  issue's runtime state and is never aggregated.

No single artifact answers the question that matters most: *how many real
Langflow regressions has this suite caught, and what is their status?*

## The decision

Keep one curated, append-only ledger at `REGRESSIONS.md` (repo root,
deliberately visible) that is simultaneously:

1. the **ROI indicator** — how many real regressions caught, by severity, by
   area; and
2. the **canonical registry** of confirmed product regressions, each linked to
   its upstream ticket and detailed bug report.

## The qualifying bar — all three, no exceptions

A row is added **only** when all three hold:

1. **`langflow-regression` verdict** — confirmed product breakage (something
   that worked and broke, or violates the product's own contract). Not a flake,
   saturation failure, test-defect, or product-changed verdict.
2. **Adversarially validated** — the finding survived a refute-first review:
   every claim in the bug report was treated as a hypothesis to *disprove*, not
   confirm, across source + API + UI axes where applicable. This is the gate
   that keeps overstated findings out.
3. **Filed upstream ticket** — DataStax Jira `LE-####` or a
   `langflow-ai/langflow` GitHub issue.

This high bar is the whole point: every number in the indicator maps to a real,
adversarially-validated, externally-tracked product regression. A count that
anyone can puncture is worth less than no count at all.

### Scope — what the suite caught, not what QA confirmed

Decided 2026-07-27, when seeding the ledger surfaced the ambiguity. A row must
trace to a **spec failure or a spec-validation run recorded in a repo issue**
(the `Detected by` column). Regressions the QA team confirms by hand — a manual
Desktop session, an API investigation outside the suite — are real and are
filed upstream, but they do not earn a row: counting them would turn this file
into a QA-team indicator rather than a suite indicator, and would silently
include surfaces (Desktop) the suite does not test.

Two regressions Rafael reported in this window sit exactly on that line and are
deliberately excluded: **LE-1929** (Message History returns another flow's chat
history for a colliding `session_id`, on all three execution paths) and
**LE-2010** (Multi Agent Flow + Gemini fails with *"Requests ending with a model
turn are not supported"*). Both are confirmed, both are fixed upstream, neither
was caught by a spec.

### What does not earn a row

| Case | Where it goes |
|---|---|
| Confirmed regression, **no upstream ticket yet** | **Candidates** list at the bottom — not counted, promoted the moment a ticket is filed |
| Real gap, but validation downgraded it to non-user-facing | **Nowhere.** Kept as a standalone report for reference only |
| Flake, saturation failure, test-defect, product-changed | Never listed |

**Worked counter-example.** The bulk-delete SQLite-lock 500
(`LANGFLOW-BUG-bulk-flow-delete-sqlite-lock.md`) was adversarially validated by
Victor on 2026-07-14 (`bulk-flow-delete-500-validation.md`). The validation
confirmed the backend gap on three axes **but refuted two of the report's
claims** — the trigger is narrower than "any blank-flow navigation", and the
500 is masked by a client-side retry, so the user sees success. Net: Medium →
**Low**, observability noise, a long-standing robustness gap rather than a
regression, no upstream ticket. It is neither a ledger row nor a candidate.

## Row schema

Nine columns, hand-curated:

`Found` · `Area / Test` · `Regression` · `Severity` · `Detected by` ·
`Upstream` · `Status` · `Fixed in` · `Report`

`Severity` ∈ {High, Medium, Low}; `Status` ∈ {Open, Fixed}. The `Area / Test`
cell is `area · spec-file` — the area token before the `·` is what the
by-area breakdown counts.

`Severity` is **our** rating of user impact, not the Jira priority. Three of
the four seeded rows are `Minor` on the board and two of them are `High` here —
LE-1974 makes every Google model unbuildable, LE-1850 leaves a user
authenticated after clicking Logout. `Fixed in` carries the upstream PR that
resolved the row; it is replaced by the Langflow version once the suite re-runs
green against a build carrying that fix. The PR is what we can verify today;
the version is what we will have verified.

## Indicator block — generated, never hand-edited

A block at the top of the file, between `<!-- REGRESSIONS:START -->` and
`<!-- REGRESSIONS:END -->`, holding lean metrics only: total caught, open vs
fixed, by severity, by area. No mean-time-to-fix or other time-series metrics —
lean by decision.

Generated by `scripts/regressions-summary.ts` via `npm run regressions:summary`,
mirroring the existing `scripts/coverage-summary.ts` marker-block pattern:

- The row table is the single source of truth; the script rewrites only the
  marked block.
- **Idempotent** — a second run with no data change produces no diff.
- **Fails loudly** — a wrong headline number is the one outcome the ledger
  cannot afford, so the script aborts on: a missing, duplicated or
  **out-of-order** marker pair; a missing **or empty** `## Ledger` section; a
  row without exactly 9 columns; a `Severity` / `Status` outside its set; an
  `Area / Test` cell missing the `area · spec-file` separator (which would
  otherwise report a spec path as an area); and **two rows carrying the same
  `Upstream` ticket** (a pasted row would otherwise inflate the count).

Regeneration stays a local, hand-run step, but drift is now caught in CI:
`npm run regressions:check` recomputes the block and exits non-zero when the
committed one disagrees, wired as a step of the existing typecheck job in
`pr-validation.yml`.

**On committing a generated block in a PR.** This is precisely the pattern
`scripts/check-checklist-guard.mjs` forbids for `QA-CHECKLIST.md`, where
concurrent `@stable` PRs collided on the same count lines (issue #741). The
ledger is deliberately the exception: it changes a handful of times per quarter,
never on the same lines as another PR's work, so the collision risk that
justified the guard does not apply — and hand-committing keeps the row and its
count in one reviewable diff. If the rate ever rises, the resolution is a CI
auto-regen job mirroring `update-coverage-summary.yml`, not a second guard.

## What this changes for the team

Adding a row is a **mandatory step**, not an optional chore — that is the only
reason a curated ledger stays current:

- **Pipeline (`langflow-e2e-issue-deterministic`)** — when DEBUG records a
  `langflow-regression` verdict and an upstream ticket is filed, the REPORT
  phase checklist includes "add the row to `REGRESSIONS.md`".
- **Triage (`langflow-e2e-triage`)** — unchanged. Triage dispatches, it does not
  confirm verdicts; a regression enters the ledger only after the consuming
  resolution confirms the verdict and files the ticket.
- **Manual investigations** — same rule, same three requirements.

The flow:

```
confirm langflow-regression verdict   (pipeline DEBUG / manual investigation)
  └─ file upstream ticket (Jira LE-#### or GH issue)
      └─ add row to REGRESSIONS.md          [mandatory REPORT step]
          └─ npm run regressions:summary    (regenerates the indicator block)
              └─ commit
```

Documented in `CONTRIBUTING.md` → *Regression Ledger — record every confirmed
regression*.

## Explicit non-goals

- **No automatic ingestion hook** in the pipeline or triage — YAGNI. Rows are
  added by hand as part of confirming a regression.
- **No time-series metrics** (mean-time-to-fix and friends).
- **Not a replacement** for the detailed per-bug reports — those stay as
  standalone documents; the ledger consolidates and links to them.

## Seed — the five regressions the suite has caught

Re-derived on 2026-07-27 from the Jira board and the repo's issue trail. The
original 2026-07-17 seed listed a single row and was already wrong on three
counts: LE-1850 had been fixed, three more regressions had been filed since,
and both candidates were dead.

| Found | Area | Regression | Sev | Detected by | Upstream | Status | Fixed in |
|---|---|---|---|---|---|---|---|
| 07-27 | flows | "New Flow" click silently dropped when the flows list has not painted its cards yet — no navigation, no modal, no console error, and the button then stops being actionable until a reload | Medium | daily 07-27 · #962 → #966 | [LE-2019](https://datastax.jira.com/browse/LE-2019) | **Open** | — |
| 07-24 | mcp | `resources/read` crashes with `AttributeError: 'str' object has no attribute 'hex'` — the project server advertises a flow file it cannot read (worked on 1.11.0) | Medium | #948 spec validation | [LE-2012](https://datastax.jira.com/browse/LE-2012) | **Open** (Ready for QA) | — |
| 07-23 | model-provider | Groq / Mistral / Ollama components silently hidden from the sidebar — image ships the component source but not the `langchain-*` package, and Langflow hides the component with no message | Medium | daily 07-23 · #907 | [LE-1987](https://datastax.jira.com/browse/LE-1987) | Fixed | [langflow#14248](https://github.com/langflow-ai/langflow/pull/14248) |
| 07-22 | model-provider | Nightly ships without `langchain-google-genai` — every Google chat/embedding model raises ImportError at build; surfaced as node-build timeouts across ~17 `@stable` specs | High | daily 07-22 · #898 | [LE-1974](https://datastax.jira.com/browse/LE-1974) | Fixed | [langflow#14220](https://github.com/langflow-ai/langflow/pull/14220) |
| 07-17 | auth | Logout does not terminate the session — no `POST /api/v1/logout` fired, and `POST /api/v1/refresh` silently re-authenticates so the session survives a reload | High | daily 07-17 · #808 | [LE-1850](https://datastax.jira.com/browse/LE-1850) | Fixed | [langflow#14158](https://github.com/langflow-ai/langflow/pull/14158) |

Indicator: `Regressions caught: 5 — Open: 2 · Fixed: 3`,
`High 2 · Medium 3 · Low 0`, `model-provider 2 · auth 1 · flows 1 · mcp 1`.

**Candidates: none.** The New Flow dead click was the sole candidate for a few
hours on 2026-07-27 — short of two requirements, since it had no ticket and its
last-known-good was unverified. Filing LE-2019 closed both gaps in one move: the
ticket exists, and the investigation behind it established 1.10.0 as the last
good build with 1.10.1 (langflow#12575) as the first affected, refuting the
initial "1.12 regression" reading by comparing the nightly and 1.11.x frontend
trees. It was promoted the same day. That is the intended lifecycle, not an
exception.

**Not listed, recorded so nobody re-litigates them:** the bulk-delete
SQLite-lock 500 (validated non-regression, downgraded to Low observability
noise with two claims refuted); #643, the Anthropic HTTP 400 on a thinking
block + tool call (fixed upstream on 1.12.0.dev0 by the `langchain-anthropic`
1.3.5 → 1.4.8 bump, never ticketed, so it never qualified); and #552, closed on
triage without a confirmed verdict. The last two were the original candidates.

## Implementation status

Live on `main`. The ledger, the generator, the `CONTRIBUTING.md` rule and this
record shipped together; the CI drift check, the `CLAUDE.md` rule for agents and
the LE-2019 row followed in the review round.

| File | Role |
|---|---|
| `REGRESSIONS.md` | The ledger — scope + curation notes, generated marker block, row table, candidates, non-regression list |
| `scripts/regressions-summary.ts` | Indicator generator; `--check` mode for CI |
| `package.json` | `regressions:summary` and `regressions:check` scripts |
| `.github/workflows/pr-validation.yml` | Runs `regressions:check` in the typecheck job |
| `CONTRIBUTING.md` | The mandatory curation step, for humans |
| `CLAUDE.md` | The never-hand-edit rule for the generated block, for agents |
| `docs/product-regression-core/regression-ledger.md` | This decision record |

Verified 2026-07-27 against the live ledger: the generator emits
`5 regression(s)` matching the table by hand-count; a second run reports
*already up to date* with no diff; `regressions:check` passes in sync and exits
1 with the expected block when the committed one is stale; and each guard was
reproduced against a deliberately broken copy — reversed markers, an emptied
`## Ledger` table, a 8-column row, a `Critical` severity, an `Area / Test` cell
without the separator, and a duplicated row all abort instead of publishing a
number. `typecheck` and `lint` report 0 errors.

The one thing that still ages: `Fixed in` carries the fixing upstream PR on
three rows, not a verified Langflow version. Each becomes a version the next
time the corresponding spec runs green on a build that contains the fix.
