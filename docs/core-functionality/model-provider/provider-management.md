# Provider Management — modal, provider count, components, add/remove API key

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

The **Model Providers** management surface (QA-CHECKLIST §7.5), across six
existing specs promoted to `@stable` after hardening (issue #505):

| Spec | Behaviors |
|---|---|
| `modelProviderModal.spec.ts` | Provider list renders; selecting a provider opens its detail; a configured provider shows its model-selection panel |
| `model-provider-modal-actions.spec.ts` | Page opens with description; **available provider count**; an invalid API key is rejected (does not enable the provider) |
| `model-provider-api-key.spec.ts` | OpenAI/Anthropic listed; **adding a real key via the page enables the provider** (delete→re-add cycle with the OpenAI key) |
| `remove-provider-api-key.spec.ts` | A provider credential (global variable) can be removed via UI and via API |
| `modelInputComponent.spec.ts` | The Language Model component's model selector renders, opens, lists models, and shows the selected model |
| `language-model-regression.spec.ts` | LM answers with OpenAI; answers with Google; provider switch (OpenAI → Google) persists on the node; "Manage Model Providers" opens the provider dialog from the node |

> **Hardening note (issue #505):** the six specs pre-dated the model-bundle
> refactor and "passed" without testing — dead assertions
> (`expect(x || true).toBe(true)`), whole bodies inside `if (visible)` guards,
> and silent early-return chains (observed: 2 tests "passing" while logging
> `skipping`; the variables API test "passed" on a 422). Promotion to `@stable`
> requires the force-failure check, so every weak assertion was replaced with a
> real one against live-scouted testids before tagging.

> **Provider strategy (no Anthropic needed):** key-validation on Save performs
> a real 1-token inference (`llm.invoke("test")`, `max_tokens=1` —
> `lfx/base/models/unified_models/credentials.py`), so add-key tests need a
> **funded, real key**. The suite already has two: `OPENAI_API_KEY` (the only
> one present in CI) and `GOOGLE_API_KEY` (local). The add-key test recycles
> the OpenAI credential (delete → re-add, net state identical); multi-provider
> behavior uses Google. **OpenAI is the "configured provider" reference** —
> it is configured in both environments (CI runs `collect-models` with the
> OpenAI secret; the fresh CI container has no Google key until the
> `GOOGLE_API_KEY` secret is added — flagged on the PR).

If these fail, provider configuration — the gateway for every LLM feature — is
broken or its UI has drifted.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace` `@model-provider` (per test,
at least one cross-cutting + `@model-provider`; `@components` on the
node-level specs).

`@stable` added only after multiple clean `--retries=0` runs on the fresh
nightly, per test file.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` in `.env` (funded) — the add-key cycle, the
  configured-provider assertions, and the LM execution test T1.
- `GOOGLE_API_KEY` in `.env` (funded) — the LM Google/switch tests
  (`test.skip` without it). **CI note:** `daily-stable` currently injects only
  `OPENAI_API_KEY`; the Google-dependent tests skip there until the
  `GOOGLE_API_KEY` secret is added (workflow env updated in this PR; secret is
  a maintainer action — flagged).
- The settings-page specs are parallel-safe; the LM execution spec keeps the
  template machinery serial (`--workers=1`).

---

## Step by step *(required)*

Live-scouted testids (dev33; re-scouted on 1.12.0.dev9): `provider-list`,
`provider-item-<Name>` — 8 providers on 1.11 (Google Generative AI, OpenAI,
Anthropic, IBM WatsonX, Ollama, OpenAI Compatible, OpenRouter, vLLM), **9 on
1.12** (`Azure AI Foundry` added). `GET /api/v1/models/providers` returns a
wider set (11 on dev9 — it also lists Groq and Azure OpenAI, which the page
does not render); the page, not the API, is the contract here.
`provider-search-input`,
`provider-variable-input-<VAR>` (e.g. `OPENAI_API_KEY`, `OPENROUTER_API_KEY`),
`model-provider-selection`, `model-search-input`, `llm-toggle-<model>`,
`embeddings-toggle-<model>`; Save/Cancel/Confirm buttons (by role+name);
configured providers show a **"N models"** suffix in their list item and a
**Replace** button in their detail. LM node: `add-component-button-language-model`,
`model_model` / `value-dropdown-model_model`, dropdown options `<model>-option`.

**`modelProviderModal.spec.ts`**
1. *Provider list renders* — Settings → Model Providers; assert `provider-list`
   visible and the 8 known `provider-item-*` present. **This spec owns the
   by-name contract**: a known provider silently dropping from the page fails
   here. Providers added after 1.11 (`Azure AI Foundry`) are deliberately not
   pinned — a new catalog entry is not a regression.
2. *Provider detail opens* — click `provider-item-OpenRouter` (unconfigured):
   assert its `provider-variable-input-OPENROUTER_API_KEY` becomes visible.
3. *Configured provider shows model selection* — click `provider-item-OpenAI`
   (configured in both environments; skip without `OPENAI_API_KEY`): assert
   `model-provider-selection` and at least one `llm-toggle-*` visible.

**`model-provider-modal-actions.spec.ts`**
1. *Page opens with description and provider count* — assert the description
   text and `provider-item-*` count **≥ `MIN_PROVIDER_COUNT` (8)** (§7.5
   "Available provider count").

   > **Count contract: floor, not exact** (decided on issue #993). The
   > assertion is `toBeGreaterThanOrEqual`, never `toHaveCount` — the risk this
   > test exists to catch is *the provider list failing to render*, not Langflow
   > shipping a new provider. An exact count couples the suite to the live
   > catalog and breaks on unrelated additions: it was authored as
   > `toHaveCount(8)`, went red when 1.11 shipped a 9th provider (#704 → #721,
   > which closed with `@stable` off and the assertion untouched), and was still
   > red on 1.12.0.dev9 (9 items: the 1.11 eight plus `Azure AI Foundry`).
   > `MIN_PROVIDER_COUNT` stays at the 1.11 baseline of **8** — a page rendering
   > fewer providers than 1.11 did is a real shrink. By-name coverage is not
   > lost: `modelProviderModal.spec.ts` pins each known provider individually,
   > so a provider disappearing still fails there.
2. *Invalid key is rejected* — OpenRouter detail → fill
   `provider-variable-input-OPENROUTER_API_KEY` with a fake key → Save →
   assert the item does **not** gain the "models" suffix AND the API confirms
   no `OPENROUTER_API_KEY` variable was created (backend validates the key —
   scouted live: fake key leaves no variable and no badge).
3. *Detail panel toggles per provider* — clicking another provider switches
   the visible detail (the previously open input disappears, the new one
   renders).

**`model-provider-api-key.spec.ts`**
1. *OpenAI listed* — `provider-item-OpenAI` visible (exact testid, no
   text-match fallback).
2. *Anthropic listed* — `provider-item-Anthropic` visible.
3. *Configured provider exposes the key edit surface* (skip with a reason if
   the instance has no stored `OPENAI_API_KEY`) — the OpenAI item shows the
   `N models` badge and its detail shows **Replace** (masked key, no raw
   input); Replace opens `provider-variable-input-OPENAI_API_KEY`; Cancel
   restores the masked state. **Zero writes** — see the cache-poisoning note
   below for why a real add cycle is not exercised.

**`remove-provider-api-key.spec.ts`**
1. *UI removal* — create a uniquely-named credential variable via
   `POST /api/v1/variables/` (fix: the endpoint now **requires**
   `default_fields: []` — the old spec 422'd and "passed"), then delete it
   through the Settings → Global Variables UI and assert the row is gone. No
   silent early-returns: every intermediate element is a hard assertion.
2. *API removal* — POST (with `default_fields`), DELETE → 200/204, GET-by-id
   → 404/422, list no longer contains it (hard-fail on non-2xx create).

**`modelInputComponent.spec.ts`** — migrated from the legacy `modelsOpenAI`
sidebar entry to the canonical **Language Model** component:
1. *Model selector renders* — blank flow → add
   `add-component-button-language-model` → assert node + `model_model`
   visible.
2. *Dropdown opens with model options* — click `model_model` → assert ≥ 1
   `*-option` entries render.
3. *Dropdown lists models from multiple providers* — assert options from more
   than one provider are present (the unified catalog behavior).
4. *Trigger shows the selected model* — assert `model_model` text is a
   non-empty model name (catalog default, e.g. `gemini-3.5-flash`).

**`language-model-regression.spec.ts`**
1. *OpenAI answers* (skip without `OPENAI_API_KEY`) — Basic Prompting +
   `initialGPTsetup`, run, playground "What is 2+2?" → reply matches `/4/`.
2. *Google answers* (skip without `GOOGLE_API_KEY`) — same flow via
   `setupGoogle`, non-empty reply. (Replaces the former Anthropic test — same
   contract, a second provider the suite already holds a funded key for.)
3. *Provider switch persists* (skip without both keys) — after switching
   OpenAI → Google, the node's `model_model` shows a `gemini` model.
4. *Manage Model Providers opens from the node* — click the LM node's
   `model_model` dropdown → "Manage Model Providers" → assert
   `provider-item-OpenAI` visible in the dialog (hard assertions, no
   if-wrapping).

---

## Validation criterion *(required)*

Every test asserts a **specific, live-scouted observable** (testid visibility,
count floor, API state) with no conditional bypass: each one fails when its
behavior breaks (verified by force-failure during promotion). Counts are
asserted as a **floor against the 1.11 baseline**, never as an exact match —
see the #993 note under `model-provider-modal-actions.spec.ts` above. The §7.5
behaviors — modal, provider count, component configuration, add key (real
accepted / fake rejected), remove key — are each pinned by at least one test.

## Guarding against false positives *(how)*

- **No dead assertions** — every `expect(x || true)`-style always-pass and
  every `if (visible) { expect }` wrapper was removed; missing UI now fails.
- **No silent early-returns** — unmet preconditions are hard failures (or an
  explicit `test.skip` with a reason, for missing provider keys only).
- **Fake-key negative control** — the rejected-key test proves Save actually
  validates, so the add-key test's "models suffix" cannot appear spuriously.
- **API cross-checks** — variable creation/removal asserted through
  `/api/v1/variables/` in addition to the UI.
- **State restore** — the add-key cycle ends in the same configured state it
  started from; the fake-key test verifies nothing was created.

---

## What this test does not cover *(optional)*

- Anthropic execution (no funded key in the environment; the multi-provider
  contract is covered via Google — re-scope if an Anthropic key lands).
- Groq/Mistral provider specs (issues #499/#500 — those providers are not in
  the current provider list; flagged there).
- Per-model enable/disable toggles (covered by
  `model-provider-model-toggle.spec.ts`).
- Provider key expiry/invalidation after configuration.

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/` — Model Providers page
  (`provider-list`, `provider-item-*`, `provider-variable-input-*`,
  `model-provider-selection`).
- `src/backend/base/langflow/api/v1/variables.py` — variables CRUD (the
  `default_fields` requirement; key storage behind providers).
- `src/lfx/base/models/unified_models/credentials.py` — key validation on
  Save (real 1-token inference per provider).
- `src/frontend/src/components/` model input — `model_model` dropdown and
  `<model>-option` entries.
- OpenAI + Google live APIs for the execution and add-key tests (real calls).

---

## When to review this test *(optional)*

- If the provider list gains/loses providers (count assertion floor of 8).
- If `provider-variable-input-<VAR>` or `llm-toggle-<model>` testids change.
- If Save stops validating keys server-side (the negative control would then
  need a different observable).
- When the `GOOGLE_API_KEY` secret lands in CI (Google tests stop skipping).

---

## Notes *(optional)*

- **Fake keys never configure a provider** — Save validates against the
  provider's API with a real 1-token inference; a rejected key creates no
  variable and no badge (scouted live). A positive add test would therefore
  need a real, **funded** key — a valid key with no credits fails validation
  the same way a fake one does.
- **Credential delete → re-add poisons a server-side cache (suspected
  Langflow bug, flagged on the PR):** a delete→re-add cycle with the real
  OpenAI key passed its own assertions (badge back, variable stored, Save
  validation succeeded), but every subsequent flow build received the
  **wrong provider's key** — the OpenAI node was sent the Google key and
  401'd (`Incorrect API key provided: AIza…`) until the backend container
  restarted. This reproduced 4/4 and disappeared immediately after a restart.
  That is why the add surface is validated by the fake-key negative control +
  the Replace/Cancel edit surface, with zero writes to real credentials.
- **Configured providers expose only Replace** in their detail — key removal
  happens through the Global Variables surface (UI or API), which is what the
  remove spec exercises.
- **The provider detail is an accordion** — clicking an item toggles its
  panel; assertions must target the specific provider's elements, not
  "any input".
- **The Google key is never touched** — it is the standing local provider the
  agent specs depend on; the add-key cycle recycles the OpenAI credential and
  ends in the identical configured state.
