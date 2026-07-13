# Playground — Response Streaming (SSE)

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that a Playground run is delivered over Server-Sent Events (SSE): the
browser consumes a `text/event-stream` response from the workflow-execution
endpoint, the user message renders immediately, and the run completes. If this
transport breaks, the Playground silently falls back to a non-streaming path (or
hangs), degrading the progressive-response experience that §9.1 promises.
Streaming was previously exercised only *implicitly* by `playground-ux.spec.ts`,
which never asserts the SSE transport itself — this is the dedicated,
transport-level proof.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@playground`

---

## Step by step *(required)*

1. Use `setupPlayground(page)` to create a blank flow with ChatInput → ChatOutput
   connected and capture the created `flowId` (deterministic echo flow — no LLM).
2. Register a `page.on("response")` collector that records the `content-type` of
   every response whose URL matches the workflow-execution endpoint
   (`/api/v2/workflows`, or legacy `/build/.../events`), installed **before** the
   run is triggered. This scoping excludes the editor's own
   `/api/v1/flows/{id}/events` JSON polling.
3. Click `playground-btn-flow-io` and wait for `input-chat-playground` to be
   visible (confirms the Playground is open).
4. Send a message: fill `input-chat-playground`, click `button-send`.
5. Assert the user message renders in the chat (its text is visible), matching
   the proven pattern in `playground-ux.spec.ts`.
6. Wait for the run to complete — `input-chat-playground` re-enabled (robust
   completion signal; token/usage badges are model-dependent and fragile).
7. Assert at least one collected run-endpoint response carried
   `content-type: text/event-stream` — proving the run was delivered over SSE.

`afterEach` navigates to `/` and deletes the flow created by the helper via
`DELETE /api/v1/flows/{id}` (id-scoped cleanup, never a wipe).

---

## Validation criterion *(required)*

- The Playground run consumes **at least one** `text/event-stream` (SSE) response
  on the workflow-execution endpoint, **and** the user message renders **and** the
  run completes (input re-enabled). All three must hold — the SSE observation
  alone, without a completed run, does not pass.

---

## External dependencies *(required)*

- `POST /api/v2/workflows` — the workflow-execution endpoint the Playground run
  hits on 1.11; returns a `text/event-stream` (SSE) response under streaming mode
  (verified live on nightly 1.11.0.dev). Legacy fallback: `GET
  /api/v1/build/{job_id}/events` (`text/event-stream` on v1). The test matches
  the transport (content-type on the run endpoint), not a URL, so an upstream
  path move does not silently defeat it.
- `data-testid="playground-btn-flow-io"` — opens the Playground from the editor.
- `data-testid="input-chat-playground"` — chat input; readiness + completion
  signal.
- `data-testid="button-send"` — sends the message.
- `setupPlayground` helper — builds the ChatInput → ChatOutput flow and returns
  the created flow id.

---

## What this test does not cover *(optional)*

- **Progressive token-by-token rendering** of an LLM response (the "message grows
  over multiple frames" experience) — that needs a real model and is intentionally
  out of scope to keep this spec deterministic and `@stable`. Covered implicitly by
  the LLM/agent playground specs.
- **Polling and direct** event-delivery modes — this spec asserts the streaming
  transport only; the `withEventDeliveryModes` helper exercises all three for
  behavior-level tests elsewhere.
- The general Playground UX (instant user echo, auto-scroll, input readiness) —
  covered by `playground-ux.spec.ts`.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on nightly 1.11.0.dev).
- No LLM / provider key required — the ChatInput → ChatOutput flow echoes the
  input, so the run is deterministic and the SSE transport is exercised without
  any external model.

---

## Notes *(optional)*

- Runs in `serial` mode for consistency with the sibling playground specs and to
  keep the id-scoped cleanup contract simple.
- The SSE assertion is transport-level (content-type on the build-events
  response), not URL-exact, so an upstream path rename does not silently defeat
  it as long as the events endpoint keeps the `text/event-stream` contract.
