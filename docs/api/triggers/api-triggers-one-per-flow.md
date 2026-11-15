# Triggers — one trigger per flow: refused on every write path, atomic on import

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-one-per-flow.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev27`)

Owning issue: #2450 (the 1.14 triggers and connectors batch). The canvas half of the same rule (the
palette, paste, duplicate and the sidebar marking) is `docs/core-functionality/integrations/trigger-placement.md`,
from the same issue. The trigger lifecycle (CRUD, the state machine, flow-save reconciliation) is
#2303's; this file asserts only what the one-trigger rule does to a flow write. The catalog flow builder
(`tests/helpers/flows/build-catalog-flow.ts`) builds every graph, so the trigger nodes are the running
image's own components.

---

## What this test validates *(required)*

From 1.14 a flow holds at most one trigger (upstream #16120). The server enforces it in the flow model
itself: `FlowCreate` and `FlowUpdate` run `validate_single_trigger_per_flow` over `data`, so every route
that writes a graph refuses a second trigger, and an import that carries one bad flow writes none. The
contract under test:

1. **A single-flow write with a second trigger is refused, and changes nothing.** `POST /api/v1/flows/`,
   `PATCH` and `PUT /api/v1/flows/{id}`, `POST …/fork` and `POST …/overwrite` all answer `422` with
   *"A flow can have only one trigger. Remove the extra triggers and try again."*. A refused create or
   fork leaves no flow behind. A refused update leaves the stored graph, the flow's version token and
   its trigger row exactly as they were.
2. **An import with one bad flow writes none of them.** `POST /api/v1/flows/batch/`,
   `POST /api/v1/flows/upload/` and `POST /api/v1/projects/upload/` answer `422` naming the bad flow's
   index, and none of the flows in the request exists afterwards (nor, for the project upload, the
   project).
3. **The rule is about the count, not the kind, and only the count.** Two Schedules are refused like a
   Schedule beside an Inbound Webhook. One trigger and no trigger are accepted, and an edit that sends
   no `data` (a description change) saves on a one-trigger flow.

Every refusal is asserted by the rule's exact message and the `loc` its route produces, so a `422` for
any other reason cannot pass for the rule. The create, fork and batch refusals are also paired with a
control that differs only by the second trigger, which shows the route accepts the same payload once the
second trigger is gone.

### Measured on `1.14.0.dev27`

- **Two shapes of the same refusal.** Routes whose body FastAPI validates (`POST /flows/`, `PATCH`,
  `PUT`, `/batch/`) answer through the request-validation handler: each `detail` entry is
  `{type: "value_error", loc: [...], msg: "Value error, A flow can have only one trigger. …"}`, with
  `loc` `["body", "data"]` or, for `/batch/`, `["body", "flows", <i>, "data"]`. The routes that parse
  the body themselves (`/flows/upload/`, `/projects/upload/`, `fork`, `overwrite`) strip the
  `"Value error, "` prefix (`api/v1/flow_validation.py`), with `loc` `["flows", <i>, "data"]` for the
  two uploads and `["data"]` for `fork` and `overwrite`.
- **`POST /flows/` repeats its entry.** Its `detail` carries the same entry **twice**; `PATCH` and `PUT`
  carry it once. Harmless (`FlowCreate` is validated twice on that route), so the spec asserts that every
  entry is the rule's entry and that there is at least one, never a count.
- **Nothing is written by a refusal.** A refused `PATCH` re-reads with its one node. `overwrite` refused
  with a current `If-Match` leaves `GET /flows/{id}/version-state`'s `version_token` unchanged. A
  `/batch/`, `/flows/upload/` or `/projects/upload/` request of `[one trigger, two triggers]` creates
  neither flow, and the project upload creates no project.
- **`overwrite` asks for its precondition first.** Without `If-Match` it answers `428` before it reads
  the graph; the spec sends the current `version_token` so that the `422` is the rule's.
- **The trigger row follows the accepted graph.** A one-trigger flow gets one `schedule` row whose
  `node_id` is the node's id; a no-trigger flow gets none; a refused `PATCH` leaves the row's id and
  state as they were.

### Premises from the issue that did not hold

- **"Version activation is validated too"** — there is no flow-version activation route on the OSS
  image (`/openapi.json` lists only `GET /flows/{id}/version-state`), so nothing to assert here.
- **"The legacy multi-trigger canvas"** (#2450 item 3) — no route on `1.14.0.dev27` admits a second
  trigger at the top level of a graph, so a pre-1.14 multi-trigger canvas is reachable only by
  upgrading an instance that saved one under 1.13. Upgrades belong to the `e2e-routine-migration` VM
  routine, so its behaviour (readable, metadata-only edit, `enable` → `409 multiple_triggers`) stays
  uncovered here and is recorded as such. A trigger hidden **inside a group** is another way to reach
  two triggers; that one is reachable, and it is a defect (LE-3453) — see the canvas spec doc, *Known defect*.

### What is not covered here, and why

- The canvas surfaces (palette, paste, duplicate, sidebar) — the canvas spec doc.
- What a multi-trigger flow does at `enable` / `resume` (`multiple_triggers`) — only reachable through
  an upgrade, above.
- Who may write a flow — the authorization layer, not this rule.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model, no network egress, and every write is id-scoped. `@stable`
enters in this PR. The rule ships in `1.14.0.dev18` (first tag carrying upstream #16120); on an older
build (the 1.13.x patch lines validated on demand do not carry it) each test skips with that reason
through `servedVersionAtLeast`, instead of failing on a rule the build does not have.

---

## Step by step *(required)*

Three tests over the `request` fixture, each declaring its operations through `apiCoverage`. Graphs come
from `buildCatalogFlow` over the live `GET /api/v1/all`: `ONE` = a Schedule; `TWO` = a Schedule and an
Inbound Webhook; `TWO_SCHEDULES` = two Schedules; `NONE` = a Chat Output. Every name carries a per-run
suffix, and every flow or project the test created — or that a refused request should **not** have
created — is deleted by id in the teardown, which runs however the test ended.

### 1. A single-flow write that carries a second trigger is refused, and changes nothing

1. `POST /api/v1/flows/` with `TWO` → `422`, every `detail` entry the rule's (`loc ["body","data"]`,
   prefixed `msg`); with `TWO_SCHEDULES` → the same. No flow with either name exists.
2. Control: `POST` with `ONE` → `201`; its trigger list holds one `schedule` row on the node's id.
3. `PATCH /flows/{id}` with `{data: TWO}` → `422`, same entry. The flow re-reads with its one node, and
   the trigger list holds the same row id in the same state.
4. `PUT /flows/{id}` with `{name, data: TWO}` → `422`, same entry; same re-read.
5. `POST /flows/{id}/overwrite` with `If-Match: <version_token>` and `{data: TWO}` → `422`, unprefixed,
   `loc ["data"]`; the `version_token` is unchanged.
6. `POST /flows/{id}/fork` with `{name, data: TWO}` → `422`, unprefixed, `loc ["data"]`; no flow with
   that name exists. Control: the same fork without `data` → `201`.

### 2. An import that carries one bad flow creates none of the flows in it

1. `POST /flows/batch/` with `[ONE, TWO]` → `422`, `loc ["body","flows",1,"data"]`, prefixed; neither
   name exists. Control: `[ONE, NONE]` → `201`, both exist.
2. `POST /flows/upload/` with a JSON file `{flows: [ONE, TWO]}` → `422`, `loc ["flows",1,"data"]`,
   unprefixed; neither name exists.
3. `POST /projects/upload/` with `{folder_name, flows: [ONE, TWO]}` → `422`, `loc ["flows",1,"data"]`,
   unprefixed; no project and no flow with those names exists.

### 3. One trigger and no trigger are accepted, and an edit without `data` still saves

1. `POST` with `NONE` → `201`, and its trigger list is empty.
2. On a `ONE` flow, `PATCH {description}` → `200`, and the description reads back.

---

## Validation criterion *(required)*

Tests 1–3 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev27`, and once at
`--workers=2` together with `api/triggers/`, with:

- every refusal a `422` whose `detail` entries all carry the exact rule message, with the prefix and
  `loc` its route produces (above), each paired with a control accepted by the same route;
- no flow, project or trigger row created by a refused request, and a refused update leaving the stored
  graph, the version token and the trigger row unchanged;
- the declared coverage matching what the fixture recorded: `POST /api/v1/flows/`,
  `GET /api/v1/flows/`, `GET /api/v1/flows/{flow_id}`, `PATCH /api/v1/flows/{flow_id}`,
  `PUT /api/v1/flows/{flow_id}`, `POST /api/v1/flows/{flow_id}/fork`,
  `POST /api/v1/flows/{flow_id}/overwrite`, `GET /api/v1/flows/{flow_id}/version-state`,
  `POST /api/v1/flows/batch/`, `POST /api/v1/flows/upload/`, `POST /api/v1/projects/upload/`,
  `GET /api/v1/projects/`, `GET /api/v1/triggers`.

The file drives only the `request` fixture and opens no page, so the fixture's HTTP-error monitor sees
none of the deliberate `422`s. After the run, the instance has no flow, project or trigger left from
this file.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev18` or later) at `PLAYWRIGHT_BASE_URL`, auto-login
  or superuser.
- `src/backend/base/langflow/services/triggers/reconciliation.py` — `validate_single_trigger_per_flow`
  and `find_trigger_nodes`: what counts as a trigger (the node's `data.type`, top-level nodes only).
- `src/backend/base/langflow/services/database/models/flow/model.py` — `_normalize_flow_data_for_write`,
  the validator `FlowCreate` and `FlowUpdate` run on `data`.
- `src/backend/base/langflow/api/v1/flows.py` — create, update, put, fork, overwrite, batch and upload.
- `src/backend/base/langflow/api/v1/flow_validation.py` — the unprefixed `loc` shape of the upload
  routes.
- `src/backend/base/langflow/api/validation_errors.py` — the request-validation handler behind the
  prefixed shape.
- `src/backend/base/langflow/api/v1/projects.py` — the project upload.
- `src/lfx/src/lfx/components/triggers/schedule_trigger.py` and
  `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py` — the two core trigger components.
- `tests/helpers/flows/build-catalog-flow.ts`, `tests/helpers/flows/delete-flow.ts`,
  `tests/helpers/flows/delete-project.ts` and `tests/helpers/other/served-version.ts`.
