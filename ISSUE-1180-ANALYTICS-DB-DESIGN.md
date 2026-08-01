# ISSUE-1180 — Analytics data model for E2E runs and specs

**Status:** proposed — revision 2, after review on [#1181](https://github.com/oriontech-me/langflow-e2e/pull/1181). No code ships against this document until the model is approved.
**Issue:** [#1180](https://github.com/oriontech-me/langflow-e2e/issues/1180)
**Scope:** the QA Platform database (`quality-platform`) plus the payload producers in this repo.
**Sibling fact:** `ISSUE-1217-TOKEN-ANALYTICS-DB-DESIGN.md` designs `e2e_test_token_usage` — one row per
(run × test × **model**) — against this model. It generates the same `test_key` as §3.1 so the two facts
join on `(run_id, test_key)` and the token series inherits §3.4's rename bridge; it also reuses §3.5's
`is_valid_run` and adds four nullable token columns to `e2e_automation_runs`. Any change to §3.1's
identity expression, to §3.4, or to §3.5 has to be made in both places.
**Revision log:** §11.

---

## 1. Problem

The suite already ships every daily run into Postgres. It has done so since 2026-06-10, when the
table now called `e2e_automation_runs` was created (born as `nightly_runs`, renamed in migration
`20260630183535`). What the suite does **not** have is a shape that answers longitudinal questions.

Three layers hold run data today, and each is blocked for analysis in its own way.

| Layer | Holds | Analytical limit |
|---|---|---|
| `reports/daily-history.jsonl` | One line per run: `totals` + `failures[]` + `flaky[]` | Failure-centric **by design**. No pass list, no per-test duration. `reports/README.md` § *Cannot answer with the current schema* already enumerates this |
| `e2e_automation_runs` (QA Platform Postgres) | Scalar run columns, plus a `tests` JSONB carrying every test — status, duration, tags, steps, error, screenshot URL | Per-test data exists **only as a JSONB blob**. No fact table, no spec dimension, no index that serves aggregation. Answering "flake rate per test over 90 days" means `jsonb_array_elements` across the whole history |
| `flakiness-report/report.json` | Per-attempt detail, Flakiness.io format | Ephemeral, never persisted |

The gap is modelling, not plumbing. The raw data is already arriving.

### 1.1 Questions that are impossible today

Not slow — impossible, because the data was never recorded in a queryable form.

1. **"Is this test actually stable?"** Without a recorded pass list you can only say "it never
   appeared as a failure in the captured window", which is necessary but not sufficient. The test
   may have been renamed, silently skipped, or removed from `@stable`.
2. **"Which Langflow build introduced this regression?"** Answered by hand every time — see the
   dev41→dev47 failure-spike investigation behind #816/#830.
3. **"Which spec inflated the daily from ~14 to ~22 minutes?"** `duration_ms` is run-level only.
4. **"What entered and left the daily between two dates?"** No nominal list of what ran exists.
5. **"Which recurring failure never got an issue?"** Nobody measures this. It is the triage hole,
   and it is invisible by construction.

---

## 2. Architecture

Everything new lives in the QA Platform Supabase database. This repo only **produces** payloads; it
gains no database and reads none.

```
  langflow-e2e (repo)                    QA Platform (Supabase)
  ───────────────────                    ──────────────────────
  daily-stable.yml  ────POST──→  e2e-automation-runs-create (edge fn)
  nightly.yml  (conditional, §2.3)        │ one transaction
                                          ├──→ e2e_automation_runs   (exists, + is_valid_run)
                                          └──→ e2e_test_results      NEW — the fact

  build-catalog-payload.mjs (new)
  run from update-coverage-summary.yml
                     ───POST──→  e2e-spec-catalog-sync (edge fn, NEW)
                                          ├──→ e2e_spec_catalog      NEW
                                          └──→ e2e_coverage_items    NEW

  (already running on cron, untouched)
        sync-e2e-issues      ──→ e2e_dev_issues_cache, e2e_issue_spec_refs
        sync-e2e-regressions ──→ e2e_product_regressions
        sync-jira-board-hourly ─→ jira_board_cards
```

### 2.1 Invariants

1. **No human-editable column in any new table.** Every value is derived — from the Playwright
   payload or from the repository. This is what answers the objection recorded in
   `20260726120000_e2e_issue_spec_refs.sql`, whose concern was a hand-declared flag becoming a
   second source of truth.
2. **The `tests` JSONB stays.** It remains the raw audit payload; the fact table is a materialised
   index over an immutable source, not a competing copy. If the two ever disagree, the JSONB wins and
   the fact is rebuilt by `e2e_rebuild_facts(run_id)` — a **named deliverable** (§9), because an
   invariant that nothing implements is an assertion, not an invariant.
3. **Every path column is normalised through `public.e2e_normalize_spec_path()`** — the function that
   already exists, and which is declared `LANGUAGE sql IMMUTABLE` in
   `20260726120000_e2e_issue_spec_refs.sql`. That verification matters beyond style: the generated
   column in §3.1 does not compile against a merely `STABLE` function.

### 2.2 Decisions taken before this document

| Decision | Value |
|---|---|
| Where the tables live | QA Platform Supabase |
| Source of truth | Markdown wins. `QA-CHECKLIST.md` and the spec files stay authoritative; the database is a read-only projection, resynced on merge to `main`. The PR guards from #741 and #985 are untouched |
| Run sources | `daily-stable` only, unconditionally. `nightly` is conditional on §2.3. PR-CI and `manual.yml` are excluded — their per-run scope varies (the import-graph subset), which would poison trend lines |
| Volume | ~5k rows/month from the daily alone (~250 tests × ~21 runs). Nightly would add ~24k when and if §2.3 is resolved. No partitioning until ~5M |

### 2.3 Precondition — `nightly.yml` is dormant

The nightly workflow **does not run**. Its cron is commented out with *"Schedule disabled until the
suite is stable in production"* (`nightly.yml:4-6`), and its last execution was **2026-03-19**, which
failed. Its issue-opening step is additionally gated on `github.event_name == 'schedule'`.

Adding ingest to a dormant workflow produces zero rows. So nightly is **out of the core deliverable**
and becomes conditional:

- If the team decides to re-enable the cron — a decision that belongs to its own issue, not to
  #1180 — then §4.1's nightly work and its share of §9 apply as written.
- If not, the nightly items drop from the implementation split, `p_workflow` in §5 has exactly one
  meaningful value for now, and the volume estimate is the daily-only figure in §2.2.

Nothing else in the design depends on the outcome. The workflow filter in §5 stays regardless: it
costs nothing today and is required the moment a second source exists.

> Related defect, out of scope here: `CLAUDE.md` states the nightly *"Runs daily at 03:00 BRT"*.
> It has not run since March. That documentation drift deserves its own issue.

---

## 3. Data model

### 3.1 `e2e_test_results` — the fact

One row per (run × test). Roughly 250 rows per daily run.

```sql
CREATE TABLE public.e2e_test_results (
  id             BIGSERIAL PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES public.e2e_automation_runs(run_id) ON DELETE CASCADE,

  spec_path      TEXT NOT NULL,          -- always e2e_normalize_spec_path()'d
  title_path     TEXT NOT NULL,          -- describe > describe > test, full chain
  test_title     TEXT NOT NULL,          -- leaf title, for display
  line           INTEGER,                -- display only; drifts on every edit to the spec

  -- Stable identity as a GENERATED column: defined once, in the database, so the
  -- edge function and the backfill cannot compute it differently. Requires
  -- e2e_normalize_spec_path() to be IMMUTABLE — verified, see §2.1.
  test_key       TEXT GENERATED ALWAYS AS (
                   md5(public.e2e_normalize_spec_path(spec_path) || '::' || title_path)
                 ) STORED,

  -- FALSE when title_path was reconstructed rather than reported by the producer
  -- (backfilled rows, §4.3). Queries that need strict identity filter on it;
  -- without this column the degradation would be prose in a README instead of a
  -- predicate.
  title_path_exact BOOLEAN NOT NULL DEFAULT true,

  status         TEXT NOT NULL CHECK (status IN ('passed','failed','flaky','skipped')),
  duration_ms    INTEGER,
  attempts       SMALLINT NOT NULL CHECK (attempts >= 0),  -- 0 for a skipped test
  tags           TEXT[] NOT NULL DEFAULT '{}',
  param          TEXT,                   -- "google / gemini-2.5-flash" when parameterized

  error_signature TEXT,                  -- first line, capped at 240 chars
  error_full      TEXT,
  screenshot_url  TEXT,
  steps           JSONB,

  UNIQUE (run_id, test_key)
);

CREATE INDEX ON public.e2e_test_results (test_key, run_id DESC);
CREATE INDEX ON public.e2e_test_results (spec_path);
CREATE INDEX ON public.e2e_test_results (status) WHERE status <> 'passed';
CREATE INDEX ON public.e2e_test_results USING GIN (tags);
```

Three column choices carry the design:

**`title_path`, not just the leaf title — and the collision is not hypothetical.** The payload
currently sends `test: spec.title` (`build-run-payload.mjs:97`), which drops the `describe` chain. A
model-parameterized spec repeats the same leaf title under a different `describe`, one per provider.
This is already in production data: the daily of **2026-07-29** recorded two entries for
`agent-context-id-isolation.spec.ts` with the identical leaf title *"switching the agent's context_id
re-tags new turns without…"*. **17 spec files** use an interpolated `describe` title, concentrated in
`llm-agents/` and `mcp/client/`. Keying on the leaf alone therefore collides today, not at some
future point — which makes this the strongest argument in the document, not a `#899` footnote.

**`attempts` allows 0.** The producer sends `(t.results || []).length`, which is `0` for a skipped
test. A `DEFAULT 1` never applies when a value is supplied, so the default would have been decoration
and the real contract is the `CHECK`.

**`tags` is stored as it was AT THAT RUN**, not as it is today. That single choice makes "evolution of
the `@stable` set" and "scope diff between run A and run B" fall out of the fact table, with no
slowly-changing dimension to maintain. Both are listed as unanswerable in `reports/README.md` today.

### 3.2 `e2e_spec_catalog` — spec dimension

One row per spec file, current state, derived from the repository.

```sql
CREATE TABLE public.e2e_spec_catalog (
  spec_path         TEXT PRIMARY KEY,     -- normalized
  area              TEXT NOT NULL,        -- path segment: core-functionality/auth, mcp/server, …
  functional_tags   TEXT[] NOT NULL DEFAULT '{}',
  test_count        INTEGER NOT NULL DEFAULT 0,
  stable_test_count INTEGER NOT NULL DEFAULT 0,
  is_destructive    BOOLEAN NOT NULL DEFAULT false,
  has_spec_doc      BOOLEAN NOT NULL DEFAULT false,
  spec_doc_path     TEXT,
  repo_commit_sha   TEXT NOT NULL,        -- which commit this row reflects
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**There is deliberately no `module` column here.** An earlier revision had one, sourced from the
`MODULES` array in `scripts/coverage-summary.ts` — which does not work: those 16 entries cover only
**14 distinct directories**. `core-components/` splits into "Component Config" (`### 2.`) and "Core
Components" (`### 3.`), and `ui-ux/` into Canvas (`## ui-ux/`) and Settings (`#### 15.10`). Both are
splits by **checklist section**, not by file path, so no `spec_path → module` function exists for
those two areas.

`module` therefore lives only on `e2e_coverage_items`, where it is derived from sections and is
well-defined. `area` — always derivable from the path — lives here. The consequence for
`e2e_coverage_rollup()` (§5) is that it groups by `e2e_coverage_items.module` and joins to the
catalog on `spec_path`, never on module. Both of its interesting outputs work that way anyway:
`items_without_spec` is a coverage row whose `spec_path` does not resolve, and `specs_without_item` is
a catalog row with no coverage row at all.

### 3.3 `e2e_coverage_items` — the checklist as data

One row per Part II bullet of `QA-CHECKLIST.md`.

```sql
CREATE TABLE public.e2e_coverage_items (
  id              BIGSERIAL PRIMARY KEY,
  module          TEXT NOT NULL,          -- derived from the checklist section, not from a path
  section         TEXT NOT NULL DEFAULT '',
  item_text       TEXT NOT NULL,
  item_hash       TEXT NOT NULL,          -- md5(item_text)
  marker          TEXT NOT NULL CHECK (marker IN ('x','-','~','!',' ')),
  spec_path       TEXT,                   -- NULL when the item is not automated
  phase           TEXT,
  repo_commit_sha TEXT NOT NULL,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (module, section, item_hash)
);
```

Keyed on `md5(item_text)` rather than line number: a line number drifts on every edit.

**`section` is part of the key, and it is `NOT NULL DEFAULT ''` so that it participates in the
constraint** — a nullable column would let duplicates through, since NULLs never compare equal in a
UNIQUE index. Duplicate bullet text already exists in the checklist: line 156 (`#### 2.3 Component
Updates`) and line 459 (`#### 8.2 Notifications`) carry the identical bullet *"Outdated component
notification → `core-components/outdated-component-notification.spec.ts`"*. Today it survives only
because those two land in different modules. Two identical bullets in two subsections of the **same**
module would abort the full-replace transaction on an ordinary checklist edit; including `section`
removes that failure mode.

Sync is a **full replace per commit** inside one transaction — Markdown is authoritative, so
incremental reconciliation would only add ways to drift.

### 3.4 `e2e_test_aliases` — rename bridge

```sql
CREATE TABLE public.e2e_test_aliases (
  old_test_key TEXT PRIMARY KEY,
  new_test_key TEXT NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Without it, every rename silently resets a test's series and "flake rate over 90 days" starts lying.
Testid drift has already cost the suite history once.

Note that `spec_path` is the weaker half of the identity: a **file move** breaks the key exactly as a
rename does, and moves are more frequent in this repo than renames. The alias table covers both, but
manually — which fails precisely when a bulk reorganisation makes it expensive. §9 therefore
allocates alias generation to the PR tooling, which already computes which specs changed path
(`scripts/impacted-specs-by-import.mjs`), rather than to someone remembering.

### 3.5 `is_valid_run` — a zero-test run must be excluded by construction

An earlier revision handled infra aborts (#1007/#1012) with a sentence: *"every RPC must exclude runs
where `passed = 0 AND failed = 0 AND flaky = 0`"*. That is an obligation on five RPCs and on every
future one, it is NULL-unsafe (if any total is nullable the predicate evaluates to NULL, not TRUE, and
the run is silently kept), and it wrongly discards an all-skipped run, which is not an abort.

It becomes a generated column on the existing run table, and the RPCs read it:

```sql
ALTER TABLE public.e2e_automation_runs
  ADD COLUMN is_valid_run BOOLEAN GENERATED ALWAYS AS (
    COALESCE(totals_passed, 0) + COALESCE(totals_failed, 0)
  + COALESCE(totals_flaky,  0) + COALESCE(totals_skipped, 0) > 0
  ) STORED;
```

Any test result at all — including a skipped one — makes a run valid. Only a run that produced
nothing is excluded, which is exactly the #1012 hazard and nothing more.

### 3.6 RLS

Identical to the sibling cache tables: `SELECT` granted to `authenticated`, all writes restricted to
`service_role`.

---

## 4. Ingestion

### 4.1 Producer changes in this repo

**One shared report walk, not two.** `scripts/append-weekly-history.mjs` and
`scripts/build-run-payload.mjs` are already two independent parsers of the same Playwright report,
each with its own `visit()`, and they have quietly diverged:

| | `append-weekly-history.mjs` | `build-run-payload.mjs` |
|---|---|---|
| `visit()` signature | `visit(node, suitePath = [])` — threads the describe chain (`:96`) | `visit(node)` — does not (`:84`) |
| `param` extraction | `paramFromSuitePath()` (`:88`) | absent |

So `title_path` is **already computed in the sibling script**, and `param` — a column in §3.1 — already
has a working implementation twenty lines away. Rather than evolve one parser and widen the gap, the
walk is extracted into `scripts/lib/playwright-report-walk.mjs`, exporting the traversal, the
describe-chain threading, `paramFromSuitePath()` and `title_path`. Both scripts import it. The fact
table and the JSONL then cannot disagree about what ran, which is the property that made §6's
"keep both copies" trade-off defensible in the first place.

Also in this repo:

- **`scripts/build-catalog-payload.mjs`** (new) walks `tests/**/*.spec.ts` for tags, `test()` counts,
  `@stable` and `@destructive`; resolves docs under `docs/` by content reference; parses the Part II
  bullets of `QA-CHECKLIST.md` with their section headings. It **fails loudly** when a `MODULES` entry
  cannot be located, mirroring what `scripts/coverage-summary.ts` already does.
- **`update-coverage-summary.yml`** runs the catalog sync. It already triggers on every push to
  `main` touching `QA-CHECKLIST.md` or `tests/**/*.spec.ts`, which is exactly the right trigger; no
  new workflow is needed.
- **`nightly.yml`** — conditional on §2.3. If the cron is re-enabled it gains a `json` reporter plus
  copies of the `Build run payload` and `POST run to QA Platform` steps from `daily-stable.yml`,
  keeping `if: always()` and `continue-on-error: true`, sending `WORKFLOW: nightly` and no
  `STABLE_COUNT`/`TOTAL_COUNT`.

### 4.2 Atomic ingest, and what atomicity must not cost

The Supabase JS client cannot run a multi-statement transaction. Inserting the run and then the facts
leaves a window for an **orphan run** — run recorded, zero facts — and the series would start lying
with no signal that it had. Both inserts move into one plpgsql function, which also concentrates the
idempotency currently split between the `UNIQUE(run_id)` constraint and the `23505` race handling
inside the edge function.

The fact insert uses `ON CONFLICT (run_id, test_key) DO NOTHING` and the function **reports the
delta**:

```sql
CREATE FUNCTION public.e2e_ingest_run(p_payload jsonb)
RETURNS TABLE (run_id text, was_new boolean, tests_received integer, tests_inserted integer)
LANGUAGE plpgsql SECURITY DEFINER AS $$
  -- 1. INSERT INTO e2e_automation_runs ... ON CONFLICT (run_id) DO NOTHING
  -- 2. if nothing was inserted and run_attempt is not higher -> RETURN (run_id, false, 0, 0)
  -- 3. INSERT INTO e2e_test_results
  --      SELECT ... FROM jsonb_to_recordset(p_payload->'tests')
  --      ON CONFLICT (run_id, test_key) DO NOTHING
$$;
```

Without `DO NOTHING`, a single unresolved identity collision would abort the transaction and lose the
**entire run** rather than one test — atomicity turning a one-row problem into a total loss. With it,
a collision degrades to a dropped row plus a visible `tests_received > tests_inserted`, which the
edge function logs and returns. A non-zero delta is a signal to investigate, not a failed ingest.

**Re-run supersede.** `run_id` is `github.run_id` (`build-run-payload.mjs:154`), which is **stable
across re-run attempts** — only `run_attempt` increments. Under a plain `DO NOTHING` idempotency, re-
running a daily that failed on infra would leave the fact table holding the bad attempt permanently,
and §4.3 confirms a re-POST does not repair it. This is a real path: the team has re-run a daily over
a Chromium-install flake. So the payload carries `run_attempt`, and the ingest treats a **higher**
`run_attempt` for an existing `run_id` as a supersede — delete that run's facts, update the run row,
reinsert — while an equal or lower attempt keeps today's `200 exists`.

Screenshot upload to the `playwright-evidence` bucket still happens **before** the RPC, so no base64
reaches the database. The `continue-on-error: true` on the POST step stays — a platform outage must
never bring down the suite.

### 4.3 Backfill

An earlier revision proposed one `INSERT … SELECT` over the historical `tests` JSONB and called the
result "complete". **It would have aborted.** That JSONB carries only the leaf title — `title_path` is
precisely what §4.1 is adding now — so backfilled rows must reconstruct `title_path` from the leaf,
and for the 17 parameterized specs the leaf is identical across providers. With `UNIQUE (run_id,
test_key)` and a single statement, the first collision takes the whole migration down, not the
offending rows. The 2026-07-29 daily alone contains such a pair.

The backfill is therefore **per run**, with `ON CONFLICT DO NOTHING`, and it emits a summary rather
than a boolean:

| Tier | Runs | Identity | Result |
|---|---|---|---|
| **A** | Runs with a populated `tests[]` (from migration `20260701120000` onward) | `title_path` reconstructed from the leaf title → `title_path_exact = false` | Every test's status, duration, steps and error, minus the rows dropped by collision. The dropped rows are **counted and listed per run**, never silently skipped |
| **B** | Earlier runs | Same reconstruction, over `failures[]` / `flaky[]` only | Failures with `duration_ms = NULL`. These runs will **never** have a per-test pass rate |

Two consequences worth stating plainly rather than discovering later:

- **`title_path_exact = false` on every backfilled row** (§3.1). Any query that needs strict identity
  filters it out; `e2e_test_health` reports it as a separate count so a flake rate computed partly
  from reconstructed identity cannot masquerade as an exact one.
- **"Roughly 30 runs of history on day one" is an upper bound, not a promise.** The real figure is
  whatever survives collision-dropping, which the migration reports. §8 validates against it instead
  of asserting it.

A re-POST does not repair an old run: ingest short-circuits on an existing `run_id` at an equal or
lower `run_attempt` (§4.2). Backfill and repair are SQL paths — the backfill migration and
`e2e_rebuild_facts(run_id)` — not replays of HTTP requests.

---

## 5. Query layer

plpgsql RPCs, not raw views — matching the pattern the platform already uses
(`get_run_failure_treatment`, `get_qa_board_e2e`). Every RPC takes `p_days int DEFAULT 90` and
`p_workflow text DEFAULT 'daily-stable'`.

The workflow default is a **value, not NULL**. An earlier revision defaulted to NULL meaning "all
workflows" one sentence after arguing that mixing workflows distorts every average; the default
handed back precisely the answer the paragraph warned against. `daily-stable` is the only
unconditional source (§2.3), so it is the correct default, and a caller who genuinely wants the union
passes NULL explicitly.

Every RPC reads `is_valid_run` (§3.5) instead of restating a totals predicate.

| RPC | Returns | Answers |
|---|---|---|
| `e2e_test_health(p_days, p_workflow)` | `runs`, `passed`, `failed`, `flaky`, `flake_rate`, `current_fail_streak`, `last_failed_at`, `distinct_error_signatures`, `rows_with_reconstructed_identity` | "Is this test actually stable?" and the `@stable` removal rule in `CONTRIBUTING.md`, mechanically. Resolves aliases via `COALESCE(new_test_key, test_key)` |
| `e2e_spec_duration_trend(p_days, p_workflow)` and `e2e_duration_movers(p_days)` | `total_ms`, `p50_ms`, `p95_ms`, `slowest_test_key`, `delta_p95` | "Which spec inflated the daily?" The movers RPC compares the first half of the window against the second and ranks by p95 delta |
| `e2e_version_regression_window(p_test_key)` and `e2e_version_failure_matrix(p_days)` | `last_green_run`, `first_red_run`, each with `langflow_version` and `langflow_commit_sha` | "Which build introduced it?" — the window the regression entered through |
| `e2e_coverage_rollup()` and `e2e_stable_set_diff(run_a, run_b)` | per `module`: counts per marker, `automated_pct`, `items_without_spec`, `specs_without_item` | Reproduces the Coverage Summary as data, plus two things Markdown cannot show. Groups by `e2e_coverage_items.module`; joins the catalog on `spec_path`, never on module (§3.2) |
| `e2e_failure_lifecycle(p_days)` | `first_failed_at`, `issue_number`, `hours_to_issue`, `hours_to_close`, `is_product_regression`, `upstream_key`, `upstream_status`, `has_no_issue` | Triage responsiveness and the suite's real ROI |

### 5.1 The failure-to-upstream chain

`e2e_failure_lifecycle` is the RPC that closes the loop, and it needs no new issue table — all four
right-hand sources are already populated by cron.

```
e2e_test_results (status IN ('failed','flaky'))
  → e2e_issue_spec_refs      ON e2e_normalize_spec_path(spec_path) + test_title
  → e2e_dev_issues_cache     issue_number, labels, milestone, state, created_at, closed_at
  → e2e_product_regressions  detected_issue_numbers @> issue, severity, upstream_key
  → jira_board_cards         live status, pr_url
```

`has_no_issue` is the most uncomfortable output and the most valuable: a recurring failure that never
became an issue. Together with `hours_to_issue` it gives triage responsiveness a number, and with
`is_product_regression` it separates real Langflow regressions from noise on our side — which is the
suite's ROI, currently curated by hand in `REGRESSIONS.md`.

---

## 6. On keeping two histories

`reports/*.jsonl` stays. The offline-copy argument holds: a file versioned in git is readable when the
platform is not, and it costs nothing to keep appending.

But two things about that duplication need stating rather than assuming, because an earlier revision
framed it as a settled trade-off.

**The JSONL cannot restore what an outage costs the fact table.** Its keys are `date, duration_ms,
failures, flaky, langflow_image, run_id, run_url, totals, version, workflow` — there is no `tests[]`.
After a platform outage: the JSONL has the run, Postgres does not, a re-POST will not repair it
(§4.2/§4.3), and the SQL backfill depends on a `tests` JSONB that never arrived. Every outage is
therefore a **permanent hole** in the fact table, recoverable only to the degraded Tier-B shape of
§4.3 — failures, no pass list, no durations. Calling that a "safety net" overstates it; it is a
partial reconstruction, and the two series drift apart with different gaps.

**The duplication has already cost capability**, which is why §4.1 extracts the shared walk instead of
evolving one parser. Two parsers of the same report, one of which solved the describe-chain problem
some time ago while the other did not, is the concrete price — and adding the fact table as a third
consumer of that split without fixing it would have compounded it.

---

## 7. Out of scope, deliberately

- **PR-CI and `manual.yml` ingestion.** Their scope varies per run (the import-graph subset), which
  would poison trend lines.
- **Re-enabling `nightly.yml`.** A team decision with its own issue (§2.3).
- **Any new UI in the QA Platform.** This delivers data and RPCs; screens are a separate cycle.
- **Attempt-level granularity.** Test-level plus an `attempts` count answers every question asked
  here.
- **Partitioning and retention.** Revisit above ~5M rows.
- **Merging with Flakiness.io.** Third-party format, partial overlap.
- **Retiring `reports/*.jsonl`.** See §6.

---

## 8. Failure modes

| Failure | Response |
|---|---|
| Platform unreachable at the end of the daily | `continue-on-error: true` already covers the suite. The run is lost to the fact table and recoverable only to the degraded Tier-B shape — see §6, which is honest about what the JSONL can and cannot restore |
| Run recorded with no facts | Impossible by construction — the ingest RPC is atomic (§4.2) |
| Identity collision during ingest | `ON CONFLICT DO NOTHING` plus a reported `tests_received > tests_inserted` delta. One row is dropped and visible, instead of one run being lost to a rollback (§4.2) |
| A red daily re-run on infra flake | Higher `run_attempt` supersedes: facts deleted, run row updated, facts reinserted (§4.2) |
| A rename or file move resets a test's series | `e2e_test_aliases` plus `COALESCE` inside the RPCs; alias rows generated by the PR tooling (§3.4, §9) |
| A zero-test run (infra abort, #1007/#1012) | `is_valid_run` generated column (§3.5) — a constraint the RPCs read, not a rule they must remember |
| Catalog drifting from the repo | `repo_commit_sha` on every row, full replace per commit |
| Divergence between the JSONB and the fact table | `e2e_rebuild_facts(run_id)` (§9) |
| Oversized payload | The existing caps in `build-run-payload.mjs` still apply: 25 screenshots, 3 MB each, 8000 chars of error text |

---

## 9. Validation

**This repo** — unit tests under `npm run test:scripts`:

- `scripts/lib/playwright-report-walk.test.mjs` — the shared walk: describe-chain threading,
  `title_path` for nested describes, `paramFromSuitePath()`, and a parameterized spec producing two
  distinct `title_path` values from one leaf title (the 2026-07-29 case, as a regression test).
- `build-catalog-payload.test.mjs` — bullet parsing across all five markers, section extraction,
  `spec_path` resolution, and a hard failure when a `MODULES` entry cannot be located.

**`quality-platform`** — an assertion migration against a synthetic run: ingest a payload, check the
fact count, re-POST at the same `run_attempt` and confirm idempotency (zero new facts), re-POST at a
higher attempt and confirm supersede, then run each RPC against the seed and validate its shape. Plus
one negative case: a payload containing an identity collision must yield `tests_received >
tests_inserted` and a persisted run, never a rollback.

**Evidence on day one** — the backfill reports how many runs and rows it actually landed, and that
figure is cross-checked against `reports/daily-history.jsonl` for the same dates. The comparison is
the validation; the count is not asserted in advance (§4.3).

---

## 10. Implementation split (after approval)

- **`quality-platform`** — migrations for the four tables and the `is_valid_run` column;
  `e2e_ingest_run`; **`e2e_rebuild_facts(run_id)`** (the function that makes invariant 2 real and is
  the repair path in §8); the analytical RPCs; the per-run backfill migration with its summary; and
  the `e2e-automation-runs-create` change from `.insert()` to the RPC. The bulk of the work.
- **`langflow-e2e`** — extract `scripts/lib/playwright-report-walk.mjs` and refit both existing
  scripts onto it; `build-run-payload.mjs` emits `title_path`, `param` and `run_attempt`; new
  `build-catalog-payload.mjs`; alias generation wired into the PR tooling; the two unit-test files.
  Nightly ingest only if §2.3 is resolved in favour of re-enabling.

---

## 11. Revision log

Revision 2 applies the review on #1181. Every claim below was verified against the repository before
being accepted.

| Finding | Verdict | Change |
|---|---|---|
| Backfill aborts — historical JSONB has only the leaf title, and parameterized specs collide | **Confirmed.** Daily of 2026-07-29 holds two `agent-context-id-isolation.spec.ts` rows with an identical leaf title; 17 spec files use an interpolated `describe` | §4.3 rewritten: per-run, `ON CONFLICT DO NOTHING`, two tiers, reported drops. New `title_path_exact` column (§3.1). §4.2 adds the same guard so a collision cannot cost a whole run |
| `nightly.yml` is dormant — half the ingest ships zero rows | **Confirmed.** Cron commented out ("Schedule disabled until the suite is stable in production"), last run 2026-03-19, failed | New §2.3 precondition; nightly removed from the core deliverable; volume estimate in §2.2 recomputed daily-only |
| `module` is not derivable from a spec path | **Confirmed.** 16 `MODULES` entries, 14 distinct directories; `core-components/` and `ui-ux/` split by checklist section | `module` removed from `e2e_spec_catalog` (§3.2); lives only on `e2e_coverage_items`; `e2e_coverage_rollup()` joins on `spec_path` |
| A re-run of a red daily is silently discarded | **Confirmed.** `run_id` is `github.run_id`, stable across attempts | `run_attempt` in the payload and a supersede path (§4.2) |
| Zero-test-run exclusion is prose, NULL-unsafe, and wrongly drops all-skipped runs | **Confirmed** | New `is_valid_run` generated column (§3.5); RPCs read it |
| `UNIQUE (module, item_hash)` should include `section` | **Confirmed**, with two corrections: the duplicate is at lines 156 and **459** (not 470), and there is exactly **one** such duplicate, not several | `UNIQUE (module, section, item_hash)`, with `section NOT NULL DEFAULT ''` so it participates in the constraint (§3.3) |
| Confirm `e2e_normalize_spec_path` is `IMMUTABLE` before any DDL | **Confirmed and already satisfied** — `LANGUAGE sql IMMUTABLE` in `20260726120000_e2e_issue_spec_refs.sql`. No work required | Recorded in §2.1 so the next reader does not have to re-derive it |
| `p_workflow DEFAULT NULL` contradicts the paragraph below it; `attempts DEFAULT 1` never applies | **Confirmed** on both | `DEFAULT 'daily-stable'` (§5); `attempts` is `NOT NULL CHECK (attempts >= 0)` (§3.1) |
| Two parsers of the same report have diverged; `title_path` and `param` already exist in the sibling | **Confirmed.** `append-weekly-history.mjs:88,96` vs `build-run-payload.mjs:84` | §4.1 extracts `scripts/lib/playwright-report-walk.mjs`; §6 reframed from settled trade-off to the cost being paid |
| §2.1's "rebuildable by replay" is asserted, not allocated | **Confirmed** | `e2e_rebuild_facts(run_id)` is a named deliverable (§10) and the repair path in §8 |
| Identity is weak on `spec_path` — a file move breaks it like a rename, and moves are more common | **Confirmed** as a gap | §3.4 ties alias generation to the PR tooling rather than to memory |

On the review's own two corrections to this document's framing: the roadmap statements in the PR body
were wrong — `origin/main:ROADMAP.md:193` has **Wave 5 — 1.11.0 feature coverage** as current, Wave 4
closed early on 2026-07-29, and the **Wave 5** milestone is open with 7 issues. The PR body is
corrected; the off-wave exception is requested at review rather than self-declared.

### 11.1 Still open for review

1. **Is `md5(spec_path || '::' || title_path)` the right identity**, given that `spec_path` makes a
   file move indistinguishable from a rename? Tooling-generated aliases (§3.4) mitigate but do not
   remove that.
2. **Is Tier-B backfill worth landing at all**, or is a clean cut-over less misleading than rows
   carrying `title_path_exact = false` and `duration_ms = NULL`? The review's position — keep it,
   because failure-recurrence is the highest-value question and does not need duration — is reflected
   above, and remains reversible.
3. **Does `nightly.yml` get re-enabled** (§2.3)? Not a #1180 decision, but it determines whether half
   the implementation split exists.
