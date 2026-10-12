# Langflow E2E

End-to-end regression tests for [Langflow](https://github.com/langflow-ai/langflow) with Playwright.

This repository is **independent from the Langflow source code** — the tests point to any running instance via URL, without needing to clone or build the project.

---

## Setup

```bash
git clone https://github.com/oriontech-me/langflow-e2e.git
cd langflow-e2e
npm install
npx playwright install chromium --with-deps
cp .env.example .env  # adjust PLAYWRIGHT_BASE_URL and API keys
```

**Prerequisites:** Node.js 20+, Playwright 1.57+ (installed via `npm install`), Docker (optional).

---

## Starting Langflow

```bash
# Docker — nightly (default): langflowai/langflow-nightly:latest, the image CI runs
./scripts/start-langflow-docker.sh

# Docker — a released version, from langflowai/langflow
./scripts/start-langflow-docker.sh 1.3.0

# Docker — any exact image reference
LANGFLOW_IMAGE=langflowai/langflow:latest ./scripts/start-langflow-docker.sh

# External instance (staging, PR branch, already running locally)
# Just set PLAYWRIGHT_BASE_URL in .env or on the command line
```

> To test a specific branch: check out the branch in the Langflow repo, start it with `uv run langflow run`, and point `PLAYWRIGHT_BASE_URL=http://localhost:7860`.

---

## Running the tests

```bash
npm test                                              # full suite
npm run test:core                                     # core tests only
npm run test:extended                                 # extended tests only
npm run test:regression                               # regression-only
npx playwright test --grep "@api"                    # by tag
npx playwright test path/to/file.spec.ts             # specific file
npm run report                                        # open the last HTML report
```

---

## Tests with LLM (agents, providers, MCP)

Tests that depend on language models require two steps before running:

### 1. Collect providers and models

```bash
npx playwright test tests/collect-models.spec.ts
```

This command:
- Validates API keys for OpenAI, Anthropic and Google via a real API call
- Collects the list of available models in the UI via Settings → Model Providers
- Saves two files in `tests/helpers/provider-setup/data/`:
  - `providers.json` — status of each provider (`active` / `inactive` + reason)
  - `models.json` — list of all available models per provider

### 2. Configure the test strategy in `.env`

The strategy is automatically detected by the priority of the defined variables:

```bash
# Run only a specific model (highest priority)
MODEL_TEST_ID=gpt-4o-mini

# Run only models from one provider
MODEL_TEST_PROVIDER=openai

# Run all models from the JSON (default — leave variables empty)
```

For specs declared `tier: "any-completion"` — the ones where **no** assertion depends
on the model choosing or managing to do anything (not merely "the reply's content is
not read"; see `CONTRIBUTING.md`, #1187) — a fourth option runs them against a
**local, keyless** model (no API key, no quota), and takes priority over the two
variables above for that tier only:

```bash
# Needs `ollama serve` with the model pulled; see .env.example for the full block
ANY_COMPLETION_PROVIDER=ollama
OLLAMA_TEST_MODEL=llama3.2:1b
```

### 3. Run with --workers=1

Agent tests create flows in Langflow and require `--workers=1` to avoid name conflicts:

```bash
npx playwright test tests/tests-automations/regression/core-functionality/llm-agents/agent-component-regression.spec.ts --workers=1
```

> Providers with `status: "inactive"` in `providers.json` appear as `skipped` in the output with the exact reason (e.g.: insufficient balance, invalid key).

---

## Available tags

Tags are split into two groups: **cross-cutting** (severity/layer) and **functional** (product area). Every test must have at least one tag from each group.

**Cross-cutting**

| Tag | When to use |
|---|---|
| `@release` | Happy-path flows required before any deploy |
| `@regression` | Tests for previously fixed bugs |
| `@api` | Tests exercising REST API endpoints |
| `@components` | Canvas/sidebar component configuration |
| `@workspace` | Flow, folder and canvas management |
| `@database` | Tests with persisted state in the database |
| `@mainpage` | Home/dashboard UI tests |

**Functional** (use alongside the cross-cutting ones)

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

Every new test must have **at least one tag** and import from `../../fixtures` (not directly from Playwright).

---

## Structure

| Folder | Responsibility |
|---|---|
| `assets/` | Static files used in tests: documents for upload, ready-to-import flow JSONs and media files. No code here — data only. |
| `fixtures/` | Entry point for all tests. Extends Playwright's `test` with automatic backend error monitoring. Every test imports from here, never from Playwright directly. |
| `helpers/` | Reusable action functions. Encapsulate concrete application operations. |
| `helpers/provider-setup/` | Provider setup (OpenAI, Anthropic, Google), model collection and credential validation. |
| `pages/` | Page Objects for UI navigation. Each file represents an area of the UI. |
| `tests-automations/` | Where tests live, organized by functional area. |

```
tests/
├── assets/
│   ├── files/
│   ├── flows/
│   └── media/
│
├── collect-models.spec.ts          # collects providers.json + models.json (run before LLM tests)
│
├── fixtures/
│
├── helpers/
│   ├── api/
│   ├── auth/
│   ├── filesystem/
│   ├── flows/
│   ├── mcp/
│   ├── other/
│   ├── provider-setup/             # provider setup and model collection
│   │   ├── collect-models.ts       # helper: validates providers via API + collects models via UI
│   │   ├── setup-openai.ts
│   │   ├── setup-anthropic.ts
│   │   ├── setup-google.ts
│   │   ├── index.ts                # providerSetupMap + hasProviderEnvKeys
│   │   └── data/
│   │       ├── providers.json      # generated by collect-models.spec.ts
│   │       └── models.json         # generated by collect-models.spec.ts
│   └── ui/
│
├── pages/
│   ├── BasePage.ts
│   ├── SimpleAgentTemplatePage.ts  # loads Simple Agent template with configurable provider/model
│   ├── SettingsPage.ts
│   └── ...
│
└── tests-automations/
    ├── regression/
    │   ├── api/flows/
    │   ├── core-components/
    │   ├── core-functionality/
    │   │   ├── auth/
    │   │   ├── knowledge-ingestion-management/
    │   │   ├── llm-agents/
    │   │   ├── model-provider/
    │   │   ├── observability-monitoring/
    │   │   ├── playground/
    │   │   ├── project-management/
    │   │   └── templates/
    │   ├── flow-functionality/
    │   ├── mcp/
    │   │   ├── client/
    │   │   └── server/
    │   └── ui-ux/
    └── smoke/
```

---

## CI (GitHub Actions)

| Workflow | Trigger | What it does |
|---|---|---|
| `pr-validation.yml` | Every PR to `main` | TypeScript check (`tsc --noEmit`) + ESLint in parallel — both must pass before merge |
| `daily-stable.yml` | **Disabled since 2026-10-02** (#2159) | Ran `@stable` against `langflow-nightly:latest` on weekdays. **The daily now runs on the QA VM** (`ops/vm/run-daily.sh`, `e2e-daily.timer`, see [`ops/systemd/README.md`](./ops/systemd/README.md)), which also writes `reports/daily-history.jsonl` (#2164). The file stays as the way back: `gh workflow enable daily-stable.yml` |
| `manual.yml` | Manual | Runs against any Docker tag or external URL, filters by suite/tag. Carries the `provider` input (`auto` / `openai` / `anthropic` / `google` / `all-models`) — **the only lane that still runs multi-provider**, since `pr-validation` pins one provider and the daily rotates by weekday (#1186) |

---

## Scheduled workflows moved to the QA VM

Each was disabled in Actions once its VM routine had shown the same result: days in parallel with the same verdict, or a rehearsal on the VM that produced the same report. The file stays as the way back. The routines, their schedules and their alarms are in [`ops/systemd/README.md`](./ops/systemd/README.md) (*Scheduled routines*).

| Workflow | Disabled | Replaced by | Way back |
|---|---|---|---|
| `migration-test.yml`, `migration-fresh-install.yml`, `migration-upgrade-with-flows.yml` | 2026-10-10, after three weekdays of the same verdict in parallel (#2208) | `e2e-routine-migration`: one routine, latest stable below the target → the target, in 12 cells (SQLite / Postgres 16 × pip / docker × fresh / upgrade, plus `AUTO_LOGIN` off on the four upgrades) (#2193) | `gh workflow enable <file>` |
| `stable-orphan-reconcile.yml` | 2026-10-11, after a rehearsal on the VM produced the same report as the workflow, and before the routine's first scheduled run | `e2e-routine-stable-orphans`: the same reconciler, Mondays 10:00 UTC, reading the trackers of both repositories, with its report issue on the destination (#2224) | `gh workflow enable stable-orphan-reconcile.yml` |
| `refresh-coverage-matrix.yml` | 2026-10-12, after the routine committed the day's refresh at 08:45 UTC and the workflow's own fallback run that afternoon found the matrix already current | `e2e-routine-coverage-matrix`: the same refresh of the matrix's derivable axes, weekdays 08:45 UTC after the daily, committed to `main` (#2211). Neither posts the feed to the QA Platform yet: the endpoint was never configured | `gh workflow enable refresh-coverage-matrix.yml` |

---

## Retired workflows

`nightly.yml`, `weekly-stable.yml`, `adaptive-impacted.yml` and `file-watcher.yml` were deleted in #2171. All four were disabled in Actions, none had run since June, and two never ran at all. The `@stable` removal the weekly ran now lives in the VM lane (`scripts/run-e2e.sh`). Their history, including `reports/weekly-history.jsonl`, stays in the repository.

To inspect which specs have or lack a populated **External dependencies** section, run `npm run validate:specs`.

---

## Regression Checklist

See [`QA_CHECKLIST.md`](./QA_CHECKLIST.md) for the full coverage map.

| Symbol | Meaning |
|---|---|
| `[x]` | Automated and validated |
| `[-]` | Automated, needs validation |
| `[ ]` | Not covered |
| `[~]` | Partially covered |
| `[!]` | Flaky — needs stabilization |

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the complete guide on how to create tests and validate coverage.

See [`REGRESSIONS.md`](./REGRESSIONS.md) for the ledger of real Langflow regressions this suite has caught — each one adversarially validated and tracked upstream.
