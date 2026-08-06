# Migration Test

Python tests that verify whether the Langflow database migrates correctly from `latest` to `nightly`. Executed by the workflow `.github/workflows/migration-test.yml`, triggered manually via `workflow_dispatch`.

## What the workflow does

The workflow starts two Docker containers sequentially against the same PostgreSQL database, simulating a real production upgrade.

### Phase 0 — Credential pre-flight

0. Spends **one token** on `OPENAI_API_KEY` before installing anything (`provider_credentials.py --probe`). Presence is not usability: run #124 passed a non-empty-secret check and then died on a drained OpenAI account *after* installing Playwright and Langflow, and filed the result as a migration failure (#1295). A `billing` / `key-rot` verdict aborts the job here; anything the probe cannot classify (network blip, unexpected response) only warns — the authoritative verdict on a migration is the migration.

### Phase 1 — Langflow Latest

1. Starts `langflowai/langflow:latest` with an empty PostgreSQL database.
2. Authenticates with the API and locates the agent template in the starter projects.
3. Creates a flow from that template.
4. Creates the `OPENAI_API_KEY` environment variable in Langflow.
5. Executes the flow via API and saves the state (flow ID, results) to `/tmp/migration-test-state.json`.

### Phase 2 — Upgrade to Nightly

6. Stops the `latest` container (the PostgreSQL database remains intact).
7. Starts `langflowai/langflow-nightly:latest` pointing to the same database — the Alembic migrations run automatically on startup.
8. Waits for Langflow to become available (180s timeout to allow time for migrations).

### Phase 3 — Verification

Two scripts verify that the migration did not break anything:

**`verify_migration_api.py`** — verifications via REST API:
- The flow created in Phase 1 still exists by the same ID.
- All flows appear in the listing.
- The `OPENAI_API_KEY` variable was preserved.
- The flow executes successfully on nightly.

**`test_ui_migration.py`** — verifications via Playwright (Chromium):
- The flow opens in the editor without component errors.
- The "Updates are available" banner is detected and reported.
- Components are updated via "Review All → Select All → Update Components".
- The flow runs in the Playground UI.
- The flow runs via API after the component update.

### Phase 4 — Report

`generate_report.py` consolidates the collected state into `/tmp/migration-report.md` with status per phase and step (`PASS` / `FAIL` / `WARN` / `SKIP` / `BLOCK`).

On failure, the workflow opens or updates an issue in the repository, including the full report and a link to the run. **Which tracker it writes to depends on the verdict (#1295):**

| Verdict | Tracker | Meaning |
|---|---|---|
| `FAILED` | `migration-test` | Something about the migration is broken — a claim about Langflow. |
| `BLOCKED (provider credentials)` | `provider-credentials` | The witness flow never reached the model provider, so **nothing about the migration was measured**. Not a claim about Langflow; fix the account or the key. |

The split exists because both are red and only one is about the product. A billing outage filed under `migration-test` gets closed by the next green run with *"Migration test passed"*, leaving a migration bug in the history that never existed. A green run closes **both** trackers, each with wording about what it actually proved.

Attribution happens in three places, all through `provider_credentials.py`: the pre-flight probe (Phase 0), the two API flow executions (`setup_latest.py`, `verify_migration_api.py`), and the compose job's two `curl` executions (`--classify-file`). A blocking verdict leaves `/tmp/credential-verdict.json`, which the report and the issue-routing steps read; its **absence** is the normal case and leaves every other verdict untouched.

## Generated artifacts

| File | Content |
|---|---|
| `test-results/` | Playwright traces and screenshots |
| `/tmp/migration-report.md` | Consolidated Markdown report |
| `/tmp/langflow-latest.log` | Latest container logs |
| `/tmp/langflow-nightly.log` | Nightly container logs |
| `/tmp/migration-test-state.json` | Raw state collected between phases |
| `/tmp/latest-digest.txt` | Digest of the latest image used |
| `/tmp/nightly-digest.txt` | Digest of the nightly image used |
| `/tmp/credential-verdict.json` | Credential verdict — present **only** when one was reached (#1295) |

## How to run manually

On GitHub: **Actions → Langflow Migration Test: Latest → Nightly → Run workflow**.

Requires the `OPENAI_API_KEY` secret configured in the repository (used to create the variable in Langflow and execute the agent flow).

## Python dependencies

```
requests
playwright
pytest
pytest-playwright
```
