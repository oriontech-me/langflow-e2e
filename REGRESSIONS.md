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
**Regressions caught:** 12 — **Open:** 1 · **Fixed:** 11

**By severity:** High 3 · Medium 9 · Low 0

**By area:** core-components 3 · model-provider 3 · api 1 · auth 1 · flows 1 · knowledge-ingestion 1 · mcp 1 · ui-ux 1
<!-- REGRESSIONS:END -->

## Ledger

| Found | Area / Test | Regression | Severity | Detected by | Upstream | Status | Fixed in | Report |
|-------|-------------|------------|----------|-------------|----------|--------|----------|--------|
| 2026-08-20 | core-components · edit-tools.spec.ts | A Tool Mode action's edits — slug, description and the **Requires Approval** flag — are **silently reverted by one stale `custom_component/update` response**, and the reverted node is autosaved over the user's work. None of the panel edits reach the flow while the actions editor is open (at +2.5 s after the flip the persisted node still reads `name: "fetch_content", approval_actions: []`); they are applied on editor **close**, which fires `POST /api/v1/custom_component/update` and then the autosave `PATCH /api/v1/flows/{id}`. A round trip still in flight when the editor closes returns the **pre-edit** `tools_metadata`, and the frontend applies it over the edits with no staleness check. Reproduced on demand on 1.12.0.dev33 by holding one such response: released into the ESC→reopen window the reopened editor shows the defaults (`aria-checked="false"`, slug back to `FETCH_CONTENT`); released **after** the reopen it is worse — the editor keeps rendering the edits while `GET /api/v1/flows/{id}` already reads `approval_actions: []`, so the divergence is invisible until a reload. No toast, no error, no non-2xx anywhere. Impact is not cosmetic: `approval_actions` is what `lfx/base/tools/component_tool.py::update_tools_metadata` copies onto the tool and `lfx/run/hitl.py` reads as "this action requires approval", so an action the user marked as gated runs **ungated** after the UI confirmed the setting. The "toggle is not wired into the save path" reading is **refuted** — both daily hits are in the run's `flaky` bucket with `attempts: 2`, and the un-forced control persists `["approve","reject"]` correctly. Filed **Major** upstream on the failure mode; **Medium** here because the natural trigger needs an update response that lags the close, i.e. load — un-forced it has surfaced twice in 30 days, on the 8-worker daily lane, and the local baseline is 0/10. Attribution not bisected: reproduced on `1.12.0.dev33` | Medium | daily 07-30 + 08-20 · #1517 → #1519 | [LE-2272](https://datastax.jira.com/browse/LE-2272) | Open | — | #1519 |
| 2026-08-13 | knowledge-ingestion · upload-via-component.spec.ts | A file attached to a file-input node is **silently destroyed by one stale file-list response**, and the empty value is saved with the flow. The chip is not node state — it is a projection of the `useGetFilesV2` cache (`files.filter(f => selectedFiles.includes(f.path))`) — and a reconcile effect in the same `InputFileComponent` rewrites the node's `value`/`file_path` from that cache with `?? ""` fallbacks, so a `GET /api/v2/files` that merely **lags** the upload is read as "the user selected nothing". The wipe is terminal: `selectedFiles` is then empty, and no later correct response restores it. Reproduced 5/5 on 1.12.0.dev25 by removing one entry from a single list response — chip renders ~50 ms, disappears, and `GET /api/v1/flows/{id}` shows `file_path` empty, with no error, no toast and no non-2xx anywhere. Latency of the attach path is **refuted** as the cause: 13/13 clean attaches at 49–241 ms, including with `POST /api/v1/custom_component/update` stalled 25 s and aborted — the chip waits on no request at all. Filed **Major** upstream on the failure mode (silent data loss, no recovery short of re-attaching, every component using `InputFileComponent`); **Medium** here because the natural trigger needs a list read that lags a write, i.e. load — un-forced it has surfaced once in 30 days, on the 8-worker daily lane. Attribution not bisected: present on `release-1.12.0`, reproduced on `1.12.0.dev25` | Medium | daily 08-12 · #1430 | [LE-2208](https://datastax.jira.com/browse/LE-2208) | Fixed | 1.12.0.dev26 ([langflow#14541](https://github.com/langflow-ai/langflow/pull/14541)) | #1430 |
| 2026-08-11 | core-components · edit-name-description-node.spec.ts | The flow editor **accepts an Add Component click and discards it** while the RBAC permission query (`POST /api/v1/authz/me/permissions`) is in flight: `useAddComponent` early-returns on `useIsFlowReadOnly`, which fails closed while `isLoading`, before the store write — so no node, no toast, no console output and no network call. The control is rendered, enabled and hit-testable the whole time; only the mutation path was gated, not the affordance. All three add surfaces (sidebar footer button, `add-component-button-<x>`, canvas drop) share the hook. Isolated from the "first click after mount" confound by holding a 3 s endpoint delay fixed in both arms and moving only the click: **0 nodes added in 5/5 runs inside the window, 1 node in 5/5 on the identical single click after it** (Fisher one-tailed p ≈ 0.004). The window is not one round-trip — the wrapper's 5× exponential-backoff ladder (the LE-2123 ladder) stretches it to **~31–36 s** from a single 503, measured at 1/2/4/8/16 s per provider. Introduced by langflow#14068 (`887f2a552d`, 2026-07-15); on `release-1.12.0` **and** `main` | Medium | daily 08-05 · #1296 → #1301 (PR #1427) | [LE-2176](https://datastax.jira.com/browse/LE-2176) | Fixed | 1.12.0.dev30 ([langflow#14523](https://github.com/langflow-ai/langflow/pull/14523)) | docs/upstream-bugs/UPSTREAM-BUG-sidebar-add-permission-gate-dead-window.md |
| 2026-08-07 | model-provider · openai-compatible-provider-setup.spec.ts | A flow run can execute a model from a **different provider than the node selects**. An empty `ModelInput` value is filled by `update_build_config` with `options[0]`, and `options` is a **flat list across every enabled provider** (`get_language_model_options`), so the fill is the first default-enabled model of the first *configured* provider — not of the node's own. `POST /api/v2/workflows` then carries the live-canvas `data`, declared in `WorkflowRunRequest` as taking **priority over the saved flow data**, so the fill is what runs while the persisted flow still holds the correct selection. Measured through `POST /api/v1/custom_component/update` on 1.12.0.dev19: an OpenAI-Compatible node with an empty value came back `claude-opus-5` / **Anthropic**. Loud here only because that provider's endpoint-derived default set starts with completions-only ids (`404 … not a chat model`); `options[0]` is a working chat model for Anthropic, Google, OpenAI, Azure AI Foundry, Ollama and OpenRouter — **6 of 8** — where the same substitution runs green on a provider nobody selected. Two backend explanations were tested and **refuted** (an invalid selection is preserved; an empty `options` list does not wipe it, because the selection is injected into the options), and the run path is exonerated (`get_llm` raises rather than defaulting), so the trigger that empties the field is editor state and remains open | High | #1334 spec validation (PR #1369) · #1372 | [LE-2156](https://datastax.jira.com/browse/LE-2156) | Fixed | 1.12.0.dev23 ([langflow#14465](https://github.com/langflow-ai/langflow/pull/14465)) | docs/upstream-bugs/UPSTREAM-BUG-model-input-cross-provider-default-fill.md |
| 2026-08-04 | ui-ux · global-variable-edit.spec.ts | Global Variables grid silently drops row interactions while the RBAC permission query (`POST /api/v1/authz/me/permissions`) is loading — a row click never opens the Update Variable modal and checkbox ticking selects nothing, so the delete button stays disabled, with no spinner or feedback of any kind. Normally a 1–2 s window, but one transient network/5xx failure on the first call holds the gate through the query wrapper's 5× exponential-backoff retry ladder: ~31 s of dropped input, measured to the decimal (retries at 0.8/1.8/3.8/7.8/15.8/31.8 s under an injected 503). Introduced by the release-1.12 RBAC gate (langflow#14215, `2e677bf843`). The gate blocks checkbox selection too (proven by the 503 injection), but this row rests on `global-variable-edit.spec.ts` alone: the recorded flake of `remove-provider-api-key.spec.ts:17` is NOT evidence of it — the same signature reproduces at ~75 % on a healthy 1.12.0 with the gate open, from a test defect (#1235) | Medium | daily 07-27 + 08-03 · #1231 → #1235 | [LE-2123](https://datastax.jira.com/browse/LE-2123) | Fixed | 1.12.0.dev23 ([langflow#14404](https://github.com/langflow-ai/langflow/pull/14404)) | docs/upstream-bugs/UPSTREAM-BUG-global-variables-permission-gate-dead-window.md |
| 2026-07-28 | core-components · nested-grouping-regression.spec.ts | Grouping two connected non-IO components raises a false `Error while updating the Component` notification although the grouping fully succeeds — the `PATCH /api/v1/flows/{id}` that persists the grouped shape returns `200`, the console logs no error and no request fails, yet the message persists in the Notifications panel until dismissed by hand. Deterministic; reproduced independently in a manual browser session | Medium | #942 spec validation | [LE-2045](https://datastax.jira.com/browse/LE-2045) | Fixed | [langflow#14314](https://github.com/langflow-ai/langflow/pull/14314) | docs/upstream-bugs/UPSTREAM-BUG-group-cosmetic-error-toast.md |
| 2026-07-27 | api · api-folders-crud.spec.ts | `DELETE /api/v1/projects/{id}` answers `500` (`sqlite3.OperationalError: database is locked`) instead of `204` while any other write is in flight, and the project survives. Not new — stable 1.10.3 emits the same instant `500` — but 1.12 raises the rate ~7× (6 % → 44 % at 2 concurrent clients, A/B/A/B) and flips the mode: 1.10.3 blocks and mostly honours the contract, 1.12 gives up in 0.03 s. Sibling write endpoints (`POST /projects`, `POST /flows`, `DELETE /flows`) survive the identical contention | Medium | daily 07-22 + 07-27 · #962 → #965 | [LE-2020](https://datastax.jira.com/browse/LE-2020) | Fixed | 1.12.0.dev23 ([langflow#14308](https://github.com/langflow-ai/langflow/pull/14308)) | docs/upstream-bugs/UPSTREAM-BUG-project-delete-500-under-contention.md |
| 2026-07-27 | flows · run-flow.spec.ts | "New Flow" click is silently dropped when the flows list has not painted its cards yet — no navigation, no modal, no console error, and the button then stops being actionable until a reload. Introduced in 1.10.1 by langflow#12575; 1.10.0 opened the templates modal and created nothing | Medium | daily 07-27 · #962 → #966 | [LE-2019](https://datastax.jira.com/browse/LE-2019) | Fixed | 1.12.0.dev23 ([langflow#14349](https://github.com/langflow-ai/langflow/pull/14349)) | docs/upstream-bugs/UPSTREAM-BUG-new-flow-dead-click.md |
| 2026-07-24 | mcp · mcp-server-resources.spec.ts | MCP `resources/read` crashes with `AttributeError: 'str' object has no attribute 'hex'` — the project server advertises a flow file it cannot itself read (worked on 1.11.0) | Medium | #948 spec validation | [LE-2012](https://datastax.jira.com/browse/LE-2012) | Fixed | [langflow#14253](https://github.com/langflow-ai/langflow/pull/14253) | docs/upstream-bugs/UPSTREAM-BUG-mcp-resources-read-uuid-hex.log |
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

**Why LE-2020 held `Open` past its Jira `Done`, and what closed it (2026-08-11).**
The ticket was resolved on 2026-07-29 by
[langflow#14308](https://github.com/langflow-ai/langflow/pull/14308) (*fix(api):
retry project delete on sqlite lock*), which touches `api/v1/projects.py` and adds
`services/database/lock_retry.py` — and, at the time, **nothing under
`api/v1/flows.py`**, on a branch (`release-1.11.2`) the nightly is not cut from.
The row therefore stayed `Open` on a Jira `Done`: a closed ticket does not prove a
closed row, which is one of the divergences the platform's Regressions tab is
built to surface. Both gaps are now closed — `1.12.0.dev23` carries
`lock_retry.py` **and** wires `run_with_lock_retry` into both `api/v1/projects.py`
and `api/v1/flows.py`, verified inside the running image rather than on a ref
alone. Re-measured with the reproduction scripts, since serial green was always
true and never the gate: `DELETE /projects` **24/24 `204` at P=2 and 32/32 at
P=4** (was 11/24 failing at P=2 on `dev7`), `PATCH /flows` **32/32 `200` with the
association persisted at P=4** (was 14/24 failing at P=2 on `dev8`). Both
quarantines in `api-folders-crud.spec.ts` are lifted and `@stable` restored
(#965, #932 — PR #1428).

## Candidates — pending upstream ticket

Confirmed locally but not yet filed upstream; promoted to a Ledger row the
moment a ticket is filed. Not counted in the indicator.

| Found | Area / Test | Regression | Severity | Report |
|-------|-------------|------------|----------|--------|

*(none — the file-attachment wipe was promoted to the Ledger on 2026-08-13 when
LE-2208 was filed; the project-delete 500 on 2026-07-28 when LE-2020 was.)*

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
