# ISSUE-1197 — Token consumption and cost monitor for a run

> Status: **design review**. Nothing executable ships with this document.
> Companion issue: #1197. Stacked on #1180 (analytics data model) for its per-spec half only —
> the producer half of this design stands alone.

---

## 1. Problem

The suite spends money on every run and measures none of it. Four questions have no answer:

1. **What does one daily run cost?** Unknown, per run and per month.
2. **Which specs burn the tokens?** The agent specs drive multi-turn loops. None is budgeted.
3. **Did consumption regress?** A Langflow change that duplicates context, or an agent that starts
   looping, keeps the suite green while the bill moves. Nothing would report it.
4. **Which model rotation made it worse?** `collect-models` rotates the model per provider (#964,
   #886). The cost consequence of a rotation is never measured.

The data to answer all four already exists inside Langflow and is thrown away: every flow run
writes a trace whose LLM spans carry `tokenUsage` and `modelName`, and the trace dies with its flow.

### 1.1 What "monitor" means here

Recording and reporting, not enforcing. The output is a number per run, per model and per spec, plus
a dollar estimate. It never fails a step and never gates a merge — the same posture as the in-run
backend watcher (#1030), for the same reason: a diagnostic that can redden a run gets disabled.

---

## 2. Phase 0 — spikes, measured before designing

Run against a clean `langflowai/langflow-nightly:latest` container (`1.12.0.dev10`) started
**without** `LANGFLOW_DEACTIVATE_TRACING`, using the `basic-prompting-trace-fixture.json` asset and
the `/api/v1/run/{id}` + `tweaks` path that `traces-detail-llm-span-populated.spec.ts` already
exercises. Verdict: **go**, and cheaper than the pre-spike design assumed.

| Spike | Question | Measured result |
|---|---|---|
| **S1** | Does `tokenUsage` populate per provider, or only for OpenAI? | **All three.** `openai/gpt-4o-mini` 40/48/**88**, `anthropic/claude-sonnet-4-6` 40/7/**47**, `google/gemini-flash-latest` 30/1821/**1851** (prompt/completion/total). `modelName` populated on the provider span in all three |
| **S2** | Does `GET /api/v1/monitor/traces` answer without `flow_id`? | **Yes**, 200. With traces present it returned 2 traces across 2 distinct flows, so the poller needs **one** request per tick, not one per live flow |
| **S3** | What does a tick cost against a live backend? | Flow list 98 ms; per-flow trace query ~13 ms; the naive per-flow loop is 28 requests / 463 ms against 27 live flows. S2 collapses it to 1 list request plus one detail fetch per **new** trace |
| **S4** | Does a trace survive its flow being deleted? | **No.** After `DELETE /api/v1/flows/{id}`: trace detail → **404**, list for that flow → 0. Collection must precede cleanup |

The provider labels accepted by the unified `ModelInput` wire format are `OpenAI`, `Anthropic` and
`Google Generative AI` — the tweak shape is `model: [{ name, provider }]` plus `api_key`.

**Reproduction.** The spike script is not committed (it is a throwaway probe, and #1017 forbids
validating helpers outside the repo only for code that ships). To repeat it: start the image without
`LANGFLOW_DEACTIVATE_TRACING`, `POST /api/v1/api_key/` (auto_login has required a key since v1.5, so
a bearer token alone answers 403 on `/run`), create the fixture flow, run it with the tweak above,
then walk `GET /api/v1/monitor/traces/{trace_id}` → `spans[]`.

### 2.1 Two findings that shape the design

**The same usage is reported twice per call.** Langflow emits a component-level `llm` span
(`Language Model`, `modelName: null`) *and* an inner provider span (`ChatOpenAI gpt-4o-mini`), both
carrying an identical `tokenUsage` object. Summing every `llm` span double-counts every call.
Per-model attribution therefore sums **only spans with a populated `modelName`**; run totals use the
trace's own `totalTokens`, which the spike confirmed is not doubled (47 for the Anthropic run whose
two spans each reported 47).

**A local run produces nothing.** `scripts/start-langflow-docker.sh` sets
`LANGFLOW_DEACTIVATE_TRACING=true`, so a local instance writes zero traces. The daily's service
container does not set it, which is why `traces-latency-tokens.spec.ts` is green in CI and a local
`--grep` of the same spec would find nothing to read. Local development of this monitor needs the
flag off; see open question 2.

### 2.2 A collateral finding

Asked to reply with a single word, `gemini-flash-latest` spent **1821 completion tokens** against
OpenAI's 48 and Anthropic's 7 — 38× and 260× for identical input. It is the exact class of waste the
monitor exists to surface, and it compounds with the model-verbosity flakiness recorded in #866,
where a rotated-in verbose model broke text-length assertions. Cost and flakiness have the same root
here.

---

## 3. Architecture

```
  langflow-e2e (repo)                              QA Platform (Supabase)
  ───────────────────                              ──────────────────────
  shard: watch-tokens.mjs  ──poll──→ Langflow /api/v1/monitor/traces
        │  (1 req/tick + 1 detail per new trace)
        ├──→ reports/tmp/token-probes-<shard>.jsonl     (artifact)
  spec: trackCreatedFlows.cleanup()
        │  (collect BEFORE the DELETE — S4)
        └──→ reports/tmp/token-attrib-<shard>.jsonl     (artifact)

  merge job: watch-tokens.mjs --summarize
        ├──→ reports/token-history.jsonl   (committed, [skip ci] — safety net)
        ├──→ $GITHUB_STEP_SUMMARY          (table + anomalies)
        └──→ build-run-payload.mjs  ──POST──→ e2e-automation-runs-create (edge fn)
                                                  └──→ e2e_test_token_usage   NEW
```

### 3.1 Invariants

1. **Diagnostic only.** The poller never fails a step, never aborts a shard, never gates `@stable`.
   A failed tick is a warning line.
2. **Never silently.** Anything not attributable to a spec is counted in an `unattributed` bucket
   with its reason. A model with no price entry keeps its token counts, gets `usd_estimated: null`,
   and is named in `unpriced_models`. Zero is never used as a stand-in for unknown (#1012's rule
   applied to money).
3. **No human-editable column in the database** (#1180 invariant 1). The DB stores derived token
   counts; dollars are computed in an RPC against a price dimension synced from this repo.
4. **Collection precedes cleanup.** Measured in S4, not assumed. The flow-cleanup rule stays
   untouched: no spec keeps a flow alive to be measured later.
5. **The suite's load budget is respected.** One request per tick against a backend whose
   saturation is a known flake source (#817, #1048); ticks are skipped while the backend is wedged.

### 3.2 Decisions taken before this document

| Decision | Value |
|---|---|
| Source of token data | Langflow's own traces. A counting proxy in front of the providers was rejected: more exact, but it edits the start scripts for three providers and becomes a single point of failure for the whole suite |
| Reconciliation against provider bills | Deferred — no admin keys today. Reserved as an optional additive `reconciliation` block; absent it, the script warns and reports the trace-derived estimate |
| Attribution mechanism | The shared flow tracker's sidecar, not a fixture. `tests/fixtures/**` is suite-wide in the import graph (#1054) and its teardown runs after the `afterEach` cleanup, i.e. after the flow is gone |
| Run sources | `daily-stable` + `nightly`. PR-CI and `manual.yml` excluded — the import-graph subset varies per run and would poison the series (same reasoning as #1180) |
| Alerting | Step summary + platform. No auto-issue, no gate |

---

## 4. Components

### 4.1 `scripts/watch-tokens.mjs` — the poller

Mirrors `scripts/watch-backend.mjs` in shape and posture: a long-running recorder started next to
the shard's test step, stopped on `SIGTERM`, plus a `--summarize` mode consumed by the merge job.

Per tick (default 15 s):

1. `GET /api/v1/monitor/traces` — one request, no `flow_id` (S2).
2. For each `trace.id` not already seen, `GET /api/v1/monitor/traces/{id}` once, flatten `spans[]`,
   keep the spans with a populated `modelName`.
3. Append one line per trace to `reports/tmp/token-probes-<shard>.jsonl`.

Load control: skip the tick when a liveness probe says the backend is wedged (reusing what
`watch-backend.mjs` already measures rather than probing twice), and cap detail fetches per tick so a
burst of traces cannot turn one tick into a hundred requests.

The 15 s interval is a trade against S4, not a guess: a flow deleted between two ticks loses its
trace. That is exactly why the sidecar exists — the specs on the shared tracker do not depend on the
poller's timing at all, and the poller is what covers the rest.

```jsonc
// reports/tmp/token-probes-<shard>.jsonl — one line per trace
{ "trace_id": "d37b…", "flow_id": "63d2…", "start_time": "2026-07-31T13:35:38Z",
  "status": "ok", "total_tokens": 1851,
  "models": [ { "model": "gemini-flash-latest", "prompt_tokens": 30,
                "completion_tokens": 1821, "total_tokens": 1851, "calls": 1 } ] }
```

`models[]` is built from `modelName`-bearing spans only (§2.1). `total_tokens` at the top level comes
from the trace, so a summary can cross-check the two and report a mismatch instead of silently
preferring one.

### 4.2 Sidecar in `tests/helpers/flows/track-created-flows.ts`

`cleanup()` already settles pending body reads, navigates off the canvas, and then deletes each
captured id. One step is inserted **before** the deletes: for each captured `flow_id`, fetch its
traces and append `{trace_id, flow_id, test, file}` to `reports/tmp/token-attrib-<shard>.jsonl`.

Constraints this must honour, all of them already load-bearing in that helper:

- It **cannot throw**. A failed attribution write is logged and skipped; `cleanup()`'s contract is
  that only `{ strict: true }` fails a teardown, and never over telemetry.
- It **cannot delay the deletes** measurably. One request per captured flow, no polling: a trace that
  has not landed yet is simply missed and its tokens fall to the poller or to `unattributed`.
- It is **opt-in with the helper**. Coverage is the 5 specs on the tracker today and the 51 of #1108
  as they migrate. No spec is edited by this design.

The test identity written here is the same `title_path` chain #1180 §3.1 requires of
`build-run-payload.mjs`, so the two datasets join without a second identity rule.

### 4.3 `--summarize` and the price table

Joins probes + sidecar + `scripts/lib/model-prices.json` (USD per 1M input and output tokens, keyed
by exact model id) and emits the run line plus the step-summary table. Unknown model → counts kept,
dollars `null`, id listed in `unpriced_models`. Given how fast `collect-models` rotates models
(#886, #964), unknown models are the expected steady state, not an error.

Anomaly detection is deliberately crude: compare the run (and each attributed spec) against the
**median** of the last N entries of `reports/token-history.jsonl`, flag a ratio above a threshold.
No baseline (fewer than N entries) means no anomaly — never a division by zero, never a first-run
alarm.

### 4.4 `reports/token-history.jsonl` — schema v1

Same rules as the existing history files: append-only, machine-written, human-read, additive fields
without a version bump (`reports/README.md`).

```jsonc
{
  "version": 1,
  "date": "2026-07-31",
  "workflow": "daily-stable",
  "run_id": "30534416609",
  "run_url": "https://github.com/oriontech-me/langflow-e2e/actions/runs/30534416609",
  "langflow_image": "langflowai/langflow-nightly:latest",
  // `usd_estimated` covers priced models only. A non-empty `unpriced_models` therefore
  // makes every dollar figure in the line a FLOOR, not the cost — the token counts stay complete.
  "totals": { "traces": 312, "prompt_tokens": 1840233, "completion_tokens": 96120,
              "total_tokens": 1936353, "usd_estimated": 4.82 },
  "by_model": [ { "provider": "openai", "model": "gpt-4o-mini", "calls": 210,
                  "prompt_tokens": 1200000, "completion_tokens": 60000,
                  "total_tokens": 1260000, "usd_estimated": 2.10 } ],
  "by_spec": [ { "test": "agent interaction suite",
                 "file": "tests-automations/regression/core-functionality/llm-agents/agent-component-regression.spec.ts",
                 "traces": 12, "total_tokens": 240113, "usd_estimated": 0.61 } ],
  "unattributed": { "traces": 190, "total_tokens": 900000, "usd_estimated": 2.30,
                    "reason": "spec not migrated to trackCreatedFlows (#1108)" },
  "unpriced_models": ["gemini-flash-latest"],
  "anomalies": [ { "scope": "spec", "key": "agent-max-tokens.spec.ts",
                   "run_usd": 0.90, "baseline_usd": 0.11, "ratio": 8.2 } ]
  // "reconciliation": { … }  ← optional, additive, when an admin key exists
}
```

A zero-test run (#1012) writes **no** line: an infra abort spending nothing must not read as a cheap
day. The same exclusion #1180 §7 requires of every RPC applies here.

---

## 5. Analytical persistence (QA Platform, depends on #1180)

```sql
CREATE TABLE public.e2e_test_token_usage (
  id                BIGSERIAL PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES public.e2e_automation_runs(run_id) ON DELETE CASCADE,
  spec_path         TEXT,                  -- NULL for the unattributed bucket
  title_path        TEXT,                  -- NULL for the unattributed bucket
  model             TEXT NOT NULL,
  provider          TEXT,
  calls             INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     BIGINT NOT NULL DEFAULT 0,
  completion_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens      BIGINT NOT NULL DEFAULT 0,
  -- NULLS NOT DISTINCT is required, not cosmetic: with the default, Postgres treats two
  -- unattributed rows (spec_path/title_path NULL) as distinct, so a re-POST would duplicate
  -- the bucket and idempotency — the property #1180 §4.2 buys with an atomic ingest — would
  -- hold for attributed rows and quietly fail for the bucket. On PG < 15, a unique index over
  -- COALESCE(spec_path,''), COALESCE(title_path,'') instead.
  UNIQUE NULLS NOT DISTINCT (run_id, spec_path, title_path, model)
);
```

Grain is (run × test × model) — a spec may call more than one model, which is why this cannot be
columns on `e2e_test_results`. `spec_path`/`title_path` are nullable and the `unattributed` bucket is
one row per model with both null, so a query that forgets to filter still sums to the run total
rather than under-reporting. Ingest goes through the same atomic RPC #1180 §4.2 introduces.

Dollars are **not** stored. A price dimension (`e2e_model_prices`, synced from
`scripts/lib/model-prices.json` the way `e2e_spec_catalog` is synced from the repo) plus an RPC that
joins it keeps invariant 3 and makes a price correction retroactive instead of frozen into old rows.

---

## 6. Wiring

- **`daily-stable.yml`** — start `watch-tokens.mjs` where `watch-backend.mjs` starts, stop it where
  that one stops, upload its JSONL as a per-shard artifact. The merge job summarises, writes
  `reports/token-history.jsonl`, and commits it in the push that already carries
  `daily-history.jsonl` with `[skip ci]`.
- **`nightly.yml`** — same, once it gains the payload steps #1180 §4.1 adds.
- **`pr-validation.yml` / `manual.yml`** — not wired.
- **Structural guard** in `npm run test:scripts` that the poller is still started and stopped in the
  lanes that claim it, mirroring the guard that keeps the health gate between `Collect models` and
  the run step (#1045).

---

## 7. Failure modes

| Failure | Response |
|---|---|
| Tracing disabled on the target (`LANGFLOW_DEACTIVATE_TRACING`) | Zero traces for the whole run. The summary says **"tracing disabled or no traces recorded"** and writes no history line — it must never read as "the run spent nothing" |
| Backend wedged mid-run (#922/#1048) | Ticks are skipped while wedged; traces that outlive the outage are picked up on the next tick. Traces of flows deleted during it are lost and land in `unattributed` |
| Flow deleted between two ticks, spec not on the shared tracker | Its tokens are lost. Counted as a gap in `unattributed`'s reason field, not silently dropped |
| Trace detail 404 (flow deleted mid-poll) | Skip the trace, count it in `unattributed`; that is S4 happening in real time |
| Model missing from the price table | Tokens kept, `usd_estimated: null`, id in `unpriced_models` |
| Trace `totalTokens` disagrees with the sum of its `modelName` spans | Report both and flag the run; do not pick a winner silently |
| Zero-test run (#1007/#1012) | No history line, explicit note in the summary |
| Platform unreachable | `continue-on-error` on the POST; the committed JSONL remains the record |

---

## 8. Validation

**This repo** — `npm run test:scripts`:

- `watch-tokens.test.mjs` — HTTP fake: trace with usage, trace without usage, the duplicated
  component/provider span pair (asserting no double count), unknown model, wedged backend (tick
  skipped), trace detail 404, dedup across ticks, detail-fetch cap.
- `token-cost.test.mjs` — per-1M input/output arithmetic, unknown model → `null` + listed, sums by
  model and by spec.
- `token-anomaly.test.mjs` — median with an empty and a short history (no baseline → no anomaly),
  ratio threshold, no division by zero.
- The workflow structural guard described in §6.

**Real evidence before merging the producer** — one dispatched run of the wired lane, cross-checking
the summary's per-model totals against the traces of a spec whose token count is known from the
Phase 0 fixture.

**`quality-platform`** — an assertion migration: ingest a payload with an attributed spec and an
unattributed bucket, assert the row count and that the run total is grain-independent, re-POST for
idempotency, then exercise the price-join RPC.

---

## 9. Implementation split (after approval)

- **`langflow-e2e`, phase 1** — `watch-tokens.mjs` (poll + summarize), `scripts/lib/token-cost.mjs`,
  `scripts/lib/token-anomaly.mjs`, `model-prices.json`, the tracker sidecar, `daily-stable.yml`
  wiring, the four test files, `reports/README.md` documenting the new file.
- **`langflow-e2e`, phase 2** — the `by_spec` / `unattributed` blocks added to the run payload, once
  #1180's fact ingest exists.
- **`quality-platform`** — `e2e_test_token_usage`, `e2e_model_prices` + its sync, the price-join RPC,
  the ingest change. Screens are a later cycle, as in #1180.

Phase 1 delivers all four questions of §1 from the committed JSONL alone. Phase 2 is what makes them
queryable next to the failure data.

---

## 10. Open questions for review

1. **Is the `unattributed` bucket acceptable while #1108 is partial?** Today it would hold most of
   the consumption and shrink as specs migrate. The alternative is a fixture, rejected in §3.2 for
   two concrete reasons — but that rejection is the load-bearing choice of this design and deserves
   the challenge.
2. **Should `start-langflow-docker.sh` stop deactivating tracing**, or gain an opt-in variable
   (`LANGFLOW_DEACTIVATE_TRACING=${…:-true}`)? Flipping the default changes what every local run
   writes to its own DB, and the trace tables grow unbounded across a long-lived local container.
3. **Where does the price table live** — this repo, synced to the platform (what invariant 3 argues
   for), or authored in the platform, where a price correction needs no PR?
4. **Is a 15 s tick the right trade?** Shorter loses fewer traces of short-lived flows and adds load
   to the backend that #817/#1048 already identify as the suite's bottleneck.
