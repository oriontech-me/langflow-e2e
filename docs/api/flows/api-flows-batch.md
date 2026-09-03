# API Flows — batch create (`POST /api/v1/flows/batch/`)

**File:** `tests/tests-automations/regression/api/flows/api-flows-batch.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

This spec predates the gauge and had **no spec doc**. Adopting it surfaced a defect in
the spec itself, recorded here because the fix changes what the file asserts:

**Its first test asserted an endpoint that does not exist.** Titled "DELETE
`/api/v1/flows/batch` endpoint — documents actual behavior", it `POST`ed
`{"flow_ids": [...]}` to `/api/v1/flows/batch` (no trailing slash) expecting a *bulk
delete*, and accepted `200`/`204`. Measured on `1.13.0.dev0`:

| Request | Answer |
|---|---|
| `POST /api/v1/flows/batch` (no slash), any body | `405 Method Not Allowed` — the slash-less spelling falls through to `/api/v1/flows/{flow_id}`, which has no `POST` |
| `POST /api/v1/flows/batch/` with `{"flow_ids": [...]}` | `422`, `detail[0].loc === ["body","flows"]`, `type: "missing"` — the endpoint is a **batch create** and wants `flows` |
| `POST /api/v1/flows/batch/` with `{"flows": [<two flow bodies>]}` | `201`, a **list** of the two created flows (full server bodies, `id`s minted) |
| `POST /api/v1/flows/batch/` with `{"flows": []}` | `201 []` |
| `POST /api/v1/flows/batch/` with a name that already exists | `409 {"detail":"Name must be unique"}` (the `workflows-v2-job-lifecycle` spec pins the lock-release half of this, #14634) |

The test was **red** on the current nightly (`got 405. Feature not implemented.`) and,
carrying `@release @regression` without `@stable`, invisible to the daily. The bulk
delete it was looking for is `DELETE /api/v1/flows/` with the ids in the body — measured
and covered in `api-flows-put-and-bulk-delete.md`.

So the file is re-scoped to what the endpoint **is** — **batch create**: the
`{"flows": [...]}` contract, the empty list, the `409` on a duplicate name, and the
slash-less `405` as the trap it is.

**Its second test is dropped, not kept.** Titled "GET `/api/v1/flows` with size=2
returns at most 2 items", it branched on the response shape and, when the body was a
plain array, asserted `length >= 0` — a test that cannot fail. Measured on
`1.13.0.dev0`, `GET /api/v1/flows/?page=1&size=2` **is** a plain array of every flow
(26 on the instance): `page` and `size` are ignored on this build. Pinning that as
expected behaviour would defend a possible defect; asserting the opposite would be red
with no issue behind it; and "the listing contains the flows I created" is already the
contract `api-flows-crud.spec.ts` asserts and declares for `GET /api/v1/flows/`.
Recorded here so the finding is not lost: **the flows listing does not paginate**.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

`@stable` is new: the red test is replaced, not patched, and the family needs no
provider. The old `@release @regression` pair is dropped — neither described the file
(the batch-create contract is not a happy-path deploy gate, and no fixed bug is
re-asserted here).

---

## Step by step *(required)*

One test over the `request` fixture, declaring through `apiCoverage`. Flows created by
the batch are tracked from the `201` list and deleted by id in `afterEach`.

**Test 1 — `batch create makes every flow in the list and refuses a duplicate name`**
1. `POST /api/v1/flows/batch/` with `{"flows": [A, B]}` (two `Date.now()`-suffixed
   names, empty graphs) → `201`, body is an array of length 2, each entry with a UUID
   `id`, the submitted `name`, and `access_type === "PRIVATE"`.
2. `GET /api/v1/flows/{id}` for each → `200` with the same `name` — the flows exist
   server-side, not only in the response.
3. `POST /api/v1/flows/batch/` with `{"flows": [<A's name again>]}` → `409`,
   `detail === "Name must be unique"`; the flow count is unchanged.
4. `POST /api/v1/flows/batch/` with `{"flows": []}` → `201`, body deep-equals `[]`.
5. `POST /api/v1/flows/batch` (**no** trailing slash) with the valid body → `405`. The
   trap the old test fell into, pinned so the next author does not.

---

## Validation criterion *(required)*

The test passes three consecutive times at `--retries=0 --workers=1`, with the batch
asserted on the created flows being **readable by id** (not only present in the
response), the duplicate refused on status **and** message, the slash-less call
answering `405`, and the declared coverage — `POST /api/v1/flows/batch/` and
`GET /api/v1/flows/{flow_id}` — matching what the fixture recorded. Zero flows left
behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/flows.py` — the flows router these operations live in.
- No provider key, no model, no network egress.
