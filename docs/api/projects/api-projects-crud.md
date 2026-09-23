# API Projects — CRUD (`/api/v1/projects`)

**File:** `tests/tests-automations/regression/api/projects/api-projects-crud.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`; test 4 on `1.13.0.dev21`)

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
| `POST /api/v1/projects/` for a second name sharing its **first 26 characters** with an existing one | `201` from `1.13.0.dev21` on; each project gets its own `lf-…` MCP server entry, the second under a fallback name with an id suffix. `409 MCP server name conflict` on every image before it, back to at least `1.10.3` (#1409) |
| `POST /api/v1/projects/` `{description}` only | `422`, `detail[0].loc === ["body","name"]`, `type: "missing"` |
| `GET /api/v1/projects/` | `200`, a list whose rows carry **`is_owner` and `owner_username`** — two keys the create response does not have |
| `GET /api/v1/projects/{project_id}` | `200`, the create shape **plus `flows: [...]`** |
| `GET /api/v1/projects/{project_id}?page=&size=` | `200` with a **different envelope**: `{folder, flows}`, the paginated read — one operation, two shapes |
| `GET /api/v1/projects/{unknown uuid}` | `404 {"detail":"Project not found"}` |
| `PATCH /api/v1/projects/{project_id}` `{description}` | `200` — partial, `name` preserved |
| `PUT /api/v1/projects/{project_id}` `{description}` | **`422` on `["body","name"]`** — `PUT` *requires* `name` where `PATCH` does not, and otherwise merges just like it (a `PUT` with only `name` preserves `description`) |
| `DELETE /api/v1/projects/{project_id}` | `204`; **the project's flows are deleted with it** (a flow that was in it answers `404` afterwards) |
| `DELETE` of the same id again | `404 {"detail":"Project not found"}` |

**The suffixing used to have a length ceiling, and it still decides how this file
names things.** Creating a project derives an MCP server named
`lf-${sanitize_mcp_name(name)[:26]}` (`MAX_MCP_SERVER_NAME_LENGTH` is 30 minus the `lf-`
prefix). Until `1.13.0.dev20` that derived name had to be unique per user, so two
projects whose names share their first 26 characters were refused with
`409 MCP server name conflict`. That product behaviour was reproducible with two ordinary
names, filed as **#1409** (`LE-2648`) and documented in
`docs/mcp/server/mcp-server-project-config.md`. It bit this file twice: a name long
enough to fill the cut could not have a `" (1)"` twin at all (the twin truncates back
onto the original slug). That is why the generated names in this file use a
five-character label plus a base36 timestamp, and why the rename in test 2 appends one
character rather than a word. The short names stay, so tests 1–3 still pass on an image
older than the fix.

**Test 4 pins the fix (#1409).** langflow-ai/langflow#15144 (merged 2026-09-18 into
`release-1.12.3`) makes `validate_mcp_server_for_project` fall back to a second name
with an id suffix when another project already owns the base name. The first nightly
carrying it is `1.13.0.dev21`: `compare/<fix>...v1.13.0.dev20` is diverged, and
`...v1.13.0.dev21` is behind 0. The test asserts the observable, not the fallback's
format: both projects exist, and each has its own MCP server entry, identified by the
project id in the entry's `args` rather than by the name.

The `PUT`/`PATCH` pair is the finding worth pinning: two verbs, the same merge
behaviour, different required fields — the same asymmetry `PUT /api/v1/flows/{id}`
showed in #1699. Nothing today would notice if `PUT` started replacing instead of
merging.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable`: no provider, no model, no run — a project and a trivial flow are the whole
fixture.

Test 4 carries `@mcp` besides `@api` `@workspace` `@stable`, since the
entries it reads back live on the MCP servers API. On any image before
`1.13.0.dev21` it fails by design, at the second create with `Received: 409`. It is
`@stable` because every lane that runs the tag runs the nightly. A `manual.yml` dispatch
against an older tag will show it red, and that red is the old defect, not a new one.

---

## Step by step *(required)*

Four tests over the `request` fixture, declaring through `apiCoverage`. Every id the
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

**Test 4 — `two projects sharing their first 26 characters are both created, each with its own MCP server`** *(#1409)*
1. Build a head that is unique per run and at least 26 sanitized characters long: a
   label, a base36 timestamp, a random tail and a fixed padding. The per-run part
   sits inside the first 26 characters, so two runs never share a base name, and the
   two names in the pair differ only **after** the cut.
2. `POST /api/v1/projects/` `{name: "<head> alpha"}` → `201`.
3. `POST /api/v1/projects/` `{name: "<head> beta"}` → **`201`**. This is the call that
   answered `409` before the fix.
4. `GET /api/v1/projects/` → both ids are present, found by id.
5. `GET /api/v2/mcp/servers` → `200` array. For each `lf-` entry, `GET
   /api/v2/mcp/servers/{name}` and keep the ones whose `args` contain
   `/api/v1/mcp/project/<id>/`. Each project maps to **exactly one** entry, and the
   two entries have **different** names.
6. `afterEach` deletes both projects, which also removes their MCP entries (measured
   on `1.13.0.dev21`).

---

## Validation criterion *(required)*

The four tests pass three consecutive times at `--retries=0 --workers=1`, with the
create/list/read shapes asserted as key sets (not `toHaveProperty` on one field), the
two `422`s asserted on `detail[0].loc`, the cascade asserted by the flow's `404`, and
the declared coverage — `POST /api/v1/projects/`, `GET /api/v1/projects/`,
`GET /api/v1/projects/{project_id}`, `PATCH`, `PUT`, `DELETE` — matching what the
fixture recorded. Zero projects and zero flows left behind.

Test 4 specifically: the second `POST` answers `201`, both project ids are in the list,
and each project id appears in the `args` of exactly one MCP server entry, with the two
entry names distinct. Mapping by id in `args` is what makes the assertion
independent of how the fallback name is spelled. It also prevents a pass on two
entries that point at the same project.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/projects.py` — the router under test.
- `src/backend/base/langflow/services/database/models/folder/model.py` — `FolderRead`
  / `FolderReadWithFlows`, the two response shapes asserted here.
- `src/backend/base/langflow/api/utils/mcp/config_utils.py` —
  `validate_mcp_server_for_project`, which derives the `lf-…` name and, since
  langflow-ai/langflow#15144, falls back to an id-suffixed one (test 4).
- `src/backend/base/langflow/api/v2/mcp.py` — `GET /api/v2/mcp/servers[/{name}]`,
  the listing and single read test 4 uses to find each project's entry.
- No provider key, no model, no network egress.
