# A flow run can execute a model from a different provider than the node selects

**Upstream:** [LE-2156](https://datastax.jira.com/browse/LE-2156)
**Found:** 2026-08-07 · **Measured on:** `1.12.0.dev19` (`langflowai/langflow-nightly`)
**Detected by:** `#1334` spec validation (PR #1369) → dedicated issue `#1372`
**Status:** Open

---

## Summary

When a `ModelInput` field's value is empty, `update_build_config` fills it with
`options[0]`. `options` is a **flat list across every enabled provider**, so the
model filled in is the first default-enabled model of the **first configured
provider** — frequently not the provider the node is configured for.

Because `POST /api/v2/workflows` carries the live-canvas `data` override, which
by its own schema *"takes priority over the saved flow data"*, whatever the
editor filled in is what actually runs. The persisted flow can still hold the
correct selection at that moment.

**Net effect:** a flow can execute a model the persisted flow does not name,
from a provider the user never selected, with no error.

## How it surfaced here

`openai-compatible-provider-setup.spec.ts` failed **2 in 12** full-file runs
with:

```text
Error code: 404 - {'error': {'message': 'This is not a chat model and thus not
supported in the v1/chat/completions endpoint. Did you mean to use
v1/completions?', 'type': 'invalid_request_error', 'param': 'model'}}
```

`gpt-4o-mini` **is** a chat model. The only ids that provider offers which
produce that error are its completions-only ones (`babbage-002` / `davinci-002`)
— the first entries of its default-enabled set.

## Reproduction (deterministic)

Against `POST /api/v1/custom_component/update` — the endpoint the editor itself
uses — on an instance with Anthropic, Google Generative AI and OpenAI
configured, with a `LanguageModelComponent` node and `field: "model"`:

| `field_value` sent | returned `model.value` | verdict |
|---|---|---|
| `[{name: "gpt-4o-mini", provider: "OpenAI Compatible"}]` | unchanged | preserved |
| `[{name: "definitely-not-a-model", provider: "Nope"}]` | unchanged | preserved |
| `[{name: "gpt-4o-mini", provider: "OpenAI"}]` | unchanged | preserved |
| `[]` | `[{name: "claude-opus-5", provider: "Anthropic", …}]` | **replaced** |

The last row is the defect: the node's own provider is irrelevant to what it is
filled with. `options[0]` is Anthropic's first default-enabled model purely
because Anthropic comes first in the enabled-provider iteration order.

## Why it is usually silent — the reason this matters beyond one 404

The OpenAI-Compatible case fails **loudly** only because that provider's
default-enabled set is derived from the endpoint's own `GET <base_url>/v1/models`
and starts with completions-only ids. Measured on `1.12.0.dev19`, every other
provider's `options[0]` is a working chat model:

| Provider | `options[0]` |
|---|---|
| Anthropic | `claude-opus-5` |
| Google Generative AI | `gemini-3.5-flash-lite` |
| OpenAI | `gpt-5.6-sol` |
| Azure AI Foundry | `gpt-4o` |
| Ollama | `llama3.3` |
| OpenRouter | `anthropic/claude-opus-4.7` |

**6 of 8.** In those cases the substitution produces a *passing* run against a
model nobody selected, on a provider nobody selected, billed to that provider's
account — the #1169 silent-substitution class, one layer deeper.

## Source

`lfx/base/models/unified_models/build_config.py`:

```python
build_config[model_field_name]["value"] = (
    field_value if value_is_valid else [options[0]] if options else "")
```

`lfx/base/models/unified_models/model_catalog.py` — `get_language_model_options`
accumulates **one flat list** across providers:

```python
for provider_data in all_models:
    if provider not in enabled_providers:
        continue
    for model_data in models:
        ...  # appended to the same `options`
```

## What is NOT the cause — refuted by experiment, not by argument

What *empties* the field on a node that had a selection is **not established**.
Two candidate backend paths were tested and both died:

1. **Not an invalid-selection reset.** A deliberately impossible model
   (`definitely-not-a-model` / `Nope`) is **preserved**, so the `[options[0]]`
   branch does not fire for out-of-catalog values.
2. **Not an empty `options` list wiping the value.** With every provider
   credential deleted, `options` comes back as **1**, not 0 — the current
   selection is injected into the options — and the value is **preserved**.

Both are backend paths, so the trigger looks like **editor/frontend state** that
never round-trips through `update_build_config`.

The **run path is not responsible** either: `get_llm`
(`lfx/base/models/unified_models/instantiation.py`) raises
`"A model selection is required"` on an empty list and `"The selected model is
missing a provider"` on a blank provider. It never falls back to a default.

## The observable, and why the obvious one cannot work

`POST /api/v2/workflows` sends the canvas. Captured on a **healthy** run — no
flake needed:

```text
keys = flow_id, input_value, mode, stream_protocol, session_id, start_component_id, data
data = PRESENT   data.nodes = 6
node LanguageModelComponent-FLeYF
  model.value = [{"name":"claude-opus-5","provider":"Anthropic",...,"default":true}]
```

`lfx/schema/workflow.py`, `WorkflowRunRequest`:

> `data` — *"Optional live-canvas override of the flow's nodes/edges; takes
> priority over the saved flow data."*

So `GET /api/v1/flows/{id}` is **structurally incapable** of predicting the
executed model. That is not a weak observable — it is the wrong object, and no
amount of strengthening the persisted-binding poll could have caught this. The
only observable that predicts the run is the `data` payload of the run request.

This is why `openai-compatible-provider-setup.spec.ts` keeps its pre-send
re-read as **attribution, not repair** (#1369): a re-selection loop was written,
measured against this, and removed — re-selecting cannot fix a state that is
already correct.

## Honesty about the rate

The pre-fix baseline over 12 runs of the untouched spec reproduced the 404
**zero** times. The runner reported *"3/12 failed (25 %)"*, but two of those
three carry `unexpected=0` — no test failed at all, they were classified as
failures because a backend error was logged — and the single genuine failure
carries `TimeoutError: page.waitForResponse: Timeout 60000ms exceeded`, a
different symptom.

The finding therefore rests on the deterministic experiment above, not on
frequency.

## Suggested fix direction

The fill is reasonable on a genuinely new node; crossing providers is not.
Scoping the default to the node's current provider — or refusing to fill when
the node already carries a provider identity — turns a silent cross-provider
substitution into either the right model or a visible error.
