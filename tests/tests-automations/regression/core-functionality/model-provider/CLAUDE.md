# model-provider — Guia para criação de testes

Testes nesta pasta validam configuração de providers (API keys, modal de providers, seleção de modelos) via UI.

---

## Testes que navegam pelas configurações

Use `SettingsPage` para navegar até a página de configurações:

```typescript
import { SettingsPage } from "../../../../pages";

const settings = new SettingsPage(page);
await settings.navigate();
await page.getByTestId("sidebar-nav-Model Providers").click();
```

---

## Testes que executam um agente com o provider configurado

Se o teste vai além da configuração e executa um agente, **use o setup de modelos**:

```bash
# Antes de rodar
npx playwright test tests/collect-models.spec.ts
```

```typescript
import { SimpleAgentTemplatePage } from "../../../../pages";

await new SimpleAgentTemplatePage(page).load({ provider: "openai", model: "gpt-4o-mini" });
```

Para testes parametrizados por modelo, siga o padrão de `agent-component-regression.spec.ts` em `llm-agents/`.

---

## Tags obrigatórias para esta pasta

```typescript
{ tag: ["@model-provider"] }                        // mínimo para todos os testes
{ tag: ["@model-provider", "@settings"] }           // se navega via Settings
{ tag: ["@model-provider", "@agents"] }             // se executa um agente após configurar
```

---

## Referências

- `SettingsPage` → `tests/pages/SettingsPage.ts`
- `SimpleAgentTemplatePage` → `tests/pages/SimpleAgentTemplatePage.ts`
- Setup de providers → `tests/helpers/provider-setup/`
- Coleta de modelos → `tests/collect-models.spec.ts`
