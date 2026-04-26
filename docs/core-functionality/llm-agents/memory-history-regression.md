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
3. *Step: canvas has all 6 required nodes* — `expect.soft` para cada um dos 6 nós:
   - `title-Chat Input`, `title-Chat Output`, `title-Message History`
   - `title-Language Model`, `title-Prompt Template`, `note_node`
4. *Step: canvas has exactly 6 nodes* — contar `.react-flow__node` e verificar `=== 6`

---

**Teste 2 — message history context retention suite**

Requer `OPENAI_API_KEY`. Agrupa as validações de comportamento em `test.step` com `expect.soft`.

1. Carregar o template Memory Chatbot e configurar OpenAI via `setupLanguageModelOpenAI`:
   - Se `model_model` não estiver visível (providers não configurados): clicar no botão "Setup Provider" (sem data-testid) → selecionar `provider-item-OpenAI` → preencher API key com `pressSequentially` → clicar "Save" → aguardar botão "Replace" aparecer → habilitar toggles `[data-testid^="llm-toggle"]` → fechar com Escape → aguardar `model_model` aparecer
   - Clicar `model_model` e selecionar `gpt-4o-mini`
2. Abrir o Playground (`playground-btn-flow-io`) e aguardar `input-chat-playground`
3. *Step: context retention* — Enviar `"My name is Alice..."`, aguardar resposta, enviar `"What is my name?"` e verificar que a resposta contém "Alice"
4. *Step: multiple messages* — contar `div-chat-message` ≥ 2 (testid marca apenas respostas do bot)
5. *Step: persistence* — fechar o Playground via `playground-close-button`, reabrir, confirmar que a contagem de mensagens é ≥ ao valor anterior

---

**Teste 3 — session isolation: new session has no context from previous session**

Requer `OPENAI_API_KEY`. Separado por ser destrutivo (cria nova sessão).

1. Carregar template, configurar API key (mesmo fluxo do Teste 2)
2. Abrir Playground, enviar `"My name is Bob..."`
3. Aguardar resposta aparecer
4. Clicar em `new-chat` (botão "+" no painel de sessões do sidebar)
5. Aguardar 500ms para reset do estado de sessão
6. Verificar que `div-chat-message` count é `=== 0` (sessão começa vazia)

---

## Critério de validação *(obrigatório)*

- Template carrega com exatamente 6 nós: Chat Input, Chat Output, Message History, Language Model, Prompt Template, note (README)
- O LLM recorda o nome informado em mensagem anterior da mesma sessão ("Alice")
- Respostas do bot acumulam no histórico (div-chat-message ≥ 2 após 2 trocas)
- O histórico persiste após fechar e reabrir o Playground
- Uma nova sessão começa com 0 mensagens, sem herdar contexto de sessões anteriores

---

## Dependências externas *(obrigatório)*

- `src/backend/base/langflow/initial_setup/starter_projects/Memory Chatbot.json` — define o grafo do template em runtime (sobrescreve o `.py`); mudanças nos nós ou arestas quebram o Teste 1
- `src/lfx/src/lfx/components/models_and_agents/memory.py` — `MemoryComponent` (`display_name = "Message History"`); renomear ou remover quebra o Teste 1 e o Teste 2
- `src/lfx/src/lfx/components/models_and_agents/language_model.py` — `LanguageModelComponent` (`display_name = "Language Model"`); mudanças no campo `model` ou no `display_name` afetam Testes 1, 2 e 3
- `src/frontend/src/components/core/playgroundComponent/` — `input-chat-playground`, `div-chat-message`, `playground-close-button`, `new-chat` — qualquer renomeação quebra Testes 2 e 3
- `src/frontend/src/CustomNodes/GenericNode/components/NodeName/index.tsx` — `data-testid="title-{display_name}"` — mudança no padrão de testid quebra o Teste 1
- `src/frontend/src/modals/modelProviderModal/components/ProviderConfigurationForm.tsx` — botão "Save" (texto exato para salvar API key); mudar para outro texto quebra `setupLanguageModelOpenAI`

---

## O que este teste não cobre *(opcional)*

- Comportamento do Memory Chatbot com outros providers (Anthropic, Google) — `setupLanguageModelOpenAI` configura apenas OpenAI
- Validação do conteúdo da resposta da IA além da referência ao nome ("Alice")
- Verificação de que, sem o nó `Message History` conectado, o contexto se perde
- Persistência do histórico após restart do servidor Langflow

---

## Pré-condições *(opcional)*

- Langflow rodando e acessível em `PLAYWRIGHT_BASE_URL`
- `OPENAI_API_KEY` definida no `.env` para os Testes 2 e 3
- Rodar com `--workers=1` para evitar conflito de flows

---

## Quando revisar este teste *(opcional)*

- Se o template "Memory Chatbot" for removido ou renomeado em `starter_projects`
- Se o `LanguageModelComponent` mudar de `display_name` ou a sessão padrão mudar de comportamento
- Se o botão "Save" no provider modal mudar de texto (quebra `setupLanguageModelOpenAI`)
- Se o botão `new-chat` no sidebar de sessões for renomeado (quebra Teste 3)
- Se o Playground ganhar confirmação modal ao criar nova sessão (Teste 3 precisará de step extra)

---

## Notas *(opcional)*

- **Estrutura do template em runtime**: o template carrega de `Memory Chatbot.json` (não do `.py`), com 6 nós: Chat Input, Chat Output, Prompt Template, Message History, Language Model (não OpenAI direto), note/README.
- **`div-chat-message`**: testid presente apenas em respostas do bot (`bot-message.tsx`), não em mensagens do usuário. 2 trocas → count = 2 (não 4).
- **`setupLanguageModelOpenAI`**: função local ao spec que configura OpenAI via modal "Setup Provider". Usa `pressSequentially` (não `fill`) para garantir eventos de teclado no input controlado do React. Aguarda botão "Replace" aparecer para confirmar que o save completou.
- **`new-chat`**: botão "+" no painel lateral de sessões (`chat-sidebar.tsx`). Equivalente funcional ao "New Session" do dropdown `session-selector-trigger` (que pode estar oculto por animação em certas builds).
- **Teste 1 sem API key**: validação de estrutura pura — útil em CI sem keys configuradas.
