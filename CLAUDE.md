# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
./scripts/stop-langflow-docker.sh            # Stop Docker instance
```

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

- **`tests/fixtures/fixtures.ts`** — Always import `test` from here, never directly from Playwright. It extends the base `test` with backend HTTP error monitoring and flow execution error detection. **The two are not equally strong, and the difference decides how much a green run is worth (#1084):** a `flow_error` **fails** the test; an `http_error` is **logged and never fails it**, on any path, for any endpoint — so the only thing between a real backend 500 and a green test is a human reading the log (checklist step 4 below, `CONTRIBUTING.md` step 5). Which responses reach that log is decided by `tests/fixtures/http-error-policy.ts` — every 4xx/5xx on an `/api/` route except the documented exemptions (auth endpoints; the external Langflow Store, unreachable in CI). It genuinely covers 4xx/5xx now; before #1084 it matched four exact codes and silently missed 401/403/405/409/502/503, which is why `execution-error-notification` could mock a 503 specifically to slip past it. Escape hatches: `page.allowFlowErrors()` for tests that provoke execution failures, `page.allowHttpErrors()` for tests that drive an endpoint into a 4xx/5xx on purpose (keeps the advisory log trustworthy). `PW_HTTP_ERROR_DEBUG=1` prints what the policy ignored, with reasons.

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
| `@destructive` | Test mutates account-wide state (e.g. deletes every project of the shared superuser). **Lane selector, not a severity:** `playwright.config.ts` excludes it from every normal run via `grepInvert` and CI runs it alone afterwards with `PW_DESTRUCTIVE=1` (workers pinned to 1). Run it locally with `PW_DESTRUCTIVE=1 npx playwright test --grep @destructive`. Do **not** combine with `@stable` — `daily-stable.yml` has no destructive lane, so such a test would silently never run there (#1010) |

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

## CI/CD

GitHub Actions workflows:

- **`pr-validation.yml`** — Runs on every PR to `main`. Parallel jobs: TypeScript check (`tsc --noEmit`, plus the two unit lanes — `npm run test:scripts` for the dependency-free `.mjs` helpers under `scripts/`, and `npm run test:units` for everything in TypeScript), ESLint, the **QA-CHECKLIST guard** (generated blocks untouched + spec↔doc↔checklist triad, see below), and the impacted-specs E2E run. All must pass before merge. The E2E job shares one Langflow service container between its `Collect models` pre-flight and the specs, so it carries the same two guards as `daily-stable.yml` (#1019): `PLAYWRIGHT_RETRIES=0` on the pre-flight, and a health gate between the two steps that waits out the post-sweep wedge (#922/#927) and, when it does not clear, fails naming the real cause instead of letting `globalSetup` report an unattributed 120 s timeout. Both are gated on `needs_models`, so an LLM-free PR pays for neither. **The E2E work is selected by import graph, not by changed-spec glob** (`scripts/impacted-specs-by-import.mjs`, #1054): a changed helper or Page Object selects the specs that import it **transitively**, because selecting only changed `*.spec.ts` let the highest-reach change the repo can receive run zero specs (PR #1052 changed a helper reached by 112 specs; PR #1088 one imported by 135 — both reported `skipping`). A changed spec still selects itself, so the old behaviour is a subset. `tests/fixtures/**`, `playwright.config.ts` and the global hooks are **suite-wide**: they resolve to every spec and raise a visible warning telling the reviewer to dispatch `manual.yml` for the full run. The selection is capped (`IMPACTED_SPEC_CAP`, default 20, `@stable` first within each tier) and **never silently** — the dropped specs are listed in the job log and the run summary (#1012's rule). **A CI-only diff no longer skips** (`scripts/ci-change-coverage.mjs`, #1159): nothing under `tests/` imports a workflow, so the import graph honestly returns zero and the lane used to prove only that the change *parses* — PR #1157 rewired four workflows onto a new composite action with every check green and the E2E lane `skipping`. The classifier answers the other half — *does the PR lane run what changed?* — deriving reachability from the YAML itself (a workflow's `scripts/x` refs plus its `uses: ./.github/actions/y`, and each action's own refs, which is how `wait-for-backend.mjs` is reached without being named in `pr-validation.yml`). Verdicts: **`canary`** (the lane's own workflow, an action it uses, or a script it reaches changed) runs a fixed 3-spec set — two `api/flows` specs plus one UI spec, all `@stable` and LLM-free — so the lane boots Langflow and walks pre-flight → health gate → Playwright for real; **`dispatch`** (the surface belongs to another lane) names the workflows to dispatch instead of implying coverage; **`none`** stays silent. A canary run **forces** the `Collect models` sweep, because the gate is `if: needs_models` and would otherwise be skipped by the very run meant to cover it — and neutralises both consequences so a drained key cannot block a CI-only PR: the sweep becomes `continue-on-error` and the credential pre-flight is skipped (#980's trade, #884's check). A verdict the classifier cannot produce fails the step rather than degrading to `skipping`, and a canary spec that no longer exists aborts with exit 2.
- **`nightly.yml`** — **Dormant: `workflow_dispatch` only.** The `schedule` block is commented out in the workflow ("disabled until the suite is stable in production"), and the last run was 2026-03-19 — so despite the name this does not run nightly. When dispatched it targets `langflowai/langflow-nightly:latest` and opens a GitHub issue on failure assigned to @Victor-w-Madeira. Re-enabling is uncommenting the cron.
- **`daily-stable.yml`** — Runs on weekdays (Mon–Fri) at 05:00 BRT against `langflowai/langflow-nightly:latest`; runs only `@stable` tests; opens a GitHub issue on failure for triage (`daily-failure` label); appends one entry to `reports/daily-history.jsonl` and commits it back to `main` with `[skip ci]` (runs on success and failure). **This is the active stable workflow.** The `Collect models` pre-flight step shares the Langflow container with the `@stable` run and can leave it **wedged** (container alive, event loop blocked — #922/#927), so three guards keep that from costing the run: `LANGFLOW_WORKERS=1` on the service, `PLAYWRIGHT_RETRIES=0` on that step, and a health gate between the two that waits for the backend and fails with the real cause named if it does not recover (#1011). A red `Collect models` **does not** abort the shard — a drained provider key must not kill the specs that never touch it (#980). Two independent report guards run in the merge job: `shardguard` (every shard produced a blob → results are not under-counted; it runs `if: always()` so its verdict exists even when no shard produced anything to download) and `runguard` (`scripts/check-run-integrity.mjs` — the merged report actually contains tests). A **zero-test run is an infra abort, not a per-test day**: it fails loudly (fail-closed — an unknown `runguard` verdict fails too), is barred from both paths that write on the strength of the report (`@stable` auto-removal and the `spec-durations.json` refresh), and opens an issue titled *"executed ZERO tests"* instead of the usual per-test body — even when the `test` job came back green, which `--pass-with-no-tests` makes possible (#1012).
- **`weekly-stable.yml`** — **Disabled** (kept as a fallback, superseded by `daily-stable.yml`). When enabled it runs every Monday with the same machinery, writing to `reports/weekly-history.jsonl`.
- **`manual.yml`** — Parameterized manual run; accepts a Docker tag or full URL, a specific test suite, and an optional grep filter.
- **Self-hosted echo endpoint (`go-httpbin`)** — Every lane that runs echo-dependent specs (API Request component, the agent fetch-tool specs) starts a `ghcr.io/mccutchen/go-httpbin` service container and resolves `ECHO_BASE_URL` to it via `.github/actions/resolve-echo-endpoint`, so those specs never call the public internet. Built for `daily-stable.yml` (#462/#639) and extended to `pr-validation.yml`, `nightly.yml` and `manual.yml` in **#1128**, after PR #1133 lost three specs to an `httpbin.org` 504 that read like a product failure. Two things make this non-obvious and are encoded in the action: Langflow's `validators.url()` **rejects a single-label host**, so the variable must be a raw container IP (never `http://go-httpbin:8080`), and its SSRF layer blocks private addresses unless the RFC-1918 CIDRs are in `LANGFLOW_SSRF_ALLOWED_HOSTS` and blocks loopback outright — so the address the **job probes** (`localhost:<mapped port>`, on host-based lanes) is not the address **Langflow calls**. The failure mode differs by lane on purpose: `mode: fail` on PR/nightly/manual, because a silent fallback to the public host is what made #1128 look like a product bug, and `mode: warn` on the daily, where a day of coverage outweighs strictness (same reasoning as `Collect models`, #980). The decision logic lives in `scripts/resolve-echo-endpoint.mjs` and is covered by `npm run test:scripts`. `manual.yml`'s **external-URL** job is scoped out — it targets a Langflow that is not on the runner's network and cannot reach a service container.
- **Post-collect-models health gate (`.github/actions/wait-for-backend`)** — Every lane that shares one Langflow container between its `Collect models` sweep and its test run polls `/api/v1/version` between the two, through this one action: `daily-stable.yml`, `pr-validation.yml`, `manual.yml` and `weekly-stable.yml`. The sweep can leave the backend process-wide **wedged** (container alive, healthcheck green, event loop blocked — #922/#927); `globalSetup` polls 120 s and then throws, so a wedge that outlasts that window costs the whole lane and reports itself as an unattributed preflight timeout. The gate buys two things: a longer window for the wedge to clear (recovery is real and measured — 223 s on #1019, 260 s on #1044's dispatch, every second of it gunicorn's own `WORKER TIMEOUT` → `SIGKILL` → ~12 s restart), and, when it does not clear, **attribution** — its `::error::` names which state it observed (refused → dead; accepted-and-unanswered → the wedge; non-2xx → an application failure that is *not* the wedge), unconditionally, on every run. It was three copy-pasted shell loops until **#1045** (`#1011` daily → `#1019/#1044` pr-validation → `manual.yml`) and they had already diverged on the deadline, the heartbeat and the attribution, while `weekly-stable.yml` — the documented fallback — had no gate at all. One deadline now: **420 s** for every lane, over-waiting being nearly free because the extra time is only ever spent on a lane already headed for a red. The loop lives in `scripts/wait-for-backend.mjs`, exercised by `npm run test:scripts` against all four backend states (healthy / dead / wedged / wedged-then-recovers) plus a structural guard that the gate still sits between `Collect models` and the run step in all four workflows — the wedge itself cannot be reproduced on demand, since it depends on the runner's collect-models load. A failed sweep is surfaced here as a `::warning::` and never gates the run (#980/#570).
- **`file-watcher.yml`** — Detects upstream Langflow changes in critical paths and opens a GitHub issue with the exact `--grep` command needed to revalidate affected areas.
- **`issue-contract-guard.yml`** — Runs on `issues` `opened`/`edited` for `daily-failure` issues and validates the body against the **dedicated-issue contract** (`.claude/skills/langflow-e2e-triage/references/issue-templates.md`) via the shared `.github/actions/guard-dedicated-issue` action. **Reports, never blocks** — a malformed issue gets a comment naming the gaps plus `needs-triage`, never a closure. It covers only the **human** path: issues the triage skill creates are raised by `GITHUB_TOKEN`, and GitHub suppresses workflow runs for those events, so the same action also runs as an inline post-step of `triage-dispatch.yml`'s `execute` job (`since` mode) to cover the agent path. The **umbrella** is excluded by title (`[Daily Failure] …` vs `[Daily #N] …`) — it carries the same label but a different contract. A verdict the guard cannot produce fails loudly rather than reading as a pass (#1035). In `since` mode the **window** is equally fail-loud (#1037): it selects over `--state all` (an issue closed before the sweep must still be checked, and scoping to open issues made the umbrella drop out by *state*, so the title rule never ran), the selection lives in `scripts/select-dedicated-issues.mjs` — compared as instants, not strings, and covered by `npm run test:scripts` — and a sweep that enforces the contract on **zero** issues says so instead of logging the same line as a healthy run.
- **`update-coverage-summary.yml`** — Runs on every push to `main` that touches `QA-CHECKLIST.md`, the regeneration scripts, or `tests/**/*.spec.ts`; regenerates the Coverage Summary table and the `Phase 0 — Validated` block (counts + bulleted list) from source and commits any change with `[skip ci]`.

## Run history (`reports/`)

Append-only JSONL log of CI runs, committed to the repo so longitudinal questions ("how many weeks did test X fail in a row?", "did failures correlate with a Langflow upgrade?") can be answered without paying for an external dashboard or extending artifact retention.

- **`reports/daily-history.jsonl`** — One line per `daily-stable.yml` run (the active stable workflow). Written by `scripts/append-weekly-history.mjs` (shared appender, pointed here via the `HISTORY_FILE` override) and committed back to `main` with `[skip ci]` at the end of the daily workflow (even on failure, so recurring breakage is captured).
- **`reports/weekly-history.jsonl`** — Frozen history from `weekly-stable.yml` (now disabled). Same schema; retained for past longitudinal queries.
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
