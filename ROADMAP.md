# ROADMAP.md

> **Source of truth for direction:** where we are and what comes next, in time-boxed
> waves. This document **schedules** work that is already decided elsewhere — it does
> not invent tests, describe what a test validates, or teach process.

---

## Scope — what this document owns (and what it doesn't)

This file answers exactly one question:

> Until `yyyy-mm-dd` we run **Wave N**. Wave N requires `x`, `p`, `t`, `o`. With that, coverage converges to `w%`. → Next: **Wave N+1**.

It owns only what no other document owns: **the order of the waves, their deadlines,
and the per-wave convergence target.** Everything else is a pointer.

| Document | Owns the truth about | This file… |
|---|---|---|
| `QA-CHECKLIST.md` | **what** is covered (coverage matrix, %) | reads `w%` from its Coverage Summary |
| spec docs under `docs/` | **what** each test validates | points to the file |
| `CONTRIBUTING.md` | **how** to write / validate / triage | links only |
| **`ROADMAP.md`** | **when** and **in what order** | — |

**Rules**

1. A wave never introduces a test idea that does not already exist as a backlog
   item (a `[ ]`/`[-]` bullet in `QA-CHECKLIST.md`, a named-but-unwritten spec, a
   skipped test, or an open issue). Wave items are **pointers**, never restated
   descriptions.
2. The convergence metric is the **Coverage Summary of `QA-CHECKLIST.md`**
   (`Validated [x]` / `Total`). It is auto-generated, so the number is verifiable.
3. The target `%` is a **directional goal, not a contract.** The denominator grows
   over time (new items added, unplanned tests written mid-wave). A wave can close
   "below target" purely because the denominator moved — handling that is the
   **team's** concern, not this document's.

---

## Where we are

> Snapshot — refresh from `QA-CHECKLIST.md` when it changes. Do not hand-maintain.

- **Coverage (validated `[x]` / total):** ~49% (222 / 450 checklist bullets)
- **`@stable` `test()` calls:** ~240 across the suite
- **Total `test()` calls:** ~500 in ~211 spec files
- **Disabled tests:** 53 `test.skip` (32 files) + 1 `test.fixme` (`webhook-component-regression.spec.ts`)
- **Spec-doc coverage:** ~39% of specs have a matching doc under `docs/`
- **Langflow version last validated against:** `1.10.x`

**Biggest structural gaps** (where coverage is near-zero relative to product value):

- **RAG / knowledge ingestion** — full pipeline uncovered (0 validated of 8 bullets).
- **Agent behavior backlog** — ~24 not-automated bullets, most with spec filenames already named.
- **Templates** — 41 bullets, 2 validated; the product showcase is almost untested.
- **MCP** (client + server) — files exist but almost entirely `[-]` (unvalidated).
- **Inherited `ui-ux` canvas specs** — ~36 `[-]` carried from upstream, never validated.
- **Spec-doc debt** — ~129 specs without a doc (worst in `flow-functionality` and `ui-ux`).

---

## Cadence & review

- **Each wave is a fixed 2-week timebox.** Lock the time, flex the scope: if a wave
  runs heavy, drop items from it — never extend the deadline.
- **Capacity band: 18–21 new specs per wave** (≈9–10/week against a raw throughput
  of 10–15/week). The band sits *below* raw capacity on purpose: maintaining the
  growing validated suite competes for the same hours, so new-spec throughput
  declines as the suite grows. Treat 18–21 as the current ceiling, revisited at
  every review — later waves carry fewer new specs and more maintenance.
- A wave is filled only with **decided** backlog items. If the decided new-spec
  backlog runs short of the band, the wave is smaller — we do **not** invent specs
  to hit the number.
- **Every wave ends with a review** (the `Review (date)` line). At that checkpoint
  the team reassesses what was actually delivered vs. the target, and replenishes
  the dated horizon by promoting the next item from the pool.
- **Rolling horizon of ~3 dated waves.** Only the near term is dated, on purpose —
  dating waves months out would be invention, and reality (denominator growth,
  unplanned tests, n_messages-style surprises) reshapes the order anyway. New waves
  are coined at each review, not fixed up front.

---

## The full horizon — how many waves total?

The dated creation waves below are **not** the whole journey. The backlog splits
into three blocks of different *nature*, only the first of which is pure creation:

| Block | Nature | Est. waves | Dated? |
|---|---|---|---|
| **A — Creation (decided)** | Write new specs from the already-decided backlog (~50 specs) | **3** | ✅ Waves 1–3 |
| **B — Validation track** | Promote existing `[-]` / skipped specs to `@stable` — little to no new code | ~2–3 | ⬜ pool |
| **C — Scoped creation** | Areas too vague to schedule yet (templates, remaining ui-ux); need a scoping session to become a concrete spec list first | ~2–3 | ⬜ pool |
| **Continuous** | Spec-doc backfill (~129 missing) — runs alongside, not a wave | — | ⬜ track |

So the realistic horizon is **~8–9 waves (~4 months)**, not 3. Block A is dated now;
Blocks B and C stay in the pool with a known shape and get coined at each review.
New-spec volume is highest in Block A and tapers across B/C as maintenance grows —
exactly the declining capacity the band anticipates.

---

## Block A — Creation waves (dated)

> Sized to the 18–21 capacity band; items are pointers to decided backlog.

### Wave 1 — Agent backlog (full)  ·  2026-06-30 → 2026-07-14

The deepest decided bucket — fills a band-wave on its own, all items already named
in the checklist (`llm-agents/` §6.2–6.5).

Requires (pointers to named-but-unwritten specs):
- Parameters: `agent-max-iterations`, `agent-max-tokens`, `agent-reasoning-effort`, `agent-n-messages-limit` (**confirmed backend bug** — gate as expected-fail)
- Behavior & output: `agent-structured-output`, `agent-system-prompt`, `agent-config-persistence`, `agent-empty-refusal-response`, `agent-input-sources`, `agent-current-date-tool`, `agent-parse-error-behavior`, `agent-multimodal-image-input`
- Tools: `agent-tool-error-handling`, `agent-multi-tool-selection`, `agent-tool-name-validation`
- Memory: `agent-context-id-continuity`, `agent-context-id-isolation`

Convergence: ~49% → **~54%**
Exit: agent parameter, behavior, tool and memory surfaces validated under `@stable`.
Review (2026-07-14): reassess delivered vs. target; promote the next pool item into a dated wave.

### Wave 2 — RAG, ingestion & providers  ·  2026-07-14 → 2026-07-28

Highest product-value gap (RAG, 0% covered) bundled with provider management to
reach the band.

Requires:
- `knowledge-ingestion-management/` §5.1 — upload via component; file types (txt, pdf, json, py, wav); file size limit; file management page
- §5.2 — ingestion via Split Text + Embeddings; Vector Store index + query; full RAG pipeline (ingest → embed → store → retrieve → answer)
- `model-provider/` §7.5 — Manage Providers modal; add provider; remove key; Language Model & Model Input components
- §7.6 — open-source providers (Ollama, Groq, Mistral)

Convergence: ~54% → **~58%**
Exit: a RAG flow is validated end-to-end; provider management surface covered.
Review (2026-07-28): reassess delivered vs. target; promote the next pool item into a dated wave.

### Wave 3 — Component configuration  ·  2026-07-28 → 2026-08-11

Requires (`core-components/` §2.1–2.4):
- Parameters Panel field-type matrix: text, dropdown, textarea, code, float, int, toggle, key-pair list, input list, table, slider, tab
- Tool Mode: group components, edit-tools
- Component updates: outdated notification, update action, breaking-change alert
- Full custom component

Convergence: ~58% → **~62%**
Exit: the component configuration surface is validated.
Review (2026-08-11): reassess delivered vs. target; promote a Block B/C item into a dated wave.

---

## Block B — Validation track (pool, no dates)

> Existing specs/skipped tests promoted to `@stable`. Different unit from Block A —
> measured in bullets cleared, not new specs. A validation wave can clear more
> bullets than a creation wave because the code already exists.

- **MCP** — validate the 8 existing specs: `mcp-client-regression`, `mcp-client-agent`, `mcp-server`, `mcp-server-tab`, `mcp-server-regression`, `mcp-server-starter-projects` (§13–14, `[-]` → `[x]`).
- **`ui-ux` canvas (inherited)** — connections, node manipulation, zoom/navigation, grouping, sticky notes, sidebar (§15.1–15.9, ~36 `[-]`). Large — split when scheduled.
- **Template integration specs** — validate the existing `core/integrations/*` specs (Basic Prompting, Simple Agent, Vector Store, …) referenced under §11.
- **Auth & user management** — admin user lifecycle, session/auto-login states (`auth/` §4.1–4.2).
- **Disabled-test triage** — audit the 53 `test.skip` / 1 `test.fixme`: re-enable real ones, delete dead stubs (e.g. `voice-assistant.spec.ts`, `generalBugs-shard-3` no-op), resolve the webhook `fixme` (#165).

## Block C — Scoped creation (pool, needs scoping first)

> Too vague to date. Each requires a scoping pass that turns the checklist area into
> a concrete spec list **before** it can be promoted to a dated wave (Rule 1 — no
> inventing inside a wave).

- **Templates** — load + run coverage across starter-project categories (`templates/` §11, 41 bullets). Decide depth (smoke vs. full execution) per category.
- **Remaining `ui-ux` net-new** — anything in §15 not covered by the inherited specs validated in Block B.

## Continuous track — spec-doc backfill

> Not a wave. Runs alongside every wave per `CONTRIBUTING.md`.

- Close the ~129 specs without a matching doc under `docs/` (worst: `flow-functionality` ~39, `ui-ux` ~28). New specs ship with docs by policy; this clears the inherited debt.

---

## How to update this file

- At each wave's **Review** checkpoint: record what was delivered vs. target, move the wave to a short **Done** log line (date + final coverage), and promote the next backlog item into a dated wave to keep the ~3-wave horizon full.
- Refresh the **Where we are** snapshot from `QA-CHECKLIST.md`; never hand-edit the numbers into a different value than the checklist reports.
- Keep wave items as pointers. If a wave needs a test that does not yet exist as a backlog item, add it to `QA-CHECKLIST.md` **first**, then point to it here.
- A Block C area cannot become a dated wave until its scoping pass has turned it into concrete backlog items.
