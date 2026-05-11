# Playground — Chat Input Attachments Management

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the attachment management UX in the Playground chat input — the surface that was only partially covered before (single attach + send was already exercised by `playground-output-image.spec.ts`). This spec covers the missing behaviors:

1. **Multiple attachments** — attaching two images sequentially produces one preview per file (the upload hook appends to the list rather than replacing).
2. **Selective removal** — removing one of two attached previews via the `X` button leaves the other intact, in order.
3. **Multi-file send** — sending with two attachments propagates the full list (`is_list=True` end-to-end), not only the head; both render in the user message.
4. **Empty state after remove** — removing the only attachment returns the input to a clean state (no orphan preview, send button still enabled, text send still works).
5. **Swap (composite)** — attach A → remove A → attach B → send results in only B being sent; no residual state from A.

No API key or LLM is required — the flow is a ChatInput → ChatOutput echo that reflects any uploaded file back to the user. The second image (`chain-2.png`) is a 68-byte 1x1 PNG bundled specifically to differentiate previews by `alt` / `src` suffix.

---

## Tags *(required)*

`@stable` `@regression` `@playground` `@components`

---

## Step by step *(required)*

All five tests share the same setup: create a ChatInput → ChatOutput echo flow, open the Playground, then exercise the attachment surface via `[data-testid="input-wrapper"] input[type="file"]` and the `aria-label="Delete file"` button on each preview.

**Test 1 — one preview per attached image when two are attached**

1. Attach `chain.png` and wait for `img[alt="chain.png"]` to appear inside the input wrapper.
2. Attach `chain-2.png` and wait for `img[alt="chain-2.png"]` to appear.
3. Assert both previews are visible and `button[aria-label="Delete file"]` has count 2.

**Test 2 — remove one of two attachments leaves the other**

1. Attach both images (as in Test 1).
2. Click the delete button scoped to `chain.png` via `div:has(> img[alt="chain.png"]) button[aria-label="Delete file"]` (filename-targeted, no DOM-order assumption).
3. Assert `img[alt="chain.png"]` count is 0; `img[alt="chain-2.png"]` is visible; delete button count is 1.

**Test 3 — send with two attachments renders both in the user message**

1. Attach both images.
2. Click `button-send`.
3. Wait for the bot response (`div-chat-message`) to confirm the round-trip.
4. Assert both `img[src*="/files/images/"][src$="chain.png"]` and `img[src*="/files/images/"][src$="chain-2.png"]` are visible in the chat.

**Test 4 — removing the only attachment returns input to empty state**

1. Attach `chain.png`.
2. Click the delete button.
3. Assert the preview is gone, the delete button is gone, `button-send` stays enabled.
4. Send a plain text message; bot responds and `img[src*="/files/images/"]` count is 0.

**Test 5 — swap A → B only sends B**

1. Attach `chain.png`, then delete it, then attach `chain-2.png`.
2. Click `button-send`.
3. Wait for `div-chat-message`.
4. Assert `img[src$="chain-2.png"]` is visible and `img[src$="_chain.png"]` count is 0 (the underscore disambiguates from `chain-2.png`).

---

## Validation criterion *(required)*

- Test 1: two distinct previews + two delete buttons inside `[data-testid="input-wrapper"]`.
- Test 2: removed preview disappears; sibling preview and delete button remain (count reduces from 2 to 1).
- Test 3: both server-rendered images appear in the user message after send.
- Test 4: input wrapper has no preview and no delete button after removal; sending text without files still works; no server-image leaks.
- Test 5: only `chain-2.png` renders after send; `_chain.png` count is 0.

---

## External dependencies *(required)*

- `src/frontend/src/shared/hooks/use-chat-file-upload.ts` — `setFiles(prev => [...prev, ...new])` appending behavior and `handleFileChange` clearing input value after each upload (required for sequential `setInputFiles()` to work).
- `src/frontend/src/components/core/playgroundComponent/chat-view/utils/file-preview-display.tsx` — compact/expanded variants, `aria-label="Delete file"` on the delete button, `alt={fileInfo.name}` on the preview image.
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-messages/components/user-message.tsx` — iterates `chat.files` rendering one `FilePreviewDisplay` per attachment (`variant="expanded"`).
- `src/backend/base/langflow/` — file upload endpoint and the `/files/images/` URL prefix; if either changes, the `src*=` / `src$=` selectors will not match.

---

## What this test does not cover *(optional)*

- Non-image file types (PDF, CSV, DOCX, code files) — tracked separately.
- Drag-and-drop attachment surface — only the hidden file input path is exercised.
- File-size limits in the Playground — `limit-file-size-upload.spec.ts` covers the Files page only.
- LLM-based multimodal vision input — covered by `llm-agents/chatInputOutputUser-shard-0.spec.ts`.
- Canvas-side Chat Input `Files` inspector field — tracked separately.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- `tests/assets/media/chain.png` and `tests/assets/media/chain-2.png` present.
- No API key or LLM required.
