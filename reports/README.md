# Run history reports

Append-only history of CI runs, kept in the repo so that longitudinal questions ("how many weeks did this test fail in a row?", "what's the flake rate of test X?") can be answered without paying GitHub Actions artifact retention or paying for an external dashboard.

Files in this directory are **machine-written and human-read only**. Do not hand-edit entries — fix forward by appending corrections in a new run.

---

## Files

| File | Source | Cadence |
|---|---|---|
| `daily-history.jsonl` | `.github/workflows/daily-stable.yml` → `scripts/append-weekly-history.mjs` (via `HISTORY_FILE` override) | One line per scheduled run (daily 08:00 UTC). Manual dispatches do **not** write to this file — the series is intentionally restricted to the cron cadence so longitudinal queries have predictable spacing (one entry per day, same image tag, same trigger). **Active source.** |
| `weekly-history.jsonl` | `.github/workflows/weekly-stable.yml` → `scripts/append-weekly-history.mjs` | One line per scheduled run (Mondays 06:00 UTC), from the now-disabled weekly workflow — **frozen**. Manual dispatches do **not** write to this file — the series is intentionally restricted to the cron cadence so longitudinal queries have predictable spacing (one entry per week, same image tag, same trigger). |
| `token-history.jsonl` | `scripts/watch-tokens.mjs --summarize` (issue #1197) | One line per run of a lane that ran the token poller. Schema version 1; additive optional fields do not bump the version. **Every dollar figure on this line is a LOCAL ESTIMATE, not the authoritative spend** (#1255 item 3): USD is computed twice — here, from `scripts/lib/model-prices.json` at run time, and on the QA Platform, which re-prices each token row from its `price_key` against its own synced copy of that table, banded by the run's date. **The platform's number is the authoritative one**; this one exists because the step summary, this line and the anomaly detector all need a figure before the POST. The two can legitimately differ — price-table sync lag, the flat-rate `since` translation, and this file's UTC date against the payload's BRT `run_date` — and the seam, with all three causes, is documented in `scripts/merge-token-payload.mjs`'s header. Do not reconcile a gap against the dashboard by editing this file. `totals.usd_estimated` and every `by_model[].usd_estimated` / `by_spec[].usd_estimated` cover **priced models only** — a non-empty `unpriced_models` means every dollar figure in that line is a FLOOR, not a total. A model absent from `scripts/lib/model-prices.json` by exact key is still resolved by substring against every table key, longest-key-first (a dated/preview/`-latest` id contains its family's key, or a short alias is contained by a longer one — #1211); genuinely unmatched ids fall through to `unpriced_models` as before. A model whose price has changed over time (`model-prices.json` entry is a dated-bands array rather than a flat rate) is priced against the band effective **on the line's own `date`**, never the newest band by default — a run whose date predates every recorded band for that model is named in `unpriced_models` rather than guessed. **`totals.total_tokens` and `totals.prompt_tokens` + `totals.completion_tokens` come from two different sources and can legitimately disagree.** `total_tokens` is TRACE-authoritative — Langflow's own reported total per trace, summed across traces (design §2.1: Langflow emits the same usage twice per call, so summing spans directly would double-count). `prompt_tokens`/`completion_tokens` are SPAN sums — summed from each trace's per-model spans, the only place a prompt/completion split exists. The two are additively consistent (`total_tokens === prompt_tokens + completion_tokens`) **only when every trace's own total agrees with the sum of its own spans**; whenever one doesn't, that trace is named in `mismatches[]` on the same line (never silently reconciled), and the run's `total_tokens` legitimately drifts from the span-derived sum by exactly that trace's discrepancy. A non-empty `mismatches[]` is therefore the signal that explains a gap between the two totals — don't read the gap itself as a bug before checking there. **`by_provider` (added #1300, additive to schema version 1) is the per-provider rollup, and its provider is READ, never inferred from the model id.** Each bucket is `{provider, models[], calls, prompt_tokens, completion_tokens, total_tokens, usd_estimated}`; the provider comes from the `provider` field every entry and band of `scripts/lib/model-prices.json` declares, resolved through the same `price_key`/date-band steps that price the row (`resolveProvider()` in `scripts/lib/token-cost.mjs`), so a line's dollars and its provider can never disagree about which table row they came from. Reading the table is not the same as being able to separate two accounts that serve the same model NAME, and the difference matters when a figure is queried: the table is keyed by model id, so the single `gpt-5-mini` row — which declares `azure` because it prices an Azure AI Foundry deployment (#1281) — books a genuine OpenAI `gpt-5-mini` call to `azure` as well. A prefix rule would get that same row wrong in the other direction. What reading buys over deriving is that the answer is stated in one auditable place and correctable there, instead of being recomputed silently from an id that is a different axis from the account that pays. Three properties to know before using it. It is **span-derived, exactly like `by_model`**, so `by_provider` and `by_model` sum to the same token figure (the span sum) and **neither** sums to `totals.total_tokens`, which is trace-authoritative — the difference is whatever `mismatches[]` reports, per the paragraph above. Reconcile a provider rollup against `by_model`, never against `totals`. `provider: null` is a real bucket, not a bug: it holds every model whose provider the price table cannot state (in practice, a model with no row at all), it **names those ids in its own `models[]`**, and adding the missing price row is what moves them to a named provider on the next run — nothing is ever folded into a neighbouring provider to make the bucket disappear. And a bucket that mixed a priced model with an unpriceable one reports `usd_estimated: null` rather than the partial sum of the priced ones, because a table row is read as that provider's spend (unlike `totals`, which is documented as a FLOOR and labelled as one in the step summary). It is deliberately **not** an anomaly scope (`token-anomaly.mjs` keys on run + spec) and deliberately **not** sent in the POSTed token block: the QA Platform's `e2e_model_prices` carries `provider` as a column on each `(price_key, since)` row and joins it at read time, so a second rollup here would put two authorities on one number — the same reason the block carries no dollars (#1255 item 3). **`unattributed` carries the same pair for its own bucket** (`total_tokens` trace-authoritative, `span_tokens` the sum of those traces' model spans, added for #1255 item 4): the bucket's rows in the POSTed token block are built from spans and can only ever sum to `span_tokens`, so the pair is what lets a consumer reconcile them instead of finding an unexplained gap. `attrib_ms` and `attrib_calls` (optional, additive to schema version 1) — **this row is the CANONICAL definition of the pair; `token-cost.mjs`, `watch-tokens.mjs` and `token-attribution.ts` point here rather than restating it, because it previously existed as four copies of the same paragraph and four copies drift** — are what the attribution sidecar itself COST this run, so the price of the measurement lands on the same line as the measurement (#1217). `attrib_ms` is **milliseconds spent in attribution, summed across every `recordTokenAttribution` CALL that did work**; `attrib_calls` is how many such calls are in that sum. The sidecar writes one cost record — `{"kind": "attrib_cost", "flows": N, "attrib_ms": …}` in the `token-attrib-*.jsonl` artifact — **per `recordTokenAttribution` call that claimed at least one flow**, which is why a plain sum is correct here and why the total is comparable across runs. That is **one call per teardown only for the two specs whose `cleanup()` attributes a whole captured batch in a single call** (`trackCreatedFlows`); the far more common path — the ~132 `@stable` specs that call `deleteFlow` once per flow id — writes **one record per flow**, not one per teardown. A teardown deleting three flows through that path produces three records, `flows: 1` each: `attrib_ms` of 23, 19, 21 sums to a real 63ms of teardown cost, but `attrib_ms / attrib_calls` there gives 21ms — a per-CALL average, not a per-teardown one — against the real 63ms the teardown paid. Because of this, **`attrib_calls` counts calls, not teardowns, and is not a spec count**: on the dominant path it runs *larger* than the number of flow-deleting specs, the opposite of what "one per teardown" would suggest. **The total (`attrib_ms` summed) is the honest figure**; do not derive a "per-teardown average" from `attrib_calls` — it does not correspond to a teardown on the path most specs take. On the tracked (`trackCreatedFlows`) path the sidecar is invoked twice for the same flows (`cleanup()` attributes the captured batch, then `deleteFlow` re-calls per id); the repeat finds every id already attributed, issues no request, and writes **no** record, so it cannot pad `attrib_calls` with near-zero entries. `flows` is likewise the number of flows that call actually claimed, not the number it was handed; those records carry no `trace_id` and no `total_tokens`, so they never enter `totals`, `by_model`, `by_spec` or `unattributed`. **`attrib_ms` is not the wall-clock time the run lost:** Playwright's workers run in parallel, so their teardowns overlap and this total exceeds the real elapsed cost. A teardown is counted even when it attributed nothing at all — a spec whose flows produced no trace still paid one request per flow, and that is the sidecar's dominant cost across the suite. `0` with `attrib_calls: 0` means no teardown reported a cost, which reads as zero cost and never as "not measured". Note that a run with **no traces at all** writes no history line whatsoever (see above), so its cost records are not reported either. Absent from history written before #1217. **No line is written for a run with zero traces or zero tests** — that absence is deliberate: a zero would enter the anomaly baseline (`scripts/lib/token-anomaly.mjs`) and lower the bar for every later run, the same reasoning `daily-history.jsonl` applies to a zero-test infra abort. Machine-written by the summarizer; never hand-edited. |

Each line is one [JSON object](#schema-version-1) terminated by `\n`. The file is JSONL (newline-delimited JSON), not a JSON array — append-only, diff-friendly.

### What the token monitor cannot see

`token-history.jsonl` reads Langflow's own traces, so it can only ever cover what those traces
carry. Four known blind spots (#1211), stated here rather than only in a PR body or issue
comment so a reader of a number finds its limits in the same place:

- **A local instance records nothing, and developer spend is OUT OF SCOPE for this series
  (#1300).** Both start scripts set `LANGFLOW_DEACTIVATE_TRACING=true`, so the poller has no
  traces to read at all when developing against a local container. That is a **decision**, not a
  pending fix: flipping the flag locally would produce traces nobody can attribute, because the CI
  secret and a developer's `.env` draw on one account balance and #1183's key-separation
  recommendation (`ANTHROPIC_API_KEY_AGENT` / `ANTHROPIC_API_KEY_CI`) is still unimplemented — so a
  local figure could not be told apart from CI's in the provider console either way. The
  consequence to carry: **this file is CI spend, and must never be quoted as total account
  spend.** The gap between the two is whatever developers spent locally, which only the provider
  console can answer, and only once the keys are split.
- **`Collect models` spend enters the totals with no spec name.** That pre-flight sweep drives the
  same Langflow instance the token poller watches, but it is not a spec run, so its traces land in
  `unattributed`, never in `by_spec`.
- **Per-spec attribution covers only the specs that pass `attribution` to `cleanup()`.** The
  sidecar is opt-in per spec (design §4.2) — one spec does this today
  (`agent-max-tokens.spec.ts`). Every other spec's cost is real and counted in the run's `totals`,
  but lands in `unattributed`, never broken out by test.
- **`pr-validation` and `manual` measure but deliberately do not write history.** Both run the
  poller and render the step-summary table so a PR/dispatch's own spend is visible, but neither
  appends to this file (`TOKENS_SUPPRESS_HISTORY`, #1183) — their scope (a capped PR subset, an
  arbitrary manual grep) is not comparable to the daily's fixed `@stable` sweep, and mixing it in
  would corrupt the trend and the anomaly baseline. On `pr-validation` there is a second bound
  (#1300): tracing is enabled only when the run touches `observability-monitoring` **or** its
  provider verdict says at least one impacted spec needs a model (`needs_models`, #1216) — so a
  PR whose specs make no LLM call reports `no traces recorded`, and that is the honest answer
  rather than a gap. Until #1300 the second clause was missing and the lane could measure nothing
  at all: every run that produced a token artifact after #1210 merged recorded `0 trace(s)` —
  all 35 of them, 30855127426 through 31021593309 — including one that executed 19 `llm-agents`
  specs against a configured provider (run 31018914069, 59 passed / 29 skipped, 139 attribution
  records, no trace file). **The populated path on this lane is still unobserved**: #1300 removed
  the reason it could not happen, and the first PR whose impacted specs actually call a model is
  what will record the first non-zero figure here. Note that a CI-only diff does not produce one
  — a canary run sets `needs_models` and therefore traces, but its three specs are LLM-free by
  construction, so it records another honest zero.

### Reading `token-history.jsonl` as a trend (#1300)

Run `npm run tokens:trend` — it applies the rules below and refuses the read when the series does
not support it. Read this section before quoting any number from it.

**Rule 1 — the rate is per LLM CALL. The raw total is not a spend rate.** A run's total tracks how
much of the suite ran that day, not what a call costs. The first three lines on file go
8,741 → 67,099 → 2,592 tokens, a **26×** spread, and the low one is not a cheap day: it is
2026-08-05, a run degraded by 24 failures and 27 skips that made 4 LLM calls. Per call the same
three lines are 728 / 1,290 / 648 — a **2×** spread. The denominator is already on every line
(`by_model[].calls`), so this costs no new field and no change to the instrument. Quote the raw
total only as context for how much of the suite the figure covers, and cross-reference
`daily-history.jsonl` for that date's failure/skip counts before calling any day cheap.

**Rule 2 — tokens and dollars do not have the same exposure, so one window rule for both is wrong
in one direction.** A token count is **measured** and survives a pricing edit untouched. A dollar
figure is **computed** at run time from `scripts/lib/model-prices.json`, so a row added or repriced
inside the window makes two lines answer different questions. Concretely: the three lines above are
comparable in tokens and **not** comparable in dollars, because what changed between them was the
`attrib_*` fields and pricing. Discarding the whole line would have thrown away the figure that was
fine — the same mistake #1252 had to undo in `spec-durations.json`. So: a token rate needs five
consecutive lines of one **shape**; a dollar rate additionally needs a window with no pricing edit,
which this file cannot verify, which is why `--prices-stable` is an explicit claim the reader makes
after checking that no PR touched the price table in the window.

**Rule 3 — five consecutive lines, and a line that measured nothing is not one of them.** A line
that recorded no LLM call carries no rate and is excluded from the mean rather than counted as a
zero (a zero drags a derived figure exactly the way an unmeasured file's 0 s dragged the duration
table). A line whose models are partly unpriced has FLOOR dollars and is excluded from the dollar
mean only, keeping its token rate. The window is the **trailing** run of one shape: an older stable
stretch is history, and the question is whether today's series can be read.

Two things that restart the window and one that does not. A change to **what is measured** (how
totals are summed, which traces are captured) or to **pricing** restarts it. An **additive field**
does not: #1300's `by_provider` is derived from spans this file already recorded and moves no
existing figure. Note that `tokens:trend` can only see shape changes the schema exposes
(`attrib_*`, `by_provider`) — a pricing edit is invisible to it, which is exactly what Rule 2's
explicit claim covers.

Finally, one consequence of the young series is easy to mistake for a working detector:
`scripts/lib/token-anomaly.mjs` returns **no anomaly at all** while fewer than `minBaseline` (5)
lines are available, and windows to the last 20. With three lines on file, every run so far has
recorded `anomalies: []` **by construction** — that is not evidence the baseline is behaving. The
fifth consecutive line under one instrument is both the first honest read of the trend and the
first run the detector can act on.

### Known gaps

The series is **not continuous**. Document any missing weeks here rather than back-filling entries by hand (which would violate the machine-written invariant above, and is unrecoverable anyway — `results.json` is not retained as an artifact).

| Missing weeks | Cause | Resolution |
|---|---|---|
| 2026-06-01, 2026-06-08, 2026-06-15 | The "Commit weekly history" step failed with `fatal: not in a git directory` — git refused the root-owned-vs-host-uid workspace inside the container, and the `safe.directory` that `actions/checkout` set under a temporary HOME was gone by commit time. The "Append weekly history" step succeeded, so the file was written in-job but never committed back to `main`. | Fixed forward in #385 (re-declare `safe.directory` in the commit step). The runs themselves are recoverable from GitHub Actions run history, but their per-test `results.json` is not, so these weeks stay absent from the JSONL. |

---

## Schema (version 1)

```jsonc
{
  "version": 1,                              // schema version — bump on breaking changes
  "date": "2026-05-11",                      // YYYY-MM-DD (UTC) when the run started
  "workflow": "weekly-stable",               // workflow id; future: "nightly", "manual-...", etc.
  "run_id": "25663131100",                   // GitHub Actions run id
  "run_url": "https://github.com/.../runs/25663131100",
  "langflow_image": "langflowai/langflow-nightly:latest",
  "duration_ms": 768000,                     // Playwright stats.duration
  "totals": {
    "passed": 66,
    "failed": 2,                             // hard failures (after all retries)
    "flaky": 3,                              // failed at least once, passed on a retry
    "skipped": 2                             // includes Playwright "did not run" (mode: serial cascade)
  },
  "failures": [
    {
      "test": "...",                         // full test() title
      "file": "tests/.../foo.spec.ts",       // relative path from repo root
      "line": 369,                           // test() declaration line
      "tags": ["@stable", "@regression"],    // tags at the moment of the run
      "attempts": 3,                         // total result entries (initial + retries)
      "error_signature": "...",              // first line of the last failed-result error
      "infra_signature": null,               // infra-signature id, or null — see below (#1310)
      "param": "google / gemini-2.5-flash"   // OPTIONAL: parameterization label from
                                             // the describe title, when the spec is
                                             // model-parameterized (#899). Omitted otherwise.
    }
  ],
  "flaky": [
    {
      "test": "...",
      "file": "...",
      "line": 78,
      "tags": [...],
      "attempts": 2,                         // result entries; >1 means at least one retry happened
      "error_signature": "...",              // first line of the FIRST failed attempt (before the passing retry)
      "infra_signature": null                // infra-signature id, or null — see below (#1310)
    }
  ],
  "run_errors": [                            // OPTIONAL: top-level report errors — see below.
    "Error: [preflight] Langflow backend at http://localhost:7860/ is not reachable after 120000ms"
  ]
}
```

### Field semantics

- `tags` reflects the **state at the moment of the run**, not the current state in the repo. A test that was `@stable` at run time and has since had `@stable` removed will still show `@stable` in its historical entries.
- `error_signature` is the first non-empty line of a failed result's error message, truncated to 240 chars. Stack frames and locator details are stripped — enough to cluster recurring failures, not enough to debug from history alone. For `failures[]` it is taken from the **last** failed result (the one that made the test fail for good); for `flaky[]` it is taken from the **first** failed attempt (the one that triggered the retry that later passed). Falls back to `"unknown"` when no message is available.
- `infra_signature` (additive to schema v1, #1310) is the id of the infra-signature the entry's error matched — `api-request-timeout`, `preflight-unreachable`, `connection-refused`, `connection-dropped`, `host-unresolvable` (`scripts/lib/infra-signature-patterns.json`) — or `null`. It answers one question: *was this the harness failing to reach the backend, rather than the spec failing?* A non-null value means the failure is **not attributable to the spec that reported it** — wedge collateral (#1030/#1031). `null` means "could be the spec's own", never "definitely is": the pattern list is deliberately narrow and excludes every signature a real regression also produces (`locator.click: Timeout`, `page.waitForSelector: Timeout`, `expect(...).toBeVisible()`).
  - **It is classified here, at write time, not by whoever reads this file.** The classifier matches anywhere in the error message, while `error_signature` is line 1 only — and a wedge routinely surfaces as an assertion whose *cause* line carries the transport error (the `#751` credential guard being the usual wrapper in this suite). Both shapes occurred in run `30997773754`: `agent-context-id-isolation.spec.ts:512` had the transport error on line 1, `agent-context-id-continuity.spec.ts:405` had it three lines down. Only the second needs the full text, and only this script still has it.
  - Taken from the **same** result the entry's `error_signature` came from: the last failed attempt for `failures[]` (matching the exemption's "last error" wording and `scripts/remove-stable-from-failures.ts`), the first failed attempt for `flaky[]`.
  - **Rows written before #1310 omit the field entirely, and absent is not `null`.** The triage dataset falls back to classifying the stored `error_signature` for those and labels the result `error-signature-fallback`, because that answer is weaker; a row that carries the field is trusted as-is rather than re-derived downwards.
  - Consumers: `@stable` auto-removal already decided this independently from the full report (#1031) and does not read this field; the triage dataset uses it to keep a wedge-collateral **flake** from being filed and quarantined as if the spec were at fault.
- `failures` are tests where Playwright's final `test.status === "unexpected"`. `flaky` are tests where final status is `"flaky"` (failed and then passed on retry). Both carry `error_signature`, so the 30-day same-signature flake-recurrence criterion in `CONTRIBUTING.md` applies mechanically to either array.
- **A run where `totals` are ALL ZERO means no test executed at all** — an infra abort, *not* a clean day. The shards died before the first test (a failed `globalSetup`, a merge that produced nothing), so the line carries no per-test evidence and nothing in it should be read as a per-test signal. Distinguish it from "nothing failed", which always has `passed > 0`. `duration_ms` is a useful corroborating hint: an aborted run is far shorter than a real one (7.6 min vs the usual 14–22 on the daily). First occurrence: `run_id` `30351107916` (2026-07-28) — see #1007 for the incident and #1012 for the guard that now fails such a run loudly.
- `run_errors` (optional, additive to schema v1) carries the **top-level** report errors — `globalSetup` / worker-level failures that stopped tests from running, as opposed to a test failing. Same normalisation as `error_signature` (first non-empty line, capped at 240 chars). One entry per shard that aborted, so a 4-shard daily aborting everywhere yields 4 near-identical signatures. **Omitted entirely when there are none**, which is the normal case — so its presence is itself the signal that something happened outside the tests. Absent from history written before #1012.
- `param` (optional, additive to schema v1) is the parameterization label a model-parameterized spec carries on its `describe` title — e.g. `"google / gemini-2.5-flash"` or `"model:gpt-4o-mini"`. The triage dataset builder uses it to group failures by provider variant and surface **provider-wide** clusters (same provider failing across ≥2 spec files → likely an environment/package cause, not per-test rot; #899). Absent for non-parameterized specs and for history written before #899.

---

## Example queries

Run from the repo root. Requires `jq`.

```bash
# Which @stable tests failed in the last 4 weeks?
tail -n 4 reports/weekly-history.jsonl \
  | jq -r '.failures[] | select(.tags | index("@stable")) | "\(.file):\(.line)  \(.test)"'

# Frequency of failure per test (all-time)
jq -r '.failures[].test' reports/weekly-history.jsonl | sort | uniq -c | sort -rn

# Recurrent flakes: the SAME (test, error_signature) seen 2+ times.
# This is the monitoring rule (CONTRIBUTING.md): recurrence is same cause within a
# 30-day window — grouping by signature, not by raw test-name count. Pipe through a
# 30-day date filter first when you only care about the window.
jq -r '.flaky[] | "\(.test) :: \(.error_signature // "flaky")"' reports/daily-history.jsonl \
  | sort | uniq -c | awk '$1 >= 2'

# Did a Langflow image upgrade correlate with new failures?
jq -r '"\(.date)  \(.langflow_image)  failed=\(.totals.failed)"' reports/weekly-history.jsonl

# Runs that executed NO test at all (infra aborts) — exclude these before any
# per-test aggregation, or they read as days when nothing failed.
jq -r 'select([.totals[]] | add == 0)
       | "\(.date)  run=\(.run_id)  \(.duration_ms/1000 | floor)s  \(.run_errors[0] // "no recorded reason")"' \
  reports/daily-history.jsonl

# Pull the full error_signature for a specific test, across history.
# `. as $row` keeps the parent object reachable while iterating `.failures[]`,
# so we can join the per-failure record with the run-level `.date`.
jq -r --arg t "Webhook component — flow is saved to database and contains the Webhook node" \
  '. as $row | .failures[] | select(.test == $t) | "\($row.date)  \(.error_signature)"' \
  reports/weekly-history.jsonl
```

---

## Expansion criteria

Add a new source (e.g. `nightly-history.jsonl`) when **all** of the following hold:

1. The source runs on a fixed cadence (cron) or a well-defined trigger (release).
2. Its failures have a different lifecycle from the existing sources — i.e. you would not act on them the same way. (Example: nightly catches transient Langflow main-branch breakage that does not warrant `@stable` removal; weekly catches sustained breakage that does.)
3. You can answer at least one question with the new source that the existing files cannot answer with reasonable effort.

If a source fails (1) or (2), prefer appending to an existing file with a discriminator field (e.g. `"workflow": "nightly"`) over creating a new file.

---

## Schema evolution

- **Backwards-compatible additions** (new optional fields): no version bump. Document the addition in this README and ship.
- **Breaking changes** (removing or renaming a field, changing semantics of an existing field): bump `version` and update `scripts/append-weekly-history.mjs`. Existing lines stay untouched — readers that care about old versions branch on the `version` field.

---

## Questions this history can / cannot answer

The schema (v1) is **failure-centric** by design: each entry names the tests that failed or flaked, plus aggregate counts. It does **not** list the names of tests that passed. This shapes what kinds of questions you can answer cheaply.

### Answers directly (cheap `jq` queries)

| Question | How |
|---|---|
| Which `@stable` tests failed in the last N weekly runs? | `tail -n N` + filter on `.failures[]` |
| Which tests have been flaky in 2+ runs? | `jq` on `.flaky[].test` + `uniq -c` |
| Did a Langflow image upgrade correlate with a spike in failures? | Cross `.langflow_image` with `.totals.failed` over time |
| What is the error signature trend for test X? | `--arg t` filter on `.failures[]` joined with `.date` via `. as $row` |
| Was run N entirely clean? | `.totals.failed == 0 and .totals.flaky == 0` |
| How long does a typical weekly take, and is the trend up or down? | `.date` vs `.duration_ms` |

### Answers indirectly (requires cross-referencing)

| Question | What's missing | Workaround |
|---|---|---|
| Has test X passed in 100% of recent weeklies? | Pass list is not recorded — only counts. | "Test X never appeared in `.failures[]` or `.flaky[]` for the last N runs" **and** you verify (via git log on the spec file) that X carried `@stable` throughout those N runs. Brittle when tests enter/exit `@stable` mid-window. |
| Is test X currently part of the weekly scope? | Tags reflect run-time state, not current state. | Read the current spec file — `tags` in old entries can disagree with today's tags. |
| How many `@stable` tests existed in run N? | Only the count of `passed/failed/flaky/skipped` totals is stored — not the nominal list. | Sum `totals.*` for a run-level count; check `Phase 0 — Validated` in `QA-CHECKLIST.md` at the matching commit for a name-level breakdown. |

### Cannot answer with the current schema

The following require either a future v2 schema or a separate data source:

- **"Is this test *actually* stable?"** — without a recorded pass list, you can only say "it never appeared as a failure in the captured window." That is necessary but not sufficient: the test may have been removed from `@stable`, renamed, or skipped silently. A v2 schema with `passed_tests: []` (names + file:line) is the cheapest fix; it would grow each line from ~2 KB to ~10–15 KB but make "stability rate per test" a one-line `jq` query.
- **Per-test duration trends.** `totals.duration_ms` is run-level only. Detecting "test X used to take 8 s and now takes 35 s" requires storing per-test `duration_ms` (also a v2 addition).
- **Diff between the @stable set in run A and run B.** No nominal list of which tests ran exists.
- **Who fixed what, and when a flake stopped flaking.** That information lives in PRs and the spec docs — the history file is intentionally not the source of truth for *resolution*, only for *occurrence*.

If a recurring need for one of these answers emerges, **do not patch the schema reactively** — evaluate whether v2 (adding `passed_tests` / per-test duration) makes sense or whether the question is better answered by a derived script that reads the JSONL plus the current repo state. See `Schema evolution` above for the bump rules.

---

## What this history is NOT

- **Not a replacement for Playwright HTML reports.** Stack traces, screenshots, and videos still live in the run artifacts (retention 14 days). The JSONL holds only what is durable and aggregatable.
- **Not a substitute for issues.** Recurring failures are still tracked in GitHub issues (`weekly-failure` label). The history makes recurrence visible; the issue carries the investigation and the fix.
- **Not a flake-mitigation tool.** Adding a row does not auto-remove `@stable`. See `CONTRIBUTING.md` for the triage rules driven by this history.
- **Not a dashboard.** No charts, no alerting. If you want trend lines or thresholds, build them on top of the JSONL — the file is the contract, not the presentation.

