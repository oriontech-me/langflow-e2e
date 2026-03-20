# api — Testes de API REST

Testes que chamam diretamente os endpoints REST do Langflow, sem interação com a UI.

---

## Padrão obrigatório

Todo teste de API usa `{ request }` (não `{ page }`) e obtém o token antes de qualquer chamada:

```typescript
import { expect, test } from "../../../../fixtures/fixtures";
import { getAuthToken } from "../../../../helpers/auth/get-auth-token";

test("deve retornar 200", { tag: ["@api"] }, async ({ request }) => {
  const authToken = await getAuthToken(request);

  const res = await request.get("/api/v1/flows/", {
    headers: { Authorization: authToken },
  });

  expect(res.status()).toBe(200);
});
```

---

## getAuthToken

Localização: `tests/helpers/auth/get-auth-token.ts`

Usa `/api/v1/auto_login` (modo padrão do Langflow sem auth obrigatória). Retorna `"Bearer <token>"` ou `""` se o ambiente não exigir autenticação.

---

## Nomes únicos em POST

Ao criar flows, pastas ou componentes via POST, **sempre usar timestamp ou UUID no nome** para evitar conflito entre testes paralelos:

```typescript
const flowName = `Test Flow - ${Date.now()}`;
// ou
const flowName = `Test Flow - ${Math.random().toString(36).slice(2, 8)}`;
```

---

## Cleanup no próprio teste

Cada teste é responsável por deletar o que criou:

```typescript
// Ao final do teste (ou no bloco try/finally):
await request.delete(`/api/v1/flows/${flowId}`, {
  headers: { Authorization: authToken },
});
```

---

## Estrutura dos arquivos

| Arquivo | O que testa |
|---|---|
| `api-flows-crud.spec.ts` | CRUD completo de flows (POST, GET, PATCH, DELETE) |
| `api-flows-batch.spec.ts` | Endpoint de batch delete de flows |
| `api-folders-crud.spec.ts` | CRUD de pastas/projetos |
| `api-health-check.spec.ts` | `/api/v1/health` e `/api/v1/version` |
| `api-run-flow.spec.ts` | `/api/v1/run/:id` — execução de flow via API |
| `api-run-with-tweaks.spec.ts` | Execução com `tweaks` (override de campos) |
| `api-monitor-messages.spec.ts` | `/api/v1/monitor/messages` — histórico de mensagens |
| `api-monitor-messages-crud.spec.ts` | CRUD de mensagens no monitor |
| `api-invalid-key.spec.ts` | Comportamento com API key inválida |
| `api-custom-component.spec.ts` | CRUD de custom components via API |
| `api-request-execute.spec.ts` | Componente API Request executado via API |

---

## Tags

```typescript
{ tag: ["@api"] }                    // mínimo para testes de API
{ tag: ["@api", "@regression"] }     // para testes de regressão
{ tag: ["@release", "@api"] }        // para testes incluídos no pipeline de release
```

---

## O que NÃO fazer

- Não usar `{ page }` em testes puramente de API — desnecessário e mais lento
- Não hardcodar tokens ou credenciais — sempre usar `getAuthToken`
- Não assumir IDs fixos — IDs mudam a cada execução
- Não deixar dados criados sem cleanup
