# Run history reports

Append-only history of CI runs, kept in the repo so that longitudinal questions ("how many weeks did this test fail in a row?", "what's the flake rate of test X?") can be answered without paying GitHub Actions artifact retention or paying for an external dashboard.

Files in this directory are **machine-written and human-read only**. Do not hand-edit entries — fix forward by appending corrections in a new run.

---

## Files

| File | Source | Cadence |
|---|---|---|
| `weekly-history.jsonl` | `.github/workflows/weekly-stable.yml` → `scripts/append-weekly-history.mjs` | One line per scheduled run (Mondays 06:00 UTC). Manual dispatches do **not** write to this file — the series is intentionally restricted to the cron cadence so longitudinal queries have predictable spacing (one entry per week, same image tag, same trigger). |

Each line is one [JSON object](#schema-version-1) terminated by `\n`. The file is JSONL (newline-delimited JSON), not a JSON array — append-only, diff-friendly.

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
      "error_signature": "..."               // first line of the last failed-result error
    }
  ],
  "flaky": [
    {
      "test": "...",
      "file": "...",
      "line": 78,
      "tags": [...],
      "attempts": 2                          // result entries; >1 means at least one retry happened
    }
  ]
}
```

### Field semantics

- `tags` reflects the **state at the moment of the run**, not the current state in the repo. A test that was `@stable` at run time and has since had `@stable` removed will still show `@stable` in its historical entries.
- `error_signature` is the first non-empty line of the last failed result's error message, truncated to 240 chars. Stack frames and locator details are stripped — enough to cluster recurring failures, not enough to debug from history alone.
- `failures` are tests where Playwright's final `test.status === "unexpected"`. `flaky` are tests where final status is `"flaky"` (failed and then passed on retry).

---

## Example queries

Run from the repo root. Requires `jq`.

```bash
# Which @stable tests failed in the last 4 weeks?
tail -n 4 reports/weekly-history.jsonl \
  | jq -r '.failures[] | select(.tags | index("@stable")) | "\(.file):\(.line)  \(.test)"'

# Frequency of failure per test (all-time)
jq -r '.failures[].test' reports/weekly-history.jsonl | sort | uniq -c | sort -rn

# Tests that were flaky in 2+ runs (candidate for @stable removal under the monitoring rule)
jq -r '.flaky[].test' reports/weekly-history.jsonl | sort | uniq -c | awk '$1 >= 2'

# Did a Langflow image upgrade correlate with new failures?
jq -r '"\(.date)  \(.langflow_image)  failed=\(.totals.failed)"' reports/weekly-history.jsonl

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

## What this history is NOT

- **Not a replacement for Playwright HTML reports.** Stack traces, screenshots, and videos still live in the run artifacts (retention 14 days). The JSONL holds only what is durable and aggregatable.
- **Not a substitute for issues.** Recurring failures are still tracked in GitHub issues (`weekly-failure` label). The history makes recurrence visible; the issue carries the investigation and the fix.
- **Not a flake-mitigation tool.** Adding a row does not auto-remove `@stable`. See `CONTRIBUTING.md` for the triage rules driven by this history.
