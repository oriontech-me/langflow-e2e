# Spec: Upload files of different types via the Files page (§5.1 File Upload)

**Test file:** `tests/tests-automations/regression/core-functionality/knowledge-ingestion-management/file-types-upload.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

A user can upload files of **different content types** into their global file
store through the **My Files** page — the Files-page upload path (distinct from
the canvas Read File component that `upload-via-component.spec.ts` exercises, and
from the Chat Input / Playground upload of `limit-file-size-upload.spec.ts`).

The §5.1 checklist bullet names five representative types — **txt, pdf, json,
py, wav** — spanning plain text, a binary document (pdf), structured text
(json), source code (py) and binary audio (wav). This mix is deliberate: the
canvas **Read File** component only accepts its `VALID_EXTENSIONS` allow-list
(`TEXT_FILE_TYPES` + Docling formats), which **excludes `wav`** — so wav/binary
type coverage can only live on the Files page, whose `POST /api/v2/files`
endpoint enforces no extension allow-list (only size and filename-safety
checks). If the Files-page upload silently dropped, corrupted, or rejected one
of these types, or lost the file's extension, this test fails on that specific
type.

One `test()` per type keeps each type independently falsifiable — a regression
affecting only pdf or only wav fails exactly that row, not the whole suite.

---

## Tags *(required)*

`@stable` `@release` `@files`

(`@stable` + `@release`: cross-cutting — happy-path upload coverage, run in the
daily-stable workflow. `@files`: functional — file upload/ingestion surface.)

---

## Step by step *(required)*

Parameterized per type over `{ txt, pdf, json, py, wav }`; each `test()`:

1. Bootstrap to the home page (`awaitBootstrapTest(page, { skipModal: true })`,
   which itself handles the empty-instance first-run by creating a Basic
   Prompting flow); assert `mainpage_title` is visible.
2. Open **My Files** (sidebar button labeled "My Files" — it carries no testid,
   so click it by exact text); assert the page title contains "Files".
3. Click `upload-file-btn`, which opens a native file chooser.
4. Set a **uniquely-named** in-memory file on the chooser
   (`<random-stem>.<ext>`, real asset bytes read from disk) and gate on the
   upload completing server-side: `POST /api/v2/files` with a `< 300` status.
5. From that upload response body, assert the stored record proves the type was
   accepted and its extension preserved: `name === <random-stem>` (Langflow
   strips the extension from `name`) and `path` ends with `.<ext>`.
6. Assert the uploaded file appears in the Files list UI as
   `<random-stem>.<ext>`.

---

## Validation criterion *(required)*

For each of the five types, after uploading `<random-stem>.<ext>` through the
My Files **Upload** button:

- the `POST /api/v2/files` upload request returns a success status (`< 300`) —
  the type was **accepted** by the store; and
- the upload response record has `name === <random-stem>` and `path` ending in
  `.<ext>` — the file's **extension was preserved** (the distinctive,
  type-specific observable); and
- a row labeled `<random-stem>.<ext>` is **visible** in the Files list — the UI
  reflects the stored file.

A regression that rejects a type, corrupts the upload, or drops the extension
fails the specific type's row. The random stem makes an accidental match with a
pre-existing file impossible and isolates parallel workers.

---

## External dependencies *(required)*

- `src/frontend/src/pages/MainPage/**` (My Files page) — the `upload-file-btn`
  control, the file-list rendering, and the "My Files" sidebar entry.
- `src/backend/base/langflow/api/v2/files.py` — `POST /api/v2/files` (upload;
  no extension allow-list — only size + filename-safety), `GET /api/v2/files`,
  `DELETE /api/v2/files/{id}` (cleanup). If an extension allow-list is
  introduced here, wav/pdf coverage must be revisited.
- Assets (resolved via `resolveAssetPath`, which probes
  `tests/assets/{media,files,flows}`): `test-file.txt`, `test-file.pdf`,
  `test-file.json`, `test-file.py` (all under `files/`) and
  `test_audio_file.wav` (under `media/`).
- No model provider credentials required (pure upload/storage, no LLM).

---

## What this test does not cover *(optional)*

- The canvas **Read File** component upload + content read-back (covered by
  `upload-via-component.spec.ts`) — and note that surface **cannot** upload wav.
- Chat Input / Playground file upload and the file-size limit (covered by
  `limit-file-size-upload.spec.ts`).
- Files-page CRUD beyond upload — drag-and-drop upload, search, bulk delete
  (covered by `files-page.spec.ts`).
- Whether each type is *parsed/ingested* downstream (Split Text, embeddings,
  vector store) — that is §5.2 Processing and Vectorization.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (auto_login).

---

## Flow & file cleanup *(notes)*

Two classes of persistent artifact, both cleaned id-scoped in `afterEach`:

- **Uploaded files:** each upload persists in the user's global file store, so
  the id returned by each `POST /api/v2/files` is tracked and
  `DELETE /api/v2/files/{id}` removes it. Behavioral force-fail: no-op the file
  cleanup and orphan files accumulate across runs.
- **Flow:** `awaitBootstrapTest` creates a Basic Prompting flow **only** on a
  truly empty first-run instance; to stay safe, `POST /api/v1/flows` 201 ids are
  captured via the Pattern A response accumulator and deleted with `deleteFlow`
  (404-tolerant). Never `page.url()` (#681).
