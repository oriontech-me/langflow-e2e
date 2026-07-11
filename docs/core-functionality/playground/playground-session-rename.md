# Playground Session — Rename Availability

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Verifies the session rename availability rule enforced by the Playground:

```
canRenameSession = !isDefaultSession && hasMessages
```

When `canRenameSession` is false the rename option is not rendered in the DOM at all (not just hidden). Three scenarios are covered:

1. **Default Session** — rename must be absent regardless of message count.
2. **User-created session with no messages** — rename must be absent.
3. **User-created session with messages** — rename must be present and functional: Enter confirms the new name, Escape cancels without changing it.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — Default Session: rename option must be absent**

1. Create a flow with ChatInput → ChatOutput and open the Playground
2. Click the more-menu trigger for the Default session (`chat-header-more-menu`)
3. Assert `rename-session-option` has count 0 (not present in the DOM)

**Test 2 — User-created session with no messages: rename option must be absent**

1. Open the Playground and click `new-chat` to create a new session
2. Click the more-menu trigger for the new session (`[data-testid^="session-"][data-testid$="-more-menu"]`)
3. Assert `rename-session-option` has count 0

**Test 3 — User-created session with messages: rename must be present and functional**

1. Open the Playground, click `new-chat`, and send a message in the new session
2. Wait until the new session's message is **durably persisted server-side** —
   poll `GET /api/v1/monitor/messages?flow_id={flowId}` until at least one
   message carries a `session_id` other than the flow id (the new session). This
   gates the rename against the exact table the rename endpoint reads and
   removes the rename-404 race (see Notes)
3. Click the more-menu trigger for the session
4. Assert `rename-session-option` is visible
5. Click `rename-session-option`, type a new name, and press Enter
6. Assert the new name appears in `session-selector`
7. Click the more-menu trigger again, click `rename-session-option`, type another name, and press Escape
8. Assert the previous name is preserved (Escape cancels without saving)

---

## Validation criterion *(required)*

- Default session: `rename-session-option` count is 0 after opening the more-menu
- New session with no messages: `rename-session-option` count is 0 after opening its more-menu
- New session with messages: `rename-session-option` is visible; after Enter the new name appears in `session-selector`; after Escape the previous name is preserved

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-header/components/session-selector.tsx` — `canRenameSession = canModifySession && hasMessages` logic and `data-testid="rename-session-option"`; any change to this conditional or to these testids will break the tests
- `hasMessages` (`.../chat-header/hooks/use-session-has-messages.ts`) is derived from the **client-side React Query message cache**, which is populated by the build stream — so the rename option becomes available before the messages are committed to the DB. The rename endpoint (`PATCH /api/v1/monitor/messages/session/{old}?new_session_id={new}`) queries the DB and **404s when no rows exist for `{old}` yet**; on 404 the frontend keeps the old name (toast only). Test 3 must therefore wait for server-side persistence before renaming
- Radix `SelectContent` only renders children when the dropdown is open — the more-menu must be clicked before asserting the absence of `rename-session-option`

---

## What this test does not cover *(optional)*

- Session rename persistence across page reloads
- Rename behavior with special characters or very long session names
- Clear chat or delete session actions (covered in `playground-clear-history`)

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No API key or LLM required — the echo flow (ChatInput → ChatOutput) is sufficient to create messages

---

## Notes *(optional)*

- Radix `SelectContent` is conditionally rendered — the more-menu must be opened before querying `rename-session-option`; `count()` is used instead of `isVisible()` to assert DOM absence rather than visibility.
- **Rename-404 race (why Test 3 waits for persistence):** the rename option is enabled from the client message cache, which the build stream fills *before* the messages are committed to the DB. Sending a message and waiting only for the input to clear leaves a window where `PATCH /monitor/messages/session/{old}` runs before any row exists for `{old}` → 404 → the frontend silently keeps the old name and the "renamed label visible" assertion times out. This is the flake tracked in issue #637 (daily #629; recurring 2026-07-02 and 2026-07-10). The fix is not a wider timeout — it polls `GET /monitor/messages` (the same table the PATCH reads) so the rename is sequenced against real persistence, making the test deterministic. The endpoint's 404 itself is correct behavior; the underlying UI enabling rename ahead of the DB commit is a minor client-side robustness gap, handled gracefully (toast) and out of scope for this test.
