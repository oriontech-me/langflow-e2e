# API Run with Tweaks

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates that the `tweaks` parameter of `POST /api/v1/run/{flow_id}` actually **overrides flow component configuration at runtime** — the contract external clients rely on to reconfigure a flow per request without editing and saving it first.

The spec runs against a real `Chat Input -> Chat Output` passthrough flow (imported from a fixture, no LLM or external provider key required). Because `Chat Output` echoes whatever `Chat Input` emits, a tweak on `Chat Input.input_value` changes the response text deterministically — so the override is *observed*, not merely accepted. It also pins the two boundary behaviors confirmed against the Langflow backend: an empty `tweaks` object is a no-op, and a tweak targeting a component absent from the flow is silently ignored (still `200`).

If these tests fail, the runtime-override contract has regressed: integrations that parameterize a shared flow via `tweaks` (per-tenant prompts, per-request model settings, dynamic inputs) would either stop taking effect or start erroring.

---

## Tags *(required)*
`@stable` `@release` `@api` `@regression`

`@release` is applied only to the override happy-path test (Test 1). The two boundary tests (no-op, non-existent component) are `@stable @api @regression` — they are not deploy-gating happy paths.

---

## Step by step *(required)*

The spec runs **3 independent tests** via Playwright's `request` fixture, sharing a single flow created in `beforeAll`.

**Setup (`beforeAll`)**
1. Obtain a valid Bearer token via `getAuthToken(request)`.
2. `POST /api/v1/api_key/` with the Bearer token to mint a temporary API key (asserts `200`); the run endpoint requires `x-api-key`, not Bearer.
3. Read `tests/assets/flows/chat-io-ok-trace-fixture.json` and `POST /api/v1/flows/` with its `data` to create a runnable `Chat Input -> Chat Output` flow (asserts `201`), storing `flowId`. The fixture's `Chat Input` has a stored `input_value` default of `"Hello"`.

**Teardown (`afterAll`)**
1. `DELETE /api/v1/flows/{flowId}` with the Bearer token.
2. `DELETE /api/v1/api_key/{apiKeyId}` with the Bearer token.

Both deletions are wrapped in `.catch(() => {})` so teardown never masks a test failure.

---

**Test 1 — `tweaks` override a component field at runtime** *(`@stable @release @api @regression`)*
1. Build a unique value `TWEAKED-<timestamp>` (so a passing assertion cannot accidentally match the default).
2. `POST /api/v1/run/{flowId}` with `x-api-key` and payload `{ input_type: "chat", output_type: "chat", tweaks: { "Chat Input": { input_value: "<unique>" } } }`. Top-level `input_value` is intentionally omitted — the backend **rejects with `400`** any request that passes both a top-level `input_value` and a Chat Input tweak on the same `input_value` field, so the value is driven purely through the tweak.
3. Assert status `200` and `body.outputs` exists.
4. Assert the echoed output text equals the tweaked value — the override is proven.

**Test 2 — empty `tweaks` is a no-op** *(`@stable @api @regression`)*
1. Same request as Test 1 minus the tweak: `tweaks: {}`, no top-level `input_value`.
2. Assert status `200` and `body.outputs` exists.
3. Assert the output text equals the flow default `"Hello"`. This baseline is what makes Test 1's contrast meaningful — identical requests differing only by the tweak yield different outputs.

**Test 3 — tweaks for a non-existent component are silently ignored** *(`@stable @api @regression`)*
1. `POST /api/v1/run/{flowId}` with `tweaks: { "NonExistentComponent-999": { input_value: "..." } }`.
2. Assert status `200` (no error) and `body.outputs` exists.
3. Assert the output text is unchanged from the flow default `"Hello"` — confirming the bogus tweak had no effect.

---

## Validation criterion *(required)*
- Setup creates one flow and one API key; teardown removes both. No orphans on the backend after the suite.
- Test 1: output text equals the unique tweaked value — the tweak overrode the stored default.
- Test 2: output text equals `"Hello"` — empty tweaks change nothing.
- Test 3: status is `200` and output text equals `"Hello"` — an unmatched tweak is ignored, not errored.
- The contrast between Test 1 (`TWEAKED-…`) and Tests 2/3 (`Hello`) is the evidence that tweaks override configuration rather than being merely accepted.

---

## What this test does not cover *(optional)*
- Nested-field tweaks (`NestedDict`/`dict` template fields) and array/list-field tweaks — these need a component with such fields and are tracked as a follow-up issue.
- Tweaking by node **id** (this spec tweaks by display name; the backend accepts both).
- The `400` rejection when a top-level `input_value` and a same-field Chat Input tweak are sent together (the spec avoids this combination rather than asserting it; a dedicated negative test could cover it).
- Code-field injection protection (the backend blocks tweaks on `code`-type fields).
- Streaming responses, batch runs, multi-turn `session_id` threading → other specs / issues.

---

## Preconditions *(optional)*
- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Default superuser credentials available (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) — used by `getAuthToken` to mint the Bearer used in setup.
- Backend allows API key creation via `POST /api/v1/api_key/` for the authenticated user.
- `tests/assets/flows/chat-io-ok-trace-fixture.json` present and importable as a flow.

---

## External dependencies *(required)*
- `tests/helpers/auth/get-auth-token.ts` — issues a valid `Bearer` via `/api/v1/auto_login`; if its contract changes, `beforeAll` breaks.
- `tests/assets/flows/chat-io-ok-trace-fixture.json` — the `Chat Input -> Chat Output` fixture; renaming the `Chat Input` display name or changing its default `input_value` would break the tweak key or the baseline assertions.
- `src/backend/base/langflow/api/v1/endpoints.py` — implementation of `POST /api/v1/run/{flow_id}` (`SimplifiedAPIRequest` schema, `RunResponse` shape).
- `src/backend/base/langflow/processing/process.py` — `process_tweaks` / `apply_tweaks`; tweaks resolve by node id or display name and silently ignore unmatched references. A change here (e.g. erroring on unmatched tweaks, or changing precedence) breaks Tests 1 and 3.
- `src/backend/base/langflow/api/v1/flows.py` — `POST /api/v1/flows/` (setup) and `DELETE /api/v1/flows/{id}` (teardown).
- `src/backend/base/langflow/api/v1/api_key.py` — `POST /api/v1/api_key/` and `DELETE /api/v1/api_key/{id}` for the temporary key lifecycle.
