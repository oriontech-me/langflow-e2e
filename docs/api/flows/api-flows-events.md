# API Flows — the flow events log (`{flow_id}/events`)

**File:** `tests/tests-automations/regression/api/flows/api-flows-events.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1699 (Wave 7 — OSS API coverage, `flows` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

The hidden `flow_events_router` pair — the editor's activity log for a flow, which
three UI specs pass through and none asserts. The issue flagged it as a possible
stream surface (#1168's `response.text()` trap); **measured, it is plain JSON**, no
SSE, and the contract is small and closed:

| Operation | Answer (measured) |
|---|---|
| `GET /api/v1/flows/{id}/events` on a fresh flow | `200 {"events": [], "settled": true}` |
| `POST /api/v1/flows/{id}/events` with `{}` | `422`, `detail[0].loc === ["body","type"]`, `type: "missing"` |
| `POST … /events` with `{"type":"bogus"}` | `422`, `type: "literal_error"`, and `msg` **enumerates the seven accepted values**: `component_added`, `component_removed`, `component_configured`, `connection_added`, `connection_removed`, `flow_updated`, `flow_settled` |
| `POST … /events` with `{"type":"flow_updated"}` | `201 {"type":"flow_updated","timestamp":<epoch float>,"summary":""}` |
| `POST … /events` with `{"type":"component_added", "component_id": "…", "payload": {…}}` | `201`, same three-key shape — extra fields are accepted and **not echoed** |
| `GET … /events` after two posts | `200`, `events` lists both in order with their timestamps, and **`settled: false`** |

`settled` is the interesting bit: it is `true` on an empty log and flips to `false`
once events are recorded — the flag the editor uses to know whether it has unsaved
activity. The spec asserts the flip, not just the list.

---

## Tags *(required)*

`@api` `@workspace` `@stable`

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`; one flow per
test, deleted by id in `afterEach`.

**Test 1 — `a fresh flow has an empty, settled event log`**
1. Create a flow; `GET {id}/events` → `200`, body deep-equals `{"events": [], "settled": true}`.

**Test 2 — `posting events validates the type and un-settles the log`**
1. `POST {id}/events` with `{}` → `422`, `detail[0].loc` deep-equals `["body","type"]`.
2. `POST` with `{"type":"bogus"}` → `422`, `detail[0].type === "literal_error"`, and the
   `msg` contains all seven literals — asserted individually, so a renamed or dropped
   event type shows up by name.
3. `POST` with `{"type":"flow_updated"}` → `201`, body has exactly the keys `type`,
   `timestamp` (a finite number), `summary` (`""`).
4. `POST` with `{"type":"component_added","component_id":"ChatInput-x","payload":{"k":1}}`
   → `201`, same key set — the extras were accepted, not echoed.
5. `GET {id}/events` → `200`, `events.length === 2`, `events[0].type === "flow_updated"`,
   `events[1].type === "component_added"`, `events[1].timestamp >= events[0].timestamp`,
   and `settled === false`.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with the
`settled` flip asserted in both directions (`true` empty, `false` after posting), the
seven literals asserted by name, and the declared coverage — `GET /api/v1/flows/
{flow_id}/events`, `POST /api/v1/flows/{flow_id}/events`, plus the CRUD calls issued —
matching what the fixture recorded. Zero flows left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/router.py` — the `flow_events_router` include; the endpoint module is hidden from the schema and
  its path is not asserted here.
- No provider key, no model, no network egress.
