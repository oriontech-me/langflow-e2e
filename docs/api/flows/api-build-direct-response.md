# API Build — Direct Response Delivery

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the **direct** event-delivery path of `POST /api/v1/build/{flow_id}/flow` — the transport the Playground uses to receive a flow run's results (QA-CHECKLIST §9.1 → "Direct response"). Langflow exposes three delivery modes on this endpoint, selected via the `event_delivery` query parameter (`streaming` / `polling` / `direct`); the frontend picks one from `GET /api/v1/config`'s `event_delivery` field:

- **`streaming` / `polling`** — two-step: the `POST` returns `{ "job_id": ... }` and the client then consumes `GET /api/v1/build/{job_id}/events` (SSE or polling loop).
- **`direct`** — one-step: the `POST` **streams the full build-event body inline** in its own response (NDJSON), with **no `job_id` and no follow-up events request**. The backend implements this explicitly to support this path (comment in `chat.py`: *"we need to be able to set the event delivery to direct"*).

If this test fails, the direct delivery contract has regressed: a Langflow instance configured with `event_delivery=direct` would leave the Playground unable to receive run results in a single request, or would silently degrade the direct path back to the job_id two-step.

The spec drives the endpoint at the **REST layer** (Playwright `request` fixture) with a deterministic **Chat Input → Chat Output** passthrough flow (no LLM, no provider key). The echoed value is a per-run sentinel, so the assertion that the flow *actually ran within the single response* cannot pass on a structurally valid but empty shell.

---

## Tags *(required)*

`@api` `@regression` `@playground` `@stable`

---

## Step by step *(required)*

The spec runs **2 independent tests** via Playwright's `request` fixture, sharing a single flow created in `beforeAll`. The `/build` endpoint authenticates with **Bearer** (`CurrentActiveUser`), so the flow is created with the same Bearer identity that builds it (owner must match).

**Setup (`beforeAll`)**
1. Obtain a valid Bearer token via `getAuthToken(request)`.
2. Create a runnable Chat Input → Chat Output passthrough flow via `createRunnableChatFlowViaApi(request, { Authorization: bearer })`; store `flowId` and its `deleteFlow` teardown.

**Teardown (`afterAll`)**
1. `deleteFlow(request)` — `DELETE /api/v1/flows/{flowId}` with the Bearer. No orphan flows left on the backend.

---

**Test 1 — `event_delivery=direct` streams the build events inline (no job_id) and echoes the input**
1. Build a per-run sentinel (e.g. `ECHO-<timestamp>-<rand>`).
2. `POST /api/v1/build/{flowId}/flow?event_delivery=direct` with the Bearer and body `{ inputs: { input_value: <sentinel> } }`.
3. Assert response status is `200`.
4. Read the response body as text and parse it as NDJSON (one JSON object per non-empty line).
5. Assert the body carries the inline event stream — the parsed events include `vertices_sorted`, `build_start`, and a terminal `end` event — proving the entire build streamed within this single response.
6. Assert the body contains **no `job_id`** (neither as a parsed `{ job_id }` shell nor the substring) — this is the direct path, not the two-step job path.
7. Assert the sentinel appears in an `add_message` event's `text` — the Chat Output echoed the input, so the flow genuinely executed inside the direct response.

**Test 2 — direct is distinct from the job_id path: `event_delivery=streaming` returns a `job_id`, direct does not**
1. `POST /api/v1/build/{flowId}/flow?event_delivery=streaming` with the Bearer and the same body shape.
2. Assert response status is `200`.
3. Assert the response parses as a JSON object with a **string `job_id`** property and carries **no inline `event` stream**.
4. This is the contract contrast that makes Test 1 meaningful: the same endpoint, same flow, returns a fundamentally different response shape purely from the delivery mode — guarding against a regression where `direct` silently falls back to the job_id path (or the job_id path starts inlining events). This test asserts only the *shape* of the streaming response; consuming the SSE events endpoint is out of scope (owned by the streaming-path spec, issue #696).

---

## Validation criterion *(required)*

- Setup creates one flow; teardown removes it. No orphans on the backend after the suite (verified via `GET /api/v1/flows/`).
- Test 1: `POST …?event_delivery=direct` returns `200`; the body is an inline NDJSON event stream containing `vertices_sorted`, `build_start` and a terminal `end` event; the body contains no `job_id`; and the per-run sentinel appears echoed in an `add_message` event.
- Test 2: `POST …?event_delivery=streaming` returns `200` and a JSON body with a string `job_id` and no inline event stream.

---

## What this test does not cover *(optional)*

- Streaming (SSE) delivery consumption via `GET /api/v1/build/{job_id}/events?event_delivery=streaming` → dedicated spec, issue #696.
- Polling delivery consumption via the same events endpoint with `event_delivery=polling` → dedicated spec, issue #697.
- The Playground **UI** rendering under each delivery mode (the `withEventDeliveryModes` config-interception path) — the visible chat is identical across modes; the distinguishing behavior lives at the transport layer asserted here.
- Correctness of the run's output content beyond the echoed sentinel (LLM semantics, tool calls, multi-component graphs).
- Error/abort paths of the build endpoint (404 flow, cancel).

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Default superuser credentials available (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) — used by `getAuthToken` to mint the Bearer.
- No provider key required — the flow is a deterministic Chat Input → Chat Output echo.

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — issues a valid `Bearer` via `/api/v1/auto_login`; if its contract changes, `beforeAll` breaks.
- `tests/helpers/flows/create-runnable-chat-flow-via-api.ts` — builds the runnable Chat Input → Chat Output flow from `tests/assets/flows/chat-io-ok-trace-fixture.json`; if the fixture goes stale against the current Langflow schema, `beforeAll` breaks (shared with `api-run-flow.spec.ts`).
- `src/backend/base/langflow/api/v1/chat.py` — implementation of `POST /api/v1/build/{flow_id}/flow`; the `event_delivery != DIRECT → { job_id }` vs `DIRECT → inline events` branch is exactly what both tests assert. Changing this branch (default mode, response shape, event names) breaks the spec.
- `src/backend/base/langflow/api/v1/flows.py` — `POST /api/v1/flows/` used in setup and `DELETE /api/v1/flows/{id}` used in teardown.

---

## Notes *(optional)*

- **Design choice — API layer over UI.** The three delivery modes are a backend transport contract; the Playground chat looks identical regardless of which mode delivered the events. Asserting the direct path at the REST layer gives a razor-sharp, deterministic observable (inline event stream vs `{ job_id }` shell) that a UI test could only reach by inspecting network traffic, with added flake. The `withEventDeliveryModes` helper (config interception) remains available for a future UI-level cross-mode smoke.
- The response body is **NDJSON** (`application/x-ndjson`), one event object per line — not a single JSON document. Parse line-by-line; `response.json()` on the direct body would throw.
