# `DELETE /api/v1/projects/{id}` returns 500 (`database is locked`) and leaves the project undeleted when any other write is in flight

| Field | Value |
|---|---|
| **Filed upstream** | [LE-2020](https://datastax.jira.com/browse/LE-2020) (filed 2026-07-28) |
| **Repo issue** | [oriontech-me/langflow-e2e#965](https://github.com/oriontech-me/langflow-e2e/issues/965) (spun out of daily triage #962) |
| **Affected builds** | `langflowai/langflow-nightly:latest` → `1.12.0.dev6` and `1.12.0.dev7`; reproduced at a lower rate on stable `langflowai/langflow:latest` → `1.10.3` |
| **Component** | `src/backend/base/langflow/api/v1/projects.py` → `delete_project` |
| **Database** | SQLite (the default for the Docker image), WAL enabled, `busy_timeout = 30000` |
| **Severity** | Medium. A documented `204` contract returns `500` and the delete does not happen. No data loss. In the UI a single retry usually hides it, but when the retry budget is exhausted the delete silently no-ops with no toast and no notification (§4.4). |
| **Discovered by** | Langflow E2E regression suite — `tests/tests-automations/regression/api/flows/api-folders-crud.spec.ts` (test: *DELETE removes folder and it no longer appears in listing*), recurrent on the dailies of 2026-07-22 and 2026-07-27 |

---

## 1. Summary

`DELETE /api/v1/projects/{project_id}` is declared as `status_code=204`. Whenever
another write transaction is in flight against the same SQLite database, the
endpoint instead answers **HTTP 500** with the raw SQLAlchemy error in `detail`,
and **the project is not deleted** — a follow-up `GET /api/v1/projects/` still
lists it.

Two properties make this more than "SQLite under load":

1. **Sibling write endpoints survive the identical contention.** With two
   concurrent clients, `POST /api/v1/projects/`, `POST /api/v1/flows/` and
   `DELETE /api/v1/flows/{id}` were 100 % successful while
   `DELETE /api/v1/projects/{id}` failed 11 of 24 times (§4.2).
2. **`busy_timeout` is configured but never engages.** The pragma is set to
   30 000 ms (`lfx/services/settings/groups/database.py:48`) and WAL is active
   (`langflow.db-wal` / `-shm` present), yet the failures return in **~0.03 s**
   (§4.1, §4.3). SQLite's busy handler is not invoked on this path, so the
   configured tolerance for lock contention has no effect.

---

## 2. Reproduction

No UI needed; two concurrent API clients are enough. Scripts used for every
number in this report are reproduced in Appendix E.

```bash
docker run -d --name lf-repro -p 7860:7860 \
  -e LANGFLOW_AUTO_LOGIN=true -e LANGFLOW_SUPERUSER=langflow \
  -e LANGFLOW_SUPERUSER_PASSWORD=langflow123 -e LANGFLOW_WORKERS=1 \
  langflowai/langflow-nightly:latest

TOK=$(curl -s localhost:7860/api/v1/auto_login | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# Two shells (or the script in Appendix E), each looping:
ID=$(curl -s -X POST localhost:7860/api/v1/projects/ -H "Authorization: Bearer $TOK" \
      -H 'Content-Type: application/json' -d '{"name":"repro-'$RANDOM'"}' \
      | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -w '\n%{http_code} %{time_total}\n' -X DELETE "localhost:7860/api/v1/projects/$ID" \
      -H "Authorization: Bearer $TOK"
```

**Serially the endpoint is healthy** — 10 create+delete cycles, 10 × `204`. The
failure requires a concurrent writer, which is why a browser with two open tabs,
any parallel API consumer, or a CI suite running tests in parallel hits it while
a manual click-through never does.

---

## 3. Expected vs actual

**Expected:** `204 No Content`, and the project gone from `GET /api/v1/projects/`.

**Actual:** `500` with the SQL statement echoed to the client, project still
present:

```json
{"detail":"(sqlite3.OperationalError) database is locked\n[SQL: DELETE FROM folder WHERE folder.id = ?]\n[parameters: ('0913fdcdc2bd4f68bfa26d8ed3f0fc83',)]\n(Background on this error at: https://sqlalche.me/e/20/e3q8)"}
```

Secondary problems visible in that payload:

- The raw SQL, table name and bound parameters are returned to the caller.
- A transient database condition is reported as `500` (non-retriable by
  convention) rather than a retriable status such as `503`, so well-behaved
  clients do not retry.

---

## 4. Measurements

All runs on one machine (Colima VM, 2 vCPU / 4 GiB), `LANGFLOW_WORKERS=1`, one
Langflow container under load at a time, orphaned projects purged between rounds
so database size stays comparable.

### 4.1 Rate versus concurrency — nightly `1.12.0.dev6`, seasoned database

| Concurrent clients | cycles | `204` | `500` | latency of a failure (min/avg/max) |
|---|---|---|---|---|
| 1 (serial) | 10 | 10 | **0** | — |
| 2 | 30 | 15 | **15** | 0.02 / 0.02 / 0.03 s |
| 4 | 60 | 31 | **29** | 0.02 / 0.03 / 0.04 s |
| 8 | 80 | 13 | **67** | 0.03 / 0.07 / 0.22 s |

### 4.2 Endpoint scope — same contention, `1.12.0.dev7`, 2 clients × 12 rounds

| Endpoint | Result |
|---|---|
| `POST /api/v1/projects/` | 24/24 → `201` |
| `POST /api/v1/flows/` | 24/24 → `201` |
| `DELETE /api/v1/flows/{id}` | 24/24 → `200` |
| `DELETE /api/v1/projects/{id}` | 13/24 → `204`, **11/24 → `500`** |

Only the project delete breaks. This is the strongest argument that the fix
belongs in the endpoint's transaction handling, not in the caller or the database
engine choice.

### 4.3 Version comparison — A/B/A/B, one arm at a time

3 alternations, 2 concurrent clients, 30 deletes per round, orphans purged
between rounds. Arms never ran simultaneously, so neither competed for CPU.

| Round | Build | `204` | `500` | other | median latency of a failure | wall clock |
|---|---|---|---|---|---|---|
| 1 | stable `1.10.3` | 23 | **1** | 6 | 6.37 s | 87.5 s |
| 1 | nightly `1.12.0.dev7` | 18 | **12** | 0 | 0.03 s | 0.8 s |
| 2 | stable `1.10.3` | 22 | **2** | 6 | 1.61 s | 150.4 s |
| 2 | nightly `1.12.0.dev7` | 15 | **15** | 0 | 0.03 s | 0.8 s |
| 3 | stable `1.10.3` | 21 | **2** | 7 | 1.80 s | 195.9 s |
| 3 | nightly `1.12.0.dev7` | 17 | **13** | 0 | 0.02 s | 0.7 s |
| **total** | stable `1.10.3` | 66/90 | **5 (6 %)** | 19 | 1.80 s | — |
| **total** | nightly `1.12.0.dev7` | 50/90 | **40 (44 %)** | 0 | 0.03 s | — |

An extra stable round with the full status breakdown, so the *other* column is
not read as success (see Appendix C for the raw output): of 30 attempts, 22 →
`204`, **4 → `500` in 0.02–0.04 s**, 3 deletes and 1 create had the connection
dropped by the server after 1.3–42 s.

**Interpretation.** The defect is **not new** — `1.10.3` emits the same instant
`500`. What changed in `1.12` is the rate (≈ 7×: 6 % → 44 %) and the dominant
failure mode: `1.10.3` mostly *blocks* and still honours the contract (rounds of
68–196 s, individual deletes waiting up to 42 s, some connections dropped);
`1.12` gives up in 0.03 s. Both are wrong; `1.12` breaks correctness where
`1.10.3` mostly paid latency.

### 4.4 What the UI does with the failure (the "is it user-facing?" test)

Driven through the real sidebar (row menu → *Delete* → confirm) on
`1.12.0.dev7`, with the same contention script running in the background. This
section exists because a *previous* SQLite-lock finding in this suite was
adversarially downgraded to non-user-facing on the grounds that a client-side
retry masks the 500 — that defence had to be tested here, not assumed.

**Light contention (2 background writers), 6 consecutive UI deletes:** 6/6
projects were deleted. In 2 of the 6 the client got a `500` and **immediately
re-issued the DELETE**, which returned `204`; the user saw only
*"Project deleted successfully."* So at this level the retry does mask the defect
— the earlier finding's defence holds.

**Heavier contention (4 background writers):** the retry budget is finite and can
be exhausted. Two hand-driven deletes:

| Attempt | DELETE calls issued by the client | Project afterwards | Toast | Notification centre |
|---|---|---|---|---|
| A | 3 × `500` | **still present** | none | *"No new notifications"* |
| B | 1 × `500` | **still present** | none | *"No new notifications"* |

The only trace is in the browser console
(`Failed to load resource: the server responded with a status of 500`). The user
clicks *Delete*, confirms, and **nothing happens and nothing is said** — the
project is still in the sidebar.

Also at that level, the project list itself frequently never finishes rendering
(5 of 8 scripted iterations had to be skipped because the row never appeared),
and one full automated pass could not complete within 10 minutes.

**Net:** at low concurrency the retry hides the defect; when the retry budget is
exhausted the deletion silently does not happen and the UI reports success-shaped
silence rather than an error. The user-facing part is the *silent* no-op, not the
`500` itself.

---

## 5. Code pointers (paths as installed in the image)

`langflow/api/v1/projects.py` → `delete_project`:

```python
async def _delete_project_operation() -> None:
    flows = (await session.exec(select(Flow).where(Flow.folder_id == project_id, ...))).all()
    ...
    await check_project_has_deployments(session, project_id=project_id)
    await session.delete(project)
    # Flush eagerly so guard/constraint errors surface in-request rather than at teardown commit.
    await session.flush()

try:
    await retry_project_operation_on_deployment_guard(
        db=session, user_id=project_owner_id, project_id=project_id,
        operation=_delete_project_operation,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
except Exception as e:
    await araise_if_deployment_guard_error_or_skip(...)
    raise HTTPException(status_code=500, detail=str(e)) from e
```

- The `except Exception` funnel maps **every** failure, including a transient
  `sqlite3.OperationalError`, to `500` with `str(e)` as the public detail.
- `retry_project_operation_on_deployment_guard`
  (`langflow/api/v1/mappers/deployments/sync.py`) retries **only**
  `DeploymentGuardError` — it re-raises anything else — and it runs the operation
  inside `async with db.begin_nested()`, i.e. a SAVEPOINT write issued while the
  same session has already read (the authorization fetch, the MCP cleanup, the
  flow enumeration and the deployment check all precede it).
- Suggested directions, in the order we would try them: retry the operation on
  `OperationalError`/`SQLITE_BUSY`; begin the write transaction as `IMMEDIATE` so
  the lock is taken before the reads; failing both, map the condition to `503`
  with a clean message instead of `500` with raw SQL.

---

## 6. What we did NOT verify (stated so the report is not over-read)

- **Why the rate differs between `1.10.3` and `1.12`.** `delete_project` and
  `services/database/service.py` are byte-identical between the two images, as
  are SQLAlchemy 2.0.51, aiosqlite 0.22.1, SQLite 3.46.1 and the pragma defaults.
  The only diffs on the path are `main.py` (+98 lines, mostly an audit-log
  cleanup worker whose cadence is daily and whose first pass waits a full
  interval — so it is *not* the competing writer) and
  `mappers/deployments/sync.py` (+73 lines, rowcount confirmation on stale
  deployment deletes). Neither explains the change. The rate difference is
  reproducible; its mechanism is unexplained.
- **PostgreSQL.** Not tested. The defect is expected to be SQLite-specific, but
  that is an inference, not a measurement. Note that SQLite is the image default,
  so the affected configuration is the out-of-the-box one.
- **A single-statement causal trace** (SQL echo / `EXPLAIN`-level proof of which
  concurrent statement holds the write lock at the moment of failure). The
  evidence here is black-box: status codes, latencies and the error payload.
- **A clean failure rate for the UI path.** §4.4 has hand-driven observations and
  one automated run at light contention; the heavier-contention loop could not be
  completed (the app degrades so much that a single pass exceeded 10 minutes).

---

## 7. Impact

- **Users on the default Docker/SQLite deployment**: with light concurrency the
  frontend's retry hides the failure and the delete goes through (§4.4). When the
  retry budget is exhausted the delete **silently does not happen**: no toast, no
  entry in the notification centre, the project still in the sidebar, and only a
  console error. A user who is not watching DevTools has no way to tell the
  operation failed.
- **API consumers**: a `500` on a valid `DELETE` is not retried by conventional
  clients, so the caller reports a hard failure for a transient condition.
- **CI / test suites**: any suite running in parallel against one instance sees
  this as flakiness. In ours it recurred on two dailies with an identical
  signature; teardown paths that ignored the status silently accumulated orphan
  projects on the instance.

---

## 8. Suggested acceptance for the fix

With two concurrent clients issuing create+delete cycles (Appendix E script,
`P=2`, 45 cycles): **0 responses other than `204`**, and `GET /api/v1/projects/`
listing none of the created ids afterwards. Our quarantined regression test is
restored to `@stable` on exactly that evidence.

---

## Appendix A — failing daily signature (repo issue #965)

```
tests/tests-automations/regression/api/flows/api-folders-crud.spec.ts:82
  "DELETE removes folder and it no longer appears in listing"
  Error: expect(received).toBe(expected) // Object.is equality
  Expected: 204
  Received: 500
```

Recurrent with the same `error_signature` on the dailies of 2026-07-22 and
2026-07-27 (`langflowai/langflow-nightly:latest`), recovered on retry both times.

## Appendix B — burst output, nightly `1.12.0.dev6`, 8 clients (excerpt)

```
w5 i12 DELETE=500 id=0913fdcd-c2bd-4f68-bfa2-6d8ed3f0fc83 body={"detail":"(sqlite3.OperationalError) database is locked\n[SQL: DELETE FROM folder WHERE folder.id = ?]\n[parameters: ('0913fdcdc2bd4f68bfa26d8ed3f0fc83',)]\n(Background on this error at: https://sqlalche.me/e/20/e3q8)"}
w6 i12 DELETE=500 id=cd0a83b8-91fb-4693-84b3-9851e13742d1 body={"detail":"(sqlite3.OperationalError) database is locked ...
w4 i12 DELETE=500 id=166b3f90-6aed-4984-a648-12ac23600bc1 body={"detail":"(sqlite3.OperationalError) database is locked ...
...
total=80 ok204=13 failed=67
ok   time_total  min/avg/max: 0.01 / 0.03 / 0.09 s
fail time_total  min/avg/max: 0.03 / 0.07 / 0.22 s
failure codes: {'500': 67}
```

After that burst, 101 of the created projects were still listed by
`GET /api/v1/projects/` and had to be deleted serially (all 101 then returned
`204`) — direct evidence that the failed deletes did not happen.

## Appendix C — stable `1.10.3`, full status breakdown for one P=2 round

```
stable-1.10.3 P=2 N=15 wall=68s
  create-0    n=  1  min= 1.95s  max= 1.95s     <- connection dropped by the server
  delete-0    n=  3  min= 1.29s  max=42.23s     <- connection dropped by the server
  delete-204  n= 22  min= 0.02s  max= 2.00s
  delete-500  n=  4  min= 0.02s  max= 0.04s     <- same instant 500
  purged=7
```

## Appendix D — related but distinct: `PATCH /api/v1/flows/{id}` under the same contention

| Concurrency | `PATCH` 200 | `PATCH` 500 | of the 200s, association persisted |
|---|---|---|---|
| 2 clients × 10 rounds | 13 | **7** | 13/13 |
| 4 clients × 8 rounds | 5 | **27** | 5/5 |

So the flow-move endpoint suffers the same contention-as-500 family, but it never
returned a `200` with a stale association. (Recorded here because our repo issue
#932 tracks that stale-association symptom separately; the data says the two are
different root causes.)

## Appendix E — scripts

Committed next to this report under `docs/upstream-bugs/scripts/`. Each is
self-contained (bash + curl, or Python stdlib only), takes the concurrency and
cycle count as arguments, and purges what it creates:

| Script | Produces | Invocation used here |
|---|---|---|
| `scout-965-timed.sh` | §4.1 — status + `time_total` per delete, min/avg/max split by outcome | `./scout-965-timed.sh 2 15 out.csv` (and `4 15`, `8 10`) |
| `scout-965-scope.py` | §4.2 — the endpoint-scope matrix | `python3 scout-965-scope.py 2 12` |
| `ab-965.py` | §4.3 — the A/B/A/B harness, purging orphans between rounds | `python3 ab-965.py 3 2 15` |
| `scout-932-probe.py` | Appendix D — the `PATCH folder_id` persistence probe | `BASE=http://localhost:7862 python3 scout-932-probe.py 2 10` |
| `saboteur.sh` + `ui-delete-loop.sh` | §4.4 — background write pressure, then real UI deletes classified by what the user perceives | `./saboteur.sh 2 &` then `./ui-delete-loop.sh 6` |

`scout-965-timed.sh` honours `BASE` (default `http://localhost:7860`);
`ab-965.py` has the two arms hardcoded to `:7861` (stable) and `:7862` (nightly),
matching the two containers described in §4.
