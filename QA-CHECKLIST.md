# Langflow — Regression Test Checklist

> **Repositório:** `C:/QAx/langflow-playwright/langflow-e2e`
> **Testes:** `tests/tests-automations/regression/`
> **Config:** `playwright.config.ts`
> **Última atualização:** 2026-03-19

---

## Como usar este checklist

- `[x]` → automatizado e **validado**
- `[-]` → automatizado, **precisa validar**
- `[ ]` (vazio) → **precisa criar** automação
- `[~]` → **parcialmente** coberto
- `[!]` → coberto mas **flaky / instável**

---

---

# PART I — PAGES & HELPERS

---

## Pages

- [x] `SimpleAgentTemplatePage` — carrega template Simple Agent com provider e modelo configurável → `pages/SimpleAgentTemplatePage.ts`
- [x] `SettingsPage` — navegação à página de configurações via menu do usuário → `pages/SettingsPage.ts`
- [ ] Sidebar de componentes — barra de navegação de componentes com suporte a busca parametrizável
- [ ] Model Provider — navegação à aba de gerenciamento de provedores de modelo
- [ ] API Keys — navegação à aba de chaves de API / variáveis globais
- [ ] Templates — navegação à aba de escolha de templates (Starter Projects)
- [ ] Import Flow — navegação para importar um fluxo via JSON
- [ ] Delete Flow — navegação para excluir um fluxo
- [ ] MCP Config — navegação para configurar MCP Server

---

## Helpers

### Provider Setup

- [x] Setup de Provider OpenAI → `helpers/provider-setup/setup-openai.ts`
- [x] Setup de Provider Anthropic → `helpers/provider-setup/setup-anthropic.ts`
- [x] Setup de Provider Google Generative AI → `helpers/provider-setup/setup-google.ts`
- [x] Map de Providers (`providerSetupMap`) — ponto central de registro → `helpers/provider-setup/index.ts`
- [x] Validação de providers via API (crédito, key válida) → `helpers/provider-setup/collect-models.ts`
- [x] Coleta de modelos disponíveis via UI (Settings → Model Providers) → `helpers/provider-setup/collect-models.ts`
- [x] `providers.json` — status de cada provider (active/inactive + motivo) → `data/providers.json`
- [x] `models.json` — lista de modelos por provider → `data/models.json`

### Flows

- [x] Carregar Simple Agent com provider e modelo variável → `pages/SimpleAgentTemplatePage.ts`
- [x] Carregar Simple Agent com OpenAI (wrapper) → `helpers/flows/load-simple-agent-with-openai.ts`

### A implementar

- [ ] Configurar um MCP
- [ ] Configurar um Custom Component
- [ ] Deletar um componente
- [ ] Rodar um flow
- [ ] Pausar um flow
- [ ] Dar um chat input
- [ ] Verificar o chat output

---

---

# PART II — TEST AUTOMATION COVERAGE

> Organizado conforme `tests/tests-automations/regression/`

---

## api/ — API REST

### api/flows/ — API REST

#### 1.1 Health Check
- [-] GET `/api/v1/health_check` → status 200, db ok
- [-] GET `/api/v1/health` → retorna uptime e versão

#### 1.2 CRUD de Flows via API
- [-] POST `/api/v1/flows/` → cria flow, retorna ID
- [-] GET `/api/v1/flows/` → lista flows do usuário
- [-] GET `/api/v1/flows/{id}` → retorna flow pelo ID
- [-] PATCH `/api/v1/flows/{id}` → atualiza nome/descrição
- [-] DELETE `/api/v1/flows/{id}` → remove flow, retorna 200
- [-] GET `/api/v1/flows/{id}` após DELETE → deve retornar 404

#### 1.3 Execução de Flows via API
- [-] POST `/api/v1/run/{flow_id}` com `input_value` → retorna resposta
- [-] POST com `tweaks` → parâmetros sobrescrevem configuração do flow
- [-] POST com `session_id` customizado
- [-] POST com `input_type: "chat"` e `output_type: "chat"`
- [-] POST com API key inválida → retorna 401/403
- [-] POST para flow inexistente → retorna 404

#### 1.4 Componentes via API
- [-] GET `/api/v1/all` → lista todos os componentes disponíveis
- [-] POST `/api/v1/custom_component` → cria componente customizado

#### 1.5 Mensagens e Monitoramento via API
- [-] GET `/api/v1/monitor/messages` → retorna 200 com array
- [-] GET com filtro de session_id retorna apenas mensagens da sessão

#### 1.6 Geração de Código de Integração
- [-] Gerar curl para execução via API
- [-] Gerar código Python para integração
- [-] Modal de acesso à API

---

## core-components/ — Configuração de Componentes + Componentes Principais

### 2. Configuração de Componentes

#### 2.1 Painel de Parâmetros
- [-] Abrir opções avançadas do componente
- [-] Editar campo de texto (input)
- [-] Editar dropdown
- [-] Editar área de texto (textarea)
- [-] Editar campo de código
- [-] Editar campo float
- [-] Editar campo int
- [-] Editar campo toggle
- [-] Editar key-pair list
- [-] Editar input list
- [-] Editar table input
- [-] Editar slider
- [-] Editar tab component

#### 2.2 Tool Mode
- [-] Habilitar Tool Mode num componente
- [-] Agrupar componentes em Tool Mode
- [-] Editar tools (edit-tools)

#### 2.3 Atualização de Componentes
- [-] Notificação de componente desatualizado
- [-] Ação de atualizar componente
- [ ] Atualização com breaking change — deve alertar usuário
- [ ] Componente legado visível via configuração

#### 2.4 Edição de Código
- [-] Editar código Python do componente customizado
- [-] Componente customizado completo

---

### 3. Componentes Principais

#### 3.1 Chat Input / Output
- [-] ChatInput recebe mensagem do usuário
- [-] ChatOutput exibe resposta do LLM
- [-] Chat Input/Output com autenticação de usuário

#### 3.2 Prompt Template
- [-] Prompt com variáveis em curly braces
- [-] Modal do Prompt
- [-] Porta dinâmica gerada ao adicionar variável no prompt
- [-] Remover variável do prompt apaga porta correspondente

#### 3.3 API Request (HTTP)
- [-] Configurar URL e método HTTP
- [-] Adicionar headers e body
- [ ] Executar request GET e verificar resposta status 200
- [ ] Executar request POST com payload
- [ ] Erro de URL inválida

#### 3.4 Webhook
- [-] Componente Webhook exibido no canvas
- [-] URL de webhook gerada automaticamente
- [ ] Trigger via requisição HTTP externa
- [ ] Payload recebido propagado ao flow

#### 3.5 Agent (Componente)
- [-] Componente Agent exibido no canvas com configurações padrão
- [ ] Configurar system prompt no componente Agent
- [ ] Configurar model provider diretamente no componente Agent

#### 3.6 Loop Component
- [-] Componente Loop no canvas
- [ ] Loop executa número correto de iterações
- [ ] Loop para ao atingir condição de saída

#### 3.7 Nested / Agrupamento
- [-] Componente aninhado (nested)
- [-] Entrar e sair de componente agrupado

---

## core-functionality/ — Lógica Central e Operacional

### core-functionality/auth/ — Autenticação e Gerenciamento de Usuários

#### 4.1 Login / Logout
- [-] Login com credenciais válidas
- [-] Login com credenciais inválidas — deve exibir mensagem de erro
- [-] Logout — deve redirecionar para tela de login
- [-] Auto-login ativado — deve pular tela de login
- [-] Auto-login desativado — deve exibir tela de login
- [-] Sessão expirada — deve redirecionar para login
- [-] Limpeza de sessão após logout

#### 4.2 Gerenciamento de Usuários (Admin)
- [-] Admin cria novo usuário
- [-] Admin desativa usuário
- [-] Admin ativa usuário inativo
- [-] Admin renomeia usuário
- [-] Admin altera senha de usuário
- [-] Admin altera senha — senha antiga não funciona após troca
- [-] Fluxo de isolamento: user A não vê flows de user B

#### 4.3 Variáveis Globais (API Keys)
- [-] Criar variável global
- [ ] Usar variável global em componente (API key)
- [-] Editar variável global existente
- [-] Deletar variável global
- [-] Criar variável global do tipo "Generic"

---

### core-functionality/knowledge-ingestion-management/ — Upload, Processamento e Vetores

#### 5.1 File Upload
- [-] Upload de arquivo via componente
- [-] Upload de arquivos de diferentes tipos (txt, pdf, json, py, wav)
- [-] Limite de tamanho de arquivo
- [-] Página de gerenciamento de arquivos

#### 5.2 Processamento e Vetorização
- [ ] Ingestão de documento via componente Split Text + Embeddings
- [ ] Indexação em Vector Store — documento disponível para consulta
- [ ] Query ao Vector Store retorna chunks relevantes ao prompt
- [ ] Pipeline RAG completo (ingest → embed → store → retrieve → answer)

---

### core-functionality/llm-agents/ — Agentes e Execução com LLM

> ⚠️ Testes nesta seção usam `SimpleAgentTemplatePage` e são parametrizados por modelo via `models.json`.
> Rode `npx playwright test tests/collect-models.spec.ts` antes de executar estes testes.
> Veja `CLAUDE.md` nesta pasta para o guia completo.

#### 6.1 Execução de Agente
- [x] Agent executa com múltiplos providers e modelos (OpenAI, Anthropic, Google) → `agent-component-regression.spec.ts`
- [x] Agent exibe resposta válida para pergunta simples → `agent-component-regression.spec.ts`
- [x] Agent responde sem tools conectadas (regressão ID 147) → `agent-component-regression.spec.ts`
- [-] Agent exibe steps de raciocínio no Playground → `agent-reasoning-steps.spec.ts`
- [-] Composio (tool integration para Agent) → `composio.spec.ts`
- [ ] Agent em modo streaming — resposta exibida progressivamente no Playground

#### 6.2 Controle de Execução
- [x] Botão Stop interrompe execução do agente → `agent-component-regression.spec.ts`
- [ ] Agent para ao atingir stop condition configurada
- [ ] Agent para ao atingir número máximo de iterações
- [ ] Agent com múltiplas tools configuradas executa corretamente
- [ ] Agent com timeout configurado respeita o limite

#### 6.3 Memória e Contexto
- [x] Agent responde múltiplas mensagens consecutivas na mesma sessão → `agent-component-regression.spec.ts`
- [ ] Agent com memória persistente entre mensagens
- [ ] Agent usa `context_id` customizado
- [ ] Trocar `context_id` reseta histórico do agente

#### 6.4 Tools e Integrações
- [ ] Agent com tool MCP externo integrado executa ação e retorna resultado
- [ ] Agent executa múltiplas tools em sequência
- [ ] Tool retorna erro — agent trata e continua execução

#### 6.5 Output e Raciocínio
- [x] Duração de execução exibida após run com tools → `agent-component-regression.spec.ts`
- [ ] Inspecionar tools usadas pelo Agent no Playground
- [ ] Agent retorna output em formato JSON estruturado
- [ ] Agent retorna output em Markdown renderizado corretamente

---

### core-functionality/model-provider/ — Gestão de Provedores

> ⚠️ Testes de configuração de provider via Settings usam `SettingsPage`.
> Veja `helpers/provider-setup/` para os helpers de setup de cada provider.

#### 7.1 Coleta e Validação de Providers
- [x] Validar API keys de todos os providers via chamada real → `collect-models.spec.ts`
- [x] Coletar modelos disponíveis por provider via UI → `collect-models.spec.ts`
- [x] Providers inativos aparecem como skipped nos testes com motivo → `agent-component-regression.spec.ts`

#### 7.2 OpenAI
- [-] Configurar API key OpenAI via GlobalVariables
- [-] Selecionar modelo GPT no agente
- [-] Executar flow com OpenAI
- [-] Erro de API key inválida — exibir mensagem de erro

#### 7.3 Anthropic
- [-] Configurar API key Anthropic
- [-] Selecionar modelo Claude no agente
- [-] Trocar entre modelos Claude (Sonnet, Haiku, Opus)
- [-] Erro de API key Anthropic inválida

#### 7.4 Google Generative AI
- [-] Configurar API key Google no agente
- [-] Selecionar modelo Gemini no agente

#### 7.5 Gerenciamento de Providers
- [-] Modal "Manage Model Providers"
- [-] Contagem de providers disponíveis
- [-] Componente Language Model — configuração
- [-] Componente Model Input
- [-] Adicionar novo provider via modal
- [-] Remover API key de provider existente

#### 7.6 Provedores Open-Source
- [ ] Configurar e executar flow com Ollama (modelo local)
- [ ] Configurar e executar flow com Groq
- [ ] Configurar e executar flow com Mistral

#### 7.7 Parâmetros de Modelo (Agent)
- [ ] Parâmetro de temperatura
- [ ] Parâmetro de esforço (reasoning effort)
- [ ] Quantidade máxima de tokens
- [ ] Quantidade máxima de tentativas do agente
- [ ] Uso de `context_id` customizado
- [ ] Formatação do output (JSON, Markdown, texto simples)

---

### core-functionality/observability-monitoring/ — Tracing, Logs e Métricas

#### 8.1 Traces
- [-] Visualizar traces de execução
- [-] Trace API retorna transações paginadas
- [-] Trace exibe latência de cada componente
- [-] Trace exibe tokens consumidos

#### 8.2 Notificações
- [-] Notificações do sistema
- [-] Notificação de erro de execução
- [-] Notificação de componente desatualizado

#### 8.3 Estado do Usuário
- [-] Rastrear progresso do usuário
- [-] Limpeza de estado do flow de usuário

#### 8.4 Tratamento de Erros e Edge Cases
- [-] Componente que levanta erro Python
- [ ] Flow com erro exibe mensagem apropriada
- [-] Erro de rede durante execução
- [-] Timeout de execução — mensagem clara ao usuário

---

### core-functionality/playground/ — Chat, Renderização e Testes de Saída

#### 9.1 Interações de Chat
- [-] Abrir Playground
- [-] Enviar mensagem de texto
- [-] Receber resposta do LLM
- [-] Streaming de resposta (SSE)
- [-] Polling de resposta
- [-] Resposta direta (direct)
- [-] UX do Playground
- [!] Enviar mensagem vazia — deve desabilitar botão enviar (**BUG: botão habilitado mesmo vazio**)
- [ ] Enviar mensagem enquanto resposta em curso

#### 9.2 Histórico e Sessão
- [-] Configurar session ID customizado
- [-] Trocar session ID — inicia nova conversa
- [-] Deletar mensagem individual do histórico
- [ ] Limpar histórico completo de sessão
- [-] Histórico persiste ao reabrir Playground

#### 9.3 Features Avançadas do Playground
- [-] Modo fullscreen do Playground
- [ ] Playground compartilhável (URL pública, sem autenticação)
- [-] Voice mode (assistente de voz)
- [-] Botão Stop no Playground

#### 9.4 Output Modal
- [-] Copiar output do componente
- [-] Botão de copy no output

---

### core-functionality/project-management/ — Gestão de Projetos e Pastas

#### 10.1 CRUD de Pastas
- [-] Criar nova pasta
- [-] Renomear pasta
- [-] Deletar pasta vazia
- [-] Deletar pasta com flows dentro
- [-] Integridade após deleção
- [-] Criar pasta após deletar todas as pastas
- [-] Upload de flow por drag-and-drop na pasta
- [-] Mover flow para outra pasta

#### 10.2 Navegação de Pastas
- [~] Navegar entre pastas
- [-] Pesquisar flow por nome filtra resultados corretamente
- [-] Pastas na sidebar de navegação

---

### core-functionality/templates/ — Modelos Pré-definidos de Flows e Componentes

#### 11.1 Templates Básicos
- [-] Basic Prompting (OpenAI)
- [-] Basic Prompting (Anthropic)
- [-] Simple Agent (OpenAI)
- [-] Simple Agent (Anthropic)
- [-] Simple Agent com memória
- [-] Vector Store RAG
- [-] Memory Chatbot

#### 11.2 Templates de Geração de Conteúdo
- [-] Blog Writer
- [-] Instagram Copywriter
- [-] Twitter Thread Generator
- [-] SEO Keyword Generator
- [-] Portfolio Website Code Generator
- [-] SaaS Pricing

#### 11.3 Templates de Análise e Processamento
- [-] Document QA
- [-] Invoice Summarizer
- [-] Financial Report Parser
- [-] Image Sentiment Analysis
- [-] Text Sentiment Analysis
- [-] Youtube Analysis

#### 11.4 Templates de Agentes
- [-] Dynamic Agent
- [-] Hierarchical Agent
- [-] Sequential Task Agent
- [-] Social Media Agent
- [-] Travel Planning Agent
- [-] Market Research
- [-] Research Translation Loop
- [-] Pokedex Agent
- [-] Price Deal Finder
- [-] News Aggregator

#### 11.5 Templates Avançados
- [-] Custom Component Generator
- [-] Prompt Chaining
- [-] Decision Flow
- [-] Similarity
- [-] MCP Server (starter projects)

---

## flow-functionality/ — Execução de Grafos, Drag-and-Drop e JSON

#### 12.1 Criar Flow
- [-] Criar flow em branco (blank flow)
- [-] Criar flow a partir de template
- [-] Criar flow duplicando um existente
- [-] Criar flow via importação de arquivo JSON

#### 12.2 Visualizar e Editar Flow
- [-] Renomear flow pelo header do editor
- [-] Editar nome e descrição do flow
- [-] Auto-save do flow ao fazer alterações
- [-] Configurações do flow (flow settings)

#### 12.3 Deletar Flow
- [-] Deletar flow individual
- [-] Deletar múltiplos flows (bulk actions)
- [-] Confirmar que flow deletado não aparece na listagem

#### 12.4 Exportar / Importar Flow
- [-] Exportar flow como JSON
- [-] Importar flow via upload de arquivo JSON
- [~] Importar flow com componentes desatualizados
- [-] Importar JSON inválido — deve exibir mensagem de erro

#### 12.5 Operações de Flow
- [-] Travar (lock) flow — impede edição
- [-] Destravar flow
- [-] Mover flow entre pastas via API
- [-] Publicar flow (publish)
- [-] Salvar componentes do flow como template

#### 12.6 Execução de Flow
- [-] Executar flow pelo botão Run
- [-] Parar building do flow

---

## mcp/ — Model Context Protocol

> ⚠️ Testes que executam agentes via MCP devem usar `SimpleAgentTemplatePage` e `models.json`.
> Veja `CLAUDE.md` nesta pasta para o guia completo.

### mcp/client/ — Consumo de Ferramentas e Contexto

#### 13.1 MCP Client
- [ ] Configurar conexão com MCP server externo (stdio ou HTTP)
- [ ] Listar tools disponíveis via protocolo MCP
- [ ] Executar tool do MCP server e receber resultado no flow
- [ ] Listar resources disponíveis via protocolo MCP
- [ ] Consumir resource URI e injetar conteúdo no flow
- [ ] Erro de conexão com MCP server exibe mensagem clara

---

### mcp/server/ — Provedor de Recursos e Tools

#### 14.1 MCP Server
- [-] Aba MCP Server no flow
- [-] Adicionar MCP server via modal
- [-] Starter project com MCP
- [ ] Flow exposto como MCP server — verificar endpoint gerado
- [ ] Executar tool do MCP server via protocolo MCP
- [ ] Resource exposto pelo server é acessível via URI
- [ ] Prompt exposto pelo server retorna template correto

---

## ui-ux/ — Interface Visual, Canvas e Design System

#### 15.1 Sidebar de Componentes
- [-] Pesquisar componente por nome
- [-] Hover sobre componente exibe tooltip/preview
- [-] Pesquisa por teclado (keyboard shortcut)
- [-] Filtrar componentes por categoria
- [-] Sidebar mostra contagem correta de providers

#### 15.2 Adicionar Componentes ao Canvas
- [-] Arrastar componente da sidebar para o canvas
- [-] Duplo clique na sidebar adiciona componente ao canvas
- [-] Hover + clique no botão "+" adiciona componente ao canvas
- [-] Componente adicionado aparece com configurações padrão

#### 15.3 Conexões entre Componentes
- [-] Conectar dois componentes compatíveis
- [-] Impedir conexão entre tipos incompatíveis
- [-] Deletar edge/conexão
- [-] Filtrar edges por tipo de dado
- [-] Reconectar edge já existente

#### 15.4 Manipulação de Nós
- [-] Deletar componente do canvas
- [-] Copiar e colar componente (Ctrl+C / Ctrl+V)
- [-] Atalhos de teclado do canvas
- [-] Minimizar componente no canvas
- [-] Mover componente dentro do canvas
- [-] Selecionar múltiplos componentes via box selection
- [-] Deletar múltiplos componentes selecionados
- [-] Desselecionar nó clicando em área vazia do canvas
- [-] Desselecionar nó via Escape

#### 15.5 Zoom e Navegação do Canvas
- [-] Zoom in / Zoom out
- [-] Fit View centraliza nós
- [-] Botão Fit View na toolbar
- [-] Scroll para navegar no canvas
- [~] Minimap — feature flag-gated

#### 15.6 Agrupamento (Group)
- [-] Criar grupo de componentes
- [-] Desagrupar componentes
- [-] Expandir/colapsar grupo

#### 15.7 Freeze e Estado
- [-] Congelar componente (freeze)
- [-] Freeze path
- [-] Descongelar componente

#### 15.8 Sticky Notes
- [-] Adicionar sticky note
- [ ] Editar texto da sticky note
- [-] Mudar cor da sticky note
- [-] Redimensionar sticky note
- [-] Deletar sticky note

#### 15.9 Right-Click e Menus
- [-] Menu de contexto por right-click no canvas
- [-] Menu de contexto por right-click em componente
- [-] Ações do menu principal

#### 15.10 Settings e Configurações de UI
- [-] Acessar página de Settings
- [-] Configurações de histórico de mensagens
- [-] Alterar configurações de aparência/tema
- [-] Atalhos de teclado funcionam no editor
- [~] Todos os atalhos documentados funcionam

---

## Resumo de Cobertura — Test Automation Coverage

| Módulo | Total | Cobertos | Parcial | Não cobertos |
|--------|-------|----------|---------|--------------|
| `api/` — Auth + Variáveis | 17 | 15 | 0 | 2 |
| `api/` — API REST | 17 | 17 | 0 | 0 |
| `core-components/` — Config | 20 | 18 | 0 | 2 |
| `core-components/` — Componentes | 22 | 16 | 0 | 6 |
| `core-functionality/playground/` | 17 | 14 | 0 | 3 |
| `core-functionality/observability-monitoring/` | 16 | 13 | 0 | 3 |
| `core-functionality/model-provider/` | 20 | 13 | 0 | 7 |
| `core-functionality/llm-agents/` | 15 | 8 | 0 | 7 |
| `core-functionality/knowledge-ingestion/` | 8 | 4 | 0 | 4 |
| `flow-functionality/` | 20 | 18 | 1 | 1 |
| `mcp/server/` | 7 | 3 | 0 | 4 |
| `mcp/client/` | 6 | 0 | 0 | 6 |
| `project-management/` | 11 | 9 | 1 | 1 |
| `templates/` | 35 | 33 | 0 | 2 |
| `ui-ux/` — Canvas | 30 | 28 | 1 | 1 |
| `ui-ux/` — Settings | 4 | 4 | 0 | 0 |
| **TOTAL** | **265** | **213 (80%)** | **3** | **49 (18%)** |

---

### Prioridades para Automatizar

#### 🔴 Alta Prioridade (bloqueadores de release)
1. Erro de API key inválida (OpenAI/Anthropic)
2. Flow com erro Python exibe mensagem clara
3. Atualização com breaking change — deve alertar usuário
4. Erro de rede durante execução

#### 🟡 Média Prioridade (regressão importante)
5. MCP client — consumo de tools e resources externos
6. Agent com tool MCP externo integrado
7. Webhook trigger externo
8. Playground compartilhável (URL pública)
9. Pipeline RAG completo (knowledge-ingestion)
10. Agent — steps de raciocínio com tools usadas

#### 🟢 Baixa Prioridade (melhorias de cobertura)
11. Loop component — iterações corretas
12. MCP server endpoint gerado
13. Ollama / Groq / Mistral providers
14. Parâmetros de modelo para agentes
15. Editar texto da sticky note
16. Usar variável global em componente
