# API Files — v2, the user-scoped file store

**File:** `tests/tests-automations/regression/api/files/api-files-v2-store.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1692 (Wave 7 — OSS API coverage). Denominator, definitions and the
gauge this spec feeds: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The full contract of the **v2 files** router — the user-scoped store behind the
Files page and behind every component that picks an already-uploaded file. Eight
operations. Three UI specs touch this surface today
(`knowledge-ingestion-management/files-page`, `file-types-upload`,
`upload-via-component`) but drive it through the browser and use the API only to
clean up; none asserts a status or a body shape, so by the definition in the gauge
doc the family is uncovered.

Measured contracts (`1.13.0.dev0`, auto-login bearer, multipart `file=@…`):

| Operation | Answer |
|---|---|
| `POST /api/v2/files` | `201` `{id, name, path, size, provider}`; `name` is the filename **without** its extension, `path` is `<user_id>/<original filename>`, `provider` is `null` |
| `GET /api/v2/files` | `200`, array of `{name, user_id, size, created_at, id, path, provider, updated_at}` |
| `GET /api/v2/files/{file_id}` | `200`, `application/octet-stream` — the **content**, not metadata |
| `PUT /api/v2/files/{file_id}?name=<new>` | `200`, `name` updated, `path` **unchanged** (the rename is metadata-only) |
| `DELETE /api/v2/files/{file_id}` | `200` `{"detail":"File <name> deleted successfully"}` |
| `POST /api/v2/files/batch/` | `200`, `application/x-zip-compressed`; a ZIP whose entries are named `<display name>.<original extension>` — **not** the uploaded filename |
| `DELETE /api/v2/files/batch/` | `200` `{"message":"<N> files deleted successfully"}` |
| `DELETE /api/v2/files` | wipes **every** file of the caller — `@destructive` |

Two contract details worth the asserts, both measured rather than assumed:

**The envelope key differs between the two deletes.** A single delete answers
`detail`, the batch delete answers `message`. A client normalising on one of them
silently loses the other's confirmation, so both are asserted by key.

**The display name is not the filename, and the store suffixes duplicates.** An
upload of `test-file.txt` followed by `test-file.json` reports the second as
`name: "test-file (1)"` — display names are unique per user, enforced by
suffixing — and its ZIP member reads `test-file (1).json`. So the batch assertion
is written against the names the API itself reported, never against the asset
filenames: the suffix appears whenever a file of that name already exists,
including one another worker uploaded, which would make an asset-name assertion
fail depending on the order the suite happened to run in.

**The trailing slash on `batch/` is load-bearing.** Without it the request falls
through to `/api/v2/files/{file_id}`:

| Request | Answer |
|---|---|
| `POST /api/v2/files/batch` | `405 Method Not Allowed` |
| `DELETE /api/v2/files/batch` | `422`, `type: "uuid_parsing"`, `loc: ["path","file_id"]`, `input: "batch"` |

That is asserted, not just recorded: it is the difference between a batch call and
a call that hits the single-file route with `"batch"` as the id, and it is the case
that makes `rstrip("/")` the wrong normalisation for the whole inventory.

---

## Tags *(required)*

`@api` `@files` `@stable` — tests 1–4.
`@api` `@files` `@destructive` — test 5.

Test 5 (`DELETE /api/v2/files`, the wipe) is **`@destructive` and deliberately not
`@stable`**: the store is per-user and every worker shares the superuser, so the
wipe would delete files other tests are actively reading. `playwright.config.ts`
`grepInvert`s `@destructive` out of every normal run, and CI runs it alone with
`PW_DESTRUCTIVE=1` at `workers: 1`. Combining it with `@stable` would put it in a
lane that has no destructive pass, where it would silently never run (#1010).

---

## Step by step *(required)*

Five tests over Playwright's `request` fixture, each obtaining a bearer through
`getAuthToken()` and declaring its coverage with `declareApiCoverage()`.

Cleanup is id-scoped: every uploaded file's id (from the `201`) goes into a
tracker, and `afterEach` deletes exactly those ids — the store is shared, so a
listing-diff cleanup would delete another worker's uploads (the same destructive
class as `cleanAllFlows`, #553/#518).

**Test 1 — `uploads a file, the store reports it, and deleting it removes it`**
1. `POST /api/v2/files` with `tests/assets/files/test-file.txt`.
2. Assert `201`; `id` a UUID; `name === "test-file"` (extension stripped);
   `path` ending `/test-file.txt`; `size` equal to the asset's byte length;
   `provider === null`.
3. `GET /api/v2/files` → `200`; the entry for that id carries the same `name`,
   `size` and `path`, plus `created_at`/`updated_at`/`user_id`.
4. `GET /api/v2/files/{id}` → `200`, `application/octet-stream`, body
   **byte-identical** to the asset.
5. `DELETE /api/v2/files/{id}` → `200` whose body key is **`detail`**, naming the
   file — asserted here rather than left to the cleanup hook, because cleanup is
   not an assertion: it resolves on any status, so the single-delete contract
   would be exercised on every run and verified on none. It is also what makes
   the `detail`-versus-`message` asymmetry with the batch delete an assertion
   instead of a note.
6. `GET /api/v2/files` → the id is gone from the listing.

**Test 2 — `renames a file without moving it`**
1. Upload the asset.
2. `PUT /api/v2/files/{id}?name=renamed-<Date.now()>` → `200`, `name` equal to the
   value sent, `path` **unchanged** from the upload response.
3. `GET /api/v2/files` → the entry shows the new `name` and the old `path`.
4. `GET /api/v2/files/{id}` still returns the same bytes — the rename touched
   metadata only.

**Test 3 — `zips a batch and deletes a batch`**
1. Upload two distinct assets (`test-file.txt`, `test-file.json`), keeping both ids.
2. `POST /api/v2/files/batch/` with the id array → `200`,
   `content-type: application/x-zip-compressed`; the body starts with the ZIP magic
   `PK\x03\x04` and contains both members named `<reported name>.<extension>`.
3. `DELETE /api/v2/files/batch/` with the same array → `200`,
   `message === "2 files deleted successfully"`.
4. `GET /api/v2/files` → neither id is present.

**Test 4 — `the batch path requires its trailing slash`**
1. Upload one file (so the store is non-empty and a working batch call is possible).
2. `POST /api/v2/files/batch` (no slash) with the id array → `405`.
3. `DELETE /api/v2/files/batch` (no slash) → `422` whose first `detail` entry has
   `type === "uuid_parsing"`, `loc === ["path","file_id"]` and `input === "batch"`.
4. The file uploaded in step 1 is **still listed** — the malformed calls deleted
   nothing. This is the load-bearing half: a `405`/`422` that had nonetheless
   deleted the file would be the actual hazard.

**Test 5 — `DELETE /api/v2/files empties the caller's store` (`@destructive`)**
1. Upload two files.
2. `GET /api/v2/files` → both present.
3. `DELETE /api/v2/files` → `200`.
4. `GET /api/v2/files` → `[]`. The assertion is the empty store, not a count
   delta: this endpoint's contract is "everything", and asserting a delta would
   pass against an endpoint that deleted only the two files this test uploaded.

---

## Validation criterion *(required)*

Tests 1–4 pass three consecutive times at `--retries=0 --workers=1`, and test 5
passes under `PW_DESTRUCTIVE=1` on an instance nothing else is using, with:

- the download body compared byte-for-byte against the on-disk asset,
- the single delete asserted on its `detail` key and the id gone from the listing,
- the rename asserted on `name` **and** on `path` staying put,
- the batch ZIP identified by its magic bytes and both member names,
- both slash-less batch calls refused **and** the file surviving them,
- the declared coverage — all 8 v2 operations across the five tests — matching what
  the fixture recorded,
- no file left in the store (`GET /api/v2/files` back to its pre-test contents).

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- Repo assets: `tests/assets/files/test-file.txt`, `tests/assets/files/test-file.json`.
- Upstream route definitions: `src/backend/base/langflow/api/v2/files.py`.
- No provider key, no model, no network egress.
