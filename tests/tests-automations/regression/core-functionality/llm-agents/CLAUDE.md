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

### 5. Enabling models leaves the panel mid-transaction — never close on top of it

The provider panel's model toggles are **not** written per click. Every toggle
feeds `useModelToggleQueue`, which applies an optimistic cache update and then
sends the whole batch through a **1000 ms debounce**. Which of the two send paths
ends up carrying the batch decides whether the model picker sees the result at
all, and only one of them refreshes it:

| Path | Runs on | Refreshes the picker |
|---|---|---|
| debounced flush (`flushModelToggles`) | 1000 ms after the last toggle | **yes** — its `onSettled` invalidates *and* calls `refreshAllModelInputs` |
| close-path flush (`flushPendingChanges`) | the modal's Close | **no** — it only invalidates; `handleClose`'s own `refreshAllModelInputs` runs *after* `onClose` already unmounted the modal |

So closing the panel **within** the debounce window takes the path that never
refreshes the picker, and the picker then renders the **pre-toggle** enabled set
— which on a freshly configured provider is the `MIN_DEFAULT_MODELS = 5` default
(`lfx/base/models/model_utils.py`). That is a genuine picker/panel disagreement,
so `MODEL_PICKER_DEFECT` fires, correctly (§4) — and the cause is ours.

Measured on `1.12.0.dev44`, one clean container, three runs of the identical
sequence differing **only** in the pause between the last toggle click and Close,
with the server reporting `enabled=41` in all three (#1649):

| Pause before Close | `model_model` visible after | Picker offers |
|---|---|---|
| 0 ms | 4 327 ms | **5** ❌ |
| 1 200 ms | 30 020 ms | 35 ✅ |
| 2 000 ms | 29 640 ms | 35 ✅ |

Two consequences for anything that drives this panel:

1. **Wait for the batch to flush before clicking Close.** A person never closes a
   dialog under a second after their last click, which is why this is unreachable
   by hand and reproduces every time from automation.
2. **Budget for the refresh.** Taking the correct path makes `model_model` take
   **~30 s** to come back, not the ~4 s the broken path returns in. A 15 s budget
   turns the fix into a `model_model` visibility timeout.

Two conditions were measured and rejected as the wait: `waitForResponse` on the
toggle POST **races** — the batch is often already sent mid-loop, so the wait
times out while the write has in fact landed — and polling `GET enabled_models`
**stalls the backend** that is busy with the very write being waited on
(`apiRequestContext.get: Timeout 20000ms exceeded`).

This is handled for you inside `tests/helpers/provider-setup/` — do not
re-implement the toggle loop in a spec.

### 6. Run with --workers=1

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
