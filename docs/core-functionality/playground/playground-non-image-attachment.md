# Playground Output — Non-Image Attachment

**Last validated:** Langflow 1.14.x (`1.14.0.dev26`)

---

## What this test validates *(required)*

Verifies that the Playground correctly handles non-image file uploads via the chat input — exercising the **non-image branch** of `FilePreviewDisplay` (`src/frontend/src/components/core/playgroundComponent/chat-view/utils/file-preview-display.tsx` upstream) in two contexts:

1. **Compact variant (input area)** — after attaching a `.txt` file, an icon preview tile renders (with its delete button) and **no `<img>` element** is emitted.
2. **Expanded variant (sent message)** — after sending, the user message bubble shows the file via the same component's expanded variant: a truncated filename via `formatFileName(name, 10)` and **no `<img src="/files/images/...">`**.

No API key or LLM is required — the flow is a simple ChatInput → ChatOutput echo. Closes the coverage gap from issue #195.

---

## Tags *(required)*

`@stable` `@regression` `@playground` `@components`

---

## Step by step *(required)*

**Test 1 — non-image preview tile in input area**

1. Create a flow with ChatInput connected to ChatOutput (echo, no LLM)
2. Open the Playground
3. Attach `tests/assets/files/test-file.txt` via `setInputFiles()`
4. Assert `[data-testid="input-wrapper"] >> getByRole("button", { name: /^Delete / })` is visible — the delete button only appears once a preview tile mounts. The name is matched by prefix because it changed: `Delete {{name}}` (`Delete test-file.txt`) from `1.14.0.dev23` on, `Delete file` before and still on the `1.13.x` line (see **Label drift** below)
5. Assert the preview tile — the `div` whose direct child is that delete button — shows `getByTestId("icon-File")`. This is the **positive** marker of the non-image branch, and it is what makes step 6 meaningful: while the upload is in flight the tile renders a spinner (`loading` from `input-wrapper.tsx`) with the delete button already visible and no `<img>` yet, so a zero-`<img>` count on its own is satisfied by an **image** attachment too — measured: attaching `chain.png` instead of the `.txt` passed the step-4/6 pair (#2416). `icon-File` renders only once loading has cleared and the non-image branch was taken. It is scoped to the tile because on the `1.13.x` line the attach button also renders `icon-File` (it moved to `Paperclip` in #16277)
6. Assert `[data-testid="input-wrapper"] >> img` count is `0` — with step 5 holding, proves the image branch (`<img src=URL.createObjectURL(file)>`) did not run

**Test 2 — file rendered in user message after sending**

1. Attach `test-file.txt` (as in Test 1) and confirm the input-area delete button is visible (preflight) before sending
2. Click `button-send`
3. Wait for the bot reply via `getByTestId("div-chat-message")` (30s timeout) — confirms round-trip completed
4. Assert the input area no longer holds the attachment: inside `[data-testid="input-wrapper"]`, zero delete buttons and zero text matching `/\.\.\.txt$/`. **This is what makes step 5 mean "in the chat history".** From `1.14.0.dev23` on, the input tile renders its own truncated name (`formatFileName(name, 6)` → `test-f...txt`), which also ends in `...txt`; without this step a page-wide match in step 5 is satisfied by the input tile alone, so the test would pass with the attachment missing from the sent message as long as the input kept it. The user message bubble carries no `data-testid` to scope to, so the scope is established by exclusion
5. Assert `page.getByText(/\.\.\.txt$/).first()` is visible — matches the literal `...{ext}` suffix produced by `formatFileName(name, 10)`. **This intentionally asserts the truncation/ellipsis behavior**: with the current `maxLength=10` and `test-file.txt` (9-char baseName, 13-char full name), the rendered name exceeds 10 chars and `baseName.length > 6`, so the `...txt` suffix is emitted. The test will fail loudly if truncation is removed, the `maxLength` argument is increased past the rendered filename length, or the separator changes
6. Assert `page.locator('img[src*="/files/images/"]')` count is `0` — proves the image-history renderer did **not** run

**Label drift (#2416).** Upstream langflow-ai/langflow#16277 (`fix(frontend): name playground chat attachments`, merged into `release-1.14.0` on 2026-11-10, first shipped in `1.14.0.dev23`) changed the locale string `playgroundComponent.deleteFile` from `Delete file` to `Delete {{name}}`, added a truncated name label under each input tile, and made the sent-message card drop the server's upload timestamp prefix (`test-file...txt` instead of `2026-11-13...txt`). The exact `Delete file` match found nothing and both tests failed on the 2026-11-11 daily; the product behavior under test was intact. Neither `main` nor `release-1.13.3` carries the change, so the prefix match keeps the test valid on both lines. Asserting the new naming itself (per-file delete names, the input label, the stripped prefix) is a different contract and is not in this spec's scope

---

## Validation criterion *(required)*

- Before sending: a `getByRole("button", { name: /^Delete / })` is visible inside `[data-testid="input-wrapper"]`, its preview tile shows `icon-File`, and the wrapper contains zero `<img>` elements
- After sending: the input wrapper holds no delete button and no `...txt` text, while the page shows visible text matching `/\.\.\.txt$/` (therefore in the chat history) and zero `img[src*="/files/images/"]` elements

---

## External dependencies *(required)*

- `src/frontend/src/components/core/playgroundComponent/chat-view/utils/file-preview-display.tsx` — both compact (input) and expanded (sent message) non-image branches; if either renders an `<img>` for non-image files, this test fails (the desired failure mode). The expanded variant call site is `formatFileName(fileInfo.name, 10)` — the test depends on the truncation actually firing for `test-file.txt`, so the regex remains valid as long as the rendered filename still exceeds the configured `maxLength` (currently `10`)
- `src/frontend/src/components/core/playgroundComponent/chat-view/utils/file-utils.ts` — `formatFileName(name, maxLength)` produces `${baseName.slice(0, maxLength)}...${fileExtension}` **only when** `name.length > maxLength` **and** `baseName.length > 6`; otherwise it returns `name` verbatim with no ellipsis. The regex `/\.\.\.txt$/` is an explicit assertion that truncation occurred — it will fail if truncation is removed, if `maxLength` is raised above the rendered filename length (making the `...` suffix disappear), or if the separator changes. With `test-file.txt` (9-char baseName, 13-char full name) and `maxLength=10`, both conditions hold today; the fixture file would need to be renamed if the upstream `maxLength` is ever raised past 13
- `src/frontend/src/components/core/playgroundComponent/chat-view/chat-input/components/input-wrapper.tsx` — passes `loading={file.loading}` to each compact tile; while it is true the tile shows a spinner instead of either branch, which is why Test 1 needs the positive `icon-File` marker
- `src/frontend/src/locales/en.json` — `playgroundComponent.deleteFile` is the delete button's accessible name (`Delete {{name}}` since #16277, `Delete file` before); the test matches it by the `Delete ` prefix, so a further rename that drops that word breaks Test 1's preflight
- `src/lfx/src/lfx/base/data/utils.py` — `TEXT_FILE_TYPES` includes `txt`; if removed upstream, the upload would be rejected and this test should explain that the contract changed

---

## What this test does not cover *(optional)*

- Other text extensions (`.md`, `.pdf`, `.csv`, `.json`, etc.) — `.txt` is sufficient to exercise the non-image branch; additional extensions would not exercise a different code path
- Mixed image + text payload — covered by issue #194's multi-attach validation of the type-agnostic `setFiles(prev => [...prev, ...new])` append behavior in `use-chat-file-upload.ts`
- Unsupported file rejection (e.g. `.exe`) — depends on `accept` attribute in `upload-file-button.tsx`; tracked separately
- LLM-based vision/multimodal flows — covered by `chatInputOutputUser-shard-0.spec.ts`
- Files page (knowledge ingestion) upload — covered by `limit-file-size-upload.spec.ts`
- Server-side persistence of the upload — the test only verifies the UI rendering of the preview tile and the sent-message span. A regression where the upload silently fails server-side but the local `File` object is still echoed back in the chat history would not be caught here. Server-persistence is exercised separately by API-level specs

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- `tests/assets/files/test-file.txt` present in the repository (used by `setInputFiles()`)
- No API key or LLM required
