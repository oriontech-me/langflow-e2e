# API Files — v1, flow-scoped store and bundled profile pictures

**File:** `tests/tests-automations/regression/api/files/api-files-v1-flow-scoped.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1692 (Wave 7 — OSS API coverage). Denominator, definitions and the
gauge this spec feeds: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The full contract of the **v1 files** router — the flow-scoped file store every
component that reads or writes a file goes through, plus the bundled
profile-picture assets the account UI renders. Seven operations, none of them
driven as a contract by any existing spec: the three specs that touch files today
(`knowledge-ingestion-management/files-page`, `file-types-upload`,
`upload-via-component`) drive the **v2** store through the UI and use it only as
cleanup.

A regression here breaks file upload from a component, the download affordance,
and every integration that pushes a file into a flow before running it. The
`images/` endpoint additionally backs the chat preview of image outputs.

Measured contracts (`1.13.0.dev0`, auto-login bearer):

| Operation | Answer |
|---|---|
| `POST /api/v1/files/upload/{flow_id}` | `201` `{flowId, file_path}`; `file_path` is `<flow_id>/<YYYY-MM-DD_HH-MM-SS>_<original name>` |
| `POST /api/v1/files/upload/{unknown flow uuid}` | `404` `{"detail":"Flow not found"}` |
| `GET /api/v1/files/list/{flow_id}` | `200` `{"files":["<stamped name>"]}` |
| `GET /api/v1/files/download/{flow_id}/{file_name}` | `200`, `application/octet-stream`, byte-identical to the upload |
| `GET /api/v1/files/images/{flow_id}/{png}` | `200`, `image/png`, 32058 bytes for `tests/assets/media/chain.png` |
| `GET /api/v1/files/images/{flow_id}/{txt}` | **`500`** `{"detail":"Content type text/plain is not an image"}` |
| `DELETE /api/v1/files/delete/{flow_id}/{file_name}` | `200` `{"message":"File <name> deleted successfully"}`, and the listing drops to `{"files":[]}` |
| `GET /api/v1/files/profile_pictures/list` | `200` `{"files":["People/People Avatar-01-05.svg", …]}` |
| `GET /api/v1/files/profile_pictures/{folder}/{file}` | `200`, `image/svg+xml` |

**Recorded hazard, asserted from the positive side only.** A non-image passed to
`images/` answers **`500`**, not `4xx`. That is a client error served as a server
error, and the spec asserts the *positive* path (a real PNG returns `image/png`)
while recording the `500` here — pinning a `500` as expected behaviour would make
the suite defend the defect, and this repo does not make that product choice by
assertion (the shape `authz/audit`'s empty-filter hazard took in #1555).

---

## Tags *(required)*

`@api` `@files` `@stable`

`@stable` from the outset: the family needs no provider key, no model and no
canvas, so nothing here depends on an LLM electing to act — the condition
`CLAUDE.md` sets for a spec entering the daily in its own PR.

---

## Step by step *(required)*

Four tests over Playwright's `request` fixture. Each obtains a bearer through
`getAuthToken()` and declares its coverage with `declareApiCoverage()`, which the
fixture verifies against the requests actually issued.

Flow lifecycle: tests 1–3 create their own flow via `POST /api/v1/flows/` with a
`Date.now()`-suffixed name, keep the id from the `201`, and `afterEach` deletes
**exactly that id** — never a listing diff, never a name-scoped or global wipe,
which under this suite's parallelism deletes flows other workers are driving
(#553). Uploaded files are deleted before the flow, so a failure mid-test leaks
neither.

**Test 1 — `upload, list and download round-trip a flow-scoped file`**
1. Create a flow; upload `tests/assets/files/test-file.txt` to
   `POST /api/v1/files/upload/{flow_id}`.
2. Assert `201`, `flowId === flow id`, and `file_path` starting with `<flow_id>/`
   and ending with `_test-file.txt`.
3. `GET /api/v1/files/list/{flow_id}` → `200`, `files` contains exactly the stamped
   name from step 2.
4. `GET /api/v1/files/download/{flow_id}/{name}` → `200`,
   `content-type: application/octet-stream`, and the body **byte-identical** to the
   asset read from disk (the assertion is the bytes, not the length — a truncating
   proxy passes a length check).

**Test 2 — `deletes a flow-scoped file and the listing reflects it`**
1. Create a flow, upload the asset (as above).
2. `DELETE /api/v1/files/delete/{flow_id}/{name}` → `200`, body `message` naming the
   file.
3. `GET /api/v1/files/list/{flow_id}` → `200` with `files: []`.
4. `GET /api/v1/files/download/{flow_id}/{name}` → a non-2xx (the file is gone).
   The status is asserted as "not 2xx" rather than a specific code, because the
   code for a missing flow-scoped file is not part of this contract and pinning it
   would be pinning an implementation detail.

**Test 3 — `serves an image through images/ and refuses an unknown flow`**
1. Create a flow, upload `tests/assets/media/chain.png`.
2. `GET /api/v1/files/images/{flow_id}/{name}` → `200`, `content-type: image/png`,
   body length equal to the asset's.
3. `POST /api/v1/files/upload/{a random UUID}` → `404` with
   `detail === "Flow not found"` — the premise assertion for the flow scoping: a
   store that accepted a file for a nonexistent flow would make every other
   assertion here meaningless.

**Test 4 — `serves the bundled profile pictures`**
1. `GET /api/v1/files/profile_pictures/list` → `200`, `files` non-empty and every
   entry shaped `<folder>/<name>.svg`.
2. Take the first entry, split it, and
   `GET /api/v1/files/profile_pictures/{folder}/{file}` → `200`,
   `content-type: image/svg+xml`, body starting with `<?xml` or `<svg`.
3. No flow, no cleanup: these are read-only bundled assets.

---

## Validation criterion *(required)*

All four tests pass three consecutive times at `--retries=0 --workers=1`, with:

- the download body compared byte-for-byte against the on-disk asset,
- the `images/` response carrying `image/png` (not merely `200`),
- `POST` to an unknown flow uuid answering `404 Flow not found`,
- the declared coverage — all 7 v1 operations — matching what the fixture recorded,
- no flow left behind (`GET /api/v1/flows/` count unchanged across the run).

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- Repo assets: `tests/assets/files/test-file.txt`, `tests/assets/media/chain.png`.
- Upstream route definitions: `src/backend/base/langflow/api/v1/files.py`.
- No provider key, no model, no network egress.
