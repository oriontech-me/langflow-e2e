# API Flows — public read, note translations, starter examples and `expand/`

**File:** `tests/tests-automations/regression/api/flows/api-flows-public-and-metadata.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

Four read-side operations of the flows router that no spec drives:

| Operation | Answer (measured) |
|---|---|
| `GET /api/v1/flows/public_flow/{id}` on a **PRIVATE** flow | `404 {"detail":"Flow not found"}` — the endpoint does not distinguish "exists but private" from "absent" |
| `PATCH /api/v1/flows/{id}` with `{"access_type":"PUBLIC"}` | `200`, `access_type === "PUBLIC"` |
| `GET /api/v1/flows/public_flow/{id}` on the now-**PUBLIC** flow | `200`, full flow body **plus** `public_access: {"can_read": true, "can_execute": true}` |
| the same, **with no `Authorization` header** | `200`, identical body — a public flow is readable anonymously **by design** |
| `GET /api/v1/flows/{id}/note_translations` | `200 {}` on a flow without sticky notes |
| `GET /api/v1/flows/basic_examples/` (`Accept-Language: en-US`) | `200`, a non-empty array of starter flows (`Simple Agent` among them), each carrying `name`, `description`, `data.nodes`; ~4.8 MB |
| `POST /api/v1/flows/expand/` with `{}` | **`400`** (not `422`) whose `detail` is pydantic's **text** report naming `CompactFlowData` and the missing `nodes` and `edges` |
| `POST /api/v1/flows/expand/` with `{"nodes":[],"edges":[]}` | `200 {"nodes":[],"edges":[]}` — the expanded form of an empty compact graph is itself |

Two of these are security-relevant and asserted as such: the private flow is
**invisible** through `public_flow` (a `404`, not a `403` that would confirm existence),
and the public flow is readable **without a token**, which is the feature — the
assertion pins that the anonymous body equals the authenticated one, so a future
regression that leaks extra fields (or hides the `public_access` block) is caught.

`expand/` is hidden from the schema; its body shape was discovered by probing, and the
`400`-with-text envelope (where the rest of the router answers `422` with a structured
`detail`) is recorded as measured, not judged.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

---

## Step by step *(required)*

Four tests over the `request` fixture, declaring through `apiCoverage`. Flows are
created per test and deleted by id in `afterEach`.

**Test 1 — `public_flow hides a private flow and serves a public one, even anonymously`**
1. Create a flow (default `access_type` is `PRIVATE`, asserted from the `201`).
2. `GET public_flow/{id}` → `404`, `detail === "Flow not found"`.
3. `PATCH /api/v1/flows/{id}` `{"access_type":"PUBLIC"}` → `200`, `access_type === "PUBLIC"`.
4. `GET public_flow/{id}` (bearer) → `200`, `id` matches, `public_access` equals
   `{can_read: true, can_execute: true}`.
5. `GET public_flow/{id}` with **no** `Authorization` header (a fresh request context
   with no headers) → `200`, and the body **deep-equals** the authenticated body.

**Test 2 — `note_translations is an empty map for a flow without notes`**
1. Create a flow; `GET {id}/note_translations` → `200`, body deep-equals `{}`.

**Test 3 — `basic_examples lists the starter flows`**
1. `GET /api/v1/flows/basic_examples/` with `Accept-Language: en-US` (the backend
   localises by header, #1400) → `200`, an array with length > 0.
2. Every entry has a string `name`, a string `description` and `data.nodes` as an array;
   the names include `"Simple Agent"`.

**Test 4 — `expand/ validates the compact body and echoes an empty graph`**
1. `POST expand/` with `{}` → `400`; `detail` is a **string** containing `CompactFlowData`,
   `nodes` and `edges`.
2. `POST expand/` with `{"nodes":[],"edges":[]}` → `200`, body deep-equals the input.

---

## Validation criterion *(required)*

All four tests pass three consecutive times at `--retries=0 --workers=1`, with the
anonymous read asserted by **body equality** against the authenticated one, the private
read asserted as `404` (never `403`), `expand/`'s refusal asserted on status **and**
the text naming the schema, and the declared coverage — `GET /api/v1/flows/public_flow/
{flow_id}`, `GET /api/v1/flows/{flow_id}/note_translations`, `GET /api/v1/flows/
basic_examples/`, `POST /api/v1/flows/expand/`, plus the `PATCH` and CRUD calls issued —
matching what the fixture recorded. Zero flows left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/flows.py` — the flows router these operations live in.
- No provider key, no model, no network egress.
