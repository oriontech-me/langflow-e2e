# API Flows — the versions sub-family (`{flow_id}/versions/`)

**File:** `tests/tests-automations/regression/api/flows/api-flows-versions.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The hidden `flow_version_router` — five operations, none in `/openapi.json`, none
driven by any spec, and no documentation of the body shapes anywhere in this repo.
Everything below was measured by probing, which is the point of pinning it:

| Operation | Answer (measured) |
|---|---|
| `GET /api/v1/flows/{id}/versions/` on a fresh flow | `200 {"entries": [], "max_entries": 50}` |
| `POST /api/v1/flows/{id}/versions/` with `{}` | `201 {id, flow_id, user_id, version_number: 1, description: null, created_at, version_tag: "v1"}` |
| `POST … /versions/` with `{"name":"x","description":"probe"}` | `201`, `version_number: 2`, `version_tag: "v2"`, `description: "probe"` — **`name` is ignored**, the tag is derived from the number |
| `GET … /versions/{version_id}` | `200`, the list entry **plus** `data` (the snapshot's `{nodes, edges}`) and `is_deployed` |
| `POST … /versions/{version_id}/activate` | `200` returning the **flow** body (not the version), and the list afterwards holds a **new** entry `version_number: 3`, `description: "Auto-saved before activating v2"` — activation snapshots the current state first |
| `DELETE … /versions/{version_id}` | `204`, empty body |
| `GET … /versions/{unknown}` | `404 {"detail":"Version entry not found"}` |
| `DELETE … /versions/{unknown}` | `404 {"detail":"Version entry <id> not found"}` — the two 404 messages differ |

The auto-snapshot on activate is the load-bearing finding: restoring an old version
is **non-destructive** — the state being replaced is saved as a new version first — and
nothing in the UI or docs says so. A regression that dropped the snapshot would lose
work silently, which is exactly the class of contract worth a test.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`; one flow per
test, deleted by id in `afterEach` (versions go with the flow).

**Test 1 — `versions lifecycle: create, list, read, activate with auto-snapshot, delete`**
1. Create a flow with `data.nodes = []`; `GET {id}/versions/` → `200`,
   `{"entries": [], "max_entries": 50}`.
2. `POST {id}/versions/` with `{}` → `201`, `version_number === 1`, `version_tag === "v1"`,
   `description === null`, `flow_id === id`.
3. `PUT /api/v1/flows/{id}` with the flow's `name` (required by PUT — see
   `api-flows-put-and-bulk-delete.md`) and one node in `data.nodes`, so the next
   snapshot differs from the first.
4. `POST {id}/versions/` with `{"name":"ignored","description":"second"}` → `201`,
   `version_number === 2`, `version_tag === "v2"`, `description === "second"`, and **no
   `name` key** in the response.
5. `GET {id}/versions/{v2.id}` → `200`, `data.nodes.length === 1`, `is_deployed` present.
6. `POST {id}/versions/{v1.id}/activate` → `200`, body is the **flow** (`id === flow id`)
   and its `data.nodes.length === 0` — v1's empty graph is now live.
7. `GET {id}/versions/` → `entries.length === 3`; the newest has `version_number === 3`
   and `description === "Auto-saved before activating v1"`; `GET /api/v1/flows/{id}`
   agrees (`data.nodes.length === 0`).
8. `DELETE {id}/versions/{v2.id}` → `204`; the list drops to 2 entries and no longer
   contains `v2.id`.

**Test 2 — `unknown version ids are refused with distinct messages`**
1. Create a flow. `GET {id}/versions/<random uuid>` → `404`, `detail === "Version entry not found"`.
2. `DELETE {id}/versions/<the same uuid>` → `404`, `detail === "Version entry <uuid> not found"`.
3. Recorded rather than judged: the two messages differ in shape; the assertion pins
   each as measured so a unification upstream is noticed, not silently absorbed.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with the
activation asserted on **three** observables (the returned flow state, the auto-
snapshot entry with its exact description, and `GET /flows/{id}` agreeing), the
ignored `name` asserted as absent, and the declared coverage — all five `versions`
operations plus the CRUD/PUT calls issued — matching what the fixture recorded. Zero
flows left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/router.py` — the `flow_version_router` include; the endpoint module is hidden from the schema.
- No provider key, no model, no network egress.
