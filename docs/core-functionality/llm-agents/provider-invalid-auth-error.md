# provider-invalid-auth-error

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that Langflow displays an error message to the user when they try to save an invalid API key on the Model Providers configuration screen (Settings → Model Providers). The key must not be accepted and the provider must not be configured successfully.

Protects against regressions in the integration between the frontend (ProviderConfigurationForm) and the `POST /api/v1/models/validate-provider` endpoint, which validates the credential against the external provider before persisting.

---

## Tags *(required)*

`@stable` `@regression` `@model-provider` `@agents`

---

## Step by step *(required)*

1. Navigate to Settings → Model Providers → [provider]
2. Fill the API key field with an invalid key (e.g.: `sk-invalid-openai-key-for-testing-12345`)
3. Click "Save Configuration"
4. Wait for the error toast `.error-build-message` with text matching "Invalid API key"
5. (finally) Restore the provider's original valid key

The test is parameterized: runs for each provider that has an env var configured (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`).

---

## Validation criterion *(required)*

- The toast `.error-build-message` must be visible after clicking Save with an invalid key
- The toast text must match `/Invalid API key/i`
- The timeout is 30 seconds because the validation makes a real HTTP call to the external provider

---

## External dependencies *(required)*

- `src/frontend/src/modals/modelProviderModal/components/ProviderConfigurationForm.tsx` — renders the API key form and triggers the error toast
- `src/frontend/src/modals/modelProviderModal/hooks/useProviderConfiguration.ts` — validation logic, calls the endpoint and manages the `validationState`
- `src/frontend/src/alerts/error/index.tsx` — visual component of the toast `.error-build-message`
- `src/backend/base/langflow/api/v1/models.py` — endpoint `POST /api/v1/models/validate-provider`
- `src/backend/base/langflow/services/credentials.py` — function `validate_model_provider_key`, which tests the key against the provider and returns `"Invalid API key for {provider}"`

---

## What this test does not cover *(optional)*

- Validation of keys with correct format but expired or revoked (identical behavior, but depends on the key state at the provider)
- Providers beyond OpenAI, Anthropic and Google (e.g.: IBM WatsonX, Ollama)
- State persistence after error (verifying that the previous key remains active)

---

## Preconditions *(optional)*

- At least one provider env var configured in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `GOOGLE_API_KEY`)
- Langflow running and accessible via `PLAYWRIGHT_BASE_URL`
- Internet access so the backend can call the external provider during validation

---

## Notes *(optional)*

- The 30s timeout in `expect` is required because the backend calls `llm.invoke("test")` against the real provider — the error response from the provider can take several seconds
- The `data-testid` of providers in the sidebar follows the pattern `provider-item-{ProviderName}` (e.g.: `provider-item-OpenAI`)
