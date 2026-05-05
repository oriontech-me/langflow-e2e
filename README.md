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
# Docker — nightly (default)
./scripts/start-langflow-docker.sh

# Docker — specific version
./scripts/start-langflow-docker.sh 1.3.0

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
| `nightly.yml` | Daily 03:00 BRT + manual | Runs everything against `langflow-nightly:latest`, opens an issue on failure |
| `manual.yml` | Manual | Runs against any Docker tag or external URL, filters by suite/tag |
| `file-watcher.yml` | Daily 05:00 BRT | Monitors changes in Langflow source and opens a review issue |

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

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the complete guide on how to create tests, validate coverage and respond to file-watcher issues.
