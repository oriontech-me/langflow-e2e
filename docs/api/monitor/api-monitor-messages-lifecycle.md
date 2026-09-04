# API Monitor — messages lifecycle, sessions, builds, transactions and the job queue

**File:** `tests/tests-automations/regression/api/monitor/api-monitor-messages-lifecycle.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1700 (Wave 7 — OSS API coverage, `monitor` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

Eleven operations of the monitor router as a **lifecycle on rows the test itself
produces**. The rows come from an LLM-free run — the repo's Chat Input → Chat Output
fixture (`tests/assets/flows/chat-io-ok-trace-fixture.json`) driven through
`POST /api/v1/run/{flow_id}` with an **API key** (under auto-login the bearer alone
answers `403`; the `traces-*` specs already create a key the same way).

**The issue's premise was wrong, and this doc is where the correction lives.** #1700
named four operations "instance-wide wipes when unfiltered". Measured on
`1.13.0.dev0`, none is:

| Operation | Scope (measured) |
|---|---|
| `DELETE /api/v1/monitor/messages` | body `[message_id, …]` — ids owned by the caller; foreign or unknown ids are ignored, `204` either way |
| `DELETE /api/v1/monitor/messages/sessions` | body `[session_id, …]` (max 500 → `400`); `200 {"message":"Messages deleted successfully for N session","deleted_count":N}` |
| `DELETE /api/v1/monitor/builds` | **requires** `?flow_id` — `422 loc ["query","flow_id"]` without it; `204` with it |
| `DELETE /api/v1/monitor/traces` | **requires** `?flow_id` — same `422`; covered in `api-monitor-traces.md` |

So nothing here is `@destructive`. Every delete is scoped by body or by a required
query parameter, and the spec asserts the scoping as part of the contract.

Measured contracts (`1.13.0.dev0`, three runs on two sessions):

| Operation | Answer |
|---|---|
| `GET /api/v1/monitor/messages?flow_id=` | `200`, array of `{id, flow_id, timestamp, sender, sender_name, session_id, context_id, text, files, edit, duration, properties, category, content_blocks, session_metadata}`; `sender` is `User`/`Machine`, `sender_name` `User`/`AI` |
| `…?session_id=&sender=User` | only the `User` rows of that session |
| `…?flow_id=&order=DESC&limit=1` | exactly one row, the newest |
| `GET /api/v1/monitor/messages/sessions?flow_id=` | `200`, the distinct session ids as a plain array of strings |
| `PUT /api/v1/monitor/messages/{message_id}` `{"text": X}` | `200`, `text === X` and **`edit: true`**; a subsequent `GET` agrees |
| `PUT …/{unknown}` | `404 {"detail":"Message not found"}` — the same body for "not owned", by design |
| `PATCH /api/v1/monitor/messages/session/{old}?new_session_id=` | `200`, the **list** of moved messages, each with the new `session_id`; the old session then reads `[]` |
| `PATCH …/session/{unknown}?new_session_id=` | `404 {"detail":"No messages found with the given session ID"}` |
| `DELETE /api/v1/monitor/messages` `[id]` | `204`; the message is gone, its session's other rows remain |
| `DELETE …/messages` `[unknown]` | `204` — idempotent, nothing changes |
| `DELETE /api/v1/monitor/messages/session/{id}` | `204`; the session leaves `messages/sessions` |
| `DELETE …/session/{unknown}` | `204` |
| `DELETE /api/v1/monitor/messages/sessions` `[id]` | `200 {"message":"Messages deleted successfully for 1 session","deleted_count":1}` |
| `GET /api/v1/monitor/transactions?flow_id=` | `200 {items, page, pages, size, total}`, one item per vertex build with `vertex_id`, `inputs`, `outputs.message`, `status: "success"` |
| `GET /api/v1/monitor/transactions` (no `flow_id`) | `422 loc ["query","flow_id"]` |
| `GET /api/v1/monitor/builds?flow_id=` | `200 {"vertex_builds": {"<vertex id>": [{id, data, …}]}}` keyed by vertex |
| `GET /api/v1/monitor/builds` (no `flow_id`) | `422 loc ["query","flow_id"]` |
| `DELETE /api/v1/monitor/builds?flow_id=` | `204`; the map reads `{"vertex_builds": {}}` afterwards |
| `GET /api/v1/monitor/job_queue` | `200 {"backend": "memory", "active_jobs": 0}` — superuser only |

---

## Tags *(required)*

`@api` `@observability` `@stable`

`@stable` from the outset: no provider, no model, no canvas; every row the tests read
was written by their own runs on a flow they created, and everything is deleted by id
in `afterEach`.

---

## Step by step *(required)*

Five tests over the `request` fixture, declaring through `apiCoverage`. `beforeAll`
creates an API key (`POST /api/v1/api_key/`) and the fixture flow; each test runs the
flow on **its own `session_id`** so tests never read each other's rows; `afterAll`
deletes the flow (messages, builds and transactions go with it) and the key.

**Test 1 — `a run persists messages readable by flow, session and sender`**
1. Run twice on session A (`hello-one`, `hello-two`).
2. `GET messages?flow_id=` → `200`, ≥ 4 rows, every `flow_id` equal to the flow's.
3. `GET messages?session_id=A&sender=User` → exactly 2 rows, `text` `hello-one` /
   `hello-two`, `sender_name === "User"`.
4. `GET messages?flow_id=&order=DESC&limit=1` → exactly 1 row, the newest timestamp.
5. `GET messages/sessions?flow_id=` → an array of strings containing A.

**Test 2 — `a message can be edited in place, and the edit is flagged`**
1. Run once on session B; pick the `User` row's id.
2. `PUT messages/{id}` `{"text":"edited"}` → `200`, `text === "edited"`, `edit === true`,
   `id` unchanged.
3. `GET messages?session_id=B&sender=User` → the same row, `text === "edited"`.
4. `PUT messages/{random uuid}` → `404 "Message not found"`.

**Test 3 — `renaming a session moves every message and empties the old one`**
1. Run once on session C.
2. `PATCH messages/session/C?new_session_id=C2` → `200`, an array whose every entry
   has `session_id === "C2"`, length equal to C's row count.
3. `GET messages?session_id=C` → `[]`; `GET messages?session_id=C2` → the rows.
4. `PATCH messages/session/<unknown>?new_session_id=x` → `404 "No messages found with
   the given session ID"`.

**Test 4 — `deletes are scoped: by message id, by session, by session list`**
1. Run once on session D and once on session E.
2. `DELETE messages` with `[<D's User row id>]` → `204`; `GET messages?session_id=D`
   no longer contains that id but still contains the `Machine` row — **scoped to the
   id, not the session**.
3. `DELETE messages` with `[<random uuid>]` → `204`, nothing else changed.
4. `DELETE messages/session/D` → `204`; `GET messages/sessions?flow_id=` no longer
   lists D but still lists E.
5. `DELETE messages/sessions` with `[E]` → `200`, body deep-equals
   `{"message":"Messages deleted successfully for 1 session","deleted_count":1}`;
   the sessions list is now `[]`.
6. `DELETE messages/session/<unknown>` → `204`.

**Test 5 — `builds, transactions and the job queue`**
1. Run once on session F.
2. `GET transactions` (no `flow_id`) → `422`, `detail[0].loc` deep-equals
   `["query","flow_id"]`; `GET transactions?flow_id=` → `200`, `items.length >= 2`,
   each with `vertex_id`, `status === "success"`, `outputs.message`.
3. `GET builds` (no `flow_id`) → `422` on `flow_id`; `GET builds?flow_id=` → `200`,
   `vertex_builds` has the fixture's two vertex ids as keys.
4. `DELETE builds` (no `flow_id`) → `422`; `DELETE builds?flow_id=` → `204`;
   `GET builds?flow_id=` → `{"vertex_builds": {}}`.
5. `GET job_queue` → `200`, `backend` a string, `active_jobs` a non-negative integer.

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1`, with every
delete asserted on **what survived** as well as what went (the scoping is the
contract), the rename asserted on both the new and the emptied old session, `edit`
asserted `true` after the `PUT`, the two required-`flow_id` refusals asserted on
`loc`, and the declared coverage — the eleven operations named above — matching what
the fixture recorded. Zero flows, keys or messages left behind (the flow delete
cascades; `GET messages?flow_id=` reads `[]` once the flow is gone).

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser
  (the `job_queue` read is superuser-only — auto-login is the superuser).
- Repo asset: `tests/assets/flows/chat-io-ok-trace-fixture.json` (Chat Input → Chat
  Output, no provider).
- `src/backend/base/langflow/api/v1/monitor.py` — the monitor router.
- No provider key, no model, no network egress. Tracing state is irrelevant to this
  file (traces live in `api-monitor-traces.md`).
