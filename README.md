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
npm test                                              # suíte completa
npm run test:core                                     # somente testes core (obrigatórios para release)
npm run test:extended                                 # somente testes extended
npm run test:regression                               # somente regressão de bugs
npx playwright test --grep "@api"                    # por tag
npx playwright test path/ao/arquivo.spec.ts          # arquivo específico
npm run report                                        # abre o último relatório HTML
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
