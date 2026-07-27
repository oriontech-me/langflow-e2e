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
./scripts/start-langflow-docker.sh           # Docker (nightly by default)
./scripts/start-langflow-docker.sh 1.5.1     # Specific version
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

- **`tests/fixtures/fixtures.ts`** — Always import `test` from here, never directly from Playwright. It extends the base `test` with automatic backend HTTP error monitoring (4xx/5xx) and flow execution error detection. Provides `page.allowFlowErrors()` for tests that intentionally trigger failures.

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

**Test validation checklist** before marking complete (from CONTRIBUTING.md):
1. Run with full trace (`--trace=on`) and verify steps match screenshots
2. Force a failure to confirm no false positives
3. Walk through in debug mode (`--debug`)
4. Confirm no backend errors logged (`🚨 Backend Error:`)
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

- **`pr-validation.yml`** — Runs on every PR to `main`; two parallel jobs: TypeScript check (`tsc --noEmit`) and ESLint. Both must pass before merge.
- **`nightly.yml`** — Runs daily at 03:00 BRT against `langflowai/langflow-nightly:latest`; opens a GitHub issue on failure assigned to @Victor-w-Madeira.
- **`daily-stable.yml`** — Runs on weekdays (Mon–Fri) at 05:00 BRT against `langflowai/langflow-nightly:latest`; runs only `@stable` tests; opens a GitHub issue on failure for triage (`daily-failure` label); appends one entry to `reports/daily-history.jsonl` and commits it back to `main` with `[skip ci]` (runs on success and failure). **This is the active stable workflow.**
- **`weekly-stable.yml`** — **Disabled** (kept as a fallback, superseded by `daily-stable.yml`). When enabled it runs every Monday with the same machinery, writing to `reports/weekly-history.jsonl`.
- **`manual.yml`** — Parameterized manual run; accepts a Docker tag or full URL, a specific test suite, and an optional grep filter.
- **`file-watcher.yml`** — Detects upstream Langflow changes in critical paths and opens a GitHub issue with the exact `--grep` command needed to revalidate affected areas.
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

## Playwright Configuration

Key settings in `playwright.config.ts`:
- Base URL via `PLAYWRIGHT_BASE_URL` (default: `http://localhost:7860`)
- Chromium only, with clipboard permissions
- Fully parallel, 5-minute timeout per test
- 3 retries locally, 2 retries in CI; trace captured on first retry
- HTML reporter locally, blob reporter in CI
