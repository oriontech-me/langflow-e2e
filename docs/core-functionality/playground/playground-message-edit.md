# Playground Message Edit

**Last validated:** Langflow 1.12.x

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

1. Create a flow with ChatInput → ChatOutput via `setupPlayground`
2. Open Playground (`playground-btn-flow-io`), send "Original message", wait for the
   user bubble (`div-chat-message`)
3. **Wait for the flow run to finish** — `button-stop` hidden **and** `button-send`
   visible. Editing before this point makes the message update fail (see #1062)
4. Hover the message group container to reveal the edit button (`icon-Pen`)
5. Click `icon-Pen`; wait for `save-button` to confirm EditMessageField is mounted
6. Set textarea value via `setEditTextareaValue("Edited message")`; click `save-button`
7. Wait for `save-button` to have count 0 (edit field closed)
8. Assert `data-testid="chat-message-User-Edited message"` is visible
9. Assert `data-testid="chat-message-User-Original message"` has count 0

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

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/message-options.tsx` — `EditMessageButton` renders the Pen icon; the icon gets `data-testid="icon-Pen"` from `genericIconComponent` when no explicit `dataTestId` is provided
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/edit-message-field.tsx` — `data-testid="save-button"` and `data-testid="cancel-button"` must remain stable
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-more-menu.tsx` — `data-testid="message-logs-option"` triggers the Session Logs modal
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/chat-header.tsx` — `dataTestid="chat-header-more-menu"` is the more-menu trigger in the chat header

---

## What this test does not cover *(optional)*

- Editing bot messages (same mechanism, separate coverage if needed)
- Editing messages inside the Session Logs table (ag-grid inline editing, no stable testids)
- Edit persistence across page reloads
- Editing with special characters or very long messages

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key or LLM required — the flow is ChatInput → ChatOutput, so the run echoes
  the input. The run is **executed for real**: on 1.11+ the Playground runs through
  `POST /api/v2/workflows` (SSE), so the legacy `**/api/v1/run/**` route mock this
  spec used to install never fired and was removed (#1062)
- Message storage endpoints (`/api/v1/monitor/messages/`) are NOT mocked; the test relies on the real Langflow backend persisting the edit (required for Session Logs consistency check)

---

## Notes *(optional)*

- The edit button (`icon-Pen`) is inside an `invisible group-hover:visible` container. The test hovers the `.group` container (not just the message text) and scopes the icon lookup to within it, ensuring the CSS hover state is never lost when the mouse moves to the button.
- `save-button` visibility is used as the readiness signal for `EditMessageField` being mounted. After clicking save, the test waits for `save-button` count to reach 0 — this only proves the edit field closed, **not** that the update succeeded: the field also closes when the update is rejected. The rejection raises an "Error updating messages." toast, but that toast is **not** a dependable assertion target — under load the flow page re-suspends right after, and the toast was gone from the failure snapshot in both the daily and the local reproduction. The run-completion gate below removes the cause instead.
- **The run-completion gate is the fix for #1062.** The spec edited the message as soon
  as the user bubble appeared, while the flow run was still executing. A message
  update issued mid-run is rejected — the UI raises "Error updating messages." and the
  bubble keeps its original text, so `chat-message-User-Edited message` never appears.
  Measured on 1.12.0.dev9: with the backend unloaded the run finishes inside the ~900 ms
  the spec spends hovering, so it passed 8/8; with the same backend under parallel load
  the run was still in flight at save time and it failed 8/8 with exactly the daily's
  signature. This is why the flake only ever appeared on heavily loaded daily runs
  (2026-07-10, 07-20, 07-29). All three tests share the helper, so all three were exposed.
- The edit textarea value is set via `setEditTextareaValue`, which calls the native `HTMLTextAreaElement.prototype.value` setter and then invokes React's `onChange` handler directly through `__reactProps$`. This is required because React 19's controlled textarea ignores synthetic DOM events dispatched by Playwright.
- Assertions on text after edit use `data-testid="chat-message-User-{text}"` (set by `user-message.tsx`) rather than `getByText`. The playground renders bot messages via `SanitizedMarkdown` which can incidentally match user-input text; scoping to the user bubble's testid avoids false failures.
