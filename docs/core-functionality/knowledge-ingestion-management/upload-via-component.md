# Spec: Upload a file via the Read File component (§5.1 File Upload)

**Test file:** `tests/tests-automations/regression/core-functionality/knowledge-ingestion-management/upload-via-component.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

A user can bring a local file into a flow through the **Read File** component's
file picker — the canvas-component upload path (distinct from the Chat Input /
Playground upload that `limit-file-size-upload.spec.ts` exercises). The full
chain must work end to end:

1. The Read File component is added to the canvas and exposes a file field with
   an "open file management" affordance.
2. Uploading a local file through the component's file-management modal makes
   the file appear in **My Files**, pre-selected.
3. Confirming the selection **attaches the file to the component** (the node
   shows the file chip).
4. Running the component **builds successfully** and its output is the file's
   **exact text content** — the distinctive, causal observable.

The file's content is a unique sentinel, so the output match cannot be
coincidental: `test-file.txt` = `This is a test file for upload functionality
testing.`.

## Validation criterion (concrete, distinctive)

After uploading `test-file.txt` through the Read File component and running the
node:

- the node shows a successful build badge (`node_duration_read file`), and
- the component's **raw-content output** (`output-inspection-raw content-file`
  → the output modal `textarea`) equals the file's exact text
  `This is a test file for upload functionality testing.`.

A regression in the upload, the file→component attachment, or the component's
read path fails a specific step — the output text is the end-to-end proof.

---

## Tags

`@stable` `@release` `@files` `@components`

(`@files`: file upload/ingestion surface. `@components`: canvas-component
configuration. Created `@stable` by #671 after deterministic validation.)

---

## Step by step

1. Bootstrap to the templates modal and open a **blank flow**
   (`awaitBootstrapTest` → `blank-flow`); wait for the sidebar to be
   interactive (`sidebar-search-input` visible).
2. Add the **Read File** component: search "Read File" in the sidebar, click
   `add-component-button-read-file`.
3. Open the component's file management modal (`button_open_file_management`).
4. Upload the local asset: click the dropzone (`drag-files-component`), which
   opens a native file chooser, and set `test-file.txt` on it
   (`Promise.all([page.waitForEvent("filechooser"), click])` → `setFiles`).
5. Assert the file appears and is selected (`file-item-test-file`,
   `checkbox-test-file`, "1 selected"); confirm with `select-files-modal-button`.
6. Assert the file attached to the component (`file-item-test-file` +
   `remove-file-button-test-file` render on the node).
7. Run the component (`button_run_read file`); assert `node_duration_read file`
   (successful build).
8. Open the output inspector (`output-inspection-raw content-file`); assert the
   output modal `textarea` value equals the sentinel file content.

---

## External dependencies

- Sidebar/component testids: `add-component-button-read-file`,
  `button_open_file_management`, `drag-files-component`,
  `file-item-test-file`, `checkbox-test-file`, `select-files-modal-button`,
  `remove-file-button-test-file`, `button_run_read file`,
  `node_duration_read file`, `output-inspection-raw content-file` (scouted
  live on 1.11.0.dev41).
- Files API: `POST /api/v2/files` (upload), `GET /api/v2/files`,
  `DELETE /api/v2/files/{id}` (cleanup — the upload persists in the user's
  global file store).
- Asset `tests/assets/files/test-file.txt` (resolved via `resolveAssetPath`).
- No model provider credentials required (pure file read, no LLM).

---

## What this test does not cover

- Chat Input / Playground file upload (covered by
  `limit-file-size-upload.spec.ts`).
- The file-size limit path (same sibling spec).
- Non-text file types (pdf/json/wav) — a `@files` different-types spec is a
  separate §5.1 bullet.
- The Files management PAGE CRUD (covered by `files-page.spec.ts`).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (auto_login).

---

## Flow & file cleanup

Two persistent artifacts, both cleaned id-scoped in `afterEach`:

- **Flow:** the blank flow is created after `awaitBootstrapTest` (which itself
  may create a bootstrap flow), so the canvas URL id races the bootstrap id —
  capture via the **Pattern A response accumulator** (`page.on("response")`
  collecting every `POST /api/v1/flows` 201 id) and delete all with
  `deleteFlow` (404-tolerant). Never `page.url()` here (#681).
- **Uploaded file:** the upload persists in the user's global file store, so
  list `GET /api/v2/files` and `DELETE /api/v2/files/{id}` the uploaded file
  by name in `afterEach` — otherwise repeated runs accumulate
  `test-file.txt`, `test-file (1).txt`, … Behavioral force-fail: no-op the file
  cleanup and the file count grows.
