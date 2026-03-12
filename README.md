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
cp .env.example .env  # ajuste PLAYWRIGHT_BASE_URL se necessário
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
npm test                        # suíte completa
npm run test:core               # somente testes core (obrigatórios para release)
npm run test:extended           # somente testes extended
npm run test:regression         # somente regressão de bugs
npx playwright test --grep "@api"       # por tag
npx playwright test path/ao/arquivo.spec.ts  # arquivo específico
npm run report                  # abre o último relatório HTML
```

---

## Tags disponíveis

| Tag | Quando usar |
|---|---|
| `@release` | Caminho feliz — validação antes de deploy |
| `@regression` | Bugs corrigidos que não podem voltar |
| `@api` | Mudanças em endpoints de backend |
| `@components` | Mudanças em componentes do canvas |
| `@workspace` | Mudanças em flows, pastas ou canvas |
| `@database` | Testes com estado persistido |
| `@mainpage` | Mudanças na página principal |

Todo teste novo deve ter **pelo menos uma tag** e importar de `../../fixtures` (não do Playwright diretamente).

---

## Estrutura

```
tests/
├── core/         # obrigatórios — features, integrations, unit, regression
├── extended/     # complementares — edge cases, regressões complexas
├── pages/        # Page Objects
├── utils/        # funções compartilhadas
└── fixtures.ts   # fixture base com monitoramento automático de erros de backend
```

A `fixtures.ts` intercepta erros `4xx/5xx` e falhas silenciosas de flow em toda execução — se o backend errar mas a UI não mostrar, o teste falha mesmo assim.

---

## Como validar um teste existente

Antes de marcar um cenário como coberto no checklist, o time deve seguir este processo:

**1. Rode o teste isolado com relatório completo**
```bash
PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test caminho/do/teste.spec.ts --reporter=html --trace=on
npx playwright show-report
```
No relatório, verifique se os `test.step()` descritos no código correspondem ao que aconteceu na tela (screenshots + log de rede).

**2. Confirme que os passos do teste estão documentados**

Cada teste deve ter `test.step()` descrevendo o que cada bloco faz. Se não tiver, adicione antes de validar. Exemplo:
```typescript
await test.step("Log in with valid credentials and confirm main page loads", async () => { ... });
await test.step("Reload page and confirm session was cleared — login screen must appear", async () => { ... });
```

**3. Force uma falha para confirmar que não é falso positivo**

Comente ou inverta a asserção principal do teste e rode novamente. O teste **deve falhar**. Se passar mesmo com a asserção quebrada, o cenário não está sendo validado de verdade.

```typescript
// Antes
expect(isLoggedIn).toBeFalsy();

// Para testar: inverta e confirme que falha
expect(isLoggedIn).toBeTruthy(); // deve falhar → reverta depois
```

**4. Rode em modo debug para acompanhar passo a passo**
```bash
PLAYWRIGHT_BASE_URL=http://localhost:7860 npx playwright test caminho/do/teste.spec.ts --debug
```
O Playwright Inspector abre e você avança ação por ação, vendo o estado da página em cada momento.

**5. Verifique os logs do terminal**

A fixture base imprime erros de backend automaticamente. Após rodar, procure no output por:
- `🚨 Backend Error:` — erro HTTP inesperado
- `🚨 Flow Error Detected` — falha silenciosa na execução de flow

Se aparecer algum desses e o teste passar mesmo assim, revise o teste.

**6. Atualize o checklist**

Só marque `[x]` após confirmar os 5 passos acima. Se a cobertura for parcial, use `[~]`.

---

## CI (GitHub Actions)

| Workflow | Gatilho | O que faz |
|---|---|---|
| `nightly.yml` | Diário 03h BRT + manual | Roda tudo contra `langflow-nightly:latest`, abre issue se falhar |
| `manual.yml` | Manual | Roda contra qualquer tag Docker ou URL externa, filtra por suite/tag |
| `file-watcher.yml` | Diário 05h BRT | Monitora mudanças no source do Langflow e abre issue de revisão |

---

## Manutenção dos testes

### Como o time fica sabendo que um teste precisa ser revisado

O maior risco em testes E2E não é o teste que falha — é o teste que **passa mas não valida mais o comportamento correto**, porque o Langflow mudou e o teste não acompanhou.

Existe um mecanismo automático para isso: o `file-watcher.yml` roda todo dia às 05h BRT e verifica se houve commits no repositório oficial do Langflow nas últimas 24h em caminhos críticos. Quando detecta mudanças, abre automaticamente uma issue neste repositório.

**A issue informa:**
- Qual área funcional mudou (ex: "Model Providers & LLM")
- O comando exato para rodar os testes afetados (ex: `npx playwright test --grep "@components|@api"`)
- Qual seção do `REGRESSION_CHECKLIST.md` revisar
- Os commits das últimas 24h para leitura humana

**Exemplo de issue gerada após mudança em model providers:**
> | Area | Run these tests | Checklist |
> |---|---|---|
> | Model Providers & LLM | `npx playwright test --grep "@components\|@api"` | ÁREA 8 — LLM Providers + ÁREA 7 — Templates |

### Áreas monitoradas

O watcher cobre 12 áreas funcionais mapeadas a partir do source do Langflow:

| Área | Caminhos monitorados | Tags afetadas |
|---|---|---|
| Routes & Feature Flags | `routes.tsx`, `feature-flags.ts` | todas |
| Authentication | `api/v1/login.py`, `services/auth/`, `LoginPage/`, `authStore.ts` | `@release @api` |
| Flow CRUD & Canvas | `api/v1/flows.py`, `FlowPage/`, `flowStore.ts` | `@workspace @release` |
| Flow Execution | `api/v1/endpoints.py`, `processing/`, `api/v1/chat.py` | `@release @api` |
| Model Providers & LLM | `ModelProvidersPage/`, `modelProviderModal/`, `providerConstants.ts`, `api/v1/models.py` | `@components @api` |
| Agents & Agentic Flows | `agentic/`, `base/agents/`, `MainPage/` | `@components @release` |
| Playground & Chat | `pages/Playground/`, `playgroundStore.ts`, `api/v1/chat.py` | `@workspace @release` |
| Settings & Global Variables | `SettingsPage/`, `api/v1/variable.py` | `@api @release` |
| MCP Server | `MCPServersPage/`, `api/v1/mcp.py`, `agentic/mcp/` | `@components` |
| Tracing & Monitoring | `api/v1/traces.py`, `services/tracing/` | `@api` |
| Database Models | `services/database/models/`, `alembic/` | `@database @release` |
| Component Input Types | `parameterRenderComponent/`, `CustomNodes/`, `inputs/` | `@components` |

### O que fazer quando chegar uma issue do file-watcher

1. Leia os commits listados na issue — identifique se é uma mudança de comportamento, renomeação de elemento, novo endpoint, etc.
2. Rode os testes indicados na tabela da issue
3. Para cada teste que falhar ou parecer desatualizado, siga o guia de validação acima
4. Atualize os testes necessários e marque o `REGRESSION_CHECKLIST.md`
5. Feche a issue

> **Importante:** uma issue do file-watcher não significa que os testes vão falhar — significa que o time precisa verificar ativamente. Mudanças sutis de UI (renomear um botão, mover um elemento) podem não quebrar o teste, mas invalidar o que ele está testando.

---

## Regression Checklist

Veja [`REGRESSION_CHECKLIST.md`](./REGRESSION_CHECKLIST.md) para o mapa completo de cobertura.

| Símbolo | Significado |
|---|---|
| `[x]` | Automatizado |
| `[ ]` | Não coberto |
| `[~]` | Parcialmente coberto |
| `[!]` | Flaky — precisa estabilizar |
