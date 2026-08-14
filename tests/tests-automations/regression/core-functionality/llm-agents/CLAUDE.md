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
import { resolveTestTargets } from "../../../../helpers/provider-setup/test-targets";

// The target list comes from ONE shared resolver — never copy it into the spec
// (#1184). It reads models.json, applies the .env strategy and attaches each
// provider's inactive-skip reason. Seventeen specs used to carry their own copy and
// they had drifted into five variants, two of which silently ignored MODEL_TEST_ID —
// the same drift #1043 removed for providerSkipReasons.
//
// `tier` is what the spec needs from a lane, so a lane can resolve the cheapest
// target that satisfies it in one place (#1185, #1187) instead of guessing per spec.
// Add `requires: "vision" | "chat"` when the assertion needs a specific capability
// within the provider — see agent-multimodal-image-input / agent-markdown-output.
for (const { label, options, skipReason } of resolveTestTargets({ tier: "tool-calling" })) {
  test.describe.serial(`My Test [${label}]`, () => {
    test("should ...", async ({ page }) => {
      test.skip(!!skipReason, skipReason ?? "");
      // ...
    });
  });
}
```

This automatically creates one describe per model — the test runs for each model in `models.json`, respecting the `MODEL_TEST_ID` and `MODEL_TEST_PROVIDER` variables from `.env` (by priority). The full pattern, including the strategy filter, is in `CONTRIBUTING.md` → **Model parameterization pattern**.

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

**Catch that prefix and nothing else.** `MODEL_NOT_AVAILABLE` now means an
absence the helper *established*: it enumerated the picker, the model was not
among the options, and the provider panel did not list it either — the message
carries the option count, the per-provider breakdown and the nearest offered
ids. A model the picker IS offering but the suite cannot select raises
`MODEL_PICKER_DEFECT` instead, which no spec may skip on: that is our defect,
and it must fail. An **empty** picker raises it too — zero options prove nothing
about a model, so they can never justify a skip (#1461).

Why the split exists: until #1459 the three provider helpers resolved a pinned
model with `hasText: /^model$/`, and 1.12.0.dev26 added a `sr-only` "N of M"
counter inside every option. The matcher stopped matching, the guard reported
"model may not be supported", and one daily lost ~30 `@stable` tests to
`test.skip` — with the run's skip total (35 against a 4–15 baseline) as the only
trace. Resolve a model through
`tests/helpers/provider-setup/model-option.ts` (identity from `data-value` /
`data-testid`), never through the option's rendered text.

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
