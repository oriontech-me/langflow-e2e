# Decision — Regression Ledger (`REGRESSIONS.md`)

**Date:** 2026-07-17 · **Shared with the team:** 2026-07-27
**Status:** Implemented and seeded with 4 regressions on branch
`docs/regression-ledger-decision` — not merged, no PR yet
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
- **Fails loudly** — a malformed row (wrong column count, `Severity` outside
  High/Medium/Low, `Status` outside Open/Fixed), a missing `## Ledger` section,
  or a missing/duplicated marker aborts the run rather than emitting wrong
  counts.

Regeneration is local for now. A CI auto-regen job mirroring
`update-coverage-summary.yml` is a possible later addition, deliberately out of
scope.

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

## Seed — the four regressions the suite has caught

Re-derived on 2026-07-27 from the Jira board and the repo's issue trail. The
original 2026-07-17 seed listed a single row and was already wrong on three
counts: LE-1850 had been fixed, three more regressions had been filed since,
and both candidates were dead.

| Found | Area | Regression | Sev | Detected by | Upstream | Status | Fixed in |
|---|---|---|---|---|---|---|---|
| 07-24 | mcp | `resources/read` crashes with `AttributeError: 'str' object has no attribute 'hex'` — the project server advertises a flow file it cannot read (worked on 1.11.0) | Medium | #948 spec validation | [LE-2012](https://datastax.jira.com/browse/LE-2012) | **Open** (Ready for QA) | — |
| 07-23 | model-provider | Groq / Mistral / Ollama components silently hidden from the sidebar — image ships the component source but not the `langchain-*` package, and Langflow hides the component with no message | Medium | daily 07-23 · #907 | [LE-1987](https://datastax.jira.com/browse/LE-1987) | Fixed | [langflow#14248](https://github.com/langflow-ai/langflow/pull/14248) |
| 07-22 | model-provider | Nightly ships without `langchain-google-genai` — every Google chat/embedding model raises ImportError at build; surfaced as node-build timeouts across ~17 `@stable` specs | High | daily 07-22 · #898 | [LE-1974](https://datastax.jira.com/browse/LE-1974) | Fixed | [langflow#14220](https://github.com/langflow-ai/langflow/pull/14220) |
| 07-17 | auth | Logout does not terminate the session — no `POST /api/v1/logout` fired, and `POST /api/v1/refresh` silently re-authenticates so the session survives a reload | High | daily 07-17 · #808 | [LE-1850](https://datastax.jira.com/browse/LE-1850) | Fixed | [langflow#14158](https://github.com/langflow-ai/langflow/pull/14158) |

Indicator: `Regressions caught: 4 — Open: 1 · Fixed: 3`,
`High 2 · Medium 2 · Low 0`, `model-provider 2 · auth 1 · mcp 1`.

**Candidate (1, uncounted):** the "New Flow" button fires
`POST /api/v1/flows` (201) but never navigates — neither the welcome panel nor
the templates modal opens (#966, evidence log under `docs/upstream-bugs/`). It
is short of **two** requirements: no ticket filed, and `Last known good` is
unverified — it was only run on 1.12.0.dev6, so it is a defect on that build
until the evidence log's comparison section is re-run against 1.11.x.

**Not listed, recorded so nobody re-litigates them:** the bulk-delete
SQLite-lock 500 (validated non-regression, downgraded to Low observability
noise with two claims refuted); #643, the Anthropic HTTP 400 on a thinking
block + tool call (fixed upstream on 1.12.0.dev0 by the `langchain-anthropic`
1.3.5 → 1.4.8 bump, never ticketed, so it never qualified); and #552, closed on
triage without a confirmed verdict. The last two were the original candidates.

## Implementation status

Branch `docs/regression-ledger-decision`, cut from current `main` — this
document plus the four original implementation commits (2026-07-17), rebased
forward and re-seeded. **Local only: not pushed, no PR, not merged.** The
original `feat/regression-ledger` branch is superseded.

| File | Change |
|---|---|
| `REGRESSIONS.md` | New — scope + curation note, marker block, 4-row ledger, candidate, non-regression list |
| `scripts/regressions-summary.ts` | New — indicator generator (149 lines) |
| `package.json` | `regressions:summary` script |
| `CONTRIBUTING.md` | New section documenting the mandatory curation step |
| `docs/product-regression-core/regression-ledger.md` | This decision record |

Verified on 2026-07-27 against the re-seeded ledger: the generator emits
`4 regression(s)` matching the table by hand-count, a second run reports
*already up to date* with no diff, a `Critical` severity row throws
`Invalid Severity`, an 8-column row throws `Malformed ledger row`, and
`typecheck` / `lint` report 0 errors.

**Open decision for the team:** push and open the PR. The one thing that will
age is `Fixed in` — three rows carry the fixing PR rather than a verified
Langflow version, and each becomes a version the next time the corresponding
spec runs green on a build that contains the fix.
