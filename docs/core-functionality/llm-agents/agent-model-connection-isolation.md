# Agent Model Connection Isolation

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that selecting **"Connect other models"** in the Agent component's model picker isolates the node from its previously selected provider/model — the node drops the concrete model selection and enters connection mode, so a stale provider configuration cannot be used in a backend run when an external `LanguageModel` is meant to be wired in instead.

In Langflow 1.11 the Agent no longer exposes inline per-provider credential fields on the node (provider credentials are global, managed under **Settings → Model Providers** via the unified model picker). The only node-level "provider field isolation" left is the connection-mode clear performed by `useModelConnectionLogic`: it resets the `model` field value to `[]` and wipes every `password` / `SecretStrInput` field on the node. The visible effect is that the picker trigger stops showing the previously selected model name and instead shows the "Connect other models" connection-mode label.

This is a pure UI/state assertion — no LLM call is made.

---

## Tags *(required)*

`@stable` `@regression` `@components` `@agents` `@model-provider`

---

## Step-by-step *(required)*

1. Resolve a single `{ provider, model }` target: `MODEL_TEST_ID` wins (its provider is inferred from `models.json`, falling back to `MODEL_TEST_PROVIDER`); otherwise the first model of `MODEL_TEST_PROVIDER` (or of the first env-configured provider) is read from `helpers/provider-setup/data/models.json`. The test skips with an accurate reason when no provider resolves — either no provider has its env keys configured, or a given `MODEL_TEST_ID` could not be mapped to a provider.
2. `SimpleAgentTemplatePage.load({ provider, model })` — loads the Simple Agent template, configures the provider via the unified model picker (Manage Model Providers → API key → enable models) and selects the resolved model. `MODEL_NOT_AVAILABLE` is caught and turned into a skip.
3. Assert the picker trigger `model_model` is visible.
4. Capture the selected model label from `value-dropdown-model_model` and assert it is non-empty and not the `"Select a model"` placeholder (a concrete model is selected — the precondition).
5. Open the picker (`model_model`) and click the `connect-other-models` footer button. If that option is not present (no compatible external `LanguageModel` type registered), skip.
6. Assert `value-dropdown-model_model` now reads `"Connect other models"` and no longer contains the previously selected model name.

---

## Validation criteria *(required)*

- Before the action, the Agent's model picker shows a concrete model name (not the placeholder).
- After choosing "Connect other models", the picker trigger displays the `"Connect other models"` connection-mode label.
- The previously selected model name is no longer present in the trigger, confirming the prior selection was dropped (and, per `useModelConnectionLogic`, the model value and secret fields were cleared).

---

## External dependencies *(required)*

- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/` — renders the `model_model` trigger, the `value-dropdown-model_model` value span, and the `connect-other-models` footer button. Renaming these `data-testid` attributes breaks the test.
- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/hooks/useModelConnectionLogic.ts` — the connection-mode clear logic under test (resets `model` to `[]`, wipes `password`/`SecretStrInput` fields). Changing this behavior changes the expected outcome.
- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/components/ModelTrigger.tsx` — derives the displayed label; the `"Connect other models"` label in connection mode is the assertion's anchor.
- `tests/helpers/provider-setup/` and `data/models.json` — provider setup and the model source of truth (populated by `collect-models`).

---

## What this test does not cover *(optional)*

- Actually wiring an external `LanguageModel` component and running the flow with it.
- Backend-level verification that the cleared secret fields are absent from the persisted/executed config (asserted only indirectly via the UI label change).
- Provider credential configuration correctness (covered by the provider-setup helpers and provider-management specs).

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- At least one provider has its env keys set (e.g. `OPENAI_API_KEY`). A real API key is needed to configure the provider so the picker lists models, but no LLM call is made.
- `models.json` populated by `collect-models` (otherwise the resolved model may be `undefined` and `setup-openai`'s default is used).

---

## Notes *(optional)*

- In connection mode, `selectedModel` is intentionally overridden to `{ name: "Connect other models" }` in `modelInputComponent/index.tsx`, which is why the trigger shows that label rather than the empty `"Select a model"` placeholder.
- Run with `--workers=1`: `SimpleAgentTemplatePage.load()` deletes all flows before loading the template, so parallel agent specs would wipe each other's flows. The spec also sets file-level serial mode.
- The spec is provider-agnostic and runs a single target on purpose — the connection-mode clear does not vary by provider, so looping every model would add cost without coverage.
