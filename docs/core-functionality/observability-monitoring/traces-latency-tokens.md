# Traces — Latency, Tokens, and Span Tree (end-to-end)

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

This is the deepest trace coverage in the suite. It seeds a real flow run via API, polls until at least one trace is emitted, then pins three contracts:

1. **REST API:** `GET /api/v1/monitor/traces?flow_id=<id>` returns a trace list where each trace exposes the metrics consumed by the Flow Activity UI — `totalLatencyMs`, `totalTokens`, `flowId`, `status`, `startTime`.
2. **Flow Activity UI:** opening the flow editor and clicking `sidebar-nav-traces` renders a grid with `totalLatencyMs` and `totalTokens` columns populated with real numeric values for the seeded run.
3. **Trace Details UI:** clicking the `run` cell of a trace row opens the Trace Details modal showing the span tree (root + Prompt Template + Chat Input + Language Model), per-span latency on the initially-selected span, and — after clicking the Language Model node — the LLM span detail panel surfacing the `Tokens` / `Prompt` / `Completion` metric cards (with em-dash fallback values, since the unconfigured fixture errors out before token usage is captured) and the `LLM` type label.

The 3 tests share a single `beforeAll` setup and run in `serial` mode so the seeded flow + emitted trace are reused.

---

## Tags *(required)*

**Test 1 (API):** `@stable` `@release` `@api` `@regression` `@observability`
**Tests 2–3 (UI inside the flow editor):** `@stable` `@release` `@workspace` `@regression` `@observability`

---

## Step by step *(required)*

**`beforeAll` (shared setup)**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/` with bearer auth, name `traces-latency-test-<timestamp>`) and capture `api_key` + `id`
3. Create a flow (`POST /api/v1/flows/` with `x-api-key` auth) from `tests/assets/flows/basic-prompting-trace-fixture.json`, name suffixed with the timestamp; expect HTTP 201; capture `flowId`
4. Run the flow once (`POST /api/v1/run/{flowId}` with `x-api-key` auth, `input_value: "trace-probe"`, `input_type: "chat"`, `output_type: "chat"`). The fixture has no provider configured, so the LanguageModelComponent fails with "A model selection is required" — the failure is **intentional**: it still emits a trace entry with `totalLatencyMs` and `totalTokens`, which is what the suite validates. Accept HTTP 200 or 500; anything outside that range means the run never reached the graph executor.
5. Poll `GET /api/v1/monitor/traces?flow_id=<flowId>` (Bearer auth) with intervals `[500, 1000, 2000]` ms up to 30 s until `body.traces.length > 0` — trace writes are asynchronous, so downstream tests must wait for them to land

**`afterAll`** — delete the flow (`x-api-key`) and the API key (Bearer).

**Test 1 — `GET /api/v1/monitor/traces returns totalLatencyMs and totalTokens for a flow run`**
1. `GET /api/v1/monitor/traces?flow_id=<flowId>` with Bearer auth
2. Assert HTTP 200; `body.traces` is an array with length > 0; `body.total` is a number > 0
3. Pick the first trace and assert:
   - `typeof totalLatencyMs === "number"` and `>= 0`
   - `typeof totalTokens === "number"` and `>= 0`
   - `flowId === <seeded flowId>`
   - `status` is one of `"unset" | "ok" | "error"` (the OpenTelemetry-aligned `SpanStatus` enum defined at `services/database/models/traces/model.py:96-106`)
   - `typeof startTime === "string"`

**Test 2 — `Flow Activity page shows latency and token columns for the run`**
1. Mark `page.allowFlowErrors()` (the seeded flow fails at the LanguageModelComponent by design; without this the fixture's HTTP error monitor would fail the test)
2. `page.goto("/flow/<flowId>")`
3. Wait for `sidebar-nav-traces` to be visible (30 s timeout), then click it
4. Assert `flow-activity-header` is visible (10 s)
5. Locate the first `.ag-cell[col-id="totalLatencyMs"]`; assert it is visible (15 s) and its text matches `/^\d+(\.\d+)?\s*(ms|s)$/` (15 s) — the cell renders before metrics populate, so the text-match timeout is larger than the visibility one on purpose. The regex accepts both `formatTotalLatency` branches (`<n> ms` below 1000ms and `<n.nn> s` at or above)
6. Locate the first `.ag-cell[col-id="totalTokens"]`; assert it is visible and its text matches `/^\d+$/` (15 s)

**Test 3 — `Trace Details modal shows span tree and per-span latency`**
1. Mark `page.allowFlowErrors()`
2. `page.goto("/flow/<flowId>")` and click `sidebar-nav-traces`
3. Click the first `.ag-cell[col-id="run"]` — whole-row click does not trigger the panel because `onCellClicked` is the wired event
4. Assert `trace-detail-view` is visible (10 s); `span-tree` is visible; `span-detail` is visible
5. Assert there are exactly **4 span nodes** (`[data-testid^="span-node-"]`): 1 root + Prompt Template + Chat Input + Language Model
6. In the `span-detail` panel (showing the initially-selected span), assert the text contains `Latency` and a `\d+(\.\d+)?\s*(ms|s)` pattern (per-span latency render — same dual-branch regex as Test 2)
7. In the `span-tree`, assert the labels `Prompt Template`, `Chat Input`, `Language Model` are present
8. Click the `Language Model` span node inside `span-tree` (matched by `[data-testid^="span-node-"]` + text filter) to swap the detail panel onto the LLM span
9. In the now-LLM `span-detail` panel, assert the text contains the metric-card labels `Tokens`, `Prompt`, `Completion` and the em-dash fallback character `—`. The Tokens/Prompt/Completion cards are gated by `(hasTokenUsage || isLlmSpan)` in `SpanDetail.tsx`: with the unconfigured fixture, `tokenUsage` is `null` on the API payload (the LLM step errors before any token capture), so only the `isLlmSpan` branch keeps the cards visible. Pinning the labels + em-dash protects against a regression that drops the `isLlmSpan` branch and hides the token UI surface for failed LLM runs.
10. Assert the panel also contains the type label `LLM` (rendered by `getSpanTypeLabel("llm")` in the header). `modelName` would appear next to it when populated; the error-path fixture leaves it `null` — see "What this test does not cover" for why the modelName text is not asserted.

---

## Validation criterion *(required)*

- **Test 1** — Pins the wire contract that downstream UI consumes: each trace exposes `totalLatencyMs`, `totalTokens`, `flowId`, `status`, `startTime`. A regression that renames any of these or drops a key would surface here before the Flow Activity grid breaks at render time. The bounds checks (`>= 0`, allowed status set) protect against type-shape regressions.
- **Test 2** — The Flow Activity grid renders `totalLatencyMs` and `totalTokens` columns populated with actual numeric values for the seeded run. Regex anchors (`^\d+(\.\d+)?\s*(ms|s)$`, `^\d+$`) prevent silent regressions where the cell renders a placeholder like `—` or `null`; the latency regex covers both `formatTotalLatency` branches.
- **Test 3** — The Trace Details modal shows the full per-span breakdown for the seeded flow: 4 spans (root + 3 components), per-span latency in the detail panel, span labels in the tree, and — after the LLM span is selected — the `Tokens` / `Prompt` / `Completion` metric-card labels, the em-dash fallback for null `tokenUsage`, and the `LLM` type label in the header. Pins the wiring between `onCellClicked` on the Run cell and `TraceDetailView` + `SpanTree` + `SpanDetail`, the `(hasTokenUsage || isLlmSpan)` branch in `SpanDetail`, and the type-label render path.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/traces.py:45` — `GET /monitor/traces` handler returning `TraceListResponse`; line 42 mounts the router with prefix `/monitor/traces`
- `src/backend/base/langflow/services/tracing/formatting.py:108` — defines `totalTokens` key on the trace payload (the formatter also emits `totalLatencyMs` and the other fields the test asserts)
- `src/frontend/src/pages/FlowPage/components/TraceComponent/FlowInsightsContent.tsx:263` — defines `data-testid="flow-activity-header"`
- `src/frontend/src/pages/FlowPage/components/TraceComponent/TraceDetailView.tsx:108` — defines `data-testid="trace-detail-view"`
- `src/frontend/src/pages/FlowPage/components/TraceComponent/SpanTree.tsx:71` — defines `data-testid="span-tree"`
- `src/frontend/src/pages/FlowPage/components/TraceComponent/SpanDetail.tsx:44` — defines `data-testid="span-detail"`
- `data-testid="sidebar-nav-traces"` is asserted in Langflow's own unit tests under `flowSidebarComponent/components/__tests__/sidebarSegmentedNav.test.tsx`

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — minimal Basic Prompting flow with no provider configured; runs to a LanguageModelComponent error that still emits a trace
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/fixtures/fixtures.ts` — `page.allowFlowErrors()` opt-in for specs that intentionally trigger flow execution errors

---

## What this test does not cover *(optional)*

- The empty-state UI smoke (template loaded, no run, Traces panel shows "No Data Available") — covered by `traces.spec.ts`.
- The `/api/v1/monitor/transactions` envelope contract — covered by `traces-detail.spec.ts`.
- Successful (non-error) trace shape: this spec exercises the failure path because no provider is configured in the fixture. A successful trace might surface extra fields (e.g., token counts > 0, span outputs). Not pinned here.
- **Numeric values inside the LLM span's `Tokens` / `Prompt` / `Completion` metric cards.** The fixture leaves `LanguageModelComponent` unconfigured, so the run errors at the LLM step and `tokenUsage` lands as `null` on the API payload. The cards still render via the `isLlmSpan` branch in `SpanDetail`, but their values fall back to em-dash (`—`) — test 3 pins the labels + the fallback, not numeric counts. Pinning numeric values would require a fixture that runs to completion (real provider key or mock LLM); that would force `test.skip` on a missing API key, which conflicts with the `@stable` contract (every provider-gated test in the repo today is non-`@stable`). If a mock LLM provider lands in Langflow, a follow-up can switch this test to a successful-path fixture and assert numeric counts.
- **The `modelName` text in the LLM span detail header.** `model_name` is sourced from `gen_ai.response.model` (see `services/tracing/formatting.py:124`), which is only populated when the LLM call returns a response. The fixture's error path never reaches that point, so `modelName` is `null` and the `{span.modelName && ...}` block in `SpanDetail` renders nothing. Same upstream blocker as the numeric counts: a follow-up needs a successful run to pin this surface.
- **Implicit contract:** the entire suite assumes Langflow emits a trace for a flow that fails at component-execution time (the seeded run intentionally errors at `LanguageModelComponent`). If a future Langflow release ever decided not to emit traces for component failures, the `beforeAll` polling at `/api/v1/monitor/traces` would time out at 30 s and surface as a flake on every nightly. The contract is not pinned by any test in the repo and is not documented as guaranteed in Langflow's docs — at most "observability captures runs regardless of success/failure" is the design intent. If this fragility ever materializes, the fix is to switch the fixture to a provider-configured flow that succeeds.
- Span detail panel sections other than latency, the LLM token-usage metric cards (label + em-dash fallback), and the type label — inputs/outputs JSON, the cost row, the error message section, and the empty-state placeholder are not asserted.
- Trace filtering (status, query, start/end time, session_id). The handler supports those query params but no test pins them.
- Negative auth path on `/api/v1/monitor/traces` — no test pins the 401/403 response on missing or bad token.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required — the fixture is intentionally unconfigured

---

## Notes *(optional)*

- The 3 tests share a `beforeAll` that does heavy setup (key + flow + run + poll). `test.describe.configure({ mode: "serial" })` is critical: parallel execution would race on the seeded flow and the polled trace. Tests must not be reordered without considering this.
- Two further tests previously lived at the bottom of this file and were removed in the same PR that introduced this doc:
  - `GET /api/v1/monitor/messages response contains message content` — duplicated `api/flows/api-monitor-messages.spec.ts`, which has more thorough assertions (`id`, `session_id`, `timestamp`, `sender`, `text`). The version here used a looser `hasContent || hasContext` check. Removed as duplicate.
  - `traces page is accessible in the UI` — gated on `GET /api/v1/monitor/transactions` without `flow_id`, which the backend rejects with 422; the early-return path made the test pass trivially without ever exercising the UI. It also navigated to `/logs`, which is a **backend** endpoint (`src/backend/base/langflow/api/log_router.py:75`), not a frontend route — the same pattern that broke the deleted test in `traces-detail.spec.ts`. UI coverage of the populated Traces grid is owned by tests 2 and 3 in this file.
- The fixture deliberately runs to error (`LanguageModelComponent` requires a model selection). The trace is still emitted because Langflow's tracing service captures component runs regardless of success/failure — that is the whole point of observability.
