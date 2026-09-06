# API Monitor — the `messages/shared/*` sub-family

**File:** `tests/tests-automations/regression/api/monitor/api-monitor-shared.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev0`)

Owning issue: #1700 (Wave 7 — OSS API coverage, `monitor` family). Gauge, definitions
and denominator: `docs/api/api-surface-coverage-gauge.md`.

---

## What this test validates *(required)*

Five operations nothing in this repo had measured, and whose meaning the issue could
only guess at. Measured, from the router source inside the container and by probing:

**What "shared" is.** When a **public** flow is executed through the public path
(`POST /api/v1/build_public_tmp/{flow_id}/flow`, the shareable playground), its
messages are not stored under the flow — they go under a **virtual flow id** derived
from `(principal, source_flow_id)`. The `shared/*` endpoints read and edit that
namespace for the **current user**: every one of them takes `source_flow_id` (the
original public flow) and computes the user's virtual flow from it. Without the
parameter each answers `422`.

**Why the positive path is out of reach on every OSS lane, stated as a premise.** The
public build decides the principal as
`authenticated_user_id = user.id if user and not AUTO_LOGIN else None` — under
`LANGFLOW_AUTO_LOGIN=true`, which every OSS lane runs, it **always** uses the
`client_id` cookie principal (`400 "No client_id cookie found"` without the cookie,
even with a bearer). Measured: the build's own event stream namespaces the session
under a client-derived virtual id that neither `GET messages/shared?source_flow_id=`
nor `GET messages?flow_id=<that id>` can read. So on an auto-login instance the
user-principal namespace these endpoints address is **never written to**, and no test
can observe a shared row. This spec therefore asserts the **closed contract** — the
required parameter, the empty read, the four refusals — and records the positive path
as a follow-up that needs an auto-login-**off** instance (the `@enterprise` lane is
one, but a different product; an OSS container with `LANGFLOW_AUTO_LOGIN=false` and a
real superuser is the honest target).

Measured contracts (`1.13.0.dev0`, on a flow the test owns, PUBLIC or PRIVATE alike):

| Operation | Answer |
|---|---|
| `GET /api/v1/monitor/messages/shared` (no `source_flow_id`) | `422`, `detail[0].loc === ["query","source_flow_id"]`, `type: "missing"` |
| `GET …/shared?source_flow_id=not-a-uuid` | `422`, `type: "uuid_parsing"` |
| `GET …/shared?source_flow_id=<own flow>` | `200 []` — the user's namespace for that flow is empty (see premise) |
| `GET …/shared?source_flow_id=<unknown uuid>` | `200 []` — no existence check on the source flow |
| `GET /api/v1/monitor/messages/shared/sessions` (no param) | `422` on `source_flow_id` |
| `GET …/shared/sessions?source_flow_id=` | `200 []` |
| `PUT /api/v1/monitor/messages/shared/{message_id}?source_flow_id=` `{"text": X}` | `404 {"detail":"Message not found"}` for any id — there is no row in the namespace |
| `PUT …/shared/{message_id}` (no param) | `422` on `source_flow_id` |
| `PATCH /api/v1/monitor/messages/shared/session/{old}?new_session_id=&source_flow_id=` | `404 {"detail":"No messages found with the given session ID"}` |
| `PATCH …/shared/session/{old}?new_session_id=` (no `source_flow_id`) | `422` on `source_flow_id` |
| `DELETE /api/v1/monitor/messages/shared/session/{id}?source_flow_id=` | `204` — idempotent, like its non-shared twin |
| `DELETE …/shared/session/{id}` (no param) | `422` on `source_flow_id` |

The refusals are the contract worth having: a future change that made `source_flow_id`
optional would silently widen every one of these reads to a namespace the caller did
not name — the CVE-2026-33017 class the public build's own docstring cites.

---

## Tags *(required)*

`@api` `@observability` `@stable`

`@stable`: no provider, no model, no rows — the closed contract is deterministic on
every OSS instance, auto-login or not.

---

## Step by step *(required)*

Two tests over the `request` fixture, declaring through `apiCoverage`. One flow is
created per test (so `source_flow_id` names a flow the caller owns) and deleted by id
in `afterEach`.

**Test 1 — `every shared endpoint requires source_flow_id and reads an empty namespace`**
1. Create a flow.
2. `GET shared` and `GET shared/sessions` without the parameter → `422` each, with
   `detail[0].loc` deep-equal to `["query","source_flow_id"]`.
3. `GET shared?source_flow_id=not-a-uuid` → `422`, `detail[0].type === "uuid_parsing"`.
4. `GET shared?source_flow_id=<flow>` → `200 []`; `GET shared/sessions?source_flow_id=<flow>`
   → `200 []`; `GET shared?source_flow_id=<random uuid>` → `200 []`.

**Test 2 — `the shared write surface refuses what is not there, and never without the parameter`**
1. Create a flow.
2. `PUT shared/<random uuid>?source_flow_id=<flow>` `{"text":"x"}` → `404 "Message not found"`;
   the same **without** `source_flow_id` → `422` on `source_flow_id`.
3. `PATCH shared/session/<random>?new_session_id=y&source_flow_id=<flow>` → `404 "No
   messages found with the given session ID"`; without `source_flow_id` → `422`.
4. `DELETE shared/session/<random>?source_flow_id=<flow>` → `204`; without
   `source_flow_id` → `422`.

---

## Validation criterion *(required)*

Both tests pass three consecutive times at `--retries=0 --workers=1`, with every
refusal asserted on **`loc`** (the parameter name, not just the status), the two
`404` messages asserted verbatim, and the declared coverage — all five `shared`
operations — matching what the fixture recorded. The premise above is repeated in the
spec header so the day an auto-login-off lane exists, the positive path is added
there and not rediscovered. Zero flows left behind.

---

## External dependencies *(required)*

- A running Langflow OSS instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser.
- `src/backend/base/langflow/api/v1/monitor.py` — the `shared/*` routes and
  `_compute_shared_message_flow_id`.
- `src/backend/base/langflow/api/v1/chat.py` — `build_public_tmp`, where the
  `AUTO_LOGIN` branch that makes the positive path unreachable lives.
- No provider key, no model, no network egress.
