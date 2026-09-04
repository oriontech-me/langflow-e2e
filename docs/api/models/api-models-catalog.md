# API Models — the catalog read surface (`/api/v1/models`, `/api/v1/model_options`)

**File:** `tests/tests-automations/regression/api/models/api-models-catalog.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1709 (Wave 7 — OSS API coverage, `models` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The nine read operations of the family — the surface **this suite's own infrastructure
consumes** (`scripts/collect-models.*` and every provider resolver) and which nothing
asserts. All nine are hidden from `/openapi.json`, so no schema-derived count sees them.

**The finding this file pins: three endpoints answer three different provider counts,
and each answers a different question.** Measured on one instance at one moment —
`GET /models` → **9**, `GET /models/providers` → **11**, `GET /models/provider-descriptors`
→ **14**. Read from the router source: `/models` is the *catalog the UI renders from*,
`/providers` is display names, and `provider-descriptors` is the **stable provider
identity for authorization and administrative pickers** (`ModelProviderDescriptorRead`),
which is why it is the longest. No test states which is which, so any of them silently
changing membership or shape is invisible today.

Measured contracts (`1.13.0.dev0`, keyless instance):

| Operation | Answer |
|---|---|
| `GET /api/v1/models` | `200`, a list (52 KB) of provider objects. Every row carries `api_docs_url, icon, is_configured, is_enabled, live_discovery, mapping, max_tokens_field_name, models, num_models, provider, provider_id, variables` — and the rows are **not uniform**: `ibm-watsonx` adds `aliases`, `openai-compatible` and `vllm` add `display_name`, `openrouter` adds `base_url`, so the shape is asserted as a **required superset**, never as an exact key set |
| `GET /api/v1/models/providers` | `200`, a list of display-name **strings** (`"Anthropic"`, `"OpenAI"`, …) |
| `GET /api/v1/models/provider-descriptors` | `200`, a list of `{provider_id, display_name, provider}` — the longest of the three |
| `GET /api/v1/models/provider-variable-mapping` | `200`, an object keyed by **display name** (`Anthropic`, `Azure AI Foundry`, `Google Generative AI`, `IBM WatsonX`, `Ollama`, `OpenAI`, …) → the global-variable name each provider's key is stored under |
| `GET /api/v1/models/enabled_providers` | `200 {enabled_providers, provider_status}` |
| `GET /api/v1/models/enabled_models` | `200 {enabled_models, enabled_models_by_type}`; `enabled_models` is `{provider: {model_id: boolean}}` — all `false` on a keyless instance |
| `GET /api/v1/models/default_model` | `200 {"default_model": null}` when unset; the query parameter is **`model_type`** (`"language"` default, or `"embedding"`) — two separate stored variables |
| `GET /api/v1/models/default_model?model_type=<garbage>` | `200` — **not** a `422`: the route branches `language` vs *everything else*, so an unknown value silently reads the **embedding** slot |
| `GET /api/v1/model_options/language` | `200 []` on a keyless instance |
| `GET /api/v1/model_options/embedding` | `200 []` on a keyless instance |

**The hierarchy, measured on `1.13.0.dev0`:** `/models` (9: anthropic, azure-ai-foundry,
google-generative-ai, ibm-watsonx, ollama, openai, openai-compatible, openrouter, vllm)
⊂ `/providers` (11: the same plus **Azure OpenAI** and **Groq**) ⊂
`/provider-descriptors` (14: plus **amazon**, **cohere**, **oracle**). So the catalog is
what the image can actually serve, the names are what the settings UI offers, and the
descriptors are the full identity space authorization can name. The spec asserts the
**subset relations**, never the counts — 9/11/14 is a packaging fact per image (#1040).
`enabled_providers.provider_status` is keyed by the same 11 display names as
`/providers`, asserted as a set equality.

The `model_type` misroute is asserted the only way that proves it: set an **embedding**
default (as the throwaway user of the sibling spec's fixture pattern), then read with a
garbage `model_type` and observe the embedding value coming back.

Two further properties read from the router and worth knowing before extending this
file: every route is **`current_user`-scoped** (the "enabled" and "default" state lives
in that user's global variables, not in instance settings), and the `default_model` read
is **policy-filtered** — a default whose provider a `@governance` policy disallows comes
back as `null` rather than as an error.

---

## Tags *(required)*

`@api` `@model-provider` `@stable`

`@stable`: read-only, keyless, no run. The empty `model_options` list is the honest
keyless state and is asserted as such.

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`. No fixture
beyond an auth token; nothing is created, so there is nothing to clean up.

**Test 1 — `the three provider lists answer three different questions`**
1. `GET /models` → `200`; every row has `provider_id` and `icon`; the row for a
   provider this suite depends on (`openai`) is present.
2. `GET /models/providers` → `200`; every element is a non-empty **string**; contains
   `"OpenAI"`.
3. `GET /models/provider-descriptors` → `200`; every row has exactly
   `{provider_id, display_name, provider}`; contains a descriptor for `openai`.
4. The three are asserted **by membership and shape, never by count** — a hardcoded
   9/11/14 would redden the day the image ships one more distribution (#1040).
5. `GET /models/provider-variable-mapping` → `200`; the `OpenAI` key maps to the
   variable name the resolvers expect.

**Test 2 — `the enabled and default reads describe a keyless instance`**
1. `GET /models/enabled_providers` → `200` with both keys.
2. `GET /models/enabled_models` → `200` with both keys; `enabled_models` is an object
   of objects of booleans.
3. `GET /models/default_model` → `200 {"default_model": null}`; the same for
   `?model_type=embedding`.
4. `GET /model_options/language` and `/embedding` → `200 []`.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with the three
lists asserted on **membership and row shape** rather than length, the variable mapping
asserted on the entry the resolvers read, and the declared coverage — the nine read
operations — matching what the fixture recorded. Zero writes issued, so nothing to
clean up and nothing another worker can observe.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/models.py` — the router under test.
- `src/backend/base/langflow/api/v1/model_options.py` — the two option endpoints.
- No provider key, no model, no network egress.
