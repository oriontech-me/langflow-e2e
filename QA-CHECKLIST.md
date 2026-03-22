# Langflow — Regression Test Checklist

> **Repositório:** `C:/QAx/langflow-playwright/langflow-e2e`
> **Testes:** `tests/tests-automations/regression/`
> **Config:** `playwright.config.ts`
> **Última atualização:** 2026-04-26

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
- [ ] Configurar system prompt no componente Agent → `agent-system-prompt.spec.ts`
- [ ] Configurar model provider diretamente no componente Agent → `agent-provider-field-isolation.spec.ts`

#### 3.6 Loop Component
- [x] Componente Loop renderiza no canvas com title e botão run → `core-components/loop-component-regression.spec.ts`
- [x] Handles corretos: inputs-left, item-left, item-right, done-right → `core-components/loop-component-regression.spec.ts`
- [x] Botões de output inspection presentes para item e done → `core-components/loop-component-regression.spec.ts`
- [x] Run sem conexões exibe notificação "Flow build failed" sem crash → `core-components/loop-component-regression.spec.ts`
- [x] Loop itera sobre 2 artigos ArXiv (template Research Translation Loop) e agrega resposta no Playground → `core-components/loop-component-regression.spec.ts`
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

#### 6.1 agent-component-regression.spec.ts — Regressão de Comportamento do Agente `@stable`
- [x] Agent responde sem tools conectadas
- [x] Agent exibe resposta válida e opcionalmente steps de raciocínio
- [x] Botão Stop interrompe execução do agente
- [x] Duração de execução exibida após run bem-sucedido
- [x] Resposta exibida progressivamente no Playground (streaming)
- [x] Indicador de duração exibido no canvas (`node_duration_agent`) após fechar o playground
- [x] Agent responde múltiplas mensagens consecutivas na mesma sessão

#### 6.2 Outros testes de execução
- [-] Agent exibe steps de raciocínio no Playground → `agent-reasoning-steps.spec.ts`
- [-] Composio (tool integration para Agent) → `composio.spec.ts`
- [ ] Agent para ao atingir stop condition configurada
- [ ] Agent para ao atingir número máximo de iterações → `agent-max-iterations.spec.ts`
- [ ] Agent com múltiplas tools configuradas executa corretamente → `agent-multi-tool-selection.spec.ts`
- [ ] Agent com timeout configurado respeita o limite
- [ ] Trocar de provider no Agent → campos do provider anterior não persistem → `agent-provider-field-isolation.spec.ts`
- [ ] Flow com Agent salvo e reaberto → configurações preservadas → `agent-config-persistence.spec.ts`
- [ ] max_tokens trunca resposta conforme configurado → `agent-max-tokens.spec.ts`
- [ ] Campo reasoning_effort aparece/some conforme modelo selecionado → `agent-reasoning-effort.spec.ts`

#### 6.3 Memória e Contexto
- [x] Memory Chatbot template carrega com estrutura correta de nós e arestas → `llm-agents/memory-history-regression.spec.ts`
- [x] Message History retém contexto entre mensagens na mesma sessão do Playground → `llm-agents/memory-history-regression.spec.ts`
- [x] Isolamento de sessão: session IDs distintos têm históricos independentes → `llm-agents/memory-history-regression.spec.ts`
- [x] Mensagens persistem após fechar e reabrir o Playground → `llm-agents/memory-history-regression.spec.ts`
- [x] Sem Message History, LLM não retém contexto entre mensagens → `llm-agents/memory-history-regression.spec.ts`
- [ ] Parâmetro n_messages limita quantidade de mensagens retidas → `agent-n-messages-limit.spec.ts` (**bug confirmado**: valor salvo corretamente pelo frontend mas ignorado na execução do backend)
- [ ] Agent usa `context_id` customizado — continuidade entre mensagens na sessão → `agent-context-id-continuity.spec.ts`
- [ ] Trocar `context_id` isola histórico entre sessões distintas → `agent-context-id-isolation.spec.ts`

#### 6.4 Tools e Integrações
- [ ] Agent com tool MCP externo integrado executa ação e retorna resultado
- [ ] Agent executa múltiplas tools em sequência
- [ ] Tool retorna erro — agent trata e continua execução → `agent-tool-error-handling.spec.ts`
- [ ] Múltiplas tools conectadas — agente seleciona a correta para cada prompt → `agent-multi-tool-selection.spec.ts`
- [ ] Tool com nome inválido — validação impede execução com mensagem clara → `agent-tool-name-validation.spec.ts`

#### 6.5 Output e Raciocínio
- [ ] Inspecionar tools usadas pelo Agent no Playground
- [ ] Agent retorna output em formato JSON estruturado (output_schema) → `agent-structured-output.spec.ts`
- [ ] Agent retorna output em Markdown renderizado corretamente
- [ ] Agent Instructions (system prompt) é respeitado na resposta do modelo → `agent-system-prompt.spec.ts`
- [ ] Input via campo direto vs handle (ChatInput) — ambos funcionam → `agent-input-sources.spec.ts`
- [ ] Resposta vazia ou recusa do modelo — componente não crasha → `agent-empty-refusal-response.spec.ts`
- [ ] Toggle add_current_date_tool funciona (liga/desliga tool de data) → `agent-current-date-tool.spec.ts`
- [ ] handle_parsing_errors=False falha explicitamente vs True auto-corrige → `agent-parse-error-behavior.spec.ts`
- [ ] Imagem passada via handle de input é processada corretamente → `agent-multimodal-image-input.spec.ts`

---

### core-functionality/model-provider/ — Gestão de Provedores

> ⚠️ Testes de configuração de provider via Settings usam `SettingsPage`.
> Veja `helpers/provider-setup/` para os helpers de setup de cada provider.

#### 7.1 Coleta e Validação de Providers
- [x] Validar API keys de todos os providers via chamada real → `collect-models.spec.ts`
- [x] Coletar modelos disponíveis por provider via UI → `collect-models.spec.ts`
- [x] Providers inativos aparecem como skipped nos testes com motivo → `agent-component-regression.spec.ts`
- [x] Configurar API key de provider via Save Configuration (primeiro setup) → `collect-models.spec.ts`
- [x] Substituir API key de provider via Replace Configuration (chave existente) → `collect-models.spec.ts`

#### 7.2 OpenAI
- [-] Configurar API key OpenAI via GlobalVariables
- [-] Selecionar modelo GPT no agente
- [-] Executar flow com OpenAI
- [x] Erro de API key inválida — exibir mensagem de erro → `provider-invalid-auth-error.spec.ts`

#### 7.3 Anthropic
- [-] Configurar API key Anthropic
- [-] Selecionar modelo Claude no agente
- [-] Trocar entre modelos Claude (Sonnet, Haiku, Opus)
- [x] Erro de API key Anthropic inválida → `provider-invalid-auth-error.spec.ts`

#### 7.4 Google Generative AI
- [-] Configurar API key Google no agente
- [-] Selecionar modelo Gemini no agente
- [x] Erro de API key Google inválida → `provider-invalid-auth-error.spec.ts`

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
- [ ] Parâmetro de temperatura (verificar via network payload) → `agent-max-tokens.spec.ts`
- [ ] Parâmetro de esforço (reasoning effort) — campo condicional ao modelo → `agent-reasoning-effort.spec.ts`
- [ ] Quantidade máxima de tokens — resposta truncada conforme configurado → `agent-max-tokens.spec.ts`
- [ ] Quantidade máxima de iterações do agente → `agent-max-iterations.spec.ts`
- [ ] Uso de `context_id` customizado para isolamento de memória → `agent-context-id-isolation.spec.ts`
- [ ] Formatação do output (JSON via output_schema, Markdown, texto simples) → `agent-structured-output.spec.ts`

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
- [-] Abrir Playground → (via playground-btn-flow-io)
- [-] Enviar mensagem de texto → (via input-chat-playground + button-send)
- [-] Receber resposta do LLM → (via div-chat-message)
- [-] Streaming de resposta (SSE) → `withEventDeliveryModes` (modo streaming)
- [-] Polling de resposta → `withEventDeliveryModes` (modo polling)
- [-] Resposta direta (direct) → `withEventDeliveryModes` (modo direct)
- [x] UX do Playground (playground-ux) → `playground/playground-ux.spec.ts`
- [!] Enviar mensagem vazia — deve desabilitar botão enviar → `playground/playground-empty-message-send.spec.ts` (**BUG: botão habilitado mesmo vazio**)
- [ ] Enviar mensagem enquanto resposta em curso — deve aguardar ou enfileirar

#### 9.2 Histórico e Sessão
- [-] Configurar session ID customizado → `core/features/settings-message-history.spec.ts`
- [-] Trocar session ID — inicia nova conversa → `core/features/playground-session-id.spec.ts`
- [-] Deletar mensagem individual do histórico → `core/features/playground-message-delete.spec.ts`
- [x] Limpar histórico completo de sessão (Default session) → `playground/playground-clear-history.spec.ts`
- [x] Deletar sessão criada pelo usuário → `playground/playground-clear-history.spec.ts`
- [-] Histórico persiste ao reabrir Playground → `core/features/playground-history-persist.spec.ts`

#### 9.3 Features Avançadas do Playground
- [x] Modo fullscreen do Playground → `playground/playground-fullscreen.spec.ts`
- [ ] Playground compartilhável (URL pública, sem autenticação)
- [-] Voice mode (assistente de voz)
- [-] Botão Stop no Playground

#### 9.4 Output Modal
- [-] Copiar output do componente
- [-] Botão de copy no output

#### 9.5 Output de Dados Estruturados
- [x] JSON Data output renderiza como code block → `core-functionality/playground/playground-output-data.spec.ts`
- [x] DataFrame output renderiza como tabela Markdown → `core-functionality/playground/playground-output-data.spec.ts`

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
- [-] **Basic Prompting** (OpenAI) → `core/integrations/Basic Prompting.spec.ts`
- [-] **Basic Prompting** (Anthropic) → `core/integrations/Basic Prompting Anthropic.spec.ts`
- [-] **Simple Agent** (OpenAI) → `core/integrations/Simple Agent.spec.ts`
- [-] **Simple Agent** (Anthropic) → `core/integrations/Simple Agent Anthropic.spec.ts`
- [-] **Simple Agent** com memória → `core/integrations/Simple Agent Memory.spec.ts`
- [-] **Vector Store RAG** → `core/integrations/Vector Store.spec.ts`
- [x] **Memory Chatbot** → `llm-agents/memory-history-regression.spec.ts`

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
- [-] Executar flow pelo botão Run → `core/features/run-flow.spec.ts`
- [-] Parar building do flow → `core/features/stop-building.spec.ts`
- [!] Botão playground desabilitado com flow vazio — precisa revisão → `regression/flow-functionality/generalBugs-shard-3.spec.ts` (**teste skipado: assertion era no-op, comportamento atual do Langflow a confirmar**)

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
| `core-functionality/model-provider/` | 21 | 13 | 0 | 8 |
| `core-functionality/llm-agents/` | 15 | 8 | 0 | 7 |
| `core-functionality/knowledge-ingestion/` | 8 | 4 | 0 | 4 |
| `flow-functionality/` | 20 | 18 | 1 | 1 |
| `mcp/server/` | 7 | 3 | 0 | 4 |
| `mcp/client/` | 6 | 0 | 0 | 6 |
| `project-management/` | 11 | 9 | 1 | 1 |
| `templates/` | 35 | 33 | 0 | 2 |
| `ui-ux/` — Canvas | 30 | 28 | 1 | 1 |
| `ui-ux/` — Settings | 4 | 4 | 0 | 0 |
| **TOTAL** | **266** | **213 (80%)** | **3** | **50 (19%)** |

---

## Roadmap de Implementação

---

### 🟢 Fase 0 — Validado

> Testes com cobertura confirmada (`[x]`).

#### Pages & Helpers
- [x] `SimpleAgentTemplatePage` — carrega template Simple Agent com provider e modelo configurável → `pages/SimpleAgentTemplatePage.ts`
- [x] `SettingsPage` — navegação à página de configurações via menu do usuário → `pages/SettingsPage.ts`
- [x] Setup de Provider OpenAI → `helpers/provider-setup/setup-openai.ts`
- [x] Setup de Provider Anthropic → `helpers/provider-setup/setup-anthropic.ts`
- [x] Setup de Provider Google Generative AI → `helpers/provider-setup/setup-google.ts`
- [x] Map de Providers (`providerSetupMap`) → `helpers/provider-setup/index.ts`
- [x] Validação de providers via API (crédito, key válida) → `helpers/provider-setup/collect-models.ts`
- [x] Coleta de modelos disponíveis por provider via UI → `helpers/provider-setup/collect-models.ts`
- [x] Carregar Simple Agent com provider e modelo variável → `pages/SimpleAgentTemplatePage.ts`
- [x] Carregar Simple Agent com OpenAI (wrapper) → `helpers/flows/load-simple-agent-with-openai.ts`

#### core-functionality/llm-agents/
- [x] Agent executa com múltiplos providers e modelos (OpenAI, Anthropic, Google) → `agent-component-regression.spec.ts`
- [x] Agent exibe resposta válida para pergunta simples → `agent-component-regression.spec.ts`
- [x] Agent responde sem tools conectadas (regressão ID 147) → `agent-component-regression.spec.ts`
- [x] Botão Stop interrompe execução do agente → `agent-component-regression.spec.ts`
- [x] Agent responde múltiplas mensagens consecutivas na mesma sessão → `agent-component-regression.spec.ts`
- [x] Duração de execução exibida após run com tools → `agent-component-regression.spec.ts`
- [x] Memory Chatbot template carrega com estrutura correta de nós e arestas → `memory-history-regression.spec.ts`
- [x] Message History retém contexto entre mensagens na mesma sessão → `memory-history-regression.spec.ts`
- [x] Isolamento de sessão: session IDs distintos têm históricos independentes → `memory-history-regression.spec.ts`
- [x] Mensagens persistem após fechar e reabrir o Playground → `memory-history-regression.spec.ts`
- [x] Sem Message History, LLM não retém contexto entre mensagens → `memory-history-regression.spec.ts`

#### core-functionality/model-provider/
- [x] Validar API keys de todos os providers via chamada real → `collect-models.spec.ts`
- [x] Coletar modelos disponíveis por provider via UI → `collect-models.spec.ts`
- [x] Providers inativos aparecem como skipped nos testes com motivo → `agent-component-regression.spec.ts`

#### core-functionality/templates/
- [x] Memory Chatbot → `memory-history-regression.spec.ts`

---

### 🔵 Fase 1 — Próxima Entrega

> Validar (`[-]`) e criar (`[ ]`) nos módulos abaixo. Ver detalhes na Part II.

| Módulo | Validar (`[-]`) | Criar (`[ ]`) |
|--------|-----------------|---------------|
| `api/` — Auth + Variáveis | 18 | 1 |
| `api/` — API REST | 21 | 0 |
| `core-components/` — Componentes | 36 | 11 |
| `core-functionality/llm-agents/` | 2 | 15 |
| `core-functionality/model-provider/` | 16 | 8 |
| `core-functionality/playground/` | 17 | 3 |
| `mcp/client/` | 0 | 6 |
| `mcp/server/` | 3 | 4 |
| `ui-ux/` — Canvas | 43 | 1 |

---

### 🟡 Fase 2 — Entrega Seguinte

> Módulos restantes após conclusão da Fase 1. Ver detalhes na Part II.

| Módulo | Validar (`[-]`) | Criar (`[ ]`) |
|--------|-----------------|---------------|
| `core-functionality/observability-monitoring/` | 12 | 1 |
| `core-functionality/knowledge-ingestion/` | 4 | 4 |
| `flow-functionality/` | 23 | 0 |
| `core-functionality/project-management/` | 11 | 0 |
| `core-functionality/templates/` | 34 | 0 |
| `ui-ux/` — Settings | 5 | 0 |
