# Playground — Chat Input Attachments Management

**Last validated:** Langflow 1.14.x (`1.14.0.dev26`)

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

All five tests share the same setup: create a ChatInput → ChatOutput echo flow, open the Playground, then exercise the attachment surface via `[data-testid="input-wrapper"] input[type="file"]` and the delete button on each preview, located by an `aria-label` starting with `Delete ` (see **Label drift** below).

**Test 1 — one preview per attached image when two are attached**

1. Attach `chain.png` and wait for `img[alt="chain.png"]` to appear inside the input wrapper.
2. Attach `chain-2.png` and wait for `img[alt="chain-2.png"]` to appear.
3. Assert both previews are visible and `button[aria-label^="Delete "]` has count 2.

**Test 2 — remove one of two attachments leaves the other**

1. Attach both images (as in Test 1).
2. Click the delete button scoped to `chain.png`, anchored on the image and walking up to the nearest ancestor tile that contains a delete button (`img[alt="chain.png"]` → `xpath=ancestor::div[.//button[starts-with(@aria-label,"Delete ")]][1]` → that button), filename-targeted with no DOM-order assumption. **Drift note (#908):** the previous locator `div:has(> img[alt="chain.png"]) button[aria-label="Delete file"]` assumed the Delete button was a descendant of the image's *direct* parent; on 1.12 the preview markup moved the button up to the tile (2 levels above the image), so that selector matched nothing and the click timed out (20s). The image-anchored ancestor locator is class-independent, so a further Tailwind restyle of the tile will not re-break it. It anchors on the image rather than on the button's name so that it finds the right tile on both label shapes below — on the `Delete file` line both buttons carry the same name.
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
4. Assert `img[src$="chain-2.png"]` is visible and `img[src$="chain.png"]` count is 0 (the `chain.png` suffix doesn't match `chain-2.png`, so this is exact without relying on the backend's underscore separator).

---

## Validation criterion *(required)*

- Test 1: two distinct previews + two delete buttons inside `[data-testid="input-wrapper"]`.
- Test 2: removed preview disappears; sibling preview and delete button remain (count reduces from 2 to 1).
- Test 3: both server-rendered images appear in the user message after send.
- Test 4: input wrapper has no preview and no delete button after removal; sending text without files still works; no server-image leaks.
- Test 5: only `chain-2.png` renders after send; `chain.png` count is 0.

**Label drift (#2416).** Upstream langflow-ai/langflow#16277 (`fix(frontend): name playground chat attachments`, merged into `release-1.14.0` on 2026-11-10, first shipped in `1.14.0.dev23`) changed the locale string `playgroundComponent.deleteFile` from `Delete file` to `Delete {{name}}`, so the buttons now read `Delete chain.png` / `Delete chain-2.png`. The exact `aria-label="Delete file"` selector found zero buttons, Test 1 failed on the 2026-11-11 daily and the four serial siblings were skipped behind it; the previews themselves rendered. Neither `main` nor `release-1.13.3` carries the change, so the delete button is matched by the `Delete ` prefix, which holds on both lines. Asserting the per-file names is a different contract and is not in this spec's scope.

---

## External dependencies *(required)*

- `src/frontend/src/shared/hooks/use-chat-file-upload.ts` — `setFiles(prev => [...prev, ...new])` appending behavior and `handleFileChange` clearing input value after each upload (required for sequential `setInputFiles()` to work).
- `src/frontend/src/components/core/playgroundComponent/chat-view/utils/file-preview-display.tsx` — compact/expanded variants, the delete button's `aria-label`, `alt={fileInfo.name}` on the preview image.
- `src/frontend/src/locales/en.json` — `playgroundComponent.deleteFile`, the delete button's accessible name (`Delete {{name}}` since #16277, `Delete file` before); matched by the `Delete ` prefix.
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
