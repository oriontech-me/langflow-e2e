# llm-agents — Guia para criação de testes

Testes nesta pasta validam comportamento de agentes LLM, raciocínio, tool calling e execução no Playground.

---

## Obrigatório: usar o setup de modelos

Todo teste que executa um agente com LLM **deve** usar a infraestrutura de providers e modelos do projeto.
Não hardcode provider, API key ou modelo diretamente no teste.

---

## Passo a passo para criar um teste de agente

### 1. Rodar o collect-models antes de testar

```bash
npx playwright test tests/collect-models.spec.ts
```

Isso gera `tests/helpers/provider-setup/data/providers.json` e `models.json`.

### 2. Usar SimpleAgentTemplatePage para carregar o flow

```typescript
import { SimpleAgentTemplatePage } from "../../../../pages";

// Carrega o template Simple Agent com o provider/modelo configurado
await new SimpleAgentTemplatePage(page).load(options);
// options vem do models.json: { provider: "openai", model: "gpt-4o-mini" }
```

### 3. Parametrizar o teste por modelo (padrão do projeto)

```typescript
import { getTestTargets } from "../../../../helpers/provider-setup"; // ou inline como em agent-component-regression.spec.ts

for (const { label, options, skipReason } of targets) {
  test.describe.serial(`Meu Teste [${label}]`, () => {
    test("deve ...", async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");
      // ...
    });
  });
}
```

Isso cria automaticamente um describe por modelo — o teste roda para cada modelo do `models.json`, respeitando o `MODEL_TEST_STRATEGY` do `.env`.

### 4. Tratar MODEL_NOT_AVAILABLE

Alguns modelos existem no JSON mas não estão disponíveis no dropdown do agente:

```typescript
try {
  await new SimpleAgentTemplatePage(page).load(options);
} catch (e: any) {
  if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
  throw e;
}
```

### 5. Rodar com --workers=1

```bash
npx playwright test tests/tests-automations/regression/core-functionality/llm-agents/meu-teste.spec.ts --workers=1
```

Obrigatório — testes de agente criam flows no Langflow e conflitam se rodarem em paralelo.

---

## Tags obrigatórias para esta pasta

```typescript
{ tag: ["@agents"] }                     // mínimo
{ tag: ["@agents", "@playground"] }     // se validar interação no playground
{ tag: ["@agents", "@model-provider"] } // se validar seleção de provider/modelo
```

---

## Referências

- `SimpleAgentTemplatePage` → `tests/pages/SimpleAgentTemplatePage.ts`
- Setup de providers → `tests/helpers/provider-setup/setup-openai.ts` / `setup-anthropic.ts` / `setup-google.ts`
- Coleta de modelos → `tests/helpers/provider-setup/collect-models.ts`
- Exemplo completo → `agent-component-regression.spec.ts` (nesta pasta)
