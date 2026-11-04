# API Models — the catalog read surface (`/api/v1/models`, `/api/v1/model_options`)

**File:** `tests/tests-automations/regression/api/models/api-models-catalog.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev14`)

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
| `GET /api/v1/models` | `200`, a list (52 KB) of provider objects. Every row carries `api_docs_url, icon, is_configured, is_enabled, live_discovery, mapping, models, num_models, provider, provider_id, variables`; every row whose `mapping` names a chat `model_class` also carries `max_tokens_field_name` (see *Two kinds of row* below). The rows are **not uniform**: `ibm-watsonx` adds `aliases`, `openai-compatible` and `vllm` add `display_name`, `openrouter` adds `base_url`, so the shape is asserted as a **required superset**, never as an exact key set |
| `GET /api/v1/models/providers` | `200`, a list of display-name **strings** (`"Anthropic"`, `"OpenAI"`, …) |
| `GET /api/v1/models/provider-descriptors` | `200`, a list of `{provider_id, display_name, provider}` — the longest of the three |
| `GET /api/v1/models/provider-variable-mapping` | `200`, an object keyed by **display name** (`Anthropic`, `Azure AI Foundry`, `Google Generative AI`, `IBM WatsonX`, `Ollama`, `OpenAI`, …) → the global-variable name each provider's key is stored under |
| `GET /api/v1/models/enabled_providers` | `200 {enabled_providers, provider_status}` |
| `GET /api/v1/models/enabled_models` | `200 {enabled_models, enabled_models_by_type}`; `enabled_models` is `{provider: {model_id: boolean}}` — all `false` on a keyless instance |
| `GET /api/v1/models/default_model` | `200 {"default_model": null}` when unset; the query parameter is **`model_type`** (`"language"` default, or `"embedding"`) — two separate stored variables |
| `GET /api/v1/models/default_model?model_type=<garbage>` | `200` — **not** a `422`: the route branches `language` vs *everything else*, so an unknown value silently reads the **embedding** slot |
| `GET /api/v1/model_options/language` | `200`, a list of option rows — **`[]` only when nothing is configured**. On a lane that ran the provider sweep each row carries at least `{category, icon, metadata, name, provider, provider_id}` |
| `GET /api/v1/model_options/embedding` | same shape, same dependency on the instance |

**The hierarchy, measured on `1.13.0.dev0`:** `/models` (9: anthropic, azure-ai-foundry,
google-generative-ai, ibm-watsonx, ollama, openai, openai-compatible, openrouter, vllm)
⊂ `/providers` (11: the same plus **Azure OpenAI** and **Groq**) ⊂
`/provider-descriptors` (14: plus **amazon**, **cohere**, **oracle**). So the catalog is
what the image can actually serve, the names are what the settings UI offers, and the
descriptors are the full identity space authorization can name. The spec asserts the
**subset relations**, never the counts — 9/11/14 is a packaging fact per image (#1040),
and it moved exactly that way: on `1.14.0.dev14` the same three read **11 / 13 / 16**,
**Perplexity** and **TypeSafe** having joined all three at once (next section).
`enabled_providers.provider_status` is keyed by the same display names as
`/providers`, asserted as a set equality.

**Two kinds of row since `1.14.0.dev8` (#2366).** Upstream langflow#15861 (merged into
`release-1.14.0` on 2026-10-27, between `dev7` and `dev8`) added **decision models** —
hosted models that return a typed judgment with probabilities instead of generated
text, used by Smart Router's decision mode and the Decision Model component. They
reach the catalog in two ways: two whole **decision providers**, `perplexity`
(`pplx-decider-latest`, `pplx-decider-flash-latest`) and `typesafe` (`jev-latest`), and
one decision model inside an existing chat provider (`openai` lists `gpt-6-luna` with
`model_type: "decision"` beside its `llm` and `embeddings` models). A decision
provider's row has `mapping: {}` — no chat `model_class`, because no LangChain chat
model is ever built for it (the decision adapters call the provider's HTTP endpoint
directly) — and **no `max_tokens_field_name`**. That absence is correct, not a dropped
field: the field exists to tell the chat-model instantiation which keyword carries the
token cap (`max_output_tokens` for Google, `max_tokens` elsewhere), and every reader of
it in the image treats it as optional — the catalog copies it only `if` present, and
the instantiation falls back to `"max_tokens"`. Checked on every row of `dev14`: the
only two rows without it are the two decision providers, and every chat row still
carries it. So the row contract is two-sided, and both sides are asserted:

- a row whose `mapping` names a chat `model_class` **must** carry a non-empty
  `max_tokens_field_name` — dropping it from a chat provider is the regression this
  file exists to catch (Google would silently be sent `max_tokens`);
- a row with **no** chat `model_class` is accepted only as a **decision-only** provider:
  at least one model, and every model `model_type: "decision"`. A chat provider that
  lost its `model_class` and its `max_tokens_field_name` together still fails, because
  its models are `llm`.

The first version required `max_tokens_field_name` of every row, which held while every
row was a chat provider and reddened the daily the night the first decision provider
shipped (run `20261028T080026Z`). Its assertion also stopped at the **first** offending
row, so the triage could not see that `typesafe` was missing it too; the rows are now
checked in full and every violation is named in one failure.

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

`@stable`: read-only, no run, and **no assertion depends on a credential being
present or absent**. That is a correction, not a design note: the first version
asserted `model_options === []` and reddened the PR lane, which configures providers
before running (`Collect models`). The content of `model_options` and whether a
`default_model` is set are properties of the **instance**, so this file asserts their
shape and leaves the round-trip to `api-models-selection.spec.ts`, which owns the
principal it writes to.

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`. No fixture
beyond an auth token; nothing is created, so there is nothing to clean up.

**Test 1 — `the three provider lists are a strict hierarchy, not three views of one list`**
1. `GET /models` → `200`, a non-empty list; every row carries the eleven universal
   fields as a superset, and satisfies the two-sided row contract above (a chat row
   names its `max_tokens_field_name`; a row without a chat `model_class` is
   decision-only). Every violating row is collected and named in a single failure;
   the row for a provider this suite depends on (`openai`) is present.
2. `GET /models/providers` → `200`; every element is a non-empty **string**; contains
   `"OpenAI"`.
3. `GET /models/provider-descriptors` → `200`; every row has exactly
   `{provider_id, display_name, provider}`; contains a descriptor for `openai`.
4. The three are asserted **by membership and shape, never by count** — a hardcoded
   9/11/14 would redden the day the image ships one more distribution (#1040).
5. `GET /models/provider-variable-mapping` → `200`; the `OpenAI` key maps to the
   variable name the resolvers expect.

**Test 2 — `the enabled and default reads hold their shape whether or not a provider is configured`**
1. `GET /models/enabled_providers` → `200` with both keys.
2. `GET /models/enabled_models` → `200` with both keys; `enabled_models` is an object
   of objects of booleans.
3. `GET /models/default_model`, with no query and with each `model_type` → `200` whose
   only key is `default_model`; when it is **not** null it is a
   `{model_name, provider, model_type}` triple. Not asserted as null — see the Tags
   note.
4. `GET /model_options/language` and `/embedding` → `200` and an array; every row (if
   any) carries the six required fields as a **superset**, since the sibling
   `/models` rows already vary by provider.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with the three
lists asserted on **membership and row shape** rather than length, the catalog row
contract asserted on **both** sides (a chat row without `max_tokens_field_name` fails;
a row with no chat class and a non-decision model fails), the variable mapping
asserted on the entry the resolvers read, and the declared coverage — the nine read
operations — matching what the fixture recorded. Zero writes issued, so nothing to
clean up and nothing another worker can observe.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/models.py` — the router under test.
- `src/backend/base/langflow/api/v1/model_options.py` — the two option endpoints.
- `src/lfx/src/lfx/base/models/model_metadata.py` — where each provider's row metadata,
  including `mapping` and `max_tokens_field_name`, is declared (Perplexity and TypeSafe
  are declared there with `mapping: {}` and no `max_tokens_field_name`).
- `src/lfx/src/lfx/base/models/unified_models/instantiation.py` — the consumer that
  makes `max_tokens_field_name` meaningful only for a chat `model_class`, and defaults
  it to `"max_tokens"` when absent.
- No provider key, no model, no network egress.
