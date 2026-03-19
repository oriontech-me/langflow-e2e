# Langflow E2E

Testes de regressão end-to-end do [Langflow](https://github.com/langflow-ai/langflow) com Playwright.

O repositório é **independente do código-fonte do Langflow** — os testes apontam para qualquer instância via URL, sem precisar clonar ou buildar o projeto.

---

## Setup

```bash
git clone https://github.com/lice-reis/langflow-e2e.git
cd langflow-e2e
npm install
npx playwright install chromium --with-deps
cp .env.example .env  # ajuste PLAYWRIGHT_BASE_URL e API keys
```

**Pré-requisitos:** Node.js 20+, Playwright 1.57+ (instalado via `npm install`), Docker (opcional).

---

## Subindo o Langflow

```bash
# Docker — nightly (padrão)
./scripts/start-langflow-docker.sh

# Docker — versão específica
LANGFLOW_IMAGE_TAG=1.3.0 ./scripts/start-langflow-docker.sh

# Instância externa (staging, PR branch, local já no ar)
# Apenas defina PLAYWRIGHT_BASE_URL no .env ou na linha de comando
```

> Para testar uma branch específica: faça checkout da branch no repo do Langflow, suba com `uv run langflow run`, e aponte `PLAYWRIGHT_BASE_URL=http://localhost:7860`.

---

## Rodando os testes

```bash
npm test                                              # suíte completa
npm run test:core                                     # somente testes core
npm run test:extended                                 # somente testes extended
npm run test:regression                               # somente regressão de bugs
npx playwright test --grep "@api"                    # por tag
npx playwright test path/ao/arquivo.spec.ts          # arquivo específico
npm run report                                        # abre o último relatório HTML
```

---

## Testes com LLM (agentes, providers, MCP)

Testes que dependem de modelos de linguagem exigem dois passos antes de rodar:

### 1. Coletar providers e modelos

```bash
npx playwright test tests/collect-models.spec.ts
```

Esse comando:
- Valida as API keys de OpenAI, Anthropic e Google via chamada real à API
- Coleta a lista de modelos disponíveis na UI via Settings → Model Providers
- Salva dois arquivos em `tests/helpers/provider-setup/data/`:
  - `providers.json` — status de cada provider (`active` / `inactive` + motivo)
  - `models.json` — lista de todos os modelos disponíveis por provider

### 2. Configurar a estratégia de teste no `.env`

```bash
# Rodar todos os modelos do JSON
MODEL_TEST_STRATEGY=all

# Rodar somente modelos de um provider
MODEL_TEST_STRATEGY=provider
MODEL_TEST_PROVIDER=openai

# Rodar somente um modelo específico
MODEL_TEST_STRATEGY=model
MODEL_TEST_ID=gpt-4o-mini
```

### 3. Rodar com --workers=1

Testes de agentes criam flows no Langflow e exigem `--workers=1` para evitar conflito de nomes:

```bash
npx playwright test tests/tests-automations/regression/core-functionality/llm-agents/agent-component-regression.spec.ts --workers=1
```

> Providers com `status: "inactive"` no `providers.json` aparecem como `skipped` no output com o motivo exato (ex: saldo insuficiente, key inválida).

---

## Tags disponíveis

| Tag | Área |
|---|---|
| `@model-provider` | Configuração de provedores, API keys, modal de modelo |
| `@agents` | Comportamento de agentes LLM, raciocínio, steps |
| `@mcp` | Integração MCP (server e client) |
| `@playground` | Playground de chat e interações |
| `@auth` | Autenticação, login, sessão, gestão de usuários |
| `@observability` | Traces, latência, tokens |
| `@files` | Ingestão de arquivos e RAG |
| `@project-management` | Flows, pastas, navegação, bulk actions |
| `@templates` | Starter projects e templates de flow |
| `@ui-ux` | Interface geral, atalhos, aparência |
| `@settings` | Navegações que usam a página de configurações |
| `@api` | Testes que chamam a API REST do Langflow |

Todo teste novo deve ter **pelo menos uma tag** e importar de `../../fixtures` (não do Playwright diretamente).

---

## Estrutura

| Pasta | Responsabilidade |
|---|---|
| `assets/` | Arquivos estáticos usados nos testes: documentos para upload, flows JSON prontos para importação e arquivos de mídia. Nenhum código aqui — só dados. |
| `fixtures/` | Ponto de entrada para todos os testes. Estende o `test` do Playwright com monitoramento automático de erros de backend. Todo teste importa daqui, nunca do Playwright diretamente. |
| `helpers/` | Funções de ações específicas reutilizáveis. Encapsulam operações concretas da aplicação. |
| `helpers/provider-setup/` | Setup de providers (OpenAI, Anthropic, Google), coleta de modelos e validação de credenciais. |
| `pages/` | Page Objects para navegação da interface. Cada arquivo representa uma área da UI. |
| `tests-automations/` | Onde vivem os testes, organizados por área funcional. |

```
tests/
├── assets/
│   ├── files/
│   ├── flows/
│   └── media/
│
├── collect-models.spec.ts          # coleta providers.json + models.json (rodar antes de testes LLM)
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
│   ├── provider-setup/             # setup de providers e coleta de modelos
│   │   ├── collect-models.ts       # helper: valida providers via API + coleta modelos via UI
│   │   ├── setup-openai.ts
│   │   ├── setup-anthropic.ts
│   │   ├── setup-google.ts
│   │   ├── index.ts                # providerSetupMap + hasProviderEnvKeys
│   │   └── data/
│   │       ├── providers.json      # gerado por collect-models.spec.ts
│   │       └── models.json         # gerado por collect-models.spec.ts
│   └── ui/
│
├── pages/
│   ├── BasePage.ts
│   ├── SimpleAgentTemplatePage.ts  # carrega template Simple Agent com provider/modelo configurável
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

| Workflow | Gatilho | O que faz |
|---|---|---|
| `nightly.yml` | Diário 03h BRT + manual | Roda tudo contra `langflow-nightly:latest`, abre issue se falhar |
| `manual.yml` | Manual | Roda contra qualquer tag Docker ou URL externa, filtra por suite/tag |
| `file-watcher.yml` | Diário 05h BRT | Monitora mudanças no source do Langflow e abre issue de revisão |

---

## Regression Checklist

Veja [`QA_CHECKLIST.md`](./QA_CHECKLIST.md) para o mapa completo de cobertura.

| Símbolo | Significado |
|---|---|
| `[x]` | Automatizado |
| `[ ]` | Não coberto |
| `[~]` | Parcialmente coberto |
| `[!]` | Flaky — precisa estabilizar |

---

## Contribuindo

Veja [`CONTRIBUTING.md`](./CONTRIBUTING.md) para o guia completo de como criar testes, validar cobertura e responder a issues do file-watcher.
