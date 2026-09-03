# API Flows — PUT semantics and the bulk DELETE

**File:** `tests/tests-automations/regression/api/flows/api-flows-put-and-bulk-delete.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

Two operations of the flows router nothing drives as a contract today:

- **`PUT /api/v1/flows/{flow_id}`** — every existing spec patches; nothing sends the
  replace verb. Measured, it is **not** a replace: `name` is the only required field
  (omit it and the answer is `422` naming `body.name`), and a body carrying only `name`
  answers `200` with the flow keeping its `description`, `folder_id`, `access_type` and
  every other field the body omitted. A client relying on PUT to clear a field would be
  wrong on this build, and a client relying on it to *keep* fields would break if
  upstream ever made it a true replace — both directions are worth pinning.
- **`DELETE /api/v1/flows/`** — the bulk delete, ids in the body. Issued by cleanup
  helpers all over the suite, asserted nowhere. Measured: `200` `{"deleted": N}`,
  where `N` counts the ids that existed; an unknown id contributes `0` with the same
  `200`, so a caller cannot tell "deleted" from "never existed" by status alone.

Measured contracts (`1.13.0.dev0`, auto-login bearer):

| Operation | Answer |
|---|---|
| `PUT /api/v1/flows/{id}` with `{}`, `{"data": …}` or `{"description": …}` — anything **without `name`** | `422`, `detail[0].loc === ["body","name"]`, `type: "missing"` — `name` is the one required field |
| `PUT /api/v1/flows/{id}` with `{"name": X}` | `200`, full flow body; `name === X`, `description` **unchanged**, `updated_at` bumped |
| `PUT /api/v1/flows/{id}` with `{"name", "data": {nodes:[1 node]}}` | `200`; `data.nodes` replaced by the body's, `description` still unchanged |
| `GET /api/v1/flows/{id}` after each PUT | agrees field for field with the PUT response |
| `DELETE /api/v1/flows/` with `[id]` | `200` `{"deleted": 1}`; `GET {id}` → `404 "Flow not found"` |
| `DELETE /api/v1/flows/` with `[idA, idB]` | `200` `{"deleted": 2}` |
| `DELETE /api/v1/flows/` with `[unknown uuid]` | `200` `{"deleted": 0}` — not a 404 |

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable` from the outset: no provider, no model, no canvas; every flow is created by
the test and deleted by id.

---

## Step by step *(required)*

Three tests over the `request` fixture, each declaring its operations through
`apiCoverage`. Flows are created with `POST /api/v1/flows/` (`Date.now()`-suffixed
names), ids tracked, and `afterEach` deletes **exactly those ids** — never a listing
diff (#553/#518). The bulk-delete tests delete their own flows *as the assertion*, so
their `afterEach` finds nothing left and tolerates the `404`.

**Test 1 — `PUT merges into the flow instead of replacing it`**
1. Create a flow with `description: "kept"`.
1b. `PUT /api/v1/flows/{id}` with `{"description": "x"}` (no `name`) → `422`,
   `detail[0].loc` deep-equals `["body","name"]`; the flow is untouched.
2. `PUT /api/v1/flows/{id}` with `{"name": "<new>"}` → `200`, body `name` is the new
   value **and** `description === "kept"`, `id` unchanged, `folder_id` unchanged.
3. `GET /api/v1/flows/{id}` → same `name` and `description`.
4. `PUT` again with `{"name": "<new2>", "data": {"nodes": [<one minimal node>], "edges": []}}`
   → `200`, `data.nodes` has length 1 and `description` is still `"kept"`.

**Test 2 — `bulk DELETE removes exactly the ids it is given`**
1. Create two flows, keep both ids.
2. `DELETE /api/v1/flows/` with `[idA, idB]` → `200`, body **exactly** `{"deleted": 2}`.
3. `GET /api/v1/flows/{idA}` and `{idB}` → `404` each with `detail === "Flow not found"`.
4. `GET /api/v1/flows/?header_flows=true` no longer lists either id.

**Test 3 — `bulk DELETE of an unknown id reports zero, not an error`**
1. `DELETE /api/v1/flows/` with `[<random uuid>]` → `200` `{"deleted": 0}`.
2. Recorded, not judged: a `200` for "nothing deleted" means a caller passing a stale
   id gets the same status as a successful delete. The spec asserts the measured
   behaviour; whether it should be a `404` is a product choice.

---

## Validation criterion *(required)*

All three tests pass three consecutive times at `--retries=0 --workers=1`, with the PUT
assertions carrying **both** halves (the replaced field and the preserved one), the bulk
delete asserted on the exact `{"deleted": N}` body, and the declared coverage — `PUT
/api/v1/flows/{flow_id}`, `DELETE /api/v1/flows/`, plus the `POST`/`GET` each test
issues — matching what the fixture recorded. Zero flows left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/flows.py` — the flows router these operations live in.
- No provider key, no model, no network egress.
