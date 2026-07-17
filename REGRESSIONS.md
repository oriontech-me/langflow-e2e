# Regression Ledger

The suite's core value is catching **real Langflow regressions** — product
breakage a green run would never prove. This file is the curated, append-only
registry of every such catch, and the source of the ROI indicator below.

**A row is added ONLY when all three hold** (see the design spec for the worked
rationale): (1) a confirmed `langflow-regression` verdict — real product
breakage, not a flake, saturation failure, test-defect, or expected change;
(2) **adversarially validated** — the finding survived a refute-first review
(every claim treated as a hypothesis to disprove across source/API/UI where
applicable); (3) a **filed upstream ticket** (DataStax Jira `LE-####` or a
`langflow-ai/langflow` GitHub issue). A regression confirmed but not yet
ticketed goes under **Candidates** until a ticket is filed. A finding that
adversarial validation downgrades to a non-user-facing / non-regression
robustness gap is listed nowhere here.

**Adding a row is a mandatory step** when a resolution confirms a
`langflow-regression` verdict and files the ticket (pipeline REPORT phase /
manual investigation) — see `CONTRIBUTING.md`. After editing the table, run
`npm run regressions:summary` to regenerate the indicator block, then commit.
Never hand-edit the block between the markers.

<!-- REGRESSIONS:START -->
<!-- Run `npm run regressions:summary` to generate this block. -->
<!-- REGRESSIONS:END -->

## Ledger

| Found | Area / Test | Regression | Severity | Detected by | Upstream | Status | Fixed in | Report |
|-------|-------------|------------|----------|-------------|----------|--------|----------|--------|
| 2026-07-17 | auth · logout-flow.spec.ts | Logout does not terminate the session (no redirect to login; session survives reload) | High | daily 07-17 · #808 | [LE-1850](https://datastax.jira.com/browse/LE-1850) | Open | — | LANGFLOW-BUG-logout-does-not-terminate-session.md |

## Candidates — pending upstream ticket

Confirmed locally but not yet filed upstream; promoted to a Ledger row the
moment a ticket is filed. Not counted in the indicator.

| Found | Area / Test | Regression | Severity | Report |
|-------|-------------|------------|----------|--------|
| 2026-07-07 | mcp · mcp-client-agent.spec.ts | Two independent nightly breakages in the MCP client agent flow | — | ISSUE-552-UPSTREAM-BUGS.md |
| 2026-07-13 | mcp · mcp-client-agent.spec.ts | Agent turn aborts with Anthropic HTTP 400 when a thinking-capable Claude model combines an extended-thinking block with a tool call | — | ISSUE-643-UPSTREAM-BUG.md |

## Not listed — validated non-regression

For the record: `LANGFLOW-BUG-bulk-flow-delete-sqlite-lock.md` was
adversarially validated (`bulk-flow-delete-500-validation.md`, 2026-07-14) and
downgraded to Low / non-user-facing observability noise (two report claims
refuted). It is a real robustness gap but not a countable regression — kept as
a report for reference only, deliberately absent from the ledger and candidates.
