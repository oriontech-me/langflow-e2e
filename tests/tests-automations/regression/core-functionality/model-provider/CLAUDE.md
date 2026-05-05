# model-provider — Guide for creating tests

Tests in this folder validate provider configuration (API keys, provider modal, model selection) via UI.

---

## Tests that navigate through settings

Use `SettingsPage` to navigate to the settings page:

```typescript
import { SettingsPage } from "../../../../pages";

const settings = new SettingsPage(page);
await settings.navigate();
await page.getByTestId("sidebar-nav-Model Providers").click();
```

---

## Tests that execute an agent with the configured provider

If the test goes beyond configuration and executes an agent, **use the model setup**:

```bash
# Before running
npx playwright test tests/collect-models.spec.ts
```

```typescript
import { SimpleAgentTemplatePage } from "../../../../pages";

await new SimpleAgentTemplatePage(page).load({ provider: "openai", model: "gpt-4o-mini" });
```

For tests parameterized by model, follow the pattern from `agent-component-regression.spec.ts` in `llm-agents/`.

---

## Required tags for this folder

```typescript
{ tag: ["@model-provider"] }                        // minimum for all tests
{ tag: ["@model-provider", "@settings"] }           // if navigating via Settings
{ tag: ["@model-provider", "@agents"] }             // if executing an agent after configuring
```

---

## References

- `SettingsPage` → `tests/pages/SettingsPage.ts`
- `SimpleAgentTemplatePage` → `tests/pages/SimpleAgentTemplatePage.ts`
- Provider setup → `tests/helpers/provider-setup/`
- Model collection → `tests/collect-models.spec.ts`
