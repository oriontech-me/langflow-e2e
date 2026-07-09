# Files Page — navigation, upload, search and bulk actions

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Files page end-to-end surface: empty state, single-file upload (button and
drag-and-drop), multi-type upload, search filtering, and bulk selection with
delete. If these break, users cannot manage the files that Read File / File
components consume.

1. **should navigate to files page and show empty state** — the Files page
   renders its title, empty-state message and upload button on a fresh
   instance.
2. **should upload file using upload button** — a `.txt` fixture uploaded via
   the upload button shows a success toast and appears in the list.
3. **should upload file using drag and drop** — the same fixture uploaded via
   a synthesized DataTransfer drop appears in the list.
4. **should upload multiple files with different types** — `.txt`, `.json`
   and `.py` fixtures all appear in the list after upload.
5. **should search uploaded files** — typing a file's name filters the list
   to matching rows only (non-matching names become invisible), and clearing
   the search restores all rows.
6. **should handle bulk actions for multiple files** — selecting multiple
   rows via checkboxes exposes the bulk toolbar and delete removes the
   selected files.

---

## Tags *(required)*

`@release` `@components` `@files`

Not `@stable`: the file was broken by stale asset paths since the repo
restructure (issue #613) and has no multi-run validation history yet —
promotion is a separate decision after it proves stable in the dailies.

---

## Validation criterion *(required)*

- Upload paths assert the success toast **and** the uploaded file name
  rendered in the list (not just the request).
- Search asserts both directions: matching rows visible, non-matching rows
  invisible, and restoration after clearing.
- Bulk actions assert the checkbox states, the bulk toolbar visibility and
  the post-delete absence of the deleted rows.

---

## External dependencies *(required)*

- Upload fixtures resolved via `resolveAssetPath()` from
  `tests/assets/files/`: `test-file.txt`, `test-file.json`, `test-file.py`
  (#613 — the pre-restructure relative paths pointed at a directory that no
  longer exists).
- Files page UI (`/files`), upload API, and the DataTransfer drop surface.

---

## What this test does not cover *(optional)*

- File consumption by flow components (Read File / Write File) — covered by
  component specs under `core-components/`.
- Upload size limits — covered by `limit-file-size-upload.spec.ts`.

---

## Notes *(optional)*

- Fixture paths resolve through `tests/helpers/filesystem/resolve-asset-path.ts`
  (probes `tests/assets/{media,files,flows}`), so future asset reorganizations
  fail with a clear error instead of a silent ENOENT (#613).
