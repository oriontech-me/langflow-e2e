# `PATCH /api/v1/flows/{id}` answers `500 database is locked` under concurrent writes — moving a flow between folders fails in the UI

| | |
|---|---|
| **Filed upstream** | **[LE-2020](https://datastax.jira.com/browse/LE-2020)** — the SAME ticket as the `DELETE /projects` case; the fix is expected to land there. This document records the second affected endpoint, it does not ask for a new ticket |
| **Tracked in** | `oriontech-me/langflow-e2e#932` (daily-failure, spun out of triage #930) |
| **Component** | Langflow — backend, flows API + database layer (SQLite) |
| **Surfaces** | `PATCH /api/v1/flows/{id}` returns `500`; in the UI, dragging a flow onto another project fails with a `Failed to save flow` notification carrying the raw SQLAlchemy error |
| **Observed on** | `langflowai/langflow-nightly:latest` — `1.12.0.dev8` |
| **Determinism** | Deterministic **given** concurrent writes; invisible without them (0/30 serial) |
| **Captured** | 2026-07-29, local Docker, `LANGFLOW_AUTO_LOGIN=true`, `LANGFLOW_WORKERS=1`, default SQLite |
| **Related** | LE-2020's own report covers `DELETE /api/v1/projects/{id}` and states that sibling write endpoints survive the identical contention. `PATCH /flows` does **not** — that claim is the one fact in the ticket this document contradicts. Not tracked as a separate regression in `REGRESSIONS.md`: same root cause, same ticket, one Ledger row per ticket |
| **Prior art in this repo** | The `500` under contention was already measured during #965's investigation (7/20 at P=2, 27/32 at P=4) and then **wrongly ruled out** as #932's cause, on the belief that #932 was a `200` followed by a stale association. The daily artifact disproves that belief — see §6 |

---

## 1. Summary

With any other write in flight, `PATCH /api/v1/flows/{id}` fails instead of moving
the flow:

```
500 (sqlite3.OperationalError) database is locked
[SQL: UPDATE flow SET updated_at=?, folder_id=? WHERE flow.id = ?]
```

The failure is **not silent** — the UI raises a notification and the flow stays in
its original project, so no data is lost or misplaced. What is wrong is that a
routine single-record update fails at all under mild contention, and that the
message shown to the end user is a raw database error.

---

## 2. Steps to reproduce (API)

1. Create two projects and a flow in the first one.
2. Issue `PATCH /api/v1/flows/{flow_id}` with `{"folder_id": "<second project>"}`
   from **two or more** clients concurrently.
3. Observe `500` with the message above.

Measured rate, 24 iterations per level, each iteration creating its own projects
and flow so no two clients touch the same row:

| Concurrent clients | Failures |
|---|---|
| 1 | **0 / 30** |
| 2 | 14 / 24 |
| 3 | 18 / 24 |
| 4 | 20 / 24 |

Two clients are enough. The failing statement is always the `UPDATE flow`.

## 2.1 Steps to reproduce (UI — the user-facing path)

1. Create projects `SRC` and `DST`; put a flow in `SRC`.
2. Generate background write load (4 clients renaming their own flows in a loop).
3. In the UI, drag the flow card from `SRC` onto `DST` in the project sidebar.

Observed:

| Signal | Result |
|---|---|
| Browser console | `500 Internal Server Error` on `PATCH /api/v1/flows/{id}`, ×2 |
| Flow's project after the drag | **unchanged** — still `SRC` |
| Notification centre | **`Failed to save flow`**, body = the verbatim SQLAlchemy error including the SQL statement, the bound parameters and a timestamp |

Without the background load the same drag succeeds every time, so the drag
mechanism itself is fine.

---

## 3. Why this is not simply "SQLite is single-writer"

The instance runs with Langflow's own defaults, which are already tuned for this:

```python
sqlite_pragmas = {"synchronous": "NORMAL", "journal_mode": "WAL", "busy_timeout": 30000}
db_connect_timeout = 30
```

`journal_mode=wal` is confirmed active on the running database file. With a 30 s
`busy_timeout`, a writer that merely has to *wait* should wait, not fail — and yet
the `500` comes back in ~60 ms, three orders of magnitude before that budget.

That is the signature of the one case `busy_timeout` deliberately does **not**
cover: a transaction that reads first and then upgrades to a write while another
transaction holds the write lock. SQLite returns `SQLITE_BUSY` immediately there,
because retrying would deadlock. The usual remedies are to open write paths with
`BEGIN IMMEDIATE`, or to retry the transaction at the application layer.

**Suggestive asymmetry, not yet explained:** the four background writers, each
repeatedly `PATCH`ing its *own* flow, completed **~5178 requests with zero
non-200**, while the single newcomer `PATCH` failed. Whatever the mechanism, the
request that arrives during an established write burst is the one that loses.

**Not established:** the exact transaction boundary in the flows-update path, and
whether Postgres deployments are affected (untested — the reproduction is
SQLite-only).

---

## 4. Expected behaviour

`PATCH /api/v1/flows/{id}` either applies the update or waits for the lock within
the configured `busy_timeout`. A `500` for a single-row update under two
concurrent clients is not an acceptable contract, and an end user should never be
shown a SQL statement with bound parameters.

---

## 5. Impact

- **A routine action fails.** Moving a flow between projects is a normal
  organisational gesture; it breaks whenever anything else is writing.
- **The error is unactionable for the user.** "database is locked" plus a SQL
  statement tells the person dragging a card nothing they can act on.
- **Internal detail leaks to the UI** — statement text, bound parameter values,
  server timestamps.
- **It costs CI time elsewhere.** This is what the `api-folders-crud` folder-move
  test has been catching intermittently on the daily (2026-07-15, 2026-07-24),
  where it reads as a flaky test rather than a product defect.

Severity assessed **Medium**: user-visible and reproducible at low concurrency,
but reported rather than silent, with no data loss and a consistent end state —
milder than the `DELETE /projects` manifestation tracked under the same ticket,
which **silently no-ops**. Fixing the shared root cause fixes both.

---

## 6. Notes for triage

- **The failing assertion, verbatim from the daily artifact** (`playwright-json-daily-30085452003`,
  run 30085452003, 2026-07-24):

  ```
  Error: expect(received).toBe(expected)   Expected: 200   Received: 500

  > 160 |       expect(patchRes.status()).toBe(200);
  ```

  The mismatch is the **HTTP status**, not the `folder_id`. Playwright's
  `Object.is equality` wording reads like an association mismatch, and that
  misreading sent both #932's stated hypotheses and an earlier in-repo analysis
  down the wrong path — the latter had already measured this exact `500` and
  discarded it as unrelated. Read the artifact before re-deriving a cause from
  the symptom wording.
- Not reproducible serially. Any investigation that runs the sequence once, by
  hand, will conclude the endpoint is fine.
- No version A/B was run here, so **do not quote a first-affected version**.
  LE-2020 established that its own endpoint regressed in rate (~7×) between
  1.10.3 and 1.12; whether this endpoint follows the same curve is untested.
