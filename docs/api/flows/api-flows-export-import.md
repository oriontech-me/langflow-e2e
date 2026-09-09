# API Flows — export (`download/`) and import (`upload/`)

**File:** `tests/tests-automations/regression/api/flows/api-flows-export-import.spec.ts`

**Last validated:** Langflow 1.12.x (`1.12.1`)

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
| `POST /api/v1/flows/upload/` (multipart, the one-flow JSON) while the flow **still exists** | `201`, a **list** with one flow whose `id` is the **same** id — the upload updated the existing flow in place (`updated_at` bumped, the flow stays in its project, and that project still holds **exactly one** flow) |
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
1. Create a **project** of this test's own (`createProjectViaApi`), then create the
   flow inside it (`folder_id` = that project). The project is the isolation boundary:
   no parallel worker writes into a project this test just created.
2. Count the project's flows — `GET /api/v1/flows/?get_all=false&folder_id=<project>`
   → `total` is **1**. `get_all=false` is mandatory: the default `get_all=true` branch
   returns every flow the user owns and **ignores `folder_id` entirely** (measured — it
   answered 37 against a project holding 1).
3. `download/` the flow as JSON.
4. `POST upload/` with the JSON as a multipart `file` → `201`, body is an **array of
   length 1**, `[0].id === original id`, `[0].updated_at` later than before, and
   `[0].folder_id` is still the test's project.
5. Re-count the project → `total` is still **1**. No copy was created, whatever the
   neighbours did.

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
the presence of `id`), the ZIP identified by magic bytes and both member names, and the
in-place update asserted on **both** the preserved id and a **project-scoped count** —
the test's own project holds exactly one flow before and after the upload, and the
uploaded flow's `folder_id` is still that project. That count is proven under a
**forced race**: a sibling flow created from a second `APIRequestContext` inside the
download/upload window leaves it green, while the global-count form it replaces goes
red on the same interleaving. The declared coverage
(`POST /api/v1/flows/download/`, `POST /api/v1/flows/upload/`, plus the CRUD calls
issued) matches what the fixture recorded. **Zero flows left behind — including the
flow the id-less import mints**, whose id the upload tracker must pick up — and zero
projects left behind, through `createProjectViaApi`'s own teardown.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/flows.py` — the flows router these operations live in.
- No provider key, no model, no network egress.

---

## Notes *(optional)*

- **Why the count is scoped to a project this test created** (#1773). The first form
  counted the user's flows **globally** either side of the upload. The suite runs
  `fullyParallel` against one shared `auto_login` superuser, so that total is state
  every other worker also writes: a neighbour creating a flow inside the `download/` +
  `upload/` window moved it (measured — `Expected: 27, Received: 29`, run 34304431241,
  where the diff of 2 was two sibling creations), and a neighbour that created one flow
  and deleted another left it **unchanged while a duplicate existed**. It failed to move
  for reasons unrelated to the endpoint, and moved for reasons unrelated to the
  endpoint. A project the test creates is written by nobody else, so inside it the
  original semantics — *no row appeared* — are legitimate again, which is the case the
  issue itself carves out.
- **The upsert stays inside the project, and that is what makes the scope safe.**
  Measured on `main` @ `595cd72a2b`: the export carries **no** `folder_id` (the
  `download/` payload is stripped of it), and `upload_file` therefore takes its
  `fallback_folder_id = existing_flow.folder_id` branch — the response's `folder_id` came
  back as the test's own project. The test asserts that too, so the day the backend
  starts relocating upserted flows the scope stops being silently wrong: it goes red.
- **`get_all=false` is not optional.** `GET /api/v1/flows/` defaults to `get_all=true`,
  whose branch returns every flow the user owns and never applies `folder_id` — measured,
  it answered **37** for a project holding **1**. Only the `get_all=false` branch
  paginates through the filter, and it answers an envelope (`{items, total, …}`), not a
  bare list. A test that kept the default would read a global count under a name that
  says otherwise: the original bug, with a query parameter added.
- **Why not count occurrences of the flow's `id` instead.** A duplicate row cannot
  repeat the primary key — a real copy is inserted under a **new** id while the original
  stays. Occurrences of the original `id` would still read `1`, so that form trades the
  false red for a false green on precisely the defect the step exists to catch (an
  endpoint that copies the flow and echoes the export's id back).
- **Why not a before/after set difference of ids, or a name-prefix filter over the
  global listing.** The set difference picks up the ids sibling workers created during
  the window — the same contention, unfixed. A name-prefix filter is collision-free but
  strictly weaker than the count it replaces: it only ever sees a copy that carries the
  test's name (or an auto-suffixed `"<name> (1)"`), and is blind to a copy stored under
  a name of the backend's choosing. Inside an owned project, *any* extra row is caught.
- **Known cost of the scope.** `DELETE /api/v1/projects/{id}` answers `500` under write
  contention on 1.12 (#965/LE-2020), so the teardown goes through `deleteProject`'s
  retry rather than a bare `request.delete` — otherwise the fix would trade a flaky
  assertion for a leaked project per contended run.
- The UI counterpart lives in `docs/flow-functionality/export-import-flow.md`. It is
  **not** the same code path: the UI export serializes the home card's client-side store
  (`ExportModal` → `downloadFlow`, no server fetch), so it never calls
  `POST /api/v1/flows/download/`. Both layers assert the upsert; only this one pins the
  endpoint contract.
