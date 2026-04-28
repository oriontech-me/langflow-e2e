# Playground — Open and Close Behavior

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*
Validates that the Playground opens directly in fullscreen when triggered from the flow editor and that it can be closed and reopened correctly. If this test fails, access to the Playground from the editor is broken.

The Playground migrated from a modal with an expand button to a direct fullscreen. The previous test tried to locate a fullscreen button with generic selectors (`[data-testid*="maximize"]`) and silently skipped when not found — which masked regressions. This spec anchors the selectors to the real behavior of the current version (1.10.x+).

---

## Tags *(required)*
`@stable` `@release` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — playground opens in fullscreen with chat input visible**
1. Create a blank flow with ChatInput connected to ChatOutput
2. Click the `playground-btn-flow-io` button in the toolbar
3. Confirm that `playground-close-button` appears immediately (indicates fullscreen)
4. Confirm that `input-chat-playground` is visible

**Test 2 — playground closes and reopens correctly from the flow editor**
1. Create a blank flow with ChatInput connected to ChatOutput
2. Open the Playground and wait for `playground-close-button`
3. Click the close button (`playground-close-button`)
4. Confirm that `input-chat-playground` is no longer visible
5. Reopen the Playground via `playground-btn-flow-io`
6. Confirm that `input-chat-playground` is visible again

---

## Validation criterion *(required)*
- The Playground opens in fullscreen (without an expansion step): `playground-close-button` present immediately after opening
- The chat input (`input-chat-playground`) is visible after opening
- After closing, the chat input is no longer visible
- After reopening, the chat input is visible again

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/` — main Playground component; changes to `data-testid="playground-close-button"` or `data-testid="input-chat-playground"` break this test
- `src/frontend/src/components/core/flowToolbarComponent/` — `playground-btn-flow-io` button that opens the Playground from the editor

---

## What this test does not cover *(optional)*
- Sending messages or executing flows in the Playground
- Voice mode and advanced Playground features
- Behavior with multiple open sessions

---

## Preconditions *(optional)*
- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- No pre-existing flow needed; the test creates the flow, records the ID returned in the URL and deletes it via API in the `afterEach`

---

## When to review this test *(optional)*
- If the Playground returns to a non-fullscreen mode (separate expand button): the opening test would need to be updated
- If the close button is removed or renamed

---

## Notes *(optional)*
- Both tests run in `serial` mode to avoid flow conflicts in the editor
- Cleanup done via API (`DELETE /api/v1/flows/{id}`) only for the flow created by the test itself; the ID is extracted from the URL after setup
