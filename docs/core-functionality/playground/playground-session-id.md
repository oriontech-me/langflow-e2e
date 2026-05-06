# Playground — Session ID Input

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that the Playground session ID input field is editable and correctly reflects a custom value typed by the user. If this breaks, users cannot control which session context their messages are sent to — affecting multi-session workflows.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@playground`

---

## Step by step *(required)*

1. Use `setupPlayground(page)` to create a blank flow with ChatInput → ChatOutput connected and capture the created `flowId`
2. Click `playground-btn-flow-io` and wait for `input-chat-playground` to be visible (confirms playground is open)
3. Clear `popover-anchor-input-session_id` and fill it with `session-${Date.now()}`
4. Assert the field's value equals the filled string via `toHaveValue`

`afterEach` navigates to `/` and deletes the flow created by the helper via `DELETE /api/v1/flows/{id}`.

---

## Validation criterion *(required)*

- After `.fill()`, `popover-anchor-input-session_id` holds the exact string typed (web-first `toHaveValue` assertion)

---

## External dependencies *(required)*

- `src/frontend/src/components/core/chatComponents/` — session ID input rendered inside the Playground header
- `data-testid="popover-anchor-input-session_id"` — session ID input field
- `data-testid="playground-btn-flow-io"` — opens the Playground from the editor
- `data-testid="input-chat-playground"` — chat input field used as a readiness signal for the Playground

---

## What this test does not cover *(optional)*

- Actual backend isolation between sessions (messages from session A not appearing in session B) — covered by `core-functionality/llm-agents/memory-history-regression.spec.ts`
- The sidebar-based session management (create / switch / rename) introduced in Langflow 1.9+ — covered by `playground-session-nav.spec.ts` and `playground-session-rename.spec.ts`
- Sending a message after switching the session ID — out of scope for this spec

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No LLM required — the test only types into the session ID field, no flow execution happens

---

## Notes *(optional)*

- Test runs in `serial` mode for consistency with sibling playground specs and to keep the cleanup contract simple
- Cleanup deletes only the flow created by this test (id captured from `setupPlayground`'s return value)
