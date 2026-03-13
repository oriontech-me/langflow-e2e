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

### O que cada pasta faz

| Pasta | Responsabilidade |
|---|---|
| `assets/` | Arquivos estáticos usados nos testes: documentos para upload, flows JSON prontos para importação e arquivos de mídia. Nenhum código aqui — só dados. |
| `fixtures/` | Ponto de entrada para todos os testes. Estende o `test` do Playwright com monitoramento automático de erros de backend — intercepta respostas `4xx/5xx` e falhas silenciosas de flow em toda execução. Todo teste importa daqui, nunca do Playwright diretamente. |
| `helpers/` | Funções de ações específicas reutilizáveis. Encapsulam operações concretas da aplicação — selecionar provedor e modelo de um agente, adicionar um componente customizado, fazer upload de arquivo, rodar um flow. Os testes chamam essas funções sem repetir os passos. |
| `pages/` | Page Objects para navegação da interface. Cada arquivo representa uma área da UI e expõe funções para navegar até ela — abrir a Sidebar, acessar o Model Provider, ir para Settings, importar um flow. Concentra os seletores e evita que mudem em vários lugares ao mesmo tempo. |
| `tests-automations/` | Onde vivem os testes. Organizado em `regression/` (cenários de regressão mapeados no checklist) e `smoke/` (verificações rápidas de sanidade). Dentro de `regression/`, cada subpasta corresponde a uma área funcional do Langflow. |

```
tests/
├── assets/
│   ├── files/                     # documentos, PDFs, JSONs usados em upload
│   ├── flows/                     # flows JSON pré-definidos para importação
│   └── media/                     # imagens e arquivos de mídia
│
├── fixtures/
│
├── helpers/
│   ├── api/                       # chamadas e validações de endpoints REST
│   ├── auth/                      # login, logout, criação de usuários
│   ├── filesystem/                # upload e gerenciamento de arquivos
│   ├── flows/                     # criação, execução, importação e exclusão de flows
│   ├── mcp/                       # configuração de MCP server e client
│   ├── other/                     # ações diversas sem categoria específica
│   └── ui/                        # interações de canvas, componentes, sidebar e playground
│
├── pages/
│   ├── auth/                      # login, logout, tela de usuários
│   ├── components/                # sidebar de componentes, busca, filtros
│   ├── flows/                     # listagem, importação e exclusão de flows
│   └── main/                      # página principal, navegação global, MCP, settings, model provider
│
└── tests-automations/
    ├── regression/
    │   ├── api/
    │   │   └── flows/             # endpoints REST (health check, CRUD, execução, monitoramento)
    │   ├── core-components/       # configuração de componentes + componentes principais
    │   ├── core-functionality/
    │   │   ├── auth/              # autenticação e gerenciamento de usuários
    │   │   ├── knowledge-ingestion-management/  # upload, processamento e vetores
    │   │   ├── llm-agents/        # agentes e execução com LLM
    │   │   ├── model-provider/    # gestão de provedores (OpenAI, Ollama, etc.)
    │   │   ├── observability-monitoring/        # tracing, logs e métricas
    │   │   ├── playground/        # chat, renderização e testes de saída
    │   │   ├── project-management/              # gestão de projetos e pastas
    │   │   └── templates/         # modelos pré-definidos de flows e componentes
    │   ├── flow-functionality/    # execução de grafos, drag-and-drop e JSON
    │   ├── mcp/
    │   │   ├── client/            # consumo de ferramentas e contexto
    │   │   └── server/            # provedor de recursos e tools
    │   └── ui-ux/                 # interface visual, canvas e design system
    └── smoke/
        ├── api/
        └── ui-ux/
```

---

## Como criar um novo teste

**1. Escolha a pasta correta**

Localize dentro de `tests/tests-automations/regression/` a pasta que corresponde à área funcional do teste. Exemplos:

| O que você vai testar | Pasta |
|---|---|
| Login, logout, gerenciamento de usuários | `core-functionality/auth/` |
| Execução de flow, importação de JSON | `flow-functionality/` |
| Configuração de model provider | `core-functionality/model-provider/` |
| Canvas, sidebar, sticky notes | `ui-ux/` |
| Endpoints REST | `api/flows/` |
| Upload de arquivos, RAG | `core-functionality/knowledge-ingestion-management/` |
| MCP server ou client | `mcp/server/` ou `mcp/client/` |

**2. Nomeie o arquivo**

O arquivo deve terminar em `.spec.ts` e ter um nome descritivo em kebab-case que identifique o comportamento testado:

```
login-invalid-credentials.spec.ts
agent-model-provider-selection.spec.ts
canvas-add-custom-component.spec.ts
flow-import-json.spec.ts
```

**3. Estrutura básica do arquivo**

```typescript
import { test, expect } from "../../../fixtures";

test.describe("Nome da área ou funcionalidade", () => {
  test("deve [comportamento esperado] quando [condição]", async ({ page }) => {
    await test.step("Descrição do passo 1", async () => {
      // ação
    });

    await test.step("Descrição do passo 2", async () => {
      // asserção
    });
  });
});
```

> Importe sempre de `fixtures` — nunca diretamente do Playwright. A fixture base adiciona monitoramento automático de erros de backend.

**4. Use helpers e pages existentes**

Antes de escrever ações do zero, verifique se já existe um helper ou page object para o que você precisa:

```typescript
// exemplo: navegar até o model provider e selecionar um modelo
import { navigateToModelProvider } from "../../pages/main/model-provider.page";
import { selectProviderAndModel } from "../../helpers/ui/model-provider.helper";
```

**5. Adicione pelo menos uma tag**

Todo teste deve ter uma tag para poder ser filtrado por suite:

```typescript
test("deve configurar o model provider", { tag: ["@components"] }, async ({ page }) => {
```

**6. Atualize o `QA_CHECKLIST.md`**

Após criar o teste, localize o item correspondente no checklist e marque como `[-]` (automatizado, precisa validar). Somente mude para `[x]` após seguir o processo de validação descrito abaixo.

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

Veja [`QA_CHECKLIST.md`](./QA_CHECKLIST.md) para o mapa completo de cobertura.

| Símbolo | Significado |
|---|---|
| `[x]` | Automatizado |
| `[ ]` | Não coberto |
| `[~]` | Parcialmente coberto |
| `[!]` | Flaky — precisa estabilizar |
