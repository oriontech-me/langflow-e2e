# Langflow — Guia de Cenários de Teste (Passo a Passo)

> Gerado a partir do `QA-CHECKLIST.md` para facilitar entendimento e validação manual dos testes.
>
> **Legenda de status:**
> - `[-]` → automatizado, precisa validar
> - `[x]` → automatizado e validado
> - `[ ]` → precisa criar
> - `[~]` → parcialmente coberto
> - `[!]` → flaky / instável

---

## Índice

1. [API REST — Health Check](#1-api-rest--health-check)
2. [API REST — CRUD de Flows](#2-api-rest--crud-de-flows)
3. [API REST — Execução de Flows](#3-api-rest--execução-de-flows)
4. [API REST — Componentes e Mensagens](#4-api-rest--componentes-e-mensagens)
5. [API REST — Geração de Código de Integração](#5-api-rest--geração-de-código-de-integração)
6. [Configuração de Componentes — Painel de Parâmetros](#6-configuração-de-componentes--painel-de-parâmetros)
7. [Tool Mode](#7-tool-mode)
8. [Atualização de Componentes](#8-atualização-de-componentes)
9. [Componentes Principais — Chat Input/Output](#9-componentes-principais--chat-inputoutput)
10. [Componentes Principais — Prompt Template](#10-componentes-principais--prompt-template)
11. [Componentes Principais — API Request](#11-componentes-principais--api-request)
12. [Componentes Principais — Webhook](#12-componentes-principais--webhook)
13. [Componentes Principais — Agent](#13-componentes-principais--agent)
14. [Autenticação — Login e Logout](#14-autenticação--login-e-logout)
15. [Gerenciamento de Usuários (Admin)](#15-gerenciamento-de-usuários-admin)
16. [Variáveis Globais (API Keys)](#16-variáveis-globais-api-keys)
17. [File Upload e Processamento](#17-file-upload-e-processamento)
18. [Agentes LLM — Execução e Controle](#18-agentes-llm--execução-e-controle)
19. [Model Providers](#19-model-providers)
20. [Observabilidade — Traces e Notificações](#20-observabilidade--traces-e-notificações)
21. [Playground — Chat e Sessão](#21-playground--chat-e-sessão)
22. [Gerenciamento de Projetos e Pastas](#22-gerenciamento-de-projetos-e-pastas)
23. [Templates e Starter Projects](#23-templates-e-starter-projects)
24. [Flow — CRUD e Operações](#24-flow--crud-e-operações)
25. [MCP — Client e Server](#25-mcp--client-e-server)
26. [UI/UX — Sidebar e Canvas](#26-uiux--sidebar-e-canvas)

---

---

## 1. API REST — Health Check

**Arquivo:** `core/features/api-health-check.spec.ts`

---

### 1.1.a GET `/health_check` → status 200 `[-]`

**Objetivo:** Confirmar que o servidor Langflow está online e saudável.

**Pré-condição:** Langflow rodando em `http://localhost:7860`.

**Passo a passo:**
1. Fazer requisição `GET /health_check` sem autenticação.
2. Verificar que o status HTTP retornado é `200`.
3. Verificar que o corpo da resposta contém `{ status: "ok", db: "ok" }`.

**Validação:** O servidor respondeu com `200` e banco de dados está acessível.

---

### 1.1.b GET `/api/v1/health` → retorna uptime e versão `[-]`

**Objetivo:** Verificar que o endpoint de health estendido retorna metadados da instância.

**Passo a passo:**
1. Fazer requisição `GET /api/v1/health` sem autenticação.
2. Verificar que o status é `200`.
3. Verificar que o corpo contém campos de `uptime` e `version`.

**Validação:** Informações de versão e uptime estão presentes na resposta.

---

---

## 2. API REST — CRUD de Flows

**Arquivo:** `core/features/api-flows-crud.spec.ts`

---

### 2.1 POST `/api/v1/flows/` → cria flow, retorna ID `[-]`

**Objetivo:** Verificar que é possível criar um flow via API.

**Pré-condição:** Token de autenticação obtido via `/api/v1/auto_login`.

**Passo a passo:**
1. Obter token Bearer via `GET /api/v1/auto_login`.
2. Fazer `POST /api/v1/flows/` com body `{ name, description, data: { nodes: [], edges: [] }, is_component: false }`.
3. Verificar que o status retornado é `201 Created`.
4. Verificar que o corpo da resposta contém um campo `id` (UUID).

**Validação:** Flow criado com ID único retornado.

---

### 2.2 GET `/api/v1/flows/` → lista flows do usuário `[-]`

**Objetivo:** Confirmar que a listagem de flows retorna os flows do usuário autenticado.

**Passo a passo:**
1. Criar ao menos um flow via POST (setup).
2. Fazer `GET /api/v1/flows/` com header `Authorization: Bearer <token>`.
3. Verificar que o status é `200`.
4. Verificar que o array retornado contém o flow criado (por ID ou nome).

**Validação:** Lista inclui o flow criado e não inclui flows de outros usuários.

---

### 2.3 GET `/api/v1/flows/{id}` → retorna flow pelo ID `[-]`

**Objetivo:** Confirmar que um flow específico é retornado corretamente pelo seu ID.

**Passo a passo:**
1. Criar flow e guardar o `id` retornado.
2. Fazer `GET /api/v1/flows/{id}` com header Bearer.
3. Verificar que o status é `200`.
4. Verificar que o campo `id` da resposta é igual ao ID solicitado.

**Validação:** Flow retornado corresponde ao ID consultado.

---

### 2.4 PATCH `/api/v1/flows/{id}` → atualiza nome/descrição `[-]`

**Objetivo:** Verificar que campos do flow podem ser atualizados via API.

**Passo a passo:**
1. Criar flow e guardar o `id`.
2. Fazer `PATCH /api/v1/flows/{id}` com body `{ name: "Novo Nome" }`.
3. Verificar que o status é `200`.
4. Fazer `GET /api/v1/flows/{id}` e confirmar que o `name` foi atualizado.

**Validação:** Nome/descrição refletem os valores enviados no PATCH.

---

### 2.5 DELETE `/api/v1/flows/{id}` → remove flow, retorna 200 `[-]`

**Objetivo:** Confirmar que um flow pode ser deletado via API.

**Passo a passo:**
1. Criar flow e guardar o `id`.
2. Fazer `DELETE /api/v1/flows/{id}` com header Bearer.
3. Verificar que o status é `200`.

**Validação:** Deleção confirmada com status 200.

---

### 2.6 GET após DELETE → deve retornar 404 `[-]`

**Objetivo:** Garantir que um flow deletado não é mais acessível.

**Passo a passo:**
1. Deletar um flow pelo ID.
2. Fazer `GET /api/v1/flows/{id}` com o mesmo ID deletado.
3. Verificar que o status retornado é `404 Not Found`.

**Validação:** Tentativa de acesso a flow deletado resulta em 404.

---

---

## 3. API REST — Execução de Flows

**Arquivos:** `core/features/api-run-flow.spec.ts`, `api-run-with-tweaks.spec.ts`

---

### 3.1 POST `/api/v1/run/{flow_id}` com `input_value` `[-]`

**Objetivo:** Executar um flow via API e receber resposta.

**Pré-condição:** Flow criado e API key gerada via `/api/v1/api_key/`.

**Passo a passo:**
1. Obter Bearer token via auto_login.
2. Criar API key via `POST /api/v1/api_key/` → guardar `api_key` e `id`.
3. Criar flow de teste.
4. Fazer `POST /api/v1/run/{flow_id}` com header `x-api-key: <key>` e body `{ input_value: "Olá", input_type: "chat", output_type: "chat" }`.
5. Verificar que o status é `200`.
6. Verificar que o corpo contém `outputs`.

**Validação:** Flow executado com resposta estruturada em `outputs`.

---

### 3.2 POST com `tweaks` → parâmetros sobrescrevem configuração `[-]`

**Objetivo:** Verificar que tweaks sobrescrevem parâmetros configurados no flow.

**Passo a passo:**
1. Criar flow com componente configurado.
2. Fazer `POST /api/v1/run/{flow_id}` incluindo campo `tweaks: { "NomeDoComponente": { "parametro": "valor" } }`.
3. Verificar que a execução utiliza o valor do tweak (não o original do flow).

**Validação:** O parâmetro sobrescrito por tweak é utilizado na execução.

---

### 3.3 POST com `session_id` customizado `[-]`

**Objetivo:** Garantir que sessões customizadas isolam o histórico de conversa.

**Passo a passo:**
1. Executar flow com `session_id: "sessao-abc"` no body.
2. Verificar que o `session_id` retornado na resposta corresponde ao enviado.
3. Executar novamente com `session_id: "sessao-xyz"` e verificar que é uma sessão independente.

**Validação:** Cada session_id mantém histórico isolado.

---

### 3.4 POST com API key inválida → retorna 401/403 `[-]`

**Objetivo:** Confirmar que a API protege execução com autenticação.

**Passo a passo:**
1. Fazer `POST /api/v1/run/{flow_id}` com header `x-api-key: chave-invalida`.
2. Verificar que o status retornado é `401` ou `403`.

**Validação:** Acesso negado com credencial inválida.

---

### 3.5 POST para flow inexistente → retorna 404 `[-]`

**Objetivo:** Confirmar comportamento quando flow não existe.

**Passo a passo:**
1. Fazer `POST /api/v1/run/00000000-0000-0000-0000-000000000000` com API key válida.
2. Verificar que o status é `404`.

**Validação:** Endpoint retorna 404 para flow inexistente.

---

---

## 4. API REST — Componentes e Mensagens

---

### 4.1 GET `/api/v1/all` → lista componentes disponíveis `[-]`

**Objetivo:** Verificar que o catálogo de componentes está acessível.

**Passo a passo:**
1. Fazer `GET /api/v1/all` com header Bearer.
2. Verificar que o status é `200`.
3. Verificar que o corpo é um objeto com múltiplas chaves (nomes de componentes).

**Validação:** Catálogo retorna todos os componentes registrados.

---

### 4.2 GET `/api/v1/monitor/messages` → retorna array `[-]`

**Objetivo:** Verificar que o histórico de mensagens de um flow é acessível via API.

**Pré-condição:** Flow executado ao menos uma vez para gerar mensagens.

**Passo a passo:**
1. Executar flow e guardar o `flow_id` (UUID).
2. Fazer `GET /api/v1/monitor/messages?flow_id={uuid}` com Bearer.
3. Verificar que o status é `200`.
4. Verificar que o corpo é um array.

**Validação:** Endpoint retorna `200` e array de mensagens.

> ⚠️ `flow_id` deve ser UUID válido — strings arbitrárias retornam `422`.

---

### 4.3 GET com filtro de session_id `[-]`

**Objetivo:** Verificar que mensagens podem ser filtradas por sessão.

**Passo a passo:**
1. Executar flow com `session_id: "sessao-teste"`.
2. Fazer `GET /api/v1/monitor/messages?flow_id={uuid}&session_id=sessao-teste`.
3. Verificar que todas as mensagens retornadas pertencem à sessão filtrada.

**Validação:** Filtro de session_id isola mensagens da sessão correta.

---

---

## 5. API REST — Geração de Código de Integração

---

### 5.1 Gerar curl para execução `[-]`

**Objetivo:** Verificar que o Langflow gera um comando `curl` válido para execução do flow.

**Passo a passo:**
1. Abrir um flow no editor.
2. Clicar no botão "API Access" (api-access-button).
3. Selecionar a aba `cURL`.
4. Verificar que o código gerado contém a URL correta do flow e o método `curl -X POST`.

**Validação:** Código curl gerado aponta para o endpoint correto do flow.

---

### 5.2 Gerar código Python para integração `[-]`

**Objetivo:** Verificar que o Langflow gera código Python funcional para chamar o flow.

**Passo a passo:**
1. Abrir um flow no editor.
2. Clicar no botão "API Access".
3. Selecionar a aba `Python`.
4. Verificar que o código contém `import requests` e a URL do flow.

**Validação:** Código Python gerado contém os parâmetros corretos de execução.

---

---

## 6. Configuração de Componentes — Painel de Parâmetros

**Arquivos:** `core/unit/inputComponent.spec.ts`, `dropdownComponent.spec.ts`, etc.

---

### 6.1 Abrir opções avançadas do componente `[-]`

**Objetivo:** Verificar que o painel de parâmetros avançados pode ser aberto.

**Passo a passo:**
1. Adicionar qualquer componente ao canvas.
2. Clicar em "Advanced" ou no ícone de configurações do componente.
3. Verificar que o painel de opções avançadas expande exibindo campos adicionais.

**Validação:** Painel de opções avançadas visível com campos configuráveis.

---

### 6.2 Editar campo de texto (input) `[-]`

**Passo a passo:**
1. Adicionar componente com campo de texto (ex: Chat Input).
2. Clicar no campo de texto do componente.
3. Digitar um valor (ex: "meu texto").
4. Verificar que o valor foi salvo no campo.

**Validação:** Campo de texto exibe o valor digitado.

---

### 6.3 Editar dropdown `[-]`

**Passo a passo:**
1. Adicionar componente com dropdown (ex: OpenAI com seleção de modelo).
2. Clicar no dropdown.
3. Selecionar uma opção diferente da padrão.
4. Verificar que a opção selecionada está visível no dropdown.

**Validação:** Dropdown reflete a opção selecionada.

---

### 6.4 Editar toggle `[-]`

**Passo a passo:**
1. Adicionar componente com toggle (ex: opção "Stream").
2. Verificar o estado inicial do toggle (ligado/desligado).
3. Clicar no toggle para inverter o estado.
4. Verificar que o toggle mudou de estado.

**Validação:** Toggle alterna corretamente entre os estados.

---

### 6.5 Editar campo float / int `[-]`

**Passo a passo:**
1. Localizar campo numérico em um componente (ex: Temperature = 0.7).
2. Clicar no campo e alterar o valor.
3. Pressionar Enter ou clicar fora.
4. Verificar que o valor foi atualizado.

**Validação:** Campo numérico aceita e exibe o novo valor.

---

### 6.6 Editar slider `[-]`

**Passo a passo:**
1. Localizar componente com slider (ex: parâmetro de temperatura em modo slider).
2. Arrastar o slider para a direita ou esquerda.
3. Verificar que o valor numérico correspondente é atualizado.

**Validação:** Slider e valor numérico estão sincronizados.

---

---

## 7. Tool Mode

**Arquivos:** `extended/features/tool-mode.spec.ts`, `core/features/toolModeGroup.spec.ts`

---

### 7.1 Habilitar Tool Mode num componente `[-]`

**Objetivo:** Verificar que um componente pode ser habilitado como "Tool" para uso por Agents.

**Passo a passo:**
1. Adicionar componente ao canvas (ex: API Request).
2. Localizar o toggle "Tool Mode" no componente.
3. Clicar para habilitar.
4. Verificar que o componente exibe indicação visual de Tool Mode ativo.
5. Verificar que o handle de tool fica disponível para conexão com Agent.

**Validação:** Componente em Tool Mode exibe handle de tool e indicação visual.

---

### 7.2 Agrupar componentes em Tool Mode `[-]`

**Passo a passo:**
1. Adicionar dois ou mais componentes ao canvas em Tool Mode.
2. Selecionar todos os componentes (Shift+drag).
3. Usar a opção de agrupar (menu de contexto ou atalho).
4. Verificar que o grupo mantém as configurações de Tool Mode.

**Validação:** Grupo criado preserva Tool Mode dos componentes internos.

---

---

## 8. Atualização de Componentes

**Arquivos:** `extended/features/outdated-message.spec.ts`, `outdated-actions.spec.ts`

---

### 8.1 Notificação de componente desatualizado `[-]`

**Objetivo:** Garantir que o Langflow alerta o usuário quando um componente está em versão antiga.

**Passo a passo:**
1. Importar um flow JSON que contém componente em versão desatualizada.
2. Abrir o flow no editor.
3. Verificar que o componente exibe ícone/badge de "outdated" ou notificação.
4. Verificar que existe opção de atualizar o componente.

**Validação:** Badge de componente desatualizado visível com ação de atualização disponível.

---

### 8.2 Ação de atualizar componente `[-]`

**Passo a passo:**
1. Identificar componente com badge de desatualizado.
2. Clicar na opção "Update" do componente.
3. Verificar que o badge de desatualizado desaparece.
4. Verificar que o componente mantém suas configurações após a atualização.

**Validação:** Componente atualizado sem perda de configuração.

---

---

## 9. Componentes Principais — Chat Input/Output

**Arquivos:** `core/unit/chatInputOutput.spec.ts`, `core/integrations/textInputOutput.spec.ts`

---

### 9.1 ChatInput recebe mensagem do usuário `[-]`

**Objetivo:** Verificar que o componente Chat Input processa mensagem de entrada.

**Passo a passo:**
1. Criar flow com componente Chat Input conectado ao Chat Output.
2. Abrir Playground (botão `playground-btn-flow-io`).
3. Digitar mensagem no campo `input-chat-playground`.
4. Clicar no botão de envio (`button-send`).
5. Verificar que a mensagem do usuário aparece no histórico do chat.

**Validação:** Mensagem enviada aparece na interface do Playground.

---

### 9.2 ChatOutput exibe resposta do LLM `[-]`

**Passo a passo:**
1. Criar flow: Chat Input → LLM (OpenAI/Anthropic) → Chat Output.
2. Configurar API key no componente LLM.
3. Abrir Playground e enviar mensagem.
4. Aguardar resposta do LLM.
5. Verificar que a resposta aparece na caixa de chat (div com mensagem do assistente).

**Validação:** Resposta do LLM exibida no Playground após execução.

---

---

## 10. Componentes Principais — Prompt Template

**Arquivos:** `core/regression/generalBugs-prompt.spec.ts`, `core/features/prompt-dynamic-variables.spec.ts`

---

### 10.1 Prompt com variáveis em curly braces `[-]`

**Objetivo:** Verificar que variáveis `{nome}` no prompt criam handles dinâmicos.

**Passo a passo:**
1. Adicionar componente Prompt Template ao canvas.
2. Clicar em "Edit Prompt" (botão `button_open_prompt_modal`).
3. No campo de texto do modal, digitar: `Olá {nome}, seu cargo é {cargo}.`
4. Clicar em "Save" (`genericModalBtnSave`).
5. Verificar que dois handles foram criados: `nome` e `cargo` (lado esquerdo do componente).

**Validação:** Handles `handle-prompt template-shownode-nome-left` e `handle-prompt template-shownode-cargo-left` visíveis.

---

### 10.2 Remover variável do prompt apaga porta correspondente `[-]`

**Passo a passo:**
1. Criar prompt com variável `{nome}` (handle `nome` criado).
2. Reabrir modal do prompt e remover `{nome}` do texto.
3. Salvar.
4. Verificar que o handle `nome` desapareceu do componente.

**Validação:** Handle removido quando variável é deletada do prompt.

---

---

## 11. Componentes Principais — API Request

**Arquivos:** `core/features/api-component-regression.spec.ts`, `api-request-component-ui.spec.ts`

---

### 11.1 Configurar URL e método HTTP `[-]`

**Passo a passo:**
1. Adicionar componente "API Request" ao canvas.
2. No painel de parâmetros, preencher o campo URL com uma URL válida.
3. Selecionar o método HTTP desejado (GET, POST, etc.) no dropdown.
4. Verificar que o componente exibe URL e método configurados.

**Validação:** URL e método refletidos nos campos do componente.

---

### 11.2 Adicionar headers e body `[-]`

**Passo a passo:**
1. Com componente API Request configurado.
2. Expandir seção de Headers e adicionar um header (ex: `Content-Type: application/json`).
3. Preencher campo de body com JSON.
4. Verificar que os campos foram aceitos sem erro.

**Validação:** Headers e body configurados sem erros de validação.

---

---

## 12. Componentes Principais — Webhook

**Arquivos:** `core/unit/webhookComponent.spec.ts`, `core/features/webhook-component-regression.spec.ts`

---

### 12.1 Componente Webhook exibido no canvas `[-]`

**Passo a passo:**
1. Buscar "Webhook" na sidebar.
2. Adicionar ao canvas via duplo clique ou drag.
3. Verificar que o componente aparece no canvas com suas configurações padrão.

**Validação:** Componente Webhook visível no canvas com handles e configurações padrão.

---

### 12.2 URL de webhook gerada automaticamente `[-]`

**Passo a passo:**
1. Adicionar componente Webhook ao canvas.
2. Verificar que o campo de URL do webhook é preenchido automaticamente.
3. Confirmar que a URL contém o ID do flow (formato `/api/v1/webhook/{flow_id}`).

**Validação:** URL de webhook gerada automaticamente com ID do flow correto.

---

---

## 13. Componentes Principais — Agent

**Arquivo:** `core/features/agent-component-regression.spec.ts`

---

### 13.1 Componente Agent exibido no canvas com configurações padrão `[-]`

**Passo a passo:**
1. Buscar "Agent" na sidebar.
2. Adicionar ao canvas.
3. Verificar que o componente exibe:
   - Handle de entrada para "Language Model" (`handle-agent-shownode-language model-left`)
   - Handle de entrada para "Tools" (`handle-agent-shownode-tools-left`)
   - Handle de saída "Response" (`handle-agent-shownode-response-right`)
4. Verificar que campos padrão (Max Iterations, System Prompt) estão visíveis.

**Validação:** Componente Agent com todos os handles e campos padrão visíveis.

---

---

## 14. Autenticação — Login e Logout

**Arquivos:** `core/features/auto-login-off.spec.ts`, `login-invalid-credentials.spec.ts`, `logout-flow.spec.ts`

---

### 14.1 Login com credenciais válidas `[-]`

**Objetivo:** Verificar que usuário com credenciais corretas acessa o sistema.

**Pré-condição:** Auto-login desabilitado (LANGFLOW_AUTO_LOGIN=false).

**Passo a passo:**
1. Navegar para `http://localhost:7860`.
2. Verificar que a tela de login é exibida.
3. Preencher Username: `langflow` e Password: `langflow`.
4. Clicar em "Sign In".
5. Verificar que o usuário é redirecionado para a página principal (`mainpage_title` visível).

**Validação:** Usuário autenticado e redirecionado para a home.

---

### 14.2 Login com credenciais inválidas `[-]`

**Passo a passo:**
1. Navegar para a tela de login.
2. Preencher Username: `usuario_errado` e Password: `senha_errada`.
3. Clicar em "Sign In".
4. Verificar que a mensagem de erro `"Error signing in"` é exibida.
5. Verificar que o usuário permanece na tela de login.

**Validação:** Mensagem de erro exibida, acesso bloqueado.

---

### 14.3 Logout redireciona para tela de login `[-]`

**Passo a passo:**
1. Fazer login com sucesso.
2. Clicar no ícone de perfil (`user-profile-settings`).
3. Clicar em "Logout".
4. Verificar que o usuário é redirecionado para a tela de login.

**Validação:** Sessão encerrada e usuário redirecionado para login.

---

### 14.4 Auto-login ativado — pula tela de login `[-]`

**Passo a passo:**
1. Navegar para `http://localhost:7860` com LANGFLOW_AUTO_LOGIN=true.
2. Verificar que a tela de login NÃO é exibida.
3. Verificar que a página principal carrega diretamente.

**Validação:** Com auto-login ativo, usuário acessa diretamente sem credenciais.

---

### 14.5 Auto-login desativado — exibe tela de login `[-]`

**Passo a passo:**
1. Mock do endpoint `/api/v1/auto_login` para retornar status 500.
2. Navegar para `http://localhost:7860`.
3. Verificar que a tela de login é exibida (`text=sign in to langflow`).

**Validação:** Sem auto-login, tela de autenticação é obrigatória.

---

### 14.6 Sessão expirada — redireciona para login `[-]`

**Passo a passo:**
1. Fazer login com sucesso.
2. Simular expiração de token (via mock ou aguardar timeout).
3. Tentar realizar ação autenticada (ex: criar flow).
4. Verificar que o sistema redireciona para a tela de login.

**Validação:** Ação com sessão expirada resulta em redirecionamento para login.

---

### 14.7 Limpeza de sessão após logout `[-]`

**Passo a passo:**
1. Fazer login e criar um flow.
2. Fazer logout.
3. Verificar que cookies/tokens de sessão foram removidos.
4. Tentar acessar URL autenticada diretamente — deve redirecionar para login.

**Validação:** Tokens de sessão limpos após logout.

---

---

## 15. Gerenciamento de Usuários (Admin)

**Arquivo:** `core/features/admin-user-management.spec.ts`

---

### 15.1 Admin cria novo usuário `[-]`

**Passo a passo:**
1. Fazer login como admin.
2. Navegar para Admin Page (menu do usuário → "Admin Page").
3. Clicar em "New User".
4. Preencher nome, username e senha do novo usuário.
5. Clicar em salvar.
6. Verificar mensagem de sucesso `"new user added"`.
7. Verificar que o usuário aparece na listagem.

**Validação:** Novo usuário criado e visível na listagem.

---

### 15.2 Admin desativa usuário `[-]`

**Passo a passo:**
1. Localizar usuário ativo na listagem de Admin Page.
2. Clicar no toggle `#is_active` para desativar.
3. Tentar fazer login com o usuário desativado.
4. Verificar que o login falha.

**Validação:** Usuário desativado não consegue autenticar.

---

### 15.3 Admin ativa usuário inativo `[-]`

**Passo a passo:**
1. Localizar usuário inativo.
2. Clicar no toggle `#is_active` para ativar.
3. Fazer login com o usuário reativado.
4. Verificar que o login é bem-sucedido.

**Validação:** Usuário ativado consegue autenticar normalmente.

---

### 15.4 Admin renomeia usuário `[-]`

**Passo a passo:**
1. Clicar no ícone de edição (`icon-Pencil`) do usuário.
2. Alterar o nome de exibição.
3. Salvar.
4. Verificar mensagem `"user edited"`.
5. Verificar que o novo nome aparece na listagem.

**Validação:** Nome do usuário atualizado na listagem.

---

### 15.5 Admin altera senha de usuário `[-]`

**Passo a passo:**
1. Editar usuário e alterar senha para `"NovaSenha123"`.
2. Salvar.
3. Tentar login com a senha antiga — deve falhar.
4. Tentar login com a nova senha — deve funcionar.

**Validação:** Senha antiga inválida, nova senha funciona.

---

### 15.6 Isolamento: user A não vê flows de user B `[-]`

**Passo a passo:**
1. Criar flow com user A.
2. Fazer login como user B.
3. Verificar que os flows de user A NÃO aparecem na listagem de user B.

**Validação:** Flows são isolados por usuário.

---

---

## 16. Variáveis Globais (API Keys)

**Arquivo:** `core/features/globalVariables.spec.ts`, `global-variables-crud.spec.ts`

---

### 16.1 Criar variável global `[-]`

**Passo a passo:**
1. Navegar para Settings → Global Variables.
2. Clicar em "Add Variable".
3. Preencher nome (ex: `OPENAI_API_KEY`), tipo e valor.
4. Salvar.
5. Verificar que a variável aparece na listagem.

**Validação:** Variável global criada e listada.

---

### 16.2 Editar variável global existente `[-]`

**Passo a passo:**
1. Localizar variável global existente.
2. Clicar em editar.
3. Alterar o valor.
4. Salvar.
5. Verificar que o novo valor está refletido.

**Validação:** Variável global atualizada com novo valor.

---

### 16.3 Deletar variável global `[-]`

**Passo a passo:**
1. Localizar variável global.
2. Clicar em deletar.
3. Confirmar exclusão.
4. Verificar que a variável não aparece mais na listagem.

**Validação:** Variável removida da listagem.

---

### 16.4 Criar variável global do tipo "Generic" `[-]`

**Passo a passo:**
1. Criar nova variável global.
2. Selecionar tipo "Generic".
3. Preencher nome e valor.
4. Salvar.
5. Verificar que o tipo "Generic" é exibido corretamente.

**Validação:** Variável do tipo Generic criada com tipo correto.

---

---

## 17. File Upload e Processamento

**Arquivos:** `core/unit/fileUploadComponent.spec.ts`, `extended/features/files-page.spec.ts`

---

### 17.1 Upload de arquivo via componente `[-]`

**Passo a passo:**
1. Adicionar componente de upload de arquivo ao canvas.
2. Clicar no botão de upload do componente.
3. Selecionar arquivo (ex: `test.txt`).
4. Verificar que o nome do arquivo aparece no componente após upload.

**Validação:** Arquivo carregado e nome exibido no componente.

---

### 17.2 Upload de arquivos de diferentes tipos `[-]`

**Passo a passo:**
1. Testar upload de arquivo `.txt`, `.pdf`, `.json`, `.py`.
2. Verificar que todos os tipos são aceitos sem erro.

**Validação:** Múltiplos formatos de arquivo aceitos pelo componente.

---

### 17.3 Limite de tamanho de arquivo `[-]`

**Passo a passo:**
1. Tentar fazer upload de arquivo que excede o limite configurado.
2. Verificar que o sistema exibe mensagem de erro de tamanho.
3. Verificar que o arquivo NÃO é carregado.

**Validação:** Mensagem de erro exibida para arquivo acima do limite.

---

---

## 18. Agentes LLM — Execução e Controle

**Arquivos:** `llm-agents/agent-component-regression.spec.ts`, `llm-agents/agent-reasoning-steps.spec.ts`, `llm-agents/memory-history-regression.spec.ts`

---

### 18.1 Agent com tool calling executa corretamente `[-]`

**Objetivo:** Verificar que o Agent consegue usar ferramentas para responder perguntas.

**Passo a passo:**
1. Criar flow: Agent + LLM configurado + Tool (ex: API Request em Tool Mode).
2. Conectar Tool ao handle de tools do Agent.
3. Conectar LLM ao handle de language model do Agent.
4. Abrir Playground e enviar pergunta que requer uso da tool.
5. Verificar que o Agent chama a tool e retorna resposta baseada no resultado.

**Validação:** Agent chama tool e retorna resposta coerente.

---

### 18.2 Agent exibe steps de raciocínio no Playground `[x]`

**Objetivo:** Verificar que os passos de raciocínio do Agent são visíveis no Playground.

**Arquivo:** `core/features/agent-reasoning-steps.spec.ts`

**Passo a passo:**
1. Carregar template "Simple Agent" e configurar modelo (OpenAI, Anthropic ou Gemini).
2. Abrir Playground e iniciar nova sessão.
3. Enviar mensagem que force uso de tool: `"You MUST use the Calculator tool. Compute 987 multiplied by 654."`.
4. Aguardar execução finalizar (botão Stop desaparece).
5. Verificar que o texto `"Finished in Xs"` aparece na mensagem do assistente.
6. Verificar que ao menos um item `"Called tool <nome>"` está visível (accordion).
7. Clicar no item `"Called tool"` para expandir.
8. Verificar que o conteúdo expande (`data-state="open"`).

**DOM relevante:**
- `"Finished in"` → `bot-message.tsx` status text
- `"Called tool"` → `ContentBlockDisplay.tsx` AccordionTrigger (renderizado como `<div>`, não `<button>`)
- `[data-state="open"]` → Radix AccordionItem/AccordionContent após expansão

**Validação:** Steps de raciocínio visíveis, clicáveis e expansíveis no Playground.

---

### 18.3 Memory History retém contexto entre mensagens na mesma sessão `[x]`

**Objetivo:** Verificar que o componente Message History mantém o histórico de conversa entre mensagens dentro da mesma sessão do Playground.

**Arquivo:** `llm-agents/memory-history-regression.spec.ts`

**Passo a passo:**
1. Carregar template "Memory Chatbot" e configurar modelo OpenAI.
2. Abrir Playground e iniciar nova sessão (`new-chat`).
3. Enviar mensagem com dado único: `"In our conversation my name is TESTNAME_XY9Z."`.
4. Aguardar resposta do assistente (1 mensagem exibida).
5. Enviar segunda mensagem: `"What is my name from our conversation?"`.
6. Aguardar resposta (2 mensagens exibidas).
7. Verificar que a resposta contém `"TESTNAME_XY9Z"`.

**Validação:** Assistente recorda o nome informado na mensagem anterior.

---

### 18.4 Isolamento de sessão: session IDs distintos têm históricos independentes `[x]`

**Objetivo:** Verificar que duas sessões distintas não compartilham histórico.

**Arquivo:** `llm-agents/memory-history-regression.spec.ts`

**Passo a passo:**
1. Carregar template "Memory Chatbot" e configurar modelo OpenAI.
2. Abrir Playground — sessão A: enviar `"In our conversation my secret code is ALPHA_CODE_111."`.
3. Iniciar nova sessão (`new-chat`) — sessão B: enviar `"What secret code did I mention?"`.
4. Aguardar resposta da sessão B.
5. Verificar que a resposta da sessão B **não** contém `"ALPHA_CODE_111"`.

**Validação:** Sessão B não tem acesso ao histórico da sessão A.

---

### 18.5 Mensagens persistem após fechar e reabrir o Playground `[x]`

**Objetivo:** Verificar que o histórico da sessão é preservado ao fechar e reabrir o Playground.

**Arquivo:** `llm-agents/memory-history-regression.spec.ts`

**Passo a passo:**
1. Carregar template "Memory Chatbot" e configurar modelo OpenAI.
2. Abrir Playground, iniciar nova sessão e enviar: `"In our conversation my value is PERSIST_VALUE_42."`.
3. Fechar o Playground (clicar fora ou no botão de fechar).
4. Reabrir o Playground clicando em `playground-btn-flow-io`.
5. Selecionar a mesma sessão anterior.
6. Enviar: `"What value did I mention earlier?"`.
7. Verificar que a resposta contém `"PERSIST_VALUE_42"`.

**Validação:** Histórico persistiu entre aberturas do Playground.

---

### 18.6 Sem Message History, LLM não retém contexto entre mensagens `[x]`

**Objetivo:** Verificar que sem o componente Message History conectado, o LLM não tem acesso ao histórico de conversa anterior.

**Arquivo:** `llm-agents/memory-history-regression.spec.ts`

**Passo a passo:**
1. Carregar o template "Simple Agent" (sem Message History).
2. Configurar modelo OpenAI.
3. Abrir Playground e iniciar nova sessão.
4. Enviar: `"In our conversation my secret is NOMEM5678."`.
5. Aguardar resposta (1 mensagem).
6. Enviar nova mensagem: `"What secret did I just tell you?"`.
7. Aguardar resposta (2 mensagens).
8. Verificar que a resposta **não** contém `"NOMEM5678"`.

**Validação:** LLM sem memória não recorda informações de mensagens anteriores.

---

### 18.7 Parâmetro n_messages do Message History `[ ]`

**Objetivo:** Verificar que o parâmetro `n_messages` limita corretamente a janela de mensagens retidas na memória.

**Arquivo:** a criar — aguardando correção de bug no backend.

> ⚠️ **Bug confirmado:** O parâmetro `n_messages` é salvo corretamente pelo frontend (verificado via interceptação do PATCH de autosave — payload contém `n_messages: 2`), mas o componente Message History ignora esse valor durante a execução do flow e usa o default (100 mensagens). Bug reportado ao time de desenvolvimento para correção no backend (`MemoryComponent.retrieve_messages()`).

**Passo a passo (quando o bug for corrigido):**
1. Carregar template "Memory Chatbot" e configurar modelo OpenAI.
2. Abrir InspectionPanel do nó "Message History" e alterar `n_messages` para `2`.
3. Abrir Playground, iniciar nova sessão.
4. Enviar Exchange 1: `"In our conversation my value_alpha equals ALPHA_VALUE_123."`.
5. Enviar Exchange 2: `"In our conversation my value_beta equals BETA_VALUE_456."`.
6. Enviar Exchange 3: `"In our conversation my value_gamma equals GAMMA_VALUE_789."`.
7. Enviar Exchange 4: `"What are value_alpha, value_beta, and value_gamma?"`.
8. Verificar que a resposta **contém** `"GAMMA_VALUE_789"` (dentro da janela).
9. Verificar que a resposta **não contém** `"ALPHA_VALUE_123"` (fora da janela).

**Validação:** Com `n_messages=2`, apenas os últimos 2 pares de mensagens estão no contexto.

---

---

## 19. Model Providers

**Arquivos:** `core/features/globalVariables.spec.ts`, `claude-model-switch.spec.ts`, `modelProviderModal.spec.ts`

---

### 19.1 Configurar API key OpenAI via Global Variables `[-]`

**Passo a passo:**
1. Navegar para Settings → Global Variables.
2. Criar variável `OPENAI_API_KEY` com a chave válida.
3. Adicionar componente OpenAI ao canvas.
4. Verificar que o campo de API key exibe a variável global como opção.
5. Selecionar a variável global.

**Validação:** API key configurada via variável global.

---

### 19.2 Selecionar modelo GPT (GPT-4o-mini) `[-]`

**Passo a passo:**
1. Adicionar componente OpenAI ao canvas.
2. Clicar no dropdown de modelo.
3. Selecionar `gpt-4o-mini` (testid: `gpt-4o-mini-option`).
4. Verificar que o modelo selecionado aparece no dropdown.

**Validação:** Modelo GPT-4o-mini selecionado e exibido.

---

### 19.3 Selecionar modelo Claude `[-]`

**Passo a passo:**
1. Adicionar componente Anthropic ao canvas.
2. Configurar API key Anthropic.
3. Selecionar modelo Claude (ex: `claude-sonnet-4-5-20250929`).
4. Verificar que o modelo está selecionado.

**Validação:** Modelo Claude selecionado corretamente.

---

### 19.4 Trocar entre modelos Claude `[-]`

**Passo a passo:**
1. Com componente Anthropic configurado com modelo Sonnet.
2. Abrir dropdown e selecionar Haiku.
3. Verificar que o modelo muda.
4. Repetir para Opus.

**Validação:** Todos os modelos Claude disponíveis e selecionáveis.

---

### 19.5 Erro de API key inválida `[-]` (mocked)

**Passo a passo:**
1. Configurar componente LLM com API key inválida (`sk-invalida`).
2. Executar flow ou enviar mensagem no Playground.
3. Verificar que mensagem de erro sobre API key inválida é exibida.

**Validação:** Erro de autenticação com LLM exibido ao usuário.

---

### 19.6 Modal "Manage Model Providers" `[-]`

**Passo a passo:**
1. Clicar no botão de gerenciamento de providers.
2. Verificar que modal "Manage Model Providers" abre.
3. Verificar lista de providers disponíveis.
4. Clicar em um provider e verificar que é possível configurar a API key.

**Validação:** Modal abre, lista providers e permite configuração.

---

---

## 20. Observabilidade — Traces e Notificações

**Arquivos:** `core/features/traces.spec.ts`, `traces-latency-tokens.spec.ts`, `execution-error-notification.spec.ts`

---

### 20.1 Visualizar traces de execução `[-]`

**Passo a passo:**
1. Executar um flow ao menos uma vez.
2. Navegar para a seção de Traces/Logs.
3. Verificar que a execução aparece na lista de traces.
4. Clicar no trace para expandir detalhes.

**Validação:** Trace da execução visível com detalhes expandíveis.

---

### 20.2 Trace exibe latência de cada componente `[-]`

**Passo a passo:**
1. Acessar detalhe de um trace.
2. Verificar que cada componente do flow exibe sua latência (tempo de execução).

**Validação:** Latência por componente visível nos detalhes do trace.

---

### 20.3 Trace exibe tokens consumidos `[-]`

**Passo a passo:**
1. Executar flow com LLM.
2. Acessar trace da execução.
3. Verificar que campos de tokens (input tokens, output tokens, total) estão presentes.

**Validação:** Contagem de tokens visível no trace.

---

### 20.4 Notificação de erro de execução `[-]`

**Passo a passo:**
1. Criar flow com componente que vai gerar erro (ex: URL inválida no API Request).
2. Executar o flow.
3. Verificar que notificação de erro aparece na interface com mensagem descritiva.

**Validação:** Erro de execução exibido como notificação com detalhes.

---

---

## 21. Playground — Chat e Sessão

**Arquivos:** `core/features/playground-ux.spec.ts`, `playground-session-id.spec.ts`, `playground-history-persist.spec.ts`

---

### 21.1 Abrir Playground `[-]`

**Passo a passo:**
1. Com flow criado e aberto no editor.
2. Clicar no botão Playground (`playground-btn-flow-io`).
3. Verificar que o painel do Playground abre.
4. Verificar que o campo de input (`input-chat-playground`) está visível.

**Validação:** Playground abre com interface de chat pronta para uso.

---

### 21.2 Enviar mensagem e receber resposta `[-]`

**Passo a passo:**
1. Abrir Playground.
2. Digitar mensagem no campo de input.
3. Clicar em "Send" (`button-send`).
4. Aguardar resposta.
5. Verificar que resposta do assistente aparece no histórico.

**Validação:** Mensagem enviada, resposta recebida e exibida.

---

### 21.3 Enviar mensagem vazia `[!]` (BUG DOCUMENTADO)

> ⚠️ **BUG CONHECIDO:** O botão de envio está sempre habilitado mesmo com campo vazio.

**Passo a passo:**
1. Abrir Playground sem digitar nada.
2. Verificar estado do botão "Send".
3. Clicar em "Send" com campo vazio.

**Validação:** Documentado como bug — botão deveria estar desabilitado com campo vazio.

---

### 21.4 Trocar session ID — inicia nova conversa `[-]`

**Passo a passo:**
1. Enviar mensagem na sessão atual.
2. Localizar campo `chat-session-id` e digitar novo ID.
3. Verificar que o histórico de chat é limpo (nova sessão).
4. Confirmar que é uma conversa independente.

**Validação:** Nova sessão criada sem histórico da anterior.

---

### 21.5 Deletar mensagem individual do histórico `[-]`

**Passo a passo:**
1. Enviar ao menos uma mensagem no Playground.
2. Passar o mouse sobre a mensagem para exibir opções.
3. Clicar no ícone de deletar da mensagem.
4. Verificar que a mensagem foi removida do histórico.

**Validação:** Mensagem deletada não aparece mais no histórico.

---

### 21.6 Histórico persiste ao reabrir Playground `[-]`

**Passo a passo:**
1. Enviar mensagens no Playground.
2. Fechar o painel do Playground.
3. Reabrir o Playground.
4. Verificar que as mensagens anteriores ainda estão no histórico.

**Validação:** Histórico de chat preservado após fechar e reabrir.

---

### 21.7 Modo fullscreen do Playground `[-]`

**Passo a passo:**
1. Abrir Playground.
2. Clicar no botão de fullscreen.
3. Verificar que o Playground ocupa toda a tela.
4. Verificar que ainda é possível enviar mensagens.

**Validação:** Fullscreen ativo, funcionalidade de chat preservada.

---

---

## 22. Gerenciamento de Projetos e Pastas

**Arquivo:** `core/features/folders.spec.ts`, `folder-deletion-integrity.spec.ts`

---

### 22.1 Criar nova pasta `[-]`

**Passo a passo:**
1. Na página principal, clicar em "New Folder".
2. Digitar nome da pasta.
3. Confirmar criação.
4. Verificar que a pasta aparece na listagem.

**Validação:** Pasta criada e visível na sidebar de projetos.

---

### 22.2 Renomear pasta `[-]`

**Passo a passo:**
1. Clicar no ícone de edição da pasta.
2. Digitar novo nome e confirmar.
3. Verificar que o novo nome aparece na listagem.

**Validação:** Nome da pasta atualizado.

---

### 22.3 Deletar pasta vazia `[-]`

**Passo a passo:**
1. Criar pasta vazia.
2. Clicar em deletar e confirmar.
3. Verificar que a pasta não aparece mais na listagem.

**Validação:** Pasta vazia deletada com sucesso.

---

### 22.4 Deletar pasta com flows dentro `[-]`

**Passo a passo:**
1. Criar pasta com ao menos um flow dentro.
2. Tentar deletar a pasta.
3. Confirmar a deleção (cascata ou alerta).
4. Verificar que pasta e flows foram removidos.

**Validação:** Deleção em cascata funciona ou alerta é exibido.

---

### 22.5 Mover flow para outra pasta `[-]`

**Passo a passo:**
1. Selecionar um flow e usar opção "Move to Folder".
2. Selecionar a pasta destino.
3. Verificar que o flow aparece na nova pasta e não na original.

**Validação:** Flow movido para pasta destino corretamente.

---

### 22.6 Pesquisar flow por nome `[-]`

**Passo a passo:**
1. Criar ao menos dois flows com nomes diferentes.
2. Usar o campo de busca da página principal.
3. Digitar parte do nome de um flow.
4. Verificar que apenas o flow correspondente é exibido.

**Validação:** Busca filtra flows por nome corretamente.

---

---

## 23. Templates e Starter Projects

**Arquivos:** `core/integrations/*.spec.ts`

---

### 23.1 Basic Prompting (OpenAI) `[-]`

**Passo a passo:**
1. Selecionar template "Basic Prompting".
2. Verificar que o flow carrega com Chat Input, Prompt Template, OpenAI LLM, Chat Output.
3. Configurar API key do OpenAI.
4. Abrir Playground e enviar mensagem.
5. Verificar que resposta é recebida.

**Validação:** Template Basic Prompting executa e retorna resposta do OpenAI.

---

### 23.2 Simple Agent (OpenAI) `[-]`

**Passo a passo:**
1. Selecionar template "Simple Agent".
2. Verificar que flow carrega com Agent e ferramentas padrão.
3. Configurar API key.
4. Enviar pergunta no Playground.
5. Verificar resposta do Agent.

**Validação:** Agent executa e retorna resposta via template Simple Agent.

---

### 23.3 Memory Chatbot `[x]`

**Objetivo:** Verificar que o template Memory Chatbot carrega corretamente e que o chatbot mantém contexto entre mensagens.

**Arquivo:** `llm-agents/memory-history-regression.spec.ts`

**Passo a passo:**
1. Navegar para "All Templates" e selecionar "Memory Chatbot".
2. Aguardar canvas carregar (`canvas_controls_dropdown` visível).
3. Verificar que há pelo menos 3 nós no canvas (Memory History, LLM, Chat I/O).
4. Verificar que há pelo menos 2 arestas (conexões entre os nós).
5. Verificar que o botão do Playground está visível (`playground-btn-flow-io`).
6. Configurar API key OpenAI, abrir Playground e iniciar nova sessão.
7. Enviar: `"In our conversation my name is TESTNAME_XY9Z."`.
8. Enviar: `"What is my name from our conversation?"`.
9. Verificar que a resposta contém `"TESTNAME_XY9Z"`.

**Validação:** Template carrega com estrutura correta; chatbot mantém contexto da conversa entre mensagens.

---

### 23.4 Vector Store RAG `[-]`

**Passo a passo:**
1. Carregar template "Vector Store RAG".
2. Fazer upload de documento de teste.
3. Configurar embeddings e vector store.
4. Enviar pergunta relacionada ao conteúdo do documento.
5. Verificar que a resposta é baseada no documento.

**Validação:** RAG retorna resposta baseada no documento carregado.

---

---

## 24. Flow — CRUD e Operações

**Arquivos:** `core/features/export-import-flow.spec.ts`, `flow-lock.spec.ts`, `run-flow.spec.ts`

---

### 24.1 Criar flow em branco `[-]`

**Passo a passo:**
1. Clicar em "New Flow" e selecionar "Blank Flow".
2. Verificar que canvas vazio é exibido.

**Validação:** Canvas vazio exibido após selecionar Blank Flow.

---

### 24.2 Criar flow duplicando existente `[-]`

**Passo a passo:**
1. Clicar em "Duplicate" no menu de um flow.
2. Verificar que um novo flow com nome "(copy)" é criado com os mesmos componentes.

**Validação:** Flow duplicado com cópia dos componentes originais.

---

### 24.3 Importar flow via JSON `[-]`

**Passo a passo:**
1. Clicar em "Import" e selecionar arquivo JSON de flow.
2. Verificar que o flow é importado e exibido no editor.

**Validação:** Flow importado corretamente a partir de arquivo JSON.

---

### 24.4 Exportar flow como JSON `[-]`

**Passo a passo:**
1. Abrir flow existente.
2. Clicar em Export.
3. Verificar que download de arquivo `.json` é iniciado com a estrutura correta.

**Validação:** Arquivo JSON válido gerado para o flow.

---

### 24.5 Importar JSON inválido — exibe erro `[-]`

**Passo a passo:**
1. Tentar importar arquivo `.json` com conteúdo inválido.
2. Verificar que mensagem de erro é exibida.
3. Verificar que nenhum flow inválido é criado.

**Validação:** Importação de JSON inválido exibe erro descritivo.

---

### 24.6 Travar (lock) flow `[-]`

**Passo a passo:**
1. Clicar no botão de lock/travar no editor.
2. Tentar mover um componente no canvas.
3. Verificar que a movimentação é impedida.

**Validação:** Flow travado impede edições no canvas.

---

### 24.7 Executar flow pelo botão Run `[-]`

**Passo a passo:**
1. Clicar no botão "Run" (`button_run_flow`).
2. Verificar que a execução inicia (indicadores de loading nos componentes).
3. Verificar que os outputs são exibidos ao final.

**Validação:** Execução iniciada e resultados exibidos nos componentes.

---

### 24.8 Parar building do flow `[-]`

**Passo a passo:**
1. Iniciar execução do flow.
2. Clicar em "Stop" (`stop-building-button`) durante a execução.
3. Verificar que a execução para e o botão "Run" volta a ficar disponível.

**Validação:** Execução interrompida ao clicar em Stop.

---

---

## 25. MCP — Client e Server

---

### 25.1 Aba MCP Server no flow `[-]`

**Passo a passo:**
1. Abrir um flow no editor.
2. Verificar presença da aba "MCP Server".
3. Clicar na aba e verificar que conteúdo relacionado a MCP é exibido.

**Validação:** Aba MCP Server acessível no editor de flow.

---

### 25.2 Adicionar MCP server via modal `[-]`

**Passo a passo:**
1. Navegar para configuração de MCP.
2. Clicar em "Add MCP Server".
3. Preencher configuração (nome, URL/comando) e salvar.
4. Verificar que o servidor MCP aparece na listagem.

**Validação:** MCP server adicionado e visível na listagem.

---

### 25.3 Configurar conexão MCP client `[ ]`

**Passo a passo:**
1. Adicionar componente MCP Client ao flow.
2. Configurar tipo de conexão (stdio ou HTTP) e parâmetros.
3. Verificar que a conexão é estabelecida sem erros.

**Validação:** Componente MCP Client conectado com sucesso.

---

---

## 26. UI/UX — Sidebar e Canvas

---

### 26.1 Pesquisar componente por nome `[-]`

**Passo a passo:**
1. Digitar nome no campo `sidebar-search-input`.
2. Verificar que apenas componentes correspondentes são exibidos.
3. Limpar com `.clear()`.
4. Verificar que todos os componentes voltam.

**Validação:** Filtro de busca funciona e limpa corretamente.

---

### 26.2 Arrastar componente da sidebar para o canvas `[-]`

**Passo a passo:**
1. Localizar componente na sidebar.
2. Arrastar para posição específica do canvas.
3. Verificar que o componente aparece no canvas.

**Validação:** Componente adicionado ao canvas via drag-and-drop.

---

### 26.3 Duplo clique na sidebar adiciona componente `[-]`

**Passo a passo:**
1. Localizar componente na sidebar.
2. Dar duplo clique no componente.
3. Verificar que o componente é adicionado ao canvas automaticamente.

**Validação:** Duplo clique adiciona componente ao canvas.

---

### 26.4 Conectar dois componentes compatíveis `[-]`

**Passo a passo:**
1. Adicionar Chat Input e Chat Output ao canvas.
2. Clicar no handle de saída do Chat Input.
3. Clicar no handle de entrada do Chat Output.
4. Verificar que uma edge é criada.

**Validação:** Edge visível conectando os dois componentes.

---

### 26.5 Impedir conexão entre tipos incompatíveis `[-]`

**Passo a passo:**
1. Tentar conectar handles de tipos incompatíveis.
2. Verificar que a conexão não é permitida.

**Validação:** Sistema impede conexão entre handles de tipos incompatíveis.

---

### 26.6 Deletar componente do canvas `[-]`

**Passo a passo:**
1. Selecionar componente no canvas.
2. Pressionar Delete ou usar menu de contexto → Delete.
3. Verificar que o componente é removido.

**Validação:** Componente removido após Delete key.

---

### 26.7 Copiar e colar componente (Ctrl+C / Ctrl+V) `[-]`

**Passo a passo:**
1. Clicar no componente para selecioná-lo.
2. Pressionar `Ctrl+C`.
3. Clicar em área vazia do canvas.
4. Pressionar `Ctrl+V`.
5. Verificar que um segundo componente (cópia) aparece.

**Validação:** Canvas com 2 componentes após copy-paste.

---

### 26.8 Selecionar múltiplos componentes via box selection `[-]`

**Passo a passo:**
1. Adicionar 2+ componentes ao canvas.
2. Segurar Shift e arrastar para criar caixa de seleção cobrindo os componentes.
3. Verificar que todos os componentes cobertos ficam selecionados.

**Validação:** Múltiplos componentes selecionados via Shift+drag.

---

### 26.9 Minimizar componente no canvas `[-]`

**Passo a passo:**
1. Clicar no botão de minimizar do componente.
2. Verificar que o componente exibe versão minimizada.
3. Clicar novamente para expandir.
4. Verificar que o componente volta ao tamanho normal.

**Validação:** Componente minimiza e expande corretamente.

---

### 26.10 Zoom in / Zoom out / Fit View `[-]`

**Passo a passo:**
1. Clicar em Zoom In — verificar que escala aumenta.
2. Clicar em Zoom Out — verificar que escala diminui.
3. Pressionar `Ctrl+Shift+H` ou clicar em "Fit View" — verificar que canvas centraliza todos os nós.

**Validação:** Zoom e fit view funcionam conforme esperado.

---

### 26.11 Criar e desfazer agrupamento `[-]`

**Passo a passo:**
1. Selecionar 2+ componentes via box selection.
2. Usar opção de agrupar (menu de contexto → "Group").
3. Verificar que componente de grupo é criado.
4. Usar "Ungroup" e verificar que os componentes originais são restaurados.

**Validação:** Agrupamento e desagrupamento de componentes funciona.

---

### 26.12 Congelar componente (Freeze) `[-]`

**Passo a passo:**
1. Clicar em "Freeze" no componente.
2. Verificar indicação visual de congelado.
3. Executar flow — verificar que o componente congelado usa cache.

**Validação:** Componente congelado não reexecuta em nova execução do flow.

---

### 26.13 Adicionar e deletar sticky note `[-]`

**Passo a passo:**
1. Right-click no canvas → "Add Note".
2. Verificar que sticky note aparece no canvas.
3. Selecionar e pressionar Delete.
4. Verificar que a nota foi removida.

**Validação:** Sticky note adicionada e removida do canvas.

---

### 26.14 Mudar cor da sticky note `[-]`

**Passo a passo:**
1. Selecionar sticky note no canvas.
2. Escolher uma cor diferente no seletor de cor.
3. Verificar que a cor da sticky note mudou.

**Validação:** Cor da sticky note alterada conforme seleção.

---

### 26.15 Menu de contexto por right-click no canvas `[-]`

**Passo a passo:**
1. Clicar com botão direito em área vazia do canvas.
2. Verificar que menu de contexto abre com opções disponíveis.

**Validação:** Menu de contexto abre com opções corretas.

---

### 26.16 Acessar página de Settings `[-]`

**Passo a passo:**
1. Clicar no ícone de perfil (`user-profile-settings`).
2. Clicar em "Settings" (`menu_settings_button`).
3. Verificar que a página de Settings carrega com todas as abas.

**Validação:** Página de Settings acessível com todas as abas.

---

### 26.17 Alterar configurações de aparência/tema `[-]`

**Passo a passo:**
1. Acessar Settings.
2. Localizar toggle de tema (Dark/Light mode).
3. Clicar para alternar o tema.
4. Verificar que o tema muda na interface.

**Validação:** Tema da interface altera conforme configuração.

---

---

## Resumo de Cobertura Atual

| Módulo | Total | Cobertos | Pendentes |
|--------|-------|----------|-----------|
| API REST | 17 | 17 | 0 |
| Autenticação + Usuários | 17 | 15 | 2 |
| Configuração de Componentes | 20 | 18 | 2 |
| Componentes Principais | 22 | 16 | 6 |
| Playground | 17 | 14 | 3 |
| Observabilidade | 16 | 13 | 3 |
| Model Providers | 16 | 10 | 6 |
| Knowledge Ingestion | 8 | 4 | 4 |
| Flow Operations | 20 | 18 | 2 |
| MCP | 13 | 3 | 10 |
| Gestão de Projetos | 11 | 9 | 2 |
| Templates | 35 | 33 | 2 |
| UI/UX Canvas | 34 | 32 | 2 |
| **TOTAL** | **246** | **202 (82%)** | **44 (18%)** |

---

## Prioridades de Automação

### 🔴 Alta Prioridade (bloqueadores de release)
1. Erro de API key inválida (OpenAI/Anthropic) — usuário deve ser informado claramente
2. Flow com erro Python exibe mensagem clara na UI
3. Atualização de componente com breaking change — alerta ao usuário
4. Erro de rede durante execução — retry ou mensagem descritiva

### 🟡 Média Prioridade
5. MCP client — consumo de tools e resources externos
6. Webhook trigger via requisição HTTP externa
7. Agent — inspecionar tools usadas no Playground
8. Playground compartilhável (URL pública sem autenticação)
9. Pipeline RAG completo

### 🟢 Baixa Prioridade
10. Loop component — iterações corretas
11. Provedores Ollama, Groq, Mistral
12. Parâmetros de modelo (temperatura, max tokens)
13. Editar texto de sticky note
14. Usar variável global diretamente em componente

---

*Gerado em 2026-03-18 | Fonte: QA-CHECKLIST.md*
