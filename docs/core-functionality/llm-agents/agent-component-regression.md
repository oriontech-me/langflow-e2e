# Agent Component Regression

**Última validação:** Langflow 1.10.x

---

## O que este teste valida *(obrigatório)*
Valida o comportamento core do componente Agent no Langflow: resposta sem tools, exibição de reasoning steps, streaming progressivo, indicador de duração e múltiplas mensagens consecutivas. Cobre a regressão ID 147 (agente falhava quando nenhuma tool estava conectada) e garante que os comportamentos fundamentais de execução do Agent permaneçam estáveis a cada ciclo de release. É parametrizado por provider/modelo via `models.json`, cobrindo OpenAI, Anthropic e Google automaticamente.

Se qualquer um desses testes falhar, o Agente LLM está quebrado para uso no Playground.

---

## Tags *(obrigatório)*
`@stable` `@release` `@components` `@agents` `@playground`

---

## Passo a passo *(obrigatório)*

O spec gera **2 testes por modelo ativo** via `getTestTargets()`. Por padrão (nightly/CI) roda 1 modelo por provider; `ALL_MODELS=true` executa todos os modelos do `models.json`.

---

**Teste 1 — agent interaction suite**

Único `load()` por modelo — todas as validações compartilham a mesma sessão de Playground via `expect.soft` (todas rodam mesmo que uma falhe).

1. Carregar o template Simple Agent via `SimpleAgentTemplatePage.load(options)`
2. Abrir o Playground (`playground-btn-flow-io`) e aguardar `input-chat-playground`

*Step: responds without tools connected*
3. Enviar "What is the capital of France?" e aguardar `waitForAgentResponse`
4. `expect.soft`: `div-chat-message` visível com texto não vazio

*Step: shows reasoning steps*
5. Enviar "Who was the first astronaut to walk on the Moon?" e aguardar resposta
6. `expect.soft`: `div-chat-message` visível; verificar (soft, condicional) se "Finished in" aparece

*Step: streams response progressively and displays duration*
7. Enviar prompt longo (5-paragraph AI summary) e aguardar primeira mensagem
8. Capturar texto inicial; aguardar 3s; se Stop ainda visível: `expect.soft` texto cresceu
9. Aguardar Stop desaparecer; `expect.soft` resposta final não vazia
10. Verificar (soft, condicional) se "Finished in Xs" aparece

*Step: handles multiple consecutive messages*
11. `expect.soft`: contagem de `div-chat-message` ≥ 2

*Step: response time visible on canvas after closing playground*
12. Clicar em `playground-close-button`
13. `expect.soft`: `node_duration_agent` visível no canvas

---

**Teste 2 — agent stop button must halt execution mid-run**

Separado do suite porque interrompe o estado da execução.

1. Carregar o template Simple Agent (novo `load()` independente)
2. Abrir o Playground e enviar prompt longo (história de explorador do século 18)
3. Se Stop button não aparecer em 30s: teste passa (modelo respondeu antes — comportamento válido)
4. Clicar no Stop button via `dispatchEvent("click")`
5. Confirmar que Stop button some e `input-chat-playground` fica visível

---

## Critério de validação *(obrigatório)*
- Agente responde com texto não vazio mesmo sem tools conectadas
- Reasoning steps ("Finished in Xs") aparecem quando o modelo os usa (verificação condicional)
- Botão Stop interrompe geração e o input volta ao estado normal
- `node_duration_agent` visível no canvas após fechar o Playground (assertion canônica de duração — vem do backend)
- Texto do Playground cresce durante geração longa (streaming confirmado)
- Múltiplas mensagens consecutivas acumulam no histórico do Playground

---

## O que este teste não cobre *(opcional)*
- Configuração de tools externas (Composio, MCP) no Agent
- Validação de tool calling com ferramentas reais
- Comportamento de memória/contexto entre sessões distintas
- Structured output (JSON schema)

---

## Pré-condições *(opcional)*
- Langflow rodando e acessível em `PLAYWRIGHT_BASE_URL`
- `models.json` e `providers.json` gerados via `npx playwright test tests/collect-models.spec.ts`
- Ao menos uma API key ativa no `.env` (OpenAI, Anthropic ou Google)
- Rodar com `--workers=1` para evitar conflitos de flow no Langflow

---

## Dependências externas *(obrigatório)*

- `src/frontend/src/components/core/playgroundComponent/` — componente principal do Playground; mudanças em `input-chat-playground`, `button-send`, `div-chat-message` ou `playground-close-button` quebram este spec
- `src/frontend/src/components/core/flowToolbarComponent/` — botão `playground-btn-flow-io` que abre o Playground a partir do editor
- `src/frontend/src/CustomNodes/GenericNode/components/NodeStatus/index.tsx` — exibe `node_duration_agent` no canvas após execução
- `src/backend/base/langflow/components/agents/` — lógica de execução do Agent; mudanças no streaming ou na geração do campo de duração afetam múltiplos testes

---

## Quando revisar este teste *(opcional)*
- Se o template "Simple Agent" for renomeado ou removido do Langflow
- Se o comportamento padrão de streaming mudar (ex.: resposta em batch em vez de tokens progressivos)
- Se o campo `node_duration_agent` for renomeado ou removido do canvas

---

## Notas *(opcional)*
- **Estrutura de testes**: 2 testes por modelo — `agent interaction suite` (5 validações em `test.step` com `expect.soft`) e `agent stop button` (separado por ser destrutivo). Usar `expect.soft` garante que todas as validações rodam mesmo se uma falhar, sem perda de visibilidade.
- **Seleção de modelos**: por padrão (`ALL_MODELS` omitido), `getTestTargets()` retorna 1 modelo por provider ativo (o primeiro do `models.json`). Para rodar todos os modelos: `ALL_MODELS=true`. Para filtrar por provider: `MODEL_TEST_PROVIDER=openai`. Para modelo específico: `MODEL_TEST_ID=gpt-4o-mini`.
- **"Finished in Xs" no Playground**: verificação condicional — o texto aparece no `BotMessage` com base no ciclo `isBuilding` do `useFlowStore`; não é garantido em sessões multi-mensagem ou modelos que respondem muito rápido. A assertion canônica de duração é `node_duration_agent` no canvas.
- O Stop button é verificado com `isVisible({ timeout: 30000 }).catch(() => false)` — modelos rápidos podem responder antes do botão aparecer, e isso é comportamento válido.
- `dispatchEvent("click")` no Stop button contorna checagens de cobertura do React sem perder o handler.
