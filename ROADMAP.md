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

- **Coverage (validated `[x]` / total):** ~59% (268 / 454 checklist bullets)
- **`@stable` `test()` calls:** ~298 across 111 spec files
- **Total `test()` calls:** ~541 in ~222 spec files
- **Disabled tests:** 54 `test.skip` (51 files) + 1 `test.fixme` (`webhook-component-regression.spec.ts`)
- **Spec-doc coverage:** ~117 docs under `docs/`
- **Langflow version last validated against:** `1.10.x`

**Biggest structural gaps** (where coverage is near-zero relative to product value):

- **RAG / knowledge ingestion** — full pipeline uncovered (0 validated of 8 bullets). *(Wave 2 target.)*
- **Templates** — 41 bullets, 2 validated; the product showcase is almost untested.
- **MCP** (client + server) — files exist but almost entirely `[-]` (unvalidated). *(Wave 3 target.)*
- **Inherited `ui-ux` canvas specs** — ~36 `[-]` carried from upstream, never validated. *(Wave 3 target.)*
- **Component-configuration & flow-lifecycle** — large `[-]` backlogs awaiting `@stable`. *(Wave 2 target.)*
- **Spec-doc debt** — ~100+ specs without a matching doc (worst in `flow-functionality` and `ui-ux`).

---

## Cadence & review

- **Each wave is a fixed 2-week timebox.** Lock the time, flex the scope: if a wave
  runs heavy, drop items from it — never extend the deadline.
- **Capacity band: 50–60 validated checklist bullets per wave** — the target set by
  leadership for this cycle (up from the previous 18–21 net-new specs). A wave hits
  the band by moving 50–60 `QA-CHECKLIST.md` bullets to validated `[x]`, blending two
  kinds of work: **writing new specs** (`[ ]` → `[x]`) and **promoting existing
  unvalidated specs** to `@stable` (`[-]` → `[x]`). Both count, because both advance
  the convergence metric. Net-new creation alone (~50 `[ ]` bullets in the whole
  backlog) cannot sustain the band; the ~171 `[-]` promotions are what make 50–60/wave
  reachable. Treat 50–60 as the target band, revisited at every review.
- A wave is filled only with **decided** backlog items — real `QA-CHECKLIST.md`
  bullets (`[ ]` to create, `[-]` to validate). If the decided backlog for an area
  runs short of the band, the wave is smaller — we do **not** invent items to hit the
  number.
- **Every wave ends with a review** (the `Review (date)` line). At that checkpoint
  the team reassesses what was actually delivered vs. the target, and replenishes
  the dated horizon by promoting the next item from the pool.
- **Rolling horizon of ~3 dated waves.** Only the near term is dated, on purpose —
  dating waves months out would be invention, and reality (denominator growth,
  unplanned tests, n_messages-style surprises) reshapes the order anyway. New waves
  are coined at each review, not fixed up front.

---

## The full horizon — how many waves total?

`QA-CHECKLIST.md` holds **186 non-validated bullets** (25 `[ ]` to create, 154 `[-]`
to validate, 7 `[~]`/`[!]`). That backlog is the fuel for every wave. At 50–60 bullets
per wave, the two remaining dated waves (2–3) absorb the ~116 bullets that are
**decided and ready to schedule now**; the rest stay in the pool because they need a
scoping pass before they can become concrete wave items.

| Source | Nature | Bullets | Dated? |
|---|---|---|---|
| **Dated waves 2–3** | Blend of net-new specs (`[ ]`→`[x]`) and validation promotions (`[-]`→`[x]`), by product axis | ~116 | ✅ Waves 2–3 |
| **Pool — needs scoping** | Templates (§11, 39 bullets — depth per category undecided) + auth & project-management tail (~20) | ~59 | ⬜ pool |
| **Continuous** | Spec-doc backfill (~100+ missing) — runs alongside, not a wave | — | ⬜ track |

So the realistic horizon is **~2 more dated waves (~1 month)** to converge the
schedulable backlog, then the pool tail (auth, project-management) and templates once
a scoping session turns §11 into a concrete list. Wave 1 (agents & providers) is done;
the remaining dated waves are validation-heavy (component, flow, canvas & MCP specs
promoted to `@stable`).

---

## Dated waves

> Sized to the 50–60 capacity band; items are pointers to decided `QA-CHECKLIST.md`
> backlog (created `[ ]`→`[x]` and validated `[-]`→`[x]`).

> **Operationalized as GitHub milestones.** Each dated wave below is a GitHub
> milestone named exactly like the wave's `### Wave N — Axis` heading; its work
> items are the issues labeled `roadmap` assigned to it. Pick work with:
>
> ```bash
> gh issue list --label roadmap --milestone "Wave N — Axis"
> ```
>
> This file owns the wave's **definition, order and deadline**; the milestone
> mirrors the deadline and holds the concrete issues (never listed here).

| Wave | Axis (focus) | Bullets (planned) | Sources in `QA-CHECKLIST.md` | Coverage target | Delivery date |
|---|---|---|---|---|---|
| ~~**1**~~ ✅ | Agents & providers | ~53 | llm-agents §6.2–6.5 & §7.7 (26) + model-provider §7.1–7.6 (27) | ~61% | ✅ 2026-07-14 (**59%**) |
| **2** ◀ current | Components, RAG, flows & observability | ~58 | core-components §2 (22) + knowledge-ingestion §5 (8) + flow-functionality §12 (15) + observability §8 (8) + playground §9 (5) | ~74% | 2026-07-17 |
| **3** | Canvas UI/UX & MCP | ~58 | ui-ux §15 (42) + mcp §13–14 (16) | ~87% | 2026-08-11 |

> Bullet counts and `%` are planned targets (`~`), not contracts — see **Cadence & review**.
> Each wave mixes creation (`[ ]`→`[x]`) and validation (`[-]`→`[x]`): Wave 1 is
> creation-heavy (agent backlog), Wave 3 is validation-heavy (inherited specs).

### ✅ Wave 1 — Agents & providers  ·  2026-06-30 → 2026-07-14 · **DONE**

> Delivered 2026-07-14. Final coverage **~59% (268/454)** — target was ~61%; the gap
> is denominator growth (450→454), as **Cadence & review** anticipates. All **25**
> `roadmap`-labeled issues closed (GitHub milestone *Wave 1 — Agents & providers*, #482–#505).
> Delivered the agent parameter/behavior/tool/memory creation backlog (§6.2–6.5 & §7.7,
> incl. `agent-max-iterations` gated as expected-fail) + open-source providers
> (Ollama/Groq/Mistral), and promoted the provider-management surface (§7.1–7.5:
> collect-models, OpenAI/Anthropic/Google configure/select/execute, provider modal &
> keys) to `@stable`.

### Wave 2 — Components, RAG, flows & observability  ·  2026-07-13 → 2026-07-17 ◀ **CURRENT**

Bundles the component-configuration backlog with the highest product-value gap
(RAG, 0% covered) plus the flow-lifecycle and observability tails.

Requires:
- **Create**: `knowledge-ingestion-management/` §5.1–5.2 — upload via component; file types (txt, pdf, json, py, wav); size limit; file management page; ingestion via Split Text + Embeddings; Vector Store index + query; full RAG pipeline (ingest → embed → store → retrieve → answer).
- **Validate** (`[-]` → `@stable`): `core-components/` §2.1–2.4 — Parameters Panel field-type matrix (text, dropdown, textarea, code, float, int, toggle, key-pair, input list, table, slider, tab), Tool Mode grouping + edit-tools, component-update notification/action, full custom component; `flow-functionality/` §12 — create blank/from-template/import, edit name & description, auto-save, settings, lock/unlock, move-between-folders, save-as-template; `observability-monitoring/` §8.2–8.4 — execution-error & outdated notifications, user-state tracking, Python-error/network-error/timeout handling; `playground/` §9 — streaming/polling/direct-response paths.

Convergence: ~59% → **~74%**
Exit: a RAG flow is validated end-to-end; the component-configuration, flow-lifecycle and observability surfaces are promoted.
Review (2026-07-17): reassess delivered vs. target; promote the next pool item into a dated wave.

### Wave 3 — Canvas UI/UX & MCP  ·  2026-07-28 → 2026-08-11

Validation-heavy: the ~36 inherited `ui-ux` canvas specs and the 8 existing MCP
specs already have code — this wave promotes them to `@stable` and fills the few
named `[ ]` gaps.

Requires:
- **Validate** (`[-]` → `@stable`): `ui-ux/` §15.1–15.10 — component sidebar (search, tooltip, filter), add-to-canvas, connections (compatible/incompatible, delete, reconnect), node manipulation (move, minimize, box-select, deselect), zoom & navigation, grouping, freeze/state, sticky notes, right-click menus, settings/shortcuts; `mcp/` §13–14 — client (configure stdio/HTTP, list tools, execute, error handling, agent-uses-MCP) and server (tab, add via modal, starter project).
- **Create** (`[ ]`): MCP resources — list/consume resource URI; server-exposed resource & prompt via URI/template.

Convergence: ~74% → **~87%**
Exit: the inherited canvas surface and MCP client/server are validated under `@stable`.
Review (2026-08-11): reassess delivered vs. target; promote a pool item (templates, once scoped) into a dated wave.

---

## Pool — not yet dated

> What's left after the dated waves absorb the ~169 schedulable bullets. Most of the
> validation track (providers, components, flows, observability, canvas, MCP) is folded
> **into** Waves 1–3 to reach the 50–60 band — it is no longer a separate pool. What
> remains here is either a smaller decided tail or an area that needs scoping first.

**Ready to date (decided tail — coin at a review):**

- **Auth & user management** — login/logout states, admin user lifecycle, auto-login, session isolation (`auth/` §4.1–4.2, ~13 `[-]`).
- **Project-management tail** — deletion integrity, move/drag flows, folder navigation & search (`project-management/` §10, ~7 `[-]`/`[~]`).
- **Disabled-test triage** — audit the 53 `test.skip` / 1 `test.fixme`: re-enable real ones, delete dead stubs (e.g. `voice-assistant.spec.ts`, `generalBugs-shard-3` no-op), resolve the webhook `fixme` (#165).

**Needs scoping first (Rule 1 — no inventing inside a wave):**

- **Templates** — load + run coverage across starter-project categories (`templates/` §11, 39 bullets, incl. the `core/integrations/*` specs). A scoping pass must decide depth (smoke vs. full execution) per category before this becomes a dated wave.

## Continuous track — spec-doc backfill

> Not a wave. Runs alongside every wave per `CONTRIBUTING.md`.

- Close the ~129 specs without a matching doc under `docs/` (worst: `flow-functionality` ~39, `ui-ux` ~28). New specs ship with docs by policy; this clears the inherited debt.

## Intake — community regression issues (proposed)

> **Status: proposed — flow still being designed (owner: Alice).** This section
> reserves the slot; the exact routing is not decided yet. Do not treat it as active
> process until the flow lands.

A second inflow of work, alongside the existing checklist backlog: **regressions
observed by the community land as GitHub issues**, and a triage flow routes them into
the suite. Two candidate paths (to be decided during the design):

- **Via the checklist (default assumption).** A triaged regression issue becomes a new
  `QA-CHECKLIST.md` bullet — a named `@regression` spec — which is then scheduled into
  a wave like any other item. This keeps a single backlog of record and preserves the
  convergence metric. Rule 1 already admits "an open issue" as a valid backlog pointer,
  so no rule changes are needed for this path.
- **Directly into the ROADMAP (possible shortcut).** A high-severity regression may be
  inserted into the current or next wave without waiting for a checklist pass —
  displacing lower-priority items to hold the 2-week timebox ("lock the time, flex the
  scope"). If this path is adopted, the item must still be **back-filled into
  `QA-CHECKLIST.md`** so the coverage metric and Rule 1 stay honest.

Open questions for the design: who triages and on what SLA; the severity bar for the
direct-into-wave shortcut; how these items are tagged/labeled on the issue and in the
suite (`@regression`); and whether they count toward or on top of the 50–60 band.

---

## How to update this file

- At each wave's **Review** checkpoint: record what was delivered vs. target, move the wave to a short **Done** log line (date + final coverage), and promote the next backlog item into a dated wave to keep the ~3-wave horizon full.
- Refresh the **Where we are** snapshot from `QA-CHECKLIST.md`; never hand-edit the numbers into a different value than the checklist reports.
- Keep wave items as pointers. If a wave needs a test that does not yet exist as a backlog item, add it to `QA-CHECKLIST.md` **first**, then point to it here.
- A "needs scoping first" pool area (e.g. templates) cannot become a dated wave until its scoping pass has turned it into concrete backlog items.
