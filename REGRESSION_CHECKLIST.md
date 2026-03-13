# Langflow — Regression Test Checklist

> **Repositório:** `C:/QAx/langflow-playwright/langflow-e2e`
> **Testes:** `tests/tests-automations/regression/`
> **Config:** `playwright.config.ts`
> **Última atualização:** 2026-03-13

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

> _Conteúdo a ser adicionado. Envie a estrutura para esta seção ser preenchida._

---

## Pages

- [ ] Sidebar de componentes — barra de navegação de componentes com suporte a busca parametrizável (search como variável)
- [ ] Settings — navegação à aba de configurações gerais
- [ ] Model Provider — navegação à aba de gerenciamento de provedores de modelo
- [ ] API Keys — navegação à aba de chaves de API / variáveis globais
- [ ] Templates — navegação à aba de escolha de templates (Starter Projects)
- [ ] Import Flow — navegação para importar um fluxo via JSON
- [ ] Delete Flow — navegação para excluir um fluxo
- [ ] Delete Project — navegação para excluir um projeto/pasta
- [ ] MCP Config — navegação para configurar MCP Server

---

## Helpers

- [ ] Configurar um MCP
- [ ] Configurar um Provedor/Modelo
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

## api/ — Autenticação + API REST

### 1. Autenticação e Gerenciamento de Usuários

#### 1.1 Login / Logout
- [-] Login com credenciais válidas (admin/admin) → `core/features/auto-login-off.spec.ts`
- [-] Login com credenciais inválidas — deve exibir mensagem de erro → `core/features/login-invalid-credentials.spec.ts`
- [-] Logout — deve redirecionar para tela de login → `core/features/logout-flow.spec.ts`
- [-] Auto-login ativado (LANGFLOW_AUTO_LOGIN=true) — deve pular tela de login → `core/features/auto-login-off.spec.ts`
- [-] Auto-login desativado — deve exibir tela de login → `extended/features/autoLogin.spec.ts`
- [-] Sessão expirada — deve redirecionar para login ao tentar ação autenticada → `core/features/session-expired.spec.ts`
- [-] Limpeza de sessão após logout → `core/regression/general-bugs-remove-session-after-logout.spec.ts`

#### 1.2 Gerenciamento de Usuários (Admin)
- [-] Admin cria novo usuário → `core/features/auto-login-off.spec.ts`
- [-] Admin desativa usuário — usuário não consegue mais logar → `core/features/admin-user-management.spec.ts`
- [-] Admin ativa usuário inativo — usuário consegue logar após ativação → `core/features/admin-user-management.spec.ts`
- [-] Admin renomeia usuário → `core/features/admin-user-management.spec.ts`
- [-] Admin altera senha de usuário — usuário loga com nova senha → `core/features/admin-password-change.spec.ts`
- [-] Admin altera senha — senha antiga não funciona após troca → `core/features/admin-password-change.spec.ts`
- [-] Fluxo de isolamento: user A não vê flows de user B → `core/features/auto-login-off.spec.ts`
- [-] Configurações de usuário (user settings) → `extended/features/userSettings.spec.ts`

#### 1.3 Variáveis Globais (API Keys)
- [-] Criar variável global → `core/features/globalVariables.spec.ts`
- [ ] Usar variável global em componente (API key)
- [-] Editar variável global existente → `core/features/global-variable-edit.spec.ts`
- [-] Deletar variável global → `core/features/global-variables-crud.spec.ts`
- [-] Criar variável global do tipo "Generic" → `core/features/global-variables-crud.spec.ts`

---

### 2. API REST

#### 2.1 Health Check
- [-] GET `/api/v1/health_check` → status 200, db ok → `core/features/api-health-check.spec.ts`
- [-] GET `/api/v1/health` → retorna uptime e versão → `core/features/api-health-check.spec.ts`

#### 2.2 CRUD de Flows via API
- [-] POST `/api/v1/flows/` → cria flow, retorna ID → `core/features/api-flows-crud.spec.ts`
- [-] GET `/api/v1/flows/` → lista flows do usuário → `core/features/api-flows-crud.spec.ts`
- [-] GET `/api/v1/flows/{id}` → retorna flow pelo ID → `core/features/api-flows-crud.spec.ts`
- [-] PATCH `/api/v1/flows/{id}` → atualiza nome/descrição → `core/features/api-flows-crud.spec.ts`
- [-] DELETE `/api/v1/flows/{id}` → remove flow, retorna 200 → `core/features/api-flows-crud.spec.ts`
- [-] GET `/api/v1/flows/{id}` após DELETE → deve retornar 404 → `core/features/api-flows-crud.spec.ts`

#### 2.3 Execução de Flows via API
- [-] POST `/api/v1/run/{flow_id}` com `input_value` → retorna resposta → `core/features/api-run-flow.spec.ts`
- [-] POST com `tweaks` → parâmetros sobrescrevem configuração do flow → `core/features/api-run-with-tweaks.spec.ts`
- [-] POST com `session_id` customizado → `core/features/api-run-flow.spec.ts`
- [-] POST com `input_type: "chat"` e `output_type: "chat"` → `core/features/api-run-with-tweaks.spec.ts`
- [-] POST com API key inválida → retorna 401/403 → `core/features/api-run-flow.spec.ts`
- [-] POST para flow inexistente → retorna 404 → `core/features/api-run-flow.spec.ts`

#### 2.4 Componentes via API
- [-] GET `/api/v1/all` → lista todos os componentes disponíveis → `core/features/api-run-flow.spec.ts`
- [-] POST `/api/v1/custom_component` → cria componente customizado → `core/features/api-custom-component.spec.ts`

#### 2.5 Mensagens e Monitoramento via API
- [-] GET `/api/v1/monitor/messages` → retorna 200 com array → `core/features/api-monitor-messages.spec.ts`
- [-] GET com filtro de session_id retorna apenas mensagens da sessão → `core/features/api-monitor-messages.spec.ts`

#### 2.6 Geração de Código de Integração
- [-] Gerar curl para execução via API → `extended/features/curlApiGeneration.spec.ts`
- [-] Gerar código Python para integração → `extended/features/pythonApiGeneration.spec.ts`
- [-] Modal de acesso à API (api-access-button) → `core/features/tweaksTest.spec.ts`

---

## core-components/ — Configuração de Componentes + Componentes Principais

### 3. Configuração de Componentes

#### 3.1 Painel de Parâmetros
- [-] Abrir opções avançadas do componente → `core/features/` (open-advanced-options util)
- [-] Editar campo de texto (input) → `core/unit/inputComponent.spec.ts`
- [-] Editar dropdown → `core/unit/dropdownComponent.spec.ts`
- [-] Editar área de texto (textarea) → `core/unit/textAreaModalComponent.spec.ts`
- [-] Editar campo de código → `core/unit/codeAreaModalComponent.spec.ts`
- [-] Editar campo float → `core/unit/floatComponent.spec.ts`
- [-] Editar campo int → `core/unit/intComponent.spec.ts`
- [-] Editar campo toggle → `core/unit/toggleComponent.spec.ts`
- [-] Editar key-pair list → `core/unit/keyPairListComponent.spec.ts`
- [-] Editar input list → `core/unit/inputListComponent.spec.ts`
- [-] Editar table input → `core/unit/tableInputComponent.spec.ts`
- [-] Editar slider → `core/unit/sliderComponent.spec.ts`
- [-] Editar tab component → `core/unit/tabComponent.spec.ts`

#### 3.2 Tool Mode
- [-] Habilitar Tool Mode num componente → `extended/features/tool-mode.spec.ts`
- [-] Agrupar componentes em Tool Mode → `core/features/toolModeGroup.spec.ts`
- [-] Editar tools (edit-tools) → `extended/features/edit-tools.spec.ts`

#### 3.3 Atualização de Componentes
- [-] Notificação de componente desatualizado → `extended/features/outdated-message.spec.ts`
- [-] Ação de atualizar componente → `extended/features/outdated-actions.spec.ts`
- [ ] Atualização com breaking change — deve alertar usuário
- [ ] Componente legado visível via configuração

#### 3.4 Edição de Código
- [-] Editar código Python do componente customizado → `core/features/customComponentAdd.spec.ts`
- [-] Componente customizado completo → `core/unit/` (custom_component_full.ts)

---

### 4. Componentes Principais

#### 4.1 Chat Input / Output
- [-] ChatInput recebe mensagem do usuário → `core/unit/chatInputOutput.spec.ts`
- [-] ChatOutput exibe resposta do LLM → `core/integrations/textInputOutput.spec.ts`
- [-] Chat Input/Output com autenticação de usuário → `core/integrations/chatInputOutputUser-shard-0.spec.ts`

#### 4.2 Prompt Template
- [-] Prompt com variáveis em curly braces → `core/regression/generalBugs-prompt.spec.ts`
- [-] Modal do Prompt → `core/unit/promptModalComponent.spec.ts`
- [-] Porta dinâmica gerada ao adicionar variável no prompt → `core/features/prompt-dynamic-variables.spec.ts`
- [-] Remover variável do prompt apaga porta correspondente → `core/features/prompt-remove-variable.spec.ts`

#### 4.3 API Request (HTTP)
- [-] Configurar URL e método HTTP → `core/features/api-component-regression.spec.ts`
- [-] Adicionar headers e body → `core/features/api-request-component-ui.spec.ts`
- [ ] Executar request GET e verificar resposta status 200
- [ ] Executar request POST com payload
- [ ] Erro de URL inválida

#### 4.4 Webhook
- [-] Componente Webhook exibido no canvas → `core/unit/webhookComponent.spec.ts`
- [-] URL de webhook gerada automaticamente → `core/features/webhook-component-regression.spec.ts`
- [ ] Trigger via requisição HTTP externa
- [ ] Payload recebido propagado ao flow

#### 4.5 Agent
- [-] Agent com tool calling → `core/features/agent-component-regression.spec.ts`
- [-] Agent exibe steps de raciocínio no Playground → `core/features/agent-reasoning-steps.spec.ts`
- [ ] Agent para ao atingir stop condition
- [ ] Agent com múltiplas tools configuradas
- [-] Composio (tool integration para Agent) → `core/features/composio.spec.ts`

#### 4.6 Loop Component
- [-] Componente Loop no canvas → `extended/features/loop-component.spec.ts`
- [ ] Loop executa número correto de iterações
- [ ] Loop para ao atingir condição de saída

#### 4.7 Nested / Agrupamento
- [-] Componente aninhado (nested) → `core/unit/nestedComponent.spec.ts`
- [-] Entrar e sair de componente agrupado → `core/features/group-enter-exit.spec.ts`

---

## core-functionality/ — Lógica Central e Operacional

### core-functionality/playground/ — Chat, Renderização e Testes de Saída

#### 5. Playground

##### 5.1 Interações de Chat
- [-] Abrir Playground → (via playground-btn-flow-io)
- [-] Enviar mensagem de texto → (via input-chat-playground + button-send)
- [-] Receber resposta do LLM → (via div-chat-message)
- [-] Streaming de resposta (SSE) → `withEventDeliveryModes` (modo streaming)
- [-] Polling de resposta → `withEventDeliveryModes` (modo polling)
- [-] Resposta direta (direct) → `withEventDeliveryModes` (modo direct)
- [-] UX do Playground (playground-ux) → `core/features/playground-ux.spec.ts`
- [!] Enviar mensagem vazia — deve desabilitar botão enviar → `core/features/playground-empty-message-send.spec.ts` (**BUG: botão habilitado mesmo vazio**)
- [ ] Enviar mensagem enquanto resposta em curso — deve aguardar ou enfileirar

##### 5.2 Histórico e Sessão
- [-] Configurar session ID customizado → `core/features/settings-message-history.spec.ts`
- [-] Trocar session ID — inicia nova conversa → `core/features/playground-session-id.spec.ts`
- [-] Deletar mensagem individual do histórico → `core/features/playground-message-delete.spec.ts`
- [ ] Limpar histórico completo de sessão
- [-] Histórico persiste ao reabrir Playground → `core/features/playground-history-persist.spec.ts`

##### 5.3 Features Avançadas do Playground
- [-] Modo fullscreen do Playground → `core/features/playground-fullscreen.spec.ts`
- [ ] Playground compartilhável (URL pública, sem autenticação)
- [-] Voice mode (assistente de voz) → `core/features/voice-assistant.spec.ts`
- [ ] Inspecionar steps de raciocínio do Agent
- [ ] Inspecionar tools usadas pelo Agent
- [-] Botão Stop no Playground → `extended/features/stop-button-playground.spec.ts`

##### 5.4 Output Modal
- [-] Copiar output do componente → `extended/features/output-modal-copy-button.spec.ts`
- [-] Botão de copy no output → `extended/features/copy-button-in-output.spec.ts`

---

### core-functionality/observability-monitoring/ — Tracing, Logs e Métricas

#### 6. Observabilidade e Monitoramento

##### 6.1 Traces
- [-] Visualizar traces de execução → `core/features/traces.spec.ts`
- [-] Trace API retorna transações paginadas → `core/features/traces-detail.spec.ts`
- [-] Trace exibe latência de cada componente → `core/features/traces-latency-tokens.spec.ts`
- [-] Trace exibe tokens consumidos → `core/features/traces-latency-tokens.spec.ts`

##### 6.2 Notificações
- [-] Notificações do sistema → `extended/features/notifications.spec.ts`
- [-] Notificação de erro de execução → `core/features/execution-error-notification.spec.ts`
- [-] Notificação de componente desatualizado → `core/features/outdated-component-notification.spec.ts`

##### 6.3 Estado do Usuário
- [-] Rastrear progresso do usuário → `core/features/user-progress-track.spec.ts`
- [-] Limpeza de estado do flow de usuário → `core/features/user-flow-state-cleanup.spec.ts`

##### 6.4 Tratamento de Erros e Edge Cases
- [-] Componente que levanta erro Python → `extended/features/validate-raise-errors-components.spec.ts`
- [ ] Flow com erro exibe mensagem apropriada
- [-] Erro de rede durante execução — retry ou mensagem clara → `core/features/execution-error-notification.spec.ts`
- [-] Timeout de execução — mensagem clara ao usuário → `core/features/execution-error-notification.spec.ts`
- [-] Bugs gerais shard-4 → `core/regression/generalBugs-shard-4.spec.ts`
- [-] Bugs gerais shard-5 → `core/regression/generalBugs-shard-5.spec.ts`
- [-] Bugs gerais shard-9 → `core/regression/generalBugs-shard-9.spec.ts`
- [-] Bugs de agente (extended) → `extended/regression/`
- [-] Bugs de minimize, move, save → `extended/regression/`
- [-] Bugs de truncation, icons → `extended/regression/`

---

### core-functionality/model-provider/ — Gestão de Provedores

#### 7. Integrações LLM e Model Providers

##### 7.1 OpenAI
- [-] Configurar API key OpenAI via GlobalVariables → `core/features/globalVariables.spec.ts`
- [-] Selecionar modelo GPT (GPT-4o-mini) → `utils/select-gpt-model.ts`
- [-] Executar flow com OpenAI → todos os testes de integration
- [-] Trocar versão do modelo GPT (dropdown) → `core/features/gpt-model-version.spec.ts`
- [-] Erro de API key inválida — exibir mensagem de erro → `core/features/llm-invalid-api-key-ui.spec.ts` (mocked)

##### 7.2 Anthropic
- [-] Configurar API key Anthropic → `utils/select-anthropic-model.ts`
- [-] Selecionar modelo Claude → `core/integrations/Basic Prompting Anthropic.spec.ts`
- [-] Trocar entre modelos Claude (Sonnet, Haiku, Opus) → `core/features/claude-model-switch.spec.ts`
- [-] Erro de API key Anthropic inválida → `core/features/api-invalid-key.spec.ts` (API-level)

##### 7.3 Gerenciamento de Providers
- [-] Modal "Manage Model Providers" → `core/features/modelProviderModal.spec.ts`
- [-] Contagem de providers disponíveis → `core/features/modelProviderCount.spec.ts`
- [-] Componente Language Model — configuração → `core/features/language-model-regression.spec.ts`
- [-] Componente Model Input → `core/features/modelInputComponent.spec.ts`
- [-] Adicionar novo provider via modal → `core/features/model-provider-api-key.spec.ts`, `core/features/model-provider-modal-actions.spec.ts`
- [-] Remover API key de provider existente → `core/features/remove-provider-api-key.spec.ts`

##### 7.4 Provedores Open-Source
- [ ] Configurar e executar flow com Ollama (modelo local)
- [ ] Configurar e executar flow com Groq
- [ ] Configurar e executar flow com Mistral
- [ ] Configurar e executar flow com outros provedores open-source disponíveis no modal

##### 7.5 Parâmetros de Modelo (Agent)
- [ ] Parâmetro de temperatura — variação afeta o comportamento da resposta
- [ ] Parâmetro de esforço (reasoning effort) — variação afeta profundidade do raciocínio
- [ ] Quantidade máxima de tokens — resposta respeitada ao limite configurado
- [ ] Quantidade máxima de tentativas e interações do agente — agente para ao atingir o limite
- [ ] Uso de `context_id` customizado — memória isolada por contexto
- [ ] Formatação do output — resposta respeita formato configurado (JSON, Markdown, texto simples)

---

### core-functionality/knowledge-ingestion/ — Upload, Processamento e Vetores

#### 8. Knowledge Ingestion

##### 8.1 File Upload
- [-] Upload de arquivo via componente → `core/unit/fileUploadComponent.spec.ts`
- [-] Upload de arquivos de diferentes tipos (txt, pdf, json, py, wav) → `utils/upload-file.ts`
- [-] Limite de tamanho de arquivo → `extended/features/limit-file-size-upload.spec.ts`
- [-] Página de gerenciamento de arquivos → `extended/features/files-page.spec.ts`

##### 8.2 Processamento e Vetorização
- [ ] Ingestão de documento via componente Split Text + Embeddings
- [ ] Indexação em Vector Store (Chroma/Astra/Pinecone) — documento disponível para consulta
- [ ] Query ao Vector Store retorna chunks relevantes ao prompt
- [ ] Pipeline RAG completo (ingest → embed → store → retrieve → answer) executa sem erro

---

## flow-functionality/ — Execução de Grafos, Drag-and-Drop e JSON

### 9. Gerenciamento de Flows (CRUD)

#### 9.1 Criar Flow
- [-] Criar flow em branco (blank flow) → `core/features/` (awaitBootstrapTest)
- [-] Criar flow a partir de template (via modal "New Flow") → `core/integrations/`
- [-] Criar flow duplicando um existente → `core/features/duplicate-flow.spec.ts`
- [-] Criar flow via importação de arquivo JSON → `core/features/import-flow-json.spec.ts`

#### 9.2 Visualizar e Editar Flow
- [-] Renomear flow pelo header do editor → `core/features/` (rename-flow util)
- [-] Editar nome e descrição do flow → `extended/features/edit-flow-name.spec.ts`
- [-] Auto-save do flow ao fazer alterações → `extended/features/auto-save-off.spec.ts`
- [-] Configurações do flow (flow settings) → `extended/features/flowSettings.spec.ts`

#### 9.3 Deletar Flow
- [-] Deletar flow individual → `extended/features/deleteFlows.spec.ts`
- [-] Deletar múltiplos flows (bulk actions) → `extended/features/bulk-actions.spec.ts`
- [-] Confirmar que flow deletado não aparece na listagem → `core/features/api-flows-crud.spec.ts`

#### 9.4 Exportar / Importar Flow
- [-] Exportar flow como JSON → `core/features/export-import-flow.spec.ts`
- [-] Importar flow via upload de arquivo JSON → `core/features/export-import-flow.spec.ts`
- [~] Importar flow com componentes desatualizados — deve mostrar aviso de atualização → `core/features/outdated-component-notification.spec.ts`
- [-] Importar JSON inválido — deve exibir mensagem de erro → `core/features/import-invalid-json.spec.ts`

#### 9.5 Operações de Flow
- [-] Travar (lock) flow — impede edição → `core/features/flow-lock.spec.ts`
- [-] Destravar flow → `extended/features/lock-flow.spec.ts`
- [-] Mover flow entre pastas via API (PATCH folder_id) → `core/features/api-folders-crud.spec.ts`
- [-] Publicar flow (publish) → `core/features/publish-flow.spec.ts`
- [-] Salvar componentes do flow como template → `core/features/save-flow-as-template.spec.ts`

#### 9.6 Execução de Flow
- [-] Executar flow pelo botão Run → `core/features/run-flow.spec.ts`
- [-] Parar building do flow → `core/features/stop-building.spec.ts`

---

## mcp/ — Model Context Protocol

### mcp/server/ — Provedor de Recursos e Tools

#### 10. MCP Server

- [-] Aba MCP Server no flow → `extended/features/mcp-server-tab.spec.ts`
- [-] Adicionar MCP server via modal → `extended/features/mcp-server.spec.ts`
- [-] Starter project com MCP → `extended/features/mcp-server-starter-projects.spec.ts`
- [ ] Flow exposto como MCP server — verificar endpoint gerado
- [ ] Executar tool do MCP server via protocolo MCP
- [ ] Resource exposto pelo server é acessível via URI
- [ ] Prompt exposto pelo server retorna template correto

---

### mcp/client/ — Consumo de Ferramentas e Contexto

#### 11. MCP Client

- [ ] Configurar conexão com MCP server externo (stdio ou HTTP)
- [ ] Listar tools disponíveis via protocolo MCP
- [ ] Executar tool do MCP server e receber resultado no flow
- [ ] Listar resources disponíveis via protocolo MCP
- [ ] Consumir resource URI e injetar conteúdo no flow
- [ ] Erro de conexão com MCP server exibe mensagem clara

---

## project-management/ — Gestão de Projetos + Folder Management

### 12. Pastas e Projetos

#### 12.1 CRUD de Pastas
- [-] Criar nova pasta → `core/features/folders.spec.ts`
- [-] Renomear pasta → `core/features/folders.spec.ts`
- [-] Deletar pasta vazia → `core/features/folders.spec.ts`
- [-] Deletar pasta com flows dentro → `core/features/folder-deletion-integrity.spec.ts`
- [-] Integridade após deleção — flows/pastas restantes não afetados → `core/features/folder-deletion-integrity.spec.ts`
- [-] Criar pasta após deletar todas as pastas → `core/features/folder-deletion-integrity.spec.ts`
- [-] Upload de flow por drag-and-drop na pasta → `core/features/folder-drag-drop-flow.spec.ts`
- [-] Mover flow para outra pasta → `core/features/folders.spec.ts`

#### 12.2 Navegação de Pastas
- [~] Navegar entre pastas — flows corretos exibidos por pasta → `core/features/flow-navigation-folders.spec.ts`
- [-] Pesquisar flow por nome filtra resultados corretamente → `core/features/flow-navigation-folders.spec.ts`
- [-] Pastas na sidebar de navegação → `extended/features/integration-side-bar.spec.ts`

---

## templates/ — Modelos Pré-definidos de Flows e Componentes

### 13. Templates (Starter Projects)

#### 13.1 Templates Básicos
- [-] **Basic Prompting** (OpenAI) → `core/integrations/Basic Prompting.spec.ts`
- [-] **Basic Prompting** (Anthropic) → `core/integrations/Basic Prompting Anthropic.spec.ts`
- [-] **Simple Agent** (OpenAI) → `core/integrations/Simple Agent.spec.ts`
- [-] **Simple Agent** (Anthropic) → `core/integrations/Simple Agent Anthropic.spec.ts`
- [-] **Simple Agent** com memória → `core/integrations/Simple Agent Memory.spec.ts`
- [-] **Vector Store RAG** → `core/integrations/Vector Store.spec.ts`
- [-] **Memory Chatbot** → `core/integrations/Memory Chatbot.spec.ts`

#### 13.2 Templates de Geração de Conteúdo
- [-] **Blog Writer** → `core/integrations/Blog Writer.spec.ts`
- [-] **Instagram Copywriter** → `core/integrations/Instagram Copywriter.spec.ts`
- [-] **Twitter Thread Generator** → `core/integrations/Twitter Thread Generator.spec.ts`
- [-] **SEO Keyword Generator** → `core/integrations/SEO Keyword Generator.spec.ts`
- [-] **Portfolio Website Code Generator** → `core/integrations/Portfolio Website Code Generator.spec.ts`
- [-] **SaaS Pricing** → `core/integrations/SaaS Pricing.spec.ts`

#### 13.3 Templates de Análise e Processamento
- [-] **Document QA** → `core/integrations/Document QA.spec.ts`
- [-] **Invoice Summarizer** → `core/integrations/Invoice Summarizer.spec.ts`
- [-] **Financial Report Parser** → `core/integrations/Financial Report Parser.spec.ts`
- [-] **Image Sentiment Analysis** → `core/integrations/Image Sentiment Analysis.spec.ts`
- [-] **Text Sentiment Analysis** → `core/integrations/Text Sentiment Analysis.spec.ts`
- [-] **Youtube Analysis** → `core/integrations/Youtube Analysis.spec.ts`

#### 13.4 Templates de Agentes
- [-] **Dynamic Agent** → `core/integrations/Dynamic Agent.spec.ts`
- [-] **Hierarchical Agent** → `core/integrations/Hierarchical Agent.spec.ts`
- [-] **Sequential Task Agent** → `core/integrations/Sequential Agent.spec.ts`
- [-] **Social Media Agent** → `core/integrations/Social Media Agent.spec.ts`
- [-] **Travel Planning Agent** → `core/integrations/Travel Planning Agent.spec.ts`
- [-] **Market Research** → `core/integrations/Market Research.spec.ts`
- [-] **Research Translation Loop** → `core/integrations/Research Translation Loop.spec.ts`
- [-] **Pokedex Agent** → `core/integrations/Pokedex Agent.spec.ts`
- [-] **Price Deal Finder** → `core/integrations/Price Deal Finder.spec.ts`
- [-] **News Aggregator** → `core/integrations/News Aggregator.spec.ts`

#### 13.5 Templates Avançados
- [-] **Custom Component Generator** → `core/integrations/Custom Component Generator.spec.ts`
- [-] **Prompt Chaining** → `core/integrations/Prompt Chaining.spec.ts`
- [-] **Decision Flow** → `core/integrations/decisionFlow.spec.ts`
- [-] **Similarity** → `core/integrations/similarity.spec.ts`
- [-] **MCP Server** (starter projects) → `extended/features/mcp-server-starter-projects.spec.ts`

#### 13.6 Shards de Starter Projects
- [-] Starter Projects Shard 1 → `core/integrations/starter-projects-shard1.spec.ts`
- [-] Starter Projects Shard 2 → `core/integrations/starter-projects-shard2.spec.ts`
- [-] Starter Projects Shard 3 → `core/integrations/starter-projects-shard3.spec.ts`
- [-] Starter Projects Shard 4 → `core/integrations/starter-projects-shard4.spec.ts`
- [-] Starter Projects (extended) → `extended/features/starter-projects.spec.ts`

---

## ui-ux/ — Interface Visual, Canvas e Design System

### 14. Canvas / Editor Visual

#### 14.1 Sidebar de Componentes
- [-] Pesquisar componente por nome → `core/features/filterSidebar.spec.ts`
- [-] Hover sobre componente exibe tooltip/preview → `core/features/componentHoverAdd.spec.ts`
- [-] Pesquisa por teclado (keyboard shortcut) → `core/features/keyboardComponentSearch.spec.ts`
- [-] Filtrar componentes por categoria → `core/features/sidebar-category-filter.spec.ts`, `core/features/sidebar-filter-by-category.spec.ts`
- [-] Sidebar mostra contagem correta de providers → `core/features/sidebar-provider-count.spec.ts`

#### 14.2 Adicionar Componentes ao Canvas
- [-] Arrastar componente da sidebar para o canvas (drag-and-drop) → `extended/features/dragAndDrop.spec.ts`
- [-] Duplo clique na sidebar adiciona componente ao canvas → `core/features/sidebar-add-component.spec.ts`
- [-] Hover + clique no botão "+" adiciona componente ao canvas → `core/features/sidebar-add-component.spec.ts`
- [-] Componente adicionado aparece com configurações padrão → `core/features/canvas-component-defaults.spec.ts`

#### 14.3 Conexões entre Componentes
- [-] Conectar dois componentes compatíveis (desenhar edge) → `core/features/canvas-connect-components.spec.ts`
- [-] Impedir conexão entre tipos incompatíveis (edge inválida) → `core/features/canvas-incompatible-connection.spec.ts`
- [-] Deletar edge/conexão → `extended/features/twoEdges.spec.ts`
- [-] Filtrar edges por tipo de dado → `core/features/filterEdge-shard-0.spec.ts`
- [-] Reconectar edge já existente → `core/features/canvas-edge-reconnect.spec.ts`

#### 14.4 Manipulação de Nós
- [-] Deletar componente do canvas → `extended/features/deleteComponents.spec.ts`
- [-] Copiar e colar componente (Ctrl+C / Ctrl+V) → `core/features/canvas-copy-paste.spec.ts`
- [-] Atalhos de teclado do canvas → `extended/features/langflowShortcuts.spec.ts`
- [-] Minimizar componente no canvas → `extended/features/minimize.spec.ts`
- [-] Mover componente dentro do canvas (drag no canvas) → `extended/regression/`
- [-] Selecionar múltiplos componentes via box selection (Shift+drag) → `core/features/canvas-multiselect.spec.ts`
- [-] Deletar múltiplos componentes selecionados → `core/features/canvas-multiselect.spec.ts`
- [-] Desselecionar nó clicando em área vazia do canvas → `core/features/canvas-deselect-node.spec.ts`
- [-] Desselecionar nó via Escape → `core/features/canvas-deselect-node.spec.ts`

#### 14.5 Zoom e Navegação do Canvas
- [-] Zoom in aumenta escala do canvas → `core/features/canvas-zoom-fitview.spec.ts`
- [-] Zoom out diminui escala do canvas → `core/features/canvas-zoom-fitview.spec.ts`
- [-] Fit View (Ctrl+Shift+H) centraliza nós → `core/features/canvas-zoom-fitview.spec.ts`
- [-] Botão Fit View na toolbar → `core/features/canvas-zoom-fitview.spec.ts`
- [-] Scroll para navegar no canvas → `core/features/canvas-scroll-navigation.spec.ts`
- [~] Minimap (se habilitado) — feature flag-gated, not tested

#### 14.6 Agrupamento (Group)
- [-] Criar grupo de componentes → `core/features/group.spec.ts`
- [-] Desagrupar componentes → `core/features/group-enter-exit.spec.ts`
- [-] Expandir/colapsar grupo → `core/features/group-expand-collapse.spec.ts`, `core/features/group-enter-exit.spec.ts`

#### 14.7 Freeze e Estado
- [-] Congelar componente (freeze) → `core/features/freeze.spec.ts`
- [-] Freeze path (congela caminho inteiro) → `core/features/freeze-path.spec.ts`
- [-] Descongelar componente → `core/features/freeze-unfreeze-component.spec.ts`

#### 14.8 Sticky Notes
- [-] Adicionar sticky note → `extended/features/sticky-notes.spec.ts`
- [ ] Editar texto da sticky note
- [-] Mudar cor da sticky note → `core/features/note-color-picker.spec.ts`
- [-] Redimensionar sticky note → `extended/features/sticky-notes-dimensions.spec.ts`
- [-] Deletar sticky note (Delete key) → `core/features/canvas-sticky-note-delete.spec.ts`
- [-] Deletar sticky note (Backspace key) → `core/features/canvas-sticky-note-delete.spec.ts`
- [-] Múltiplas sticky notes independentes → `core/features/canvas-sticky-note-delete.spec.ts`

#### 14.9 Right-Click e Menus
- [-] Menu de contexto por right-click no canvas → `core/features/right-click-dropdown.spec.ts`
- [-] Menu de contexto por right-click em componente → `core/features/canvas-right-click-component.spec.ts`
- [-] Ações do menu principal (actionsMainPage) → `core/features/actionsMainPage-shard-1.spec.ts`

---

### 15. Settings e Configurações de UI

#### 15.1 Settings Gerais
- [-] Acessar página de Settings → `core/features/settings-navigation.spec.ts`
- [-] Configurações de histórico de mensagens → `core/features/settings-message-history.spec.ts`
- [-] Alterar configurações de aparência/tema → `core/features/settings-theme-toggle.spec.ts`

#### 15.2 Shortcut Keys
- [-] Atalhos de teclado funcionam no editor → `extended/features/langflowShortcuts.spec.ts`
- [~] Todos os atalhos documentados funcionam → `core/features/settings-navigation.spec.ts` (verifica seção Shortcuts carrega)

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
| `core-functionality/model-provider/` | 16 | 10 | 0 | 6 |
| `core-functionality/knowledge-ingestion/` | 8 | 4 | 0 | 4 |
| `flow-functionality/` | 20 | 18 | 1 | 1 |
| `mcp/server/` | 7 | 3 | 0 | 4 |
| `mcp/client/` | 6 | 0 | 0 | 6 |
| `project-management/` | 11 | 9 | 1 | 1 |
| `templates/` | 35 | 33 | 0 | 2 |
| `ui-ux/` — Canvas | 30 | 28 | 1 | 1 |
| `ui-ux/` — Settings | 4 | 4 | 0 | 0 |
| **TOTAL** | **246** | **202 (82%)** | **3** | **41 (17%)** |

---

### Prioridades para Automatizar

#### 🔴 Alta Prioridade (bloqueadores de release)
1. Erro de API key inválida (OpenAI/Anthropic)
2. Flow com erro Python exibe mensagem clara
3. Atualização com breaking change — deve alertar usuário
4. Erro de rede durante execução

#### 🟡 Média Prioridade (regressão importante)
5. MCP client — consumo de tools e resources externos
6. Webhook trigger externo
7. Agent — steps de raciocínio no Playground (inspecionar tools)
8. Playground compartilhável (URL pública)
9. Importar flow com componentes desatualizados
10. Pipeline RAG completo (knowledge-ingestion)

#### 🟢 Baixa Prioridade (melhorias de cobertura)
11. Loop component — iterações corretas
12. MCP server endpoint gerado
13. Ollama / Groq / Mistral providers
14. Parâmetros de modelo para agentes
15. Editar texto da sticky note
16. Usar variável global em componente

---
