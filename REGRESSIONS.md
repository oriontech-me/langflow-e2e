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

`Report` is the committed evidence file when one exists, and otherwise the repo
issue that carries the evidence. Both shapes are allowed; what is not allowed is
a reference that does not resolve.

<!-- REGRESSIONS:START -->
**Regressions caught:** 7 — **Open:** 4 · **Fixed:** 3

**By severity:** High 2 · Medium 5 · Low 0

**By area:** model-provider 2 · api 1 · auth 1 · core-components 1 · flows 1 · mcp 1
<!-- REGRESSIONS:END -->

## Ledger

| Found | Area / Test | Regression | Severity | Detected by | Upstream | Status | Fixed in | Report |
|-------|-------------|------------|----------|-------------|----------|--------|----------|--------|
| 2026-07-28 | core-components · nested-grouping-regression.spec.ts | Grouping two connected non-IO components raises a false `Error while updating the Component` notification although the grouping fully succeeds — the `PATCH /api/v1/flows/{id}` that persists the grouped shape returns `200`, the console logs no error and no request fails, yet the message persists in the Notifications panel until dismissed by hand. Deterministic; reproduced independently in a manual browser session | Medium | #942 spec validation | [LE-2045](https://datastax.jira.com/browse/LE-2045) | Open | — | docs/upstream-bugs/UPSTREAM-BUG-group-cosmetic-error-toast.md |
| 2026-07-27 | api · api-folders-crud.spec.ts | `DELETE /api/v1/projects/{id}` answers `500` (`sqlite3.OperationalError: database is locked`) instead of `204` while any other write is in flight, and the project survives. Not new — stable 1.10.3 emits the same instant `500` — but 1.12 raises the rate ~7× (6 % → 44 % at 2 concurrent clients, A/B/A/B) and flips the mode: 1.10.3 blocks and mostly honours the contract, 1.12 gives up in 0.03 s. Sibling write endpoints (`POST /projects`, `POST /flows`, `DELETE /flows`) survive the identical contention | Medium | daily 07-22 + 07-27 · #962 → #965 | [LE-2020](https://datastax.jira.com/browse/LE-2020) | Open | — | docs/upstream-bugs/UPSTREAM-BUG-project-delete-500-under-contention.md |
| 2026-07-27 | flows · run-flow.spec.ts | "New Flow" click is silently dropped when the flows list has not painted its cards yet — no navigation, no modal, no console error, and the button then stops being actionable until a reload. Introduced in 1.10.1 by langflow#12575; 1.10.0 opened the templates modal and created nothing | Medium | daily 07-27 · #962 → #966 | [LE-2019](https://datastax.jira.com/browse/LE-2019) | Open | — | docs/upstream-bugs/UPSTREAM-BUG-new-flow-dead-click.md |
| 2026-07-24 | mcp · mcp-server-resources.spec.ts | MCP `resources/read` crashes with `AttributeError: 'str' object has no attribute 'hex'` — the project server advertises a flow file it cannot itself read (worked on 1.11.0) | Medium | #948 spec validation | [LE-2012](https://datastax.jira.com/browse/LE-2012) | Open | — | docs/upstream-bugs/UPSTREAM-BUG-mcp-resources-read-uuid-hex.log |
| 2026-07-23 | model-provider · groq-provider.spec.ts | Groq / Mistral / Ollama components silently hidden from the sidebar — the image ships the component source but not the provider's `langchain-*` package, and Langflow now hides the component with no message. Mechanism note (measured on 1.12.0.dev8, #1039): the `langchain-*` diagnosis still holds, but it is only one of two gates — 1.12 also moved components out of `lfx.components.*` into per-vendor distributions plus an aggregate `lfx-bundles` package, and the default image installs neither that package nor the two extras. Only Ollama returned to the default image; Groq and Mistral stay out by product decision, which is not a regression | Medium | daily 07-23 · #907 | [LE-1987](https://datastax.jira.com/browse/LE-1987) | Fixed | [langflow#14248](https://github.com/langflow-ai/langflow/pull/14248) | #907 |
| 2026-07-22 | model-provider · google-provider.spec.ts | Nightly ships without `langchain-google-genai` — every Google chat/embedding model raises ImportError at build; surfaced as node-build timeouts across ~17 `@stable` specs | High | daily 07-22 · #898 | [LE-1974](https://datastax.jira.com/browse/LE-1974) | Fixed | [langflow#14220](https://github.com/langflow-ai/langflow/pull/14220) | #898 |
| 2026-07-17 | auth · logout-flow.spec.ts | Logout does not terminate the session — no redirect to login, no `POST /api/v1/logout` fired, and `POST /api/v1/refresh` silently re-authenticates so the session survives a reload | High | daily 07-17 · #808 | [LE-1850](https://datastax.jira.com/browse/LE-1850) | Fixed | [langflow#14158](https://github.com/langflow-ai/langflow/pull/14158) | #808 |

Note on the LE-2020 row, so the earlier adjudication is not re-litigated blindly:
the *Bulk-flow-delete SQLite-lock 500* entry under *Not listed* was downgraded
because a client-side retry masked the failure. That defence was re-tested for
this row and holds **only at light contention** — 6/6 UI deletes succeeded at 2
background writers, 2 of them via a masked retry. With 4 writers the retry budget
is exhausted and the delete **silently no-ops**: project still in the sidebar, no
toast, notification centre empty, only a console error. That silent no-op is what
makes the row user-facing; it is Medium, not High, because it needs sustained
concurrent writes.

**Second affected endpoint, same ticket (2026-07-29, #930 → #932).**
`PATCH /api/v1/flows/{id}` fails the same way — `500 (sqlite3.OperationalError)
database is locked` on `UPDATE flow SET folder_id`, with **two** concurrent writers
(14/24; 0/30 serial) — so the row's claim that sibling write endpoints survive the
identical contention does not hold for this one. It is deliberately **not** a second
Ledger row: same root cause, same upstream ticket (LE-2020), and the ledger counts
one row per ticket. The user-visible outcome differs and is milder: the flow stays
in its source project and the UI *does* raise `Failed to save flow` (with the raw
SQL and bound parameters), where the project-delete equivalent silently no-ops.
Evidence, API and UI:
[docs/upstream-bugs/UPSTREAM-BUG-flow-patch-500-under-contention.md](docs/upstream-bugs/UPSTREAM-BUG-flow-patch-500-under-contention.md).

## Candidates — pending upstream ticket

Confirmed locally but not yet filed upstream; promoted to a Ledger row the
moment a ticket is filed. Not counted in the indicator.

| Found | Area / Test | Regression | Severity | Report |
|-------|-------------|------------|----------|--------|

*(none — the project-delete 500 was promoted to the Ledger on 2026-07-28 when
LE-2020 was filed.)*

## Not listed — validated non-regression

Findings deliberately kept out of both tables, so nobody re-litigates them:

- **Bulk-flow-delete SQLite-lock 500** — adversarially validated by Victor on
  2026-07-14 and downgraded to Low / non-user-facing observability noise, with
  two report claims refuted: the trigger is narrower than "any blank-flow
  navigation", and the 500 is masked by a client-side retry, so the user sees
  success. A real robustness gap, not a countable regression. The report and
  validation write-ups were never committed to this repo — the record is this
  entry plus the Jira board.
- **#643 — Anthropic HTTP 400 on a thinking block + tool call** — confirmed and
  then fixed upstream on 1.12.0.dev0 by the `langchain-anthropic` 1.3.5 → 1.4.8
  bump. No ticket was ever filed, so it never qualified; it is fixed, not
  pending. (Former candidate.)
- **#552 — no echo response for gemini-3.5-flash in `mcp-client-agent`** —
  closed on triage 2026-07-10 without a confirmed `langflow-regression` verdict
  or a filed ticket. (Former candidate.)
