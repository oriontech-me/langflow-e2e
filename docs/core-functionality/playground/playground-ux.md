# Playground — UX de Chat

**Última validação:** Langflow 1.10.x

---

## O que este teste valida *(obrigatório)*

Valida o comportamento de UX do chat no Playground usando um flow determinístico (ChatInput → ChatOutput), sem dependência de LLM. Cobre três propriedades fundamentais: renderização imediata da mensagem do usuário, auto-scroll após envio e prontidão do campo de entrada após a resposta do flow.

---

## Tags *(obrigatório)*

`@release` `@regression` `@playground`

---

## Passo a passo *(obrigatório)*

**Teste 1 — user message must appear instantly in playground before AI responds**
1. Criar flow em branco com ChatInput conectado ao ChatOutput via `setupPlayground`
2. Abrir o Playground via `playground-btn-flow-io`
3. Confirmar que `input-chat-playground` está visível
4. Preencher o campo com "Hello from regression test" e clicar em `button-send`
5. Confirmar que o texto da mensagem aparece no chat em até 3 s
6. Aguardar o input reabilitar (flow concluído)

**Teste 2 — playground must scroll to latest message after sending**
1. Criar flow em branco com ChatInput conectado ao ChatOutput via `setupPlayground`
2. Abrir o Playground via `playground-btn-flow-io`
3. Enviar 6 mensagens sequenciais, aguardando o input reabilitar entre cada uma
4. Confirmar que a última mensagem ("Message 6.") está visível e dentro do viewport

**Teste 3 — playground input field must be ready after flow responds**
1. Criar flow em branco com ChatInput conectado ao ChatOutput via `setupPlayground`
2. Abrir o Playground via `playground-btn-flow-io`
3. Enviar "Hi." e aguardar o input reabilitar
4. Confirmar que o input está visível e habilitado
5. Confirmar que aceita digitação de follow-up ("Follow-up message.")

---

## Critério de validação *(obrigatório)*

- Mensagem do usuário aparece no chat com timeout de 3 s após o clique em enviar
- A última mensagem de uma sequência está visível e dentro do viewport após envio
- O campo `input-chat-playground` fica habilitado após a conclusão do flow e aceita nova entrada

---

## Dependências externas *(obrigatório)*

Referências no **repositório principal do Langflow** (compatíveis com Langflow 1.10.x):

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/text-area-wrapper.tsx` — define `data-testid="input-chat-playground"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/button-send-wrapper.tsx` — define `data-testid="button-send"`
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/bot-message.tsx` — renderiza mensagens no chat com `data-testid="div-chat-message"`
- `src/frontend/src/components/ui/simple-sidebar.tsx` — define `data-testid="playground-btn-flow-io"`

Referências neste repositório:

- `tests/helpers/flows/setup-playground.ts` — helper compartilhado que monta o flow e retorna o ID para cleanup

---

## O que este teste não cobre *(opcional)*

- Streaming, polling e modo direct de resposta
- Voice mode e funcionalidades avançadas do Playground
- Envio de mensagem vazia (coberto em `playground-empty-message-send.spec.ts`)
- Envio de mensagem enquanto resposta em curso

---

## Pré-condições *(opcional)*

- Langflow rodando e acessível em `PLAYWRIGHT_BASE_URL`
- Nenhum flow pré-existente necessário; o helper `setupPlayground` cria o flow, registra o ID retornado pela API e o apaga via `DELETE /api/v1/flows/{id}` no `afterEach`

---

## Notas *(opcional)*

- Os três testes rodam em modo `serial` para evitar conflitos de estado no editor
- O flow ChatInput → ChatOutput é determinístico: o output ecoa o input, eliminando dependência de LLM e tornando os testes executáveis sem chaves de API
