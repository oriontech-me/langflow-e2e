# The instance-migration lane

**Last validated:** Langflow 1.14.0.dev14 — the lane was started from `langflowai/langflow-nightly:latest` (`1.14.0.dev14`, `package: "Langflow Nightly"`), a migration was driven through every copy step against it twice, and the reset was run against a finished migration and against a copy still running. Every number below was measured that day unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

---

## What this test validates *(required)*

This document specifies **infrastructure, not a test**: the fourth run lane, its selector, the three containers it starts, the reset between tests and the `@instance-migration` tag. It ships no `.spec.ts`. The specs that consume it are #2349–#2353 (tracker #2357). `docs/serving/end-user-identity-lane.md` is the precedent this follows.

**Instance migration** (*Settings > Migration*) moves a whole Langflow instance — users, flows, files, knowledge bases — to a new one, typically SQLite → PostgreSQL + pgvector + S3. It is **not** the schema/upgrade migration the `e2e-routine-migration` VM routine covers (#2193), which is why everything in this repo says *instance migration*.

No existing lane can reach it, for three reasons:

- **It is off by default.** `/api/v1/migration` is mounted only when `LANGFLOW_FEATURE_INSTANCE_MIGRATION=true` is set when the process starts. Measured: the flag reads `instance_migration=False` in the nightly, and with it on `GET /api/v1/migration` answers `200`.
- **Its pause is instance-global.** While it is on, every non-`GET` request outside `/api/v1/migration/` and the login routes answers `503 "This instance is being migrated."`. Measured: `POST /api/v1/flows/` answered `503` during a pause and `201` after a reset. A worker sharing the instance would fail mid-test.
- **It needs destinations.** A SQLite source copies into an **empty** PostgreSQL database, its knowledge bases into pgvector, and its files into an S3-compatible bucket. It also needs **one worker**, because the destination passwords live only in that worker's memory *(code)*.

### What the lane starts

`./scripts/start-langflow-instance-migration.sh` starts three containers on one user-defined network, so the source reaches the target by container name:

| container | image | published on | what it is |
|---|---|---|---|
| `langflow-instance-migration` | the nightly + the `pgvector` package | `127.0.0.1:7895` | the source: SQLite, flag on, one worker, a known `LANGFLOW_SECRET_KEY`, seeded data |
| `langflow-instance-migration-pg` | `pgvector/pgvector:0.8.6-pg16` | `127.0.0.1:55895` | an empty database `langflow_target`, with `CREATE EXTENSION vector` already run |
| `langflow-instance-migration-s3` | `chrislusf/seaweedfs:4.47` | `127.0.0.1:58895` | an S3 gateway with one empty bucket, `langflow-migration` |

Names, ports and fixture credentials live in `scripts/lib/instance-migration-lane.sh`. `tests/helpers/instance-migration/instance-migration-lane.ts` exposes the same values to specs, and a unit test parses the shell file to pin the two together.

### Four facts that changed the plan

**MinIO cannot be pulled any more.** The issue asked for MinIO. `minio/minio` and `quay.io/minio/minio` both answer *not found*, for `latest` and for a pinned release. Upstream Langflow hit the same wall and moved its own S3 tests to SeaweedFS (`.github/workflows/ci.yml`, step *Start S3 server*: `chrislusf/seaweedfs:4.47 server -s3`). The lane uses that exact image and command. With no S3 config it accepts any credentials, so the fixture keys are sentinels and not real access keys. Measured: the destination test answers `files: ok`, and the files copy writes `langflow/<user_id>/instance-migration-seed-file.txt` into the bucket.

**The nightly cannot copy a knowledge base.** The image has no `pgvector` Python package. The destination test then answers `pgvector_package_missing`, and the knowledge base copy can never start. The user doc tells an operator to install `langflow[pgvector]`. The lane does the same: it builds a derived image that adds `pgvector==0.5.1` and nothing else, rebuilt on every start so it always sits on the base that was just pulled. That takes about 9 s when the base changed and is a cache hit when it did not. This is the lane's one deliberate difference from the shipped image, and #2353 has to know it is there.

**Without seed data, two of the copies are unreachable.** On an empty instance the page marks `copy_knowledge_bases` and `copy_files` `skipped` (`no_local_knowledge_bases`, `no_local_files`). The start script seeds one flow, one uploaded file and one knowledge base through the API, the way a user would. The knowledge base create path calls no provider, so it needs no key. The script then adds three vectors through the app's own store, the way upstream's `scripts/migration_rehearsal/seed_instance.py` does (the idea, not the code). Ingesting real vectors would need an embedding provider and its key. Two traps were hit and are now encoded in the script:
- The vectors are **unit length**. With raw values the copy refused with `kb_metric_change`: the source ranks by l2 and pgvector by cosine, and only unit vectors rank the same under both. That refusal is a decision a spec may want to reach on purpose (`accept_ranking_change`), but the seed should not force it on every run.
- A fresh Python process inside the container does not find the server's SQLite file on its own. The server keeps it in the package directory. The script reads the path from `GET /api/v1/migration` and creates the database service **before** importing the `lfx` backends. Done in the other order, the session opened an empty database and found no knowledge base at all.

**The PostgreSQL image answers "ready" before the database exists.** Its entrypoint first runs a temporary server that listens only on the socket. `pg_isready` on the socket said yes to it, and `CREATE EXTENSION` then failed with `database "langflow_target" does not exist`. The script asks over TCP, where only the final server listens.

### The walk the lane makes possible

The lane was driven through the whole flow over the API, twice in a row with a reset in between. These are the shapes #2349–#2353 will meet:

| step | measured |
|---|---|
| *Check this instance* | `POST /checks` streams NDJSON, one `check` event per check and then the report, ~16–22 s; all 12 checks `ok` on the seeded source |
| destinations | `PUT /destinations` with all three parts → `database`, `vectors` and `files` all `ok`; no sentinel appears in the response |
| secret key | the fingerprint of `IM_SECRET_KEY` (`e4a7b5ecdd4f`) verifies with `200` |
| pause | `POST /pause` → `200`; then the pause step reads `blocked: recheck_pending` until *Check this instance* runs again **during** the pause |
| backup | *I've backed up everything* answers `409 database_not_downloaded` until *Download the database* has run; the download is a valid SQLite file (~6.7 MB) |
| database copy | `202` with a `run_id`; the events end with `done`; 63 tables, 55 rows, ~11–22 s |
| knowledge base copy | `done`; the target gains a pgvector table holding exactly the 3 seeded vectors; the **source** row stays on `sqlite` |
| files copy | `done`; one object under the bucket's prefix |

---

## Tags *(required)*

`@instance-migration` is a **lane selector**. It belongs in `CLAUDE.md`'s cross-cutting table beside `@destructive`, `@enterprise` and `@serving`, and not in the functional table, for the reason the `@serving` doc gives: `grepInvert` matches on it, so it decides whether a spec runs at all. Specs carry it **together with** functional tags for their area. #2353 plans `@instance-migration @settings @database @files`. `PW_INSTANCE_MIGRATION=1` selects the run and the tag marks the test, kept apart for the same reason `PW_ENTERPRISE` is kept apart from `@enterprise`.

**It is serial**, for a cause neither of the other serial lanes has. There is one migration record per instance, and its pause refuses every write outside the migration routes. A second worker would either overwrite the first one's record or fail its own writes mid-test. `lane.test.ts` asserts `serial === true` for this lane, so flipping it fails a test.

**Precedence**, when several lane flags are set, is `@enterprise` > `@instance-migration` > `@serving` > `@destructive`. The order is by how specialised an instance each one demands. Instance migration needs the image plus one package plus two companion services, which is more than serving's configuration-only variant and less than a separate Enterprise build.

**Never with `@stable`.** No scheduled lane runs it, so the tag would mark a test that never runs (#1010). #2348 is the exception the tracker names: it asserts the feature is **off**, so it runs on the normal lane and does not carry this tag.

---

## Step by step *(required)*

**1 — the selector, in `tests/fixtures/lane.ts`.**
`PW_INSTANCE_MIGRATION=1` selects the lane, which returns `serial: true` and excludes the other three selectors. Every other invocation excludes `@instance-migration` through `grepInvert` and says so in a notice that carries the command to run it.

**2 — every other list of lane tags.**
A lane tag that one list knows and another does not is a silent gap, so all of them gain it in the same change:
- `scripts/lib/stable-tests.ts` `LANE_TAGS` — the orphan reconciler must not read a lane-gated test as an unowned `@stable` removal;
- `scripts/lib/inherited-backlog.ts` `LANE_SELECTORS` — the backlog must not count it as debt;
- `scripts/destructive-only-selection.mjs` and its warning in `pr-validation.yml` — a PR whose selection is only `@instance-migration` specs would otherwise reach `npx playwright test`, match nothing and go red on `No tests found`. That is the red PR #2169 hit for `@serving`, and here it is prevented before the lane's first spec exists;
- `scripts/run-e2e.sh` — `STABLE_AREAS` refuses it like the other lane tags;
- the rendered texts that list the lane-gated tags (`render-impacted-summary.mjs`, `stable-orphans.ts`).

**3 — `scripts/start-langflow-instance-migration.sh`.**
It starts the three containers above, waits for each one (the destinations come up while the source boots), and fails rather than reporting a healthy start whenever:
- `LANGFLOW_WORKERS` is anything but `1` — refused, never overridden;
- the port answers with a different version than the container runs (the shadow check from the serving script — a loopback bind beats docker's publish);
- `GET /api/v1/migration` is not `200`, which means the routes were not mounted. The flag is read back from what the server mounted, never trusted from the `-e` line;
- a seed request fails, the vector seed does not confirm its count, or any step is still `skipped` after seeding.

The source's environment mirrors `start-langflow-docker.sh` line for line. The unit test reads that script's block at test time, so a variable added there fails this lane's test instead of making the lane quietly different. Only the port, the forced single worker and the lane's four variables differ: the flag, the secret key, the config directory, and the derived image the source runs on. The source publishes on **loopback** by default, like `start-langflow-source.sh`, because it runs auto-login with a known superuser and a known secret key. `LANGFLOW_BIND_HOST` opts out. The database and the bucket are always loopback-only. The script only ever removes its own three containers, never `langflow-e2e-runner`.

**4 — the reset between tests, and why it is a script.**
The issue offered two options. Both were measured on this machine:

| option | cost | what it loses |
|---|---|---|
| **a reset script** (chosen) | **1.3 s** bare, **2.2–3.6 s** with every part verified | nothing the lane needs |
| a fresh source container per spec file | **44.9 s** to healthy, plus the re-seed | the seed, which dies with the container's SQLite database |
| (for reference) `docker restart` of the source | 36.4 s | nothing, but it is still ~10× the reset |

`./scripts/reset-langflow-instance-migration.sh` (called from specs as `resetInstanceMigration()`) does four things, then **verifies** each one and exits non-zero naming what did not reset:

1. it stops any run still going — the `python -m langflow <command>` children of the server, found through `/proc` because the image has no `ps`;
2. it removes `LANGFLOW_CONFIG_DIR/migrations/`: the record, the runs and their locks. The pause is a field of that record, and a missing record reads as "not paused" *(code, and measured: writes answer `201` again)*;
3. it drops and recreates the target database and runs `CREATE EXTENSION vector` again;
4. it deletes and recreates the bucket.

Measured against a copy that was still running: the child was gone, the record was gone and the target database was empty 3 s later. A full migration then ran through all three copies again. The first version of the stop step matched its own shell, whose command line holds the pattern as text, and killed itself. It now matches only the first three arguments of each process.

**What the reset deliberately leaves alone:**
- **The source's data.** A migration does not write to the source. Measured: the knowledge base copy leaves the source row on `sqlite`. So the seed survives every reset. What a spec adds to the source itself is that spec's to clean up.
- **The destination secrets in the worker's memory** *(code: `_secrets` in `api/v1/migration.py`)*. The reset record names no destination, so no step can use the old secrets until a destination is saved again, and that save replaces them. This could not be observed over the API, because no route exposes them. A spec that asserts what a **restart** forgets has to run `docker restart langflow-instance-migration` itself and pay the 36 s.
- **`pause.lock`.** The server recreates this empty file on its next request. It is a lock, not the record, and does not pause anything.

**5 — docs.** A `CLAUDE.md` row for the tag, and this document.

---

## Validation criterion *(required)*

- `npm run test:units` passes with `lane.test.ts` covering the fourth lane. `PW_INSTANCE_MIGRATION` selects it, every other invocation excludes it, it cannot be co-selected with another selector, its precedence is as stated, and it is `serial: true`. Flipping that to `false` must fail a test.
- `instance-migration-lane.test.ts` parses `scripts/lib/instance-migration-lane.sh`, and every default must match in both directions. The secret key is a valid Fernet key whose fingerprint is `e4a7b5ecdd4f`, and the reset helper rethrows the script's own words.
- `npm run test:scripts` passes with `start-langflow-instance-migration.test.mjs`. The env block matches `start-langflow-docker.sh`, the source binds to loopback by default, a second worker is refused before any docker call, and only the lane's own containers are removed. A shadowed port, unmounted routes, an unconfirmed vector seed and a step still skipped each fail the start. The reset stops runs before it removes the record and empties the target, and a reset that left anything behind fails naming what. The `@instance-migration` cases in `destructive-only-selection.test.mjs` and the starter's entry in `fake-oauth-registrations.test.mjs` pass too.
- **Live:** the start script brings the lane up on the current nightly, reports `Langflow Nightly`, and seeds all three pieces. A full migration over the API then reaches `done` on all three copies, with 3 vectors in the target's pgvector table and one object in the bucket. A reset returns the record to its first step, and writes answer `201` again.
- `npx playwright test --grep @instance-migration` selects **zero** tests until #2349, and with `PW_INSTANCE_MIGRATION` unset it must select zero even after.

---

## What this does not cover *(and why)*

- **The specs.** #2349–#2353, and #2348 on the normal lane. The split has the same mechanical reason as #1582/#1583: `tests/fixtures/**` is suite-wide for `impacted-specs-by-import.mjs`, so this change resolves to every spec. Specs bundled into it would have their validation buried inside a full-suite run.
- **The target instance.** Starting a second Langflow on the copied database is #2354's decision (a spec or a VM routine cell). This lane provides the database and the bucket that instance would start on.
- **A PostgreSQL source.** That path skips the database copy and needs `PGVECTOR_CONNECTION_STRING` on the source *(code)*. It is a different container shape and nothing in the batch asks for it.
- **OpenSearch as the vector destination.** The API accepts only `kind: "pgvector"` today *(code: `VectorsDestination`)*.
- **The QA VMs.** They have no container runtime, and this lane is three containers. A native path is possible, but nothing schedules this lane yet, so it would have no caller.
- **A scheduled lane.** Like `@enterprise` and `@serving`, nothing runs `@instance-migration` on a cron, so its specs cannot be `@stable` (#1010).

---

## Preconditions *(required)*

- Docker, with room for one more Langflow (~1.5 GiB) plus PostgreSQL and SeaweedFS (~150 MiB together, measured idle).
- Network access on the first start: the nightly, `pgvector/pgvector:0.8.6-pg16`, `chrislusf/seaweedfs:4.47`, and the `pgvector` package from PyPI for the derived image.
- Ports `7895`, `55895` and `58895` free, or overridden through `IM_PORT`, `IM_PG_HOST_PORT` and `IM_S3_HOST_PORT`.

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/router.py` — mounts the migration router only when the feature flag is on.
- `src/lfx/src/lfx/services/settings/feature_flags.py` — declares `instance_migration`, default `False`, bound from `LANGFLOW_FEATURE_INSTANCE_MIGRATION`.
- `src/backend/base/langflow/api/v1/migration.py` — every route the lane drives, the record path under `LANGFLOW_CONFIG_DIR/migrations/`, and the in-memory destination secrets the reset leaves alone.
- `src/backend/base/langflow/api/utils/migration_pause.py` — the pause middleware: the `503` refusal, the allowed paths, and "a missing record means not paused", which the reset relies on.
- `src/backend/base/langflow/api/utils/migration_runs.py` — runs as `python -m langflow <command>` children with their files under `migrations/runs/`, which is what the reset stops and removes.
- `src/backend/base/langflow/api/utils/migration_probes.py` — the destination tests: `db_not_empty`, `pgvector_package_missing` / `pgvector_missing`, and `bucket_missing`.
- **Langflow API** — `GET /api/v1/version`, `GET /api/v1/auto_login`, `GET /api/v1/migration`, `POST /api/v1/flows/`, `POST /api/v2/files`, `POST /api/v1/knowledge_bases/`.
- **Images** — `langflowai/langflow-nightly:latest`, `pgvector/pgvector:0.8.6-pg16`, `chrislusf/seaweedfs:4.47`.
- **No provider key, no model.**
