# Triggers — the lifecycle: CRUD, the state machine, pinning, canvas-only kinds and flow-save reconciliation

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-lifecycle.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev35`)

Owning issue: #2303 (Dedicated Integrations, batch 2). The siblings in this directory each needed a
trigger to exist and made one with the calls they needed; this file owns the calls themselves. What a
trigger's actions and reasons are is `api-triggers-operator.md`'s (#2448), who a trigger run executes as
is `api-triggers-run-identity.md`'s (#2309), signing and delivery are `api-triggers-webhook-ingress.md`'s
(#2308), the audit rows are `api-triggers-audit.md`'s (#2451), and the one-trigger-per-flow rule on every
write path — including the atomic `POST /api/v1/flows/upload/` the issue's comment proposed — is
`api-triggers-one-per-flow.md`'s (#2450).

---

## What this test validates *(required)*

`/api/v1/triggers` is how a trigger is made, changed and switched on and off, and a flow save is the
other way a trigger comes to exist. Langflow 1.13 shipped both with the trigger UI compiled out, so the
API and an imported flow JSON are the only surfaces for most of it. The contract under test:

1. **CRUD.** `POST /triggers` answers `201` with the exact 28-key `TriggerRead` and the defaults
   (`pending`, `flow` binding, `per_event`, `concurrency_limit: 1`, `max_attempts: 5`), owned by the flow's
   owner. `GET` by id, the list by `flow_id`, `PATCH` and `DELETE` (`204`, then `404` on every read).
   `PATCH` with an explicit `null` is refused on the six required fields and, on the two
   nullable references the suite can set (`connection_id`, `flow_version_id`), clears a value that was
   set. A `schedule` created through the API validates its cron on
   create and on `PATCH`.
2. **State machine.** `enable` arms (`active`) and `disable` pauses (`paused`). Both are idempotent.
   `pending`, `expired` and `error` all enable. A `dead` trigger can be neither enabled nor disabled, and
   stays `dead`. (`needs_reconnect` also enables while its `resume` reads blocked — measured and deliberately
   not asserted, see *Measured, not asserted*.)
3. **Pin.** `POST …/pin` takes a version of the trigger's own flow, or `null` to unpin. A version of
   another flow, or one that does not exist, is `404` on `pin`, on `PATCH` and on create alike. An empty
   body is refused rather than read as an unpin.
4. **Canvas-only kinds.** The eight Slack, Microsoft and Google kinds are refused on create with the
   sentence that says where they come from.
5. **Flow-save reconciliation.** A save that adds a trigger node creates one `pending` row bound to the
   node. Saving again neither arms nor disarms it. Removing the node **pauses** the row and records why,
   and `enable` then refuses it. Putting the node back clears the reason and leaves it paused. An inbound
   webhook's `payload_schema` is parsed into an object, and a malformed one is recorded on the row.
   Deleting the flow deletes its triggers.
6. **Validation.** `concurrency_limit` 1–100 and `max_attempts` 1–20 on create and on `PATCH`, a
   deployment binding without `deployment_id` (create and `PATCH`, the row unchanged after the refused
   `PATCH`), `config.mechanism_id` (create and `PATCH`), an extra field, a bad `kind`, an empty `name` and
   an unknown flow.
7. **Owner scope.** Another user — here the superuser, which OSS does not exempt — gets `404 "Trigger not found"` on every
   per-trigger route of the owner's trigger, and on create and list for the owner's flow, and the row is
   unchanged afterwards.
8. **The manual-QA leads, as the image behaves today** (TRG-2 / TRG-4). All three reproduce. None has an
   upstream ticket, so each is asserted as the current behaviour in a test of its own, not declared
   failing (see *Leads*).

### Measured on `1.14.0.dev32`

- **Create.** An `inbound_webhook` with only `flow_id`, `name` and `kind` answers the 28 keys of
  `TRIGGER_READ_KEYS` with `state: "pending"`, `reason: "pending"`, `binding_target: "flow"`,
  `session_policy: "per_event"`, `concurrency_limit: 1`, `max_attempts: 5`, `config: {}`, every
  reference `null`, and `user_id` = the flow owner. `GET …?flow_id=` returns the row with `flow_name` set;
  `GET /{id}` returns it with `flow_name: null` (the operator file pins that difference).
- **PATCH nulls.** `name`, `config`, `binding_target`, `session_policy`, `concurrency_limit` and
  `max_attempts` sent as `null` → `422`, `type: "value_error"`, `loc ["body", <field>]`, `msg` *"Value
  error, This field cannot be null."*. `connection_id` (an owned connection) and `flow_version_id`
  (through `pin`) can each be set, and a `PATCH` sending `null` → `200` and a re-read reads `null`.
  `deployment_id` is left out of that step on purpose: it is a foreign key to `deployment.id`, a
  deployment row needs a deployment provider account (watsonx Orchestrate) this suite does not have, and
  a made-up id is lead 8's subject, whose outcome depends on the database (#2539).
- **Schedule through the API.** `kind: "schedule"` with `config: {cron: "0 0 1 1 *"}` → `201`, `pending`,
  `config` filled to `{cron, timezone: "UTC", catchup_policy: "coalesce"}` (no `share_session`, which only
  the reconciler adds). `{cron: "not a cron"}` → `422 {"detail": "Invalid cron expression: a valid
  five-field cron expression is required."}`, and the same on a `PATCH`, which leaves the stored config
  unchanged. A schedule with no config is accepted `pending`; with `state: "active"` and no config it is
  refused with the same cron sentence (measured, not asserted).
- **Delete.** `204` with an empty body. Afterwards `GET` and a second `DELETE` both answer `404
  {"detail": "Trigger not found"}`, and the flow's list is empty.
- **Enable / disable.** `enable` on `pending` → `active`, `reason: null`; `enable` again → `200`, still
  `active`. `disable` → `paused`, `reason: "paused"`; again → `200`, still `paused`. `expired`, `error` and
  `needs_reconnect` (made through the create route, which writes any state) each enable to `active`.
- **Dead.** `enable` → `409 {"detail": {"code": null, "message": "Trigger in state 'dead' cannot be
  enabled."}}`. `disable` → `409 {"detail": "A dead trigger cannot be disabled."}` — a string, not the
  object `enable` answers: the two routes shape their refusals differently, and the spec pins each.
- **Pin.** `POST /api/v1/flows/{id}/versions/` with `{}` → `201` and a version (`version_tag: "v1"`).
  `pin` with the own flow's version → `200`, `flow_version_id` set; with another flow's or a random id →
  `404 {"detail": "Flow version not found for this trigger's flow."}`; `{}` → `422` `missing` at
  `["body","flow_version_id"]`; `{"flow_version_id": null}` → `200`, unpinned. `PATCH {flow_version_id:
  <other flow's>}` and a create carrying it answer the same `404`.
- **Canvas-only kinds.** `slack.message`, `slack.reaction`, `microsoft.mail`, `microsoft.calendar`,
  `microsoft.file`, `google.gmail`, `google.calendar` and `google.drive` → `422 {"detail": "A '<kind>'
  trigger is created by adding its component to the flow, not through this API."}`, and nothing is
  written. (`CANVAS_ONLY_KINDS` plus `source_kinds()` on this image are exactly these eight.)
- **Reconciliation, Schedule.** A flow created through `POST /api/v1/flows/` holding a `ScheduleTrigger`
  node (`schedule_type: "Custom (cron)"`, `cron_expression: "0 0 1 1 *"`) has one row: `kind: "schedule"`,
  `node_id` = the node's id, `state: "pending"`, `name: "Schedule 0 0 1 1 *"`, `config` = `{cron, timezone:
  "UTC", catchup_policy: "coalesce", share_session: false}`. A `PATCH` of the same data → same id, still
  `pending`. After `enable` → `active`, and the same `PATCH` again leaves it `active`. A `PATCH` to an empty
  graph → `paused`, `last_error: "trigger node removed from the flow"`, `last_error_code: "node_removed"`,
  `reason: "node_removed"`, `blocked_actions.resume: "node_removed"`; `enable` → `409 {"detail": {"code":
  "node_removed", "message": "The trigger node was removed from the flow. Add it back to resume the
  trigger."}}`. A `PATCH` with the node back → same id, `paused`, `last_error: null`, `reason: "paused"`.
- **Reconciliation, Inbound Webhook.** `payload_schema` typed as JSON text is stored as the object;
  `"not json"` is stored as the text with `state: "pending"` and `last_error` *"The payload schema must be
  valid JSON, or empty to accept any body."*.
- **Flow delete.** Deleting the flow → its trigger's `GET` answers `404 "Trigger not found"`.
- **Validation.** `concurrency_limit` `0` / `101` → `greater_than_equal` / `less_than_equal` at `["body",
  "concurrency_limit"]`, `100` → `201`; `max_attempts` `0` / `21` likewise, `20` → `201`. `binding_target:
  "deployment"` with no `deployment_id` → `422 {"detail": "A deployment binding requires deployment_id."}`
  on create; the same on `PATCH`, and a re-read shows `binding_target: "flow"` (the refusal is raised
  after the update is flushed, and the transaction is rolled back). `config: {mechanism_id: "x"}` → `422
  {"detail": "mechanism_id is derived from the trigger's connection and cannot be set."}`. An extra field
  → `extra_forbidden`; `kind: "Bad Kind"` → `string_pattern_mismatch`; `name: ""` →
  `string_too_short`; a random `flow_id` → `404 "Trigger not found"`.
- **Owner scope.** OSS reads flows owner-scoped (`_read_flow` without an authorization plugin), so the
  superuser is just another user here: `GET`, `PATCH`, `DELETE`, `enable`, `disable` and `pin` on the
  owner's trigger, a create on the owner's flow and `GET ?flow_id=<owner's flow>` all answer `404
  {"detail": "Trigger not found"}`.

### Premises from the issue that did not hold

- **"List by `flow_id` (required: without it the route answers `422`, measured on dev42)."** On
  `1.14.0.dev32` the list without `flow_id` answers `200` with the caller's triggers across every flow it
  owns — the TRG-7 operator view (upstream #15786). That half is `api-triggers-operator.md`'s; this file
  lists by `flow_id` only.
- **"`409` from an invalid state, including *A dead trigger cannot be disabled*."** Only `dead` refuses.
  `enable` on an `active` trigger and `disable` on a `paused` one are idempotent `200`s, and every other
  state enables.
- **"Removing the node reconciles the row away."** It pauses the row and keeps it (the reconciler says why:
  the ledger and its history survive an accidental delete-and-undo). Only deleting the flow removes it.
- **"A caller who can read the flow but not act gets `403`; the owner is the flow owner, not the caller."**
  Neither is reachable in OSS. Without an authorization plugin nobody but the owner can read a flow, so
  every other caller gets the `404`, and the caller is always the owner. The spec asserts the `404` half and
  that `user_id` is the owner's; the `403` half and a collaborator creating a trigger on someone else's
  flow belong to the `@enterprise` `@authz` lane.

### Leads from manual QA — reproduced, asserted as today's behaviour

None of the three has an upstream ticket, and none will be filed without the team's confirmation, so
none is a `test.fail()` declaration (#1084's rule: a declaration names the ticket that will retire it).
Each lead is **its own test** asserting what the image does today, with *"LEAD:"* in its assertion
messages. They are separate so that when upstream fixes one, the daily's `@stable` removal takes only
that test, never the other two. A lead going red is upstream changing it; the response is to turn that
test into the fixed contract, and — once a ticket exists — to name it here. Each lead is one candidate
ticket:

| Test | Candidate ticket |
|---|---|
| *lead: a deployment binding's deployment_id is never checked — stored and failed at dispatch, or a 500 where foreign keys are enforced* | Create (and `PATCH`) should refuse a `deployment_id` that names no deployment with a `4xx`, instead of accepting it and failing every event at dispatch (foreign keys off) or answering `500` with the raw `IntegrityError` (foreign keys on) |
| *lead: enable arms a webhook whose payload_schema is malformed, and erases the error* | `enable` should refuse an `inbound_webhook` whose config the reconciler recorded as invalid, as it does a schedule, and must not erase that reason |
| *lead: a stored payload_schema is not enforced on delivery* | Ingress should validate a delivery against the trigger's `payload_schema`, or the node should stop offering a schema it never applies |

- **A `deployment_id` that names nothing is never checked by the API.** Neither `create_trigger` nor
  `update_trigger` looks the deployment up; `trigger.deployment_id` is a foreign key to `deployment.id`,
  so what the caller sees is decided by the database, and both outcomes are the same defect (#2539):
  - **Foreign keys not enforced** (SQLite's default pragmas, as the image ships and the PR lane runs): a
    random UUID → `201`, `binding_target: "deployment"`; `enable` → `active`; `POST …/test` → an event
    that ends `failed` with `error` *"Trigger binding target 'deployment' is stored but not dispatched in
    this release; re-bind the trigger to its flow to run it."*, and the trigger reads `active` /
    `reason: "degraded"` with that text in `last_error`. The refusal arrives at dispatch, never at create
    or enable.
  - **Foreign keys enforced** (`LANGFLOW_SQLITE_PRAGMAS` with `"foreign_keys": "ON"`, as the QA VM's
    daily runs since #1717, and every Postgres deployment): the create → **`500`**, whose body is the raw
    driver error naming the foreign-key violation and the SQL statement (`(sqlite3.IntegrityError) FOREIGN
    KEY constraint failed` on SQLite; psycopg names it `ForeignKeyViolation` on Postgres, not measured
    here), and no row is written. The exception is unhandled, so the server also drops the connection
    after the `500`, and the next request on that keep-alive socket fails with *"socket hang up"*; the test
    sends `Connection: close` on this one request. Measured on the 2026-11-20 daily (`1.14.0.dev33`, run
    `20261120T080016Z`) and locally on `1.14.0.dev35`.

  The fixed contract is a `4xx` at create (and at `PATCH`) naming the missing deployment; either
  outcome above going away is the lead turning red.
- **`enable` validates only schedule configs.** An Inbound Webhook node with `payload_schema: "not json"`
  reconciles `pending` with the error in `last_error`; `enable` → `200`, `active`, and `last_error` is
  **cleared** (`set_state` clears it) while `config.payload_schema` is still `"not json"`. The only record
  of the broken schema is gone.
- **`payload_schema` is stored but never enforced.** An active webhook whose schema is `{"type":
  "object", "required": ["x"]}` accepts a signed delivery of `{"y": 1}` (`202`), and its event runs to
  `completed`. Nothing in the image reads `payload_schema` after reconciliation stores it.

### Measured, not asserted

- **`resume` is blocked on `needs_reconnect` while `enable` accepts it.** A `needs_reconnect`
  `inbound_webhook` with no connection reads `blocked_actions: {resume: "needs_reconnect"}`, and `POST
  …/enable` arms it (`200`, `active`). That is the converse of LE-3454 (an allowed action the route
  refuses): a blocked action the route accepts. `capabilities.py` states the rule only in the allowed
  direction, and a blocked `resume` there may be a UX instruction (reconnect first) rather than a refusal,
  so the spec does not pin it either way.
- **`updated_at` changes format.** The create answers `2026-11-19T22:25:32`; a write answers
  `2026-11-19T22:26:01.166058`. Not asserted: no consumer compares the strings.

### What is not covered here, and why

- **No rate limit is declared on these routes** (code). Asserting an absence of limits is out of scope.
- **The trigger UI** is compiled out in 1.13 and is the `core-functionality/integrations/trigger-*` specs'
  from 1.14.
- **Slack, Microsoft and Google trigger nodes** need a provider connection to reconcile; their arming is
  the provider issues'.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model and no network egress (the one delivery goes to the instance's own
ingress). Every row is created by a throwaway user made once per worker and deleted with it, so nothing
touches another spec's triggers (its deletion waits on Langflow's serial erase queue for as long as that
queue keeps moving — `ERASE_STALL_MS` in `throwaway-user.ts`), and the one schedule armed in this file is on `0 0 1 1 *`, which does
not fire inside a run. The floor is `1.14.0.dev16`, where `TriggerRead` gained `last_error_code`
(upstream #16132) — the 28-key set this file asserts. The canvas-only kinds were measured on
`1.14.0.dev32` only.

---

## Step by step *(required)*

Ten tests over the `request` fixture, each declaring its operations through `apiCoverage`. A throwaway
**owner** (`createConnectionsOwner`) is created once per worker and owns every flow and trigger here;
deleting it in `afterAll` takes them with it, and each test also deletes its own flows by id. Flows are
empty (`{nodes: [], edges: []}`) unless stated. Names carry a per-run suffix.

### 1. Creates, reads, lists, updates and deletes a trigger on the owner's own flow

1. Create an `inbound_webhook` on flow A → `201`, the 28 keys, the defaults above, `user_id` = the owner.
2. `GET /{id}` equals the create's body; `GET ?flow_id=A` holds exactly that row, with `flow_name`.
3. `PATCH {name, concurrency_limit: 3, max_attempts: 7, session_policy: "shared"}` → `200` with the four
   values; a re-read agrees.
4. `PATCH` each of the six required fields to `null` → `422`, the exact entry; a re-read is unchanged.
5. Set two nullable references (a connection planted through `createConnectionViaApi`, a pin to a
   snapshot of A) and re-read them set; `PATCH` each to `null` → `200`, and a re-read reads `null`.
   `deployment_id` is not set here (see *Measured* → *PATCH nulls*).
6. Create a `schedule` with a valid cron → `201`, the filled config, a re-read agrees. A malformed cron on
   create and on `PATCH` → `422`, the exact sentence; the stored config is unchanged.
7. `DELETE` → `204`, empty body. `GET`, a second `DELETE` → `404 "Trigger not found"`; the list is `[]`.

### 2. Enable arms and disable pauses, idempotently, from every state but dead

1. Create a `pending` `inbound_webhook`. `enable` twice → `active`, `reason: null` both times; `disable`
   twice → `paused`, `reason: "paused"` both times; `enable` → `active`. A re-read agrees after each.
2. Create one each in `expired` and `error`, each read back in that state; `enable` each → `active`.
   `needs_reconnect` is left out on purpose (see *Measured, not asserted*).
3. Create a `dead` one. `enable` → the exact `409` object; `disable` → the exact `409` string; a re-read
   reads `dead`.

### 3. Pins a trigger to a version of its own flow, and to nothing else

1. Snapshot flows A and B (`POST /flows/{id}/versions/`).
2. Create a trigger on A. `pin` A's version → `flow_version_id` = it; a re-read agrees.
3. `pin` B's version, then a random id → `404`, the exact detail; the pin is unchanged.
4. `pin {}` → `422` `missing` at `["body","flow_version_id"]`; the pin is unchanged.
5. `pin {flow_version_id: null}` → `flow_version_id: null`.
6. `PATCH {flow_version_id: B's}` and a create on A carrying B's version → the same `404`; the list of A
   holds only the one trigger.

### 4. Refuses through the API the kinds that only a component on the canvas creates

1. Create each of the eight kinds → `422`, the exact sentence naming the kind.
2. The flow's list is `[]`.

### 5. A flow save creates the trigger unarmed, never arms or disarms it, and pauses it when its node is removed

1. Create flow S with a Schedule node → one `pending` row, `kind`, `node_id`, `name` and `config` as
   measured.
2. `PATCH` S with the same data → the same id, still `pending`.
3. `enable` → `active`; `PATCH` the same data → still `active`.
4. `PATCH` S to an empty graph → `paused`, `node_removed` (state, `last_error`, `last_error_code`,
   `reason`, `blocked_actions.resume`). `enable` → the exact `409`; a re-read is unchanged.
5. `PATCH` the node back → the same id, `paused`, `last_error: null`, `reason: "paused"`.
6. Create flow W with an Inbound Webhook node whose `payload_schema` is JSON text → `config.payload_schema`
   is the object. Create flow X whose schema is `"not json"` → `pending`, the exact `last_error`.
7. Delete S → its trigger's `GET` → `404 "Trigger not found"`.

### 6. Refuses out-of-range and server-owned fields on create and on update

1. Create with each bound's two edges → `422` with the exact `type` and `loc`; with each bound itself →
   `201`.
2. `PATCH` `concurrency_limit: 101` and `max_attempts: 0` → the same refusals.
3. Create with `binding_target: "deployment"` and no id → the exact `422`. `PATCH` the same onto an
   existing row → the exact `422`, and a re-read reads `binding_target: "flow"`.
4. `config.mechanism_id` on create and on `PATCH` → the exact `422`.
5. An extra field, a bad kind, an empty name → `extra_forbidden`, `string_pattern_mismatch`,
   `string_too_short`. A random `flow_id` → `404 "Trigger not found"`.
6. The flow's list holds only the rows the `201`s created.

### 7. Only the flow's owner can see or act on its triggers

1. The owner creates a flow and an `active` trigger on it.
2. As another user — the superuser, which OSS does not exempt: `GET`, `PATCH`, `DELETE`, `enable`, `disable` and `pin` of that trigger, a create on
   that flow and `GET ?flow_id=` of it → each `404 {"detail": "Trigger not found"}`.
3. The owner's re-read is unchanged (`active`, same name, same `updated_at`), and its list holds only it.

### 8. Lead: a deployment binding's deployment_id is never checked — stored and failed at dispatch, or a 500 where foreign keys are enforced

1. Create with `binding_target: "deployment"` and a random `deployment_id`. The answer must be one of
   the two outcomes of the unchecked foreign key, and the test records which one in an annotation
   (`deployment-fk`); anything else, a `4xx` included, fails with a *"LEAD:"* message:
   - **`500`** (foreign keys enforced): the body names an `IntegrityError` and the foreign key, and the
     flow's trigger list is `[]`. The test ends here.
   - **`201`** (not enforced): a re-read holds both values, and steps 2–3 run.
2. `enable` → `active`, re-read.
3. `POST …/test` → `202`; poll the events until it settles → `failed`, the exact `error`. The trigger
   reads `active`, `reason: "degraded"`, that `last_error`.

The scheduled lane, the QA VM's daily, enforces foreign keys, so it runs only the `500` branch. The `201`
branch (enable, the test event, `degraded`) runs on the PR lane's image, which keeps SQLite's default
pragmas, whenever a PR selects this spec, and locally against an image started without the pragma. A
`PATCH` of a `deployment_id` that names nothing behaves the same way (`500` with foreign keys enforced,
measured on `1.14.0.dev35`) and is not asserted: the create is the lead's one probe.

### 9. Lead: enable arms a webhook whose payload_schema is malformed, and erases the error

1. Flow with a `"not json"` webhook node → `pending`, the parse error in `last_error`.
2. `enable` → `200`; its answer and a re-read both read `active`, `last_error: null`,
   `config.payload_schema` still `"not json"`.

### 10. Lead: a stored payload_schema is not enforced on delivery

1. Flow with the `required: ["x"]` webhook node → the schema stored as an object; `enable` → `active`,
   re-read.
2. Mint its signing secret (`mintSigningSecret`) and deliver `{"y": 1}` → `202`; poll its events → one
   `completed` row whose `payload.delivery` is `{"y": 1}`.

---

## Validation criterion *(required)*

Tests 1–10 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev35`, and once at
the default worker count, **both with SQLite foreign keys enforced** (`LANGFLOW_SQLITE_PRAGMAS` with
`"foreign_keys": "ON"`, as the QA VM runs) **and with the product's default pragmas** (as the image ships),
with:

- every refusal asserted by its status and its exact body, or its `type` and `loc`;
- every write's effect re-read through `GET` or the flow's list — never inferred from the write's own
  answer alone;
- each lead step's message naming the lead, so a fix arriving reads as such;
- the declared coverage matching what the fixture recorded: `POST /api/v1/triggers`,
  `GET /api/v1/triggers`, `GET /api/v1/triggers/{trigger_id}`, `PATCH /api/v1/triggers/{trigger_id}`,
  `DELETE /api/v1/triggers/{trigger_id}`, `POST /api/v1/triggers/{trigger_id}/enable`,
  `POST /api/v1/triggers/{trigger_id}/disable`, `POST /api/v1/triggers/{trigger_id}/pin`,
  `POST /api/v1/triggers/{trigger_id}/test`, `GET /api/v1/triggers/{trigger_id}/events`,
  `POST /api/v1/triggers/{trigger_id}/signing-secret`, `POST /api/v1/connections`, `POST /api/v1/flows/`,
  `PATCH /api/v1/flows/{flow_id}`, `DELETE /api/v1/flows/{flow_id}` and
  `POST /api/v1/flows/{flow_id}/versions/`.

The file drives only the `request` fixture, so the HTTP-error monitor sees none of the deliberate `404`s,
`409`s and `422`s. After the run the instance holds no flow, user or trigger left by this file.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev16` or later) at `PLAYWRIGHT_BASE_URL`, auto-login or
  superuser.
- `src/backend/base/langflow/api/v1/triggers.py` — create, read, update, delete, enable, disable, pin and
  the deployment-binding refusal.
- `src/backend/base/langflow/services/triggers/service.py` — `create`, `update`, `enable`, `disable`,
  `pin`, `_reject_mechanism` and the flow-version check.
- `src/backend/base/langflow/services/triggers/reconciliation.py` — `reconcile_flow_triggers`, the node
  removal pause and `normalize_webhook_config`.
- `src/backend/base/langflow/services/triggers/capabilities.py` — the `node_removed` reason.
- `src/backend/base/langflow/services/triggers/constants.py` — `CANVAS_ONLY_KINDS`.
- `src/backend/base/langflow/services/database/models/trigger/model.py` — `deployment_id`'s foreign key to
  `deployment.id`, which no API path checks before writing (lead 8).
- `src/backend/base/langflow/services/database/models/trigger/schemas.py` — `TriggerCreate`,
  `TriggerUpdate` and `TriggerPinRequest`.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_read_flow`, owner-scoped without an
  authorization plugin.
- `src/lfx/src/lfx/components/triggers/schedule_trigger.py` and
  `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py` — the two nodes the reconciler reads.
- `tests/helpers/triggers/trigger-api.ts`, `tests/helpers/triggers/sign-webhook.ts`,
  `tests/helpers/integrations/connections-owner.ts`, `tests/helpers/integrations/create-connection.ts`,
  `tests/helpers/auth/throwaway-user.ts`, `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/flows/create-flow.ts`, `tests/helpers/flows/delete-flow.ts` and
  `tests/helpers/other/served-version.ts`.
