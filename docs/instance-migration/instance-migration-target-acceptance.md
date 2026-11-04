# Instance migration — the new instance serves what was copied, and turning changes back on loses nothing

**File:** `tests/tests-automations/regression/instance-migration/instance-migration-target-acceptance.spec.ts`

**Last validated:** Langflow 1.14.0.dev14 (`langflowai/langflow-nightly:latest` plus the `pgvector` package, `package: "Langflow Nightly"`), on the `@instance-migration` lane. Every fact below was measured that day, over the API and on both instances' pages, unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

---

## What this test validates *(required)*

A migration's copy steps succeed on the **source**. Nothing proves the move worked until a Langflow **starts on the copy** and serves it. The user doc's acceptance list is the one this spec runs: sign in, use a saved credential, open and run a migrated flow, read a migrated knowledge base, and download a migrated file and a chat attachment. The doc also warns that *"downloading a flow only exports its records and can succeed when the target instance cannot read files from S3"*. The easy check is the misleading one, so every assertion here reads a surface that **fails** when the target is started wrong (measured, see *Validation criterion*).

Two tests:

1. **The new instance serves the copy.** The source is migrated end to end, and a second Langflow is started from the settings *Start the new instance* prints, with its placeholders filled in. On that instance:
   - a user created on the source signs in with the password it was created with;
   - a credential global variable is **decrypted and handed to a component**, not just listed;
   - a migrated flow opens on the canvas and runs;
   - the migrated knowledge base returns a known chunk from pgvector;
   - the uploaded file and the chat attachment download with the source's exact bytes, read from S3.
2. **Turning changes back on before the start loses nothing.** At the last step before the start, *Turn changes back on* makes the source writable again, and its users, flows, variables, files and knowledge bases are exactly what they were before the migration began.

### Where this lives: a spec, not a VM routine cell

#2354 asked to decide first between a spec on this lane (Option A) and a cell in the VM routine `e2e-routine-migration` (Option B). **Decided: Option A**, for these reasons:

- **Reuse.** The walk to the start step already exists in TypeScript and is validated (`migration-walk.ts`, #2353). Option B would rewrite it in Python inside `ops/vm/migration/cell.py`, a routine whose axis is a version upgrade (stable → target), with no instance-migration shape.
- **Validation cost.** Option A is validated locally with a force-fail per assertion. Option B can only be validated on the QA VM, where every command needs the operator's approval, and the routine runs once a day behind the heavy-lane lock.

What Option A gives up is **scheduled coverage**. Nothing runs `@instance-migration` on a cron, so this spec runs only when someone runs the lane (the same as #2349–#2353). Scheduling the lane, or adding the cell later on top of this spec's measurements, is a separate decision.

### What the measurements settled

- **The printed settings, measured (11 entries).** The settings appear only once *Check the copy* is `done`; before that, `start.settings` is `[]`. They are:
  - `LANGFLOW_DATABASE_URL=postgresql://<user>:<password>@langflow-instance-migration-pg:5432/langflow_target`
  - `LANGFLOW_SECRET_KEY=<secret key>`
  - `LANGFLOW_STORAGE_TYPE=s3`, `LANGFLOW_OBJECT_STORAGE_BUCKET_NAME=langflow-migration`, `LANGFLOW_OBJECT_STORAGE_PREFIX=langflow`
  - `AWS_ACCESS_KEY_ID=<access key id>`, `AWS_SECRET_ACCESS_KEY=<secret access key>`, `AWS_ENDPOINT_URL=http://langflow-instance-migration-s3:8333`
  - `PGVECTOR_CONNECTION_STRING=postgresql+psycopg://<user>:<password>@langflow-instance-migration-pg:5432/langflow_target`
  - `LANGFLOW_AUTO_LOGIN=true`
  - `LANGFLOW_SSRF_ALLOWED_HOSTS=<the source's ranges>`

  Five placeholders need filling: `<user>`, `<password>`, `<secret key>`, `<access key id>`, `<secret access key>`.
- **What the page does not print is the operator's own, on purpose** *(code: `migration_target.start_settings`)*. Only where the data lives, the secret key, the sign-in settings and the dial policies are carried. Port, workers and `LANGFLOW_ALLOW_CUSTOM_COMPONENTS` are not. The target gets the lane's values for those. The custom-components switch matters here because the credential test runs custom code.
- **A target started wrong still passes the easy checks.** Measured on a target started with a different secret key, no storage settings and no `PGVECTOR_CONNECTION_STRING`:
  - the user still signs in;
  - the variable is still listed;
  - the knowledge base still lists as `postgres`, `ready`, 3 chunks;
  - the flow export still answers `200`.

  These surfaces fail on that target:
  - the credential **reaches the component empty, and the run still answers `200`** (`resolved_len=0`);
  - reading a chunk answers `500 "Error getting chunks."`;
  - the file download answers `404`;
  - the attachment download answers `500`.

  So the assertions are on the second list. The first list is never offered as proof.
- **The migrated API key authenticates on the target**, and is how the run is driven. With `LANGFLOW_AUTO_LOGIN=true`, `POST /api/v1/run/{id}` refuses a bearer token (`403 "Since v1.5, LANGFLOW_AUTO_LOGIN requires a valid API key."`). That holds on the source and on the target alike.
- **Turning changes back on is a dialog, and it does not touch the data.**
  - The paused page shows a status banner, *"Changes are paused on this instance. Paused <time> by <user>."*, with *Turn changes back on*.
  - The button opens *"Turn changes back on?"*, which says *"People can work again. The backup and any copies made so far become out of date, so you'll pause and make them again before you move."* and offers *Resume* / *Cancel*.
  - After *Resume*, measured with all three copies done and *Check the copy* `done`:
    - the banner is gone;
    - `pause` is `current` again, and every step below it is `locked: earlier_step`;
    - a write answers `201` (it was `503` a moment earlier);
    - the source's users, flows, variables, files and knowledge bases are byte-for-byte the same API listing as before the migration began, and the knowledge base still reads `backend_type: "sqlite"` on the source.

---

## Tags *(required)*

`@instance-migration` `@settings` `@database` `@files`

- `@instance-migration` — lane selector (cross-cutting). It needs the lane's containers and runs only under `PW_INSTANCE_MIGRATION=1`, serially.
- `@database` — cross-cutting: the spec asserts persistent state on two instances.
- `@settings`, `@files` — functional: *Settings > Migration*, and files served from S3.

**No `@stable`.** No scheduled lane runs `@instance-migration`, so the tag would mark a test that never runs (#1010).

---

## Precondition *(required)*

- The lane is up: `./scripts/start-langflow-instance-migration.sh`. The source is on `127.0.0.1:7895`, PostgreSQL + pgvector on `55895`, SeaweedFS on `58895`. The lane is seeded with one flow, one uploaded file, and one knowledge base whose chunks read *"instance-migration seed chunk <i>"*.
- `PW_INSTANCE_MIGRATION=1` and `PLAYWRIGHT_BASE_URL=http://127.0.0.1:7895/`.
- **Room for a second Langflow** (~1.5 GiB). The target runs the same derived image as the source, `langflow-instance-migration:local`, which carries the `pgvector` package the knowledge base needs, on the lane's network as `langflow-instance-migration-target`, published on `127.0.0.1:7896`.
- **The lane owns the target container.** Its name, port and image live in `scripts/lib/instance-migration-lane.sh`, beside the other three. The reset removes a target left running before it empties the database, and so do the stop and start scripts, so a test that died with the target up cannot block the next one.
- **Each test starts and ends with `resetInstanceMigration()`**, as in #2353. What a test adds to the source is its own to remove.
- No provider key and no model.

The walk to the start step is #2353's, through the API (`docs/instance-migration/instance-migration-copy.md` → *Getting to a step through the API*). It is not this spec's subject.

### Timing

A full run measured 6.2 min: test 1 took 3.9 min and test 2 took 2.2 min. On a loaded machine the database copy alone took ~6.5 min, and the target took 140 s to answer `/api/v1/version` once and ~9.5 min another time. A source check measured 15–27 s on most runs, 95 s on one, and ran past the walk's 120 s budget on another. So the walk's budgets were raised: 5 → 10 min for a run, and 120 → 300 s for a check. The tests carry generous budgets (30 min per test, 12 min for the target to answer), and a target that does not answer within its budget fails naming the container's last log lines.

### A dropped connection is re-dialled, never duplicated

A pooled socket can be closed by the server at the instant it is reused, because of its 2 s keep-alive (`tests/helpers/api/retry-on-dropped-connection.ts`). Measured on this lane: the setup's `POST /api/v1/flows/` died with `socket hang up` in 1 of 5 runs. Reads, sign-ins and runs are re-dialled once.

Every request that **creates** something goes through `createWithoutLeak` instead. Before it creates again, it looks for what the dropped attempt would have created:
- the variable and the user, by name;
- the flow, by difference with the listing taken before;
- the attachment, by name in the flow's folder;
- an API key, by name. A key found that way is deleted and created again, because its secret was only in the lost response.

A retry never leaves a second copy on the source.

---

## Step by step *(required)*

### Test 1 — the new instance serves the users, credential, flow, knowledge base and files that were copied

1. **Setup on the source (API), before the pause.**
   - Create a Credential global variable whose value is a sentinel unique to the run.
   - Create a user with a password unique to the run, and activate it.
   - Create a flow whose custom component reads that variable through a secret input and returns only its length (`createCredentialConsumerFlowViaApi`).
   - Create an API key.
   - Upload a chat attachment to that flow.
   - Run the flow on the source with the API key. It returns `resolved_len=<sentinel length>`: the baseline that this flow works before it moves.
   - Download the seed file and the attachment from the source, and keep their bytes.
2. **Walk (API):** check → destinations → key → pause → check → backup → the three copies → *Check the copy*, which is `ok`.
3. **Read the settings from the page.** Open *Settings > Migration*. In `migration-step-start_target`, click *Show the settings*, then *Continue* in *"Start the new instance?"*. Every `NAME=value` line of `migration-start-settings` is exactly the API's `start.settings`. They are 11 settings, and the five placeholders above are the only `<…>` values.
4. **Start the new instance.** Fill each placeholder from the lane's fixtures: the database user and password, the secret key, and the S3 key id and secret. A placeholder the spec cannot fill fails the test, naming it. Add the operator's own settings: host, port `7896`, one worker, custom components on, tracing off. Start the container. Values reach `docker run` through the environment, never on the command line. Wait until `GET /api/v1/version` answers `200` with the source's version.
5. **Sign in.** On the new instance, `POST /api/v1/login` with the user and password from step 1 answers `200`, and its token's `whoami` is that username. The same user with a wrong password answers `401` (the control: the sign-in really checks the copied password).
6. **The flow opens.** Open `http://127.0.0.1:7896/flow/<flow id>`. The canvas shows the custom component node (`<node id>-main-node`), and `flow_name` reads the flow's name. The ids are the source's: the flow was copied, not re-created.
7. **The credential decrypts and the flow runs.** `POST /api/v1/run/<flow id>` with the **migrated** API key returns `resolved_len=<sentinel length>`, the same as on the source. A credential that did not decrypt reaches the component empty, and the run would still answer `200` with `resolved_len=0`.
8. **The knowledge base.** `GET /api/v1/knowledge_bases/` lists the seed knowledge base with `backend_type: "postgres"`. `GET /api/v1/knowledge_bases/<name>/chunks?search=seed chunk 1` returns exactly one chunk, `seed-001`, reading *"instance-migration seed chunk 1"*. It is read from pgvector, because the new instance has no local store.
9. **The files.** The seed file (`GET /api/v2/files/<id>`) and the chat attachment (`GET /api/v1/files/download/<flow id>/<name>`) download from the new instance with **the source's exact bytes**. The flow export is not used as evidence (see above).
10. **Cleanup.** Remove the target container **first**, then reset the lane. On the source, delete the flow (and its attachment), the variable, the user and the API key.

### Test 2 — turning changes back on before the start leaves this instance writable, with its data unchanged

1. **Before (API).** Record the source's listing: users, flows, variables, files and knowledge bases, by id, name, type, size and backend.
2. **Walk (API)** through all three copies and *Check the copy*. *Start the new instance* is `current`, the last step before the move becomes one-way. A write now answers `503`.
3. **On the page.** The status banner reads *"Changes are paused on this instance."*. Click its *Turn changes back on*. The dialog *"Turn changes back on?"* says the backup and the copies *"become out of date"*. Click *Resume*.
4. **The source is writable again.**
   - The banner is gone.
   - The API reads `pause` as `current` and every later step as `locked`.
   - Creating a global variable answers `201`. It is deleted again.
5. **Nothing changed.**
   - The source's listing equals step 1's, field for field.
   - The knowledge base still reads `backend_type: "sqlite"` and returns `seed-001` for the same search.
   - The seed file still downloads with its bytes.
6. **Cleanup:** reset the lane.

---

## Validation criterion *(required)*

- Test 1 passes only when the new instance, started from the printed settings:
  - signs the source's user in, and refuses a wrong password;
  - opens the migrated flow by its source id;
  - decrypts the credential into the component (`resolved_len` equals the sentinel's length);
  - reads the seed chunk from pgvector;
  - serves both files with the source's bytes.
- Test 2 passes only when *Resume* turns a `503` into a `201` and the source's listing is unchanged.

**Force-fail (each executed before the report, each failing on the assertion named):**

- Test 1 — start the target with **a different secret key**: the run returns `resolved_len=0` against `resolved_len=37`, and the credential assertion fails. Every step before it passes, including the sign-in.
- Test 1 — start the target **without the storage settings**: the seed file download answers `404 "File … not found"`, and the files assertion fails. Every earlier step passes.
- Test 1 — start the target **without `PGVECTOR_CONNECTION_STRING`**: the chunk read answers `500 "Error getting chunks."`, and the knowledge base assertion fails.
- Test 1 — sign in with **a username the copy never had**: `401 "Incorrect username or password"`, and the sign-in assertion fails.
- Test 2 — click *Cancel* instead of *Resume*: the banner stays, and the test fails on it.
- Test 2 — create a flow on the source after step 1's listing: the final listing differs from the first, and the test fails on it.

---

## What this does not cover *(and why)*

- **A sign-in with `LANGFLOW_AUTO_LOGIN=false`.** The lane's source runs with it on, so the settings carry `LANGFLOW_AUTO_LOGIN=true`. With it off, the page would also print `LANGFLOW_SUPERUSER` and `LANGFLOW_SUPERUSER_PASSWORD=<password>` *(code)*. That needs a source started differently.
- **Clicking *The new instance is running*.** #2353 covers what it closes. This spec stops before it, because the acceptance happens on the target and the click changes nothing there.
- **A credential that silently resolves empty.** Measured: on a target with the wrong secret key, the run answers `200` and the component receives `""`, with only an `API key decryption failed` line in the server log. Here that is the force-fail and not an assertion. Whether a run should fail instead is a product question.
- **Restarting the target.** Each test starts the target once.
- **Scheduled coverage.** See *Where this lives*.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/utils/migration_target.py` — `start_settings`: the printed list, its placeholders, and what is deliberately left out.
- `src/backend/base/langflow/api/v1/migration.py` — `start.settings` empty until *Check the copy* is `done`, the pause and its lifting, and every route of the walk.
- `src/backend/base/langflow/api/utils/migration_pause.py` — the `503` while paused.
- `src/frontend/src/pages/SettingsPage/pages/MigrationPage/PauseStep.tsx` — the status banner, *Turn changes back on*, and the *"Turn changes back on?"* dialog.
- `src/frontend/src/pages/SettingsPage/pages/MigrationPage/StartStep.tsx` — `migration-start-settings`.
- `src/frontend/src/locales/en.json` — every sentence asserted above.
- `src/backend/base/langflow/api/v1/login.py` — `POST /api/v1/login`.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/run/{flow_id}` and its API-key rule under auto-login.
- `src/backend/base/langflow/api/v1/knowledge_bases.py` — `GET /api/v1/knowledge_bases/` (`backend_type`) and `GET /api/v1/knowledge_bases/{kb_name}/chunks` (`search`).
- `src/backend/base/langflow/api/v2/files.py` — `GET /api/v2/files/{id}`, served from the configured storage.
- `src/backend/base/langflow/api/v1/files.py` — `POST /api/v1/files/upload/{flow_id}` and `GET /api/v1/files/download/{flow_id}/{file_name}`.
- **Langflow API** — `POST`/`DELETE /api/v1/variables/`, `POST /api/v1/users/`, `PATCH`/`DELETE /api/v1/users/{id}`, `POST`/`DELETE /api/v1/api_key/`, `POST`/`DELETE /api/v1/flows/`, `GET /api/v1/users/whoami`.
- **The lane** — `scripts/lib/instance-migration-lane.sh`, `scripts/start-langflow-instance-migration.sh`, `scripts/reset-langflow-instance-migration.sh`, `scripts/stop-langflow-instance-migration.sh`, `tests/helpers/instance-migration/instance-migration-lane.ts`, `tests/helpers/instance-migration/migration-walk.ts`.
- **No provider key, no model.**
