# Playground Output — Image Upload

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Verifies that the Playground correctly handles image uploads via the chat input:

1. After attaching an image, a compact preview appears in the input area before sending.
2. After sending the message, the image is rendered in the user message bubble in the chat history.

No API key or LLM is required — the flow is a simple ChatInput → ChatOutput echo that reflects any uploaded file back to the user.

---

## Tags *(required)*

`@stable` `@regression` `@playground`

---

## Step by step *(required)*

**Test 1 — compact preview visible in input area before sending**

1. Delete existing flows and create a flow with ChatInput connected to ChatOutput (echo, no LLM)
2. Open the Playground
3. Attach `chain.png` to the chat input via `setInputFiles()`
4. Assert `img[alt="chain.png"]` is visible inside `[data-testid="input-wrapper"]`

**Test 2 — image rendered in user message bubble after sending**

1. Attach `chain.png` (as in Test 1) and send the message
2. Wait for the bot response to confirm the round-trip completed
3. Assert `img[src*="/files/images/"]` is visible in the user message bubble — the server prefixes the filename with a timestamp, so the selector uses `src*=` instead of `alt`

---

## Validation criterion *(required)*

- Before sending: `img[alt="chain.png"]` is visible inside `[data-testid="input-wrapper"]`
- After sending: `img[src*="/files/images/"]` is visible in the user message bubble in the chat history

---

## External dependencies *(required)*

- `src/frontend/src/components/core/chatComponents/` — `input-wrapper` container and image preview rendering in the chat input area
- `src/backend/base/langflow/` — file upload endpoint; if the server path for images (`/files/images/`) changes, the `src*=` selector will not match

---

## What this test does not cover *(optional)*

- Image upload with LLM-based vision models (multimodal input)
- Upload of non-image file types via the Playground input
- Upload size limits or error handling for oversized files

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `tests/assets/files/chain.png` present in the repository (used by `setInputFiles()`)
- No API key or LLM required
