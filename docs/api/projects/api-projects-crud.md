# API Projects — CRUD (`/api/v1/projects`)

**File:** `tests/tests-automations/regression/api/projects/api-projects-crud.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1707 (Wave 7 — OSS API coverage, `projects` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

Six of the eight `projects` operations as a contract: the create/read/update/delete
lifecycle of a project the test owns. `api/flows/api-folders-crud.spec.ts` already
drives three of them (create, list, delete) but asserts only `id` and `name`, declares
nothing, and never touches `GET {id}`, `PATCH` or `PUT`. This file asserts the shapes
and the refusals, and declares all six so they count.

Measured on `1.13.0.dev0` before the spec was written:

| Operation | Answer |
|---|---|
| `POST /api/v1/projects/` `{name, description}` | `201 {name, description, auth_settings, id, parent_id}` — **no `flows` key** |
| `POST /api/v1/projects/` with a **name that already exists** | `201`, name suffixed `"<name> (1)"`; only the name is rewritten — the rest of the body is stored as sent |
| `POST /api/v1/projects/` `{description}` only | `422`, `detail[0].loc === ["body","name"]`, `type: "missing"` |
| `GET /api/v1/projects/` | `200`, a list whose rows carry **`is_owner` and `owner_username`** — two keys the create response does not have |
| `GET /api/v1/projects/{project_id}` | `200`, the create shape **plus `flows: [...]`** |
| `GET /api/v1/projects/{project_id}?page=&size=` | `200` with a **different envelope**: `{folder, flows}`, the paginated read — one operation, two shapes |
| `GET /api/v1/projects/{unknown uuid}` | `404 {"detail":"Project not found"}` |
| `PATCH /api/v1/projects/{project_id}` `{description}` | `200` — partial, `name` preserved |
| `PUT /api/v1/projects/{project_id}` `{description}` | **`422` on `["body","name"]`** — `PUT` *requires* `name` where `PATCH` does not, and otherwise merges just like it (a `PUT` with only `name` preserves `description`) |
| `DELETE /api/v1/projects/{project_id}` | `204`; **the project's flows are deleted with it** (a flow that was in it answers `404` afterwards) |
| `DELETE` of the same id again | `404 {"detail":"Project not found"}` |

**The suffixing has a length ceiling, and it decides how this file names things.**
Creating a project derives an MCP server named `lf-${sanitize_mcp_name(name)[:26]}`
(`MAX_MCP_SERVER_NAME_LENGTH` is 30 minus the `lf-` prefix) which must be unique per
user, so two projects whose names share their first 26 characters are refused with
`409 MCP server name conflict` — a product behaviour reproducible with two ordinary
names, filed as **#1409** and documented in `docs/mcp/server/mcp-server-project-config.md`.
It bites here twice: a name long enough to fill the cut cannot have a `" (1)"` twin at
all (the twin truncates back onto the original slug), which is why the generated names
in this file use a five-character label plus a base36 timestamp, and why the rename in
test 2 appends one character rather than a word.

The `PUT`/`PATCH` pair is the finding worth pinning: two verbs, the same merge
behaviour, different required fields — the same asymmetry `PUT /api/v1/flows/{id}`
showed in #1699. Nothing today would notice if `PUT` started replacing instead of
merging.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable`: no provider, no model, no run — a project and a trivial flow are the whole
fixture.

---

## Step by step *(required)*

Three tests over the `request` fixture, declaring through `apiCoverage`. Every id the
tests create is pushed as it is created and deleted in `afterEach` — flows first, then
projects, through `helpers/flows/delete-project.ts` (which verifies the deletion and
retries the transient `500` of #965 rather than resolving on any status).

**Test 1 — `a project is created, listed, read with its flows and deleted by id`**
1. `POST /api/v1/projects/` → `201`; assert the exact key set and that `flows` is absent.
2. `GET /api/v1/projects/` → `200`; find the row **by id** (never a length assertion —
   the list is instance-wide and the suite runs parallel workers) and assert
   `is_owner === true` and `owner_username` is a non-empty string.
3. `POST /api/v1/flows/` with `folder_id` = the project → `201`.
4. `GET /api/v1/projects/{id}` → `200`; `flows` contains exactly that flow id.
5. `GET /api/v1/projects/{id}?page=1&size=1` → `200`; the body has keys `folder` and
   `flows` and **not** `id` — the paginated envelope.
6. `DELETE /api/v1/projects/{id}` → `204`; `GET /api/v1/flows/{flow id}` → `404`
   (the cascade); `DELETE` again → `404 "Project not found"`.

**Test 2 — `PATCH is partial, PUT merges but refuses a body without a name`**
1. Create a project with a description.
2. `PATCH {description}` → `200`, `name` unchanged.
3. `PUT {description}` (no name) → `422` on `["body","name"]`.
4. `PUT {name}` → `200`, `description` unchanged — the merge.
5. `GET {id}` confirms the last write won on `name` and nothing else moved.

**Test 3 — `a duplicate name is suffixed and the required field is enforced`**
1. Create a project with a unique name.
2. Create a second one with **the same** name and a different description → `201`,
   `name === "<name> (1)"`, the description **as sent**, and a new `id`.
3. `POST` with no `name` → `422` on `["body","name"]`.
4. `GET /api/v1/projects/{random uuid}` → `404 "Project not found"`.

---

## Validation criterion *(required)*

The three tests pass three consecutive times at `--retries=0 --workers=1`, with the
create/list/read shapes asserted as key sets (not `toHaveProperty` on one field), the
two `422`s asserted on `detail[0].loc`, the cascade asserted by the flow's `404`, and
the declared coverage — `POST /api/v1/projects/`, `GET /api/v1/projects/`,
`GET /api/v1/projects/{project_id}`, `PATCH`, `PUT`, `DELETE` — matching what the
fixture recorded. Zero projects and zero flows left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/projects.py` — the router under test.
- `src/backend/base/langflow/services/database/models/folder/model.py` — `FolderRead`
  / `FolderReadWithFlows`, the two response shapes asserted here.
- No provider key, no model, no network egress.
