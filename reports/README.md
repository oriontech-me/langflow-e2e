# Run history reports

Append-only history of CI runs, kept in the repo so that longitudinal questions ("how many weeks did this test fail in a row?", "what's the flake rate of test X?") can be answered without paying GitHub Actions artifact retention or paying for an external dashboard.

Files in this directory are **machine-written and human-read only**. Do not hand-edit entries — fix forward by appending corrections in a new run.

---

## Files

| File | Source | Cadence |
|---|---|---|
| `daily-history.jsonl` | `.github/workflows/daily-stable.yml` → `scripts/append-weekly-history.mjs` (via `HISTORY_FILE` override) | One line per scheduled run (daily 08:00 UTC). Manual dispatches do **not** write to this file — the series is intentionally restricted to the cron cadence so longitudinal queries have predictable spacing (one entry per day, same image tag, same trigger). **Active source.** |
| `weekly-history.jsonl` | `.github/workflows/weekly-stable.yml` → `scripts/append-weekly-history.mjs` | One line per scheduled run (Mondays 06:00 UTC), from the now-disabled weekly workflow — **frozen**. Manual dispatches do **not** write to this file — the series is intentionally restricted to the cron cadence so longitudinal queries have predictable spacing (one entry per week, same image tag, same trigger). |
| `token-history.jsonl` | `scripts/watch-tokens.mjs --summarize` (issue #1197) | One line per run of a lane that ran the token poller. Schema version 1; additive optional fields do not bump the version. `totals.usd_estimated` and every `by_model[].usd_estimated` / `by_spec[].usd_estimated` cover **priced models only** — a non-empty `unpriced_models` means every dollar figure in that line is a FLOOR, not a total. **No line is written for a run with zero traces or zero tests** — that absence is deliberate: a zero would enter the anomaly baseline (`scripts/lib/token-anomaly.mjs`) and lower the bar for every later run, the same reasoning `daily-history.jsonl` applies to a zero-test infra abort. Machine-written by the summarizer; never hand-edited. |

Each line is one [JSON object](#schema-version-1) terminated by `\n`. The file is JSONL (newline-delimited JSON), not a JSON array — append-only, diff-friendly.

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
      "error_signature": "..."               // first line of the FIRST failed attempt (before the passing retry)
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

