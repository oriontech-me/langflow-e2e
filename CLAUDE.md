# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**What belongs here.** This file loads into every agent session, so it holds standing rules and pointers only. A mechanism's narrative (measurements, traps, history, the why) goes in `docs/infra/<mechanism>.md`, and the bullet here keeps the rule plus a link. `scripts/check-claude-md-budget.mjs` fails a PR that takes a guide past its size budget or any one block (a bullet with its nested lines, a paragraph, a table) past 3,000 bytes, and refuses `@path` imports, which load a whole file into every session (#2542).

## Language

**All content in this repository must be written in English** — without exception.

This applies to:
- Test files (`.spec.ts`): test names, `test.step()` labels, comments, and `test.describe()` blocks
- Spec documents under `docs/` and area `CLAUDE.md` guides
- Checklist and guide files (`QA-CHECKLIST.md`, `QA-SCENARIOS-GUIDE.md`, `CONTRIBUTING.md`, etc.)
- Inline code comments and JSDoc in `.ts` / `.js` files
- GitHub Actions workflow comments and issue/PR body strings

If you receive a prompt in another language, respond and write all generated content in English regardless.

## Project Overview

This is an independent end-to-end regression test suite for [Langflow](https://github.com/langflow-ai/langflow), built with Playwright and TypeScript. It tests any running Langflow instance via URL — it is fully decoupled from Langflow's source code.

## Environment Setup

Copy `.env.example` to `.env` and configure:

```
PLAYWRIGHT_BASE_URL=http://localhost:7860/
LANGFLOW_SUPERUSER=langflow
LANGFLOW_SUPERUSER_PASSWORD=langflow123
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

Start a Langflow instance before running tests:

```bash
./scripts/start-langflow-docker.sh           # Docker — nightly (langflowai/langflow-nightly:latest)
./scripts/start-langflow-docker.sh 1.5.1     # Docker — a released version (langflowai/langflow)
LANGFLOW_IMAGE=langflowai/langflow:latest ./scripts/start-langflow-docker.sh   # any exact image
./scripts/start-langflow-pip.sh              # Via pip (local dev)
./scripts/start-langflow-source.sh           # From a local source clone (the only option where containers are unavailable)
./scripts/stop-langflow-docker.sh            # Stop Docker instance
LANGFLOW_PORT=7861 ./scripts/stop-langflow-source.sh   # Stop a source instance, by port
```

The source starter needs `uv` and a **frontend build in the clone** — `make -C <clone>
install_frontend build_frontend`, once. `src/backend/base/langflow/frontend/` is
gitignored upstream, so a fresh clone has none, and without it the backend still
answers `/health_check` with 200 while serving no UI at all: the start looks perfect
and every browser spec dies at page load. The starter refuses instead of building,
because the build writes into a clone it has promised not to touch. It also binds
**loopback** by default (unlike the pip starter's `0.0.0.0`): the target is a shared
VM, where these flags otherwise publish an auto-login instance with a known superuser
to anything that can route there. `LANGFLOW_BIND_HOST` opts out.

## Test Commands

```bash
npm test                                      # Full suite
npm run test:core                             # Core tests (release-critical)
npm run test:extended                         # Extended tests
npm run test:features                         # core + extended
npm run test:integrations                     # Integration tests
npm run test:unit                             # Unit tests
npm run test:regression                       # Regression tests
npm run test:units                            # TypeScript unit tests (scripts/ + tests/helpers/)
npm run test:scripts                          # .mjs unit tests for scripts/
npm run test:grep <pattern>                   # Filter by grep pattern
npx playwright test tests/path/to/file.spec.ts  # Single file
npm run report                                # Open HTML report
npm run typecheck                             # TypeScript check (tsc --noEmit)
npm run lint                                  # ESLint (same check as PR CI)
```

Filter by tag: `npx playwright test --grep "@api"` — available tags listed in the Tag Semantics section below.

## What to work on

`ROADMAP.md` is the source of truth for **direction and order** — it schedules the
decided backlog into 2-week waves. Each dated wave is a GitHub milestone named after
its `### Wave N — Axis` heading; its work items are the issues labeled `roadmap`
assigned to it. Before picking up work, take an open issue from the current wave:

```bash
gh issue list --label roadmap --milestone "Wave N — Axis"
```

Off-wave work is allowed **only** when it traces to an approved exception issue: a
follow-up, a `daily-failure` triage issue, or a `community`-labeled regression
(worked in severity order — `high` → `medium` → `low priority` — when indicated;
see `ROADMAP.md` → *Intake*). No exception issue ⇒ it belongs to the current wave.

Do not restate the current wave here — it changes every cycle; follow the pointer.

## Architecture

### Test Infrastructure

- **`tests/fixtures/fixtures.ts`** — Always import `test` from here, never directly from Playwright. It extends the base `test` with backend HTTP error monitoring and flow execution error detection, and **the two are not equally strong** (#1084):
  - A **`flow_error` fails the test** on both run surfaces: v1 (`/build/`, `/run/`, `/events`) and v2 (`POST /api/v2/workflows`, captured as it streams by `tests/fixtures/run-stream-capture.ts`). The policy is `tests/fixtures/flow-error-policy.ts`. A provider outage delivered inside the stream (quota, drained credits) is reported as **unevaluated**, never as clean and never as a failure. Keep its `PROVIDER_OUTAGE_PATTERNS` in agreement with `run-node-and-wait.ts`'s `TRANSIENT_PATTERNS`.
  - An **`http_error` is logged and never fails the test**, on any path. The only thing between a real backend 500 and a green run is a human reading `🚨 Backend Error` in the log (checklist step 4 below). What gets logged is decided by `tests/fixtures/http-error-policy.ts`: every 4xx/5xx on `/api/` except auth endpoints and the external Store. `PW_HTTP_ERROR_DEBUG=1` prints what it ignored.
  - Escape hatches: `page.allowFlowErrors()` for tests that provoke execution failures; `page.allowHttpErrors()` for tests that drive an endpoint into a 4xx/5xx on purpose; `page.expectKnownHttpError({ pathname, status, reason })` for a spec that only passes through a filed product defect. The last one quietens exactly that status and pathname, and **fails the test if the declared defect does not fire**, so a stale declaration names itself.
  - `page.flowErrorReport()` lets a spec read the gate's accounting. A caller **must assert `evaluated > 0` alongside `clean`** (`clean` is vacuously true when nothing was evaluated), and the report is **cumulative for the whole test**, not per run.
  - An HTTP error's body is recorded as read, empty, or never obtained (with the reason). `tests/fixtures/http-error-body.ts` decides, and every branch prints.
  - Full mechanism, measurements and traps: [`docs/infra/error-gates.md`](docs/infra/error-gates.md). Covered by `npm run test:units` and the behavioural `tests/fixtures/{http,flow}-error-gate.spec.ts`.
- **Component availability is a packaging decision, per image (#1040)** — `docs/component-distribution-policy.md` is the standing answer; do not re-decide it per incident. Most families moved out of `lfx.components.*` into per-vendor distributions, and the source tree does **not** map 1:1 onto the catalog, so never answer an availability question by reading the tree. `probe-component-available.ts` checks presence; `probe-component-buildable.ts` checks that it builds. `globalSetup` reports catalog drift against `tests/assets/catalog/component-catalog-baseline.json`. It **warns, never fails**, and reports `UNKNOWN` rather than clean when it cannot decide. Accept expected drift with `npm run catalog:baseline` (a committed diff, on purpose).
- **Spec-doc dependency paths are resolved in CI** — `pr-validation.yml`'s **Spec-doc dependency paths** job (`scripts/watch-upstream-areas.mjs --mode=check-docs`) resolves every backticked `src/…` path in a doc's `## External dependencies` against upstream `main` and the release lines. An unresolvable path in a doc **the PR changed** fails; a pre-existing one warns. **Write upstream paths in full**: a path written with an ellipsis is a defect the job reports, not a skip, and an abbreviation such as `api/v2/hitl.py` is invisible to that resolver, so `--mode=check-doc-abbrevs` reports it. A token named only to say the spec does *not* depend on it goes in `scripts/lib/doc-dep-abbreviation-declarations.json`. `scripts/validate-spec-deps.ts` only checks that the section is populated and runs in no workflow. Full record: [`docs/infra/component-availability.md`](docs/infra/component-availability.md).

- **`tests/pages/`** — Page Object Model (POM). `BasePage.ts` provides common navigation; `FlowEditorPage.ts`, `PlaygroundPage.ts`, `MainPage.ts`, `LoginPage.ts`, `SidebarComponent.ts` provide feature-specific selectors and actions.

- **`tests/helpers/`** — Reusable action functions organized by domain: `api/`, `auth/`, `filesystem/`, `flows/`, `mcp/`, `ui/`, `other/`.

- **`tests/assets/`** — Static test data: `files/` (PDFs, docs), `flows/` (pre-built flow JSONs for import), `media/` (images).

### Test Organization

All tests live under `tests/tests-automations/regression/`, organized by feature area:

```
regression/
├── api/flows/                          # REST API tests
├── core-functionality/
│   ├── auth/
│   ├── llm-agents/
│   ├── model-provider/
│   ├── knowledge-ingestion-management/
│   ├── playground/
│   ├── project-management/
│   ├── templates/
│   └── observability-monitoring/
├── core-components/                    # Component configuration
├── flow-functionality/                 # Graph execution, drag-drop
├── mcp/client/, server/               # MCP integration
├── ui-ux/                             # Interface tests
└── smoke/                             # Quick sanity checks
```

### Writing Tests

- Use `test.describe()` and `test()` blocks; document steps with `test.step()`
- Tag every test with at least one tag (`@release`, `@regression`, etc.)
- Use helpers from `tests/helpers/` instead of writing raw Playwright calls

### Unit tests (our code, not Langflow)

Specs cover Langflow; **unit tests cover this repo's own code** — the `scripts/` that
generate the release signal, the guards that gate PRs, the automation that edits specs on
`main`, and the helpers under `tests/helpers/`. A unit test goes **next to the code it
covers**, named `*.test.ts` (`*.test.mjs` for the `.mjs` scripts) — e.g.
`scripts/lib/stable-tests.ts` → `scripts/lib/stable-tests.test.ts`. Run with
`npm run test:units` (TypeScript, `node --test` via ts-node's require hook) or
`npm run test:scripts` (`.mjs`); both gate every PR. Never validate a helper in a scratch
file outside the repo (#1017). Full rules — the runner trade-off, how to make a script
importable, `testMatch`/discovery gotchas — in `CONTRIBUTING.md` → **Unit tests**.

**Test validation checklist** before marking complete (from CONTRIBUTING.md):
1. Run with full trace (`--trace=on`) and verify steps match screenshots
2. Force a failure to confirm no false positives
3. Walk through in debug mode (`--debug`)
4. Confirm no backend errors logged (`🚨 Backend Error:`) — **this step is a real gate, not a formality: an HTTP error never fails the test on its own** (#1084)
5. Update `QA-CHECKLIST.md` coverage symbols

**PR review checklist** — request changes if any of these are missing:
- The PR links a **current-wave item** or an **approved exception issue** (follow-up / `daily-failure` / `community`, in severity order) — see `ROADMAP.md`
- `@stable` is present **or** its absence is explicitly explained: utility specs state the reason in the spec doc's **Tags** section; temporary removals are tracked via a GitHub issue (no spec doc change required)
- Spec doc exists under `docs/` mirroring the test's path under `regression/`
- Spec doc has all mandatory sections filled: **What this test validates**, **Tags**, **Validation criterion**, **External dependencies**
- `Last validated` field reflects the current Langflow release cycle (e.g.: `1.10.x`)

### Tag Semantics

Tags are split into two groups: **cross-cutting** (severity/layer) and **functional** (product area).

**Cross-cutting**

| Tag | When to apply |
|---|---|
| `@stable` | Team-validated test — runs in the weekly workflow; failures open an issue for triage |
| `@release` | Happy-path flows required before any deploy |
| `@regression` | Tests for previously fixed bugs |
| `@api` | Tests exercising REST API endpoints |
| `@components` | Canvas/sidebar component configuration |
| `@workspace` | Flow/folder/canvas management |
| `@database` | Tests with persistent saved state |
| `@mainpage` | Home/dashboard UI tests |
| `@destructive` | Test mutates account-wide state. **Lane selector**: excluded from every normal run by `grepInvert`; run alone with `PW_DESTRUCTIVE=1 npx playwright test --grep @destructive` (workers pinned to 1). **Scheduled**: the VM daily runs `@stable` + `@destructive` on shard 1's backend after its round (#2142) |
| `@enterprise` | Targets a Langflow **Enterprise** instance. **Lane selector**, serial (login is rate-limited per IP): `PW_ENTERPRISE=1 npx playwright test --grep @enterprise` with `PLAYWRIGHT_BASE_URL` pointed at the instance. **Never combine with `@stable`** (#1010) |
| `@serving` | **Lane selector**, the only parallel one: the OSS nightly under serving-plane end-user identity. Start it with `./scripts/start-langflow-serving-identity.sh`, then `PW_SERVING_IDENTITY=1 npx playwright test --grep @serving`. **Scheduled**: the VM daily runs `@stable` + `@serving` after the shards, one backend per variant (`scripts/lib/scheduled-lanes.mjs`, #2142) |
| `@instance-migration` | **Lane selector**, serial: a source Langflow with instance migration (*Settings > Migration*) and its two destinations (not the schema-upgrade migration). Start it with `./scripts/start-langflow-instance-migration.sh`, then `PW_INSTANCE_MIGRATION=1 npx playwright test --grep @instance-migration`. **Never combine with `@stable`** (#1010) |

Lane precedence when several flags are set: `@enterprise` > `@instance-migration` > `@serving` > `@destructive`, resolved in `tests/fixtures/lane.ts`. Full lane contracts: [`docs/infra/tags.md`](docs/infra/tags.md).

**Functional** (product area — use alongside cross-cutting tags)

| Tag | Area |
|---|---|
| `@model-provider` | Provider configuration, API keys, model modal |
| `@agents` | LLM agent behavior, reasoning, steps |
| `@mcp` | MCP integration (server and client) |
| `@playground` | Chat playground and interactions |
| `@auth` | Authentication, login, session, user management |
| `@observability` | Traces, latency, tokens |
| `@files` | Files page, upload, Read File / Write File components |
| `@templates` | Starter projects and flow templates |
| `@settings` | Navigation and configuration on the Settings page |
| `@ui-ux` | General interface, shortcuts, appearance |
| `@a2a` | Agent-to-Agent protocol (publishing a flow as an A2A agent, the `A2AAgent` component). Needs `LANGFLOW_A2A_ENABLED=true`; specs call `requireA2aEnabled()` first |
| `@authz` | Enterprise **authorization** (roles, assignments, shares, teams, audit log). Always with `@enterprise`. Needs the RBAC container variant (`LANGFLOW_EE_RBAC=1 ./scripts/start-langflow-enterprise.sh`); specs gate on `authz_enabled: true` **and** `superuser_bypass: false` |
| `@governance` | Catalog and model-provider policy, as shipped in OSS. Always with `@destructive` (the policy is instance-global). RBAC is out of scope |
| `@integrations` | **Dedicated Integrations**: the `Connection` entity, the capability manifest and effective policy, `/settings/connections`, and connector reachability. Not a lane selector. Lanes and starters set fake OAuth registrations and fake deployment sites (`scripts/lib/fake-oauth-registrations.json`, `scripts/lib/fake-integration-sites.json`) |
| `@evals` | **Evaluations** (Langflow 1.14): datasets, flow evaluations and their runs (`/api/v1/datasets`, `/api/v1/evaluations`, `/api/v1/evaluation-runs`) and the evals UI. On by default (`feature_flags.evals`). Not a lane selector |

Details for the specialised functional tags: [`docs/infra/tags.md`](docs/infra/tags.md).

## CI/CD

GitHub Actions workflows:

- **`pr-validation.yml`** — Runs on every PR to `main`; every job must pass before merge. Jobs: typecheck (`tsc --noEmit` plus three unit lanes: `npm run test:scripts`, `npm run test:units`, and `npm run test:pipeline` for `.claude/skills/`), ESLint, the **QA-CHECKLIST guard** (generated blocks, the spec↔doc↔checklist triad, the `@stable` ownership guard), the **Spec-doc dependency paths** job, and the impacted-specs E2E run.
  - **E2E specs are selected by import graph** (`scripts/impacted-specs-by-import.mjs`): a changed helper or Page Object selects every spec that imports it, transitively. `tests/fixtures/**`, `playwright.config.ts` and the global hooks are suite-wide. The selection is capped (`IMPACTED_SPEC_CAP`, default 20, `@stable` first), and dropped specs are listed, never silent.
  - **A CI-only diff is classified** by `scripts/ci-change-coverage.mjs` as `canary` (runs a fixed 3-spec set), `dispatch` (names the workflow to dispatch, checking that it can be dispatched), `vm-only` or `none`.
  - **Provider-dependent specs** (`scripts/provider-dependent-specs.mjs`): one the PR changed itself forces the `Collect models` sweep; one pulled in only by an import is excluded and announced, except a spec that consumes the sweep's output (`models.json`, the resolvers), which still forces it. If the exclusion would empty the run list, the sweep is forced instead.
  - The run summary is rendered by `scripts/render-impacted-summary.mjs`. **Put lane logic in a script whose tests assert on output, not inline in YAML** (#1226): a regex guard over workflow text pins a spelling, not a behaviour.
  - Full mechanism: [`docs/infra/pr-validation.md`](docs/infra/pr-validation.md).
- **`daily-stable.yml`** — **Disabled since 2026-10-02 (#2159), kept as the way back** (`gh workflow enable daily-stable.yml`). The daily runs on the QA VM (`ops/vm/run-daily.sh` → `scripts/run-e2e.sh`, see `ops/systemd/README.md`). It runs only `@stable`, opens a `daily-failure` umbrella issue on failure, and writes `reports/daily-history.jsonl`. On the VM, `run-e2e.sh` keeps the run-integrity guard (a zero-test run is an infra abort) and the listing-completeness check (a `@stable` spec file that entered no shard fails the day, #1812/#1818). It does **not** run the coverage verdict, and its shards balance on its own ledger of durations. `reports/spec-durations.json` is frozen since the workflow was disabled; when the workflow ran, its refresh step read that file as input, so it must never be written with `>`. Full mechanism: [`docs/infra/daily-lane.md`](docs/infra/daily-lane.md).
- **When the QA VM cannot reach the destination** (the `destination-reachability` alert on Slack, or a daily that ran an old suite and opened no umbrella), follow `ops/runbooks/destination-unreachable.md`. It holds the deadline for each step (wait, temporary mode, network ticket) and the commands to enter and leave temporary mode. Do not switch the daily to this public repository outside that runbook: the fallback lasts only while both repositories exist (migration plan, open decision nº 10).
- **Infra exemptions from `@stable` removal and flake quarantine** — a hard failure whose error carries a transport-level signature is exempt from auto-removal. An earlier attempt exempts only with a measured outage window on its own shard (#1589). An assertion-shaped failure inside a measured outage can demote a *flake* (outage overlap ≥ 0.5, #1763), but **never** `@stable` auto-removal. Full rules: [`docs/infra/stable-exemption.md`](docs/infra/stable-exemption.md).
- **What a provider-health skip does to a lane's verdict (#1456, #1800)** — `scripts/lane-coverage-verdict.mjs` reads the run's JSON report: `covered`, `degraded` (a provider-health skip, other tests ran; stays green and says what was not covered) or `uncovered` (a provider-health skip and zero tests executed). Failing is a separate question (`shouldFail()`, which sets the exit code only under `--fail-closed`): an unreadable report always fails; with no provider-health skip nothing fails; with one, an account `providers.json` records as dry fails, and an `uncovered` run fails unless the account is demonstrably alive, or always with `--fail-on-uncovered` (set only by the disabled `daily-stable.yml`; the VM daily does not run this verdict). The skip reason text is a contract: produce and parse it only through `scripts/lib/provider-health-reason.mjs`. Full mechanism: [`docs/infra/coverage-verdict.md`](docs/infra/coverage-verdict.md).
- **`manual.yml`** — Parameterized manual run: a Docker tag or full URL, a test suite, and an optional grep. `provider` (`auto` / `openai` / `anthropic` / `google` / `all-models`) makes it **the only lane that can run multi-provider**. A selection it cannot honour exits 1 rather than running something else. `any_completion_provider: ollama` and `retries` exist only for the #1187 adoption gate. **It cannot finish the full suite at any timeout; dispatch it with `test_tag=@stable`** (lane-gated specs are unreachable there). Recorded cadence: one `provider=auto` + `test_tag=@stable` dispatch per release-candidate cycle, at least 2 business days before sign-off. Full detail, including **What `manual.yml` can actually run**: [`docs/infra/lanes-and-services.md`](docs/infra/lanes-and-services.md).
- **Lane services and shared helpers** ([`docs/infra/lanes-and-services.md`](docs/infra/lanes-and-services.md)):
  - **Local Ollama** (`ghcr.io/<repo>/ollama-e2e:llama3.2-1b`, weights baked in; `scripts/start-ollama-source.sh` on the VMs) for `ollama-provider.spec.ts`, via `OLLAMA_BASE_URL`, `OLLAMA_BASE_URL_FROM_LANGFLOW` and `OLLAMA_TEST_MODEL`.
  - **Self-hosted echo endpoint** (`go-httpbin`, resolved into `ECHO_BASE_URL` by `.github/actions/resolve-echo-endpoint`; `scripts/start-echo-source.sh` on the VMs). It must be a **raw IP**, never a single-label host. Echo specs never call the public internet.
  - **Post-collect-models health gate** (`.github/actions/wait-for-backend`, 420 s) between `Collect models` and the run, on every lane that shares one container between them. When the backend does not recover, it names the wedge instead of an unattributed timeout.
  - **`--grep` composition**: compose multiple filters only through `scripts/build-grep-filter.mjs`. **Never compose a lookahead around an interpolated variable in YAML**, and pass dispatch inputs to `run:` through `env`, never `${{ … }}`.
- **Retired workflows (#2171)** — `nightly.yml`, `weekly-stable.yml`, `adaptive-impacted.yml` and `file-watcher.yml` were deleted, all of them `disabled_manually` and none with a run since June (two never ran at all), together with the composite action `.github/actions/auto-remove-stable` (its last caller was the weekly; the VM lane removes `@stable` through the same scripts, inline in `scripts/run-e2e.sh`) and the adaptive lane's `scripts/impacted-tests.ts` and `scripts/check-nightly-delta.ts`. The upstream-area table stays in `scripts/watch-upstream-areas.mjs`: its `--mode=check` and `--mode=detect` now run by hand, and its doc modes keep running in `pr-validation.yml`. Their history is in git.
- **Scheduled workflows moved to the QA VM** — disabled in Actions, not deleted: each file stays as the way back (`gh workflow enable <file>`), and each was switched off once its VM routine had shown the same result (days in parallel with the same verdict, or a rehearsal on the VM that produced the same report). The routines, their schedules, their absence alarm and where their red goes are in `ops/systemd/README.md` (*Scheduled routines*). **`migration-test.yml`, `migration-fresh-install.yml` and `migration-upgrade-with-flows.yml`** were disabled on 2026-10-10, after three weekdays in parallel with the same verdict (#2208). They are replaced by one routine, `e2e-routine-migration` (`ops/vm/run-migration.sh`, #2193): from the latest stable release below the target to the target, in 12 cells (SQLite and Postgres 16 × pip and docker × fresh install and upgrade, plus `AUTO_LOGIN` off on the four upgrades). A red opens or comments the `routine:migration` issue on the destination, where the three workflows used to open theirs on the source.
- **`issue-contract-guard.yml`** — Validates `daily-failure` issue bodies against the dedicated-issue contract (`.claude/skills/langflow-e2e-triage/references/issue-templates.md`). It **reports, never blocks**. The agent path is covered by the same action inside `triage-dispatch.yml`. Detail: [`docs/infra/issue-contract-guard.md`](docs/infra/issue-contract-guard.md).
- **`refresh-coverage-matrix.yml`** — **Disabled since 2026-10-12, kept as the way back (`gh workflow enable refresh-coverage-matrix.yml`).** The refresh of the coverage matrix's derivable axes runs on the QA VM as `e2e-routine-coverage-matrix` (`ops/vm/run-coverage-matrix.sh`, weekdays 08:45 UTC after the daily, #2211), committing `docs/coverage-heatmap/` to `main` as the workflow did. The workflow fired on the daily's completion, which ended with `daily-stable.yml`, so after 2026-10-02 only its Monday fallback ran; it was disabled once the routine had committed a day's refresh and that fallback, run the same day, found the matrix already current. Neither the workflow nor the routine posts the feed to the QA Platform: `QA_COVERAGE_MATRIX_ENDPOINT` was never set.
- **`@stable` orphans and ownership** — a spec whose tests carry no `@stable` runs in no scheduled lane, so it needs an **open** issue naming it, or a declared absence in `scripts/lib/stable-orphan-exemptions.json`. `stable-orphan-reconcile.yml` (disabled since 2026-10-11; runs on the QA VM as `e2e-routine-stable-orphans`) reports removed tags nobody owns and gate justifications citing closed issues. The **ownership guard** (`npm run check:stable-ownership`) runs in the PR lane and fails only for a spec the PR touched. Full mechanism: [`docs/infra/stable-ownership.md`](docs/infra/stable-ownership.md).
- **`update-coverage-summary.yml`** — Runs on every push to `main` that touches `QA-CHECKLIST.md`, the regeneration scripts, or `tests/**/*.spec.ts`; regenerates the Coverage Summary table and the `Phase 0 — Validated` block (counts + bulleted list) from source and commits any change with `[skip ci]`.
- **Secrets are scrubbed from every published report (#2486)** — Playwright redacts nothing (traces record request headers and every `fill()`). `scripts/scrub-secrets.mjs` removes the values of every credential-named variable from every report, blob, `results.json` and `test-results/`. **Every upload of one of those must run after a scrub step fed `${{ toJSON(secrets) }}` has succeeded** (pinned by `scripts/scrub-secrets-wiring.test.mjs`). The flag is `--dotenv`, not `--env-file`. Limits, such as a key typed into a visible field: [`docs/infra/secret-scrubbing.md`](docs/infra/secret-scrubbing.md).

## Run history (`reports/`)

Append-only JSONL log of CI runs, committed to the repo so longitudinal questions ("how many weeks did test X fail in a row?", "did failures correlate with a Langflow upgrade?") can be answered without paying for an external dashboard or extending artifact retention.

- **`reports/daily-history.jsonl`** — One line per daily run. **Written by the VM daily since 2026-10-05** (#2164): with `HISTORY_TO_SOURCE=1` (`ops/vm/run-daily.sh`), `scripts/run-e2e.sh` puts the row it adds to its ledger on the source's `main`, built with plumbing so the VM's clone is never touched, and it never changes the verdict. Until `daily-stable.yml` was disabled on 2026-10-02, it was written by `scripts/append-weekly-history.mjs` (shared appender, pointed here via the `HISTORY_FILE` override) and committed back to `main` with `[skip ci]` at the end of that workflow (even on failure, so recurring breakage is captured).
- **`reports/weekly-history.jsonl`** — Frozen history from `weekly-stable.yml` (retired in #2171). Same schema; retained for past longitudinal queries.
- **`reports/README.md`** — Schema (version 1), expansion criteria, and example `jq` queries. Read this before extending the mechanism.

The JSONL files are **machine-written and human-read only** — never hand-edit. The schema is versioned; backwards-compatible additions ship without a version bump, breaking changes bump `version` and the script branches on it. Adding a new source (e.g. `nightly-history.jsonl`) requires meeting the three expansion criteria documented in `reports/README.md` — in particular, a different failure lifecycle from existing sources.

Triage rules driven by this history (when to remove `@stable`, when to open an issue for a recurring flake) live in `CONTRIBUTING.md` under "Tag @stable — validated tests".

## REGRESSIONS.md — the Regression Ledger

Curated, append-only registry of the real Langflow regressions **the suite caught**, and the source of the ROI indicator at the top of the file. A row is added only when all three hold: a confirmed `langflow-regression` verdict, adversarial (refute-first) validation, and a filed upstream ticket (Jira `LE-####` or a `langflow-ai/langflow` issue). Confirmed but unticketed goes under **Candidates**; a finding validation downgrades to a non-user-facing gap is listed nowhere. Regressions the team confirms by hand, outside the suite, stay on the Jira board — every row must trace to a spec failure or spec-validation run recorded in a repo issue.

The block between `<!-- REGRESSIONS:START -->` and `<!-- REGRESSIONS:END -->` is **auto-generated** — never hand-edit it, and never hand-edit the counts. Edit the `## Ledger` table only, then run `npm run regressions:summary` to regenerate the block and commit both. Logic lives in `scripts/regressions-summary.ts`; it is idempotent and aborts rather than emitting a wrong count (bad marker order, missing/empty `## Ledger` section, wrong column count, invalid `Severity`/`Status`, an `Area / Test` cell without the `area · spec-file` separator, or two rows with the same `Upstream` ticket).

Unlike `QA-CHECKLIST.md`, the generated block here **is** committed in the PR that adds the row — the file changes a handful of times per quarter, so the collision risk that forced the checklist guard (issue #741) does not apply. The `pr-validation.yml` typecheck job runs `npm run regressions:check`, which fails the PR when the committed block disagrees with the table.

## QA-CHECKLIST.md

Two passages in `QA-CHECKLIST.md` are **auto-generated**:

1. The **Coverage Summary table** is derived from the bullet markers (`[x]` / `[-]` / `[ ]` / `[~]` / `[!]`) inside Part II. Never propose manual edits to the table's numbers, percentages, or `**TOTAL**` row — only edit the bullets, and the workflow regenerates the table on the next merge to `main`. Logic lives in `scripts/coverage-summary.ts`. If a new module section is added to Part II, update the `MODULES` array in the script.
2. The **Coverage Summary Note** and the **`Phase 0 — Validated`** block (header counts and bulleted list) are derived from `@stable` `test()` calls parsed out of `tests/tests-automations/regression/**.spec.ts`. Never edit those by hand. Add or remove the `@stable` tag on the relevant `test(...)` and the workflow regenerates on the next merge to `main`. Logic lives in `scripts/stable-tests.ts`.

Both regenerators run together via `npm run coverage:summary` and are idempotent — a second run produces no diff when in sync.

> **In a PR, edit ONLY the manual Part II bullets — do NOT run `npm run coverage:summary` and commit its output.** The generated blocks (Coverage Summary table + note, `Phase 0 — Validated` list, Phase 1/2 tables) are regenerated on merge to `main` by `update-coverage-summary.yml`. Committing regenerated counts in a PR makes concurrent `@stable` PRs collide on the same count lines (the recurring `QA-CHECKLIST.md` conflict — issue #741). `npm run coverage:summary` is for local inspection only; the `pr-validation.yml` **QA-CHECKLIST guard** job (`scripts/check-checklist-guard.mjs`) fails any PR that edits a generated block.

> **The bullet itself is mandatory.** The same job runs `npm run check:checklist-coverage` (`scripts/check-checklist-coverage.ts`), which fails the PR when a spec carries `@stable` **or** has a spec doc under `docs/` but no manual Part II bullet references it — that spec would otherwise be invisible in every generated count (issue #985). Only the hand-written region counts as a reference: the generated `Phase 0` block echoes every `@stable` basename, so matching the whole file is vacuous. A missing mirrored doc is **not** a defect — docs resolve by content reference, not filename.

## Playwright Configuration

Key settings in `playwright.config.ts`:
- Base URL via `PLAYWRIGHT_BASE_URL` (default: `http://localhost:7860`)
- Chromium only, with clipboard permissions
- Fully parallel, 5-minute timeout per test
- 3 retries locally, 2 retries in CI; trace captured on first retry
- HTML reporter locally, blob reporter in CI
- Browser locale `en-US` by default, resolved by `tests/fixtures/locale.ts` (`test.use(withLocale("pt-BR"))` per spec, `PW_LOCALE` per run). **It does not change the language Langflow renders**, which comes from `localStorage.languagePreference`. A spec asserting on the backend's locale must set `Accept-Language` itself. Detail: [`docs/infra/browser-locale.md`](docs/infra/browser-locale.md) and `CONTRIBUTING.md` → *Browser locale*.
