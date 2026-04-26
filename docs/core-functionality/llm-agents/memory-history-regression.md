# Memory Chatbot — Regressão de Histórico e Memória

**Última validação:** Langflow 1.10.x

---

## O que este teste valida *(obrigatório)*

Valida o comportamento core do template **Memory Chatbot**: carregamento da estrutura do flow, retenção de contexto entre mensagens dentro da mesma sessão do Playground, persistência do histórico após fechar e reabrir o Playground, e isolamento de sessão (sessões distintas têm históricos independentes). Se qualquer um desses testes falhar, o Memory Chatbot está quebrado para uso real.

---

## Tags *(obrigatório)*

`@stable` `@release` `@agents` `@playground`

---

## Passo a passo *(obrigatório)*

O spec contém **3 testes** dentro de `test.describe("Memory Chatbot Regression")`.

---

**Teste 1 — memory chatbot template loads with correct node structure**

Não requer API key. Valida somente a estrutura do canvas.

1. Apagar flows existentes e carregar o template "Memory Chatbot" em `All Templates`
2. Aguardar `canvas_controls_dropdown` aparecer; ajustar view e atualizar componentes
3. *Step: canvas has all 6 required nodes* — `expect.soft` para cada um dos 6 `title-*`:
   - `title-Chat Input`, `title-Chat Output`, `title-Message History`
   - `title-OpenAI`, `title-Prompt Template`, `title-Type Convert`
4. *Step: canvas has exactly 6 nodes* — contar `.react-flow__node` e verificar `=== 6`

---

**Teste 2 — message history context retention suite**

Requer `OPENAI_API_KEY`. Agrupa as validações de comportamento em `test.step` com `expect.soft`.

1. Carregar o template Memory Chatbot e configurar `OPENAI_API_KEY` no campo `popover-anchor-input-api_key` do nó OpenAI
2. Abrir o Playground (`playground-btn-flow-io`) e aguardar `input-chat-playground`
3. *Step: context retention* — Enviar `"My name is Alice..."`, aguardar resposta, enviar `"What is my name?"` e verificar que a resposta contém "Alice"
4. *Step: multiple messages* — contar `div-chat-message` ≥ 4
5. *Step: persistence* — fechar o Playground via `playground-close-button`, reabrir, confirmar que a contagem de mensagens é ≥ ao valor anterior

---

**Teste 3 — session isolation: new session has no context from previous session**

Requer `OPENAI_API_KEY`. Separado por ser destrutivo (cria nova sessão).

1. Carregar template, configurar API key
2. Abrir Playground, enviar `"My name is Bob..."`
3. Aguardar resposta aparecer
4. Clicar em `session-selector-trigger` → `New Session`
5. Aguardar `input-chat-playground` na nova sessão
6. Verificar que `div-chat-message` count é `=== 0` (sessão começa vazia)

---

## Critério de validação *(obrigatório)*

- Template carrega com exatamente 6 nós: Chat Input, Chat Output, Message History, OpenAI, Prompt Template, Type Convert
- O LLM recorda o nome informado em mensagem anterior da mesma sessão ("Alice")
- Mensagens acumulam no histórico (≥ 4 após 2 trocas)
- O histórico persiste após fechar e reabrir o Playground
- Uma nova sessão começa com 0 mensagens, sem herdar contexto de sessões anteriores

---

## Dependências externas *(obrigatório)*

- `src/backend/base/langflow/initial_setup/starter_projects/memory_chatbot.py` — define o grafo do template; mudanças nos nós ou arestas quebram o Teste 1
- `src/lfx/src/lfx/components/models_and_agents/memory.py` — `MemoryComponent` (`display_name = "Message History"`); renomear ou remover quebra o Teste 1 e o Teste 2
- `src/lfx/src/lfx/components/openai/openai_chat_model.py` — `OpenAIModelComponent`; mudanças no campo `api_key` ou no `display_name` afetam Testes 1, 2 e 3
- `src/frontend/src/components/core/playgroundComponent/` — `input-chat-playground`, `div-chat-message`, `playground-close-button`, `session-selector-trigger` — qualquer renomeação quebra Testes 2 e 3
- `src/frontend/src/CustomNodes/GenericNode/components/NodeName/index.tsx` — `data-testid="title-{display_name}"` — mudança no padrão de testid quebra o Teste 1

---

## O que este teste não cobre *(opcional)*

- Comportamento do Memory Chatbot com outros providers (Anthropic, Google) — o template usa `OpenAIModelComponent` diretamente
- Validação do conteúdo da resposta da IA além da referência ao nome ("Alice")
- Verificação de que, sem o nó `Message History` conectado, o contexto se perde (coberto conceitualmente pelo Teste 3: nova sessão = histórico zerado)
- Persistência do histórico após restart do servidor Langflow

---

## Pré-condições *(opcional)*

- Langflow rodando e acessível em `PLAYWRIGHT_BASE_URL`
- `OPENAI_API_KEY` definida no `.env` para os Testes 2 e 3
- Rodar com `--workers=1` para evitar conflito de flows

---

## Quando revisar este teste *(opcional)*

- Se o template "Memory Chatbot" for removido ou renomeado em `starter_projects`
- Se o `MemoryComponent` mudar de `display_name` ou a sessão padrão mudar de comportamento
- Se o Playground ganhar confirmação modal ao criar nova sessão (Teste 3 precisará de step extra)

---

## Notas *(opcional)*

- **Estrutura**: 3 testes — estrutura (sem API), suite de retenção (com `expect.soft`), isolamento de sessão (destrutivo, separado). O `expect.soft` garante visibilidade total das falhas sem abortar o suite.
- **`popover-anchor-input-api_key`**: testid gerado dinamicamente pelo `parameterRenderComponent` com `data-testid={id}` onde `id = "popover-anchor-input-api_key"`. Se o campo não estiver visível (Langflow picking up a key from env), `configureOpenAIApiKey` silencia e o teste continua.
- **`session-selector-trigger`**: botão `ListRestart` no header do Playground que abre o dropdown de sessões; "New Session" cria uma sessão com ID aleatório e limpa o histórico exibido.
- **Teste 1 sem API key**: validação de estrutura pura — útil em CI sem keys configuradas.
