# API Projects — download and upload (`/api/v1/projects/{download,upload}`)

**File:** `tests/tests-automations/regression/api/projects/api-projects-transfer.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1707 (Wave 7 — OSS API coverage, `projects` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The two transfer operations of the family, which nothing in the repo drives at all:
exporting a project as an archive and importing one back. The interesting half is the
**collision semantics**, which are the opposite of the sibling endpoint's.

Measured on `1.13.0.dev0`:

| Operation | Answer |
|---|---|
| `GET /api/v1/projects/download/{project_id}` on a project with **no flows** | `404 {"detail":"No flows found in project"}` — an empty project is not downloadable |
| `GET /api/v1/projects/download/{project_id}` with one flow | `200`, body is a **ZIP** (`PK\x03\x04`, 626–652 B for a one-flow project) |
| `POST /api/v1/projects/upload/` with that ZIP while the flows still exist | `422 {"detail":"Flow(s) with the following IDs already exist: <id>. Use the update endpoint or upload_file() for upsert semantics."}` |
| `POST /api/v1/projects/upload/` once those ids are gone | `201`, and the body is a **list of the imported flows** (`FlowRead[]`) — **not** the project object |
| the imported flow | keeps **the same `id`** it had in the archive (which is why re-importing collides) |
| the created project | is named after the **uploaded file**, extension stripped (`p3.zip` → `p3`) |
| `POST /api/v1/projects/upload/` with a non-archive | `400 {"detail":"Invalid JSON file: invalid literal: line 1 column 1 (char 0)"}` |

**The asymmetry worth a test.** `POST /api/v1/flows/upload/` **upserts by id**
(measured in #1699: re-uploading the same flow updates it). `POST /api/v1/projects/upload/`
**refuses** the same collision with a `422` telling the caller to use the update
endpoint. Two sibling importers, opposite behaviour on the identical input; either one
drifting toward the other is a silent data-loss change (upsert where the caller
expected a refusal) that no test would catch today.

**The uploaded file name is a project name, so it obeys the same length rule.** A
project's derived MCP server name is `lf-${sanitize_mcp_name(name)[:26]}` and must be
unique per user, so an archive whose file name shares its first 26 characters with an
existing project is refused `409 MCP server name conflict` (#1409). The spec generates
a four-character label plus a base36 timestamp for exactly that reason.

Two consequences for the test's own shape: the response gives back **flows, not a
project**, so the created project has to be found by listing and matching the file
name; and because the import reuses ids, the happy path must run **after** the source
flow is deleted, which is also the only way to exercise it more than once on a
long-lived instance.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable`: keyless and deterministic — one project, one trivial flow, no run.

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`. Ids are pushed
as they are created; `afterEach` deletes flows first, then projects (via
`helpers/flows/delete-project.ts`), including the project the **import** creates,
which is found by name and by the flow ids it brought back.

**Test 1 — `download refuses an empty project and returns a ZIP for a populated one`**
1. Create a project; `GET /api/v1/projects/download/{id}` → `404`,
   `detail === "No flows found in project"`.
2. Create a flow inside it; download again → `200`, and the first four bytes of
   `response.body()` are `PK\x03\x04`.
3. Keep the buffer for test 2's fixture path (each test builds its own — no shared
   state between tests).

**Test 2 — `upload refuses colliding flow ids and imports once they are gone`**
1. Create a project with one flow and download it.
2. `POST /api/v1/projects/upload/` with the archive **as-is** → `422`; the `detail`
   contains the flow's id and the words `already exist`.
3. Delete the flow and the project (the source is now gone).
4. Upload the archive again → `201`; the body is an array of length 1 whose single
   element has the flow's **original id** and name.
5. `GET /api/v1/projects/` → a project named after the uploaded file (extension
   stripped) exists; `GET /api/v1/projects/{that id}` lists the imported flow.
6. Upload a `text/plain` part instead of an archive → `400`, `detail` starts with
   `Invalid JSON file:`.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with the ZIP
asserted by magic bytes (never by `Content-Type`, which the server does not set), the
collision asserted on the id **inside** the `detail` string, the happy path asserting
that the imported flow keeps its id, and the declared coverage —
`GET /api/v1/projects/download/{project_id}` and `POST /api/v1/projects/upload/` —
matching what the fixture recorded. Zero projects and zero flows left behind, the
imported ones included.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/projects.py` — `download_file` and `upload_file`.
- `src/backend/base/langflow/api/v1/flows.py` — `upload_file`, the upserting sibling
  this file contrasts with.
- No provider key, no model, no network egress.
