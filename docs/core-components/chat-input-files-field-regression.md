# Chat Input — `Files` Inspector Field Regression

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates the **canvas-side `Files` field** on the Chat Input node — the advanced FileInput surface declared in `src/lfx/src/lfx/components/input_output/chat.py:70-78` — without depending on an LLM. This is the inspector path users take to attach a file to a flow at design time, distinct from the Playground paperclip path covered by `playground-output-image.spec.ts`.

The 4 tests cover:

1. **`showfiles` exposes the Files inspector field** — the field is `advanced=True`, so `input-file-component` and `button_upload_file` must be absent from the DOM before the advanced toggle and visible after it (same contract as `showsender_name` validated by Test 6 of `chat-input-output-component-regression`).
2. **Inspector upload populates the field** — clicking the upload button triggers a native file picker; setting a file via `filechooser` updates the readonly `input-file-component` value to the file name, and the upload button switches to "value present" mode (X dismiss icon revealed on hover).
3. **Inspector-attached file participates in flow execution** — running ChatInput → ChatOutput from the Chat Output run button propagates the inspector-attached file as part of the Message; opening the Playground shows the user-side message with the image rendered as `<img alt$="chain.png">`. The signal mirrors the existing `general-bugs-shard-3836` test, but LLM-free (no Basic Prompting template, no API key).
4. **Dismiss clears the field** — clicking the upload button while a value is present (X icon visible on hover) calls `handleDismissClick`, returning the input value to the placeholder literal `"Upload a file..."`.

If any of these tests fails, the canvas-side multimodal entry point on Chat Input is broken — either the advanced field rendering contract, the inspector upload write path, runtime propagation of inspector-attached files, or the dismiss action.

---

## Tags *(required)*

`@stable` `@regression` `@components`

All 4 tests carry `@stable` per the project rule "spec is born 100% @stable; tag is removed per-test only during weekly triage".

---

## Step by step *(required)*

**Setup helpers** (private to the spec — duplicated from `chat-input-output-component-regression` to avoid touching shared helpers in the same PR)

- `addChatInputComponent(page)` — opens a blank flow, adds Chat Input via the sidebar, focuses and expands the node.
- `addChatOutputToCanvas(page)` — drags Chat Output onto an existing flow and expands it.
- `connectChatInputToChatOutput(page)` — clicks `handle-chatinput-shownode-chat message-right` then `handle-chatoutput-shownode-inputs-left` and asserts exactly one `.react-flow__edge` is present.
- `toggleFilesFieldVisible(page)` — `openAdvancedOptions` → click `showfiles` → `closeAdvancedOptions`.
- `chatInputNodeScope(page)` — returns a locator scoped to the Chat Input `.react-flow__node` container. The `input-file-component` and `button_upload_file` testids are also mounted by the side-panel/edit-fields modal even before the toggle, so all field assertions and the upload click target are scoped here.
- `uploadFileViaInspector(page, filePath, scope)` — `waitForEvent("filechooser")`, click `scope.getByTestId("button_upload_file")`, `setFiles(filePath)` on the chooser. With `temp_file=True` the FileInput renders the simple `<input>` + button path (NOT `button_open_file_management`), so this is the only correct entry point.

**Test 1 — `showfiles` exposes the Files inspector field**
1. Run `addChatInputComponent`
2. Scope to the Chat Input `.react-flow__node` (`chatInputNodeScope`); assert `input-file-component` and `button_upload_file` have count `0` within that scope (not on the node body — both testids are still mounted in the side-panel inspector, which is why the scope matters)
3. Run `toggleFilesFieldVisible`
4. Within the scope, assert `input-file-component` and `button_upload_file` are visible

**Test 2 — Inspector upload populates the field**
1. Run `addChatInputComponent` → `toggleFilesFieldVisible`
2. Assert `input-file-component` has value `"Upload a file..."` (placeholder literal)
3. Run `uploadFileViaInspector(page, IMAGE_PATH)` with `tests/assets/media/chain.png`
4. Assert `input-file-component` has value `"chain.png"` (single-element list coerced to its element string by the `<input>` rendering)
5. Hover `button_upload_file`; assert its inner `icon-X` reaches `opacity: 1` (button is in "value present" mode)

**Test 3 — Inspector-attached file participates in flow execution**
1. Run `addChatInputComponent` → `toggleFilesFieldVisible` → `uploadFileViaInspector`
2. Assert the field value is `"chain.png"`
3. Run `addChatOutputToCanvas` and `connectChatInputToChatOutput`
4. Click `button_run_chat output`; wait for `"built successfully"` toast
5. Click `playground-btn-flow-io` to open the Playground
6. Assert `img[alt$="chain.png"]` is visible (suffix-match because the server prefixes uploaded filenames with a timestamp)

**Test 4 — Dismiss clears the field**
1. Run `addChatInputComponent` → `toggleFilesFieldVisible` → `uploadFileViaInspector`
2. Assert the field value is `"chain.png"`
3. Hover `button_upload_file`; assert `icon-X` has `opacity: 1`
4. Click `button_upload_file` (in "value present" mode this calls `handleDismissClick`)
5. Assert `input-file-component` has value `"Upload a file..."` (the placeholder literal returned by `value || "Upload a file..."` when the underlying value is `""`)

---

## Validation criterion *(required)*

- The `Files` field is hidden until `showfiles` is toggled, then renders both `input-file-component` and `button_upload_file`.
- A file uploaded via the inspector sets the field value to the file name and switches the upload button to "value present" mode.
- After running ChatInput → ChatOutput from the canvas, the Playground shows the user-side message with the inspector-attached image rendered as `<img alt$="chain.png">`.
- Clicking the upload button while a value is present clears the field back to the `"Upload a file..."` placeholder.

---

## External dependencies *(required)*

- `src/lfx/src/lfx/components/input_output/chat.py:70-78` — defines the FileInput `name="files"` with `advanced=True`, `is_list=True`, `temp_file=True`, `file_types=TEXT_FILE_TYPES + IMG_FILE_TYPES`. Renaming the field, dropping `advanced`, or flipping `temp_file=False` breaks Tests 1, 2, and 4.
- `src/frontend/src/components/core/parameterRenderComponent/components/inputFileComponent/index.tsx` — renders the two branches based on `tempFile`. With `tempFile=True` (Chat Input case) it always renders the `input-file-component` text input + `button_upload_file` regardless of `ENABLE_FILE_MANAGEMENT`. The empty-value placeholder literal `"Upload a file..."` and the dismiss handler (which sets value/file_path to `""`) come from this file.
- `src/frontend/src/pages/FlowPage/components/InspectionPanel/components/InspectionPanelEditField.tsx` — generates the `show${name}` toggle. Renaming the testid pattern breaks Test 1's toggle click and the helper used by Tests 2-4.
- `src/lfx/src/lfx/schema/message.py` — `Message` carries `files: list[str | Image]` and serializes them so the Playground can render the user-side image. Test 3 depends on this propagation chain.
- `src/frontend/src/helpers/create-file-upload.ts` — backs `handleButtonClick` on the FileInput; the hidden `<input type="file">` it creates is what `page.waitForEvent("filechooser")` captures.

---

## What this test does not cover *(optional)*

- **Playground-side attach/swap/remove** — already covered by `playground-output-image.spec.ts` and tracked further in #194.
- **Non-image file type validation** — image happy path only; non-image (`text` types from `TEXT_FILE_TYPES`) is tracked in the non-image follow-up issue.
- **File size limits and rejection** — partially covered by `limit-file-size-upload.spec.ts` for the Files page; canvas-side enforcement may diverge.
- **`is_list=True` multi-file semantics** — only single-file upload is asserted; multi-file behavior (comma-joined display, multiple file paths in the Message) is not exercised.
- **`button_open_file_management` path** — does not apply to Chat Input because `temp_file=True` forces the simple `<input>` + button path.
- **Persistence to the global Files repository** — `temp_file=True` uploads do not land on the Files page; no cross-page assertion is needed and no cleanup is required.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- No API key required — the spec is fully LLM-free.
- `tests/assets/media/chain.png` must be present (already in the repo).
- Test 3 requires the autosave/build pipeline and the Playground to be functional within the configured timeouts.
- Chat Input starts `minimized = True` upstream; `expandFocusedNode` exposes the inspector content. If the expand testids change, all 4 tests break at the helper.

---

## When to review this test *(optional)*

- If `temp_file=True` flips to `False` on the FileInput in `src/lfx/src/lfx/components/input_output/chat.py`, the rendering branch changes (`button_open_file_management` modal becomes the entry point) — the upload helper must be updated.
- If the placeholder literal in `inputFileComponent/index.tsx` changes from `"Upload a file..."`, Tests 2 and 4 fail.
- If the server stops timestamp-prefixing uploaded filenames, the `img[alt$="chain.png"]` suffix match in Test 3 still works (no regression). If the alt attribute pattern changes, Test 3 must be updated.
- If `is_list=True` flips to `False`, the value is stored as a string instead of a single-element array — `toHaveValue("chain.png")` still works because `Array.prototype.toString()` of `["chain.png"]` is `"chain.png"`.

---

## Notes *(optional)*

- The closest existing coverage of this surface is `flow-functionality/general-bugs-shard-3836.spec.ts`, but that test is `@release @components`, requires `OPENAI_API_KEY`, and uses the Basic Prompting template — so it does not run in the weekly `@stable` triage. This spec re-validates the same canvas-inspector surface in isolation, LLM-free, against a minimal ChatInput → ChatOutput flow.
- The upstream backend integration test `src/backend/tests/integration/components/inputs/test_chat_input.py` does not assert anything about the `files` field — it covers only `text/sender/sender_name/session_id`. So the inspector-side path was previously untested both upstream and in this suite.
- The four helper functions (`expandFocusedNode`, `addChatInputComponent`, `addChatOutputToCanvas`, `connectChatInputToChatOutput`) are duplicated from `chat-input-output-component-regression.spec.ts` to avoid editing a shared file in the same PR. A future refactor PR can extract them into `tests/helpers/`.
