# Instance migration — backup, copies, *Check the copy*, start and the migration record

**File:** `tests/tests-automations/regression/instance-migration/instance-migration-copy.spec.ts`

**Last validated:** Langflow 1.14.0.dev14 (`langflowai/langflow-nightly:latest` plus the `pgvector` package, `package: "Langflow Nightly"`), on the `@instance-migration` lane. Every fact below was measured that day over the API and on the page, unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

---

## What this test validates *(required)*

The copy is the point of instance migration (*Settings > Migration*): back up → copy the database → copy the knowledge bases → copy the files → *Check the copy* → start the new instance. A copy that reports success while leaving data behind is the worst failure the feature can have. This spec walks the second half of a migration on the lane's seeded SQLite source and asserts what each step leaves in the **destinations themselves** — the PostgreSQL database, its pgvector tables and the S3 bucket — not only what the page says about them.

Five tests, one per question:

1. **Backup.** *Download the database* hands out a real SQLite copy of this instance, and *I've backed up everything* is refused until that download has happened and refused without a location. The confirmation is recorded.
2. **Database copy, stopped and repeated.** A copy stopped mid-way keeps nothing and runs again **without** a new database. A copy repeated into the database it filled, in the same pause, duplicates nothing.
3. **The out-of-date copy (#15814).** Once changes were turned back on and a row was deleted, the page says *before* the copy that it needs a new, empty database, and copying into the old one fails without touching it.
4. **Knowledge bases and files.** A test run reports what it would copy and writes nothing — the pgvector tables and the bucket stay empty. The real copies land the vectors in pgvector and both the uploaded file and the chat attachment in the bucket. A knowledge base the copy cannot read is **left behind and reported** (#15777), not skipped in silence.
5. ***Check the copy*, start and record.** A clean copy reads as matching. A row deleted from the PostgreSQL copy is **named** — the force-fail that proves the check checks. The start step shows the new instance's settings with no password or key, *The new instance is running* closes the move, and the downloaded migration record holds the steps and decisions and none of the planted secrets.

### What the measurements changed in the issue's plan

Three statements of #2353 did not survive measurement. Each test asserts what was measured instead.

- **"A second copy into the now non-empty database is refused before it starts."** It is not. Within one pause, *Copy again* into the database the first copy filled runs to `done` with the same counts (63 tables, 56 rows) and no duplicate rows. #15814 is about a **different** sequence: changes turned back on, a row deleted on this instance, changes paused again. Then the copy step says *"To copy the database again, save a new, empty database in 'Where your data goes' first."* before anything runs, and *Copy again* into the old database ends `count_mismatch` (*"flow: source has 29 rows, target has 30 after copy"*), rolled back. The server does not refuse it before it starts — the run starts and fails inside its transaction. Test 2 pins the first sequence, test 3 the second.
- **"Delete one row from the PostgreSQL copy, and the check must name the difference."** Only for some rows. *Check the copy* runs the eight integrity checks of the first step on the copy and compares their summaries: `schema`, `credentials`, `files`, `knowledge base storage`, `knowledge bases`, `vector counts`, `memory bases`, `authorization`. None of them counts flows. Measured: a **flow** row deleted from the copy reads *"Everything matches."* and unlocks the start step. A **credential** row deleted from the copy is named (`credentials`: *"6 encrypted values…"* here, *"5 encrypted values…"* there) and blocks the start. Test 5 forces the fail with a credential, which is what the check covers. The flow gap is a finding — see *What this does not cover*.
- **MinIO.** The bucket is SeaweedFS (the lane's decision, #2347).

---

## Tags *(required)*

`@instance-migration` `@settings` `@database` `@files`

- `@instance-migration` — lane selector (cross-cutting). It needs the lane's three containers and runs only under `PW_INSTANCE_MIGRATION=1`, serially.
- `@database` — cross-cutting: the spec asserts persistent state in two databases.
- `@settings`, `@files` — functional: *Settings > Migration*, and the files copy.

**No `@stable`.** No scheduled lane runs `@instance-migration`, so the tag would mark a test that never runs (#1010).

---

## Precondition *(required)*

- The lane is up: `./scripts/start-langflow-instance-migration.sh` (source on `127.0.0.1:7895`, PostgreSQL + pgvector on `55895`, SeaweedFS on `58895`), seeded with one flow, one uploaded file and one knowledge base with 3 unit vectors.
- `PW_INSTANCE_MIGRATION=1` and `PLAYWRIGHT_BASE_URL=http://127.0.0.1:7895/`.
- **Each test starts and ends with `resetInstanceMigration()`**: no record, no pause, an empty target database with `vector`, an empty bucket. What a test adds to the **source** is its own to remove (the reset leaves the source alone on purpose — a migration never writes to it).
- No provider key and no model.

### Getting to a step through the API

The steps before the one under test are not this spec's subject (#2349–#2352 own them), so a test gets there through the API, the way upstream's own walk does (`src/frontend/tests/utils/migration-walk.ts` — the idea, not the code). Measured, in order:

| call | answer |
|---|---|
| `POST /api/v1/migration/checks` `{target_version}` | NDJSON stream, ~16–22 s; read it to the end |
| `POST /api/v1/migration/accepted-findings` `{name}` | only for a test that plants a finding (test 4) |
| `PUT /api/v1/migration/destinations` | database, vectors and files all `ok` |
| `POST /api/v1/migration/secret-key/verify` `{fingerprint}` | `200` with `e4a7b5ecdd4f` |
| `POST /api/v1/migration/pause` | `200`, then the pause step is `blocked: recheck_pending` |
| `POST /api/v1/migration/checks` again | the pause step is `done` |
| `POST /api/v1/migration/backup/database`, then `POST /steps/backup/confirm` `{location}` | test 1 does these on the page |
| `POST /steps/{step}/runs` `{dry_run}` → `GET /steps/{step}/runs/{run_id}/events` | `202` + `run_id`; NDJSON that ends with `{"event": "end", "status": …}` |

A copy run is a `python -m langflow` child: ~10–12 s pass before its first event, the database copy then takes ~8 s.

### Reading the destinations from the test host

- **PostgreSQL** — `docker exec langflow-instance-migration-pg psql -tAc …`, through the lane helper. No client library is added.
- **The bucket** — SeaweedFS answers an **unsigned** `GET http://127.0.0.1:58895/langflow-migration?list-type=2` with the ListObjectsV2 XML (measured), so the test reads keys and sizes with Playwright's own request context.
- **The source's row counts** — `docker exec langflow-instance-migration python` with `sqlite3` on the path `GET /api/v1/migration` reports (`instance.database.path`).

---

## Step by step *(required)*

Selectors are live testids and accessible names, scouted on dev14: each step is `migration-step-<step_id>`; a difference is `migration-difference-<check name>`; the start settings are `migration-start-settings`; the closing panel is `migration-complete`. A step that is `done` collapses to its title and a one-line summary; its title opens it again.

### Test 1 — the backup is a real copy, needs the download first, and needs a location

1. **Setup (API):** check → destinations → verify the key → pause → check again. The backup step is `current`.
2. Open *Settings > Migration*. In `migration-step-backup`, *I've backed up everything* is **disabled** and *"Download the database first."* is shown.
3. The server holds the same rule: `POST /steps/backup/confirm` before any download → `409 {"code": "database_not_downloaded"}`.
4. Click *Download the database*. The download is named `langflow-backup-<YYYYMMDD>.db` (UTC). Its first 16 bytes are `SQLite format 3\0`, and it contains the seed flow's name, so it is this instance's database and not an empty file. The step shows *"Downloaded <time>."* and the button is enabled.
5. The location is required. With the field empty, the form does not submit (`validity.valueMissing`) and the step stays `current`. The server refuses an empty and a blank location: `422 string_too_short` for `""` and for `"   "`.
6. Type a location unique to the run and click *I've backed up everything*. The record holds it: `record.backup.location` is that text, `confirmed_by` is the superuser, `confirmed_at` is set. The step is `done`, its summary reads *"Backed up <time> to <location>."*, and *Copy the database* is now the `current` step.

### Test 2 — a stopped copy keeps nothing and runs again; a repeated copy duplicates nothing

1. **Setup (API):** everything up to and including the backup.
2. In `migration-step-copy_database`, click *Copy the database*. Click *Stop* while it runs and confirm in the dialog *"Stop copying?"*.
3. The step's alert reads *"Stopped before it finished. Run it again."*. The API reads the step `blocked: cancelled`, and the run's last event says the copy is one transaction (*"…the target has all of the rows or none of them. It is safe to run again."*).
4. The target keeps **no rows**: `flow` holds 0 rows (or does not exist yet — measured both ways, depending on whether the stop came before or after the schema was prepared).
5. Click *Copy again* **without resetting the database**. The step reaches `done`; its line reads *"Tables: 63. Rows: <n>."*. The target's `flow` count equals the source's.
6. Open the step and click *Copy again* once more. It reaches `done` again, with the same `rows_copied`, and the target's `flow` count is still the source's — nothing was duplicated.

### Test 3 — the out-of-date copy says it needs a new database, and the old one is left as it was (#15814)

1. **Setup (API):** create a flow on the source named for the run. Everything up to the backup, then copy the database (`done`; the target holds the run's flow).
2. Turn changes back on (`DELETE /api/v1/migration/pause`), delete the run's flow on the source, pause again, check again, and download + confirm the backup again.
3. Open the page. Before anything runs, `migration-step-copy_database` says *"This copy is out of date, so it no longer counts. Copy again."* and *"To copy the database again, save a new, empty database in 'Where your data goes' first."*
4. Click *Copy again*. The alert reads *"The new instance's database holds an earlier copy that no longer matches this instance. Copying into it again can't fix that. Save a new, empty database in 'Where your data goes', then copy again."*, and its *Details* name the table: *"flow: source has <n> rows, target has <n+1> after copy"*.
5. The API reads the step `blocked: count_mismatch`. The target is **unchanged**: it still holds the deleted flow's row and the same `flow` count as before the attempt.

### Test 4 — test runs write nothing; the copies land; an unreadable knowledge base is left behind and reported (#15777)

1. **Setup, before the pause (API + container):**
   - create a second knowledge base, named for the run, through `POST /api/v1/knowledge_bases/`;
   - make its store unreadable with `chmod 000` on its `vectors.sqlite3` — the copy then reports `kb_source_unreadable` (*"CantOpenError: unable to open database file"*). This is reversible, which overwriting the file is not: measured, `DELETE /api/v1/knowledge_bases/{name}` answers **500** on a corrupt store, so a test that corrupted it could not clean up through the API;
   - attach a file to the seed flow as a chat attachment, through `POST /api/v1/files/upload/{flow_id}` — the upload the Playground makes. It is stored under the flow's namespace, outside the `file` table;
   - the first check now blocks on `source: knowledge bases` (*"1 of 2 knowledge bases have a backend that cannot be built or reached"*). Accept it, as an admin would (`POST /accepted-findings`).
2. **Setup (API):** destinations → key → pause → check → backup → copy the database (`done`).
3. In `migration-step-copy_knowledge_bases`, click *Test run*. The step reads *"Test run: nothing was copied. To copy: 1. Already copied: 0. Can't be copied: 1."*. The target holds **no** `lf_%` table. `migration-step-copy_files` offers no button yet (its step is `locked`).
4. Click *Copy knowledge bases*. The alert reads *"Some were not copied. Each one below says why."*; the run's knowledge base is listed with *"This instance can't read its store. Details says why."*; the line reads *"Copied: 1. Already copied: 0. Not copied: 1."*. The API reads the step `blocked: kb_source_unreadable`. The target holds **one** `lf_%` table with exactly 3 rows — the seed's vectors.
5. Tick *Leave it behind, <name>*. The step is `done`, and `record.decisions` holds `{kind: "leave_behind", subject: <knowledge base id>}`.
6. In `migration-step-copy_files`, click *Test run*. It reads *"Test run: nothing was copied. To copy: 2. …"*, and the bucket lists **0** keys.
7. Click *Copy files*. It reads *"Copied: 2. Already copied: 0. Not copied: 0."*. The bucket lists exactly two keys, each with the source file's size: `langflow/<user_id>/instance-migration-seed-file.txt` (the upload) and `langflow/<seed flow id>/<attachment name>` (the chat attachment).
8. **Cleanup (after the reset):** `chmod 600` on the store, `DELETE /api/v1/knowledge_bases/{name}` → `200`, delete the attachment.

### Test 5 — *Check the copy* matches a clean copy and names a deleted row; the start shows no secret; the record holds none

1. **Setup, before the pause (API):** a global variable of type **Credential**, named for the run, whose value is a sentinel.
2. **Setup (API):** everything up to the backup, then the three copies (`done`).
3. In `migration-step-check_target`, click *Check the copy*. The step reaches `done` with *"Checked <time>. Everything matches."*; the API report is `ok` with 8 checks, all `same`.
4. Delete the run's credential row from the **PostgreSQL copy**, and run the check again **through the API** (`POST /steps/check_target/runs`). Measured: once a check matches, its step collapses to the summary with no body and no *Check again* — the page offers a new check only when a step above changes, and a row deleted straight from the database is a change the page cannot see. Reload the page.
5. The alert reads *"The copy differs from this instance: 1."*, and `migration-difference-credentials` shows *This instance* *"<n> encrypted values…"* against *The copy* *"<n−1> encrypted values…"*. The API reads the step `blocked: differences`, and *Start the new instance* is `locked`.
6. Tick *I compared them, and what differs is expected.* and click *Continue*. The step is `done`, and `record.steps.check_target.accepted_differences` is `["credentials"]`.
7. In `migration-step-start_target`, click *Show the settings* and *Continue* in *"Start the new instance?"*. `migration-start-settings` lists the new instance's settings with placeholders where a secret would go — `LANGFLOW_DATABASE_URL=postgresql://<user>:<password>@langflow-instance-migration-pg:5432/langflow_target`, `LANGFLOW_SECRET_KEY=<secret key>`, `AWS_ACCESS_KEY_ID=<access key id>`, `AWS_SECRET_ACCESS_KEY=<secret access key>` — and the page's whole HTML contains none of the five sentinels (database password, S3 key id, S3 secret, secret key, the credential's value).
8. Click *The new instance is running*. `migration-complete` shows *"Move complete. …"*, every step is `done`, and the server refuses every further run with `409 {"code": "new_instance_started"}` — the three copies, a test run, and *Check the copy*.
9. Click *Download the migration record (for support)*. The download is named `langflow-migration-<YYYYMMDD>.json` (UTC). It parses as JSON, lists the ten steps, all `done`, and holds the decisions made on the way: the backup location, `accepted_differences: ["credentials"]`, and who confirmed the start. Its raw text contains none of the five sentinels.
10. **Cleanup (after the reset):** delete the credential variable from the source.

---

## Validation criterion *(required)*

The spec passes only when the destinations agree with the page:

- the backup download is a SQLite file of this instance, and the confirmation is refused without a download and without a location;
- a stopped database copy leaves no rows and runs again into the same database; a repeated one leaves the target's `flow` count equal to the source's;
- an out-of-date copy is announced before it runs and fails `count_mismatch` without changing the target;
- a test run leaves no `lf_%` table and no bucket key; the real copies leave exactly the 3 seed vectors and the two files, at their sizes; the unreadable knowledge base is listed, blocks the step until it is left behind, and the decision is recorded;
- *Check the copy* is `ok` on a clean copy and names `credentials` once a credential row is gone from the copy;
- the start settings, the page and the migration record contain no sentinel.

**Force-fail (each executed before the report, one or more per test):**

- Test 1 — skip the download: the confirmation stays disabled, the record holds no location, and the test fails.
- Test 2 — delete one `flow` row from the target just before the last count: the target's count no longer equals the source's, and the test fails. This proves the count reads the target's real table.
- Test 3 — skip the deletion on the source: *Copy again* reaches `done`, and the test fails. This proves the refusal comes from the lost row and not from repeating the copy.
- Test 4 — skip the `chmod`: nothing is reported as unreadable, and the test fails. Separately, skip *Leave it behind*: the step stays `blocked`, and the test fails.
- Test 5 — skip deleting the credential row: the second check reads as matching, and the test fails. Separately, append the database password to the record's text before the sentinel assertion: the test fails.

---

## What this does not cover *(and why)*

- **A flow missing from the copy is not caught by *Check the copy*.** Measured on dev14: a `flow` row deleted from the PostgreSQL copy reads *"Everything matches."* and unlocks *Start the new instance*. The check compares integrity summaries, none of which counts flows; the database copy itself compares every table's rows (`source_rows` / `target_rows` in its events), so the gap is a row lost **after** the copy. The step's own subtitle says *"Confirms everything arrived."*. This is a **candidate** finding: not filed upstream, not asserted here until the team decides what it is.
- **A chat message that names the attachment.** `relocate-files` also rewrites `message.files` from absolute paths to `<namespace>/<name>` *(code: `api/utils/file_relocation.py`)*. The seed has no message, so that rewrite is not exercised; the attachment's bytes are.
- **Users and projects beyond the lane's superuser and default project.** The database copy is table-agnostic (63 tables, measured), so more of them would change counts, not behaviour.
- **What the target instance serves.** Starting a Langflow on the copy is #2354: `docs/instance-migration/instance-migration-target-acceptance.md`.
- **The steps before the backup**, the pause and the secret boundary of *Where your data goes* — #2349–#2352. They are driven through the API here.
- **Accepting a difference that hides a real loss.** Test 5 accepts `credentials` only to reach the start step; whether accepting should be possible for a credential is a product question, not asserted.
- **The leftover store directories.** Measured: `DELETE /api/v1/knowledge_bases/{name}` answers `200` and leaves the store's directory under `knowledge_bases/sqlite/<user>/<id>/` on disk. Test 4 creates one such directory per run on the source. The source check stays clean with them (measured), so they do not affect later runs.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/migration.py` — every route above; the backup rules (`database_not_downloaded`, `location` with `min_length=1`), `no_dry_run`, `new_instance_started`, `differences`, the record the page downloads.
- `src/backend/base/langflow/api/utils/migration_copies.py` — the three copy commands and the decisions (`leave_behind` answers `kb_source_unreadable`).
- `src/backend/base/langflow/api/utils/migration_runs.py` — runs as child processes, followed through their events and cancelled with `SIGTERM`.
- `src/backend/base/langflow/api/utils/file_relocation.py` — the files copy: the storage namespace (user or flow) is what is copied, which is how a chat attachment outside the `file` table reaches the bucket.
- `src/backend/base/langflow/services/knowledge_base_storage/migration_io.py` — the knowledge base copy into pgvector.
- `src/frontend/src/pages/SettingsPage/pages/MigrationPage/BackupStep.tsx` — the download, the disabled confirmation, the required location.
- `src/frontend/src/pages/SettingsPage/pages/MigrationPage/CopyStep.tsx` — *Test run*, *Stop*, *Copy again*, the out-of-date lines, the items left behind.
- `src/frontend/src/pages/SettingsPage/pages/MigrationPage/CheckTargetStep.tsx` — `migration-difference-<name>`, the acceptance of differences.
- `src/frontend/src/pages/SettingsPage/pages/MigrationPage/StartStep.tsx` — `migration-start-settings`, `migration-complete`.
- `src/frontend/src/pages/SettingsPage/pages/MigrationPage/index.tsx` — `migration-step-<id>` and the client-side download of the migration record.
- `src/frontend/src/locales/en.json` — every sentence asserted above.
- **Langflow API** — the routes in the table above, plus `POST /api/v1/knowledge_bases/`, `DELETE /api/v1/knowledge_bases/{name}`, `POST /api/v1/files/upload/{flow_id}`, `POST /api/v1/variables/`, `POST`/`DELETE /api/v1/flows/`.
- **The lane** — `scripts/start-langflow-instance-migration.sh`, `scripts/reset-langflow-instance-migration.sh`, `tests/helpers/instance-migration/instance-migration-lane.ts`.
- **No provider key, no model.**
