# Instance migration — destinations and the secret key name every failure and never leak a secret

**File:** `tests/tests-automations/regression/instance-migration/instance-migration-destinations-and-key.spec.ts`

**Last validated:** Langflow 1.14.0.dev17 (`langflowai/langflow-nightly:latest` plus the `pgvector` package, `package: "Langflow Nightly"`), on the `@instance-migration` lane. Every fact below was measured that day over the API and on the page, unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

---

## What this test validates *(required)*

Two migration steps handle secrets.

- *Where your data goes* is given a PostgreSQL address, which carries a password, and the S3 access keys. The server keeps them only in the memory of the worker that saved them *(code: `_secrets` in `migration.py`)*. A restart drops them, and the user doc says the admin enters them again.
- *Hand over the secret key* proves that the new instance holds this instance's `LANGFLOW_SECRET_KEY` without the key ever entering the page. The admin pastes a 12-character fingerprint, the first 12 hex characters of the key's SHA-256.

Both steps are secret boundaries: a password, a key or the fingerprint that leaves the server can be copied by anyone who reads a page, a log, a file or a support record. Four tests:

1. **Each destination failure names its cause.** A wrong password, a host that does not exist, a database without pgvector and a bucket that does not exist each give their own code, and the server's own words say which one it was, on the API and on the page. A valid destination saves, and the step is `done`.
2. **No destination secret or key leaves the server.** The lane's planted secrets, plus the ones the test types, appear nowhere the server answers or writes:
   - the `PUT` answers, `GET /api/v1/migration` and every API answer the page receives;
   - the rendered page;
   - `migration.json` on disk;
   - the events of the three copies;
   - the container's logs.
   An endpoint that carries credentials and a password with an unescaped `@` are refused without being read or kept.
3. **After a restart, the passwords are asked for again, never replayed.** The step still reads `done`, because the record survives. The copy refuses with `secrets_missing`, and the page says to enter them again. Once they are entered again, the copy runs.
4. **The secret key step names where the key is, never the key, and cannot be skipped.** The page says the key is in `LANGFLOW_SECRET_KEY`. A key pasted whole is cut to 12 characters before it leaves the page. A wrong fingerprint is refused and blocks the step, the right one is accepted, and a wrong one after it reopens the step. Until the key is verified, the pause and the copies are refused.

### What the measurements changed in the issue's plan

- **A wrong password and an unreachable host have the same code.** Both are `db_unreachable` *(code: `_ask` in `migration_probes.py`)*. They are told apart only by the server's reason: `password authentication failed for user "langflow"` against `failed to resolve host 'im-no-such-host'`. The test asserts the reason, as the issue asks, because asserting the code alone would pass with the two swapped.
- **A wrong S3 key cannot be tested on this lane.** The lane's SeaweedFS gateway runs with no identities and accepts any key, so `bucket_denied` answers `ok: true`. #2397 tracks turning on authentication in the lane. Doing it inside this spec would break the unsigned bucket listing #2353 and #2354 use, so it is left out here.
- **The destination test passes on a bucket that cannot store a file.** Its probe writes an empty object, which needs no storage. On a host with little free disk, the lane's SeaweedFS has no volume for the bucket, and *Copy files* then ends `blocked: bucket_error` (#2396). Test 2 reads the events of all three copies whatever their status, so it does not depend on that copy succeeding.
- **"Read the destinations after a restart" shows a `done` step.** The saved record survives, and only the secrets are lost. What shows the loss is the next run: `409 secrets_missing`, and on the page *"Langflow no longer holds the passwords and keys of the new instance. … Then enter them again in 'Where your data goes'."*. Test 3 pins that, and that entering them again lets the copy run.
- **A form filled the moment it appears can lose its submit.** Measured once: the destination fields were filled as soon as they rendered, and *Test and save* sent no request. Filled after the page's requests had settled, the `PUT` went out at once. The test fills the form only after that, and every save waits for the page's own `PUT`, so a lost submit fails there and not later as a missing result.
- **The secret key's fingerprint is a secret as well.** The server never sends it *(code: `_instance`: "never its fingerprint: one that is handed out would pass the check without anyone reading the new instance")*. Test 2 and test 4 add it to the planted values.

### Measured answers

`PUT /api/v1/migration/destinations` answers `200` in every case below. The verdict is in `results`, and the step `connect_target` reads `blocked` with the first failing code:

| Destination sent | `results` | The page shows |
|---|---|---|
| Wrong PostgreSQL password | `database` and `vectors`: `db_unreachable`, reason `… password authentication failed for user "langflow"` | *Can't connect to this database.* and the reason |
| Host that does not exist | `database` and `vectors`: `db_unreachable`, reason `failed to resolve host 'im-no-such-host': … Name or service not known` | the same line, another reason |
| Database without the `vector` extension | `database`: ok; `vectors`: `pgvector_missing`, reason `Run CREATE EXTENSION vector; in this database, then test again.` | *The database needs the pgvector extension…* |
| Bucket that does not exist | `files`: `bucket_missing`, reason `An error occurred (404) when calling the HeadBucket operation: Not Found` | *Can't find this bucket.* |
| Endpoint `http://user:<secret>@host:8333` | `files`: `bucket_unreachable`, reason *"Enter the endpoint as http(s)://host:port… A user, a password or a query in it is not accepted…"*; `endpoint_url` saved as `null` | *Can't reach this bucket. Check the endpoint.* |
| Password with an unescaped `@` | `database`: `db_unreachable`, reason *"This address has an "@" after its password. If the password has an "@" in it, write it as %40."* | |
| The lane's destinations | every part `{"ok": true}`, the step `done` | the step closes on one line, *"Database: langflow-instance-migration-pg:5432/langflow_target · Knowledge bases: PostgreSQL · Files: langflow-migration"* |

The record keeps each part's location and outcome, never a reason or a secret: `database: {location: "langflow-instance-migration-pg:5432/langflow_target", identity}`, `vectors: {kind: "pgvector"}`, `files: {bucket, prefix, endpoint_url}`, and `results` holding only `ok` and `code`. The logs say `tested the destination: database db_unreachable, vectors db_unreachable, files ok`, which is codes only.

`POST /api/v1/migration/secret-key/verify`:

| Sent | Answer | Step |
|---|---|---|
| `000000000000` | `400 {"detail": {"code": "fingerprint_mismatch"}}` | `blocked: fingerprint_mismatch`, and later steps are `locked` |
| The right fingerprint, uppercase, with spaces around it | `200` | `done`; the pause is `current` |
| A wrong one after the right one | `400` | `blocked` again: the last answer stands |
| The whole key | `400` | `blocked` |

Before the key is verified, `POST /api/v1/migration/pause` and `POST /api/v1/migration/steps/copy_database/runs` both answer `409 {"detail": {"code": "locked", "reason": "earlier_step"}}`.

## Tags *(required)*

| Test | Tags |
|---|---|
| 1 — each failure names its cause | `@instance-migration` `@settings` `@api` `@ui-ux` |
| 2 — no secret leaves the server | `@instance-migration` `@settings` `@api` |
| 3 — asked for again after a restart | `@instance-migration` `@settings` `@api` `@ui-ux` |
| 4 — the secret key step | `@instance-migration` `@settings` `@api` `@ui-ux` |

None is `@stable`: nothing runs `@instance-migration` on a cron (#1010).

## Precondition *(required)*

- The `@instance-migration` lane (`./scripts/start-langflow-instance-migration.sh`), run with `PW_INSTANCE_MIGRATION=1 … --grep @instance-migration`. It is serial, with one worker.
- **Each test starts and ends with `resetInstanceMigration()`.** The reset does not forget the secrets the worker holds *(lane doc)*. Each test therefore saves its own destinations before relying on them, and test 3 restarts the source to drop them.
- The planted secrets are the lane's own: `lane.sentinels` (the PostgreSQL password, both S3 keys, `LANGFLOW_SECRET_KEY`) plus `lane.secretKeyFingerprint`. Each test adds the values it types, with a unique suffix.
- Test 1 creates an empty database without the `vector` extension in the lane's PostgreSQL container, and drops it afterwards.
- No flow, file, user or variable is created on the source.

## Step by step *(required)*

### Test 1 — each destination failure names its cause, on the API and on the page

1. *Check this instance* through the API. Create the database `im_novector_<id>`, without the `vector` extension.
2. On *Settings > Migration*, in `migration-step-connect_target`, enter the lane's destinations with a wrong password. The fields are found by their ids (`migration-destination-<name>`). Click *Test and save*:
   - the database line (`#migration-probe-database`, `role="alert"`) reads *"Can't connect to this database."* and the server's reason, `password authentication failed for user "langflow"`;
   - the address field is `aria-invalid="true"`;
   - the step is `blocked: db_unreachable`.
3. Enter the right password and click *Test and save*. The step closes on its summary, *"Database: langflow-instance-migration-pg:5432/langflow_target · Knowledge bases: PostgreSQL · Files: langflow-migration"*, and its state is `done`. A valid save shows no *Ready.* line, because the form is replaced at once (measured).
4. Through the API, one `PUT` per case: an unreachable host, the database without pgvector, a missing bucket. Each one asserts:
   - the part's `ok: false`, its code, and the reason text in the table above;
   - the step's `blocked` reason;
   - that the record keeps the code and no `reason`.
5. A last `PUT` of the lane's destinations: every part `ok`, the step `done`, and the record holds the locations listed above.

### Test 2 — no destination secret or key leaves the server

1. From the start of the test, the page's every API answer is captured, and the time is noted for the logs.
2. *Check this instance* through the API. On the page, save the destinations with a wrong password `e2e-im-wrong-pg-password-<id>` (refused), then with the lane's own (saved).
3. Through the API, two refused destinations, each a planted value:
   - an endpoint `http://e2e:e2e-im-endpoint-secret-<id>@…:8333` is refused (`bucket_unreachable`), and the record's `files.endpoint_url` is `null`;
   - an address with the password `e2e-im-at@password-<id>` is refused with the `%40` hint.
   Then the lane's destinations are saved again.
4. Verify the key, pause, check again, back up, and run the three copies through the API. Each copy's event stream is read to its `end` event, whatever its status (#2396).
5. Search for every planted value, as raw text. It is absent from:
   - every `PUT` answer and `GET /api/v1/migration`;
   - the page's HTML and visible text;
   - every API answer the page received;
   - the source's `<CONFIG_DIR>/migrations/migration.json`, read with `docker exec`;
   - each copy's events;
   - the source container's logs (stdout and stderr) since the test began.

### Test 3 — after a restart, the passwords are asked for again, never replayed

1. Walk to the copies through the API: destinations, key, pause, check, backup. *Copy the database* is `current`.
2. `docker restart` the source container, then wait for `/api/v1/version`.
3. `GET /api/v1/migration`: `connect_target` is still `done`, and the record still holds the destinations' locations.
4. `POST /api/v1/migration/steps/copy_database/runs` answers `409 {"detail": {"code": "secrets_missing"}}`.
5. On the page, click *Copy the database*: an alert reads *"Langflow no longer holds the passwords and keys of the new instance. … Then enter them again in 'Where your data goes'."*.
6. Open *Where your data goes* by its heading. It reads *"Saved … by langflow."*, the note *"Passwords and keys stay in the memory of the Langflow worker that saves them. If Langflow restarts, you'll enter them again…"*, and *Change or enter again*. Click it. The form brings back what the record keeps: the bucket, the folder and the endpoint. The connection address and the secret access key are **empty**, so nothing secret is filled back in.
7. Enter the address and the keys, and click *Test and save*. The step closes on its summary.
8. Click *Copy the database* again. The page's `POST …/copy_database/runs` answers `202`, and the run, followed through the API, ends `done`.

### Test 4 — the secret key step names where the key is, never the key, and cannot be skipped

1. Through the API, *Check this instance* and the lane's destinations. *Hand over the secret key* is `current`. `POST /pause` and `POST /steps/copy_database/runs` answer `409 locked earlier_step`. `GET /api/v1/migration` gives `instance.secret_key` as `{"source": "env"}`.
2. In `migration-step-secret_key`, the page reads:
   - *"This instance's secret key is set in its LANGFLOW_SECRET_KEY environment variable."*;
   - the command `printf '%s' "$LANGFLOW_SECRET_KEY" | sha256sum | cut -c1-12`.
3. Paste the whole key into *What the command printed*. The field holds its first 12 characters. *Verify* sends `{"fingerprint": "<those 12>"}`, never the key, and gets `400 fingerprint_mismatch`:
   - the alert reads *"This doesn't match this instance's key…"*;
   - the field is `aria-invalid="true"`;
   - the step is `blocked: fingerprint_mismatch`;
   - `POST /pause` is still refused.
4. Enter the right fingerprint in uppercase and click *Verify*. The answer is `200`, the step is `done`, and the pause step is `current`.
5. Through the API, a wrong fingerprint reopens the step (`blocked`). The right one with spaces around it closes it again (`done`).
6. Neither the key nor the fingerprint appears in the page's HTML or in any API answer the page received.

## Validation criterion *(required)*

The spec passes only when, on the lane:

- a wrong password, an unreachable host, a database without pgvector and a missing bucket each give their code and the server's reason, on the API and, for the password, on the page; and a valid destination saves to `done`;
- no planted secret, key or fingerprint appears in any answer, the page, `migration.json`, the copies' events or the container logs; and an endpoint with credentials and an unescaped `@` are refused and not kept;
- after a restart, the copy is refused with `secrets_missing`, the page says to enter the secrets again, and after entering them the copy runs to `done`;
- the secret key step names the environment variable, cuts a pasted key to 12 characters, refuses a wrong fingerprint, accepts the right one, reopens on a later wrong one, and the pause and the copies are refused until it is verified.

**Force-fails**, each to be executed and to fail on its intended assertion:

1. Test 1, with the wrong-password case expecting the unreachable host's reason: it fails on the reason, which shows the code alone does not tell the two apart.
2. Test 1, with the expected page alert text changed: it fails on the alert.
3. Test 2, with the bucket's name (present in the record) added to the planted values: it fails on `GET /api/v1/migration`, which shows the search reads the real text.
4. Test 2, reading `migration.json` from a path that does not exist: it fails on the read, which shows an unreadable file cannot pass as a clean one. Each searched surface also has a positive check beside it: the saved location in the state, the bucket in `migration.json`, an `end` event in each copy, *"tested the destination"* in the logs, and at least one answer captured from the page.
5. Test 3, without the restart: the copy starts (`202`) instead of answering `409 secrets_missing`.
6. Test 4, expecting the key pasted whole to be accepted (`200`): it is refused with `400`.
7. Test 4, expecting the field to hold 13 characters: it fails on the field's value.

## What this does not cover *(and why)*

- **A wrong S3 key (`bucket_denied`).** The lane's gateway accepts any key (#2397).
- **A database user who cannot create tables (`no_create`) and a database that is not empty (`db_not_empty`).** Both need a second PostgreSQL role or a planted table; each is a separate code with its own page line, and neither is part of the issue.
- **The downloaded *migration record (for support)*.** `instance-migration-copy.spec.ts` (#2353, its last test) asserts the lane's planted secrets are absent from it after a whole migration. The record is `GET /api/v1/migration` saved by the browser, which test 2 searches here.
- **A key kept in a file** (`source: "file"`, the page naming the path). The lane sets `LANGFLOW_SECRET_KEY` in the environment; the other branch needs a second source.
- **Several workers.** The lane runs one worker by design, which is what the user doc requires for the secrets to stay available.

## External dependencies *(required)*

| Upstream | What this spec relies on |
|---|---|
| `src/backend/base/langflow/api/v1/migration.py` | `PUT /destinations` (results per part, the record without reasons or secrets, the secrets kept in `_secrets`), `POST /secret-key/verify` (`fingerprint_mismatch`, the last answer stands), `instance.secret_key`, `secrets_missing` on a run, `locked earlier_step` |
| `src/backend/base/langflow/api/utils/migration_probes.py` | each code and reason: `db_unreachable` (with the password removed from the driver's line), `pgvector_missing`, `bucket_missing`, `bucket_unreachable`, the `@` and endpoint refusals |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/DestinationsStep.tsx` | the fields `migration-destination-<name>`, the lines `migration-probe-<part>`, *Test and save*, the saved summary, *Change or enter again* with only the non-secret fields filled back in |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/SecretKeyStep.tsx` | where the key is, the command, the 12-character field, *Verify*, the mismatch alert |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/catalog.ts` | which page line each code shows, including `secrets_missing` |

- **Langflow API**: the routes above, plus `GET /api/v1/migration`, `POST /api/v1/migration/checks`, `POST`/`DELETE /api/v1/migration/pause`, `POST /api/v1/migration/backup/database`, `POST /api/v1/migration/steps/backup/confirm`, `POST /api/v1/migration/steps/{step}/runs`, `GET …/runs/{run_id}/events`.
- **Test ids**: `migration-step-connect_target`, `migration-step-secret_key`, `migration-step-copy_database`. The destination fields and their result lines are found by their element ids, which the code builds from each field's name.
- **The lane**: `scripts/start-langflow-instance-migration.sh`, `scripts/reset-langflow-instance-migration.sh`, `tests/helpers/instance-migration/instance-migration-lane.ts` (its `sentinels`), `tests/helpers/instance-migration/migration-walk.ts`, `docker exec` / `docker logs` / `docker restart` on the source container, and `psql` in the database container.
- **No provider key, no model.**
