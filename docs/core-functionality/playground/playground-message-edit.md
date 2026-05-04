# Playground Message Edit

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Verifies that individual messages in the Playground chat can be edited via the hover-revealed pen button, and that edits are properly persisted and reflected in the Session Logs modal.

Three behaviors are covered:

1. **Edit and save** — hovering a user message reveals an edit button (`icon-Pen`); saving replaces the original text in the chat.
2. **Cancel edit** — discarding an edit via the Cancel button leaves the original message unchanged.
3. **Session Logs consistency** — a message edited in the Playground appears with the updated text when the Session Logs modal is opened.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — Edit and save**

1. Create a flow with ChatInput → ChatOutput via `setupPlayground`, mock `**/api/v1/run/**`
2. Open Playground (`playground-btn-flow-io`), send "Original message", wait for bot reply
3. Hover the message group container to reveal the edit button (`icon-Pen`)
4. Click `icon-Pen`; wait for `save-button` to confirm EditMessageField is mounted
5. Press `Control+a` and type "Edited message"; click `save-button`
6. Assert "Edited message" is visible and "Original message" has count 0

**Test 2 — Cancel edit**

1–4. Same setup as Test 1
5. Type "Discarded edit"; click `cancel-button`
6. Assert "Original message" is still visible and "Discarded edit" has count 0

**Test 3 — Session Logs consistency**

1–4. Same setup as Test 1, message text "Before edit"
5. Type "After edit"; click `save-button`; assert "After edit" visible in chat
6. Click `chat-header-more-menu`; click `message-logs-option`
7. Assert modal title "Session logs" is visible
8. Assert "After edit" is present in the modal table

---

## Validation criterion *(required)*

- After save: edited text replaces original text in the chat; original text is absent
- After cancel: original text is unchanged; discarded text is absent
- Session Logs: edited text appears in the modal table after saving the change in Playground

---

## External dependencies *(required)*

- `components/core/playgroundComponent/chat-view/chat-messages/components/message-options.tsx` — `EditMessageButton` renders the Pen icon; the icon gets `data-testid="icon-Pen"` from `genericIconComponent` when no explicit `dataTestId` is provided
- `components/core/playgroundComponent/chat-view/chat-messages/components/edit-message-field.tsx` — `data-testid="save-button"` and `data-testid="cancel-button"` must remain stable
- `components/core/playgroundComponent/chat-view/chat-header/components/session-more-menu.tsx` — `data-testid="message-logs-option"` triggers the Session Logs modal
- `components/core/playgroundComponent/chat-view/chat-header/components/chat-header.tsx` — `dataTestid="chat-header-more-menu"` is the more-menu trigger in the chat header

---

## What this test does not cover *(optional)*

- Editing bot messages (same mechanism, separate coverage if needed)
- Editing messages inside the Session Logs table (ag-grid inline editing, no stable testids)
- Edit persistence across page reloads
- Editing with special characters or very long messages

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `**/api/v1/run/**` is mocked to return a deterministic bot reply — no API key or LLM required
- Message storage endpoints (`/api/v1/messages/`) are NOT mocked; the test relies on the real Langflow backend persisting the edit (required for Session Logs consistency check)

---

## Notes *(optional)*

- The edit button (`icon-Pen`) is inside an `invisible group-hover:visible` container. The test hovers the `.group` container (not just the message text) and scopes the icon lookup to within it, ensuring the CSS hover state is never lost when the mouse moves to the button.
- `save-button` visibility is used as the readiness signal for `EditMessageField` being mounted and the textarea being auto-focused, before sending keyboard input.
