# llm-agents — Guide for creating tests

Tests in this folder validate LLM agent behavior, reasoning, tool calling and Playground execution.

---

## Required: use the model setup

Every test that executes an agent with an LLM **must** use the project's provider and model infrastructure.
Do not hardcode provider, API key or model directly in the test.

---

## Step by step to create an agent test

### 1. Run collect-models before testing

```bash
npx playwright test tests/collect-models.spec.ts
```

This generates `tests/helpers/provider-setup/data/providers.json` and `models.json`.

### 2. Use SimpleAgentTemplatePage to load the flow

```typescript
import { SimpleAgentTemplatePage } from "../../../../pages";

// Loads the Simple Agent template with the configured provider/model
await new SimpleAgentTemplatePage(page).load(options);
// options comes from models.json: { provider: "openai", model: "gpt-4o-mini" }
```

### 3. Parameterize the test by model (project standard)

```typescript
import { getTestTargets } from "../../../../helpers/provider-setup"; // or inline as in agent-component-regression.spec.ts

for (const { label, options, skipReason } of targets) {
  test.describe.serial(`My Test [${label}]`, () => {
    test("should ...", async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");
      // ...
    });
  });
}
```

This automatically creates one describe per model — the test runs for each model in `models.json`, respecting the `MODEL_TEST_ID` and `MODEL_TEST_PROVIDER` variables from `.env` (by priority).

### 4. Handle MODEL_NOT_AVAILABLE

Some models exist in the JSON but are not available in the agent dropdown:

```typescript
try {
  await new SimpleAgentTemplatePage(page).load(options);
} catch (e: any) {
  if (e?.message?.startsWith("MODEL_NOT_AVAILABLE")) test.skip(true, e.message);
  throw e;
}
```

### 5. Run with --workers=1

```bash
npx playwright test tests/tests-automations/regression/core-functionality/llm-agents/my-test.spec.ts --workers=1
```

Required — agent tests create flows in Langflow and conflict if run in parallel.

---

## Required tags for this folder

```typescript
{ tag: ["@agents"] }                     // minimum
{ tag: ["@agents", "@playground"] }     // if validating playground interaction
{ tag: ["@agents", "@model-provider"] } // if validating provider/model selection
```

---

## References

- `SimpleAgentTemplatePage` → `tests/pages/SimpleAgentTemplatePage.ts`
- Provider setup → `tests/helpers/provider-setup/setup-openai.ts` / `setup-anthropic.ts` / `setup-google.ts`
- Model collection → `tests/helpers/provider-setup/collect-models.ts`
- Full example → `agent-component-regression.spec.ts` (in this folder)
