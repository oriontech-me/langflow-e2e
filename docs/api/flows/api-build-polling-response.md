# API Build — Polling Response Delivery

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the **polling** event-delivery path of the flow build API — the transport the Playground uses to receive a flow run's results when `GET /api/v1/config`'s `event_delivery` is `polling` (QA-CHECKLIST §9.1 → "Response polling"). It is the sibling of the direct path (`api-build-direct-response.spec.ts`, issue #698) and the streaming/SSE path (issue #696).

The three delivery modes of `POST /api/v1/build/{flow_id}/flow` split into two transport families:

- **`direct`** — one-step: the `POST` streams the full event body inline; no `job_id` (covered by #698).
- **`streaming` / `polling`** — two-step: the `POST` returns `{ job_id }`, and the client then reads the events from `GET /api/v1/build/{job_id}/events`. The two differ in **how that events endpoint delivers**:
  - **`streaming`** — a single long-lived `StreamingResponse` (SSE) pushes every event over one held-open connection (#696).
  - **`polling`** — each `GET …?event_delivery=polling` returns a **discrete, bounded** `application/x-ndjson` response draining whatever events are currently queued, then closes. The client **polls in a loop**, issuing repeated GETs, until a batch carries the terminal `end` event. This mirrors the frontend's `customPollBuildEvents`.

If this test fails, the polling contract has regressed: a Langflow instance configured with `event_delivery=polling` would leave the Playground unable to reconstruct a run from the incremental batches (client-driven progress), or the events endpoint would stop honoring the polling mode.

The spec drives the endpoint at the **REST layer** (Playwright `request` fixture) with a deterministic **Chat Input → Chat Output** passthrough flow (no LLM, no provider key). The echoed value is a per-run sentinel, so "the flow actually ran and its output was delivered through the poll loop" cannot pass on a structurally valid but empty shell.

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

**Test 1 — polling is the two-step path: `POST …?event_delivery=polling` returns a `job_id` shell (no inline events)**
1. `POST /api/v1/build/{flowId}/flow?event_delivery=polling` with the Bearer and body `{ inputs: { input_value: "polling-handshake" } }`.
2. Assert response status is `200`.
3. Assert the body parses as a JSON object with a **string `job_id`** and carries **no inline `event`** — the run's events are NOT in the POST response; they are read from the separate events endpoint (unlike the direct path, whose POST streams the events inline).
4. Best-effort `POST /api/v1/build/{job_id}/cancel` — this job's events are not drained in this test, so cancel it to avoid a lingering job. (A failed cancel must not fail the assertions above.)

**Test 2 — the poll loop drains the build to completion across repeated `GET …/events?event_delivery=polling` calls**
1. Build a per-run sentinel (e.g. `POLL-<timestamp>-<rand>`).
2. `POST /api/v1/build/{flowId}/flow?event_delivery=polling` with `{ inputs: { input_value: <sentinel> } }`; read the `job_id`.
3. **Poll loop** (bounded by a max-iteration guard): repeatedly `GET /api/v1/build/{job_id}/events?event_delivery=polling`. For each response:
   - Assert status `200` and `Content-Type: application/x-ndjson`.
   - Parse the body as NDJSON and accumulate the events.
   - Stop once an accumulated event's `event` is `end`; sleep briefly between empty batches.
4. Assert the accumulated events reconstruct the full lifecycle — they contain `vertices_sorted`, `build_start`, and a terminal `end` event — proving the batched, client-driven delivery reassembled the complete run.
5. Assert the **Chat Output** message (an `add_message` event with `sender: "Machine"`) echoes the sentinel — the flow genuinely executed and its output arrived through the poll loop. (Matching any `add_message` would also be satisfied by the User input echo, so the output message is asserted specifically.)

---

## Validation criterion *(required)*

- Setup creates one flow; teardown removes it. No orphans on the backend after the suite (verified via `GET /api/v1/flows/`).
- Test 1: `POST …?event_delivery=polling` returns `200` and a JSON body with a string `job_id` and no inline event stream; the job is cancelled afterwards.
- Test 2: repeated `GET …/events?event_delivery=polling` calls each return `200` + `application/x-ndjson`; the accumulated events contain `vertices_sorted`, `build_start` and a terminal `end`, and the `sender: "Machine"` output message echoes the per-run sentinel.

---

## What this test does not cover *(optional)*

- Direct delivery (`POST …?event_delivery=direct`, inline stream) → dedicated spec, issue #698.
- Streaming/SSE delivery (`GET …/events?event_delivery=streaming`, single long-lived connection) → dedicated spec, issue #696.
- The Playground **UI** rendering under each delivery mode (the `withEventDeliveryModes` config-interception path) — the visible chat is identical across modes; the distinguishing behavior lives at the transport layer asserted here.
- The exact number of poll iterations (timing-dependent — the test asserts the loop reaches completion, not how many batches it took).
- Correctness of the run's output content beyond the echoed sentinel (LLM semantics, tool calls, multi-component graphs).
- Error/abort paths of the events endpoint (404 job, cancel mid-poll).

---

## Preconditions *(optional)*

- Langflow running and reachable at `PLAYWRIGHT_BASE_URL`.
- Default superuser credentials available (`LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD`) — used by `getAuthToken` to mint the Bearer.
- No provider key required — the flow is a deterministic Chat Input → Chat Output echo.

---

## External dependencies *(required)*

- `tests/helpers/auth/get-auth-token.ts` — issues a valid `Bearer` via `/api/v1/auto_login`; if its contract changes, `beforeAll` breaks.
- `tests/helpers/flows/create-runnable-chat-flow-via-api.ts` — builds the runnable Chat Input → Chat Output flow from `tests/assets/flows/chat-io-ok-trace-fixture.json`; if the fixture goes stale against the current Langflow schema, `beforeAll` breaks (shared with `api-run-flow.spec.ts` and `api-build-direct-response.spec.ts`).
- `src/backend/base/langflow/api/v1/chat.py` — `POST /api/v1/build/{flow_id}/flow` (returns `{ job_id }` for polling) and `GET /api/v1/build/{job_id}/events`.
- `src/backend/base/langflow/api/build.py` — `get_flow_events_response`; the polling branch drains the queue non-blocking and returns a bounded `application/x-ndjson` `Response`. Changing this branch (media type, batching, the `end` sentinel) breaks Test 2.
- `src/backend/base/langflow/api/v1/flows.py` — `POST /api/v1/flows/` used in setup and `DELETE /api/v1/flows/{id}` used in teardown.

---

## Notes *(optional)*

- **Design choice — API layer over UI.** The three delivery modes are a backend transport contract; the Playground chat looks identical regardless of which mode delivered the events. Asserting the polling path at the REST layer gives a deterministic observable (a `job_id` handshake plus a client-driven poll loop that reassembles the run) that a UI test could only reach by inspecting network traffic, with added flake.
- **Both polling and streaming events responses use `application/x-ndjson`** — the media type does NOT distinguish them. The distinction is the *response semantics*: polling returns a bounded batch per call and requires repeated GETs; streaming holds one connection open. This spec exercises the poll loop rather than asserting on a content-type contrast.
- The events body is **NDJSON**, one event object per line — parse line-by-line; `response.json()` on it would throw.
