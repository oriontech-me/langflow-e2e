# Model Provider Model Toggle

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the per-model **enable/disable toggles** in **Settings → Model Providers** (the `ModelSelection` UI, shared by the settings page and the provider modal through `ModelProvidersContent`). Two behaviors are covered:

1. **Immediate change + persistence** — toggling a model updates the switch optimistically (immediately) and the change is persisted by the debounced `POST /api/v1/models/enabled_models` write (`useUpdateEnabledModels`, debounced ~1s by `useModelToggleQueue`). Leaving and reopening Model Providers reflects the persisted state (read back from `useGetEnabledModels`).
2. **Propagation to component dropdowns** — disabling a model in Settings removes it from the model dropdown of an intelligent component (the Agent's `model_model` picker) on the canvas; re-enabling brings it back. This is the cross-cutting effect driven by `useRefreshModelInputs`.

Both are pure UI/state assertions — no LLM call is made. No prior spec covered these toggles: `model-provider-modal-actions.spec.ts` only covers entering/removing API keys, and the only existing toggle tests are upstream Langflow unit tests, not this suite.

---

## Tags *(required)*

`@stable` `@regression` `@components` `@agents` `@model-provider`

- Test 1 (settings-only): `@stable` `@regression` `@components` `@model-provider`
- Test 2 (canvas propagation): adds `@agents`

---

## Step-by-step *(required)*

Both tests resolve a single provider — `MODEL_TEST_PROVIDER` when its env keys are set, otherwise the first provider in `providerConfigMap` with env keys configured. The file skips with an accurate reason when no provider has its env keys configured. The provider's display name (`provider-item-OpenAI`, etc.) comes from `provider-config.ts`.

### Test 1 — toggle changes immediately and persists across reopen

1. `SimpleAgentTemplatePage.load({ provider })` — configures the provider's API key globally and enables all its models (the known baseline). `MODEL_NOT_AVAILABLE` is caught and turned into a skip.
2. Navigate to **Settings → Model Providers**, expand the provider (`provider-item-...`), and wait for `model-provider-selection` and `llm-models-section`.
3. Read the first visible `llm-toggle-<model>` to derive a model name, filter the list to it via `model-search-input`, and assert it is enabled (`aria-checked="true"`).
4. Disable it: click the toggle, assert `aria-checked="false"` immediately (optimistic), and wait for the `POST .../enabled_models` response (debounced persistence flush).
5. Reload the app, reopen Model Providers, re-expand the provider, search for the same model and assert its toggle is still `aria-checked="false"` (persisted).
6. Restore the baseline: re-enable the model and assert `aria-checked="true"`.

### Test 2 — disabling a model removes it from a component dropdown

1. `SimpleAgentTemplatePage.load({ provider })` — same baseline (all models enabled, a model selected on the Agent). Capture the flow URL.
2. Open the Agent's `model_model` picker and collect the option names
   (`[data-testid$="-option"]`). **The dropdown mixes models from every
   configured provider** (#597 — with Google configured by sibling specs it
   listed `gemini-3.5-flash` first while the test's provider was OpenAI), so
   the options alone cannot pick the target.
3. In **Settings → Model Providers**, open the test's provider and read the
   attached `llm-toggle-<model>` testids — the provider's own model set.
   Pick the target as the first dropdown option that is **in that set** and
   is **not** the currently selected model (avoids entangling with
   selection-reset logic). Skip if the intersection is empty. Then disable
   the target (immediate + persisted, as in Test 1).
4. Return to the flow (`page.goto(flowUrl)`), open the `model_model` picker, and assert the target model option has count `0` (anchored exact-match regex so substrings like `gpt-4o` vs `gpt-4o-mini` don't collide).
5. Re-enable the target model in Settings, return to the flow, and assert the option reappears (count `1`).

---

## Validation criteria *(required)*

- Toggling a model flips `aria-checked` immediately (optimistic update).
- A `POST /api/v1/models/enabled_models` is sent after the debounce; reopening Model Providers reflects the persisted state.
- A disabled model disappears from the Agent's `model_model` dropdown; re-enabling restores it.
- The baseline is restored at the end of each test (model left enabled) so sibling specs are unaffected.

---

## Flow cleanup *(required)*

Both tests create a flow via `SimpleAgentTemplatePage.load()`, which does NO
cleanup (post-#553 contract). The spec tracks every `POST /api/v1/flows` →
201 id fired during load and deletes them by id in `test.afterEach`
(id-scoped — never name-based or delete-all; the file previously leaked 2
flows per run). Behavioral force-fail contract: no-op the cleanup and the
flow count grows.

---

## External dependencies *(required)*

- `src/frontend/src/modals/modelProviderModal/components/ModelSelection.tsx` — renders the `llm-toggle-<model_name>` / `embeddings-toggle-<model_name>` switches, the `llm-models-section` / `embeddings-models-section` containers, and `model-search-input`. Renaming these `data-testid` attributes breaks the test.
- `src/frontend/src/modals/modelProviderModal/components/ModelProvidersContent.tsx` and `pages/SettingsPage/pages/ModelProvidersPage/index.tsx` — host the model selection panel and the `provider-item-...` / `model-provider-selection` testids.
- `src/frontend/src/modals/modelProviderModal/hooks/useModelToggleQueue.ts` — the optimistic queue + ~1s debounced `POST .../enabled_models` write under test. Changing the endpoint or debounce affects the persistence wait.
- `src/frontend/src/hooks/use-refresh-model-inputs.ts` — refreshes component model dropdowns when toggles change (the propagation behavior in Test 2).
- `src/frontend/src/components/core/parameterRenderComponent/components/modelInputComponent/` — renders the Agent's `model_model` trigger, `value-dropdown-model_model` value span, and the `-option` dropdown entries.
- `tests/helpers/provider-setup/` and `data/models.json` — provider setup and model source of truth (populated by `collect-models`).

---

## What this test does not cover *(optional)*

- Embedding-model toggles (`embeddings-toggle-...`) — only LLM toggles are exercised.
- The provider modal entry point (`ModelProviderModal` with `onFlushRef`) — only the Settings page entry point is tested, where persistence relies on the debounce rather than a flush-on-close.
- Backend correctness of the enabled-models payload beyond the round-trip UI assertion.
- Deprecated-model rows (collapsed under `*-deprecated-disclosure`).

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- At least one provider has its env keys set (e.g. `OPENAI_API_KEY`). A real API key is required to configure the provider so models are listed, but no LLM call is made.
- Run with `--workers=1`: `SimpleAgentTemplatePage.load()` deletes all flows before loading the template, so parallel agent specs would wipe each other's flows. The spec also sets file-level serial mode.

---

## Notes *(optional)*

- Models are only listed once the provider has an API key configured — the spec cannot run standalone without provider setup.
- The `model-search-input` filter is used before reading a toggle so the target row is always rendered on-screen, regardless of how many models the provider exposes.
- The Settings page mounts `ModelProvidersContent` without `onFlushRef`, so persistence depends on the ~1s debounce; the test waits for the `POST` response rather than a fixed timeout.
