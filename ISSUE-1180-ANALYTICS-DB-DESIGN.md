# ISSUE-1180 — Analytics data model for E2E runs and specs

**Status:** proposed — awaiting review approval. No code ships against this document until the model is approved.
**Issue:** [#1180](https://github.com/oriontech-me/langflow-e2e/issues/1180)
**Scope:** the QA Platform database (`quality-platform`) plus the payload producers in this repo.
**Author:** design pass, 2026-07-31.

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
  daily-stable.yml  ──┐
  nightly.yml  (new) ─┴──POST──→  e2e-automation-runs-create (edge fn)
                                        │ one transaction
                                        ├──→ e2e_automation_runs   (exists, untouched)
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
   index over an immutable source, not a competing copy. If the two ever disagree, the JSONB wins
   and the fact is rebuildable by replay.
3. **Every path column is normalised through `public.e2e_normalize_spec_path()`** — the function
   that already exists. Issue bodies write `core-functionality/foo.spec.ts` while the runner JSONB
   sometimes carries the `tests/` prefix; without the shared normaliser the join to
   `e2e_issue_spec_refs` misses on a prefix difference.

### 2.2 Decisions taken before this document

| Decision | Value |
|---|---|
| Where the tables live | QA Platform Supabase |
| Source of truth | Markdown wins. `QA-CHECKLIST.md` and the spec files stay authoritative; the database is a read-only projection, resynced on merge to `main`. The PR guards from #741 and #985 are untouched |
| Run sources | `daily-stable` (already POSTs) + `nightly` (new). PR-CI and `manual.yml` are excluded — their per-run scope varies (the import-graph subset), which would poison trend lines |
| Volume | ~25k rows/month. No partitioning until ~5M |

---

## 3. Data model

### 3.1 `e2e_test_results` — the fact

One row per (run × test). Roughly 250 rows per daily run, 800 per nightly.

```sql
CREATE TABLE public.e2e_test_results (
  id             BIGSERIAL PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES public.e2e_automation_runs(run_id) ON DELETE CASCADE,

  spec_path      TEXT NOT NULL,          -- always e2e_normalize_spec_path()'d
  title_path     TEXT NOT NULL,          -- describe > describe > test, full chain
  test_title     TEXT NOT NULL,          -- leaf title, for display
  line           INTEGER,                -- display only; drifts on every edit to the spec

  -- Stable identity as a GENERATED column: defined once, in the database, so the
  -- edge function and the backfill cannot compute it differently.
  test_key       TEXT GENERATED ALWAYS AS (
                   md5(public.e2e_normalize_spec_path(spec_path) || '::' || title_path)
                 ) STORED,

  status         TEXT NOT NULL CHECK (status IN ('passed','failed','flaky','skipped')),
  duration_ms    INTEGER,
  attempts       SMALLINT NOT NULL DEFAULT 1,
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

Two column choices carry the design:

- **`title_path`, not just the leaf title.** The payload currently sends `test: spec.title`, which
  drops the `describe` chain. A model-parameterized spec repeats the same leaf title under a
  different `describe` (one per provider — the `param` case from #899), so keying on the leaf alone
  collides. The producer must be changed to emit the full chain; see §4.1.
- **`tags` is stored as it was AT THAT RUN**, not as it is today. That single choice makes
  "evolution of the `@stable` set" and "scope diff between run A and run B" fall out of the fact
  table, with no slowly-changing dimension to maintain. Both are listed as unanswerable in
  `reports/README.md` today.

### 3.2 `e2e_spec_catalog` — spec dimension

One row per spec file, current state, derived from the repository.

```sql
CREATE TABLE public.e2e_spec_catalog (
  spec_path         TEXT PRIMARY KEY,     -- normalized
  module            TEXT NOT NULL,        -- one of the 16 in scripts/coverage-summary.ts MODULES
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

`module` reuses the vocabulary of the `MODULES` array in `scripts/coverage-summary.ts` — no new
taxonomy is invented. `repo_commit_sha` on every row is how a stale catalog is detected instead of
silently trusted.

### 3.3 `e2e_coverage_items` — the checklist as data

One row per Part II bullet of `QA-CHECKLIST.md`.

```sql
CREATE TABLE public.e2e_coverage_items (
  id              BIGSERIAL PRIMARY KEY,
  module          TEXT NOT NULL,          -- same vocabulary as e2e_spec_catalog.module
  section         TEXT,                   -- "15.10", "3.2" …
  item_text       TEXT NOT NULL,
  item_hash       TEXT NOT NULL,          -- md5(item_text)
  marker          TEXT NOT NULL CHECK (marker IN ('x','-','~','!',' ')),
  spec_path       TEXT,                   -- NULL when the item is not automated
  phase           TEXT,                   -- 0 / 1 / 2
  repo_commit_sha TEXT NOT NULL,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (module, item_hash)
);
```

Keyed on `md5(item_text)` rather than line number: the text can repeat across modules, and a line
number drifts on every edit. Sync is a **full replace per commit** inside one transaction —
Markdown is authoritative, so incremental reconciliation would only add ways to drift.

### 3.4 `e2e_test_aliases` — rename bridge

```sql
CREATE TABLE public.e2e_test_aliases (
  old_test_key TEXT PRIMARY KEY,
  new_test_key TEXT NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Without it, every rename silently resets a test's series and "flake rate over 90 days" starts
lying. Testid drift has already cost the suite history once.

### 3.5 RLS

Identical to the sibling cache tables: `SELECT` granted to `authenticated`, all writes restricted
to `service_role`.

---

## 4. Ingestion

### 4.1 Producer changes in this repo

- **`scripts/build-run-payload.mjs`** emits `title_path` — the full `describe > … > test` chain —
  alongside the existing leaf `test` field. Backwards compatible; the current payload keeps working
  for any consumer that ignores the new field.
- **`scripts/build-catalog-payload.mjs`** (new) walks `tests/**/*.spec.ts` for tags, `test()` counts,
  `@stable` and `@destructive`; resolves docs under `docs/` by content reference; parses the Part II
  bullets of `QA-CHECKLIST.md` reusing the `MODULES` taxonomy. It **fails loudly** when a module in
  `MODULES` cannot be located, mirroring what `scripts/coverage-summary.ts` already does.
- **`nightly.yml`** gains a `json` reporter plus copies of the `Build run payload` and
  `POST run to QA Platform` steps from `daily-stable.yml`, keeping `if: always()` and
  `continue-on-error: true`. It sends `WORKFLOW: nightly` and no `STABLE_COUNT`/`TOTAL_COUNT` — the
  nightly runs the whole suite, so the optional `coverage` block is simply absent.
- **`update-coverage-summary.yml`** runs the catalog sync. It already triggers on every push to
  `main` touching `QA-CHECKLIST.md` or `tests/**/*.spec.ts`, which is exactly the right trigger; no
  new workflow is needed.

### 4.2 Atomic ingest

The Supabase JS client cannot run a multi-statement transaction. Inserting the run and then the
facts leaves a window for an **orphan run** — run recorded, zero facts — and the series would start
lying with no signal that it had. Both inserts move into one plpgsql function, which also
concentrates the idempotency currently split between the `UNIQUE(run_id)` constraint and the
`23505` race handling inside the edge function.

```sql
CREATE FUNCTION public.e2e_ingest_run(p_payload jsonb)
RETURNS TABLE (run_id text, was_new boolean, tests_inserted integer)
LANGUAGE plpgsql SECURITY DEFINER AS $$
  -- 1. INSERT INTO e2e_automation_runs ... ON CONFLICT (run_id) DO NOTHING
  -- 2. if nothing was inserted -> RETURN (run_id, false, 0)   [preserves today's 200 "exists"]
  -- 3. INSERT INTO e2e_test_results
  --      SELECT ... FROM jsonb_to_recordset(p_payload->'tests')
$$;
```

The edge function calls the RPC instead of `.insert()`. External behaviour does not change: 201 for
a new run, 200 `exists` for a repeat. Screenshot upload to the `playwright-evidence` bucket still
happens **before** the RPC, so no base64 reaches the database. The `continue-on-error: true` on the
POST step stays — a platform outage must never bring down the suite.

### 4.3 Backfill

| Source | Coverage | Method |
|---|---|---|
| Runs with a populated `tests[]` (from migration `20260701120000` onward) | **Complete** — every test's status, duration, steps, error | One migration: `INSERT … SELECT` over `jsonb_to_recordset(tests)`. No CI re-run needed |
| Earlier runs | **Partial** — only `failures[]` and `flaky[]`, with no duration and no pass list | Backfill the failures with `duration_ms = NULL`. These runs will **never** have a per-test pass rate |

The gap is recorded in a *Known gaps* block on the table, in the same spirit as the missing weeks in
`reports/README.md`. Retroactive data is not invented.

Note that re-POSTing an old run does **not** repair it: the ingest short-circuits on an existing
`run_id` and returns `200 exists` without updating. Backfill is therefore a SQL path, not a replay
of HTTP requests.

---

## 5. Query layer

plpgsql RPCs, not raw views — matching the pattern the platform already uses
(`get_run_failure_treatment`, `get_qa_board_e2e`). Every RPC takes `p_days int DEFAULT 90` and
`p_workflow text DEFAULT NULL` (NULL means all).

Filtering by workflow is effectively mandatory: the daily runs ~250 `@stable` tests and the nightly
runs the whole suite, so mixing them distorts every average.

| RPC | Returns | Answers |
|---|---|---|
| `e2e_test_health(p_days, p_workflow)` | `runs`, `passed`, `failed`, `flaky`, `flake_rate`, `current_fail_streak`, `last_failed_at`, `distinct_error_signatures` | "Is this test actually stable?" and the `@stable` removal rule in `CONTRIBUTING.md`, mechanically. Resolves aliases via `COALESCE(new_test_key, test_key)` |
| `e2e_spec_duration_trend(p_days, p_workflow)` and `e2e_duration_movers(p_days)` | `total_ms`, `p50_ms`, `p95_ms`, `slowest_test_key`, `delta_p95` | "Which spec inflated the daily?" The movers RPC compares the first half of the window against the second and ranks by p95 delta |
| `e2e_version_regression_window(p_test_key)` and `e2e_version_failure_matrix(p_days)` | `last_green_run`, `first_red_run`, each with `langflow_version` and `langflow_commit_sha` | "Which build introduced it?" — the window the regression entered through |
| `e2e_coverage_rollup()` and `e2e_stable_set_diff(run_a, run_b)` | per module: counts per marker, `automated_pct`, `items_without_spec`, `specs_without_item` | Reproduces the Coverage Summary as data, plus two things Markdown cannot show: a `[x]` bullet with no resolvable spec, and a spec with no Part II bullet |
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

`has_no_issue` is the most uncomfortable output and the most valuable: a recurring failure that
never became an issue. Together with `hours_to_issue` it gives triage responsiveness a number, and
with `is_product_regression` it separates real Langflow regressions from noise on our side — which
is the suite's ROI, currently curated by hand in `REGRESSIONS.md`.

---

## 6. Out of scope, deliberately

- **PR-CI and `manual.yml` ingestion.** Their scope varies per run (the import-graph subset), which
  would poison trend lines.
- **Any new UI in the QA Platform.** This delivers data and RPCs; screens are a separate cycle.
- **Attempt-level granularity.** Test-level plus an `attempts` count answers every question asked
  here. Attempt rows would answer "how often did a retry save us", which nobody asked for.
- **Partitioning and retention.** Revisit above ~5M rows.
- **Merging with Flakiness.io.** Third-party format, partial overlap.
- **Retiring `reports/*.jsonl`.** It stays: a second copy, versioned in git, useful exactly when the
  platform is unreachable.

---

## 7. Failure modes

| Failure | Response |
|---|---|
| Platform unreachable at the end of the daily | `continue-on-error: true` already covers it — suite green, run not ingested. The JSONL in the repo remains the safety net |
| Run recorded with no facts | Impossible by construction — the ingest RPC is atomic (§4.2) |
| A rename resets a test's series | `e2e_test_aliases` plus `COALESCE` inside the RPCs |
| A zero-test run (infra abort, #1007/#1012) | `tests[]` is empty, so zero facts are written. Every RPC must exclude runs where `passed = 0 AND failed = 0 AND flaky = 0`; without that filter an abort reads as "a day when nothing failed" — the exact error #1012 closed |
| Catalog drifting from the repo | `repo_commit_sha` on every row, full replace per commit. An RPC can surface "catalog is N commits behind" |
| Oversized payload | The existing caps in `build-run-payload.mjs` still apply: 25 screenshots, 3 MB each, 8000 chars of error text |

---

## 8. Validation

**This repo** — unit tests under `npm run test:scripts`:

- `build-run-payload.test.mjs` — the `title_path` chain, including nested `describe` and a
  model-parameterized spec.
- `build-catalog-payload.test.mjs` — bullet parsing across all five markers, section extraction,
  `spec_path` resolution, the 16-module taxonomy, and a hard failure when a `MODULES` entry cannot
  be located.

**`quality-platform`** — an assertion migration against a synthetic run: ingest a payload, check the
fact count, re-POST and confirm idempotency (zero new facts), then run each RPC against the seed and
validate its shape.

**Real evidence on day one** — the backfill yields roughly 30 runs of history immediately, which can
be cross-checked against what `reports/daily-history.jsonl` already asserts for the same dates.

---

## 9. Implementation split (after approval)

- **`quality-platform`** — migrations for the four tables, `e2e_ingest_run`, the analytical RPCs, the
  backfill migration, and the `e2e-automation-runs-create` change from `.insert()` to the RPC. The
  bulk of the work.
- **`langflow-e2e`** — `build-run-payload.mjs` emits `title_path`; new `build-catalog-payload.mjs`;
  `nightly.yml` ingest; the two unit-test files.

---

## 10. Open questions for review

1. **Materialising failures as rows reopens a documented decision.** The header comment of
   `20260726120000_e2e_issue_spec_refs.sql` deliberately chose not to: *"Rather than materialize
   failures as rows — which would duplicate the jsonb and reintroduce a human-declared flag —
   treatment is DERIVED"*. This design argues the objection targeted a **human-declared flag**,
   which the fact table does not introduce, and that the read pattern is inverted: that decision
   optimised opening one run, whereas longitudinal analysis sweeps ninety. If that reasoning does
   not hold, the design changes fundamentally.
2. **Is `md5(spec_path || '::' || title_path)` the right identity**, with a manual alias table for
   intentional renames? Alternatives welcome.
3. **Is the partial backfill of pre-July runs worth having at all**, or is a clean cut-over date
   less misleading than rows with `duration_ms = NULL`?
