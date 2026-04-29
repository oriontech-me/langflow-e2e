# Spec: collect-models

**Test file:** `tests/collect-models.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

This is a utility spec — not a regression assertion test. It exists to populate two local data files used by LLM agent and model-provider specs as preconditions:

- `tests/helpers/provider-setup/data/models.json` — list of models available per provider (collected from Settings → Model Providers UI)
- `tests/helpers/provider-setup/data/providers.json` — provider status (`active` / `inactive`) validated via real API calls

If this spec is not run before the LLM agent specs, those specs fall back to a hardcoded model and may skip or fail due to missing provider configuration.

---

## Tags

`@stable`

---

## Step by step

1. Navigate to Settings → Model Providers
2. For each configured provider (OpenAI, Anthropic, Google):
   a. Click the provider entry to open its configuration panel
   b. If an API key is present in the environment and the panel is visible, enter the key and click Save / Replace
   c. Wait for model toggles to load; enable any that are unchecked
   d. Record each model name paired with the provider
3. Write the collected model list to `data/models.json`
4. For each provider, call its API directly (using the first model found) to confirm the key is active
5. Write the provider status records to `data/providers.json`

---

## Validation criterion

- `data/models.json` is written with at least one model per provider whose API key is set in the environment
- `data/providers.json` is written with one record per provider; `status` is `"active"` if the direct API call returned 2xx, `"inactive"` otherwise
- No unhandled exception is thrown; providers whose key is missing are recorded as `inactive` without failing the test

---

## External dependencies

- `src/frontend/src/pages/SettingsPage/pages/GlobalVariablesPage/index.tsx` — Settings navigation; if the `sidebar-nav-Model Providers` testid changes, the spec cannot reach the provider list
- `src/frontend/src/components/core/modelProviderTag/` — provider list items (testids like `provider-item-OpenAI`) and model toggles (`llm-toggle-*`); any rename breaks model collection
- `src/frontend/src/components/ui/button` — Save / Replace button labels; if these change the API key save step is silently skipped and `models.json` ends up empty

---

## What this test does not cover

- Does not assert that specific models are returned — only that the collection and file-write succeed
- Does not validate provider responses in detail — only checks HTTP status 2xx vs non-2xx
- Does not configure providers that lack an API key in the environment

---

## Preconditions

- Langflow instance running and accessible at `PLAYWRIGHT_BASE_URL`
- At least one provider API key set in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`)

---

## When to review this test

- Whenever the Settings → Model Providers UI changes button labels, testids, or layout
- Whenever a new provider is added to Langflow and should be included in the model collection

---

## Notes

- Run this spec before any LLM agent or model-provider specs: `npx playwright test tests/collect-models.spec.ts`
- If `models.json` is empty after running, check that the provider panel animates in before the form is read and that button labels match (`Save` / `Replace`)
