# ISSUE-1217 — Token-usage analytics tables and the dashboard's data path

> Status: **design review**. Nothing executable ships with this document — no migration, no producer
> change, no screen.
> Companion issue: #1217. Corrects §5 of `ISSUE-1197-TOKEN-MONITOR-DESIGN.md`, which was written
> before #1211 and before the platform's own state was checked.
> Verified against `langflow-e2e@ed6eb6e` and `quality-platform@e42cc36`.

---

## 1. What this is for

#1197 phase 1 answers its four questions from a committed JSONL file. This document is the other
half: the same numbers as rows, queryable next to the failure data, so the QA Platform's E2E
dashboard can carry a cost view.

It is a **correction pass**, not a fresh design. §5 of the #1197 document sketched two tables in one
short section, before #1211 dated the price table and before anyone read the platform's migrations.
Nine of its assumptions turn out to be wrong or stale. Eight are defects that would have shipped as a
grain nothing can fill, sums that do not add up, a column that is always NULL, a history repriced on
every correction, the repo's most error-prone rule written twice in two languages, a payload that
cannot carry the data at all, two providers' consumption merged into one row, and a fact table with no
shared identity — so the join the whole exercise exists for would not have worked. The ninth is a
dependency that does not exist.

The issue that opened this pass named six. Three more were found while writing and reviewing it, all
from reading the implementation and the sibling design rather than the sketch: §2.2 and §2.7 while
drafting, and §2.8 — the missing `test_key` — from a reviewer asking the obvious question, *can the two
documents be correlated?* §2.7 is a live defect in phase 1's own output, independently confirmed by
#1180's own review on production rows.

### 1.1 State on the ground

| Piece | State |
|---|---|
| `e2e_test_token_usage`, `e2e_model_prices` | No migration exists |
| `e2e_test_results` (#1180) | Design **approved and merged** (PR #1181). No migration exists yet |
| `e2e_automation_runs` | **Exists.** `run_id TEXT NOT NULL UNIQUE` (`20260610210000_nightly_runs.sql`), read today by `TrendView.tsx` and `RegressionsView.tsx` |
| Token data in the run payload | None. `build-run-payload.mjs` has no token block |
| `reports/token-history.jsonl` | **Does not exist on `main`.** The history steps are `schedule`-gated; the series starts with the next scheduled daily |

The last row bounds the UI half and nothing else: five scheduled dailies are the first anomaly
baseline, and the detector is silent until then by construction. Database and producer work do not
wait on it.

---

## 2. The nine corrections

### 2.1 The declared grain cannot be filled from what the summarizer emits

§5 declares `(run × test × model)`. `aggregate()` returns `byModel` (run × model, no spec) and
`bySpec` (run × spec, no model split). A spec that called two models contributes **one** `bySpec` row
with a summed total, so the two outputs cannot be joined back into the grain after the fact.

**Decision.** `aggregate()` gains a third accumulator, `bySpecModel`, keyed
`${file}::${test}::${model}`. The inputs are already in hand — `probe.models[]` crossed with the
attribution for that `trace_id` — so this is an added rollup, not new collection. The unattributed
bucket is emitted the same way: one row per model with no spec, not one lump.

### 2.2 Sum of fact rows will not equal the run's authoritative total

`aggregate()` deliberately keeps two totals: per-model sums come from `modelName`-bearing spans,
while the run total comes from each trace's own `totalTokens`, because §2.1 of the #1197 document
measured that Langflow reports the same usage twice per call. When the two disagree the summarizer
reports both and picks no winner (#1197 §7).

A fact table at the declared grain can only hold the **span-derived** figure. §5's claim that "a
query that forgets to filter still sums to the run total" is therefore false whenever a mismatch
exists.

**Decision.** The fact table is span-derived, and the authoritative run total lives on the run row
as four nullable columns (§3.3). A screen can then show the discrepancy instead of a reconciled
number, and "sum of rows ≠ run total" stays queryable. No third table: the run row is created by the
same POST, and both `TrendView.tsx` and `RunSummaryView.tsx` already select from it. Widening that
table is a move the approved #1180 design takes itself — its §3.5 adds a generated `is_valid_run`
column to the same table, for the same reason: a property every reader needs belongs where every
reader already looks.

### 2.3 `provider` is never produced

§4.4's example line shows `by_model[].provider: "openai"` and §5 declares a `provider TEXT` column.
The implementation emits no provider anywhere — not on the probe, not in `byModel`, not on the
history line. Deriving one from the model id is a prefix guess that rots exactly as ids rotate
(#886, #964).

**Decision.** No `provider` on the fact table. It moves to the **price dimension**, where it is a
curated fact reviewed in a PR alongside the rate it belongs to, and provider grouping is recovered
through the join. A model with no price band therefore has no provider either — which is honest:
an id we cannot price is an id we have not classified.

### 2.4 The price dimension must be banded

#1211 made prices dated. `claude-sonnet-5` carries two bands ($2/$10 through 2026-08-31, $3/$15 from
2026-09-01) and `--summarize` selects the band effective on the **run's own** date, never the newest.
A flat dimension would reprice every historical run at today's rate on the next correction — the
failure #1211 closed on the JSONL side, reintroduced in SQL.

**Decision.** Key `(price_key, since)`; the join picks the greatest `since <= run_date`. A run whose
date precedes every band for its model resolves to unpriced, not to the earliest band.

### 2.5 The model-id resolution rule must not be reimplemented in SQL

`resolveBands()` is exact-key first, then the longest matching substring in either direction, gated
by `isAllowedSuffix()` so a tier id (`-lite`, `-mini`, `-nano`) never inherits its non-tier sibling's
rate. That gate exists because the ungated version priced `gemini-2.5-flash-lite` as Flash — a 3–6×
overstatement, caught in #1211's second review round. Porting it to plpgsql puts two
implementations of this repo's most error-prone rule in two languages, and the SQL copy would be the
one nobody unit-tests.

**Decision.** The producer sends the **already-resolved** `price_key` per row; the database joins on
it exactly and applies only band-by-date. #1197's invariant 3 holds — no dollars are stored, the
dimension is still the source of the rate. `token-cost.mjs` gains an exported `resolvePriceKey(model, prices)`
and `resolveBands()` is refactored to call it, so the resolution has exactly one implementation and
keeps its existing tests.

### 2.6 In `daily-stable.yml` the token summary runs after the payload is POSTed

`Build run payload` and `POST run to QA Platform` sit at lines ~895/~914; `Summarize token
consumption` at ~953. As wired, the payload cannot carry a token block at all.

**Decision.** Two changes, both small:

- The summarize step moves ahead of `Compute coverage counts`. Its inputs allow it: the shard token
  artifacts are downloaded at ~733 and `runguard` runs at ~806, both already upstream.
- It writes a machine-readable summary to `TOKENS_SUMMARY_OUT`, **unconditionally** — not gated by
  `TOKENS_SUPPRESS_HISTORY`. That knob suppresses the *history line* on a manual dispatch (#1183)
  because a dispatch's shape is not comparable to the daily's fixed sweep, but the DB ingest records
  **every** run by design. Sourcing the payload's token block from the history file would drop it on
  exactly the runs the platform does record.

A structural guard in `npm run test:scripts` pins the order, mirroring the guard that keeps the
health gate between `Collect models` and the run step (#1045). The summarize step keeps
`continue-on-error: true`: if it fails there is no summary file, the payload omits the block, and the
run's token columns stay NULL — visibly not measured.

### 2.7 The attribution call site records the leaf title, not the title path

§4.2 of the #1197 document claims the sidecar writes "the same `title_path` chain #1180 §3.1
requires". It does not. The helper's contract is deliberately agnostic (`test: string`, documented as
"leaf or full chain"), but the one call site passes `testInfo.title` — the leaf. #1180 §3.1 argues at
length that the leaf collides for a model-parameterized spec, where the same leaf title repeats under
one `describe` per provider.

**And the one call site is itself the collision case.** `agent-max-tokens.spec.ts` builds its suite in
a `for (const { label } of targets)` loop as `test.describe(\`Agent max_tokens [${label}]\`)`, so the
leaf titles `"max_tokens=50 caps the response's output tokens"` and
`"causal control — unset max_tokens generates freely"` repeat once per provider. `aggregate()` keys
its spec rollup on `${file}::${test}`, so whenever more than one provider's targets run, two
providers' consumption merges into a single `bySpec` row **today** — a live defect in phase 1's own
output, not only a database concern. #1185's weekday rotation masks it by usually resolving one
provider per day, which is exactly the kind of masking that makes a latent bug expensive later.

**#1180's own review reached the same defect from the other side, with production data.** Its backfill
aborted on it: the daily of **2026-07-29** holds two `agent-context-id-isolation.spec.ts` rows with an
identical leaf title, and **17 spec files** use an interpolated `describe`, concentrated in
`llm-agents/` and `mcp/client/` (#1180 §3.1, §11). `llm-agents/` is where this suite's token
consumption lives, so the overlap between "collides on the leaf title" and "spends money" is close to
total. Two independent routes — reading the code here, reading the recorded rows there — found one bug.
That is the argument for fixing it in the producer rather than compensating for it per query.

**Decision.** The call site passes `testInfo.titlePath.slice(1).join(" > ")`. Playwright documents
`titlePath` as "the full title path starting with the test file name", so element 0 is the file name
and is dropped — `file` is already carried separately. Pinned by a unit test, because that `slice(1)`
is the kind of off-by-one that silently produces a `title_path` beginning with a filename and joins
to nothing.

### 2.8 The sketch gives the fact table no shared identity, so the join it exists for does not work

§5 declares `spec_path` and `title_path` columns and stops there. #1180 §3.1 keys its own fact on a
**generated** `test_key` — `md5(e2e_normalize_spec_path(spec_path) || '::' || title_path)`, `UNIQUE
(run_id, test_key)` — and resolves renames through `e2e_test_aliases` and
`COALESCE(new_test_key, test_key)`. A token table without that column joins only by recomputing the
digest on every query, and never reaches the rename bridge at all.

The second half is the damaging one. #1180 §3.4 records that a **file move breaks the key exactly as a
rename does, and that moves are more frequent in this repository than renames.** One folder
reorganisation would therefore reset the cost series while leaving the failure series intact — two
histories disagreeing about when a test began, with nothing reporting the disagreement.

**Decision.** The fact table generates the same `test_key` from the same expression, and the unique key
becomes `(run_id, test_key, model)`. Full treatment, including the `title_path_exact` trap, in §3.5.

### 2.9 The #1180 dependency is weaker than §5 states

§5 routes the token ingest through the atomic RPC #1180 §4.2 introduces. The FK anchors on
`e2e_automation_runs(run_id)`, which exists today; only the cross-joins — cost of the spec that
failed, cost against duration — need `e2e_test_results`.

#1180's design is now approved and merged (PR #1181), which removes the review-timing argument but
not the substance: **no migration exists**, so `e2e_test_results` is still not a table anything can
join to, and an approved design is not a schema.

**Decision: ship independently of #1180.** The token fact table, its dimension and its RPCs stand
alone and answer all four questions of #1197 §1. When #1180's migrations land, `e2e_ingest_run`
absorbs the token block and `e2e_ingest_run_tokens` (§4.2) is retired in the same migration; the fact
table itself does not change, because §2.8 already gave it #1180's identity.

**The shared `test_key` does not reintroduce the dependency.** The generated column needs only
`public.e2e_normalize_spec_path()`, which exists and is `IMMUTABLE` — not `e2e_test_results`. The
token table can therefore be keyed for the join long before there is anything to join to, and the
alias bridge starts protecting the cost series from the first row rather than from whenever #1180's
migrations land. Ordering the two the other way would make a cost view wait on the larger deliverable
for no schema reason.

---

## 3. Data model

### 3.1 `e2e_model_prices` — the price dimension

```sql
CREATE TABLE public.e2e_model_prices (
  price_key          TEXT NOT NULL,          -- the key as it appears in scripts/lib/model-prices.json
  since              DATE NOT NULL,          -- band start; the flat case syncs as a single band
  provider           TEXT,                   -- curated alongside the rate (§2.3)
  input_per_million  NUMERIC(12,6) NOT NULL CHECK (input_per_million  >= 0),
  output_per_million NUMERIC(12,6) NOT NULL CHECK (output_per_million >= 0),
  note               TEXT,                   -- the band's `_comment`, carried verbatim
  repo_commit_sha    TEXT NOT NULL,          -- which commit of model-prices.json this row reflects
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (price_key, since)
);
```

Sync is a **full replace per commit inside one transaction**, the same rule #1180 §3.3 applies to the
checklist: the JSON in the repo is authoritative, so incremental reconciliation would only add ways
to drift. A flat entry (`{inputPerMillion, outputPerMillion}`) syncs as one band whose `since` is the
earliest date the table needs to answer for; the file already documents that `since` carries ordering,
not a verified launch date.

### 3.2 `e2e_test_token_usage` — the fact

One row per (run × test × model), plus one row per model for the unattributed bucket.

```sql
CREATE TABLE public.e2e_test_token_usage (
  id                BIGSERIAL PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES public.e2e_automation_runs(run_id) ON DELETE CASCADE,

  spec_path         TEXT,          -- as reported; normalised by the RPC. NULL = unattributed bucket
  title_path        TEXT,          -- describe > … > test (§2.7); NULL = unattributed bucket
  model             TEXT NOT NULL, -- raw modelName as the trace reported it
  price_key         TEXT,          -- resolved by token-cost.mjs (§2.5); NULL = unpriced

  -- The SAME identity #1180 §3.1 generates on e2e_test_results, character for character,
  -- so the two facts join without either side recomputing a hash at read time and the
  -- token series inherits the e2e_test_aliases rename bridge (§3.5). NULL for the
  -- unattributed bucket, because `||` with a NULL operand yields NULL — which is the
  -- wanted behaviour: a bucket row has no test identity to be stable about.
  -- Requires e2e_normalize_spec_path() to be IMMUTABLE — verified in #1180 §2.1.
  test_key          TEXT GENERATED ALWAYS AS (
                      md5(public.e2e_normalize_spec_path(spec_path) || '::' || title_path)
                    ) STORED,

  calls             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     BIGINT  NOT NULL DEFAULT 0,
  completion_tokens BIGINT  NOT NULL DEFAULT 0,
  total_tokens      BIGINT  NOT NULL DEFAULT 0,

  -- NULLS NOT DISTINCT is required, not cosmetic: with the default, Postgres treats two
  -- unattributed rows (test_key NULL) as distinct, so a re-POST would duplicate the
  -- bucket and idempotency would hold for attributed rows while quietly failing for it.
  -- On PG < 15, a unique index over COALESCE(test_key,'') instead.
  UNIQUE NULLS NOT DISTINCT (run_id, test_key, model)
);

CREATE INDEX ON public.e2e_test_token_usage (run_id);
CREATE INDEX ON public.e2e_test_token_usage (model);
CREATE INDEX ON public.e2e_test_token_usage (test_key, run_id DESC);  -- mirrors #1180 §3.1
CREATE INDEX ON public.e2e_test_token_usage (spec_path) WHERE spec_path IS NOT NULL;
```

The unique key is `(run_id, test_key, model)` rather than the four-column
`(run_id, spec_path, title_path, model)` an earlier draft used: `test_key` already *is* the normalised
pair, so keying on both would let a row whose `spec_path` differs only by a `tests/` prefix insert
twice under one identity.

`price_key` carries no FK: the dimension's key is `(price_key, since)`, so a single-column reference
is not expressible, and a run must remain ingestable when its model was priced after the fact. The
gap is reported instead — see `e2e_token_price_gaps()` in §5.

**Volume.** One attributed spec today plus a handful of models: single digits of rows per run. It
grows with per-spec attribution, not with the suite.

### 3.3 Run-level columns on `e2e_automation_runs`

```sql
ALTER TABLE public.e2e_automation_runs
  ADD COLUMN token_traces          INTEGER,  -- traces observed
  ADD COLUMN token_total_tokens    BIGINT,   -- authoritative: sum of each trace's own totalTokens
  ADD COLUMN token_span_tokens     BIGINT,   -- sum over modelName-bearing spans (= sum of fact rows)
  ADD COLUMN token_mismatch_traces INTEGER;  -- traces where the two disagree (#1197 §7)
```

All four nullable, and the distinction is load-bearing:

- **NULL** — not measured. Every run before this ships, and any run whose summarize step failed.
- **0 traces** — measured, nothing recorded. Tracing disabled, or no flow ran. §7 of the #1197
  document already forbids reading this as "the run spent nothing", and the screen must carry that
  wording.

No dollar column, here or anywhere: #1197's invariant 3 — which is #1180's invariant 1, no
human-editable column in any new table — stands, and dollars are computed against the dimension at
read time so a price correction is retroactive instead of frozen into old rows.

### 3.4 RLS

Identical to the sibling tables: `SELECT` to `authenticated`, all writes to `service_role` only.

### 3.5 Joining the two facts

The two fact tables are siblings at different grains — `e2e_test_results` is (run × test),
`e2e_test_token_usage` is (run × test × model) — and the whole value of having both is the join. Three
things make it work, and none of them was in §5 of the #1197 document.

**One identity, generated in one place.** Both tables generate `test_key` from the same expression
over the same `IMMUTABLE` normaliser, so the join is `USING (run_id, test_key)` with no hashing, no
`e2e_normalize_spec_path()` call and no prefix reconciliation at read time. Without it the join would
have to recompute the digest on every query, and each RPC would be free to compute it slightly
differently — the objection #1180 §3.1 answers by generating the column in the database rather than in
the edge function.

**The rename bridge is inherited, not re-solved.** #1180 §3.4 resolves renames through
`e2e_test_aliases` and `COALESCE(new_test_key, test_key)`. Sharing the key means every token RPC gets
that for free. This is not a nicety: #1180 §3.4 records that a **file move** breaks the key exactly as
a rename does, *and that moves are more frequent in this repository than renames*. Without a shared
key, one folder reorganisation silently resets the cost series while leaving the failure series
intact — two histories disagreeing about when a test began, with nothing reporting it.

**A join must not pair an exact identity with a reconstructed one.** #1180 §3.1 carries
`title_path_exact BOOLEAN`, false for rows whose `title_path` was reconstructed during backfill
(§4.3 there). Token rows are never backfilled — there is nothing to backfill (§4.4 here) — so they are
always exact, and a naive join would quietly match an exact token row against a reconstructed result
row, i.e. against a guess. Every RPC that joins the two filters `e2e_test_results.title_path_exact`,
and reports how many rows it dropped for that reason rather than narrowing the window in silence.

**What the join answers that neither table can alone:**

| Question | Why it needs both |
|---|---|
| Did the red day cost more than the green one? | `status` lives only in the results fact; tokens only in ours |
| What does a retry cost? | The poller records a trace per **attempt**, so a flaky test's tokens already arrive summed across attempts — but `attempts` exists only on the results side. A test billed three times is invisible today, in both tables separately |
| Cost movers, not just duration movers | `e2e_duration_movers` already ranks by p95 delta across the window halves; the same query over `usd_estimated` needs the run and spec identity to agree |
| What does the `@stable` set cost, and what does a promotion add? | `tags` are stored **as they were at that run** (#1180 §3.1), so the cost of a scope change is a join, not an archaeology exercise |
| Dollars spent on a recurring failure that never got an issue | `e2e_failure_lifecycle`'s `has_no_issue` × cost. The suite's least comfortable number |

The retry row is the one worth acting on: it is a real measurement gap that exists **now**, in phase 1,
and neither document currently names it.

---

## 4. Ingestion

### 4.1 The payload block

`build-run-payload.mjs` reads `TOKENS_SUMMARY_OUT` when present and emits one additive block. Absent
the file, the block is absent and every consumer that ignores it keeps working.

```jsonc
"tokens": {
  "traces": 65,
  "total_tokens": 37777,          // authoritative (trace totals)
  "span_tokens": 37777,           // span-derived; equals the sum of `rows`
  "mismatch_traces": 0,
  "rows": [
    { "spec_path": "core-functionality/llm-agents/agent-max-tokens.spec.ts",
      "title_path": "Agent max_tokens [anthropic] > max_tokens=50 caps the response's output tokens",
      "model": "claude-sonnet-5", "price_key": "claude-sonnet-5",
      "calls": 10, "prompt_tokens": 8210, "completion_tokens": 1990, "total_tokens": 10200 },
    { "spec_path": null, "title_path": null,
      "model": "gemini-3.5-flash", "price_key": "gemini-3.5-flash",
      "calls": 10, "prompt_tokens": 300, "completion_tokens": 18210, "total_tokens": 18510 }
  ]
}
```

`spec_path` is sent exactly as `build-run-payload.mjs` already reports a test's file — normalisation
is the RPC's job, through `public.e2e_normalize_spec_path()`, which is what #1180 invariant 3 requires
so the join to `e2e_issue_spec_refs` cannot miss on a `tests/` prefix.

The payload carries **no** `test_key`. It is `GENERATED ALWAYS`, so supplying it is an error rather than
an override — which is the point: one expression, in the database, for both facts (§2.8).

No dollars in the payload. The producer computes them for its own step summary and history line; the
database recomputes from `price_key` + `run_date`, and the two agreeing is a property worth being
able to check rather than one to assume.

### 4.2 Atomic write

```sql
CREATE FUNCTION public.e2e_ingest_run_tokens(p_run_id text, p_tokens jsonb)
RETURNS TABLE (rows_inserted integer, run_updated boolean)
LANGUAGE plpgsql SECURITY DEFINER AS $$
  -- 1. UPDATE e2e_automation_runs SET token_* = … WHERE run_id = p_run_id
  --      → run_updated = false when the run does not exist; DOES NOT create it
  -- 2. INSERT INTO e2e_test_token_usage
  --      SELECT … FROM jsonb_to_recordset(p_tokens->'rows')
  --      ON CONFLICT DO NOTHING          -- re-POST is a no-op, per §3.2's unique key
$$;
```

Run creation stays where it is — in the edge function today, in `e2e_ingest_run` once #1180 lands —
so there is never a second place that can insert a run. The token write is atomic in itself: totals
and detail land together or not at all. The remaining inconsistency (`token_traces > 0` with zero
fact rows) is impossible inside the transaction and detectable if it ever appears.

The edge function calls the RPC after its existing run insert, and only when the payload carries a
`tokens` block. `continue-on-error: true` on the POST step stays — a platform outage must never bring
down the suite, and the committed JSONL remains the record.

### 4.3 Price sync

`scripts/lib/model-prices.json` changes a handful of times per quarter and only on `main`. Recommended
home: a POST step in `update-coverage-summary.yml`, whose `paths` gains
`scripts/lib/model-prices.json`. That workflow already runs on push to `main` and already exists to
project repository state outward; #1180 §4.1 plans its catalog sync in the same place.

Rejected: shipping the price table inside each run payload. It removes a workflow step but lets a
manual dispatch from a branch overwrite the dimension with that branch's rates.

### 4.4 No backfill

There is nothing to backfill. Token data has never been recorded, so the series starts at the first
scheduled daily after the producer ships. A *Known gaps* comment on the table says so, in the spirit
of the missing weeks in `reports/README.md` — retroactive data is not invented.

---

## 5. Query layer

plpgsql RPCs, matching the platform's existing pattern (`get_run_failure_treatment`,
`get_qa_board_e2e`). Every RPC takes `p_days int DEFAULT 90` and `p_workflow text DEFAULT NULL`.

Zero-test runs are excluded through `is_valid_run`, the generated column #1180 §3.5 adds to
`e2e_automation_runs` — not through a per-RPC predicate. An infra abort spending nothing must not read
as a cheap day (#1012), and #1180 already argues why that obligation cannot live in five separate RPC
bodies: it is NULL-unsafe and it wrongly discards an all-skipped run. This design inherits the column
rather than restating the rule, which makes it a **soft ordering constraint**: shipping the token RPCs
before #1180's migrations means either landing `is_valid_run` here or carrying the predicate inline
until it exists. Landing the column here is the better trade — it is four lines and it belongs to the
run table either way.

| RPC | Returns | Answers |
|---|---|---|
| `e2e_token_cost_trend(p_days, p_workflow)` | per run: `run_date`, `traces`, `total_tokens`, `usd_estimated`, `is_floor`, `unpriced_models[]`, `mismatch_traces` | "What does a run cost, and is that number complete?" `is_floor` is true whenever any row of that run has a NULL `price_key` |
| `e2e_token_cost_by_model(p_days, p_workflow)` | `model`, `provider`, `calls`, tokens, `usd_estimated` per period | "Which rotation made it worse?" — provider comes from the dimension (§2.3) |
| `e2e_token_cost_by_spec(p_days, p_workflow)` | `spec_path`, `title_path`, tokens, `usd_estimated`, plus the run's `attributed_share` | "Which specs burn the tokens?" — the share is returned *with* the rows so a caller cannot present a partial breakdown as a whole |
| `e2e_token_price_gaps()` | models with no `price_key`, and `price_key`s with no band covering a run they appear in | The two ways a dollar figure silently becomes a floor |

Dollars are computed inside every RPC as
`prompt_tokens * input_per_million / 1e6 + completion_tokens * output_per_million / 1e6`, against the
band selected by the run's own `run_date` (§2.4). A row with no resolvable band contributes tokens and
**no** dollars, and marks the aggregate as a floor. Zero is never substituted for unknown.

`attributed_share` is the uncomfortable output and the one that must exist: with one attributed spec
today, a "cost per spec" screen shows a few percent of the run. It has to read as *the share we can
attribute*, not as a breakdown.

### 5.1 The joining RPCs, deferred on purpose

The questions in §3.5's table — cost by outcome, cost per retry, cost movers, cost of the `@stable` set,
dollars on an unticketed recurring failure — all need `e2e_test_results` to be a table. They are
**not** in the four above, and they are not in this deliverable.

What *is* in this deliverable is the identity that makes them a query rather than a migration when
#1180 lands: `test_key` generated identically on both sides (§2.8, §3.5). The RPCs themselves become a
short follow-up, gated on #1180's migrations, and every one of them filters
`e2e_test_results.title_path_exact` and reports its drops.

The exception worth naming now: **cost per retry** is a measurement gap in phase 1 itself, not only a
missing query. The poller records a trace per attempt, so a flaky test's tokens already arrive summed
across attempts with no attempt count anywhere on the token side. Nothing in this design makes it worse
and nothing here fixes it — it needs `attempts` from the results fact, which is exactly why it is
listed as a join question and flagged in §7.

---

## 6. Producer changes in this repo

- **`scripts/lib/token-cost.mjs`** — export `resolvePriceKey(model, prices)`; refactor
  `resolveBands()` to call it. Add the `bySpecModel` accumulator to `aggregate()`, emitting
  `price_key` per row and per-model rows for the unattributed bucket.
- **`scripts/watch-tokens.mjs`** — `--summarize` writes `TOKENS_SUMMARY_OUT` unconditionally (§2.6).
- **`scripts/build-run-payload.mjs`** — read that file when present, emit the `tokens` block (§4.1).
- **`.github/workflows/daily-stable.yml`** — move the summarize step ahead of the payload build; add
  `TOKENS_SUMMARY_OUT`; add the structural order guard to `npm run test:scripts`.
- **`agent-max-tokens.spec.ts`** — the call site sends `titlePath.slice(1).join(" > ")` (§2.7).
- **`.github/workflows/update-coverage-summary.yml`** — price-dimension sync (§4.3).
- **`nightly.yml`** — unchanged, and for a stronger reason than the #1197 document had. #1180 §2.3
  establishes the workflow is **dormant**: its cron is commented out and its last run was 2026-03-19.
  Wiring token ingest there produces zero rows. It follows the same conditional #1180 puts on its own
  nightly work — if the cron is ever re-enabled, by its own issue, these steps apply as written.
- **`pr-validation.yml` / `manual.yml`** — measurement only, unchanged. They summarize and never
  ingest, for the reason #1180 §2.2 gives: their per-run scope varies with the import graph.

---

## 7. Failure modes

| Failure | Response |
|---|---|
| Summarize step fails or writes nothing | No `tokens` block; run's token columns stay NULL — not measured, distinct from zero (§3.3) |
| Tracing disabled on the target | `traces = 0`, no fact rows. Screens must say "no traces recorded (tracing disabled or nothing ran)", never "$0" |
| Model has no price band | Tokens kept, no dollars, run marked `is_floor`, id listed by `e2e_token_price_gaps()` |
| Run date precedes every band for a model | Same as above — unpriced, never the earliest band by default |
| Trace total disagrees with the span sum | Both stored (`token_total_tokens` vs `token_span_tokens`) plus `token_mismatch_traces`; no winner is picked (#1197 §7) |
| Re-POST of the same run | `ON CONFLICT DO NOTHING` on the fact rows, idempotent UPDATE on the run columns |
| Token block arrives for a run that does not exist | `run_updated = false`, zero rows inserted, RPC does not create the run |
| Platform unreachable | `continue-on-error: true` already covers it; `reports/token-history.jsonl` remains the record |
| Zero-test run (#1007/#1012) | No history line already; `is_valid_run` (#1180 §3.5) also excludes the run from every RPC, so an abort cannot lower a cost average |
| Price dimension stale | `repo_commit_sha` on every row; full replace per commit, so "N commits behind" is queryable |
| A spec is renamed or **moved** | `test_key` changes on both facts identically, and `e2e_test_aliases` (#1180 §3.4) bridges both. Sharing the key is what keeps the cost series and the failure series from disagreeing about when a test began |
| A flaky test is billed once per attempt | **Known gap, not handled here.** The poller records a trace per attempt, so the tokens arrive summed with no attempt count on the token side. Needs `attempts` from #1180's fact — §5.1 |
| A join pairs an exact identity with a reconstructed one | Every joining RPC filters `e2e_test_results.title_path_exact` and reports the rows it dropped (§3.5) |

---

## 8. Validation

**This repo** — `npm run test:scripts` / `npm run test:units`:

- `token-cost.test.mjs` — `resolvePriceKey()` returns the same key `resolveBands()` resolves for the
  whole existing table (the `gpt-4o-mini-search-preview` and `gemini-*-lite` cases in particular);
  `bySpecModel` splits a two-model spec into two rows and sums back to its `bySpec` total; the
  unattributed bucket emits one row per model.
- `watch-tokens.test.mjs` — `TOKENS_SUMMARY_OUT` is written when `TOKENS_SUPPRESS_HISTORY` is set,
  and when there are zero traces.
- `build-run-payload.test.mjs` — the block is emitted when the file exists, omitted when it does not,
  and a malformed file omits it without failing the build.
- The title-path unit test of §2.7, and the workflow order guard of §2.6.

**`quality-platform`** — an assertion migration: ingest a payload with one attributed spec and an
unattributed bucket, assert the row count and that `token_span_tokens` equals the sum of the rows;
re-POST for idempotency; exercise each RPC, including a run whose date falls in the introductory
`claude-sonnet-5` band and one that falls after 2026-09-01, asserting the two price differently from
identical token counts.

Two assertions specifically about the shared identity (§2.8), because a silent divergence there is the
one failure that makes both datasets look fine on their own:

- The same `(spec_path, title_path)` inserted into `e2e_test_results` and into
  `e2e_test_token_usage` produces the **same** `test_key`, including when one side carries the `tests/`
  prefix and the other does not — the case `e2e_normalize_spec_path()` exists for.
- A row of the unattributed bucket has `test_key IS NULL`, and two bucket rows differing only by
  `model` both insert (the `NULLS NOT DISTINCT` key admits them, and a re-POST adds neither).

**Real evidence before the screen** — the first scheduled daily after the producer ships,
cross-checking the RPC's per-model dollars against the same run's `reports/token-history.jsonl` line.
The two are computed independently (§4.1); agreement is the check.

---

## 9. Implementation split (after approval)

- **`langflow-e2e`** — the producer changes of §6 plus their tests. No screen, no migration.
- **`quality-platform`** — migrations for the dimension, the fact table (including its generated
  `test_key`, §2.8) and the four run columns; `e2e_ingest_run_tokens`; the four RPCs of §5; the
  edge-function call; the price-sync endpoint.
- **Follow-up, gated on #1180's migrations** — the joining RPCs of §5.1. No schema change: the shared
  identity ships here.
- **One line in `ISSUE-1180-ANALYTICS-DB-DESIGN.md`** pointing at this document. Today the reference is
  one-way — this design cites #1180 fifteen times and #1180 does not contain the word "token", so a
  reader arriving at the data model has no way to learn a sibling fact was designed against it.
- **Later cycle** — the cost view, a fourth alongside
  `src/components/e2e/dashboard/{TrendView,RunSummaryView,RegressionsView}.tsx`. Deferred for the
  reason #1180 §7 defers its own UI, and for one more: with a single attributed spec and no committed
  history, there is not yet enough data for a screen to be honest about.

---

## 10. Open questions for review

1. **Are four token columns on `e2e_automation_runs` acceptable**, or should the run-level integrity
   block be its own table? Columns win on the read path (`TrendView` already selects that row) and on
   atomicity; a table wins if run-level token facts keep growing.
2. **Should `provider` be curated in the price dimension at all**, given a model we cannot price is
   also a model we cannot attribute to a provider? The alternative is no provider grouping until an
   id gets a row — which is arguably the honest behaviour rather than a gap.
3. **Does the price sync belong in `update-coverage-summary.yml`**, or does a dimension synced from
   the repo deserve its own workflow, so a price correction is not coupled to the checklist
   regeneration's trigger?
4. **Is per-spec attribution worth broadening before the screen?** Three other specs import the
   tracker and could each gain one line, which would take `attributed_share` from a few percent to
   something a screen can lead with. Against it: #1197 kept the blast radius at one call site
   deliberately.
5. **Does the per-attempt billing gap deserve its own issue now?** A flaky test's tokens already arrive
   summed across attempts (§5.1, §7) and nothing on the token side counts attempts. It is invisible in
   both facts today and becomes a query only once #1180's `attempts` exists — which argues for filing it
   against the retry data rather than letting it live as a table row in this document.
6. **Should the identity expression be extracted rather than duplicated?** Both facts now generate
   `md5(e2e_normalize_spec_path(spec_path) || '::' || title_path)`. Two literal copies of one expression
   is exactly the kind of divergence #1180 §3.1 generated the column to prevent, one level up. A shared
   `IMMUTABLE` helper (`e2e_test_key(spec_path, title_path)`) would make it one definition — at the cost
   of a function both generated columns depend on.
