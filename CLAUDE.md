# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an independent end-to-end regression test suite for [Langflow](https://github.com/langflow-ai/langflow), built with Playwright and TypeScript. It tests any running Langflow instance via URL — it is fully decoupled from Langflow's source code.

## Environment Setup

Copy `.env.example` to `.env` and configure:

```
PLAYWRIGHT_BASE_URL=http://localhost:7860/
LANGFLOW_SUPERUSER=langflow
LANGFLOW_SUPERUSER_PASSWORD=langflow
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
MODEL_TEST_STRATEGY=               # all | provider | model (default: all)
MODEL_TEST_PROVIDER=               # used when MODEL_TEST_STRATEGY=provider
MODEL_TEST_ID=                     # used when MODEL_TEST_STRATEGY=model
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
npm run lint                                  # ESLint (mesmo check do CI de PR)
```

Filter by tag: `npx playwright test --grep "@api"` — available tags listed in the Tag Semantics section below.

### Agent / multi-provider tests

Before running any LLM agent test, collect the available models from a live Langflow instance:

```bash
npx playwright test tests/collect-models.spec.ts
```

This generates `tests/helpers/provider-setup/data/providers.json` and `models.json`. Then run agent tests targeting a specific model:

```bash
MODEL_TEST_STRATEGY=model MODEL_TEST_ID=gpt-4o-mini \
  npx playwright test tests/tests-automations/regression/core-functionality/llm-agents/agent-component-regression.spec.ts --workers=1
```

Always use `--workers=1` for agent tests — they create flows with unique names in Langflow and must not run in parallel.

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
- Never hardcode provider, model, or API key — use `SimpleAgentTemplatePage` and the provider setup
- Never commit with `test.only` — it breaks the entire CI suite
- Use `--workers=1` for any test that creates flows in Langflow

**Test validation checklist** before marking complete (from CONTRIBUTING.md):
1. Run with full trace (`--trace=on`) and verify steps match screenshots
2. Force a failure to confirm no false positives
3. Walk through in debug mode (`--debug`)
4. Confirm no backend errors logged (`🚨 Backend Error:`)
5. Update `QA-CHECKLIST.md` coverage symbols

### Tag Semantics

Tags are split into two groups: **transversais** (severidade/camada) e **funcionais** (área de produto).

**Transversais**

| Tag | When to apply |
|---|---|
| `@release` | Happy-path flows required before any deploy |
| `@regression` | Tests for previously fixed bugs |
| `@api` | Tests exercising REST API endpoints |
| `@components` | Canvas/sidebar component configuration |
| `@workspace` | Flow/folder/canvas management |
| `@database` | Tests with persistent saved state |
| `@mainpage` | Home/dashboard UI tests |

**Funcionais** (área de produto — use junto com as transversais)

| Tag | Área |
|---|---|
| `@model-provider` | Configuração de provedores, API keys, modal de modelo |
| `@agents` | Comportamento de agentes LLM, raciocínio, steps |
| `@mcp` | Integração MCP (server e client) |
| `@playground` | Playground de chat e interações |
| `@auth` | Autenticação, login, sessão, gestão de usuários |
| `@observability` | Traces, latência, tokens |
| `@files` | Página de arquivos, upload, Read File / Write File components |
| `@templates` | Starter projects e templates de flow |
| `@settings` | Navegação e configuração na página de Settings |
| `@ui-ux` | Interface geral, atalhos, aparência |

### Multi-provider setup

`tests/helpers/provider-setup/` contains the logic for collecting and selecting models:

- `collect-models.spec.ts` validates API keys via real calls and saves available models from the Langflow UI
- `providers.json` — `{ provider, status, error, checkedAt }`
- `models.json` — `{ provider, model }`
- `agent-component-regression.spec.ts` reads both files and parametrizes tests per model; inactive providers appear as `skipped` with the exact reason

**Supported providers**

| Provider | Env var | Default model (fallback) |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | first available `claude` model |
| Google | `GOOGLE_API_KEY` | first available `gemini` model |

**Subfolders with their own CLAUDE.md**

| Folder | Topic |
|---|---|
| `tests/helpers/` | Helper functions reference |
| `tests/tests-automations/regression/api/` | REST API tests |
| `tests/tests-automations/regression/core-functionality/llm-agents/` | Agent tests with multi-provider setup |
| `tests/tests-automations/regression/core-functionality/model-provider/` | Provider configuration tests |
| `tests/tests-automations/regression/core-functionality/playground/` | Playground tests |
| `tests/tests-automations/regression/mcp/` | MCP integration tests |

## CI/CD

Four GitHub Actions workflows:

- **`pr-validation.yml`** — Runs on every PR to `main`; two parallel jobs: TypeScript check (`tsc --noEmit`) and ESLint. Both must pass before merge.
- **`nightly.yml`** — Runs daily at 03:00 BRT against `langflowai/langflow-nightly:latest`; opens a GitHub issue on failure assigned to @Victor-w-Madeira.
- **`manual.yml`** — Parameterized manual run; accepts a Docker tag or full URL, a specific test suite, and an optional grep filter.
- **`file-watcher.yml`** — Detects upstream Langflow changes in critical paths and opens a GitHub issue with the exact `--grep` command needed to revalidate affected areas.

## Playwright Configuration

Key settings in `playwright.config.ts`:
- Base URL via `PLAYWRIGHT_BASE_URL` (default: `http://localhost:7860`)
- Chromium only, with clipboard permissions
- Fully parallel, 5-minute timeout per test
- 3 retries locally, 2 retries in CI; trace captured on first retry
- HTML reporter locally, blob reporter in CI
