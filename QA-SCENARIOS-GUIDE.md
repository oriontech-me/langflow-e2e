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

**Objetivo:** Confirmar que o servidor Langflow está online e o banco de dados está acessível.

**Pré-condição:** Langflow rodando em `PLAYWRIGHT_BASE_URL` (default `http://localhost:7860`). Nenhuma autenticação necessária.

**Dado de teste:** Nenhum — endpoint público sem payload.

**Passo a passo:**
1. Fazer requisição `GET /health_check` sem header de autenticação.
2. Capturar status HTTP e corpo da resposta.
3. Verificar que o status é exatamente `200`.
4. Verificar que o corpo contém `{ "status": "ok", "db": "ok" }`.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `body.status === "ok"`
- `body.db === "ok"`

**Casos negativos:**
- [ ] Langflow offline → conexão recusada (`ECONNREFUSED`), não deve retornar 200

**Critério de falha:**
- Status diferente de 200
- Qualquer campo ausente ou com valor diferente de `"ok"`

---

### 1.1.b GET `/api/v1/health` → retorna uptime e versão `[-]`

**Objetivo:** Verificar que o endpoint de health estendido retorna metadados da instância em execução.

**Pré-condição:** Langflow rodando. Nenhuma autenticação necessária.

**Dado de teste:** Nenhum — endpoint público sem payload.

**Passo a passo:**
1. Fazer requisição `GET /api/v1/health` sem header de autenticação.
2. Capturar status HTTP e corpo da resposta.
3. Verificar que o status é `200`.
4. Verificar que o corpo contém os campos `uptime` (número > 0) e `version` (string não vazia).

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `typeof body.uptime === "number" && body.uptime > 0`
- `typeof body.version === "string" && body.version.length > 0`

**Casos negativos:**
- [ ] Endpoint chamado com método POST → deve retornar `405 Method Not Allowed`

**Critério de falha:**
- Status diferente de 200
- Campo `uptime` ausente, zero ou negativo
- Campo `version` ausente ou string vazia

---

---

## 2. API REST — CRUD de Flows

**Arquivo:** `core/features/api-flows-crud.spec.ts`

---

### 2.1 POST `/api/v1/flows/` → cria flow, retorna ID `[-]`

**Objetivo:** Verificar que é possível criar um flow via API e obter ID único.

**Pré-condição:** Bearer token obtido via `GET /api/v1/auto_login`. Nenhum flow com o nome de teste pré-existente.

**Dado de teste:**
```json
{ "name": "qa-flow-crud-001", "description": "Criado pelo teste de CRUD", "data": { "nodes": [], "edges": [] }, "is_component": false }
```

**Passo a passo:**
1. Obter token Bearer via `GET /api/v1/auto_login`.
2. Fazer `POST /api/v1/flows/` com body acima e header `Authorization: Bearer <token>`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `201`.
5. Verificar que o corpo contém campo `id` no formato UUID.
6. Guardar o `id` para uso nos cenários 2.2 a 2.6.

**Validação (critérios mecânicos):**
- `response.status() === 201`
- `body.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) !== null`
- `body.name === "qa-flow-crud-001"`

**Casos negativos:**
- [ ] POST sem body → deve retornar `422 Unprocessable Entity`
- [ ] POST sem token de autenticação → deve retornar `401 Unauthorized`
- [ ] POST com `name` vazio (`""`) → deve retornar `422` ou nome padrão

**Critério de falha:**
- Status diferente de 201
- Campo `id` ausente ou não é UUID válido (36 chars com hífens)
- Campo `name` na resposta difere de `"qa-flow-crud-001"`

---

### 2.2 GET `/api/v1/flows/` → lista flows do usuário `[-]`

**Objetivo:** Confirmar que a listagem de flows retorna os flows do usuário autenticado.

**Pré-condição:** Bearer token obtido via `GET /api/v1/auto_login`. Flow `"qa-flow-crud-001"` criado pelo cenário 2.1 deve existir.

**Dado de teste:** `id` do flow criado no cenário 2.1 (UUID).

**Passo a passo:**
1. Usar token Bearer do cenário 2.1.
2. Fazer `GET /api/v1/flows/` com header `Authorization: Bearer <token>`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `200`.
5. Verificar que o array retornado contém objeto com `id` igual ao criado no 2.1.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `Array.isArray(body) === true`
- `body.some(f => f.id === flowIdCriado) === true`
- `body.every(f => f.user_id === usuarioAtual) === true`

**Casos negativos:**
- [ ] GET sem token → deve retornar `401 Unauthorized`
- [ ] GET com token de outro usuário → não deve retornar flows do usuário atual

**Critério de falha:**
- Status diferente de 200
- Array não contém o flow criado no cenário 2.1
- Resposta não é um array

---

### 2.3 GET `/api/v1/flows/{id}` → retorna flow pelo ID `[-]`

**Objetivo:** Confirmar que um flow específico é retornado corretamente pelo seu ID.

**Pré-condição:** Bearer token válido. Flow `"qa-flow-crud-001"` criado no cenário 2.1 deve existir.

**Dado de teste:** `id` UUID do flow criado no cenário 2.1.

**Passo a passo:**
1. Usar `id` do flow criado no cenário 2.1.
2. Fazer `GET /api/v1/flows/{id}` com header `Authorization: Bearer <token>`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `200`.
5. Verificar que o campo `id` da resposta é igual ao ID solicitado.
6. Verificar que o campo `name` é `"qa-flow-crud-001"`.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `body.id === flowIdCriado`
- `body.name === "qa-flow-crud-001"`

**Casos negativos:**
- [ ] GET com UUID inexistente → deve retornar `404 Not Found`
- [ ] GET com string não-UUID → deve retornar `422 Unprocessable Entity`

**Critério de falha:**
- Status diferente de 200
- Campo `id` na resposta difere do ID solicitado
- Campo `name` ausente ou diferente do esperado

---

### 2.4 PATCH `/api/v1/flows/{id}` → atualiza nome/descrição `[-]`

**Objetivo:** Verificar que campos do flow podem ser atualizados via API.

**Pré-condição:** Bearer token válido. Flow `"qa-flow-crud-001"` criado no cenário 2.1 deve existir.

**Dado de teste:**
```json
{ "name": "qa-flow-crud-001-updated", "description": "Descrição atualizada pelo PATCH" }
```

**Passo a passo:**
1. Usar `id` do flow criado no cenário 2.1.
2. Fazer `PATCH /api/v1/flows/{id}` com body acima e header `Authorization: Bearer <token>`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `200`.
5. Fazer `GET /api/v1/flows/{id}` e verificar que o `name` foi atualizado.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `body.name === "qa-flow-crud-001-updated"`
- `body.description === "Descrição atualizada pelo PATCH"`

**Casos negativos:**
- [ ] PATCH com UUID inexistente → deve retornar `404 Not Found`
- [ ] PATCH sem token → deve retornar `401 Unauthorized`

**Critério de falha:**
- Status diferente de 200
- GET subsequente retorna nome anterior ao invés do novo
- Campo `description` não atualizado

---

### 2.5 DELETE `/api/v1/flows/{id}` → remove flow, retorna 200 `[-]`

**Objetivo:** Confirmar que um flow pode ser deletado via API.

**Pré-condição:** Bearer token válido. Flow `"qa-flow-crud-001-updated"` do cenário 2.4 deve existir.

**Dado de teste:** `id` UUID do flow criado no cenário 2.1.

**Passo a passo:**
1. Usar `id` do flow dos cenários anteriores.
2. Fazer `DELETE /api/v1/flows/{id}` com header `Authorization: Bearer <token>`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `200`.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `body.message === "Flow deleted successfully"` ou corpo vazio (aceitar ambos)

**Casos negativos:**
- [ ] DELETE com UUID inexistente → deve retornar `404 Not Found`
- [ ] DELETE sem token → deve retornar `401 Unauthorized`
- [ ] DELETE em flow de outro usuário → deve retornar `403 Forbidden`

**Critério de falha:**
- Status diferente de 200
- Flow ainda acessível via GET após DELETE

---

### 2.6 GET após DELETE → deve retornar 404 `[-]`

**Objetivo:** Garantir que um flow deletado não é mais acessível.

**Pré-condição:** Bearer token válido. Flow com `id` UUID do cenário 2.1 deve ter sido deletado no cenário 2.5.

**Dado de teste:** `id` UUID do flow deletado no cenário 2.5.

**Passo a passo:**
1. Usar o mesmo `id` UUID do flow deletado no cenário 2.5.
2. Fazer `GET /api/v1/flows/{id}` com header `Authorization: Bearer <token>`.
3. Capturar status HTTP.
4. Verificar que o status é `404`.

**Validação (critérios mecânicos):**
- `response.status() === 404`
- `body.detail` contém texto de "not found" ou similar (string não vazia)

**Casos negativos:**
- [ ] GET com ID de flow nunca criado (`00000000-0000-0000-0000-000000000000`) → deve retornar `404`

**Critério de falha:**
- Status diferente de 404 (ex: 200 indicaria que o flow não foi deletado)
- Corpo da resposta contém dados do flow deletado

---

---

## 3. API REST — Execução de Flows

**Arquivos:** `core/features/api-run-flow.spec.ts`, `api-run-with-tweaks.spec.ts`

---

### 3.1 POST `/api/v1/run/{flow_id}` com `input_value` `[-]`

**Objetivo:** Executar um flow via API e receber resposta.

**Pré-condição:** Bearer token obtido via `GET /api/v1/auto_login`. Flow de Chat (Chat Input → Chat Output) criado e `flow_id` UUID disponível. API key gerada via `POST /api/v1/api_key/`.

**Dado de teste:**
```json
{ "input_value": "qa-run-test-message-001", "input_type": "chat", "output_type": "chat" }
```

**Passo a passo:**
1. Obter Bearer token via `GET /api/v1/auto_login`.
2. Criar API key via `POST /api/v1/api_key/` → guardar `api_key` e `id`.
3. Criar flow de Chat (Chat Input → Chat Output) e guardar `flow_id`.
4. Fazer `POST /api/v1/run/{flow_id}` com header `x-api-key: <api_key>` e body acima.
5. Capturar status HTTP e corpo da resposta.
6. Verificar que o status é `200`.
7. Verificar que o corpo contém campo `outputs` (array não vazio).

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `Array.isArray(body.outputs) === true`
- `body.outputs.length > 0`
- `typeof body.session_id === "string"`

**Casos negativos:**
- [ ] POST sem `input_value` → ver cenário 3.4 (key inválida) ou retornar 422
- [ ] POST com flow_id inválido → ver cenário 3.5

**Critério de falha:**
- Status diferente de 200
- Campo `outputs` ausente ou array vazio
- Resposta sem campo `session_id`

---

### 3.2 POST com `tweaks` → parâmetros sobrescrevem configuração `[-]`

**Objetivo:** Verificar que tweaks sobrescrevem parâmetros configurados no flow.

**Pré-condição:** Bearer token válido. Flow com componente Chat Input (node id `ChatInput-abc123`) criado e `flow_id` disponível. API key válida.

**Dado de teste:**
```json
{ "input_value": "qa-tweaks-test-001", "input_type": "chat", "output_type": "chat", "tweaks": { "ChatInput-abc123": { "input_value": "tweaked-input-value-001" } } }
```

**Passo a passo:**
1. Criar flow com Chat Input cujo `input_value` padrão é `"default-value"`.
2. Fazer `POST /api/v1/run/{flow_id}` com body acima incluindo campo `tweaks`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `200`.
5. Verificar que a execução utilizou o valor `"tweaked-input-value-001"` e não o padrão.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- Saída da execução reflete o valor do tweak e não o padrão do componente
- `body.outputs[0].outputs[0].results.message.text` contém ou foi gerado a partir de `"tweaked-input-value-001"`

**Casos negativos:**
- [ ] Tweak com nome de componente inexistente → execução continua com valores padrão (sem erro 4xx)
- [ ] Tweak com tipo de valor incompatível → deve retornar `422`

**Critério de falha:**
- Status diferente de 200
- Saída contém o valor padrão do componente ao invés do tweak
- Campo `outputs` ausente na resposta

---

### 3.3 POST com `session_id` customizado `[-]`

**Objetivo:** Garantir que sessões customizadas isolam o histórico de conversa.

**Pré-condição:** Bearer token válido. Flow de Chat criado e `flow_id` disponível. API key válida.

**Dado de teste:**
- Sessão A: `session_id = "qa-session-alpha-001"`, `input_value = "qa-msg-alpha"`
- Sessão B: `session_id = "qa-session-beta-002"`, `input_value = "qa-msg-beta"`

**Passo a passo:**
1. Fazer `POST /api/v1/run/{flow_id}` com body `{ "input_value": "qa-msg-alpha", "session_id": "qa-session-alpha-001" }`.
2. Verificar que `body.session_id === "qa-session-alpha-001"` na resposta.
3. Fazer `POST /api/v1/run/{flow_id}` com body `{ "input_value": "qa-msg-beta", "session_id": "qa-session-beta-002" }`.
4. Verificar que `body.session_id === "qa-session-beta-002"` na resposta.
5. Verificar histórico de mensagens de cada sessão via `GET /api/v1/monitor/messages?session_id=qa-session-alpha-001` e `...beta-002` — cada um deve conter apenas suas próprias mensagens.

**Validação (critérios mecânicos):**
- `body.session_id === "qa-session-alpha-001"` (primeira chamada)
- `body.session_id === "qa-session-beta-002"` (segunda chamada)
- Mensagens de `qa-session-alpha-001` não aparecem no filtro por `qa-session-beta-002`

**Casos negativos:**
- [ ] POST sem `session_id` → deve gerar session_id automaticamente (campo não nulo na resposta)

**Critério de falha:**
- `session_id` retornado difere do enviado
- Mensagens de sessões distintas aparecem misturadas no histórico

---

### 3.4 POST com API key inválida → retorna 401/403 `[-]`

**Objetivo:** Confirmar que a API protege execução com autenticação.

**Pré-condição:** Flow de Chat criado e `flow_id` disponível. Nenhuma autenticação válida fornecida.

**Dado de teste:** `x-api-key: sk-qa-invalid-key-000000000000000000000`

**Passo a passo:**
1. Fazer `POST /api/v1/run/{flow_id}` com header `x-api-key: sk-qa-invalid-key-000000000000000000000`.
2. Capturar status HTTP e corpo da resposta.
3. Verificar que o status é `401` ou `403`.

**Validação (critérios mecânicos):**
- `response.status() === 401 || response.status() === 403`
- `body.detail` contém texto de autenticação inválida (string não vazia)

**Casos negativos:**
- [ ] POST sem nenhum header de autenticação → deve retornar `401` ou `403`
- [ ] POST com header `x-api-key` vazio (`""`) → deve retornar `401` ou `422`

**Critério de falha:**
- Status 200 (execução bem-sucedida com credencial inválida)
- Status diferente de 401 ou 403

---

### 3.5 POST para flow inexistente → retorna 404 `[-]`

**Objetivo:** Confirmar comportamento quando flow não existe.

**Pré-condição:** API key válida disponível. UUID `00000000-0000-0000-0000-000000000000` não deve existir como flow.

**Dado de teste:** `flow_id = "00000000-0000-0000-0000-000000000000"`

**Passo a passo:**
1. Fazer `POST /api/v1/run/00000000-0000-0000-0000-000000000000` com header `x-api-key: <api_key_valida>` e body `{ "input_value": "qa-test", "input_type": "chat", "output_type": "chat" }`.
2. Capturar status HTTP e corpo da resposta.
3. Verificar que o status é `404`.

**Validação (critérios mecânicos):**
- `response.status() === 404`
- `body.detail` contém texto indicando flow não encontrado (string não vazia)

**Casos negativos:**
- [ ] POST com string não-UUID no path → deve retornar `422 Unprocessable Entity`

**Critério de falha:**
- Status diferente de 404
- Status 200 (indicaria que o endpoint não valida existência do flow)

---

---

## 4. API REST — Componentes e Mensagens

---

### 4.1 GET `/api/v1/all` → lista componentes disponíveis `[-]`

**Objetivo:** Verificar que o catálogo de componentes está acessível.

**Pré-condição:** Bearer token obtido via `GET /api/v1/auto_login`.

**Dado de teste:** Nenhum — requisição GET sem payload.

**Passo a passo:**
1. Fazer `GET /api/v1/all` com header `Authorization: Bearer <token>`.
2. Capturar status HTTP e corpo da resposta.
3. Verificar que o status é `200`.
4. Verificar que o corpo é um objeto com múltiplas chaves (nomes de componentes).
5. Verificar que componentes conhecidos estão presentes (ex: chave `"ChatInput"` ou `"OpenAIModel"`).

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `typeof body === "object" && !Array.isArray(body)`
- `Object.keys(body).length > 10`
- `"ChatInput" in body || "chat_input" in body` (ou chave equivalente presente)

**Casos negativos:**
- [ ] GET sem token → deve retornar `401 Unauthorized`

**Critério de falha:**
- Status diferente de 200
- Corpo vazio ou com menos de 10 chaves (catálogo incompleto)
- Resposta é array ao invés de objeto

---

### 4.2 GET `/api/v1/monitor/messages` → retorna array `[-]`

**Objetivo:** Verificar que o histórico de mensagens de um flow é acessível via API.

**Pré-condição:** Bearer token válido. Flow de Chat executado ao menos uma vez com `session_id = "qa-session-messages-001"` para gerar mensagens. `flow_id` UUID disponível.

**Dado de teste:** `flow_id` UUID de um flow que foi executado e gerou mensagens.

**Passo a passo:**
1. Usar `flow_id` de um flow executado no cenário 3.1.
2. Fazer `GET /api/v1/monitor/messages?flow_id={flow_id}` com header `Authorization: Bearer <token>`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `200`.
5. Verificar que o corpo é um array com ao menos uma mensagem.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `Array.isArray(body) === true`
- `body.length > 0`
- `typeof body[0].text === "string"`
- `body[0].flow_id === flowId`

**Casos negativos:**
- [ ] GET com `flow_id` string não-UUID → deve retornar `422 Unprocessable Entity`
- [ ] GET sem token → deve retornar `401 Unauthorized`

**Critério de falha:**
- Status diferente de 200
- Corpo não é array
- Array vazio para flow que foi executado

> ⚠️ `flow_id` deve ser UUID válido — strings arbitrárias retornam `422`.

---

### 4.3 GET com filtro de session_id `[-]`

**Objetivo:** Verificar que mensagens podem ser filtradas por sessão.

**Pré-condição:** Bearer token válido. Flow executado com `session_id = "qa-filter-session-001"` (ao menos uma execução com essa sessão). `flow_id` UUID disponível.

**Dado de teste:** `session_id = "qa-filter-session-001"`, `flow_id` UUID do flow executado.

**Passo a passo:**
1. Executar flow com `session_id: "qa-filter-session-001"` (via cenário 3.1 ou setup direto).
2. Fazer `GET /api/v1/monitor/messages?flow_id={flow_id}&session_id=qa-filter-session-001` com header `Authorization: Bearer <token>`.
3. Capturar status HTTP e corpo da resposta.
4. Verificar que o status é `200`.
5. Verificar que todas as mensagens retornadas têm `session_id === "qa-filter-session-001"`.

**Validação (critérios mecânicos):**
- `response.status() === 200`
- `Array.isArray(body) === true`
- `body.every(m => m.session_id === "qa-filter-session-001") === true`

**Casos negativos:**
- [ ] Filtro com `session_id` inexistente → deve retornar array vazio `[]` com status `200`

**Critério de falha:**
- Status diferente de 200
- Array contém mensagens de sessões diferentes da filtrada
- Filtro ignorado (retorna todas as mensagens sem filtrar)

---

---

## 5. API REST — Geração de Código de Integração

---

### 5.1 Gerar curl para execução `[-]`

**Objetivo:** Verificar que o Langflow gera um comando `curl` válido para execução do flow.

**Pré-condição:** Usuário autenticado (auto-login ou login manual). Flow aberto no editor com `flow_id` UUID visível na URL.

**Dado de teste:** Flow `"qa-flow-api-access-001"` aberto no editor.

**Passo a passo:**
1. Abrir flow `"qa-flow-api-access-001"` no editor.
2. Clicar no botão `api-access-button`.
3. Selecionar a aba `cURL` no modal.
4. Capturar o texto do código gerado.
5. Verificar que o código contém `curl -X POST`.
6. Verificar que o código contém a URL com o `flow_id` correto (formato `/api/v1/run/{flow_id}`).

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("api-access-button")).toBeVisible()`
- Texto do bloco cURL contém `curl -X POST`
- Texto do bloco cURL contém o `flow_id` UUID do flow aberto

**Casos negativos:**
- [ ] Modal aberto em flow sem ID (novo flow não salvo) → botão desabilitado ou código inválido

**Critério de falha:**
- Botão `api-access-button` não está visível
- Modal não abre ao clicar no botão
- Código gerado não contém `curl -X POST` ou não contém o `flow_id`

---

### 5.2 Gerar código Python para integração `[-]`

**Objetivo:** Verificar que o Langflow gera código Python funcional para chamar o flow.

**Pré-condição:** Usuário autenticado. Flow `"qa-flow-api-access-001"` aberto no editor. Modal de API Access já acessível via `api-access-button`.

**Dado de teste:** Flow `"qa-flow-api-access-001"` com `flow_id` UUID disponível na URL.

**Passo a passo:**
1. Abrir flow `"qa-flow-api-access-001"` no editor.
2. Clicar no botão `api-access-button`.
3. Selecionar a aba `Python` no modal.
4. Capturar o texto do código gerado.
5. Verificar que o código contém `import requests`.
6. Verificar que o código contém a URL com o `flow_id` correto.
7. Verificar que o código contém o método de chamada `requests.post(`.

**Validação (critérios mecânicos):**
- Texto do bloco Python contém `import requests`
- Texto do bloco Python contém `/api/v1/run/{flow_id}`
- Texto do bloco Python contém `requests.post(`

**Casos negativos:**
- [ ] Selecionar aba `JavaScript` (se disponível) → código deve usar `fetch(` ou `axios`

**Critério de falha:**
- Aba `Python` não aparece no modal
- Código gerado não contém `import requests`
- Código gerado não contém o `flow_id` UUID correto

---

---

## 6. Configuração de Componentes — Painel de Parâmetros

**Arquivos:** `core/unit/inputComponent.spec.ts`, `dropdownComponent.spec.ts`, etc.

---

### 6.1 Abrir opções avançadas do componente `[-]`

**Objetivo:** Verificar que o painel de parâmetros avançados pode ser aberto.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas vazio.

**Dado de teste:** Componente `"OpenAI"` adicionado ao canvas.

**Passo a passo:**
1. Adicionar componente `"OpenAI"` ao canvas via sidebar.
2. Localizar o botão "Advanced" ou ícone de configurações no componente.
3. Clicar no botão para expandir as opções avançadas.
4. Verificar que o painel de opções avançadas expande exibindo campos adicionais (ex: `max_tokens`, `model_kwargs`).

**Validação (critérios mecânicos):**
- `await expect(page.locator('[data-testid="advanced-button-modal"]')).toBeVisible()` (ou seletor equivalente)
- Painel avançado expandido exibe ao menos 1 campo adicional além dos campos padrão

**Casos negativos:**
- [ ] Clicar em "Advanced" duas vezes → painel deve fechar (toggle)

**Critério de falha:**
- Botão "Advanced" não visível no componente
- Painel não expande ao clicar
- Nenhum campo adicional é exibido após expansão

---

### 6.2 Editar campo de texto (input) `[-]`

**Objetivo:** Verificar que campos de texto em componentes aceitam e persistem valores digitados.

**Pré-condição:** Usuário autenticado. Flow aberto com componente `"Chat Input"` no canvas.

**Dado de teste:** Valor `"qa-input-text-value-001"` a ser inserido no campo `input_value` do Chat Input.

**Passo a passo:**
1. Adicionar componente `"Chat Input"` ao canvas.
2. Localizar o campo de texto `input_value` no componente.
3. Clicar no campo e digitar `"qa-input-text-value-001"`.
4. Clicar fora do campo ou pressionar Tab para confirmar.
5. Verificar que o campo exibe `"qa-input-text-value-001"`.

**Validação (critérios mecânicos):**
- Campo de texto do componente exibe `"qa-input-text-value-001"` após edição
- `await expect(page.locator('input[name="input_value"]')).toHaveValue("qa-input-text-value-001")` (ou seletor equivalente)

**Casos negativos:**
- [ ] Digitar valor e pressionar Escape → campo deve reverter ao valor anterior

**Critério de falha:**
- Campo não aceita digitação
- Valor não persiste após clicar fora do campo
- Campo exibe valor diferente do digitado

---

### 6.3 Editar dropdown `[-]`

**Objetivo:** Verificar que dropdowns em componentes exibem e persistem a opção selecionada.

**Pré-condição:** Usuário autenticado. Flow aberto com componente `"OpenAI"` no canvas. Campo de modelo com dropdown disponível.

**Dado de teste:** Opção `"gpt-4o-mini"` (testid: `gpt-4o-mini-option`) a ser selecionada no dropdown de modelo.

**Passo a passo:**
1. Adicionar componente `"OpenAI"` ao canvas.
2. Localizar o dropdown de seleção de modelo no componente.
3. Clicar no dropdown para abrir as opções.
4. Selecionar a opção `"gpt-4o-mini"` usando `data-testid="gpt-4o-mini-option"`.
5. Verificar que o dropdown exibe `"gpt-4o-mini"` como opção selecionada.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("gpt-4o-mini-option")).toBeVisible()` (após abrir dropdown)
- Dropdown do componente exibe texto `"gpt-4o-mini"` após seleção

**Casos negativos:**
- [ ] Abrir dropdown e pressionar Escape → deve fechar sem alterar seleção

**Critério de falha:**
- Dropdown não abre ao clicar
- Opção `gpt-4o-mini` não está visível na lista
- Após seleção, dropdown exibe opção diferente da selecionada

---

### 6.4 Editar toggle `[-]`

**Objetivo:** Verificar que toggles em componentes alternam corretamente entre os estados.

**Pré-condição:** Usuário autenticado. Flow aberto com componente `"OpenAI"` no canvas. Campo `stream` com toggle disponível.

**Dado de teste:** Toggle do campo `stream` no componente `"OpenAI"`.

**Passo a passo:**
1. Adicionar componente `"OpenAI"` ao canvas.
2. Localizar o toggle do campo `stream` no componente.
3. Verificar o estado inicial do toggle (ex: `false` / desligado).
4. Clicar no toggle para inverter o estado.
5. Verificar que o toggle mudou para o estado oposto (ex: `true` / ligado).
6. Clicar novamente no toggle.
7. Verificar que o toggle retornou ao estado inicial.

**Validação (critérios mecânicos):**
- Toggle exibe estado `false` inicialmente (ou estado padrão do componente)
- Após primeiro clique: toggle exibe estado `true`
- Após segundo clique: toggle retorna ao estado `false`
- `await expect(page.locator('[data-testid="toggle-stream"]')).toHaveAttribute("data-state", "checked")` (ou equivalente)

**Casos negativos:**
- [ ] Toggle em componente bloqueado (read-only) → não deve responder ao clique

**Critério de falha:**
- Toggle não responde ao clique
- Estado visual não muda após clicar
- Estado não persiste após mover foco para outro elemento

---

### 6.5 Editar campo float / int `[-]`

**Objetivo:** Verificar que campos numéricos em componentes aceitam e persistem valores válidos.

**Pré-condição:** Usuário autenticado. Flow aberto com componente `"OpenAI"` no canvas. Campo `temperature` (float) disponível.

**Dado de teste:** Valor `0.3` a ser inserido no campo `temperature` do componente `"OpenAI"`.

**Passo a passo:**
1. Adicionar componente `"OpenAI"` ao canvas.
2. Localizar o campo numérico `temperature` no componente (valor padrão `0.7` ou similar).
3. Clicar no campo e limpar o valor atual.
4. Digitar `0.3`.
5. Pressionar Enter ou clicar fora do campo.
6. Verificar que o campo exibe `0.3`.

**Validação (critérios mecânicos):**
- Campo `temperature` exibe `0.3` após edição
- `await expect(page.locator('[data-testid="float-input-temperature"]')).toHaveValue("0.3")` (ou seletor equivalente)

**Casos negativos:**
- [ ] Digitar texto não-numérico (`"abc"`) → campo deve rejeitar ou reverter ao valor anterior
- [ ] Digitar valor fora do range (`-1` ou `2.0` para temperature) → campo deve mostrar erro ou clipar ao limite

**Critério de falha:**
- Campo não aceita o valor `0.3`
- Valor não persiste após pressionar Enter
- Campo exibe valor diferente de `0.3` após edição

---

### 6.6 Editar slider `[-]`

**Objetivo:** Verificar que sliders em componentes atualizam o valor numérico correspondente.

**Pré-condição:** Usuário autenticado. Flow aberto com componente que possui campo de slider (ex: `"OpenAI"` com campo `temperature` em modo slider).

**Dado de teste:** Slider do campo `temperature` com range `0.0` a `2.0`.

**Passo a passo:**
1. Adicionar componente `"OpenAI"` ao canvas.
2. Localizar o slider do campo `temperature`.
3. Arrastar o slider para a posição extrema direita (valor máximo).
4. Verificar que o valor numérico exibido ao lado do slider corresponde ao valor máximo.
5. Arrastar o slider para a posição extrema esquerda (valor mínimo).
6. Verificar que o valor numérico corresponde ao valor mínimo.

**Validação (critérios mecânicos):**
- Após arrastar para a direita: valor exibido é igual ao valor máximo do range (ex: `2.0`)
- Após arrastar para a esquerda: valor exibido é igual ao valor mínimo do range (ex: `0.0`)
- Slider e campo numérico exibem o mesmo valor simultaneamente

**Casos negativos:**
- [ ] Editar campo numérico manualmente → slider deve mover para posição correspondente

**Critério de falha:**
- Slider não responde a arrastar
- Valor numérico não atualiza ao mover slider
- Desincronização entre posição do slider e valor numérico exibido

---

---

## 7. Tool Mode

**Arquivos:** `extended/features/tool-mode.spec.ts`, `core/features/toolModeGroup.spec.ts`

---

### 7.1 Habilitar Tool Mode num componente `[-]`

**Objetivo:** Verificar que um componente pode ser habilitado como "Tool" para uso por Agents.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas vazio. Componente `"API Request"` disponível na sidebar.

**Dado de teste:** Componente `"API Request"` adicionado ao canvas.

**Passo a passo:**
1. Adicionar componente `"API Request"` ao canvas via sidebar.
2. Localizar o toggle "Tool Mode" no componente (geralmente no header ou painel de opções).
3. Clicar no toggle para habilitar Tool Mode.
4. Verificar que o componente exibe indicação visual de Tool Mode ativo (badge, borda colorida, ou ícone).
5. Verificar que o handle de tool (`tool`) fica disponível no lado direito do componente para conexão com Agent.

**Validação (critérios mecânicos):**
- Toggle de Tool Mode exibe estado ativo após clicar
- Handle de tool visível no componente: `await expect(page.locator('[data-testid="handle-api request-shownode-tool-right"]')).toBeVisible()`
- Indicação visual de Tool Mode ativo (badge ou borda) presente no componente

**Casos negativos:**
- [ ] Desabilitar Tool Mode após habilitar → handle de tool deve desaparecer

**Critério de falha:**
- Toggle de Tool Mode não está visível no componente
- Handle de tool não aparece após habilitar
- Nenhuma indicação visual de Tool Mode ativo

---

### 7.2 Agrupar componentes em Tool Mode `[-]`

**Objetivo:** Verificar que agrupamento de componentes preserva as configurações de Tool Mode.

**Pré-condição:** Usuário autenticado. Flow aberto com ao menos 2 componentes `"API Request"` no canvas, ambos com Tool Mode habilitado.

**Dado de teste:** 2 instâncias de `"API Request"` com Tool Mode ativo.

**Passo a passo:**
1. Adicionar 2 componentes `"API Request"` ao canvas.
2. Habilitar Tool Mode em ambos (conforme cenário 7.1).
3. Selecionar ambos os componentes via Shift+drag (box selection).
4. Clicar com botão direito e selecionar "Group" no menu de contexto.
5. Verificar que um componente de grupo é criado no canvas.
6. Verificar que o grupo exibe handles de tool dos componentes internos.

**Validação (critérios mecânicos):**
- Componente de grupo visível no canvas após agrupar
- `await expect(page.locator('[data-testid*="group"]')).toBeVisible()` (ou seletor do grupo)
- Grupo exibe handles correspondentes aos componentes internos em Tool Mode

**Casos negativos:**
- [ ] Tentar agrupar apenas 1 componente → opção de grupo desabilitada ou erro exibido

**Critério de falha:**
- Opção "Group" não disponível no menu de contexto
- Grupo criado não exibe handles de tool
- Tool Mode perdido após agrupar

---

---

## 8. Atualização de Componentes

**Arquivos:** `extended/features/outdated-message.spec.ts`, `outdated-actions.spec.ts`

---

### 8.1 Notificação de componente desatualizado `[-]`

**Objetivo:** Garantir que o Langflow alerta o usuário quando um componente está em versão antiga.

**Pré-condição:** Usuário autenticado. Arquivo JSON de flow com componente em versão desatualizada disponível em `tests/assets/flows/` (ex: flow exportado de versão anterior do Langflow).

**Dado de teste:** Arquivo `tests/assets/flows/outdated-component-flow.json` contendo ao menos um componente com versão inferior à atual.

**Passo a passo:**
1. Importar arquivo `outdated-component-flow.json` via menu de importação.
2. Aguardar o flow abrir no editor.
3. Verificar que o componente desatualizado exibe badge ou ícone de alerta (ex: ícone de atualização, borda amarela, ou texto "outdated").
4. Verificar que existe botão ou opção para atualizar o componente.

**Validação (critérios mecânicos):**
- Badge/ícone de componente desatualizado visível no canvas
- `await expect(page.locator('[data-testid="update-button"]')).toBeVisible()` (ou seletor equivalente de botão de atualização)
- Tooltip ou texto informativo sobre versão desatualizada presente

**Casos negativos:**
- [ ] Flow com todos os componentes atualizados → nenhum badge de outdated deve aparecer

**Critério de falha:**
- Nenhuma indicação visual de componente desatualizado
- Botão de atualização não disponível para o componente
- Flow importado não exibe nenhum alerta de versão

---

### 8.2 Ação de atualizar componente `[-]`

**Objetivo:** Verificar que a ação de atualizar componente remove o badge de outdated e preserva as configurações.

**Pré-condição:** Usuário autenticado. Flow com componente desatualizado aberto (continuação do cenário 8.1). Componente desatualizado com configuração customizada definida (ex: campo `url` preenchido com `"https://qa-test-url.example.com"`).

**Dado de teste:** Componente desatualizado com campo `url` definido como `"https://qa-test-url.example.com"`.

**Passo a passo:**
1. Identificar componente com badge de desatualizado no canvas.
2. Anotar os valores de configuração atuais (ex: campo `url = "https://qa-test-url.example.com"`).
3. Clicar no botão "Update" do componente (ou opção no menu de contexto).
4. Aguardar a atualização.
5. Verificar que o badge de desatualizado desapareceu do componente.
6. Verificar que o campo `url` ainda exibe `"https://qa-test-url.example.com"` (configuração preservada).

**Validação (critérios mecânicos):**
- Badge/ícone de outdated não visível após atualizar
- Campo de configuração `url` mantém valor `"https://qa-test-url.example.com"` após atualização
- `await expect(page.locator('[data-testid="update-button"]')).not.toBeVisible()` após atualizar

**Casos negativos:**
- [ ] Cancelar atualização → componente mantém badge de outdated e configurações inalteradas

**Critério de falha:**
- Badge de outdated persiste após clicar em "Update"
- Configurações do componente são perdidas após atualização
- Componente desaparece do canvas após atualização

---

---

## 9. Componentes Principais — Chat Input/Output

**Arquivos:** `core/unit/chatInputOutput.spec.ts`, `core/integrations/textInputOutput.spec.ts`

---

### 9.1 ChatInput recebe mensagem do usuário `[-]`

**Objetivo:** Verificar que o componente Chat Input processa mensagem de entrada.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` conectado a `"Chat Output"` criado no editor.

**Dado de teste:** Mensagem `"qa-chat-input-test-message-001"` a ser enviada no Playground.

**Passo a passo:**
1. Criar flow com componente `"Chat Input"` conectado ao `"Chat Output"`.
2. Clicar no botão `playground-btn-flow-io` para abrir o Playground.
3. Verificar que o campo `input-chat-playground` está visível.
4. Digitar `"qa-chat-input-test-message-001"` no campo `input-chat-playground`.
5. Clicar no botão de envio `button-send`.
6. Verificar que a mensagem do usuário aparece no histórico do chat.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("input-chat-playground")).toBeVisible()`
- `await expect(page.getByTestId("button-send")).toBeVisible()`
- Mensagem `"qa-chat-input-test-message-001"` visível no histórico após envio

**Casos negativos:**
- [ ] Enviar mensagem vazia → ver cenário 21.3 (BUG documentado)

**Critério de falha:**
- Campo `input-chat-playground` não visível
- Botão `button-send` não responde ao clique
- Mensagem enviada não aparece no histórico do chat

---

### 9.2 ChatOutput exibe resposta do LLM `[-]`

**Objetivo:** Verificar que o componente Chat Output exibe a resposta gerada pelo LLM.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` → `"OpenAI"` → `"Chat Output"` criado. API key OpenAI configurada via variável global `OPENAI_API_KEY`. Modelo `gpt-4o-mini` selecionado.

**Dado de teste:** Mensagem `"qa-llm-response-test-001 — respond with exactly: PONG"` enviada para provocar resposta determinística.

**Passo a passo:**
1. Criar flow `"Chat Input"` → `"OpenAI"` (gpt-4o-mini, API key via variável global) → `"Chat Output"`.
2. Abrir Playground (`playground-btn-flow-io`).
3. Digitar `"qa-llm-response-test-001 — respond with exactly: PONG"` no campo `input-chat-playground`.
4. Clicar em `button-send`.
5. Aguardar resposta (botão Stop desaparece ou resposta aparece).
6. Verificar que a resposta do assistente aparece no histórico do chat.

**Validação (critérios mecânicos):**
- Mensagem do assistente visível no histórico após execução
- Elemento com classe ou testid de mensagem do bot presente no DOM
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Flow sem API key configurada → erro de autenticação exibido no chat (ver cenário 19.5)

**Critério de falha:**
- Nenhuma resposta do assistente aparece após enviar mensagem
- Spinner de loading nunca desaparece (timeout)
- Erro de backend logado (`🚨 Backend Error:`) durante execução

---

---

## 10. Componentes Principais — Prompt Template

**Arquivos:** `core/regression/generalBugs-prompt.spec.ts`, `core/features/prompt-dynamic-variables.spec.ts`

---

### 10.1 Prompt com variáveis em curly braces `[-]`

**Objetivo:** Verificar que variáveis `{nome}` no prompt criam handles dinâmicos.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas vazio. Componente `"Prompt"` disponível na sidebar.

**Dado de teste:** Texto do prompt: `"Olá {nome}, seu cargo é {cargo}."` — contendo 2 variáveis: `nome` e `cargo`.

**Passo a passo:**
1. Adicionar componente `"Prompt"` ao canvas via sidebar.
2. Clicar no botão `button_open_prompt_modal` para abrir o editor de prompt.
3. No campo de texto do modal, digitar: `Olá {nome}, seu cargo é {cargo}.`
4. Clicar em "Save" (`genericModalBtnSave`).
5. Verificar que dois handles foram criados no lado esquerdo do componente: `nome` e `cargo`.

**Validação (critérios mecânicos):**
- `await expect(page.locator('[data-testid="handle-prompt template-shownode-nome-left"]')).toBeVisible()`
- `await expect(page.locator('[data-testid="handle-prompt template-shownode-cargo-left"]')).toBeVisible()`

**Casos negativos:**
- [ ] Texto sem variáveis `{}` → nenhum handle dinâmico deve ser criado
- [ ] Variável com espaço `{nome completo}` → comportamento definido (handle criado ou ignorado)

**Critério de falha:**
- Handle `nome` não aparece no componente após salvar
- Handle `cargo` não aparece no componente após salvar
- Handles aparecem em posição incorreta (direita ao invés de esquerda)

---

### 10.2 Remover variável do prompt apaga porta correspondente `[-]`

**Objetivo:** Verificar que remover uma variável do prompt remove o handle correspondente do componente.

**Pré-condição:** Usuário autenticado. Flow com componente `"Prompt"` no canvas e handle `nome` já criado (continuação do cenário 10.1). Texto atual do prompt: `"Olá {nome}, seu cargo é {cargo}."`.

**Dado de teste:** Texto atualizado do prompt: `"Olá, seu cargo é {cargo}."` — removendo a variável `{nome}`.

**Passo a passo:**
1. Com componente `"Prompt"` contendo handles `nome` e `cargo`.
2. Clicar no botão `button_open_prompt_modal` para reabrir o editor.
3. No campo de texto, remover `{nome}` — deixar apenas `{cargo}`.
4. Clicar em "Save" (`genericModalBtnSave`).
5. Verificar que o handle `nome` desapareceu do componente.
6. Verificar que o handle `cargo` ainda está presente.

**Validação (critérios mecânicos):**
- `await expect(page.locator('[data-testid="handle-prompt template-shownode-nome-left"]')).not.toBeVisible()`
- `await expect(page.locator('[data-testid="handle-prompt template-shownode-cargo-left"]')).toBeVisible()`

**Casos negativos:**
- [ ] Remover todas as variáveis → todos os handles dinâmicos devem desaparecer

**Critério de falha:**
- Handle `nome` permanece visível após remover `{nome}` do prompt
- Handle `cargo` desaparece incorretamente
- Componente exibe erro após atualizar o prompt

---

---

## 11. Componentes Principais — API Request

**Arquivos:** `core-components/api-request-component-regression.spec.ts`

---

### 11.1 Renderiza no canvas com handles corretos `[x]`

**Objetivo:** Verificar que o componente API Request é adicionado ao canvas com título, handle de saída (`api response`) e handle de entrada (`url`) visíveis.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas vazio.

**Dado de teste:** Nenhum — apenas adicionar o componente.

**Passo a passo:**
1. Buscar `"API Request"` no campo `sidebar-search-input`.
2. Hover no item da sidebar e clicar em `add-component-button-api-request`.
3. Verificar que o título `title-API Request` aparece no canvas.
4. Verificar os handles `handle-apirequest-shownode-api response-right` e `handle-apirequest-shownode-url-left`.
5. Confirmar que há exatamente 1 nó no canvas.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("title-API Request")).toBeVisible()`
- `await expect(page.getByTestId("handle-apirequest-shownode-api response-right")).toBeVisible()`
- `await expect(page.getByTestId("handle-apirequest-shownode-url-left")).toBeVisible()`
- `await expect(page.locator(".react-flow__node")).toHaveCount(1)`

**Critério de falha:**
- Componente não aparece no canvas após clicar em adicionar
- Handles de entrada ou saída ausentes

---

### 11.2 Configurar URL e método HTTP `[x]`

**Objetivo:** Verificar que o campo URL aceita e retém um valor digitado e que o dropdown de método pode ser alterado.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas.

**Dado de teste:** URL `"https://httpbin.org/get"` | Método alterado para: `"POST"`

**Passo a passo:**
1. Localizar o campo `popover-anchor-input-url_input` no inspector.
2. Preencher com `"https://httpbin.org/get"` e verificar que o valor persiste.
3. Clicar no dropdown `dropdown_str_method`.
4. Selecionar `"POST"` na lista.
5. Verificar que `value-dropdown-dropdown_str_method` exibe `"POST"`.

**Validação (critérios mecânicos):**
- `await expect(urlInput).toHaveValue("https://httpbin.org/get")`
- `await expect(page.getByTestId("value-dropdown-dropdown_str_method")).toHaveText("POST")`

**Critério de falha:**
- Campo URL não retém o valor digitado
- Dropdown não lista os métodos HTTP disponíveis

---

### 11.3 Executar request GET e verificar estrutura de output `[x]`

**Objetivo:** Verificar que o componente executa um GET e retorna o output Data com todos os campos obrigatórios.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas. URL: `"https://httpbin.org/get"`. Método padrão GET.

**Dado de teste:** URL `"https://httpbin.org/get"`

**Passo a passo:**
1. Preencher URL com `"https://httpbin.org/get"`.
2. Clicar em `button_run_api request` e aguardar toast `"built successfully"`.
3. Clicar em `output-inspection-api response-apirequest` para abrir o dialog.
4. Verificar os campos no output JSON.

**Validação (critérios mecânicos):**
- Output contém `"200"`, `"source"`, `"status_code"`, `"response_headers"`, `"result"`, `"httpbin.org"`, `'"url"'`

**Critério de falha:**
- Toast de erro ao executar
- Dialog de output não abre
- Algum campo estrutural ausente no output

---

### 11.4 Executar request POST e verificar verbo enviado `[x]`

**Objetivo:** Verificar que selecionar POST faz o componente enviar efetivamente o verbo POST (não GET).

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas.

**Dado de teste:** URL `"https://httpbin.org/post"` (retorna 405 para qualquer verbo diferente de POST) | Método: `"POST"`

**Passo a passo:**
1. Preencher URL com `"https://httpbin.org/post"`.
2. Alterar dropdown para `"POST"`.
3. Executar e abrir dialog de output.
4. Verificar `200` e `"httpbin.org/post"` no output.

**Validação (critérios mecânicos):**
- Output contém `"200"` e `"httpbin.org/post"`
- Sem campo `"error"` no output

**Critério de falha:**
- Status diferente de 200 (indicaria verbo incorreto enviado)

---

### 11.5 Resposta HTTP não-2xx propagada como status_code `[x]`

**Objetivo:** Verificar que o componente não lança exceção ao receber um status HTTP de erro — ele deve retornar o status_code no Data.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas.

**Dado de teste:** URL `"https://httpbin.org/status/404"`

**Passo a passo:**
1. Preencher URL com `"https://httpbin.org/status/404"`.
2. Executar e abrir dialog de output.
3. Verificar que o output contém `"404"` e `"source"`.
4. Verificar que o output **não** contém `'"error"'`.

**Validação (critérios mecânicos):**
- `expect(output).toContain("404")`
- `expect(output).toContain("source")`
- `expect(output).not.toContain('"error"')`

**Critério de falha:**
- Componente lança exceção (toast de erro de build)
- Output contém `'"error"'` ao invés de `"status_code": 404`

---

### 11.6 Query parameters embutidos na URL são enviados `[x]`

**Objetivo:** Verificar que query strings passadas diretamente na URL são incluídas na requisição e ecoadas na resposta.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas.

**Dado de teste:** URL `"https://httpbin.org/get?e2e_param=functional_test_value"`

**Passo a passo:**
1. Preencher URL com `"https://httpbin.org/get?e2e_param=functional_test_value"`.
2. Executar e abrir dialog de output.
3. Verificar que `"e2e_param"` e `"functional_test_value"` aparecem no output.

**Validação (critérios mecânicos):**
- `expect(output).toContain("e2e_param")`
- `expect(output).toContain("functional_test_value")`
- `expect(output).toContain("200")`

**Critério de falha:**
- Query params ausentes da resposta ecoada pelo httpbin

---

### 11.7 Erro de URL inválida exibe notificação descritiva `[x]`

**Objetivo:** Verificar que uma URL com formato inválido é aceita pelo campo mas rejeitada na execução com mensagem de erro clara.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas. `page.allowFlowErrors()` chamado.

**Dado de teste:** URL `"not-a-url"`

**Passo a passo:**
1. Preencher URL com `"not-a-url"` e confirmar que o campo aceita o valor.
2. Executar o componente.
3. Verificar toast `"Error building Component API Request:"`.
4. Verificar detalhe `"Invalid URL provided:"`.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("Error building Component API Request:")).toBeVisible()`
- `await expect(page.getByText("Invalid URL provided:")).toBeVisible()`
- Botão `button_run_api request` ainda visível após o erro

**Critério de falha:**
- Nenhuma notificação de erro exibida
- Componente crasha ou trava após URL inválida

---

### 11.8 Estado do flow é persistido no banco após autosave `[x]`

**Objetivo:** Verificar que o flow com o componente API Request é salvo automaticamente no banco de dados.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` adicionado ao canvas.

**Dado de teste:** Flow ID UUID extraído da URL do browser.

**Passo a passo:**
1. Adicionar componente `"API Request"` ao canvas.
2. Aguardar 4 segundos (debounce do autosave).
3. Buscar o flow via `GET /api/v1/flows/{flow_id}` com cookies de sessão.
4. Verificar que o nó `APIRequest` existe no array `data.nodes`.
5. Verificar que o campo `url_input` existe no template do nó.

**Validação (critérios mecânicos):**
- `flowData` não é null
- `nodes.find(n => n.data?.type === "APIRequest")` é definido
- `apiRequestNode.data.node.template.url_input` é definido

**Critério de falha:**
- Flow não encontrado no banco após aguardar autosave
- Nó APIRequest ausente no data.nodes

---

### 11.9 Executar request PUT `[-]`

**Objetivo:** Verificar que o verbo PUT é enviado quando selecionado.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas.

**Dado de teste:** URL `"https://httpbin.org/put"` | Método: `"PUT"`

**Critério de falha:** Status diferente de 200.

---

### 11.10 Executar request PATCH `[-]`

**Objetivo:** Verificar que o verbo PATCH é enviado quando selecionado.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas.

**Dado de teste:** URL `"https://httpbin.org/patch"` | Método: `"PATCH"`

**Critério de falha:** Status diferente de 200.

---

### 11.11 Executar request DELETE `[-]`

**Objetivo:** Verificar que o verbo DELETE é enviado quando selecionado.

**Pré-condição:** Usuário autenticado. Componente `"API Request"` no canvas.

**Dado de teste:** URL `"https://httpbin.org/delete"` | Método: `"DELETE"`

**Critério de falha:** Status diferente de 200.

---

### 11.12 Adicionar headers e body via inspector `[-]`

**Objetivo:** Verificar que o componente API Request aceita headers e body configurados via tabela key-value no inspector.

**Dado de teste:** Header: `Content-Type: application/json` | Body: `{"qa_test_key": "qa_body_value_001"}`

**Critério de falha:** Campos não aceitam digitação ou valores não persistem.

---

### 11.13 Tab cURL alterna modo e aceita comando `[-]`

**Objetivo:** Verificar que a tab cURL troca o modo de entrada e exibe o campo de texto para comando cURL.

**Dado de teste:** Comando: `curl https://httpbin.org/get`

**Critério de falha:** Tab cURL não exibe o campo de texto ou o handle `curl-left` não aparece.

---

### 11.14 Modo cURL executa GET e retorna 200 `[-]`

**Objetivo:** Verificar que um comando cURL no modo cURL é executado e retorna resposta válida.

**Dado de teste:** `curl https://httpbin.org/get`

**Critério de falha:** Toast de erro ao executar ou output não contém `"200"`.

---

---

## 12. Componentes Principais — Webhook

**Arquivos:** `core/unit/webhookComponent.spec.ts`, `core/features/webhook-component-regression.spec.ts`

---

### 12.1 Componente Webhook exibido no canvas `[-]`

**Objetivo:** Verificar que o componente Webhook é adicionado corretamente ao canvas com configurações padrão.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas vazio. Componente `"Webhook"` disponível na sidebar.

**Dado de teste:** Nenhum — apenas adicionar o componente ao canvas.

**Passo a passo:**
1. Digitar `"Webhook"` no campo `sidebar-search-input` da sidebar.
2. Localizar o componente `"Webhook"` nos resultados.
3. Dar duplo clique no componente para adicioná-lo ao canvas.
4. Verificar que o componente `"Webhook"` aparece no canvas.
5. Verificar que o componente exibe seus handles padrão (saída de dados).

**Validação (critérios mecânicos):**
- `await expect(page.locator('[data-testid="title-Webhook"]')).toBeVisible()` (ou seletor do título do componente)
- Handle de saída do componente Webhook visível no canvas
- Campo de URL do webhook visível no componente

**Casos negativos:**
- [ ] Buscar `"Webhook"` e componente não estar na lista → indica problema de registro do componente

**Critério de falha:**
- Componente Webhook não aparece nos resultados da busca
- Componente não é adicionado ao canvas após duplo clique
- Canvas não exibe o componente Webhook

---

### 12.2 URL de webhook gerada automaticamente `[-]`

**Objetivo:** Verificar que a URL do webhook é gerada automaticamente com o ID correto do flow.

**Pré-condição:** Usuário autenticado. Flow salvo com ID UUID disponível na URL do browser. Componente `"Webhook"` adicionado ao canvas (continuação do cenário 12.1).

**Dado de teste:** `flow_id` UUID do flow atual (extraído da URL do browser após salvar o flow).

**Passo a passo:**
1. Criar e salvar flow contendo componente `"Webhook"`.
2. Capturar o `flow_id` UUID da URL do browser.
3. Localizar o campo de URL do webhook no componente.
4. Verificar que o campo foi preenchido automaticamente.
5. Confirmar que a URL exibida contém o padrão `/api/v1/webhook/{flow_id}`.

**Validação (critérios mecânicos):**
- Campo de URL do webhook não está vazio
- URL do webhook contém `/api/v1/webhook/`
- URL do webhook contém o `flow_id` UUID exato do flow atual
- `webhookUrl.includes("/api/v1/webhook/" + flowId) === true`

**Casos negativos:**
- [ ] Flow não salvo (sem ID) → URL do webhook não deve ser gerada ou deve exibir placeholder

**Critério de falha:**
- Campo de URL do webhook vazio
- URL não contém `/api/v1/webhook/`
- UUID na URL do webhook difere do `flow_id` atual

---

---

## 13. Componentes Principais — Agent

**Arquivo:** `core/features/agent-component-regression.spec.ts`

---

### 13.1 Componente Agent exibido no canvas com configurações padrão `[-]`

**Objetivo:** Verificar que o componente Agent é adicionado ao canvas com todos os handles e campos padrão visíveis.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas vazio. Componente `"Agent"` disponível na sidebar.

**Dado de teste:** Nenhum — apenas adicionar o componente `"Agent"` ao canvas.

**Passo a passo:**
1. Digitar `"Agent"` no campo `sidebar-search-input` da sidebar.
2. Localizar o componente `"Agent"` nos resultados.
3. Dar duplo clique para adicionar ao canvas.
4. Verificar que o componente exibe os 3 handles principais.
5. Verificar que campos padrão estão visíveis.

**Validação (critérios mecânicos):**
- `await expect(page.locator('[data-testid="handle-agent-shownode-language model-left"]')).toBeVisible()`
- `await expect(page.locator('[data-testid="handle-agent-shownode-tools-left"]')).toBeVisible()`
- `await expect(page.locator('[data-testid="handle-agent-shownode-response-right"]')).toBeVisible()`
- Campos `max_iterations` e `system_prompt` visíveis no painel do componente

**Casos negativos:**
- [ ] Buscar `"Agent"` com letras erradas (ex: `"Agnt"`) → deve retornar `"Agent"` por busca fuzzy ou não retornar resultado

**Critério de falha:**
- Qualquer um dos 3 handles principais não está visível
- Campos `max_iterations` ou `system_prompt` ausentes no componente
- Componente não é adicionado ao canvas

---

---

## 14. Autenticação — Login e Logout

**Arquivos:** `core/features/auto-login-off.spec.ts`, `login-invalid-credentials.spec.ts`, `logout-flow.spec.ts`

---

### 14.1 Login com credenciais válidas `[-]`

**Objetivo:** Verificar que usuário com credenciais corretas acessa o sistema e é redirecionado para a home.

**Pré-condição:** Auto-login desabilitado (`LANGFLOW_AUTO_LOGIN=false`). Usuário `langflow` existe e está ativo.

**Dado de teste:** Username: `langflow` | Password: `langflow`

**Passo a passo:**
1. Navegar para `PLAYWRIGHT_BASE_URL`.
2. Verificar que o campo de username (`input[name="username"]`) está visível.
3. Preencher username com `"langflow"` e password com `"langflow"`.
4. Clicar no botão "Sign In".
5. Aguardar redirecionamento.
6. Verificar que `data-testid="mainpage_title"` está visível.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("mainpage_title")).toBeVisible()`
- URL não contém `/login` após autenticação

**Casos negativos:**
- [ ] Credenciais erradas → ver cenário 14.2

**Critério de falha:**
- `mainpage_title` não visível após clicar em Sign In
- URL permanece em `/login`
- Qualquer erro 4xx/5xx logado pelo monitor de backend

---

### 14.2 Login com credenciais inválidas `[-]`

**Objetivo:** Verificar que credenciais incorretas bloqueiam o acesso e exibem mensagem de erro.

**Pré-condição:** Auto-login desabilitado (`LANGFLOW_AUTO_LOGIN=false`). Tela de login visível.

**Dado de teste:** Username: `usuario-qa-invalido-001` | Password: `senha-qa-invalida-001`

**Passo a passo:**
1. Navegar para `PLAYWRIGHT_BASE_URL`.
2. Verificar que a tela de login está visível (`input[name="username"]` presente).
3. Preencher username com `"usuario-qa-invalido-001"` e password com `"senha-qa-invalida-001"`.
4. Clicar em "Sign In".
5. Verificar que a mensagem de erro `"Error signing in"` é exibida.
6. Verificar que o usuário permanece na tela de login (URL ainda contém `/login`).

**Validação (critérios mecânicos):**
- Texto `"Error signing in"` visível na interface
- `await expect(page.getByText("Error signing in")).toBeVisible()`
- URL ainda contém `/login` (não redirecionado para home)
- `await expect(page.getByTestId("mainpage_title")).not.toBeVisible()`

**Casos negativos:**
- [ ] Senha correta para usuário inexistente → mesmo comportamento (erro genérico, sem revelar que usuário não existe)

**Critério de falha:**
- Usuário é redirecionado para home com credenciais inválidas
- Mensagem de erro não exibida
- Mensagem revela se o usuário existe ou não (falha de segurança)

---

### 14.3 Logout redireciona para tela de login `[-]`

**Objetivo:** Verificar que o logout encerra a sessão e redireciona para a tela de login.

**Pré-condição:** Usuário `langflow` autenticado com sucesso. Página principal (`mainpage_title`) visível.

**Dado de teste:** Nenhum dado de entrada — ação de logout.

**Passo a passo:**
1. Autenticar com credenciais `langflow/langflow`.
2. Verificar que `mainpage_title` está visível.
3. Clicar no ícone de perfil (`user-profile-settings`).
4. Localizar e clicar em "Logout" no menu do perfil.
5. Aguardar redirecionamento.
6. Verificar que a tela de login é exibida (campo `input[name="username"]` visível).

**Validação (critérios mecânicos):**
- `await expect(page.locator('input[name="username"]')).toBeVisible()` após logout
- URL contém `/login` após logout
- `await expect(page.getByTestId("mainpage_title")).not.toBeVisible()`

**Casos negativos:**
- [ ] Tentar acessar URL autenticada após logout → deve redirecionar para login

**Critério de falha:**
- Usuário permanece na home após clicar em Logout
- URL não contém `/login` após logout
- Sessão não é encerrada (recarregar página ainda mostra home)

---

### 14.4 Auto-login ativado — pula tela de login `[-]`

**Objetivo:** Verificar que com `LANGFLOW_AUTO_LOGIN=true` o usuário acessa diretamente sem tela de login.

**Pré-condição:** `LANGFLOW_AUTO_LOGIN=true` configurado no servidor Langflow.

**Dado de teste:** Nenhum — navegação direta para `PLAYWRIGHT_BASE_URL`.

**Passo a passo:**
1. Navegar para `PLAYWRIGHT_BASE_URL` (com `LANGFLOW_AUTO_LOGIN=true` no servidor).
2. Aguardar carregamento completo da página.
3. Verificar que a tela de login NÃO é exibida (`input[name="username"]` não visível).
4. Verificar que a página principal carrega diretamente (`mainpage_title` visível).

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("mainpage_title")).toBeVisible()`
- `await expect(page.locator('input[name="username"]')).not.toBeVisible()`
- URL não contém `/login`

**Casos negativos:**
- [ ] Auto-login desabilitado → ver cenário 14.5

**Critério de falha:**
- Tela de login exibida mesmo com auto-login ativo
- `mainpage_title` não visível após navegar para a URL base
- Redirecionamento para `/login` com auto-login ativo

---

### 14.5 Auto-login desativado — exibe tela de login `[-]`

**Objetivo:** Verificar que quando auto-login falha ou está desabilitado, a tela de login é exibida obrigatoriamente.

**Pré-condição:** Teste usa mock do endpoint `GET /api/v1/auto_login` para retornar status `500`.

**Dado de teste:** Mock: `GET /api/v1/auto_login` → status `500`.

**Passo a passo:**
1. Interceptar requisição `GET /api/v1/auto_login` e forçar resposta `500`.
2. Navegar para `PLAYWRIGHT_BASE_URL`.
3. Aguardar carregamento.
4. Verificar que a tela de login é exibida com texto `"sign in to langflow"` (case insensitive).
5. Verificar que campo `input[name="username"]` está visível.

**Validação (critérios mecânicos):**
- `await expect(page.getByText(/sign in to langflow/i)).toBeVisible()`
- `await expect(page.locator('input[name="username"]')).toBeVisible()`
- URL contém `/login`

**Casos negativos:**
- [ ] Mock retornando `200` com dados válidos → auto-login bem-sucedido (ver cenário 14.4)

**Critério de falha:**
- Home page exibida mesmo com auto-login retornando 500
- Tela de login não exibe campo de username
- Texto `"sign in to langflow"` ausente na tela

---

### 14.6 Sessão expirada — redireciona para login `[-]`

**Objetivo:** Verificar que tentar uma ação autenticada com sessão expirada redireciona para login.

**Pré-condição:** Usuário `langflow` autenticado. Sessão simulada como expirada via mock (cookie/token inválido injetado via `page.context().addCookies()` ou `localStorage`).

**Dado de teste:** Token de sessão inválido/expirado injetado manualmente: `access_token_lf = "qa-expired-token-000"`

**Passo a passo:**
1. Autenticar com `langflow/langflow` e verificar home (`mainpage_title` visível).
2. Invalidar o token de sessão: sobrescrever `access_token_lf` no cookie ou localStorage com `"qa-expired-token-000"`.
3. Tentar realizar ação autenticada (ex: fazer `GET /api/v1/flows/` via navegação ou clicar em "New Flow").
4. Verificar que o sistema redireciona para a tela de login.

**Validação (critérios mecânicos):**
- `await expect(page.locator('input[name="username"]')).toBeVisible()` após ação com token inválido
- URL contém `/login` após tentativa de ação autenticada

**Casos negativos:**
- [ ] Token válido → ação autenticada executada sem redirecionamento

**Critério de falha:**
- Sistema permite ação autenticada com token inválido
- Nenhum redirecionamento para login ocorre
- Erro genérico exibido ao invés de redirecionamento para login

---

### 14.7 Limpeza de sessão após logout `[-]`

**Objetivo:** Verificar que os tokens de sessão são completamente removidos após o logout.

**Pré-condição:** Usuário `langflow` autenticado. Cookie `access_token_lf` presente e válido.

**Dado de teste:** Nenhum — verificação do estado dos cookies após logout.

**Passo a passo:**
1. Autenticar com `langflow/langflow`.
2. Verificar que o cookie `access_token_lf` está presente via `page.context().cookies()`.
3. Clicar em `user-profile-settings` → "Logout".
4. Após redirecionamento para login, verificar que o cookie `access_token_lf` foi removido.
5. Tentar navegar diretamente para URL autenticada (ex: `/flows/`) — deve redirecionar para `/login`.

**Validação (critérios mecânicos):**
- Cookie `access_token_lf` presente antes do logout
- Cookie `access_token_lf` ausente após logout: `cookies.find(c => c.name === "access_token_lf") === undefined`
- Navegação para URL autenticada após logout redireciona para `/login`

**Casos negativos:**
- [ ] Recarregar página após logout sem limpar cookies → deve permanecer na tela de login

**Critério de falha:**
- Cookie `access_token_lf` ainda presente após logout
- Acesso a URL autenticada bem-sucedido após logout (sessão não encerrada)
- Cookie de sessão mantém valor válido após logout

---

---

## 15. Gerenciamento de Usuários (Admin)

**Arquivo:** `core/features/admin-user-management.spec.ts`

---

### 15.1 Admin cria novo usuário `[-]`

**Objetivo:** Verificar que um admin pode criar um novo usuário e ele aparece na listagem.

**Pré-condição:** Usuário `langflow` (admin) autenticado. Página Admin acessível.

**Dado de teste:** Username: `qa-test-user-create-001` | Password: `QaTestPass001!`

**Passo a passo:**
1. Autenticar como admin (`langflow/langflow`).
2. Clicar em `user-profile-settings` → "Admin Page".
3. Clicar em "New User".
4. Preencher username `"qa-test-user-create-001"` e password `"QaTestPass001!"`.
5. Clicar em salvar.
6. Verificar que a mensagem de sucesso `"new user added"` é exibida.
7. Verificar que `"qa-test-user-create-001"` aparece na listagem de usuários.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("new user added")).toBeVisible()`
- `await expect(page.getByText("qa-test-user-create-001")).toBeVisible()` na listagem

**Casos negativos:**
- [ ] Criar usuário com username já existente → deve exibir erro de duplicidade

**Critério de falha:**
- Mensagem de sucesso não aparece
- `"qa-test-user-create-001"` não aparece na listagem após criar
- Erro 4xx/5xx logado pelo monitor de backend

---

### 15.2 Admin desativa usuário `[-]`

**Objetivo:** Verificar que desativar um usuário impede seu login.

**Pré-condição:** Admin autenticado. Usuário `"qa-test-user-create-001"` criado (continuação do cenário 15.1) e ativo.

**Dado de teste:** Usuário alvo: `qa-test-user-create-001`.

**Passo a passo:**
1. Na Admin Page, localizar `"qa-test-user-create-001"` na listagem.
2. Clicar no toggle `#is_active` do usuário para desativar.
3. Verificar que o toggle exibe estado inativo.
4. Tentar fazer login com `qa-test-user-create-001` / `QaTestPass001!`.
5. Verificar que o login falha com mensagem de erro.

**Validação (critérios mecânicos):**
- Toggle `#is_active` exibe estado `false`/desmarcado após clicar
- Tentativa de login com `qa-test-user-create-001` não redireciona para home
- `await expect(page.getByTestId("mainpage_title")).not.toBeVisible()` após tentativa de login

**Casos negativos:**
- [ ] Reativar usuário depois → login deve funcionar novamente (ver cenário 15.3)

**Critério de falha:**
- Toggle não muda de estado ao clicar
- Usuário desativado consegue autenticar e acessar a home
- Erro 4xx/5xx nos logs do admin ao desativar

---

### 15.3 Admin ativa usuário inativo `[-]`

**Objetivo:** Verificar que reativar um usuário permite seu login novamente.

**Pré-condição:** Admin autenticado. Usuário `"qa-test-user-create-001"` inativo (continuação do cenário 15.2).

**Dado de teste:** Usuário alvo: `qa-test-user-create-001` | Password: `QaTestPass001!`

**Passo a passo:**
1. Na Admin Page, localizar `"qa-test-user-create-001"` na listagem (estado: inativo).
2. Clicar no toggle `#is_active` para ativar.
3. Verificar que o toggle exibe estado ativo.
4. Fazer login com `qa-test-user-create-001` / `QaTestPass001!`.
5. Verificar que o login é bem-sucedido (`mainpage_title` visível).

**Validação (critérios mecânicos):**
- Toggle `#is_active` exibe estado `true`/marcado após clicar
- `await expect(page.getByTestId("mainpage_title")).toBeVisible()` após login com usuário reativado

**Casos negativos:**
- [ ] Ativar usuário que já está ativo → toggle não deve mudar e nenhum erro exibido

**Critério de falha:**
- Toggle não muda de estado ao clicar
- Login com usuário reativado falha
- `mainpage_title` não visível após login bem-sucedido

---

### 15.4 Admin renomeia usuário `[-]`

**Objetivo:** Verificar que um admin pode alterar o nome de exibição de um usuário.

**Pré-condição:** Admin autenticado. Usuário `"qa-test-user-create-001"` ativo e visível na Admin Page.

**Dado de teste:** Novo username: `qa-test-user-renamed-001`

**Passo a passo:**
1. Na Admin Page, localizar `"qa-test-user-create-001"`.
2. Clicar no ícone de edição `icon-Pencil` do usuário.
3. Alterar o username/nome de exibição para `"qa-test-user-renamed-001"`.
4. Clicar em salvar.
5. Verificar que a mensagem `"user edited"` é exibida.
6. Verificar que `"qa-test-user-renamed-001"` aparece na listagem no lugar do nome anterior.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("user edited")).toBeVisible()`
- `await expect(page.getByText("qa-test-user-renamed-001")).toBeVisible()` na listagem
- `await expect(page.getByText("qa-test-user-create-001")).not.toBeVisible()` (nome anterior removido)

**Casos negativos:**
- [ ] Salvar com campo de nome vazio → deve exibir erro de validação

**Critério de falha:**
- Mensagem `"user edited"` não aparece
- Nome anterior ainda aparece na listagem após salvar
- Novo nome não aparece na listagem

---

### 15.5 Admin altera senha de usuário `[-]`

**Objetivo:** Verificar que alterar a senha de um usuário invalida a senha anterior e ativa a nova.

**Pré-condição:** Admin autenticado. Usuário `"qa-test-user-renamed-001"` (renomeado no cenário 15.4) ativo com senha `"QaTestPass001!"`.

**Dado de teste:** Nova senha: `QaTestPassNew002!` | Senha antiga: `QaTestPass001!`

**Passo a passo:**
1. Na Admin Page, clicar em editar (`icon-Pencil`) para o usuário `"qa-test-user-renamed-001"`.
2. Localizar o campo de senha e inserir `"QaTestPassNew002!"`.
3. Salvar e verificar mensagem de sucesso.
4. Tentar login com `qa-test-user-renamed-001` / `QaTestPass001!` (senha antiga) → deve falhar.
5. Tentar login com `qa-test-user-renamed-001` / `QaTestPassNew002!` (senha nova) → deve funcionar.

**Validação (critérios mecânicos):**
- Login com senha antiga falha: `await expect(page.getByTestId("mainpage_title")).not.toBeVisible()`
- Login com senha nova bem-sucedido: `await expect(page.getByTestId("mainpage_title")).toBeVisible()`

**Casos negativos:**
- [ ] Senha nova muito curta (< 6 caracteres) → deve exibir erro de validação

**Critério de falha:**
- Login com senha antiga continua funcionando após alteração
- Login com nova senha falha
- Usuário consegue autenticar com qualquer senha após alteração (falha de segurança)

---

### 15.6 Isolamento: user A não vê flows de user B `[-]`

**Objetivo:** Verificar que flows criados por um usuário não são visíveis para outro usuário.

**Pré-condição:** 2 usuários distintos existem: `langflow` (admin) e `qa-test-user-renamed-001`. Ambos com acesso ao sistema.

**Dado de teste:** Flow criado pelo admin com nome `"qa-isolation-test-flow-userA-001"`.

**Passo a passo:**
1. Autenticar como `langflow` (admin).
2. Criar flow com nome `"qa-isolation-test-flow-userA-001"`.
3. Fazer logout.
4. Autenticar como `qa-test-user-renamed-001` / `QaTestPassNew002!`.
5. Verificar que `"qa-isolation-test-flow-userA-001"` NÃO aparece na listagem de flows.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-isolation-test-flow-userA-001")).not.toBeVisible()` quando logado como user B
- Listagem de flows do user B não contém nenhum flow do user A

**Casos negativos:**
- [ ] Verificar via API `GET /api/v1/flows/` como user B → deve não incluir flow de user A no array

**Critério de falha:**
- Flow do user A aparece na listagem do user B
- API retorna flows de outros usuários junto com os do usuário autenticado

---

---

## 16. Variáveis Globais (API Keys)

**Arquivo:** `core/features/globalVariables.spec.ts`, `global-variables-crud.spec.ts`

---

### 16.1 Criar variável global `[-]`

**Objetivo:** Verificar que uma variável global pode ser criada e aparece na listagem de Settings.

**Pré-condição:** Usuário autenticado. Página Settings → Global Variables acessível.

**Dado de teste:** Nome: `QA_GLOBAL_VAR_TEST_001` | Tipo: `Generic` | Valor: `qa-global-value-001`

**Passo a passo:**
1. Navegar para Settings (`menu_settings_button`) → Global Variables.
2. Clicar em "Add Variable" (ou botão equivalente).
3. Preencher nome com `"QA_GLOBAL_VAR_TEST_001"`, tipo `"Generic"` e valor `"qa-global-value-001"`.
4. Clicar em salvar.
5. Verificar que `"QA_GLOBAL_VAR_TEST_001"` aparece na listagem de variáveis globais.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("QA_GLOBAL_VAR_TEST_001")).toBeVisible()` na listagem
- Tipo exibido na listagem é `"Generic"`

**Casos negativos:**
- [ ] Criar variável com nome já existente → deve exibir erro de duplicidade ou sobrescrever (comportamento definido)
- [ ] Salvar sem nome → deve exibir erro de validação

**Critério de falha:**
- Variável não aparece na listagem após salvar
- Tipo exibido difere do selecionado
- Erro 4xx/5xx nos logs ao criar

---

### 16.2 Editar variável global existente `[-]`

**Objetivo:** Verificar que uma variável global existente pode ter seu valor atualizado.

**Pré-condição:** Usuário autenticado. Variável `"QA_GLOBAL_VAR_TEST_001"` criada no cenário 16.1 e visível na listagem.

**Dado de teste:** Novo valor: `qa-global-value-updated-001`

**Passo a passo:**
1. Na listagem de Global Variables, localizar `"QA_GLOBAL_VAR_TEST_001"`.
2. Clicar no ícone de edição da variável.
3. Alterar o valor para `"qa-global-value-updated-001"`.
4. Salvar.
5. Verificar que a variável ainda aparece na listagem (nome inalterado).

**Validação (critérios mecânicos):**
- `await expect(page.getByText("QA_GLOBAL_VAR_TEST_001")).toBeVisible()` após editar
- Nenhum erro de validação visível após salvar
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Salvar com valor vazio → deve exibir erro ou manter valor anterior

**Critério de falha:**
- Variável desaparece da listagem após editar
- Erro de validação ao tentar salvar valor válido
- Erro 4xx/5xx logado durante edição

---

### 16.3 Deletar variável global `[-]`

**Objetivo:** Verificar que uma variável global pode ser removida da listagem.

**Pré-condição:** Usuário autenticado. Variável `"QA_GLOBAL_VAR_TEST_001"` visível na listagem de Global Variables.

**Dado de teste:** Variável alvo: `QA_GLOBAL_VAR_TEST_001`

**Passo a passo:**
1. Na listagem de Global Variables, localizar `"QA_GLOBAL_VAR_TEST_001"`.
2. Clicar no ícone de deletar da variável.
3. Confirmar exclusão no diálogo de confirmação (se houver).
4. Verificar que `"QA_GLOBAL_VAR_TEST_001"` não aparece mais na listagem.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("QA_GLOBAL_VAR_TEST_001")).not.toBeVisible()` após deletar
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Cancelar confirmação de deleção → variável deve permanecer na listagem

**Critério de falha:**
- Variável ainda aparece na listagem após confirmar deleção
- Erro ao tentar deletar variável existente
- Confirmação de deleção não exibida (deleção sem confirmação)

---

### 16.4 Criar variável global do tipo "Generic" `[-]`

**Objetivo:** Verificar que variáveis do tipo "Generic" são criadas com tipo corretamente exibido.

**Pré-condição:** Usuário autenticado. Página Settings → Global Variables acessível. Nenhuma variável `"QA_GENERIC_TYPE_TEST_001"` pré-existente.

**Dado de teste:** Nome: `QA_GENERIC_TYPE_TEST_001` | Tipo: `Generic` | Valor: `qa-generic-value-001`

**Passo a passo:**
1. Navegar para Settings → Global Variables.
2. Clicar em "Add Variable".
3. Preencher nome `"QA_GENERIC_TYPE_TEST_001"`.
4. Selecionar tipo `"Generic"` no dropdown de tipo.
5. Preencher valor `"qa-generic-value-001"`.
6. Salvar.
7. Verificar que a variável aparece na listagem com tipo `"Generic"`.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("QA_GENERIC_TYPE_TEST_001")).toBeVisible()` na listagem
- Coluna de tipo da variável exibe `"Generic"` para a variável criada

**Casos negativos:**
- [ ] Selecionar tipo `"Credential"` → variável criada com tipo `"Credential"` (não `"Generic"`)

**Critério de falha:**
- Variável criada não aparece na listagem
- Tipo exibido difere de `"Generic"`
- Tipo não pode ser selecionado (dropdown de tipo não funciona)

---

---

## 17. File Upload e Processamento

**Arquivos:** `core/unit/fileUploadComponent.spec.ts`, `extended/features/files-page.spec.ts`

---

### 17.1 Upload de arquivo via componente `[-]`

**Objetivo:** Verificar que o componente de upload aceita arquivo e exibe o nome do arquivo após upload.

**Pré-condição:** Usuário autenticado. Flow aberto com componente `"File"` ou componente com suporte a upload no canvas. Arquivo `tests/assets/files/test_file.txt` disponível.

**Dado de teste:** Arquivo `tests/assets/files/test_file.txt` (arquivo de texto simples).

**Passo a passo:**
1. Adicionar componente `"File"` (ou componente com upload) ao canvas.
2. Localizar o botão de upload do componente.
3. Clicar no botão de upload e selecionar `tests/assets/files/test_file.txt` via file dialog.
4. Aguardar conclusão do upload.
5. Verificar que o nome `"test_file.txt"` aparece no componente após upload.

**Validação (critérios mecânicos):**
- Nome do arquivo `"test_file.txt"` visível no componente após upload
- Nenhum indicador de erro no componente
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Fazer upload de arquivo vazio (0 bytes) → deve exibir erro ou recusar

**Critério de falha:**
- Nome do arquivo não aparece após upload
- Indicador de erro exibido após selecionar arquivo válido
- Erro de backend durante o upload

---

### 17.2 Upload de arquivos de diferentes tipos `[-]`

**Objetivo:** Verificar que o componente aceita múltiplos formatos de arquivo sem erros.

**Pré-condição:** Usuário autenticado. Flow com componente `"File"` no canvas. Arquivos de teste disponíveis em `tests/assets/files/`.

**Dado de teste:**
- `tests/assets/files/test_file.txt` (texto simples)
- `tests/assets/files/test_file.pdf` (PDF)
- `tests/assets/files/test_data.json` (JSON)

**Passo a passo:**
1. Adicionar componente `"File"` ao canvas.
2. Fazer upload de `test_file.txt` → verificar que é aceito (nome exibido, sem erro).
3. Limpar o campo de upload (se necessário).
4. Fazer upload de `test_file.pdf` → verificar que é aceito.
5. Limpar e fazer upload de `test_data.json` → verificar que é aceito.

**Validação (critérios mecânicos):**
- Cada arquivo: nome exibido no componente após upload sem erro
- Nenhum indicador de erro de tipo de arquivo para `.txt`, `.pdf`, `.json`
- Nenhum erro 4xx/5xx logado pelo monitor de backend para nenhum dos uploads

**Casos negativos:**
- [ ] Upload de tipo não suportado (ex: `.exe`) → deve exibir erro de tipo inválido

**Critério de falha:**
- Qualquer um dos 3 tipos de arquivo rejeitado com erro
- Mensagem de tipo de arquivo inválido para `.txt`, `.pdf` ou `.json`
- Erro de backend durante upload de arquivo válido

---

### 17.3 Limite de tamanho de arquivo `[-]`

**Objetivo:** Verificar que arquivos acima do limite de tamanho são rejeitados com mensagem de erro.

**Pré-condição:** Usuário autenticado. Flow com componente `"File"` no canvas. Arquivo de teste com tamanho acima do limite configurado no servidor disponível (ou gerado dinamicamente com >100MB para testar).

**Dado de teste:** Arquivo sintético de 200MB gerado durante o teste (ou arquivo real grande disponível em `tests/assets/files/large_file_test.bin`).

**Passo a passo:**
1. Adicionar componente `"File"` ao canvas.
2. Tentar fazer upload de arquivo com tamanho acima do limite configurado (ex: 200MB).
3. Aguardar resposta do sistema.
4. Verificar que mensagem de erro sobre tamanho é exibida.
5. Verificar que o nome do arquivo de teste NÃO aparece como carregado no componente.

**Validação (critérios mecânicos):**
- Mensagem de erro de tamanho visível na interface após tentativa de upload
- Campo de arquivo no componente não exibe o nome do arquivo rejeitado
- Nenhum upload persistido (verificar via `GET /api/v1/files/` se aplicável)

**Casos negativos:**
- [ ] Arquivo abaixo do limite → deve ser aceito sem erro (ver cenário 17.1)

**Critério de falha:**
- Arquivo grande aceito sem erro (sem validação de tamanho)
- Nenhuma mensagem de erro exibida para arquivo acima do limite
- Sistema trava ou apresenta timeout sem mensagem de erro

---

---

## 18. Agentes LLM — Execução e Controle

**Arquivos:** `llm-agents/agent-component-regression.spec.ts`, `llm-agents/agent-reasoning-steps.spec.ts`, `llm-agents/memory-history-regression.spec.ts`

---

### 18.1 Agent com tool calling executa corretamente `[-]`

**Objetivo:** Verificar que o Agent consegue usar ferramentas para responder perguntas.

**Pré-condição:** Usuário autenticado. Flow com `"Agent"` + `"OpenAI"` (gpt-4o-mini) + `"API Request"` (Tool Mode) criado e configurado. API key OpenAI via variável global `OPENAI_API_KEY`. Componente `"API Request"` conectado ao handle `tools` do Agent. Componente `"OpenAI"` conectado ao handle `language model` do Agent.

**Dado de teste:** Mensagem: `"qa-agent-tool-test-001 — use the API Request tool to fetch https://httpbin.org/get and return the url field"` | URL da tool: `https://httpbin.org/get`

**Passo a passo:**
1. Criar flow: `"Agent"` + `"OpenAI"` (gpt-4o-mini) + `"API Request"` (Tool Mode, URL: `https://httpbin.org/get`, método: `GET`).
2. Conectar `"API Request"` ao handle `handle-agent-shownode-tools-left`.
3. Conectar `"OpenAI"` ao handle `handle-agent-shownode-language model-left`.
4. Abrir Playground (`playground-btn-flow-io`).
5. Enviar `"qa-agent-tool-test-001 — use the API Request tool to fetch https://httpbin.org/get and return the url field"`.
6. Aguardar resposta (botão Stop desaparece).
7. Verificar que o Agent retorna resposta visível no histórico do chat.

**Validação (critérios mecânicos):**
- Resposta do assistente visível no histórico após execução
- Resposta contém algum texto não-vazio
- Nenhum erro de execução 4xx/5xx logado pelo monitor de backend
- `await expect(page.locator('[data-testid="bot-message"]').last()).toBeVisible()`

**Casos negativos:**
- [ ] Tool não conectada ao Agent → Agent responde sem chamar tool (resposta genérica)

**Critério de falha:**
- Nenhuma resposta do assistente após enviar mensagem
- Erro de execução exibido no chat (ex: "Error running agent")
- Spinner de loading não desaparece (timeout > 60s)

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

**Objetivo:** Verificar que uma API key OpenAI pode ser configurada via variável global e selecionada no componente.

**Pré-condição:** Usuário autenticado. `OPENAI_API_KEY` disponível como string válida de API key OpenAI (ex: `sk-proj-...`).

**Dado de teste:** Nome da variável: `OPENAI_API_KEY` | Tipo: `Credential` | Valor: `sk-proj-qa-test-key-placeholder` (ou valor real do `.env`)

**Passo a passo:**
1. Navegar para Settings → Global Variables.
2. Criar variável `"OPENAI_API_KEY"` com tipo `"Credential"` e valor da API key.
3. Salvar e verificar que a variável aparece na listagem.
4. Adicionar componente `"OpenAI"` ao canvas.
5. Localizar o campo de API key do componente.
6. Verificar que `"OPENAI_API_KEY"` aparece como opção no dropdown do campo.
7. Selecionar `"OPENAI_API_KEY"` como valor do campo.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("OPENAI_API_KEY")).toBeVisible()` na listagem de Global Variables
- `"OPENAI_API_KEY"` aparece no dropdown de API key do componente `"OpenAI"`
- Campo de API key do componente exibe `"OPENAI_API_KEY"` após seleção

**Casos negativos:**
- [ ] Campo de API key vazio e componente executado → deve exibir erro de autenticação

**Critério de falha:**
- Variável `OPENAI_API_KEY` não aparece como opção no componente
- Campo de API key não aceita variável global como valor
- Erro 4xx/5xx logado ao salvar a variável

---

### 19.2 Selecionar modelo GPT (GPT-4o-mini) `[-]`

**Objetivo:** Verificar que o modelo `gpt-4o-mini` pode ser selecionado no componente OpenAI.

**Pré-condição:** Usuário autenticado. Flow com componente `"OpenAI"` no canvas. API key configurada (pode usar variável global do cenário 19.1).

**Dado de teste:** Modelo alvo: `gpt-4o-mini` (testid: `gpt-4o-mini-option`)

**Passo a passo:**
1. Adicionar componente `"OpenAI"` ao canvas.
2. Localizar o dropdown de seleção de modelo.
3. Clicar no dropdown para abrir as opções.
4. Selecionar `gpt-4o-mini` usando `data-testid="gpt-4o-mini-option"`.
5. Verificar que o dropdown exibe `"gpt-4o-mini"` como modelo selecionado.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("gpt-4o-mini-option")).toBeVisible()` (após abrir dropdown)
- Dropdown do componente exibe texto `"gpt-4o-mini"` após seleção

**Casos negativos:**
- [ ] API key inválida configurada → dropdown de modelo pode estar vazio (sem opções da API OpenAI)

**Critério de falha:**
- `gpt-4o-mini-option` não visível no dropdown
- Após seleção, dropdown exibe modelo diferente
- Dropdown de modelo não abre ao clicar

---

### 19.3 Selecionar modelo Claude `[-]`

**Objetivo:** Verificar que o modelo Claude pode ser selecionado no componente Anthropic.

**Pré-condição:** Usuário autenticado. Flow com componente `"Anthropic"` no canvas. `ANTHROPIC_API_KEY` configurada via variável global.

**Dado de teste:** Modelo alvo: `claude-sonnet-4-5-20250929` (ou testid equivalente `claude-sonnet-4-5-20250929-option`)

**Passo a passo:**
1. Adicionar componente `"Anthropic"` ao canvas.
2. Configurar API key Anthropic (variável global `ANTHROPIC_API_KEY`).
3. Localizar o dropdown de seleção de modelo.
4. Clicar no dropdown e selecionar `claude-sonnet-4-5-20250929`.
5. Verificar que o dropdown exibe `"claude-sonnet-4-5-20250929"` como modelo selecionado.

**Validação (critérios mecânicos):**
- Opção `claude-sonnet-4-5-20250929` (ou variante com testid específico) visível no dropdown
- Dropdown exibe `"claude-sonnet-4-5-20250929"` após seleção

**Casos negativos:**
- [ ] Componente Anthropic sem API key → dropdown de modelo pode estar vazio

**Critério de falha:**
- Opção de modelo Claude não aparece no dropdown
- Após seleção, dropdown exibe modelo diferente do selecionado
- Dropdown de modelo não abre

---

### 19.4 Trocar entre modelos Claude `[-]`

**Objetivo:** Verificar que é possível trocar entre diferentes modelos Claude no mesmo componente.

**Pré-condição:** Usuário autenticado. Componente `"Anthropic"` no canvas com API key `ANTHROPIC_API_KEY` configurada e modelo `claude-sonnet-4-5-20250929` selecionado (continuação do cenário 19.3).

**Dado de teste:** Modelos a testar: `claude-haiku-3-5-20251022` e `claude-opus-4-5` (ou equivalentes disponíveis na instância)

**Passo a passo:**
1. Com componente `"Anthropic"` configurado com `claude-sonnet-4-5-20250929`.
2. Abrir dropdown de modelo e selecionar `claude-haiku-3-5-20251022` (ou Haiku disponível).
3. Verificar que o dropdown exibe o modelo Haiku selecionado.
4. Abrir dropdown novamente e selecionar modelo Opus (se disponível).
5. Verificar que cada seleção é refletida no dropdown.

**Validação (critérios mecânicos):**
- Após selecionar Haiku: dropdown exibe texto contendo `"haiku"`
- Após selecionar Opus: dropdown exibe texto contendo `"opus"`
- Cada troca de modelo persiste no componente sem erro

**Casos negativos:**
- [ ] Selecionar modelo e recarregar página → modelo selecionado deve ser salvo pelo autosave

**Critério de falha:**
- Modelo Haiku ou Opus não aparece no dropdown
- Seleção de modelo não persiste (reverte para anterior)
- Erro de validação ao trocar de modelo

---

### 19.5 Erro de API key inválida `[-]` (mocked)

**Objetivo:** Verificar que API key inválida exibe mensagem de erro de autenticação ao usuário.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` → `"OpenAI"` → `"Chat Output"` criado. `page.allowFlowErrors()` chamado (erro de execução é esperado).

**Dado de teste:** API key inválida: `sk-qa-invalid-key-000000000000000` | Mensagem: `"qa-api-error-test-001"`

**Passo a passo:**
1. Criar flow `"Chat Input"` → `"OpenAI"` → `"Chat Output"`.
2. Configurar API key do componente `"OpenAI"` com valor `"sk-qa-invalid-key-000000000000000"` (diretamente no campo, sem variável global).
3. Chamar `page.allowFlowErrors()` para autorizar erros de execução no fixture.
4. Abrir Playground e enviar `"qa-api-error-test-001"`.
5. Aguardar resposta.
6. Verificar que mensagem de erro sobre API key inválida é exibida no chat ou como notificação.

**Validação (critérios mecânicos):**
- Mensagem de erro visível na interface (texto do erro ou notificação)
- Erro refere-se a autenticação/API key (não um erro genérico de rede)
- `page.allowFlowErrors()` deve ter sido chamado antes de executar

**Casos negativos:**
- [ ] API key válida → execução bem-sucedida sem erro (ver cenário 9.2)

**Critério de falha:**
- Nenhuma mensagem de erro exibida com API key inválida
- Erro exibido não menciona autenticação ou API key
- Sistema trava sem exibir erro

---

### 19.6 Modal "Manage Model Providers" `[-]`

**Objetivo:** Verificar que o modal de gerenciamento de providers abre, lista providers e permite configuração de API key.

**Pré-condição:** Usuário autenticado. Página principal (`mainpage_title`) visível. Botão de gerenciamento de providers acessível na interface.

**Dado de teste:** Provider alvo: `OpenAI` | API key de teste: `sk-proj-qa-modal-test-placeholder`

**Passo a passo:**
1. Na página principal ou editor, localizar e clicar no botão de gerenciamento de providers (ícone ou menu).
2. Verificar que modal `"Manage Model Providers"` abre.
3. Verificar que lista de providers contém ao menos `"OpenAI"` e `"Anthropic"`.
4. Clicar no provider `"OpenAI"` na lista.
5. Verificar que campo de API key para `"OpenAI"` fica disponível para edição.

**Validação (critérios mecânicos):**
- Modal com título `"Manage Model Providers"` visível após clicar no botão
- `await expect(page.getByText("Manage Model Providers")).toBeVisible()`
- Provider `"OpenAI"` visível na lista do modal
- Campo de API key visível ao selecionar `"OpenAI"`

**Casos negativos:**
- [ ] Fechar modal sem salvar → configuração não deve ser alterada

**Critério de falha:**
- Modal não abre ao clicar no botão
- Lista de providers vazia
- Provider `"OpenAI"` não aparece na lista
- Campo de API key não disponível após selecionar provider

---

---

## 20. Observabilidade — Traces e Notificações

**Arquivos:** `core/features/traces.spec.ts`, `traces-latency-tokens.spec.ts`, `execution-error-notification.spec.ts`

---

### 20.1 Visualizar traces de execução `[-]`

**Objetivo:** Verificar que execuções de flow são registradas e visíveis na seção de traces.

**Pré-condição:** Usuário autenticado. Flow de Chat executado ao menos uma vez (pode usar flow do cenário 9.1 ou 3.1). Seção de Traces/Logs acessível na interface.

**Dado de teste:** Flow `"qa-flow-observability-001"` executado com mensagem `"qa-trace-test-msg-001"`.

**Passo a passo:**
1. Criar e executar flow `"qa-flow-observability-001"` com mensagem `"qa-trace-test-msg-001"`.
2. Navegar para a seção de Traces (botão de logs/traces no editor ou menu).
3. Verificar que a execução aparece na lista de traces (identificada pelo flow ou timestamp).
4. Clicar no trace para expandir os detalhes.
5. Verificar que os detalhes são exibidos.

**Validação (critérios mecânicos):**
- Lista de traces contém ao menos 1 entrada após execução
- Entrada do trace contém referência ao flow `"qa-flow-observability-001"`
- Ao clicar no trace, painel de detalhes é exibido e não está vazio

**Casos negativos:**
- [ ] Nenhuma execução realizada → lista de traces vazia ou exibe mensagem `"No traces"`

**Critério de falha:**
- Lista de traces vazia após execução do flow
- Trace não aparece após execução
- Clicar no trace não expande detalhes

---

### 20.2 Trace exibe latência de cada componente `[-]`

**Objetivo:** Verificar que o detalhe do trace exibe a latência individual de cada componente do flow.

**Pré-condição:** Usuário autenticado. Trace de execução disponível (continuação do cenário 20.1). Painel de detalhes do trace aberto.

**Dado de teste:** Trace de execução do flow `"qa-flow-observability-001"` com ao menos 2 componentes (Chat Input e Chat Output).

**Passo a passo:**
1. Abrir detalhe do trace do cenário 20.1.
2. Verificar que a lista de componentes executados está visível.
3. Verificar que cada componente exibe um valor de latência (número + unidade de tempo, ex: `"0.12s"` ou `"120ms"`).

**Validação (critérios mecânicos):**
- Ao menos 2 entradas de componentes no detalhe do trace
- Cada entrada contém valor de latência no formato numérico com unidade de tempo
- Valor de latência é maior que `0` para cada componente

**Casos negativos:**
- [ ] Componente que não executou → latência deve ser `0` ou ausente

**Critério de falha:**
- Latência não exibida para nenhum componente
- Latência exibida como `0` para todos os componentes (indicaria ausência de medição)
- Detalhe do trace não lista componentes individualmente

---

### 20.3 Trace exibe tokens consumidos `[-]`

**Objetivo:** Verificar que o trace de execução com LLM exibe contagem de tokens consumidos.

**Pré-condição:** Usuário autenticado. Flow com LLM (OpenAI gpt-4o-mini) executado ao menos uma vez. Trace da execução disponível.

**Dado de teste:** Trace de execução do flow `"Chat Input"` → `"OpenAI"` → `"Chat Output"` com mensagem enviada.

**Passo a passo:**
1. Executar flow com componente `"OpenAI"` (gpt-4o-mini) e mensagem qualquer.
2. Abrir detalhe do trace da execução.
3. Localizar o componente `"OpenAI"` no detalhe do trace.
4. Verificar que campos de tokens estão presentes: `input_tokens`, `output_tokens` e/ou `total_tokens`.
5. Verificar que os valores são números positivos (`> 0`).

**Validação (critérios mecânicos):**
- Campo `input_tokens` visível no trace com valor `> 0`
- Campo `output_tokens` visível no trace com valor `> 0`
- Valores numéricos de tokens coerentes (ex: `input_tokens < 10000`, `output_tokens > 0`)

**Casos negativos:**
- [ ] Flow sem componente LLM → sem campos de tokens no trace

**Critério de falha:**
- Campos de tokens ausentes no trace de execução com LLM
- Valores de tokens zerados (sem medição)
- Trace não detalha o componente LLM individualmente

---

### 20.4 Notificação de erro de execução `[-]`

**Objetivo:** Verificar que erros de execução são exibidos como notificação com mensagem descritiva.

**Pré-condição:** Usuário autenticado. Flow com componente `"API Request"` com URL inválida criado. `page.allowFlowErrors()` chamado.

**Dado de teste:** URL inválida: `"https://this-domain-does-not-exist-qa-test-001.invalid"` | Método: `GET`

**Passo a passo:**
1. Criar flow com componente `"API Request"` com URL `"https://this-domain-does-not-exist-qa-test-001.invalid"` e método `"GET"`.
2. Chamar `page.allowFlowErrors()` no fixture.
3. Executar o flow (botão `button_run_flow` ou via Playground).
4. Aguardar conclusão.
5. Verificar que notificação de erro aparece na interface.
6. Verificar que a notificação contém mensagem descritiva (não vazia).

**Validação (critérios mecânicos):**
- Notificação de erro visível na interface após execução
- Texto da notificação não está vazio e menciona falha ou erro
- `await expect(page.locator('[data-testid="notification-error"]')).toBeVisible()` (ou seletor equivalente de notificação de erro)

**Casos negativos:**
- [ ] Flow com componentes válidos → nenhuma notificação de erro (ver cenário 9.1)

**Critério de falha:**
- Nenhuma notificação exibida após execução com erro
- Notificação exibida sem mensagem descritiva (texto vazio)
- Sistema trava sem exibir erro

---

---

## 21. Playground — Chat e Sessão

**Arquivos:** `core/features/playground-ux.spec.ts`, `playground-session-id.spec.ts`, `playground-history-persist.spec.ts`

---

### 21.1 Abrir Playground `[-]`

**Objetivo:** Verificar que o Playground abre corretamente com interface de chat pronta.

**Pré-condição:** Usuário autenticado. Flow de Chat (`"Chat Input"` → `"Chat Output"`) aberto no editor.

**Dado de teste:** Nenhum dado de entrada — apenas abertura do Playground.

**Passo a passo:**
1. Com flow de Chat aberto no editor.
2. Clicar no botão `playground-btn-flow-io`.
3. Aguardar abertura do painel do Playground.
4. Verificar que o campo de input `input-chat-playground` está visível.
5. Verificar que o botão de envio `button-send` está visível.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible()`
- `await expect(page.getByTestId("input-chat-playground")).toBeVisible()` após clicar
- `await expect(page.getByTestId("button-send")).toBeVisible()`

**Casos negativos:**
- [ ] Flow sem componente Chat Input/Output → Playground pode abrir mas sem campo de input

**Critério de falha:**
- Botão `playground-btn-flow-io` não visível no editor
- Painel do Playground não abre ao clicar
- Campo `input-chat-playground` não visível após abrir

---

### 21.2 Enviar mensagem e receber resposta `[-]`

**Objetivo:** Verificar que mensagem enviada no Playground resulta em resposta do assistente.

**Pré-condição:** Usuário autenticado. Playground aberto com flow de Chat funcional (continuação do cenário 21.1).

**Dado de teste:** Mensagem: `"qa-playground-send-test-001"`

**Passo a passo:**
1. Com Playground aberto (`input-chat-playground` visível).
2. Digitar `"qa-playground-send-test-001"` no campo `input-chat-playground`.
3. Clicar em `button-send`.
4. Aguardar resposta do assistente (elemento de mensagem do bot aparece).
5. Verificar que a resposta do assistente está visível no histórico do chat.

**Validação (critérios mecânicos):**
- Mensagem `"qa-playground-send-test-001"` visível no histórico após envio
- Mensagem de resposta do assistente visível no histórico
- `await expect(page.getByTestId("button-send")).toBeEnabled()` após resposta recebida (não em loading)

**Casos negativos:**
- [ ] Enviar mensagem vazia → ver cenário 21.3

**Critério de falha:**
- Mensagem enviada não aparece no histórico
- Nenhuma resposta do assistente após envio
- Botão `button-send` permanece em loading state indefinidamente

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

**Objetivo:** Verificar que alterar o session ID inicia uma nova conversa sem histórico da anterior.

**Pré-condição:** Usuário autenticado. Playground aberto com ao menos 1 mensagem enviada na sessão atual. Campo `chat-session-id` visível no Playground.

**Dado de teste:** Novo session ID: `qa-new-session-001`

**Passo a passo:**
1. Com Playground aberto e mensagem `"qa-playground-send-test-001"` no histórico.
2. Localizar o campo `chat-session-id` no Playground.
3. Limpar o campo e digitar `"qa-new-session-001"`.
4. Pressionar Enter ou confirmar a troca.
5. Verificar que o histórico de chat é limpo (mensagens anteriores não visíveis).
6. Enviar nova mensagem `"qa-new-session-msg-001"` e verificar que não há histórico da sessão anterior.

**Validação (critérios mecânicos):**
- Após trocar session ID, histórico de mensagens da sessão anterior não está visível
- `await expect(page.getByText("qa-playground-send-test-001")).not.toBeVisible()`
- `await expect(page.getByTestId("chat-session-id")).toHaveValue("qa-new-session-001")` (ou valor confirmado)

**Casos negativos:**
- [ ] Colocar o mesmo session ID anterior → deve restaurar o histórico da sessão anterior

**Critério de falha:**
- Mensagens da sessão anterior ainda visíveis após trocar session ID
- Campo `chat-session-id` não aceita o novo valor
- Histórico não é limpo após trocar sessão

---

### 21.5 Deletar mensagem individual do histórico `[-]`

**Objetivo:** Verificar que mensagens individuais podem ser deletadas do histórico do chat.

**Pré-condição:** Usuário autenticado. Playground aberto com ao menos 1 mensagem enviada no histórico.

**Dado de teste:** Mensagem `"qa-delete-msg-test-001"` presente no histórico.

**Passo a passo:**
1. Com Playground aberto, enviar mensagem `"qa-delete-msg-test-001"`.
2. Verificar que `"qa-delete-msg-test-001"` está visível no histórico.
3. Passar o mouse sobre a mensagem para exibir opções (hover).
4. Localizar e clicar no ícone de deletar da mensagem.
5. Confirmar exclusão se diálogo de confirmação aparecer.
6. Verificar que `"qa-delete-msg-test-001"` não está mais no histórico.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-delete-msg-test-001")).not.toBeVisible()` após deletar
- Restante do histórico permanece inalterado

**Casos negativos:**
- [ ] Cancelar deleção → mensagem deve permanecer no histórico

**Critério de falha:**
- Ícone de deletar não aparece ao passar mouse sobre mensagem
- Mensagem permanece no histórico após deletar
- Outras mensagens são incorretamente removidas

---

### 21.6 Histórico persiste ao reabrir Playground `[-]`

**Objetivo:** Verificar que o histórico do chat é preservado quando o Playground é fechado e reaberto.

**Pré-condição:** Usuário autenticado. Flow de Chat aberto no editor. Playground com ao menos 1 mensagem no histórico.

**Dado de teste:** Mensagem `"qa-persist-test-001"` enviada no Playground antes de fechar.

**Passo a passo:**
1. Abrir Playground e enviar `"qa-persist-test-001"`.
2. Verificar que `"qa-persist-test-001"` está no histórico.
3. Fechar o painel do Playground (clicar no botão de fechar ou clicar fora).
4. Verificar que o Playground está fechado.
5. Reabrir o Playground clicando em `playground-btn-flow-io`.
6. Verificar que `"qa-persist-test-001"` ainda está no histórico.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-persist-test-001")).toBeVisible()` após reabrir Playground
- Histórico completo preservado (número de mensagens igual ao de antes de fechar)

**Casos negativos:**
- [ ] Nova sessão após reabrir → histórico de sessão anterior preservado (acessível via session ID)

**Critério de falha:**
- Histórico vazio ao reabrir Playground
- Mensagem `"qa-persist-test-001"` não visível após reabrir
- Playground exibe sessão diferente da anterior ao reabrir

---

### 21.7 Modo fullscreen do Playground `[-]`

**Objetivo:** Verificar que o Playground pode ser expandido para fullscreen e mantém funcionalidade de chat.

**Pré-condição:** Usuário autenticado. Playground aberto em modo painel lateral.

**Dado de teste:** Mensagem de teste em fullscreen: `"qa-fullscreen-test-001"`

**Passo a passo:**
1. Abrir Playground (`playground-btn-flow-io`).
2. Localizar o botão de fullscreen no Playground (ícone de expansão).
3. Clicar no botão de fullscreen.
4. Verificar que o Playground ocupa a área principal da tela.
5. Digitar `"qa-fullscreen-test-001"` no campo de input e enviar.
6. Verificar que a mensagem aparece no histórico no modo fullscreen.

**Validação (critérios mecânicos):**
- Após clicar em fullscreen, Playground ocupa área maior que o painel lateral
- Campo `input-chat-playground` visível em modo fullscreen
- Mensagem `"qa-fullscreen-test-001"` visível no histórico após envio em fullscreen

**Casos negativos:**
- [ ] Sair do fullscreen (clicar no botão de colapsar) → Playground retorna ao modo painel lateral

**Critério de falha:**
- Botão de fullscreen não visível no Playground
- Playground não expande ao clicar em fullscreen
- Campo de input não funciona em modo fullscreen

---

---

## 22. Gerenciamento de Projetos e Pastas

**Arquivo:** `core/features/folders.spec.ts`, `folder-deletion-integrity.spec.ts`

---

### 22.1 Criar nova pasta `[-]`

**Objetivo:** Verificar que uma nova pasta pode ser criada e aparece na sidebar de projetos.

**Pré-condição:** Usuário autenticado. Página principal (`mainpage_title`) visível.

**Dado de teste:** Nome da pasta: `qa-folder-test-001`

**Passo a passo:**
1. Na página principal, localizar o botão "New Folder" (ou equivalente).
2. Clicar em "New Folder".
3. Digitar `"qa-folder-test-001"` como nome da pasta.
4. Confirmar criação (Enter ou botão de salvar).
5. Verificar que `"qa-folder-test-001"` aparece na sidebar ou listagem de projetos.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-folder-test-001")).toBeVisible()` na sidebar/listagem
- Pasta criada acessível via clique para exibir seu conteúdo (vazio)

**Casos negativos:**
- [ ] Criar pasta com nome vazio → deve exibir erro de validação

**Critério de falha:**
- Pasta não aparece na sidebar após criar
- Nome `"qa-folder-test-001"` não visível na listagem
- Erro de backend ao criar pasta

---

### 22.2 Renomear pasta `[-]`

**Objetivo:** Verificar que uma pasta pode ser renomeada e o novo nome aparece na listagem.

**Pré-condição:** Usuário autenticado. Pasta `"qa-folder-test-001"` criada (continuação do cenário 22.1) visível na listagem.

**Dado de teste:** Novo nome: `qa-folder-renamed-001`

**Passo a passo:**
1. Na listagem de projetos, localizar `"qa-folder-test-001"`.
2. Clicar no ícone de edição da pasta (ícone de lápis ou menu de contexto → "Rename").
3. Limpar o nome atual e digitar `"qa-folder-renamed-001"`.
4. Confirmar (Enter ou botão de salvar).
5. Verificar que `"qa-folder-renamed-001"` aparece na listagem.
6. Verificar que `"qa-folder-test-001"` não aparece mais.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-folder-renamed-001")).toBeVisible()`
- `await expect(page.getByText("qa-folder-test-001")).not.toBeVisible()`

**Casos negativos:**
- [ ] Confirmar sem alterar o nome → pasta mantém o nome original sem erro

**Critério de falha:**
- Nome antigo ainda aparece após renomear
- Novo nome não aparece após confirmar
- Erro ao tentar renomear

---

### 22.3 Deletar pasta vazia `[-]`

**Objetivo:** Verificar que uma pasta vazia pode ser deletada com sucesso.

**Pré-condição:** Usuário autenticado. Pasta `"qa-folder-empty-delete-001"` criada e vazia (sem flows).

**Dado de teste:** Pasta alvo: `qa-folder-empty-delete-001`

**Passo a passo:**
1. Criar pasta vazia `"qa-folder-empty-delete-001"`.
2. Verificar que a pasta aparece na listagem (sem conteúdo).
3. Clicar em deletar (ícone de lixeira ou menu de contexto → "Delete").
4. Confirmar exclusão no diálogo de confirmação.
5. Verificar que `"qa-folder-empty-delete-001"` não aparece mais na listagem.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-folder-empty-delete-001")).not.toBeVisible()` após deletar
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Cancelar confirmação de deleção → pasta mantida na listagem

**Critério de falha:**
- Pasta ainda aparece na listagem após confirmar deleção
- Diálogo de confirmação não exibido antes de deletar
- Erro ao deletar pasta vazia

---

### 22.4 Deletar pasta com flows dentro `[-]`

**Objetivo:** Verificar que deletar uma pasta com flows remove a pasta e todos os flows contidos.

**Pré-condição:** Usuário autenticado. Pasta `"qa-folder-with-flows-001"` criada com ao menos 1 flow `"qa-flow-in-folder-001"` dentro.

**Dado de teste:** Pasta `qa-folder-with-flows-001` contendo flow `qa-flow-in-folder-001`.

**Passo a passo:**
1. Criar pasta `"qa-folder-with-flows-001"` e flow `"qa-flow-in-folder-001"` dentro dela.
2. Verificar que ambos estão visíveis.
3. Clicar em deletar a pasta `"qa-folder-with-flows-001"`.
4. Confirmar a deleção (cascata ou alerta de confirmação).
5. Verificar que `"qa-folder-with-flows-001"` não aparece na listagem.
6. Verificar que `"qa-flow-in-folder-001"` também não aparece.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-folder-with-flows-001")).not.toBeVisible()` após deletar
- `await expect(page.getByText("qa-flow-in-folder-001")).not.toBeVisible()` após deletar
- Via API: `GET /api/v1/flows/` não retorna o flow deletado

**Casos negativos:**
- [ ] Cancelar confirmação → pasta e flows preservados

**Critério de falha:**
- Pasta deletada mas flows ainda aparecem na listagem
- Sistema não exibe diálogo de confirmação de deleção em cascata
- Erro de backend ao deletar pasta com conteúdo

---

### 22.5 Mover flow para outra pasta `[-]`

**Objetivo:** Verificar que um flow pode ser movido de uma pasta para outra.

**Pré-condição:** Usuário autenticado. Flow `"qa-flow-to-move-001"` na pasta `"qa-folder-source-001"`. Pasta `"qa-folder-destination-001"` criada.

**Dado de teste:** Flow alvo: `qa-flow-to-move-001` | Pasta origem: `qa-folder-source-001` | Pasta destino: `qa-folder-destination-001`

**Passo a passo:**
1. Criar pasta `"qa-folder-source-001"` com flow `"qa-flow-to-move-001"`.
2. Criar pasta `"qa-folder-destination-001"` vazia.
3. Selecionar `"qa-flow-to-move-001"` e usar opção "Move to Folder" (menu de contexto ou arraste).
4. Selecionar `"qa-folder-destination-001"` como pasta destino.
5. Verificar que `"qa-flow-to-move-001"` aparece em `"qa-folder-destination-001"`.
6. Verificar que `"qa-flow-to-move-001"` não aparece mais em `"qa-folder-source-001"`.

**Validação (critérios mecânicos):**
- `"qa-flow-to-move-001"` visível ao navegar para `"qa-folder-destination-001"`
- `"qa-flow-to-move-001"` ausente ao navegar para `"qa-folder-source-001"`

**Casos negativos:**
- [ ] Mover flow para a mesma pasta → sem erro, flow permanece no mesmo local

**Critério de falha:**
- Flow não aparece na pasta destino após mover
- Flow ainda aparece na pasta origem após mover
- Erro ao mover flow entre pastas

---

### 22.6 Pesquisar flow por nome `[-]`

**Objetivo:** Verificar que a busca na página principal filtra flows corretamente pelo nome.

**Pré-condição:** Usuário autenticado. Ao menos 2 flows existentes: `"qa-search-target-flow-001"` e `"qa-other-flow-002"`.

**Dado de teste:** Termo de busca: `"qa-search-target"` (parte do nome do flow alvo)

**Passo a passo:**
1. Criar flows `"qa-search-target-flow-001"` e `"qa-other-flow-002"` na página principal.
2. Localizar o campo de busca da página principal.
3. Digitar `"qa-search-target"` no campo de busca.
4. Verificar que `"qa-search-target-flow-001"` aparece nos resultados.
5. Verificar que `"qa-other-flow-002"` não aparece nos resultados.
6. Limpar o campo de busca.
7. Verificar que ambos os flows voltam a aparecer na listagem.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-search-target-flow-001")).toBeVisible()` com filtro ativo
- `await expect(page.getByText("qa-other-flow-002")).not.toBeVisible()` com filtro ativo
- Após limpar campo: ambos os flows visíveis novamente

**Casos negativos:**
- [ ] Buscar com termo que não corresponde a nenhum flow → listagem vazia ou mensagem "No results"

**Critério de falha:**
- Filtro não exclui flows que não correspondem ao termo
- Flow alvo não aparece nos resultados com filtro ativo
- Limpar campo não restaura a listagem completa

---

---

## 23. Templates e Starter Projects

**Arquivos:** `core/integrations/*.spec.ts`

---

### 23.1 Basic Prompting (OpenAI) `[-]`

**Objetivo:** Verificar que o template "Basic Prompting" carrega corretamente e executa com resposta do OpenAI.

**Pré-condição:** Usuário autenticado. `OPENAI_API_KEY` válida disponível. Template "Basic Prompting" disponível na galeria de templates.

**Dado de teste:** Mensagem: `"qa-basic-prompting-test-001 — respond with exactly: ACKNOWLEDGED"` | Modelo: `gpt-4o-mini`

**Passo a passo:**
1. Na página principal, navegar para "All Templates" ou "New Flow" → templates.
2. Selecionar template `"Basic Prompting"`.
3. Aguardar que o flow carregue no editor com componentes: `Chat Input`, `Prompt Template`, `OpenAI`, `Chat Output`.
4. Verificar que ao menos 3 componentes estão presentes no canvas.
5. Configurar API key `OPENAI_API_KEY` no componente `"OpenAI"` e selecionar modelo `gpt-4o-mini`.
6. Abrir Playground (`playground-btn-flow-io`).
7. Enviar `"qa-basic-prompting-test-001 — respond with exactly: ACKNOWLEDGED"`.
8. Verificar que resposta do assistente aparece no histórico.

**Validação (critérios mecânicos):**
- Canvas contém ao menos 3 nós após carregar template
- `await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible()`
- Resposta do assistente visível no histórico após envio
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Template carregado sem configurar API key → Playground exibe erro de autenticação (ver cenário 19.5)

**Critério de falha:**
- Template não carrega (canvas vazio ou erro)
- Menos de 3 componentes no canvas após carregar template
- Nenhuma resposta do assistente após envio de mensagem

---

### 23.2 Simple Agent (OpenAI) `[-]`

**Objetivo:** Verificar que o template "Simple Agent" carrega corretamente e o Agent retorna resposta.

**Pré-condição:** Usuário autenticado. `OPENAI_API_KEY` válida disponível. Template "Simple Agent" disponível na galeria.

**Dado de teste:** Mensagem: `"qa-simple-agent-test-001 — what is 2 plus 2?"` | Modelo: `gpt-4o-mini`

**Passo a passo:**
1. Navegar para templates e selecionar `"Simple Agent"`.
2. Aguardar que o flow carregue no editor com componente `"Agent"` e ferramentas padrão.
3. Verificar que ao menos 2 componentes estão presentes no canvas.
4. Configurar API key `OPENAI_API_KEY` e modelo `gpt-4o-mini`.
5. Abrir Playground (`playground-btn-flow-io`).
6. Enviar `"qa-simple-agent-test-001 — what is 2 plus 2?"`.
7. Aguardar resposta (botão Stop desaparece).
8. Verificar que resposta do assistente aparece no histórico.

**Validação (critérios mecânicos):**
- Canvas contém componente `"Agent"` após carregar template
- `await expect(page.getByTestId("playground-btn-flow-io")).toBeVisible()`
- Resposta do assistente visível no histórico (texto não vazio)
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Template carregado sem ferramentas → Agent responde sem tool calling (resposta direta)

**Critério de falha:**
- Template não carrega componente `"Agent"`
- Nenhuma resposta após enviar mensagem
- Erro de execução do Agent visível no chat

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

**Objetivo:** Verificar que o template "Vector Store RAG" carrega e retorna resposta baseada no documento carregado.

**Pré-condição:** Usuário autenticado. `OPENAI_API_KEY` válida disponível. Template "Vector Store RAG" disponível. Documento de teste `tests/assets/files/test_rag_document.txt` com conteúdo único disponível.

**Dado de teste:** Documento: `tests/assets/files/test_rag_document.txt` com texto `"The qa-rag-unique-fact-001 is that the sky color code is QA-BLUE-7734."` | Pergunta: `"What is the qa-rag-unique-fact-001?"` | Modelo: `gpt-4o-mini`

**Passo a passo:**
1. Navegar para templates e selecionar `"Vector Store RAG"`.
2. Aguardar que o flow carregue no editor.
3. Fazer upload do documento `test_rag_document.txt` no componente de ingestão.
4. Configurar embeddings (OpenAI, `OPENAI_API_KEY`) e vector store.
5. Abrir Playground e enviar `"What is the qa-rag-unique-fact-001?"`.
6. Aguardar resposta.
7. Verificar que a resposta contém `"QA-BLUE-7734"` (fato único do documento).

**Validação (critérios mecânicos):**
- Resposta do assistente visível no histórico
- Resposta contém `"QA-BLUE-7734"` (evidenciando que o documento foi indexado e consultado)
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Pergunta sobre conteúdo não presente no documento → resposta indica que informação não foi encontrada

**Critério de falha:**
- Template não carrega componentes de RAG
- Resposta não contém o fato único `"QA-BLUE-7734"`
- Erro de embedding ou vector store durante ingestão do documento

---

---

## 24. Flow — CRUD e Operações

**Arquivos:** `core/features/export-import-flow.spec.ts`, `flow-lock.spec.ts`, `run-flow.spec.ts`

---

### 24.1 Criar flow em branco `[-]`

**Objetivo:** Verificar que um flow em branco pode ser criado com canvas vazio.

**Pré-condição:** Usuário autenticado. Página principal visível.

**Dado de teste:** Nenhum — criação de flow em branco sem componentes.

**Passo a passo:**
1. Clicar em "New Flow" (ou botão equivalente) na página principal.
2. Selecionar `"Blank Flow"` (ou opção de flow vazio).
3. Aguardar abertura do editor.
4. Verificar que o canvas está vazio (sem componentes).
5. Verificar que os controles do canvas (`canvas_controls_dropdown`) estão visíveis.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible()` (ou seletor equivalente dos controles)
- Canvas não contém nenhum componente (nenhum nó visível)
- URL contém o ID do novo flow (UUID)

**Casos negativos:**
- [ ] Cancelar criação → retorna para página principal sem criar flow

**Critério de falha:**
- Canvas não abre após selecionar "Blank Flow"
- Canvas contém componentes pré-existentes (não está em branco)
- Controles do canvas não estão visíveis

---

### 24.2 Criar flow duplicando existente `[-]`

**Objetivo:** Verificar que duplicar um flow cria uma cópia com os mesmos componentes.

**Pré-condição:** Usuário autenticado. Flow `"qa-flow-to-duplicate-001"` com ao menos 1 componente existente na página principal.

**Dado de teste:** Flow alvo para duplicação: `qa-flow-to-duplicate-001`

**Passo a passo:**
1. Na página principal, localizar `"qa-flow-to-duplicate-001"`.
2. Clicar em "Duplicate" no menu do flow (ícone de cópia ou menu de contexto → "Duplicate").
3. Aguardar criação do novo flow.
4. Verificar que um novo flow com nome contendo `"(copy)"` ou `"qa-flow-to-duplicate-001 (copy)"` aparece na listagem.
5. Abrir o flow duplicado e verificar que contém os mesmos componentes do original.

**Validação (critérios mecânicos):**
- Novo flow com nome contendo `"(copy)"` visível na listagem
- `await expect(page.getByText(/qa-flow-to-duplicate-001.*copy/i)).toBeVisible()` (ou seletor equivalente)
- Canvas do flow duplicado contém o mesmo número de componentes que o original

**Casos negativos:**
- [ ] Duplicar flow sem permissão → deve exibir erro (não aplicável com auto-login)

**Critério de falha:**
- Nenhum novo flow criado após duplicar
- Flow duplicado não contém componentes do original
- Nome do flow duplicado não inclui `"(copy)"` ou identificador similar

---

### 24.3 Importar flow via JSON `[-]`

**Objetivo:** Verificar que um flow pode ser importado a partir de um arquivo JSON válido.

**Pré-condição:** Usuário autenticado. Arquivo JSON de flow válido disponível em `tests/assets/flows/basic-chat-flow.json`.

**Dado de teste:** Arquivo `tests/assets/flows/basic-chat-flow.json` (flow válido com Chat Input e Chat Output).

**Passo a passo:**
1. Na página principal ou editor, clicar em "Import" (ou menu → "Import Flow").
2. Selecionar arquivo `tests/assets/flows/basic-chat-flow.json` via file dialog.
3. Aguardar importação.
4. Verificar que o flow importado é exibido no editor.
5. Verificar que o canvas contém os componentes esperados do JSON.

**Validação (critérios mecânicos):**
- Flow importado visível no editor após importação
- Canvas contém ao menos 1 componente (não está vazio)
- `await expect(page.getByTestId("canvas_controls_dropdown")).toBeVisible()`
- Nenhum erro de importação exibido

**Casos negativos:**
- [ ] Importar JSON inválido → ver cenário 24.5

**Critério de falha:**
- Nenhum flow aberto após importação
- Canvas vazio após importar JSON com componentes
- Mensagem de erro ao importar JSON válido

---

### 24.4 Exportar flow como JSON `[-]`

**Objetivo:** Verificar que um flow pode ser exportado como arquivo JSON válido.

**Pré-condição:** Usuário autenticado. Flow `"qa-flow-export-test-001"` com ao menos 1 componente aberto no editor.

**Dado de teste:** Flow `qa-flow-export-test-001` com componente `"Chat Input"`.

**Passo a passo:**
1. Abrir flow `"qa-flow-export-test-001"` no editor.
2. Clicar em "Export" (menu ou botão equivalente no canvas).
3. Aguardar início do download.
4. Verificar que arquivo `.json` é baixado (ou conteúdo disponível para salvar).
5. Verificar que o arquivo JSON contém a estrutura esperada (`nodes`, `edges`, `id`).

**Validação (critérios mecânicos):**
- Download de arquivo com extensão `.json` iniciado
- Conteúdo do arquivo é JSON válido (parseable)
- JSON contém campo `data.nodes` (array)
- JSON contém campo `id` (UUID do flow)

**Casos negativos:**
- [ ] Flow vazio exportado → JSON exportado com `nodes: []` e `edges: []`

**Critério de falha:**
- Nenhum download iniciado ao clicar em Export
- Arquivo exportado não tem extensão `.json`
- Conteúdo do arquivo não é JSON válido

---

### 24.5 Importar JSON inválido — exibe erro `[-]`

**Objetivo:** Verificar que importar JSON inválido exibe erro descritivo sem criar flow inválido.

**Pré-condição:** Usuário autenticado. Arquivo JSON inválido disponível para upload.

**Dado de teste:** Arquivo `tests/assets/flows/invalid-flow.json` com conteúdo `{"invalid": true, "not_a_flow": "qa-invalid-content-001"}` (JSON parseable mas estrutura inválida de flow).

**Passo a passo:**
1. Na página principal ou editor, clicar em "Import".
2. Selecionar `tests/assets/flows/invalid-flow.json` (JSON com estrutura inválida).
3. Aguardar resposta do sistema.
4. Verificar que mensagem de erro é exibida.
5. Verificar que nenhum novo flow inválido aparece na listagem da página principal.

**Validação (critérios mecânicos):**
- Mensagem de erro visível na interface após tentar importar
- Número de flows na listagem não aumenta após tentativa de importação inválida
- Texto da mensagem de erro não está vazio

**Casos negativos:**
- [ ] Arquivo `.txt` renomeado para `.json` → mesmo comportamento (erro de estrutura)

**Critério de falha:**
- Nenhuma mensagem de erro exibida para JSON inválido
- Flow com estrutura inválida criado no sistema
- Erro 500 retornado ao invés de mensagem amigável ao usuário

---

### 24.6 Travar (lock) flow `[-]`

**Objetivo:** Verificar que travar o flow impede movimentação de componentes no canvas.

**Pré-condição:** Usuário autenticado. Flow com ao menos 1 componente aberto no editor. Botão de lock (`canvas_controls_dropdown` ou botão dedicado) visível.

**Dado de teste:** Componente `"Chat Input"` no canvas com posição registrada antes de travar.

**Passo a passo:**
1. Abrir flow com componente `"Chat Input"` no canvas.
2. Registrar a posição atual do componente.
3. Clicar no botão de lock/travar (`canvas_controls_dropdown` → "Lock" ou botão equivalente).
4. Verificar que indicação visual de flow travado está ativa.
5. Tentar arrastar o componente `"Chat Input"` para outra posição.
6. Verificar que a posição do componente não mudou.

**Validação (critérios mecânicos):**
- Indicação visual de lock ativo presente no canvas
- Posição do componente após tentativa de arrastar é igual à posição antes de travar
- `await expect(page.locator('[data-testid="lock-indicator"]')).toBeVisible()` (ou seletor equivalente)

**Casos negativos:**
- [ ] Destravar o flow → movimentação de componentes volta a funcionar

**Critério de falha:**
- Componente se move após travar o flow
- Nenhuma indicação visual de lock ativo
- Botão de lock não responde ao clique

---

### 24.7 Executar flow pelo botão Run `[-]`

**Objetivo:** Verificar que o botão Run inicia execução do flow e exibe resultados nos componentes.

**Pré-condição:** Usuário autenticado. Flow `"Chat Input"` → `"Chat Output"` aberto no editor. Componente `"Chat Input"` com `input_value = "qa-run-flow-test-001"` configurado.

**Dado de teste:** `input_value` do `"Chat Input"` configurado para `"qa-run-flow-test-001"`.

**Passo a passo:**
1. Abrir flow `"Chat Input"` (input_value: `"qa-run-flow-test-001"`) → `"Chat Output"`.
2. Clicar no botão `button_run_flow`.
3. Verificar que indicadores de loading aparecem nos componentes durante execução.
4. Aguardar conclusão da execução (indicadores desaparecem).
5. Verificar que resultados/outputs são exibidos nos componentes.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("button_run_flow")).toBeVisible()`
- Indicadores de loading visíveis durante execução
- Output exibido no componente `"Chat Output"` após execução
- Nenhum erro 4xx/5xx logado pelo monitor de backend

**Casos negativos:**
- [ ] Clicar em Run sem componentes no canvas → botão desabilitado ou erro exibido

**Critério de falha:**
- Botão `button_run_flow` não visível
- Execução não inicia ao clicar em Run
- Nenhum output exibido após execução concluída

---

### 24.8 Parar building do flow `[-]`

**Objetivo:** Verificar que a execução do flow pode ser interrompida pelo botão Stop.

**Pré-condição:** Usuário autenticado. Flow com execução longa (ou componente com delay) aberto no editor. `page.allowFlowErrors()` chamado pois interrupção pode gerar erro de execução.

**Dado de teste:** Flow com LLM (gpt-4o-mini) em execução.

**Passo a passo:**
1. Abrir flow com componente `"OpenAI"` (gpt-4o-mini) e API key configurada.
2. Clicar em `button_run_flow` para iniciar execução.
3. Enquanto a execução estiver em andamento (loading visível), clicar em `stop-building-button`.
4. Verificar que a execução para.
5. Verificar que o botão `button_run_flow` volta a estar disponível (não em loading).

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("stop-building-button")).toBeVisible()` durante execução
- Após clicar em Stop: `await expect(page.getByTestId("button_run_flow")).toBeVisible()` e habilitado
- Botão `stop-building-button` não visível após parar execução

**Casos negativos:**
- [ ] Clicar em Stop após execução já concluída → botão não visível (sem efeito)

**Critério de falha:**
- Botão `stop-building-button` não aparece durante execução
- Execução continua após clicar em Stop
- Botão `button_run_flow` não retorna para estado habilitado após parar

---

---

## 25. MCP — Client e Server

---

### 25.1 Aba MCP Server no flow `[-]`

**Objetivo:** Verificar que a aba "MCP Server" está acessível no editor de flow e exibe conteúdo relevante.

**Pré-condição:** Usuário autenticado. Flow aberto no editor. Funcionalidade MCP habilitada na instância Langflow.

**Dado de teste:** Flow `"qa-flow-mcp-test-001"` aberto no editor.

**Passo a passo:**
1. Abrir flow `"qa-flow-mcp-test-001"` no editor.
2. Localizar a aba "MCP Server" na interface do editor (tab ou seção lateral).
3. Clicar na aba "MCP Server".
4. Verificar que conteúdo relacionado a MCP é exibido (lista de tools, configurações, ou estado do server).

**Validação (critérios mecânicos):**
- Aba ou botão com texto "MCP Server" visível no editor
- `await expect(page.getByText("MCP Server")).toBeVisible()`
- Ao clicar na aba, conteúdo de MCP é exibido (painel não vazio)

**Casos negativos:**
- [ ] Instância sem MCP habilitado → aba pode não aparecer ou exibir mensagem de feature desabilitada

**Critério de falha:**
- Aba "MCP Server" não visível no editor
- Clicar na aba não exibe conteúdo (painel vazio ou erro)
- Erro 4xx/5xx ao acessar conteúdo da aba MCP

---

### 25.2 Adicionar MCP server via modal `[-]`

**Objetivo:** Verificar que um MCP server pode ser adicionado e aparece na listagem de configuração.

**Pré-condição:** Usuário autenticado. Configuração de MCP acessível (Settings → MCP ou similar). Nenhum servidor `"qa-mcp-server-001"` pré-existente.

**Dado de teste:** Nome: `qa-mcp-server-001` | URL/Comando: `http://localhost:8080/mcp` | Tipo: `HTTP`

**Passo a passo:**
1. Navegar para configuração de MCP (Settings ou aba MCP do editor).
2. Clicar em "Add MCP Server" (ou botão equivalente).
3. Preencher nome `"qa-mcp-server-001"` e URL `"http://localhost:8080/mcp"`.
4. Selecionar tipo de conexão `"HTTP"`.
5. Clicar em salvar.
6. Verificar que `"qa-mcp-server-001"` aparece na listagem de servidores MCP.

**Validação (critérios mecânicos):**
- `await expect(page.getByText("qa-mcp-server-001")).toBeVisible()` na listagem após adicionar
- Nenhum erro 4xx/5xx logado pelo monitor de backend ao adicionar

**Casos negativos:**
- [ ] Adicionar MCP server com URL inválida → deve exibir erro de validação

**Critério de falha:**
- `"qa-mcp-server-001"` não aparece na listagem após salvar
- Modal de adição não abre ao clicar no botão
- Erro ao salvar configuração do MCP server

---

### 25.3 Configurar conexão MCP client `[ ]`

**Objetivo:** Verificar que o componente MCP Client pode ser configurado e conectado a um MCP server.

**Pré-condição:** Usuário autenticado. Flow aberto no editor. MCP server `"qa-mcp-server-001"` configurado (continuação do cenário 25.2) ou servidor MCP local disponível em `http://localhost:8080/mcp`.

**Dado de teste:** Tipo de conexão: `HTTP` | URL: `http://localhost:8080/mcp` | Nome do server: `qa-mcp-server-001`

**Passo a passo:**
1. Adicionar componente `"MCP Client"` ao flow via sidebar.
2. No painel do componente, selecionar tipo de conexão `"HTTP"`.
3. Configurar URL `"http://localhost:8080/mcp"` ou selecionar `"qa-mcp-server-001"` da lista.
4. Salvar configuração.
5. Verificar que o componente não exibe indicador de erro de conexão.

**Validação (critérios mecânicos):**
- Componente `"MCP Client"` visível no canvas
- Campo de URL/comando preenchido com `"http://localhost:8080/mcp"`
- Nenhum indicador de erro de configuração visível no componente
- Nenhum erro 4xx/5xx logado ao salvar configuração

**Casos negativos:**
- [ ] URL de servidor MCP inativo → componente pode exibir aviso de conexão recusada ao executar

**Critério de falha:**
- Componente `"MCP Client"` não disponível na sidebar
- Indicador de erro de configuração visível após preencher campos válidos
- Erro ao adicionar componente ao canvas

---

---

## 26. UI/UX — Sidebar e Canvas

---

### 26.1 Pesquisar componente por nome `[-]`

**Objetivo:** Verificar que a busca na sidebar filtra componentes corretamente e limpa ao apagar o termo.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com sidebar visível.

**Dado de teste:** Termo de busca: `"OpenAI"` (componente que deve aparecer) | `"Chat"` (outro componente esperado)

**Passo a passo:**
1. Localizar o campo `sidebar-search-input` na sidebar.
2. Digitar `"OpenAI"` no campo.
3. Verificar que apenas componentes relacionados a `"OpenAI"` são exibidos (ex: `"OpenAI"`, `"OpenAI Embeddings"`).
4. Verificar que componentes não relacionados (ex: `"Anthropic"`) não estão visíveis.
5. Limpar o campo `sidebar-search-input` (apagar texto).
6. Verificar que todos os componentes voltam a ser exibidos.

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("sidebar-search-input")).toBeVisible()`
- Com filtro `"OpenAI"`: componente `"OpenAI"` visível, `"Anthropic"` não visível
- Após limpar campo: `"Anthropic"` volta a ser visível na sidebar

**Casos negativos:**
- [ ] Buscar termo sem resultados → sidebar exibe mensagem "No components found" ou lista vazia

**Critério de falha:**
- Campo `sidebar-search-input` não aceita digitação
- Filtro não remove componentes não correspondentes
- Limpar campo não restaura todos os componentes

---

### 26.2 Arrastar componente da sidebar para o canvas `[-]`

**Objetivo:** Verificar que componentes podem ser adicionados ao canvas via drag-and-drop da sidebar.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas vazio. Sidebar visível.

**Dado de teste:** Componente `"Chat Input"` da sidebar, arrastado para o centro do canvas.

**Passo a passo:**
1. Localizar componente `"Chat Input"` na sidebar (buscar se necessário).
2. Pressionar e segurar o mouse sobre o componente `"Chat Input"`.
3. Arrastar para a área central do canvas.
4. Soltar o mouse.
5. Verificar que o componente `"Chat Input"` aparece no canvas.

**Validação (critérios mecânicos):**
- Componente `"Chat Input"` visível no canvas após drag-and-drop
- `await expect(page.locator('[data-testid="title-Chat Input"]')).toBeVisible()` (ou seletor do título do componente)
- Canvas contém 1 componente após o drag

**Casos negativos:**
- [ ] Soltar componente fora do canvas (ex: sobre a sidebar) → componente não adicionado

**Critério de falha:**
- Componente não aparece no canvas após arrastar e soltar
- Drag cancela ao mover para o canvas (cursor incorreto)
- Componente aparece mas com erro de renderização

---

### 26.3 Duplo clique na sidebar adiciona componente `[-]`

**Objetivo:** Verificar que duplo clique em um componente da sidebar o adiciona ao canvas automaticamente.

**Pré-condição:** Usuário autenticado. Flow aberto com canvas vazio. Sidebar com componentes visível.

**Dado de teste:** Componente `"Chat Output"` na sidebar.

**Passo a passo:**
1. Localizar componente `"Chat Output"` na sidebar.
2. Dar duplo clique no componente `"Chat Output"`.
3. Verificar que o componente é adicionado ao canvas automaticamente (sem arrastar).

**Validação (critérios mecânicos):**
- Componente `"Chat Output"` visível no canvas após duplo clique
- `await expect(page.locator('[data-testid="title-Chat Output"]')).toBeVisible()` (ou seletor equivalente)
- Canvas contém o componente adicionado

**Casos negativos:**
- [ ] Simples clique (não duplo) → componente não adicionado (apenas selecionado/expandido na sidebar)

**Critério de falha:**
- Componente não é adicionado ao canvas após duplo clique
- Duplo clique abre dialog ou executa outra ação ao invés de adicionar
- Componente adicionado mas com erro de renderização no canvas

---

### 26.4 Conectar dois componentes compatíveis `[-]`

**Objetivo:** Verificar que dois componentes compatíveis podem ser conectados via handle no canvas.

**Pré-condição:** Usuário autenticado. Flow aberto com `"Chat Input"` e `"Chat Output"` no canvas (não conectados).

**Dado de teste:** Handle de saída de `"Chat Input"` (right side) conectado ao handle de entrada de `"Chat Output"` (left side).

**Passo a passo:**
1. Adicionar `"Chat Input"` e `"Chat Output"` ao canvas.
2. Localizar o handle de saída de `"Chat Input"` (lado direito do componente).
3. Clicar e arrastar do handle de saída do `"Chat Input"` até o handle de entrada do `"Chat Output"`.
4. Soltar o mouse sobre o handle de entrada do `"Chat Output"`.
5. Verificar que uma edge (linha de conexão) é criada entre os dois componentes.

**Validação (critérios mecânicos):**
- Edge visível conectando `"Chat Input"` ao `"Chat Output"` no canvas
- `await expect(page.locator('.react-flow__edge')).toBeVisible()` (ou seletor de edge)
- Edge não desaparece após soltar o mouse

**Casos negativos:**
- [ ] Tentar conectar handles do mesmo tipo (ex: saída → saída) → ver cenário 26.5

**Critério de falha:**
- Edge não é criada após arrastar entre handles compatíveis
- Conexão desaparece após soltar o mouse
- Cursor não indica possibilidade de conexão ao hover sobre handle destino

---

### 26.5 Impedir conexão entre tipos incompatíveis `[-]`

**Objetivo:** Verificar que o sistema impede conexão entre handles de tipos incompatíveis.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` e `"OpenAI"` no canvas. Handle de saída de texto (`Chat Input`) e handle de entrada de Language Model (`OpenAI → language model`) são de tipos diferentes.

**Dado de teste:** Tentativa de conectar handle `message` (saída de `Chat Input`) ao handle `language model` (entrada de `OpenAI`) — tipos incompatíveis.

**Passo a passo:**
1. Adicionar `"Chat Input"` e `"OpenAI"` ao canvas.
2. Localizar o handle de saída `message` de `"Chat Input"` (lado direito).
3. Tentar arrastar do handle `message` até o handle `language model` de `"OpenAI"`.
4. Verificar que a conexão não é estabelecida (edge não criada).
5. Verificar que o sistema impede visualmente a conexão (cursor de "não permitido" ou handle de destino não ilumina).

**Validação (critérios mecânicos):**
- Nenhuma edge criada após tentativa de conexão incompatível
- Número de edges no canvas permanece igual ao antes da tentativa
- `await expect(page.locator('.react-flow__edge')).toHaveCount(0)` (se canvas estava sem edges)

**Casos negativos:**
- [ ] Tipos compatíveis → conexão estabelecida normalmente (ver cenário 26.4)

**Critério de falha:**
- Edge criada entre tipos incompatíveis
- Sistema não exibe indicação visual de incompatibilidade ao tentar conectar

---

### 26.6 Deletar componente do canvas `[-]`

**Objetivo:** Verificar que um componente pode ser removido do canvas via tecla Delete.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` no canvas.

**Dado de teste:** Componente `"Chat Input"` presente no canvas.

**Passo a passo:**
1. Com `"Chat Input"` no canvas, clicar no componente para selecioná-lo.
2. Verificar que o componente está selecionado (borda de seleção visível).
3. Pressionar a tecla `Delete` (ou `Backspace`).
4. Verificar que o componente `"Chat Input"` foi removido do canvas.

**Validação (critérios mecânicos):**
- Componente `"Chat Input"` não visível no canvas após pressionar Delete
- `await expect(page.locator('[data-testid="title-Chat Input"]')).not.toBeVisible()`
- Canvas sem o componente deletado

**Casos negativos:**
- [ ] Pressionar Delete com componente não selecionado → nenhum componente removido
- [ ] Usar menu de contexto → "Delete" → mesmo comportamento (componente removido)

**Critério de falha:**
- Componente permanece no canvas após pressionar Delete
- Delete remove componente incorreto (outro que não estava selecionado)
- Canvas fica com estado inconsistente após deleção

---

### 26.7 Copiar e colar componente (Ctrl+C / Ctrl+V) `[-]`

**Objetivo:** Verificar que um componente pode ser copiado e colado no canvas.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` no canvas (1 componente).

**Dado de teste:** Componente `"Chat Input"` no canvas para copiar e colar.

**Passo a passo:**
1. Clicar no componente `"Chat Input"` para selecioná-lo.
2. Pressionar `Ctrl+C` (ou `Cmd+C` no Mac).
3. Clicar em área vazia do canvas.
4. Pressionar `Ctrl+V` (ou `Cmd+V` no Mac).
5. Verificar que um segundo componente `"Chat Input"` (cópia) aparece no canvas.

**Validação (critérios mecânicos):**
- Canvas contém 2 instâncias de `"Chat Input"` após colar
- `await expect(page.locator('[data-testid="title-Chat Input"]')).toHaveCount(2)`
- A cópia tem `id` diferente do original

**Casos negativos:**
- [ ] Colar sem copiar antes → nenhum componente adicionado

**Critério de falha:**
- Apenas 1 componente no canvas após colar (cópia não criada)
- Componente colado tem o mesmo `id` do original (duplicidade de ID)
- Erro ao colar componente

---

### 26.8 Selecionar múltiplos componentes via box selection `[-]`

**Objetivo:** Verificar que múltiplos componentes podem ser selecionados usando box selection.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` e `"Chat Output"` no canvas, posicionados próximos.

**Dado de teste:** `"Chat Input"` e `"Chat Output"` no canvas para selecionar via box.

**Passo a passo:**
1. Adicionar `"Chat Input"` e `"Chat Output"` ao canvas próximos um ao outro.
2. Clicar em área vazia do canvas (sem componentes) e segurar o mouse.
3. Arrastar para criar caixa de seleção que cubra ambos os componentes.
4. Soltar o mouse.
5. Verificar que ambos os componentes estão selecionados (borda de seleção em ambos).

**Validação (critérios mecânicos):**
- Ambos os componentes exibem borda de seleção após box selection
- `await expect(page.locator('.selected')).toHaveCount(2)` (ou seletor de elementos selecionados)
- Pressionar Delete remove ambos os componentes

**Casos negativos:**
- [ ] Box selection que não cobre nenhum componente → nenhum componente selecionado

**Critério de falha:**
- Apenas 1 componente selecionado após box selection que cobre 2
- Box selection não inicia ao clicar em área vazia
- Nenhum componente selecionado após arrastar a box

---

### 26.9 Minimizar componente no canvas `[-]`

**Objetivo:** Verificar que um componente pode ser minimizado e expandido no canvas.

**Pré-condição:** Usuário autenticado. Flow com `"OpenAI"` no canvas (componente com vários campos visíveis).

**Dado de teste:** Componente `"OpenAI"` no canvas para minimizar.

**Passo a passo:**
1. Com componente `"OpenAI"` no canvas (expandido com campos visíveis).
2. Localizar o botão de minimizar do componente (ícone de seta ou chevron).
3. Clicar no botão de minimizar.
4. Verificar que o componente exibe versão minimizada (apenas header visível, campos ocultos).
5. Clicar novamente no botão para expandir.
6. Verificar que o componente volta ao tamanho original com campos visíveis.

**Validação (critérios mecânicos):**
- Após minimizar: campos internos do componente não visíveis (apenas título visível)
- Após expandir: campos internos do componente visíveis novamente
- Handles do componente permanecem visíveis em ambos os estados

**Casos negativos:**
- [ ] Tentar conectar handle de componente minimizado → deve funcionar normalmente

**Critério de falha:**
- Botão de minimizar não visível no componente
- Componente não muda visualmente ao clicar em minimizar
- Após expandir, campos não são restaurados ao estado anterior

---

### 26.10 Zoom in / Zoom out / Fit View `[-]`

**Objetivo:** Verificar que controles de zoom e fit view funcionam corretamente no canvas.

**Pré-condição:** Usuário autenticado. Flow com ao menos 1 componente no canvas. Controles de zoom visíveis.

**Dado de teste:** Componente `"Chat Input"` no canvas como referência visual.

**Passo a passo:**
1. Verificar o nível de zoom inicial do canvas.
2. Clicar no botão Zoom In (ícone `+`) — verificar que a escala do canvas aumenta.
3. Clicar no botão Zoom Out (ícone `-`) — verificar que a escala diminui.
4. Pressionar `Ctrl+Shift+H` ou clicar em "Fit View" — verificar que o canvas centraliza o(s) componente(s).

**Validação (critérios mecânicos):**
- Após Zoom In: elementos no canvas parecem maiores (escala aumentou)
- Após Zoom Out: elementos parecem menores (escala diminuiu)
- Após Fit View: todos os componentes estão visíveis no viewport
- `await expect(page.locator('[data-testid="title-Chat Input"]')).toBeVisible()` após Fit View

**Casos negativos:**
- [ ] Zoom Out máximo → canvas atinge limite mínimo de zoom (botão desabilitado ou sem mais zoom)

**Critério de falha:**
- Zoom In não aumenta visualmente o canvas
- Zoom Out não diminui visualmente o canvas
- Fit View não centraliza ou não exibe todos os componentes

---

### 26.11 Criar e desfazer agrupamento `[-]`

**Objetivo:** Verificar que componentes podem ser agrupados e desagrupados preservando suas configurações.

**Pré-condição:** Usuário autenticado. Flow com `"Chat Input"` e `"Chat Output"` no canvas (não conectados).

**Dado de teste:** `"Chat Input"` e `"Chat Output"` selecionados para agrupar.

**Passo a passo:**
1. Selecionar `"Chat Input"` e `"Chat Output"` via box selection (ver cenário 26.8).
2. Clicar com botão direito nos componentes selecionados → "Group".
3. Verificar que um componente de grupo é criado no canvas.
4. Verificar que os componentes individuais são substituídos pelo grupo.
5. Clicar com botão direito no grupo → "Ungroup".
6. Verificar que os componentes `"Chat Input"` e `"Chat Output"` são restaurados individualmente.

**Validação (critérios mecânicos):**
- Após agrupar: componente de grupo visível, componentes individuais substituídos
- Após desagrupar: `await expect(page.locator('[data-testid="title-Chat Input"]')).toBeVisible()`
- Após desagrupar: `await expect(page.locator('[data-testid="title-Chat Output"]')).toBeVisible()`

**Casos negativos:**
- [ ] Tentar agrupar com apenas 1 componente → opção "Group" desabilitada

**Critério de falha:**
- Opção "Group" não disponível no menu de contexto
- Componentes individuais ainda visíveis após agrupar (não foram substituídos pelo grupo)
- Após desagrupar, componentes originais não são restaurados

---

### 26.12 Congelar componente (Freeze) `[-]`

**Objetivo:** Verificar que um componente congelado usa cache e não reexecuta em nova execução.

**Pré-condição:** Usuário autenticado. Flow `"Chat Input"` → `"Chat Output"` aberto no editor. Componente com opção "Freeze" disponível.

**Dado de teste:** Componente `"Chat Output"` para congelar.

**Passo a passo:**
1. Com flow `"Chat Input"` → `"Chat Output"` aberto.
2. Localizar a opção "Freeze" no componente `"Chat Output"` (menu de contexto ou botão no header).
3. Clicar em "Freeze".
4. Verificar que indicação visual de congelado está ativa (ícone de snowflake ou borda azul).
5. Executar o flow (`button_run_flow`).
6. Verificar que o componente congelado exibe indicação de uso de cache (não reexecutou).

**Validação (critérios mecânicos):**
- Indicação visual de freeze ativo presente no componente após clicar em "Freeze"
- Componente congelado exibe badge ou ícone de "frozen" / "cached"
- `await expect(page.locator('[data-testid*="frozen"]')).toBeVisible()` (ou seletor equivalente)

**Casos negativos:**
- [ ] Descongelar (Unfreeze) e executar → componente reexecuta normalmente

**Critério de falha:**
- Opção "Freeze" não disponível no componente
- Nenhuma indicação visual de freeze ativo
- Componente congelado reexecuta na próxima execução (não usa cache)

---

### 26.13 Adicionar e deletar sticky note `[-]`

**Objetivo:** Verificar que sticky notes podem ser adicionadas e removidas do canvas.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas visível.

**Dado de teste:** Nenhum dado de entrada — apenas ação de adicionar e deletar nota.

**Passo a passo:**
1. Clicar com botão direito em área vazia do canvas.
2. Selecionar "Add Note" no menu de contexto.
3. Verificar que uma sticky note aparece no canvas.
4. Clicar na sticky note para selecioná-la.
5. Pressionar `Delete`.
6. Verificar que a sticky note foi removida do canvas.

**Validação (critérios mecânicos):**
- Sticky note visível no canvas após "Add Note"
- Sticky note não visível após pressionar Delete
- `await expect(page.locator('[data-testid="note-node"]')).not.toBeVisible()` após deletar (ou seletor equivalente)

**Casos negativos:**
- [ ] Pressionar Delete sem selecionar a nota → nota não removida

**Critério de falha:**
- Opção "Add Note" não disponível no menu de contexto
- Sticky note não aparece após selecionar "Add Note"
- Sticky note permanece no canvas após pressionar Delete

---

### 26.14 Mudar cor da sticky note `[-]`

**Objetivo:** Verificar que a cor de uma sticky note pode ser alterada via seletor de cor.

**Pré-condição:** Usuário autenticado. Flow com ao menos uma sticky note no canvas (criada no cenário 26.13 ou nova).

**Dado de teste:** Cor alvo: azul (ou primeira opção diferente da cor padrão).

**Passo a passo:**
1. Com sticky note no canvas, clicar na nota para selecioná-la.
2. Localizar o seletor de cor da sticky note (aparece no header ou barra de opções da nota).
3. Clicar em uma cor diferente da cor padrão (ex: azul).
4. Verificar que a cor da sticky note muda para a cor selecionada.

**Validação (critérios mecânicos):**
- Cor de fundo da sticky note muda visualmente após selecionar nova cor
- A cor selecionada é visível como fundo ou borda da nota
- Seletor de cor exibe a cor atual da nota após seleção

**Casos negativos:**
- [ ] Selecionar a cor atual (mesma cor) → sem mudança visual

**Critério de falha:**
- Seletor de cor não visível ao selecionar sticky note
- Cor da nota não muda após selecionar nova cor
- Cor muda mas reverte ao padrão após deselecionar a nota

---

### 26.15 Menu de contexto por right-click no canvas `[-]`

**Objetivo:** Verificar que o menu de contexto abre com opções corretas ao clicar com botão direito no canvas.

**Pré-condição:** Usuário autenticado. Flow aberto no editor com canvas visível.

**Dado de teste:** Nenhum — ação de right-click em área vazia do canvas.

**Passo a passo:**
1. Localizar área vazia do canvas (sem componentes).
2. Clicar com botão direito na área vazia.
3. Verificar que menu de contexto abre.
4. Verificar que o menu contém ao menos as opções: "Add Note" e "Paste" (ou equivalentes).

**Validação (critérios mecânicos):**
- Menu de contexto visível após right-click
- `await expect(page.getByText("Add Note")).toBeVisible()` no menu
- Menu fecha ao pressionar `Escape` ou clicar fora

**Casos negativos:**
- [ ] Right-click sobre um componente → menu de contexto do componente (diferente do canvas)

**Critério de falha:**
- Menu de contexto não abre ao right-click no canvas
- Menu abre mas não contém opção "Add Note"
- Menu não fecha ao pressionar Escape

---

### 26.16 Acessar página de Settings `[-]`

**Objetivo:** Verificar que a página de Settings é acessível e carrega com todas as abas esperadas.

**Pré-condição:** Usuário autenticado. Página principal ou editor visível.

**Dado de teste:** Nenhum — navegação para Settings via menu de perfil.

**Passo a passo:**
1. Clicar no ícone de perfil `user-profile-settings`.
2. Clicar em `menu_settings_button` (ou texto "Settings") no menu.
3. Aguardar carregamento da página de Settings.
4. Verificar que a página carrega com ao menos as abas: "General", "Global Variables" (e/ou outras abas configuradas).

**Validação (critérios mecânicos):**
- `await expect(page.getByTestId("user-profile-settings")).toBeVisible()`
- `await expect(page.getByTestId("menu_settings_button")).toBeVisible()` após clicar no perfil
- Página de Settings carrega com ao menos 2 abas visíveis
- Aba "Global Variables" visível na página de Settings

**Casos negativos:**
- [ ] Clicar em Settings sem estar autenticado → redirecionado para login

**Critério de falha:**
- `user-profile-settings` não visível
- `menu_settings_button` não visível após clicar no perfil
- Página de Settings não carrega (erro ou página em branco)
- Abas de Settings não visíveis após carregar

---

### 26.17 Alterar configurações de aparência/tema `[-]`

**Objetivo:** Verificar que o tema da interface (Dark/Light) pode ser alterado via Settings.

**Pré-condição:** Usuário autenticado. Página de Settings acessível. Estado inicial do tema: Dark mode (ou Light mode — anotar o estado atual).

**Dado de teste:** Alternância do tema a partir do estado inicial (ex: Dark → Light).

**Passo a passo:**
1. Navegar para Settings (`menu_settings_button`).
2. Localizar o toggle ou seletor de tema (Dark/Light mode) na seção de aparência.
3. Verificar o estado atual do tema (ex: Dark mode ativo).
4. Clicar no toggle para alternar (ex: Dark → Light).
5. Verificar que o tema da interface muda (fundo de cor diferente, ou indicador de tema atual).

**Validação (critérios mecânicos):**
- Toggle/seletor de tema visível na página de Settings
- Após alternar: `body` ou elemento principal exibe classe ou atributo de tema diferente (ex: `class="light"` ao invés de `class="dark"`)
- Mudança visual perceptível no fundo da interface (escuro → claro ou vice-versa)

**Casos negativos:**
- [ ] Clicar novamente → tema retorna ao estado original

**Critério de falha:**
- Toggle de tema não visível nas Settings
- Clicar no toggle não altera o tema visualmente
- Tema revertido ao recarregar a página (não persistido)

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
