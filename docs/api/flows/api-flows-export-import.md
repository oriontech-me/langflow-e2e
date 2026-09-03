# API Flows — export (`download/`) and import (`upload/`)

**File:** `tests/tests-automations/regression/api/flows/api-flows-export-import.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The export/import pair as a **round-trip contract**. `security/credential-secret-
exposure.spec.ts` already reads `download/` to assert a secret is absent from the
export; nothing asserts what the export *is*, and nothing drives `upload/` at all.
Both change shape with the input, which is what makes them worth pinning:

| Operation | Answer |
|---|---|
| `POST /api/v1/flows/download/` with **one** id | `200`, `application/json` — the flow as a **single JSON object**, stripped of server-side fields (`updated_at`, `user_id`, `folder_id` are absent; `id`, `name`, `description`, `data`, `access_type`-adjacent flags are present) |
| `POST /api/v1/flows/download/` with **two** ids | `200`, `application/x-zip-compressed` — ZIP (magic `PK\x03\x04`) with one member per flow, named `<flow name>.json` |
| `POST /api/v1/flows/upload/` (multipart, the one-flow JSON) while the flow **still exists** | `201`, a **list** with one flow whose `id` is the **same** id — the upload updated the existing flow in place (`updated_at` bumped, flow count unchanged) |
| `POST /api/v1/flows/upload/` of the export of a flow that was **deleted** | `201`, recreated **with the same id** the export carried |
| `POST /api/v1/flows/upload/` of an export with `id` **removed** | `201`, a **new** id |

The id-preservation rule is the load-bearing finding: an import is an *upsert keyed
by the export's `id`*, so re-importing a backup over a live flow overwrites it rather
than creating a copy. Neither the UI nor the docs say so; the suite should.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

---

## Step by step *(required)*

Three tests over the `request` fixture, declaring through `apiCoverage`. Every flow
the tests create or import is tracked by id and deleted in `afterEach` (id-scoped,
never a listing diff — #553/#518). Uploaded flows are tracked from the `201` list.

**Test 1 — `exports one flow as JSON and two as a ZIP`**
1. Create two flows with distinct names.
2. `POST download/` with `[idA]` → `200`, `content-type: application/json`, body is an
   object with `id === idA`, `name`, `data`, and **no** `updated_at`/`user_id`/`folder_id`
   keys — the export is portable, not a database row.
3. `POST download/` with `[idA, idB]` → `200`, `content-type: application/x-zip-compressed`,
   body begins with the ZIP magic bytes and contains both `<name>.json` member names.

**Test 2 — `importing an export of an existing flow updates it in place`**
1. Create a flow; `download/` it as JSON; count the user's flows (`GET /api/v1/flows/?header_flows=true`).
2. `POST upload/` with the JSON as a multipart `file` → `201`, body is an **array of
   length 1**, `[0].id === original id`, `[0].updated_at` later than before.
3. The flow count is **unchanged** — no copy was created.

**Test 3 — `an import keeps the export's id, or mints one when it has none`**
1. Create a flow, export it, delete it by id (`GET` → `404`).
2. `POST upload/` with that export → `201`, `[0].id === the deleted flow's id` —
   recreated under the same identity; track it for cleanup.
3. Strip `id` from the export JSON and upload again → `201`, `[0].id` is a **different**
   UUID; track it too.

---

## Validation criterion *(required)*

All three tests pass three consecutive times at `--retries=0 --workers=1`, with the
single-flow export asserted on the **absence** of the server-side keys (not only on
the presence of `id`), the ZIP identified by magic bytes and both member names, the
in-place update asserted on **both** the preserved id and the unchanged count, and the
declared coverage (`POST /api/v1/flows/download/`, `POST /api/v1/flows/upload/`, plus
the CRUD calls issued) matching what the fixture recorded. Zero flows left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/flows.py` — the flows router these operations live in.
- No provider key, no model, no network egress.
