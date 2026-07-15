# Files Page — navigation, upload, search and bulk actions

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The Files page end-to-end surface: page chrome and upload affordances,
single-file upload (button and drag-and-drop), multi-type upload, search
filtering, and bulk selection with delete. If these break, users cannot manage
the files that Read File / File components consume.

1. **should navigate to Files page and expose upload affordances** — the Files
   page renders its title and the Upload button, the two affordances present in
   both of the page's render trees regardless of how many files the account
   holds (see Notes).
2. **should upload file using upload button** — a `.txt` fixture uploaded via
   the upload button shows a success toast and appears in the list.
3. **should upload file using drag and drop** — after seeding one file so the
   drag-wrap drop surface renders, a fixture uploaded via a synthesized
   DataTransfer drop appears in the list.
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

`@stable` `@release` `@components` `@files`

Promoted to `@stable` (issue #669): the stale-asset-path breakage (#613) is
resolved via `resolveAssetPath()`, every test now carries a hard, falsifiable
assertion (the previous `expect(locator).toBeTruthy()` checks were dead —
a Locator is always truthy), and each upload/flow artifact is cleaned up
id-scoped so the specs are safe under the parallel daily-stable run.

---

## Validation criterion *(required)*

- Navigation asserts the Files page chrome **deterministically**: title
  `Files` and the Upload button, which render in **both** page trees. The
  search input, the drag-and-drop wrapper and the literal empty-state
  ("No files") message are **not** asserted here — each renders in only one of
  the two trees, and the shared-account parallel daily run cannot guarantee
  which tree is showing (other `@files` specs upload concurrently), so they are
  non-deterministic observables for this test. The search input and drag-wrap
  are instead covered by the search and drag-drop tests, which each upload a
  file first to force the files-exist tree.
- Upload paths assert the success toast **and** the uploaded file name
  rendered in the list, both via retrying `toBeVisible` (never a one-shot
  `.isVisible()`, which raced the row render — the pre-promotion flake).
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
- Files page UI (`/files`), upload API (`POST /api/v2/files`), and the
  DataTransfer drop surface.

---

## Cleanup *(required)*

Every uploaded file lands in the user's global `/api/v2/files` store and, on a
truly empty first-run instance, `awaitBootstrapTest` creates a Basic Prompting
flow. Both are persistent artifacts, so `afterEach` deletes them id-scoped:
file ids captured from the `POST /api/v2/files` (2xx) responses, flow ids from
`POST /api/v1/flows` (201) responses — never `page.url()` (#681). Scoped
deletion (never a global wipe) keeps the specs safe under parallel workers
(#465).

---

## What this test does not cover *(optional)*

- File consumption by flow components (Read File / Write File) — covered by
  component specs under `core-components/`.
- Upload size limits — covered by `limit-file-size-upload.spec.ts`.
- The literal empty-account "No files" empty state — non-deterministic in the
  shared-account parallel run (see Validation criterion).

---

## Notes *(optional)*

- Fixture paths resolve through `tests/helpers/filesystem/resolve-asset-path.ts`
  (probes `tests/assets/{media,files,flows}`), so future asset reorganizations
  fail with a clear error instead of a silent ENOENT (#613).
- **Two render trees.** `FilesTab.tsx` renders a completely different tree by
  file count: with files it shows the search input + a `drag-wrap-component`
  wrapped grid; empty, it shows a `CardsWrapComponent` "No files" card with no
  search input and no `drag-wrap-component`. Adding id-scoped cleanup made each
  test start from a potentially empty account, exposing that the drag-drop test
  (and any drag-wrap assertion) only worked before because earlier no-cleanup
  tests left files behind. Tests that need the files-exist tree upload a file
  first; the navigation test only asserts the tree-independent chrome.
