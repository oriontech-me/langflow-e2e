# Playground — Open and Close Behavior

**Última validação:** Langflow 1.10.x

---

## O que este teste valida *(obrigatório)*
Valida que o Playground abre diretamente em modo fullscreen ao ser acionado no editor de flows e que pode ser fechado e reaberto corretamente. Se este teste falhar, o acesso ao Playground a partir do editor está quebrado.

O Playground migrou de um modal com botão de expandir para um fullscreen direto. O teste anterior tentava localizar um botão de fullscreen com seletores genéricos (`[data-testid*="maximize"]`) e fazia skip silencioso quando não encontrava — o que mascarava regressões. Esta spec fixa os seletores contra o comportamento real da versão atual (1.10.x+).

---

## Tags *(obrigatório)*
`@stable` `@release` `@regression` `@playground`

---

## Passo a passo *(obrigatório)*

**Teste 1 — playground opens in fullscreen with chat input visible**
1. Criar flow em branco com ChatInput conectado ao ChatOutput
2. Clicar no botão `playground-btn-flow-io` na toolbar
3. Confirmar que `playground-close-button` aparece imediatamente (indica fullscreen)
4. Confirmar que `input-chat-playground` está visível

**Teste 2 — playground closes and reopens correctly from the flow editor**
1. Criar flow em branco com ChatInput conectado ao ChatOutput
2. Abrir o Playground e aguardar `playground-close-button`
3. Clicar no botão de fechar (`playground-close-button`)
4. Confirmar que `input-chat-playground` não está mais visível
5. Reabrir o Playground via `playground-btn-flow-io`
6. Confirmar que `input-chat-playground` volta a estar visível

---

## Critério de validação *(obrigatório)*
- O Playground abre em fullscreen (sem etapa de expansão): `playground-close-button` presente imediatamente após abrir
- O chat input (`input-chat-playground`) está visível após abrir
- Após fechar, o chat input deixa de estar visível
- Após reabrir, o chat input volta a estar visível

---

## Dependências externas *(obrigatório)*

- `src/frontend/src/components/core/playgroundComponent/` — componente principal do Playground; mudanças em `data-testid="playground-close-button"` ou `data-testid="input-chat-playground"` quebram este teste
- `src/frontend/src/components/core/flowToolbarComponent/` — botão `playground-btn-flow-io` que abre o Playground a partir do editor

---

## O que este teste não cobre *(opcional)*
- Envio de mensagens ou execução de flows no Playground
- Voice mode e funcionalidades avançadas do Playground
- Comportamento com múltiplas sessões abertas

---

## Pré-condições *(opcional)*
- Langflow rodando e acessível em `PLAYWRIGHT_BASE_URL`
- Nenhum flow pré-existente necessário; o teste cria o flow, registra o ID retornado na URL e o apaga via API no `afterEach`

---

## Quando revisar este teste *(opcional)*
- Se o Playground voltar a ter um modo não-fullscreen (botão de expansão separado): o teste de abertura precisaria ser atualizado
- Se o botão de fechar for removido ou renomeado

---

## Notas *(opcional)*
- Os dois testes rodam em modo `serial` para evitar conflitos de flow no editor
- Limpeza feita via API (`DELETE /api/v1/flows/{id}`) somente para o flow criado pelo próprio teste; o ID é extraído da URL após o setup
