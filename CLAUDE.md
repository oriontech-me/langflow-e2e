# CLAUDE.md — Langflow E2E

Guia de referência para o Claude Code atuar neste repositório.

---

## 📌 Visão Geral

Repositório de automação E2E do [Langflow](https://github.com/langflow-ai/langflow) usando **Playwright + TypeScript**.

Os testes são independentes do código-fonte do Langflow — apontam para qualquer instância via URL configurável. Cobrem regressão de UI, API REST, agentes LLM com múltiplos providers, MCP e playground.

---

## ⚙️ Setup

### Instalação

```bash
npm install
npx playwright install chromium --with-deps
cp .env.example .env
```

### Variáveis de ambiente (`.env`)

| Variável | Descrição |
|---|---|
| `PLAYWRIGHT_BASE_URL` | URL do Langflow (padrão: `http://localhost:7860`) |
| `LANGFLOW_SUPERUSER` | Usuário admin do Langflow |
| `LANGFLOW_SUPERUSER_PASSWORD` | Senha do admin |
| `OPENAI_API_KEY` | API key da OpenAI |
| `ANTHROPIC_API_KEY` | API key da Anthropic |
| `GOOGLE_API_KEY` | API key do Google Generative AI |
| `MODEL_TEST_STRATEGY` | `all` / `provider` / `model` |
| `MODEL_TEST_PROVIDER` | Provider a testar quando `strategy=provider` |
| `MODEL_TEST_ID` | Modelo a testar quando `strategy=model` |

### Executando testes

```bash
# Testes sem LLM
npx playwright test tests/tests-automations/regression/core-functionality/auth/

# Coletar providers e modelos (obrigatório antes de testes de agente)
npx playwright test tests/collect-models.spec.ts

# Testes de agente com modelo específico
MODEL_TEST_STRATEGY=model MODEL_TEST_ID=gpt-4o-mini \
  npx playwright test tests/tests-automations/regression/core-functionality/llm-agents/agent-component-regression.spec.ts --workers=1

# Debug visual passo a passo
npx playwright test caminho/do/teste.spec.ts --debug
```

---

## 🤖 Como atuar neste repositório

### Regras obrigatórias

- **Nunca hardcode** provider, modelo ou API key — use `SimpleAgentTemplatePage` e o setup de providers
- **Sempre importar** de `fixtures/fixtures`, nunca do Playwright diretamente
- **Usar `--workers=1`** em testes de agente — criam flows com nome único no Langflow
- **Não duplicar** lógica de setup — `providerSetupMap` é o ponto central
- **Não commitar** com `test.only` — afeta todos os outros testes na CI

### Antes de criar qualquer teste com LLM

```bash
npx playwright test tests/collect-models.spec.ts
```

Isso gera `providers.json` e `models.json` em `tests/helpers/provider-setup/data/`.

### Pastas com CLAUDE.md específico

| Pasta | Instrução |
|---|---|
| `tests/tests-automations/regression/core-functionality/llm-agents/` | Testes de agente — obrigatório usar setup de modelos |
| `tests/tests-automations/regression/core-functionality/model-provider/` | Testes de provider — usar SettingsPage e setup |
| `tests/tests-automations/regression/mcp/` | Testes MCP — usar setup quando envolve agente |

---

## 🧪 Testes

### Estrutura

```
tests/
├── collect-models.spec.ts          # roda antes de testes de agente
├── fixtures/fixtures.ts            # ponto de importação de todos os testes
├── helpers/provider-setup/         # setup de providers e coleta de modelos
├── pages/                          # Page Object Model (flat, sem subpastas)
└── tests-automations/regression/   # testes organizados por área funcional
```

### Como criar um novo teste

1. Escolha a pasta correta em `tests-automations/regression/`
2. Nomeie com kebab-case: `meu-comportamento.spec.ts`
3. Importe de `fixtures/fixtures`, não do Playwright
4. Adicione ao menos uma tag (ver tabela abaixo)
5. Atualize o `QA-CHECKLIST.md`

### Estrutura básica

```typescript
import { test, expect } from "../../../../fixtures/fixtures";

test("deve [comportamento] quando [condição]", { tag: ["@agents"] }, async ({ page }) => {
  // ...
});
```

### Tags disponíveis

| Tag | Área |
|---|---|
| `@model-provider` | Configuração de providers, API keys, modal |
| `@agents` | Agentes LLM, raciocínio, tool calling |
| `@mcp` | Integração MCP server/client |
| `@playground` | Chat UI, interações, histórico |
| `@auth` | Login, sessão, usuários |
| `@observability` | Traces, latência, tokens |
| `@files` | Upload, RAG, knowledge |
| `@project-management` | Flows, pastas, bulk actions |
| `@templates` | Starter projects, templates |
| `@ui-ux` | Canvas, sidebar, aparência |
| `@settings` | Navegação via página de configurações |
| `@api` | Chamadas REST diretas ao Langflow |

---

## 🔌 Providers

### Como funciona o setup

1. `collect-models.spec.ts` valida as API keys via chamada real e coleta modelos da UI
2. Resultado salvo em `tests/helpers/provider-setup/data/`:
   - `providers.json` — `{ provider, status, error, checkedAt }`
   - `models.json` — `{ provider, model }`
3. `agent-component-regression.spec.ts` lê os dois arquivos e parametriza os testes por modelo
4. Providers inativos aparecem como `skipped` no output com o motivo exato

### Padrão de parametrização

```typescript
for (const { label, options, skipReason } of targets) {
  test.describe.serial(`Teste [${label}]`, () => {
    test("deve ...", { tag: ["@agents"] }, async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");
      // ...
      await new SimpleAgentTemplatePage(page).load(options);
    });
  });
}
```

### Seleção de modelo no dropdown

O selector usa match exato via regex para evitar match parcial (ex: `gpt-4` vs `gpt-4o`):

```typescript
page.locator('[data-testid$="-option"]', { hasText: new RegExp(`^${model}$`) })
```

### Providers suportados

| Provider | Env var | Modelo padrão (fallback) |
|---|---|---|
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude` (primeiro disponível) |
| Google | `GOOGLE_API_KEY` | `gemini` (primeiro disponível) |

---

## 📋 Documentação relacionada

- `README.md` — setup, execução e estrutura geral
- `CONTRIBUTING.md` — como criar, validar e manter testes
- `QA-CHECKLIST.md` — cobertura por área funcional
