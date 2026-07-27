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

**Scope: regressions this suite caught.** Every row traces to a spec failure or
a spec-validation run recorded in a repo issue (the `Detected by` column). A
regression the QA team confirmed by hand — a manual Desktop session, an API
investigation outside the suite — belongs on the Jira board, not here; counting
it would make this file a QA-team indicator instead of a suite indicator.

**Adding a row is a mandatory step** when a resolution confirms a
`langflow-regression` verdict and files the ticket (pipeline REPORT phase /
manual investigation) — see `CONTRIBUTING.md`. After editing the table, run
`npm run regressions:summary` to regenerate the indicator block, then commit.
Never hand-edit the block between the markers.

`Fixed in` carries the upstream PR that resolved the row. It is replaced by the
Langflow version once the suite re-runs green against a build carrying that fix
— the PR is what we can verify today, the version is what we will have verified.

<!-- REGRESSIONS:START -->
**Regressions caught:** 4 — **Open:** 1 · **Fixed:** 3

**By severity:** High 2 · Medium 2 · Low 0

**By area:** model-provider 2 · auth 1 · mcp 1
<!-- REGRESSIONS:END -->

## Ledger

| Found | Area / Test | Regression | Severity | Detected by | Upstream | Status | Fixed in | Report |
|-------|-------------|------------|----------|-------------|----------|--------|----------|--------|
| 2026-07-24 | mcp · mcp-server-resources.spec.ts | MCP `resources/read` crashes with `AttributeError: 'str' object has no attribute 'hex'` — the project server advertises a flow file it cannot itself read (worked on 1.11.0) | Medium | #948 spec validation | [LE-2012](https://datastax.jira.com/browse/LE-2012) | Open | — | docs/upstream-bugs/UPSTREAM-BUG-mcp-resources-read-uuid-hex.log |
| 2026-07-23 | model-provider · groq-provider.spec.ts | Groq / Mistral / Ollama components silently hidden from the sidebar — the image ships the component source but not the provider's `langchain-*` package, and Langflow now hides the component with no message | Medium | daily 07-23 · #907 | [LE-1987](https://datastax.jira.com/browse/LE-1987) | Fixed | [langflow#14248](https://github.com/langflow-ai/langflow/pull/14248) | #907 |
| 2026-07-22 | model-provider · google-provider.spec.ts | Nightly ships without `langchain-google-genai` — every Google chat/embedding model raises ImportError at build; surfaced as node-build timeouts across ~17 `@stable` specs | High | daily 07-22 · #898 | [LE-1974](https://datastax.jira.com/browse/LE-1974) | Fixed | [langflow#14220](https://github.com/langflow-ai/langflow/pull/14220) | #898 |
| 2026-07-17 | auth · logout-flow.spec.ts | Logout does not terminate the session — no redirect to login, no `POST /api/v1/logout` fired, and `POST /api/v1/refresh` silently re-authenticates so the session survives a reload | High | daily 07-17 · #808 | [LE-1850](https://datastax.jira.com/browse/LE-1850) | Fixed | [langflow#14158](https://github.com/langflow-ai/langflow/pull/14158) | #808 |

## Candidates — pending upstream ticket

Confirmed locally but not yet filed upstream; promoted to a Ledger row the
moment a ticket is filed. Not counted in the indicator.

| Found | Area / Test | Regression | Severity | Report |
|-------|-------------|------------|----------|--------|
| 2026-07-27 | flows · run-flow.spec.ts | "New Flow" fires `POST /api/v1/flows` (201) but never navigates — neither the welcome panel nor the templates modal opens, and the created flow only appears after a reload. Intermittent and session-dependent: 7/8 dead on repeat clicks in one browser context, 7/8 alive with a fresh context per click | — | docs/upstream-bugs/UPSTREAM-BUG-new-flow-creates-without-navigating.log |

The New Flow candidate is short of **two** requirements, not one: no ticket is
filed, and `Last known good` is unverified — it was only ever run on
1.12.0.dev6, so it is a defect observed on that build until section 5 of the
evidence log is re-run against 1.11.x. Tracked in #966.

## Not listed — validated non-regression

Findings deliberately kept out of both tables, so nobody re-litigates them:

- **Bulk-flow-delete SQLite-lock 500** (`LANGFLOW-BUG-bulk-flow-delete-sqlite-lock.md`)
  — adversarially validated (`bulk-flow-delete-500-validation.md`, 2026-07-14)
  and downgraded to Low / non-user-facing observability noise, with two report
  claims refuted. A real robustness gap, not a countable regression.
- **#643 — Anthropic HTTP 400 on a thinking block + tool call** — confirmed and
  then fixed upstream on 1.12.0.dev0 by the `langchain-anthropic` 1.3.5 → 1.4.8
  bump. No ticket was ever filed, so it never qualified; it is fixed, not
  pending. (Former candidate.)
- **#552 — no echo response for gemini-3.5-flash in `mcp-client-agent`** —
  closed on triage 2026-07-10 without a confirmed `langflow-regression` verdict
  or a filed ticket. (Former candidate.)
