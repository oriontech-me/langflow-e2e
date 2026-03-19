# Dead Code Audit

Branch de trabalho: `chore/remove-dead-code`
Auditoria realizada em: 2026-03-18
Método: grep cruzado + leitura direta dos arquivos

---

## Como usar este arquivo

Cada item tem um status:
- `[ ]` — pendente de remoção
- `[x]` — removido

Para cada remoção: delete o arquivo, verifique se o export em algum `index.ts` precisa ser limpo junto, rode `npm run test:unit` para confirmar que nada quebrou.

---

## 1. Helpers nunca importados em testes ativos

Todos confirmados: aparecem apenas em `legacy-old-structure/` ou em si mesmos. Nenhum spec file ativo os importa.

- [x] `tests/helpers/api/build-data-transfer.ts` — `buildDataTransfer`
- [x] `tests/helpers/api/get-all-response-message.ts` — `getAllResponseMessage`
- [x] `tests/helpers/auth/auth-helpers.ts` — `getAuthToken` — **duplicata** de `get-auth-token.ts` (mesma assinatura, implementação divergente: usa `/api/v1/login` em vez de `/api/v1/auto_login`). Remover `auth-helpers.ts`; manter `get-auth-token.ts`.
- [x] `tests/helpers/mcp/add-new-api-keys.ts` — `addNewApiKeys`
- [x] `tests/helpers/flows/run-chat-output.ts` — `runChatOutput`
- [x] `tests/helpers/ui/wait-for-open-modal.ts` — `waitForOpenModalWithChatInput`, `waitForOpenModalWithoutChatInput`
- [x] `tests/helpers/other/evaluate-input-react-state-changes.ts` — `evaluateReactStateChanges`

---

## 2. Page Object nunca instanciado

- [x] `tests/pages/auth/LoginPage.ts` — classe `LoginPage` exportada em `tests/pages/index.ts` mas nunca importada por nenhum spec file.
  - Removido também o export em `tests/pages/index.ts`.
  - Nota: `admin-user-management.spec.ts` usa a variável local `isLoginPage` (booleano) — sem relação com esta classe.

---

## 3. Testes permanentemente skippados

Estes testes nunca executam. Decisão necessária: remover ou documentar prazo de retomada.

- [ ] `tests/tests-automations/regression/ui-ux/voice-assistant.spec.ts:5`
  - Sintaxe: `test.skip("nome", config, fn)` — skip permanente no nível do teste
  - Motivo registrado: `// TODO: Need to review the voice assistant vs text to voice`
  - Ação sugerida: remover o arquivo ou converter para `test.todo()` com contexto

- [ ] `tests/tests-automations/legacy/store-shared/store-shard-3.spec.ts:10`
  - Sintaxe: `test.skip()` incondicional sem razão registrada dentro do corpo do teste
  - A verificação `!process?.env?.STORE_API_KEY` logo abaixo é inalcançável
  - Ação sugerida: remover o `test.skip()` incondicional e manter apenas o condicional, ou remover o teste inteiro se obsoleto

---

## Falsos positivos descartados (não são código morto)

Para referência — o agente de busca apontou estes como suspeitos, mas foram verificados e estão ativos:

| Símbolo | Motivo de descarte |
|---|---|
| `loadSimpleAgentWithOpenAI` | Chamado 11× em `agent-component-regression.spec.ts` e `playground-ux.spec.ts` |
| `selectGptModel` | Usado em `initialGPTsetup.ts`, que é importado por 15 spec files |
| `addOpenAiInputKey` | Usado em `initialGPTsetup.ts` |
| Skips com `!process?.env?.*_API_KEY` | Condicionais — executam quando a key está presente |
