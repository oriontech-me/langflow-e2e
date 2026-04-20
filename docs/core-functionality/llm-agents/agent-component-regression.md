# Agent Component Regression

## Objetivo *(obrigatório)*
Valida o comportamento core do componente Agent no Langflow: resposta sem tools, exibição de reasoning steps, interrupção via botão Stop, streaming progressivo, indicador de duração e múltiplas mensagens consecutivas. Se qualquer um desses testes falhar, o Agente LLM está quebrado para uso no Playground.

---

## Motivação *(obrigatório)*
Cobre a regressão ID 147 (agente falhava quando nenhuma tool estava conectada) e garante que os comportamentos fundamentais de execução do Agent permaneçam estáveis a cada ciclo de release. É parametrizado por provider/modelo via `models.json`, cobrindo OpenAI, Anthropic e Google automaticamente.

---

## Tags *(obrigatório)*
`@stable` `@release` `@components` `@agents` `@playground`

---

## Passo a passo *(obrigatório)*

**Teste 1 — agent must run and respond without any tools connected**
1. Carregar o template Simple Agent via `SimpleAgentTemplatePage.load(options)`
2. Abrir o Playground (`playground-btn-flow-io`)
3. Enviar "What is the capital of France?"
4. Aguardar o Stop button desaparecer (quando presente)
5. Confirmar que `div-chat-message` aparece com conteúdo não vazio

**Teste 2 — agent must show reasoning steps and produce a valid response**
1. Carregar o template Simple Agent
2. Abrir o Playground e enviar "Who was the first astronaut to walk on the Moon?"
3. Aguardar o Stop button desaparecer
4. Confirmar resposta com conteúdo não vazio
5. Verificar (soft-check) se o texto "Finished in Xs" aparece quando reasoning steps são usados

**Teste 3 — agent stop button must halt execution mid-run**
1. Carregar o template Simple Agent
2. Abrir o Playground e enviar prompt longo (história de explorador do século 18)
3. Se Stop button aparecer em 30s, clicar nele via `dispatchEvent("click")`
4. Confirmar que Stop button some e o input volta a estar visível
5. Se Stop button não aparecer, o teste passa (modelo respondeu antes)

**Teste 4 — agent must display duration after successful run**
1. Carregar o template Simple Agent
2. Abrir o Playground e enviar "What is IA?"
3. Aguardar o Stop button desaparecer
4. Confirmar que o texto `Finished in \d+(\.\d+)?s` está visível

**Teste 5 — agent must stream response progressively in the playground**
1. Carregar o template Simple Agent
2. Abrir o Playground e enviar prompt longo (5-paragraph AI summary)
3. Capturar o texto parcial assim que `div-chat-message` aparece
4. Aguardar 3 segundos
5. Se Stop ainda visível: confirmar que o texto cresceu (streaming ativo)
6. Aguardar Stop desaparecer; confirmar resposta final não vazia

**Teste 6 — playground must display response time after agent finishes**
1. Carregar o template Simple Agent
2. Abrir o Playground e enviar pergunta sobre mammals vs. reptiles
3. Aguardar Stop button desaparecer
4. Fechar o Playground (`playground-close-button`)
5. Confirmar que `node_duration_agent` está visível no canvas

**Teste 7 — agent must handle multiple consecutive messages in same session**
1. Carregar o template Simple Agent
2. Abrir o Playground
3. Enviar "Hello." e aguardar resposta
4. Enviar "Name three countries in South America." e aguardar resposta
5. Confirmar que pelo menos 2 mensagens estão visíveis em `div-chat-message`

---

## Critério de validação *(obrigatório)*
- Agente responde com texto não vazio mesmo sem tools conectadas
- Reasoning steps ("Finished in Xs") aparecem quando o modelo os usa
- Botão Stop interrompe geração e o input volta ao estado normal
- Indicador de duração aparece tanto no Playground quanto no canvas (`node_duration_agent`)
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
- Os testes rodam em `test.describe.serial` por provider/modelo — evita conflitos de flow concorrente
- O Stop button é verificado com `isVisible({ timeout: 10000 }).catch(() => false)` — modelos rápidos podem responder antes do botão aparecer, e isso é comportamento válido
- `dispatchEvent("click")` no Stop button contorna checagens de cobertura do React sem perder o handler
- Última validação: Langflow 1.10.x (abril 2026)
