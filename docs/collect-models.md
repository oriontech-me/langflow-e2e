# Collect Models

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

This is a utility spec — not a regression assertion test. It exists to populate two local data files used by LLM agent and model-provider specs as preconditions:

- `tests/helpers/provider-setup/data/models.json` — list of models available per provider (collected from Settings → Model Providers UI)
- `tests/helpers/provider-setup/data/providers.json` — provider status (`active` / `inactive`) validated via real API calls

If this spec is not run before the LLM agent specs, those specs fall back to a hardcoded model and may skip or fail due to missing provider configuration.

---

## Tags *(required)*

`@stable` `@model-provider` `@settings`

Promoted by issue #501 (QA-CHECKLIST §7.1 ×4: key validation via real call,
model collection via UI, Save Configuration, Replace/Disconnect state).
Historically untagged as "just a setup helper" — promotion required a
force-failability hardening pass (see Validation criterion): the previous
contract ("never throws") meant a fully broken Model Providers UI still
produced a green run with empty JSONs, which would blind the daily on this
surface (the #505 lesson).

---

## Step by step *(required)*

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

## Validation criterion *(required)*

Hard asserts in the spec, executed AFTER `collectAll` (the helper itself
stays tolerant — writing "inactive" records instead of throwing is its
contract; the SPEC now verifies the outcome):

- `data/providers.json` exists and contains exactly one record per known
  provider (`openai`, `anthropic`, `google`), each with
  `status ∈ {active, inactive}` and a `checkedAt` timestamp;
- every provider recorded `active` contributed **at least one model** to
  `data/models.json` (an active key with an empty model collection means the
  Settings UI collection broke — the exact silent failure the old contract
  hid);
- every provider with its env key set that came back `inactive` carries a
  non-empty `error` (the probe's reason is visible, never silently dropped).

A provider with a key that genuinely fails its probe (e.g. a model the
account cannot access) is a legitimate `inactive` — recorded, logged, not a
test failure.

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/GlobalVariablesPage/index.tsx` — Settings navigation; if the `sidebar-nav-Model Providers` testid changes, the spec cannot reach the provider list
- `src/frontend/src/components/core/modelProviderTag/` — provider list items (testids like `provider-item-OpenAI`) and model toggles (`llm-toggle-*`); any rename breaks model collection
- `src/frontend/src/components/ui/button` — Save / Replace button labels; if these change the API key save step is silently skipped and `models.json` ends up empty

---

## What this test does not cover *(optional)*

- Does not assert that specific models are returned — only that the collection and file-write succeed
- Does not validate provider responses in detail — only checks HTTP status 2xx vs non-2xx
- Does not configure providers that lack an API key in the environment

---

## Preconditions *(optional)*

- Langflow instance running and accessible at `PLAYWRIGHT_BASE_URL`
- At least one provider API key set in `.env` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`)

---

## When to review this test *(optional)*

- Whenever the Settings → Model Providers UI changes button labels, testids, or layout
- Whenever a new provider is added to Langflow and should be included in the model collection

---

## Notes *(optional)*

- In CI (`daily-stable.yml`) this spec runs as a dedicated **Collect models** step before the `@stable` suite, ensuring `models.json` is on disk before Playwright's collection phase. The step uses `continue-on-error: true` so a missing API key does not block the rest of the run.
- **Double-run in the daily (analyzed, benign):** with `@stable` the spec ALSO runs inside the suite. The in-suite run re-saves the same keys (the exact flow `openai-provider`/`google-provider` test 1 already exercise in-suite) and rewrites the JSONs with equivalent content; workers read the files at module load, so a mid-suite rewrite does not change already-collected test targets.
- Run this spec locally before any LLM agent or model-provider specs: `npx playwright test tests/collect-models.spec.ts`
- If `models.json` is empty after running, check that the provider panel animates in before the form is read and that button labels match (`Save` / `Replace`)
