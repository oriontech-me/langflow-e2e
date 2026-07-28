# Playground — Session ID

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that the session ID a user sets from the Playground is the session the backend actually stores the conversation under — both for the messages already in the session and for every message sent afterwards. If this breaks, users cannot control which session context their messages are sent to, which affects every multi-session workflow.

The Playground has no free-text `session_id` input. The modal playground that rendered the Chat Input node's parameters was replaced by the sliding-sidebar playground (upstream `126c037aa0`, pre-1.8), whose session surface is the session list — **New chat** plus **Rename**. The `session_id` field itself survives only as an `advanced=True` parameter on the Chat Input node (exposed through `inspector-add-session_id`) and as a REST parameter. This spec therefore covers the surface that exists today (verdict recorded on #994).

---

## Tags *(required)*

`@stable` `@release` `@regression` `@playground`

---

## Step by step *(required)*

1. Use `setupPlayground(page)` to create a blank flow with ChatInput → ChatOutput connected and capture the created `flowId`
2. Open the Playground (`playground-btn-flow-io`) and wait for `input-chat-playground` to be visible
3. Click `new-chat` and send `first message`; wait for the send to settle
4. Poll `GET /api/v1/monitor/messages?flow_id={flowId}` until a message carrying a `session_id` other than `flowId` is queryable, and record that auto-generated session ID. The rename endpoint reads the database and 404s while the message is only in the client cache (same persistence gate as `playground-session-rename`, #637)
5. Rename the session to `e2e-session-<uuid>` through the session more-menu → `rename-session-option` → `session-rename-input` → `Enter`
6. Assert over the API that every message of the flow now carries the custom session ID and none carries the pre-rename one
7. Send `second message` in the same (renamed) session
8. Assert the new message is persisted under the custom session ID as well, and that `GET /api/v1/monitor/messages/sessions?flow_id={flowId}` returns exactly `["<custom>"]`

`afterEach` navigates to `/` and deletes the flow created by the helper via `DELETE /api/v1/flows/{id}`.

---

## Validation criterion *(required)*

- After the rename, `GET /api/v1/monitor/messages?flow_id={flowId}` returns **0** messages under the pre-rename session ID and **all** of the flow's messages under `<custom>`
- The message sent after the rename is persisted with `session_id === <custom>`
- `GET /api/v1/monitor/messages/sessions?flow_id={flowId}` equals `["<custom>"]` — the flow has exactly one session and it is the one the user named

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-selector.tsx` — session row and its rename affordance
- `data-testid="playground-btn-flow-io"` — opens the Playground from the editor
- `data-testid="input-chat-playground"` — chat input, also the Playground readiness signal
- `data-testid="new-chat"` — creates a session
- `data-testid="button-send"` — sends the message
- `data-testid="session-selector"` / `session-<id>-more-menu` / `rename-session-option` / `session-rename-input` — the rename path
- `PATCH /api/v1/monitor/messages/session/{old_session_id}` — the rename write performed by the UI
- `GET /api/v1/monitor/messages` and `GET /api/v1/monitor/messages/sessions` — the assertions
- No LLM provider: the flow is a ChatInput → ChatOutput echo

---

## What this test does not cover *(optional)*

- The rename UI affordance itself (when it is available, Escape cancelling it) — covered by `playground-session-rename.spec.ts`
- Creating and switching sessions — covered by `playground-session-nav.spec.ts`
- Clearing a session's history — covered by `playground-session-clear.spec.ts`
- The Chat Input node's advanced `session_id` parameter overriding the graph session (`chat.py`: `self.session_id or self.graph.session_id`) — not covered anywhere today; candidate for a `core-components` spec
- Agent memory isolation between sessions — covered by `llm-agents/memory-history-regression.spec.ts`

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No API key required — the flow echoes the input, no model is invoked

---

## Notes *(optional)*

- Test runs in `serial` mode for consistency with the sibling playground specs and to keep the cleanup contract simple
- Cleanup deletes only the flow created by this test (id captured from `setupPlayground`'s return value)
- The assertions read the database through the monitor API rather than the rendered chat, so they cannot pass on a client-side cache that never reached the server
