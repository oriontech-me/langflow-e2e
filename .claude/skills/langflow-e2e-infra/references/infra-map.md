# Infra map — CI / scripts / config topology

One line per moving part, linking to its file or owner doc. This is an index, not
an explanation — the authoritative behaviour lives in each file's header comments,
`CLAUDE.md` (CI/CD section), and the linked docs. Verify against the live files
before acting; this list drifts.

## GitHub workflows (`.github/workflows/`)

| Workflow | Role | Notes / owner doc |
|---|---|---|
| `nightly.yml` | Daily 03:00 BRT full run vs `langflow-nightly:latest`; opens issue on failure | `CLAUDE.md` → CI/CD |
| `daily-stable.yml` | **Active stable workflow.** Weekdays 05:00 BRT, `@stable` only; opens `daily-failure` issue; appends `reports/daily-history.jsonl` | consumed by `langflow-e2e-triage` |
| `weekly-stable.yml` | **Disabled** fallback (superseded by daily-stable); writes `reports/weekly-history.jsonl` | frozen history |
| `pr-validation.yml` | Every PR: `tsc --noEmit` + ESLint + QA-CHECKLIST guard + impacted-specs gate | `#741`, `#873`, `#892` |
| `adaptive-impacted.yml` | Runs the impacted-tests subset for a PR. **`disabled_manually`** | `scripts/impacted-tests.ts`; `CONTRIBUTING.md` → Adaptive impacted-tests |
| `manual.yml` | Parameterized manual run (Docker tag / URL, suite, grep) | use to dry-run a workflow-adjacent change |
| `file-watcher.yml` | Detects upstream Langflow changes in monitored paths; opens revalidation issue. **`disabled_manually` in Actions + no cron (9da85fa) ⇒ no run history at all**; a dispatch 422s | `scripts/watch-upstream-areas.mjs` (area table + `lfx` decision record + fail-closed guard, `#1092`) |
| `triage-dispatch.yml` | Automates daily-failure triage dispatch behind an approval gate | `#785/#786/#787`, `#819` |
| `update-coverage-summary.yml` | Regenerates QA-CHECKLIST generated blocks on merge to `main` | `scripts/coverage-summary.ts`, `stable-tests.ts` |
| `migration-test.yml` / `migration-fresh-install.yml` / `migration-upgrade-with-flows.yml` | Langflow version-migration checks (latest → nightly) | `migration-test` label |
| `build-ollama-image.yml` | Builds the Ollama image used by provider specs | — |

## Composite actions (`.github/actions/`)

Where a mechanism is shared by more than one lane. Check here before adding a step
to a workflow — a copy-pasted step is how the gates diverge (`#1045`).

| Action | Role | Notes / owner doc |
|---|---|---|
| `setup-playwright` | Node + deps + browser install for a lane | — |
| `run-e2e` | Runs a suite and uploads the report | used by `manual.yml` |
| `wait-for-backend` | Post-collect-models health gate: waits out the wedge, else fails naming the state | `scripts/wait-for-backend.mjs`; `#1011/#1019/#1044/#1045` — adopted by daily/pr/manual/weekly |
| `resolve-echo-endpoint` | Points `ECHO_BASE_URL` at the lane's `go-httpbin` service | `scripts/resolve-echo-endpoint.mjs`; `#1128` |
| `guard-dedicated-issue` | Validates a `daily-failure` issue against the dedicated-issue contract | `#1035/#1037` |
| `auto-remove-stable` | Auto-removes `@stable` from hard failures | `scripts/remove-stable-from-failures.ts`, `#476` |

## Scripts (`scripts/`)

| Script | Role |
|---|---|
| `start-langflow-docker.sh` / `stop-langflow-docker.sh` | Bring a Langflow instance up/down via Docker. No arg → `langflowai/langflow-nightly:latest` (refreshed before start); a version arg → the released repo; `LANGFLOW_IMAGE` → an exact reference (`#1076`) |
| `start-langflow-pip.sh` / `stop-langflow-pip.sh` | Same via pip (local dev). Caps to 1 worker to avoid OOM (`#888`) |
| `start-langflow-source.sh` / `stop-langflow-source.sh` | Same from a LOCAL SOURCE CLONE — the only substrate on the QA VMs, where Docker and Podman cannot be installed. Keys PID file, database and config dir on the port so shards run side by side; never moves the clone unless `LANGFLOW_SRC_REF` is set. Requires `uv` (the clone's deps resolve through `[tool.uv.sources] workspace = true`, which pip does not read — it would install PUBLISHED versions instead) and a frontend build in the clone (`make install_frontend build_frontend`; the served directory is gitignored upstream, and without it `/health_check` answers 200 with no UI). Refuses to start on an occupied port and fails the moment the process it launched exits — every one of those checks exists because its absence produces a GREEN run against the wrong instance |
| `coverage-summary.ts` | Regenerates the QA-CHECKLIST Coverage Summary table (bullet markers → table) |
| `stable-tests.ts` | Regenerates the `Phase 0 — Validated` block from `@stable` `test()` calls |
| `check-checklist-guard.mjs` | PR guard: fails a PR that edits a generated QA-CHECKLIST block (`#741`) |
| `impacted-tests.ts` | Computes the impacted-specs subset for a PR |
| `append-weekly-history.mjs` | Shared run-history appender (daily via `HISTORY_FILE` override) |
| `backfill-runs.mjs` | Backfills missing run-history lines (`#849`) |
| `build-run-payload.mjs` | Builds the run-history JSONL payload for a CI run |
| `check-nightly-delta.ts` | Compares nightly versions to isolate product-vs-infra regressions (`#816`) |
| `remove-stable-from-failures.ts` | Auto-removes `@stable` from hard failures (`#476`) |
| `format-auto-remove-summary.mjs` | Formats the auto-remove summary comment |
| `validate-spec-deps.ts` | Reports which spec docs have a POPULATED `## External dependencies` section. Never resolves the paths, always exits 0, and runs only under `npm run validate:specs` — nothing under `.github/` calls it. The adjacent name is a trap: the resolution is the row below (`#1573`) |
| `watch-upstream-areas.mjs` | `--mode=detect` opens the file-watcher issue; `--mode=check` guards the area table and the `lfx` classification; `--mode=check-docs` RESOLVES every backticked `src/…` token in a spec doc's `## External dependencies` against upstream via `git ls-tree` — the `Spec-doc dependency paths` PR job. Fails on docs the PR changed, `::warning::` on the rest; resolves against `origin/main` plus the two release lines `--mode=release-ref` derives (`#1298/#1574`) |
| `wait-for-backend.mjs` | The post-collect-models health gate's polling loop, behind `.github/actions/wait-for-backend`. Classifies the failure (dead / wedged / HTTP / wiring) instead of hedging (`#1045`) |
| `watch-backend.mjs` | In-run backend liveness recorder + `--summarize` (diagnostic only, never fails a shard) (`#1030/#1048`) |
| `provider-dependent-specs.mjs` | Two verdicts for the PR lane: does the impacted set need the `Collect models` sweep, and would any spec run WITHOUT a provider it needs. Provider-dependence is read from `@agents`/`@model-provider` tags, not only from model-resolver references — the gap that let a helper-only PR (#1152) run `agent-component-regression` bare. Changed-itself ⇒ sweep; only-imported ⇒ excluded and announced (`#1216`) |
| `render-impacted-summary.mjs` | Renders the PR lane's `### Impacted specs` run summary in one pass: the resolution count, the run count (from the list actually handed to Playwright), then every caveat that qualifies them. Lives here rather than in the workflow because three wrong figures shipped from that inline shell with the lane green, each guarded only by a regex over the YAML that then missed its own mutation — the assertions are on OUTPUT (`#1226`) |
| `ci-change-coverage.mjs` | Decides what a CI-only diff gets on a PR: `canary` (the PR lane runs what changed → fixed 3-spec set), `dispatch` (another lane's surface → name it), `none`. Reachability derived from the YAML, not hardcoded (`#1159`) |

## `playwright.config.ts` knobs

| Knob | Current value | Notes |
|---|---|---|
| `fullyParallel` | `true` (unless `PW_SHARD_FILE_LEVEL`) | file-level serialization for sharding (`ISSUE-833-SHARDING-DESIGN.md`) |
| `workers` | 2 in CI, unset locally | 2-worker contention was the `#817` locus; `ISSUE-833` §workers-per-shard |
| `retries` | 2 in CI, 3 locally | trace captured on first retry |
| `timeout` | 5 min/test | |
| `reporter` | `blob` when sharded, html+github+json in CI, html locally | `blob` lives here, NOT on the `--reporter` CLI flag: the merge step can only read blobs. Flakiness.io removed 2026-08-25 (Actions-OIDC only; the daily runs on a VM) |
| `projects` | see file | Chromium only, clipboard perms |

## Run history & reporting (`reports/`)

- `reports/README.md` — schema (version 1), expansion criteria, `jq` query examples. **Read before extending.**
- `reports/daily-history.jsonl` — active, one line per `daily-stable.yml` run (machine-written, human-read only; never hand-edit).
- `reports/weekly-history.jsonl` — frozen history from the disabled weekly workflow.
