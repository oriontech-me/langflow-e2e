# Instance migration — *Check this instance* gates the version, sorts its findings, and blocks a migration that cannot succeed

**File:** `tests/tests-automations/regression/instance-migration/instance-migration-checks.spec.ts`

**Last validated:** Langflow 1.14.0.dev22 (`langflowai/langflow-nightly:latest` plus the `pgvector` package, `package: "Langflow Nightly"`), on the `@instance-migration` lane. Every fact below was measured that day over the API and on the page, unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

Owning issue: #2350 (Wave 11). Tracker: #2357.

---

## What this test validates *(required)*

*Check this instance* is the first step of instance migration (*Settings > Migration*). It runs the `migration-preflight` command against this instance and decides whether a migration may start at all. A check that wrongly passes lets a migration start that cannot succeed; a check that wrongly blocks makes the feature unusable. This spec covers the step's four promises:

1. **The target version gate.** The admin types the new instance's Langflow version. An older one is refused, a malformed one is refused as input, and an equal or newer one runs the check.
2. **The four groups.** Each failing check lands under **Fix these** (cannot be accepted) or **Fix or accept** (can), a warning under **Read these**, and the rest under **Passed**.
3. **Blocking.** While any finding is open, the steps after it cannot be used, on the page and over the API.
4. **Accept and withdraw.** An acceptable finding can be accepted, which is recorded in the migration record and opens the next step. Withdrawing it blocks again. Running the check again on an unchanged instance gives the same findings, and the acceptance carries over.

### What the measurements changed in the issue's plan

- **The seeded source has no finding at all.** The issue asked to assert findings that are "known by construction (SQLite source → a PostgreSQL destination is required; local files → S3 is required)". Measured: all **12** checks answer `ok` on the lane's seeded source (~29 s). A PostgreSQL database and a bucket are *needs*, which the page lists under the instance summary (`migration-needs`) and the next step asks for. They are not findings. Every finding this spec asserts is therefore **planted** by the test, and removed by it:

  | Group | Check | Planted with | Measured summary |
  |---|---|---|---|
  | Fix these | `source: credentials` | a `Credential` global variable whose ciphertext is overwritten in the source's SQLite file | `1 of 6 encrypted values do not open with the configured secret key`; `problems` names the row as `variable.value row <id> (<name>, owner langflow)` |
  | Fix or accept | `source: knowledge bases` | a knowledge base whose store file is `chmod 000` (the technique `instance-migration-copy.spec.ts` uses) | `1 of 2 knowledge bases have a backend that cannot be built or reached`; `problems`: `langflow/<name> (sqlite): CantOpenError: unable to open database file` |
  | Read these | `embedding models` | a knowledge base created with `embedding_model: ""` (the API accepts it; omitting the field is a `422`) | status `warn`: `… 1 record none and may need re-ingesting` |

- **"Naming both versions" holds on the page, not in the answer.** An older version answers `422 {"detail": {"code": "version_older", "source_version": "1.14.0.dev22"}}`, so the API names only the **source**. The page reads *"Older than this instance. Use 1.14.0.dev22 or newer. Preview builds of that version count as older."* under the field, and the field still holds the version the admin typed. The spec asserts both as measured.
- **A malformed version is refused, never read as `0.0.0`.** `not-a-version` and the empty string both answer `422 {"detail": {"code": "version_invalid"}}`; the page reads *"Enter a version such as 1.14.0.dev22."*. A refused version changes nothing: the step stays `current` and no check runs.
- **The admin's paste is accepted.** `Langflow v1.14.0.dev22` runs the check against `1.14.0.dev22` (`version` check: *"source and target both run Langflow 1.14.0.dev22"*). `99.0.0` runs it too, and the `version` check says the target is newer and that the instance *"cannot confirm that 99.0.0 was released"*.
- **Not every later step is refused while a finding is open, and the spec does not claim it is.** With a finding open, `PUT /destinations` answers `200` and `POST /secret-key/verify` answers `200`, and both steps then read `done`. The first route that refuses is the **pause** (`409 {"code": "locked", "reason": "earlier_step"}`), then the backup confirmation the same way. Those are the routes that change the instance, and none of them can run while a finding is open *(code: `_require_unlocked` / `_require_reached` guard `pause`, `backup`, the copies, `check_target` and `start_target`; nothing guards `connect_target` or `secret_key`)*. The page hides those two steps instead: *Where your data goes* reads *"Finish the steps above first."* with no form. So "the next step cannot be started" is asserted on the page for *Where your data goes*, and over the API on the pause, with destinations and key already saved so that the finding is the only thing in the way.
- **An acceptance lapses when the finding changes.** It is stored with the check's `summary` and `problems`, and only matches a finding with the same ones *(code: `_blocking_findings`)*. Measured by accident during the scouting: a second knowledge base moved the summary from *"1 of 2"* to *"1 of 3"*, the acceptance stopped counting, and the page read *"Changed since langflow accepted it. Review it again."*. Test 4 relies on the converse, that an unchanged finding keeps its acceptance.

---

## Tags *(required)*

| Test | Tags |
|---|---|
| 1 — the version gate | `@instance-migration` `@settings` `@api` `@ui-ux` |
| 2 — the four groups and blocking | `@instance-migration` `@settings` `@api` `@ui-ux` |
| 3 — accept and withdraw | `@instance-migration` `@settings` `@api` `@ui-ux` |
| 4 — a re-run is stable | `@instance-migration` `@settings` `@api` |

None is `@stable`: nothing runs `@instance-migration` on a cron (#1010).

---

## Precondition *(required)*

- The `@instance-migration` lane (`./scripts/start-langflow-instance-migration.sh`), run with `PLAYWRIGHT_BASE_URL=http://127.0.0.1:7895 PW_INSTANCE_MIGRATION=1 … --grep @instance-migration`. It is serial, with one worker.
- **Each test starts and ends with `resetInstanceMigration()`.** What a test plants on the source it removes itself, after the reset, in reverse order: the store file gets its mode back before its knowledge base is deleted (a `chmod 000` store is deleted with `200` once readable again), and the corrupted variable is deleted over the API (measured `204`).
- *Where your data goes* and *Hand over the secret key* are walked over the API by `saveDestinations()` and `verifySecretKey()`, split out of `prepareBeforePause()` in `migration-walk.ts`, which keeps its behaviour.
- No provider key and no model. The knowledge bases are created with an embedding provider named and never used.
- A check run takes ~30 s idle. The page's `POST /checks` is an NDJSON stream whose response event fires only with its first event, ~30 s after the click (measured), so the spec waits for it on the check's whole budget, not on a 30 s one.

---

## Step by step *(required)*

### Test 1 — the target version gate refuses an older or malformed version and runs an equal or newer one

1. Open *Settings > Migration*. The field `migration-target-version` shows the source's version as its placeholder.
2. Type `1.0.0` and click `migration-run-checks`. The page's `POST /api/v1/migration/checks` answers `422`. The field is `aria-invalid="true"`, and the error (`#migration-target-version-error`) reads *"Older than this instance. Use <source> or newer."*. The field still holds `1.0.0`.
3. Type `not-a-version` and click again: `422`, and the error reads *"Enter a version such as <source>."*.
4. Over the API, `1.0.0` and `0.9.0` answer `422 {"detail": {"code": "version_older", "source_version": "<source>"}}`, and `not-a-version` and `""` answer `422 {"detail": {"code": "version_invalid"}}`. The bodies are read here and not from the page's answers, because Chromium does not keep those for a later read (measured: *"No data found for resource with given identifier"* on the second one). The record is unchanged: `check_source` is still `current`, and the record holds no check run.
5. Over the API, `99.0.0` runs the check to its report. The report's `version` check is `ok` and says the target is newer.
6. On the page, open the step again (a done step collapses to its title), type `Langflow v<source>` and click again. The check runs to its summary (*"Nothing stops the move."*), the summary names `against Langflow <source>`, and `check_source` is `done`.

### Test 2 — planted findings land in their four groups, and an open finding blocks the next step

1. Plant the three findings in the table above.
2. Open the page, type the source's version and run the check. The summary reads *"Problems that stop the move: 2"*.
3. **Fix these** (`migration-group-fix`) holds exactly `source: credentials`, with no accept checkbox. **Fix or accept** (`migration-group-decide`) holds exactly `source: knowledge bases`, with its checkbox unchecked. **Read these** (`migration-group-read`) holds exactly `embedding models`. **Passed** (`migration-group-passed`) holds the other nine, and every check of the report appears in exactly one group.
4. The API agrees: `blocking_findings` is `["source: credentials", "source: knowledge bases"]` (the warning does not block), and `check_source` is `blocked: blocking_findings`.
5. *Where your data goes* reads *"Finish the steps above first."* and has no *Test and save* button.
6. Accepting `source: credentials` over the API is refused, `400 not_acceptable`.
7. Save the destinations and verify the secret key over the API (both `200`). The pause step is still `locked: earlier_step`, and `POST /pause` answers `409 {"code": "locked", "reason": "earlier_step"}`.

### Test 3 — accepting a finding records it and opens the next step; withdrawing it blocks again

1. Plant the unreadable knowledge base only, and run the check over the API. `blocking_findings` is `["source: knowledge bases"]`.
2. Open the page. Tick the checkbox in `migration-check-source: knowledge bases`. The page sends `POST /api/v1/migration/accepted-findings` (`200`).
3. The record's `accepted_findings` holds one entry: `name` `source: knowledge bases`, the check's own `summary` and `problems` (the planted knowledge base's name among them), `accepted_by` `langflow` and an `accepted_at`. `blocking_findings` is empty, `check_source` is `done` and `connect_target` is `current`.
4. The page reads *"Accepted by langflow on …"* under the finding and *"Nothing stops the move."* in the summary, and *Where your data goes* shows its *Test and save* button.
5. Untick the checkbox. The page sends `DELETE /api/v1/migration/accepted-findings?name=…` (`200`).
6. `accepted_findings` is empty, `blocking_findings` is `["source: knowledge bases"]` again, `check_source` is `blocked`, and *Where your data goes* reads *"Finish the steps above first."* again.

### Test 4 — running the check twice on an unchanged instance produces the same findings, and an acceptance carries over

1. Plant the unreadable knowledge base and run the check over the API. Keep the report.
2. Accept `source: knowledge bases` over the API.
3. Run the check again. Every check of the second report has the same `name`, `status`, `summary` and `problems` as the first, in the same order.
4. The acceptance carries over: `blocking_findings` is still empty and `check_source` is `done`.

---

## Validation criterion *(required)*

The spec passes three consecutive times at `--retries=0 --workers=1` on the lane, with zero `🚨 Backend Error` (test 1 calls `page.allowHttpErrors()` for the `422`s it provokes), and leaves no planted knowledge base or variable behind (`GET /api/v1/knowledge_bases/` lists only the seed's; no `IM_CHECKS_` variable).

Each test is forced to fail once:

- test 1: expecting `version_invalid` for `1.0.0` fails on the code the server sends;
- test 2: not planting the credential fails on the **Fix these** group being absent;
- test 3: skipping the click on the checkbox fails on the empty `accepted_findings`;
- test 4: planting a knowledge base with no model between the two runs fails the comparison on `embedding models`.

---

## What this does not cover *(and why)*

- **The acceptance lapsing.** Measured once, above, and not asserted: it needs a second planted change and a third check run (~30 s), and #2350 does not ask for it. It is a candidate for the tracker if the step is extended.
- **The `default superuser` and `source: files` / `source: vector counts` findings.** Each is acceptable like the knowledge base one, which stands for the class. Planting them needs a different instance configuration (`AUTO_LOGIN` off) or a missing file under the storage folder.
- **`source: schema`.** When it fails, the page shows only that check and says the others did not run *(code: `groupChecks`)*. Planting it means damaging the source's schema, which the lane's reset does not repair.
- **Two checks started together.** The server answers `409 already_running` to a second `POST /checks` while one runs *(code)*; the page disables its own button meanwhile.
- **A PostgreSQL source.** The lane's source is SQLite (`docs/instance-migration/instance-migration-lane.md`).

---

## External dependencies *(required)*

| Upstream | What this spec relies on |
|---|---|
| `src/backend/base/langflow/api/v1/migration.py` | `POST /checks` (the version prefix strip, `version_older` / `version_invalid`), `POST` / `DELETE /accepted-findings` (`not_acceptable`, `not_failing`), `ACCEPTABLE_FINDINGS`, `_blocking_findings`, `_steps`, `_require_unlocked` on the pause |
| `src/backend/base/langflow/cli/migration_preflight.py` | `check_target_version`, `check_embedding_models` (its `warn`), and the `source: ` prefix on the integrity checks |
| `src/backend/base/langflow/cli/integrity.py` | the `credentials` and `knowledge bases` checks and their summaries |
| `src/backend/base/langflow/api/utils/migration_probes.py` | the destination tests `PUT /destinations` runs in test 2 |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/CheckStep.tsx` | `migration-target-version`, `migration-run-checks`, `migration-checks-summary`, `migration-group-{fix,decide,read,passed}`, `migration-check-<name>`, the accept checkbox and its *Accepted by* line |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/catalog.ts` | `groupChecks`: failing and acceptable → *Fix or accept*, failing and not → *Fix these*, `warn` → *Read these* |

- **Langflow API**: the routes above, plus `GET /api/v1/migration`, `PUT /api/v1/migration/destinations`, `POST /api/v1/migration/secret-key/verify`, `POST /api/v1/migration/pause`, `POST` / `GET` / `DELETE /api/v1/knowledge_bases/`, `POST` / `DELETE /api/v1/variables/`, `GET /api/v1/users/whoami`.
- **Test ids**: `migration-target-version`, `migration-run-checks`, `migration-checks-summary`, `migration-group-fix`, `migration-group-decide`, `migration-group-read`, `migration-group-passed`, `migration-check-<check name>`, `migration-step-check_source`, `migration-step-connect_target`, `migration-step-pause`. The version error is found by its id, `migration-target-version-error`, which the field names in `aria-describedby`.
- **The lane**: `scripts/start-langflow-instance-migration.sh`, `scripts/reset-langflow-instance-migration.sh`, `tests/helpers/instance-migration/instance-migration-lane.ts`, `tests/helpers/instance-migration/migration-walk.ts`, and `docker exec` on the source container for the store file's mode and the variable's ciphertext.
- **No provider key, no model.**
