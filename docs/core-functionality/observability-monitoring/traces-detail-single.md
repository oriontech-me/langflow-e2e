# Single-Trace API — `GET /api/v1/monitor/traces/{trace_id}` contract

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

The `/api/v1/monitor/traces` list endpoint is exercised by `traces-latency-tokens.spec.ts`, but the per-trace endpoint that feeds the **Trace Details modal** was previously unasserted. This spec pins that contract:

1. **Negative path:** `GET /api/v1/monitor/traces/<unknown-uuid>` returns **404**. The handler joins `trace → flow → user`, so an unknown trace and a trace owned by a different user both collapse to the same response — one test covers both cases.
2. **Happy path:** with a seeded flow + run + emitted trace, `GET /api/v1/monitor/traces/<trace_id>` returns **200** with the full `TraceRead` contract: top-level fields (`id`, `name`, `status`, `startTime`, `endTime`, `totalLatencyMs`, `totalTokens`, `flowId`, `sessionId`, `input`, `output`, `spans`) and a non-empty span tree where every span exposes the keys the `SpanDetail` panel consumes (`id`, `name`, `type`, `status`, `latencyMs`, `startTime`, `endTime`, `inputs`, `outputs`, `error`, `modelName`, `tokenUsage`, `children`).

Enum coverage:
- `SpanType` ∈ `chain | llm | tool | retriever | embedding | parser | agent`
- `SpanStatus` ∈ `unset | ok | error`

---

## Tags *(required)*

`@stable` `@release` `@api` `@regression` `@observability`

Both tests (negative and happy path) carry the same tag set.

---

## Step by step *(required)*

**Test 1 — `GET /api/v1/monitor/traces/{trace_id} returns 404 for an unknown but well-formed UUID`** *(standalone)*
1. Get a bearer token via `getAuthToken(request)`
2. `GET /api/v1/monitor/traces/00000000-0000-0000-0000-000000000001` with Bearer auth
3. Assert HTTP 404

**`describe("Single trace shape — seeded flow")` — `beforeAll` (shared setup)**
1. Get a bearer token via `getAuthToken(request)`
2. Create an API key (`POST /api/v1/api_key/` with Bearer auth, name `traces-detail-single-test-<timestamp>`); capture `api_key` + `id`
3. Create a flow (`POST /api/v1/flows/` with `x-api-key` auth) from `tests/assets/flows/basic-prompting-trace-fixture.json`, name suffixed with the timestamp; expect HTTP 201; capture `flowId`
4. Run the flow once (`POST /api/v1/run/{flowId}` with `x-api-key` auth, `input_value: "single-trace-probe"`, `input_type: "chat"`, `output_type: "chat"`). The fixture has no provider configured, so the LanguageModelComponent fails — the failure is **intentional**: the trace still lands. Accept HTTP 200 or 500
5. Poll `GET /api/v1/monitor/traces?flow_id=<flowId>` (Bearer auth) with intervals `[500, 1000, 2000]` ms up to 30 s until `body.traces[0].id` is not null — trace writes are asynchronous
6. Re-fetch the list and capture `traceId = body.traces[0].id`

**`afterAll`** — delete the flow (`x-api-key`) and the API key (Bearer).

**Test 2 — `GET /api/v1/monitor/traces/{trace_id} returns the full TraceRead contract with a non-empty span tree`**
1. `GET /api/v1/monitor/traces/<traceId>` with Bearer auth
2. Assert HTTP 200
3. Assert top-level `TraceRead` fields:
   - `id === traceId`; `typeof name === "string"`
   - `status` is one of `"unset" | "ok" | "error"`
   - `typeof startTime === "string"`; `endTime`, `input`, `output` keys are present (nullable)
   - `typeof totalLatencyMs === "number"` and `>= 0`; same for `totalTokens`
   - `flowId === <seeded flowId>`; `typeof sessionId === "string"`
4. Assert `body.spans` is a non-empty array; flatten the tree (root + recursive `children`) and walk every node:
   - `typeof id === "string"`; `typeof name === "string"`
   - `type` ∈ `SpanType` enum; `status` ∈ `SpanStatus` enum (asserted on every node)
   - `typeof latencyMs === "number"` and `>= 0`
   - Keys present (nullable): `startTime`, `endTime`, `inputs`, `outputs`, `error`, `modelName`, `tokenUsage`
   - `children` is an array

Note on `sessionId` and `tokenUsage`:
- `sessionId` is typed `str` on `TraceRead` but the underlying column is nullable. The spec accepts `"string" | null` to match the wire reality.
- `tokenUsage` shape (`promptTokens` / `completionTokens` / `totalTokens` numeric assertions) is **not** asserted here. The fixture errors before any LLM call, so the field always lands as `null` and a conditional shape check would be dead code under this fixture. The populated-LLM-span contract is tracked in issue #306 and will land as a dedicated spec with a provider-configured fixture.

---

## Validation criterion *(required)*

- **Test 1** — Pins the only documented failure path for the single-trace endpoint: a 404 when the trace is not visible to the caller. A regression that returned 500, 403, or 200-with-empty-payload would surface here. Because the handler enforces ownership via the SQL join, this test also implicitly covers the "trace owned by a different user" case without needing a second user fixture.
- **Test 2** — Pins the wire contract that `TraceDetailView` + `SpanTree` + `SpanDetail` consume. A rename or drop of any top-level `TraceRead` field, or any `SpanReadResponse` field, would surface here before the Trace Details modal breaks at render time. The enum checks on every span (not just the root) protect against drift in either `SpanType` or `SpanStatus`. Numeric guards (`totalLatencyMs`, `totalTokens`, per-span `latencyMs` all `>= 0`) catch regressions to sentinel values like `-1` or `NaN`. **Out of scope:** the populated `tokenUsage` / `modelName` contract on the LLM span — tracked in #306.

---

## External dependencies *(required)*

References in the **main Langflow repository** (compatible with Langflow 1.10.x):

- `src/backend/base/langflow/api/v1/traces.py:102` — `GET /monitor/traces/{trace_id}` handler returning `TraceRead`
- `src/backend/base/langflow/services/tracing/repository.py:218` — `fetch_single_trace` joins `trace → flow → user`, so unknown trace and foreign-owned trace both collapse to `None` → 404
- `src/backend/base/langflow/services/database/models/traces/model.py:84-106` — `SpanType` and `SpanStatus` enum definitions asserted by both tests
- `src/backend/base/langflow/services/database/models/traces/model.py:166-216` — `SpanReadResponse` and `TraceRead` Pydantic models (camelCase via `alias_generator=to_camel`)
- `src/backend/base/langflow/services/tracing/formatting.py:105-109` — emits `tokenUsage` with `promptTokens`, `completionTokens`, `totalTokens`
- `src/backend/tests/unit/api/v1/test_monitor_ownership.py` — upstream ownership coverage for `builds`, `transactions`, and `messages`; the single-trace endpoint is **not** covered there, which is the gap this spec fills

References in this repository:

- `tests/assets/flows/basic-prompting-trace-fixture.json` — minimal Basic Prompting flow with no provider configured; runs to a LanguageModelComponent error that still emits a trace
- `tests/helpers/auth/get-auth-token.ts` — issues a bearer token for the superuser
- `tests/tests-automations/regression/core-functionality/observability-monitoring/traces-latency-tokens.spec.ts` — list-endpoint contract; companion to this spec

---

## What this test does not cover *(optional)*

- **`DELETE /api/v1/monitor/traces/{trace_id}`** — defined on the same router (`traces.py:138`) but exercised by no spec.
- **Populated LLM-span contract** — the fixture errors at the LanguageModelComponent by design, so `tokenUsage` and `modelName` always land as `null` on the LLM span. The keys are asserted to exist (shape contract), but value-level assertions (`promptTokens > 0`, `totalTokens === promptTokens + completionTokens`, `modelName` matches the provider response) are tracked in #306, which will land as a dedicated spec using a provider-configured fixture. Deliberate scope reduction to keep this spec free of provider keys / cost / flake.
- **Explicit ownership test with a second user** — the upstream `test_monitor_ownership.py` covers `builds`/`transactions`/`messages` but not single-trace, and the handler's SQL join means the 404 path is identical to the foreign-owned case. The 404 test in this spec covers both cases. A dedicated cross-user spec would require seeding a second user (not currently supported by the helpers).
- **Span tree structural assertions** (parent/child wiring, exact span count) — covered by Test 3 in `traces-latency-tokens.spec.ts` against the UI, where `span-node` data-testids are asserted to be exactly 4.
- **Negative auth path** (401/403 on missing/bad token) — no test pins this for the single-trace endpoint.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- The configured superuser (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) must be able to issue a token via `getAuthToken`
- No provider keys required — the fixture is intentionally unconfigured

---

## Notes *(optional)*

- The negative test runs standalone (no setup) because it only needs a valid token. Keeping it outside the `describe` block avoids paying the seeding cost for a test that does not need it and matches the layout of `traces-detail.spec.ts`.
- The happy-path test runs inside a `describe` block with `mode: "serial"` and a shared `beforeAll`. The seeding pattern (key + flow + run + poll) is intentionally identical to `traces-latency-tokens.spec.ts` so both specs can rely on the same well-understood failure mode of the trace fixture.
- The span walk uses a local `flattenSpans` helper that recurses through `children`. The flat list is checked against the `SpanType`/`SpanStatus` enums on every node — drift in either enum surfaces immediately, regardless of where in the tree it lands.
