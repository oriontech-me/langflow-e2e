# Single-Trace API — populated LLM-span values on `GET /api/v1/monitor/traces/{trace_id}`

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

`traces-detail-single.spec.ts` (PR #305 / #299) pins the wire **shape** of `GET /api/v1/monitor/traces/{trace_id}` — every `TraceRead` / `SpanReadResponse` key is asserted to exist and the `SpanType` / `SpanStatus` enums are pinned on every node. But it runs the shared no-provider fixture, which errors at the `LanguageModelComponent` before any LLM call, so `tokenUsage` and `modelName` always land as `null` and the issue-#299 acceptance text — *"On the LLM span: `tokenUsage.{promptTokens,completionTokens,totalTokens}`, `latencyMs`, `modelName`"* — was never **value**-asserted. A regression that dropped `promptTokens` would have passed there.

This spec closes that gap. It seeds the same flow but injects a real **OpenAI** provider via run tweaks, runs it to a **successful** completion, then value-asserts the populated LLM span:

- `tokenUsage` is a non-null object; `promptTokens`, `completionTokens`, `totalTokens` are all numbers `> 0`
- `totalTokens === promptTokens + completionTokens` (the derivation in `formatting.py:103`)
- `modelName` is a non-empty string that contains the requested model id (`gpt-4o-mini`)
- `latencyMs > 0`

### Span topology note

Langflow emits **two** spans of `type === "llm"` for a single model call:

| Span name (this version)   | `type` | `tokenUsage` | `modelName`        | `latencyMs` |
| -------------------------- | ------ | ------------ | ------------------ | ----------- |
| `Language Model` (component) | `llm`  | populated    | `null`             | > 0         |
| `ChatOpenAI gpt-4o-mini` (provider) | `llm`  | populated    | `gpt-4o-mini`      | > 0         |

`modelName` is read from the `gen_ai.response.model` span attribute (`formatting.py:124`). Langflow sets that attribute from the request's invocation params on the inner **provider** span only — so its value is the **requested** model id (exactly `gpt-4o-mini` for this flow, with no date suffix), and it is `null` on the component span. The spec therefore targets the provider span — the only span carrying **all three** issue-#306 values. Selection is by `type === "llm"` + a non-null `modelName`, with a name-based fallback (`/(chatopenai|language model)/i`) guarding against a future version that stops tagging the model call with `type === "llm"`. The `modelName` assertion uses containment (not equality) so a future provider that echoes back a resolved id with a suffix still passes.

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

---

## Step by step *(required)*

**`describe("Single trace — populated LLM span (OpenAI)")` — `mode: "serial"`**

The whole describe block is `test.skip`-ped when OpenAI cannot serve a live call — `OPENAI_API_KEY` absent, or the provider recorded `inactive` in `providers.json` (`providerSkipGate("openai")`, #1029). Without a real LLM call the populated values can never exist, and with a drained key the call hangs the shard's Langflow worker instead of failing.

**`beforeAll` (shared setup)**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/` with Bearer auth, name `traces-detail-llm-span-test-<timestamp>`); capture `api_key` + `id`
3. Create a flow (`POST /api/v1/flows/` with `x-api-key` auth) from `tests/assets/flows/basic-prompting-trace-fixture.json`, name suffixed with the timestamp; expect HTTP 201; capture `flowId`
4. Run the flow (`POST /api/v1/run/{flowId}` with `x-api-key` auth) injecting the provider via `tweaks` on the `LanguageModelComponent` node (id resolved from the fixture at runtime): `model: [{ name: "gpt-4o-mini", provider: "OpenAI" }]` and `api_key: process.env.OPENAI_API_KEY`. Unlike the sibling shape spec, this run must **succeed** — assert HTTP **200** (a 500 means the LLM call failed and the span attributes would be empty)
5. Poll `GET /api/v1/monitor/traces?flow_id=<flowId>` (Bearer auth) with intervals `[500, 1000, 2000]` ms up to 30 s until `body.traces[0].id` is not null; capture `traceId`

**`afterAll`** — delete the flow (Bearer) and the API key (Bearer) via `Promise.allSettled`.

**Test — `GET /api/v1/monitor/traces/{trace_id} returns a populated tokenUsage + modelName on the LLM span`**
1. `GET /api/v1/monitor/traces/<traceId>` with Bearer auth; assert HTTP 200
2. Flatten the span tree (root + recursive `children`) and select the LLM spans (`type === "llm"`, name fallback if none)
3. Pick the provider span (the one with a non-null `modelName`); assert it exists
4. Assert `tokenUsage` is a non-null object with `promptTokens` / `completionTokens` / `totalTokens` all numeric and `> 0`
5. Assert `totalTokens === promptTokens + completionTokens`
6. Assert `modelName` is a non-empty string whose lowercase form contains `gpt-4o-mini`
7. Assert `latencyMs` is a number `> 0`

---

## Validation criterion *(required)*

Pins the **populated** LLM-span contract that the Trace Details modal renders for a real model call — the value-level half of the #299 acceptance that `traces-detail-single.spec.ts` deliberately left out. A regression that dropped a token field, broke the `total = prompt + completion` derivation, stopped emitting `gen_ai.response.model` (→ `modelName === null` on every span), or zeroed per-span latency would surface here before the modal renders blank or wrong token counts. **Out of scope:** the shape contract (every key present, enum pinning on every node) — that is `traces-detail-single.spec.ts`.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/services/tracing/formatting.py` (lines 97-124) — builds `tokenUsage` from `gen_ai.usage.input_tokens` / `output_tokens` (total derived as input + output) and `modelName` from `gen_ai.response.model`; both attributes are only present after a completed LLM call
- `src/lfx/src/lfx/components/models_and_agents/language_model.py` — `LanguageModelComponent`; `build_model()` → `get_llm(model=self.model, api_key=self.api_key, …)`
- `src/lfx/src/lfx/base/models/unified_models/instantiation.py` — `get_llm`; the `model` value is a one-element list of `{name, provider}` (model class derived from the provider mapping when metadata omits it), `api_key` overrides the global provider key
- `src/backend/base/langflow/services/database/models/traces/model.py` — `SpanType` / `SpanStatus` enums and the `SpanReadResponse` / `TraceRead` Pydantic models

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — the **shared** Basic Prompting flow; the provider is injected at run time via tweaks, so no provider-configured fixture file is added (see Notes)
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/tests-automations/regression/core-functionality/observability-monitoring/traces-detail-single.spec.ts` — the shape spec this one complements

External services: **OpenAI** (`OPENAI_API_KEY`) — one `gpt-4o-mini` call per run.

---

## What this test does not cover *(optional)*

- **Shape contract** (every `TraceRead` / `SpanReadResponse` key present, `SpanType` / `SpanStatus` enum pinning on every node) — covered by `traces-detail-single.spec.ts`.
- **Non-OpenAI providers** — only OpenAI is exercised. The `gen_ai.usage.*` attributes follow OTel GenAI conventions across providers, so OpenAI is a representative pin.
- **The component-level `Language Model` span's `modelName === null`** — not asserted; the spec targets the provider span where `modelName` is populated. The two-span split is documented above so a future single-span emission is understood, not mistaken for a regression.
- **UI rendering of the populated cards** — `traces-latency-tokens.spec.ts` exercises the Trace Details modal, but against the unconfigured fixture (em-dash fallback). A UI spec pinning real token numbers is not in scope here.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser must be able to issue a token via `getAuthToken`
- `OPENAI_API_KEY` set in the environment **and** OpenAI recorded `active` in `providers.json` by `collect-models` — the describe block skips entirely otherwise (#1029)

---

## Notes *(optional)*

- **Fixture-sharing decision (issue-#306 acceptance):** no new fixture file is added. The provider is injected at run time via `tweaks` on the existing shared `basic-prompting-trace-fixture.json`, keeping a single fixture for both the shape spec (no provider → intentional error) and this populated spec (provider injected → success). This avoids a second near-duplicate fixture to maintain and keeps the provider key out of any checked-in JSON. Future specs needing a populated trace can reuse the same tweak pattern.
- The `LanguageModelComponent` node id carries a random suffix; the spec resolves it from the fixture at runtime (`languageModelNodeId()`) so the tweak survives a fixture regeneration.
- The run uses the Bearer token for both deletes in `afterAll` so they can run concurrently without racing on `x-api-key` auth.
