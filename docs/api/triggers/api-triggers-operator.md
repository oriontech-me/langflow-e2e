# Triggers — the operator API: listing across flows, `scope=all`, server-computed actions, bulk pause and resume, sessions

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-operator.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2448 (the 1.14 triggers and connectors batch). The page that renders this API is
`docs/core-functionality/integrations/triggers-settings-page.md`, from the same issue. The trigger
lifecycle (CRUD, the state machine, flow-save reconciliation) is #2303's, a trigger whose runs fail
still reading `active` is recorded and not pinned (#2328, `api-triggers-webhook-ingress.md` → *Not
pinned*), and the audit rows these actions write are #2451's. This file asserts what TRG-7 (upstream LE-2485,
API #15786) added on top of them. #2464 added the declared-failing pin for LE-3454 (test 3, step 6); #2525 turned it into a plain
assertion once upstream #16450 fixed it in `1.14.0.dev32`.
#2476 set the Schedule node's `schedule_type` after upstream #16322 made it decide whether the cron is read.

---

## What this test validates *(required)*

`/api/v1/triggers` grew an operator surface in 1.14: a list across every flow, a superuser view across
every user, actions the server computes for the caller, a bulk pause and resume for incident response,
and a lookup that labels the Playground sessions a trigger started. The contract under test:

1. **Listing across flows.** `GET /api/v1/triggers` without `flow_id` returns the triggers on the flows
   the caller **owns** — a superuser included, since OSS has no cross-user prefilter. List rows carry
   `flow_name`, which is `null` on a single-object response. Order is `created_at desc, id desc`. `limit`
   is 1–200, with `offset` and no total count. `provider` and `state` filter by exact match.
2. **`scope=all`.** A non-superuser gets `403` *"Only a superuser can list every user's triggers."*. A
   superuser sees every user's triggers, each with `owner_username`. A row on another user's flow allows
   no action. It combines with `flow_id`, `provider` and `state`.
3. **Server-computed actions.** Every `TriggerRead` has the same 28 keys, and `allowed_actions`,
   `blocked_actions` and `reason` follow the state and the kind: `pause` is absent when the trigger is
   paused or dead; `resume` is absent when it is active; `test` and `replay` are always present, and
   blocked by the state's reason when the trigger is paused, expired or dead; `rotate_secret` exists only
   for `inbound_webhook`; `reconnect` exists only for a connection-backed trigger; `reason` is `degraded`
   for an active trigger with a `last_error`, and `pending` or `config_invalid` while it is pending.
4. **Bulk pause and resume** (superuser only; anyone else `403` *"The user doesn't have enough
   privileges"*). The body needs a filter, both filters select the intersection, extra fields are refused
   and `trigger_ids` takes 1–500. A dry run writes nothing. Pause takes out `active`, `error` and
   `needs_reconnect`, marks each with `admin_paused_at`, and the owner reads `reason: "paused_by_admin"`.
   Resume re-arms only what an operator paused, and an owner's own pause clears the mark. A resume that
   `enable` refuses lands in `failed`, leaves the trigger paused and unmarked, and says why in
   `last_error`.
5. **`GET /triggers/sessions`** returns only the sessions a trigger on the flow started, with six keys,
   needs `flow_id` and 1–100 `session_id`, and answers `404` for a flow the caller cannot read.

### Measured on `1.14.0.dev28`

- **Every state is reachable from the create route.** `TriggerCreate.state` takes any `TriggerState`,
  so `POST /api/v1/triggers` writes a row straight into `pending`, `active`, `paused`, `expired`, `dead`,
  `error` or `needs_reconnect`, and `provider` is free text under `^[a-z][a-z0-9_-]*$`. The spec builds
  its state matrix this way instead of driving a trigger through real provider failures.
- **The `TriggerRead` keys** (28): `id`, `flow_id`, `user_id`, `name`, `kind`, `provider`, `node_id`,
  `connection_id`, `config`, `state`, `binding_target`, `deployment_id`, `flow_version_id`,
  `session_policy`, `concurrency_limit`, `max_attempts`, `next_fire_at`, `last_fired_at`, `last_error`,
  `last_error_code`, `admin_paused_at`, `created_at`, `updated_at`, `reason`, `allowed_actions`,
  `blocked_actions`, `flow_name`, `owner_username`.
- **The owner's action table for an `inbound_webhook`** (allowed / blocked):

  | state | reason | allowed | blocked |
  |---|---|---|---|
  | `pending` | `pending` | pause, resume, test, replay, delete, rotate_secret | — |
  | `active` | `null` | pause, test, replay, delete, rotate_secret | — |
  | `paused` | `paused` | resume, delete, rotate_secret | test, replay → `paused` |
  | `expired` | `expired` | pause, resume, delete, rotate_secret | test, replay → `expired` |
  | `dead` | `dead` | delete, rotate_secret | resume, test, replay → `dead` |
  | `error` | `error` | pause, resume, test, replay, delete, rotate_secret | — |
  | `needs_reconnect` | `needs_reconnect` | pause, test, replay, delete, rotate_secret | resume → `needs_reconnect` |

  A kind other than `inbound_webhook` (here `e2e.event`) drops `rotate_secret` and keeps the rest. A
  trigger with a `connection_id` gains `reconnect`, blocked `reconnect_not_needed` while it is `pending`
  or `active`.
- **The three reasons a state alone does not give.** `degraded`: an active `e2e.event` trigger sent a
  `POST …/test` is deferred by the dispatcher as `provider-unavailable` (no bundle serves that kind), which
  writes `last_error: "provider-unavailable"` and leaves the state `active` — measured within 5 s.
  `config_invalid`: a flow saved with a `ScheduleTrigger` node whose `schedule_type` is `Custom (cron)`
  and whose `cron_expression` is `not a cron` reconciles into a `pending` row with `last_error` *"Invalid cron expression: a valid five-field cron
  expression is required."* and `last_error_code: "invalid_cron"`. `paused_by_admin`: below.
  **The schedule type is load-bearing** (#2476): since upstream #16322 (`1.14.0.dev30`) the node's
  `schedule_type` defaults to `Weekly`, and the reconciler (`_apply_schedule_pick`) compiles the picker
  fields for any of the five picker types and discards `cron_expression` — measured on `1.14.0.dev31`,
  the same node left on the default `Weekly` reconciles as a plain `pending` with `last_error: null`. The
  stored cron is the schedule only when the type is `Custom (cron)`, empty, absent, or a value outside the
  five picker types. Builds before
  `dev30` have no `schedule_type` field at all, so the spec sets it only when the catalog template carries
  it, and the floor stays `1.14.0.dev16`.
- **Ordering.** Rows created in the same second share `created_at` (second precision), and the tie is
  broken by `id desc`. The spec asserts the order the rule produces, never a creation order.
- **Paging.** `limit=0` and `limit=201` → `422` (`greater_than_equal` / `less_than_equal` on
  `["query","limit"]`), `limit=200` → `200`. The body is a bare array.
- **A superuser does not see another user's triggers in its own list**, and `?flow_id=<their flow>`
  answers `404` *"Trigger not found"* — the per-flow routes are owner-scoped without a cross-user plugin.
- **`scope=all` on another user's row.** `allowed_actions: []`. Every action the trigger has is
  blocked, and the reason is `insufficient_permission` **except** where a reason that does not depend on
  the caller outranks it (below).
- **Bulk body.** `{}` and `{dry_run: true}` → `422`, `loc ["body"]`, *"Value error, Name a provider,
  trigger_ids, or both."*; an extra field → `extra_forbidden`; `trigger_ids: []` → `too_short`; 501 ids →
  `too_long`; a provider breaking the pattern → `string_pattern_mismatch`. The result has seven keys:
  `action`, `dry_run`, `matched`, `changed`, `unchanged`, `failed`, `owners`.
- **Bulk outcome**, over one provider holding the seven `inbound_webhook` states plus an active
  `e2e.event`, across two owners. Pause: `changed` = active, error, needs_reconnect (+ the `e2e.event`),
  `unchanged` = pending, paused, expired, dead, `owners: 2`. Each changed row reads `paused`,
  `paused_by_admin`, `admin_paused_at` set. The owner's `disable` on one of them clears the mark
  (`reason: "paused"`), and a later bulk resume lists it as `unchanged`. Resume: the operator-paused
  `inbound_webhook` rows come back `active` (an `error` or `needs_reconnect` row too), the mark cleared.
- **A refused resume, reached deterministically.** `enable` refuses a kind with a `.` that no installed
  bundle serves: *"This trigger provider is unavailable. Install its integration bundle before enabling
  it."*. An active `e2e.event` trigger is therefore pausable by an operator and not resumable: the
  resume lists it in `failed` with that detail, and the row reads `state: "paused"`, `reason: "paused"`,
  `admin_paused_at: null`, `last_error` *"An administrator resumed this trigger, but it could not start:
  This trigger provider is unavailable. Install its integration bundle before enabling it."*.
- **Sessions.** A `POST …/test` on an active `inbound_webhook` on an empty flow settles `completed` with
  `session_id` `trigger:<trigger id>:<event id>`. `GET /triggers/sessions?flow_id=…&session_id=<it>&session_id=<other>`
  returns exactly one entry, keys `session_id`, `trigger_id`, `trigger_name`, `kind`, `provider`,
  `started_at`. Missing `flow_id` or `session_id` → `422` `missing`; 101 ids → `422` `too_long`, 100 →
  `200`. Another user's flow and a random id → `404` *"Trigger not found"*.

### Premises from the issue that did not hold

- **"Every applicable action is blocked with `insufficient_permission`"** on another user's row. A
  reason that is true whatever the caller's access outranks it: on a paused, expired or dead trigger
  `test` and `replay` read the state's reason (`paused`, …), `resume` on a dead one reads `dead`, and
  `reconnect` reads `reconnect_not_needed` or `not_connection_owner`. The spec asserts the caller reason on
  the actions where nothing outranks it, and the state reason where it does.
- **"Measure whether a provider trigger (Gmail with a planted Google connection) reaches `error` once
  enabled offline."** Not needed: the create route writes a provider trigger in any state, so the
  provider bulk is driven with a provider name unique to the run. That also settles the first risk the
  issue names — a bulk by provider is instance-wide across users, so a shared provider (`google`) would
  pause other specs' triggers; a per-run provider (`e2eop<run>`) selects only this run's rows.

### Measured, not asserted

- **The resume dry run counts a row `enable` will refuse as `changed`.** The dry run decides eligibility
  (paused by an operator) and never calls `enable`, so on the measured run the active `e2e.event` row is
  `changed` in the dry run and `failed` in the real one. The spec asserts the dry run's sets as measured
  and records this, since the dialog's count can therefore exceed what the confirm changes.
- **The owner's own `enable` on an operator-paused trigger clears `admin_paused_at` too**, as the issue's
  *"any other state write clears the marker"* says. The spec asserts the owner's `disable`, the case the
  operator's resume has to respect.
- **A `needs_reconnect` trigger with a `connection_id` reads `config_invalid`**, not `needs_reconnect`:
  the recovery check parses `config.connection`, which an API-created row does not carry. The matrix
  therefore uses `connection_id` only on `pending` and `active` rows.

### What is not covered here, and why

- Who may act on another user's trigger through the per-trigger routes — owner-scoped without an
  authorization plugin (`@enterprise` `@authz` lane).
- The audit rows a bulk action writes — #2451.
- `ready_to_resume`, `consent_required`, `node_removed`, `source_settings_changed` — reasons of the
  provider and reconciliation paths, owned by #2303 and the provider issues.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model, no network egress, and every write is scoped to this run — rows by
id, the bulk by `trigger_ids` or by a provider name unique to the run, the second user created and
deleted per worker. `@stable` enters in this PR. The operator routes ship in `1.14.0.dev1` (upstream #15786), but the
`TriggerRead` this file pins — 28 keys, `last_error_code` among them — is upstream #16132's, first in
`1.14.0.dev16`. Measured on `1.14.0.dev14`: 27 keys (no `last_error_code`), so tests 1 and 3 fail there
while 2, 4 and 5 pass. The floor is therefore `1.14.0.dev16`, the contract asserted rather than the
route; on an older build each test skips with that reason through `servedVersionAtLeast`.

---

## Step by step *(required)*

Five tests over the `request` fixture, each declaring its operations through `apiCoverage`. A
throwaway **owner** (`createConnectionsOwner`) is created once per worker; the **superuser** is the
lane's own. Flows are empty (`{nodes: [], edges: []}`) unless stated. Every name carries a per-run
suffix; superuser flows are deleted by id in the teardown, and deleting the owner takes its flows and
triggers with it.

### 1. Lists the caller's own triggers across flows, newest first, filtered by provider and state

1. The owner creates flows A and B, and on provider `P` (unique to the test): on A an active and a paused
   `inbound_webhook`, on B a pending `e2e.event`. The superuser creates one active `inbound_webhook` on
   `P` on a flow of its own.
2. Owner `GET /triggers?provider=P` → exactly the three owner rows, each `flow_name` = its flow's name and
   `owner_username: null`, in `created_at desc, id desc` order.
3. Superuser `GET /triggers?provider=P` → only its own row. Superuser `GET /triggers?flow_id=A` → `404`
   *"Trigger not found"*.
4. Owner `GET /triggers/{id}` → `flow_name: null`.
5. `provider=P&state=active` → the one active owner row; `state=paused` → the paused one.
6. `limit=1` with `offset=0`, `1`, `2` → the three rows in the order of step 2, one each; `limit=0` and
   `limit=201` → `422` on `["query","limit"]`; `limit=200` → `200`.

### 2. `scope=all` is superuser-only, and shows every user's triggers with their owner and no actions on rows the caller does not own

1. Same seed shape on a fresh provider `P`.
2. Owner `GET /triggers?scope=all` → `403`, exact detail.
3. Superuser `GET /triggers?scope=all&provider=P` → the four rows; the owner's carry the owner's
   username and `allowed_actions: []`; the superuser's carries its own username and its actions.
4. On the owner's active row every action is blocked `insufficient_permission`; on its paused row
   `resume`, `delete`, `rotate_secret` are, while `test` and `replay` read `paused`.
5. `scope=all&flow_id=A&state=paused` → exactly the paused row.

### 3. Computes each trigger's actions on the server, by state and by kind

1. The owner creates, on one flow, an `inbound_webhook` in each of the seven states, an active and a
   pending `e2e.event`, and — with a connection planted through `createConnectionViaApi` — a pending and
   an active `inbound_webhook` carrying its `connection_id`.
2. Every response has exactly the 28 keys; each row's `reason`, `allowed_actions` and `blocked_actions`
   equal the table above.
3. `degraded`: `POST …/test` on the active `e2e.event`, then poll its `GET` until `last_error` is set →
   `state: "active"`, `reason: "degraded"`, `last_error: "provider-unavailable"`.
4. `config_invalid`: create a flow (`buildCatalogFlow`) holding a `ScheduleTrigger` whose
   `schedule_type` is `Custom (cron)` and whose `cron_expression` is `not a cron`; its reconciled row reads `pending`, `config_invalid`,
   `last_error_code: "invalid_cron"`.
5. `POST …/enable` on that row answers `409`
   `{"detail": {"code": "invalid_cron", "message": "Invalid cron expression: a valid five-field cron expression is required."}}`,
   and a re-read shows the row unchanged (`pending`, `config_invalid`).
6. The row's `allowed_actions` do not hold `resume`, and `blocked_actions.resume` is
   `"config_invalid"`: the action list agrees with the refusal in step 5. This was
   [LE-3454](https://datastax.jira.com/browse/LE-3454) (#2464): the server listed `resume` as allowed
   on a `pending` row, against `capabilities.py`'s own rule that an allowed action is one the route
   accepts, and the step was declared failing. Upstream fixed it in langflow-ai/langflow#16450
   (*block resume while the trigger config is invalid*, first in `1.14.0.dev32`), the declaration then
   failed as *"expected to fail, but passed"*, and #2525 made the step a plain assertion.
   The fix is newer than this file's `1.14.0.dev16` floor, so the step is gated by build, like
   #16322's `schedule_type` in step 4: from `1.14.0.dev32` it asserts the corrected listing above;
   before it, it asserts the old one (`resume` in `allowed_actions`, no `blocked_actions.resume`).
   Neither side skips. Measured for #2525: `1.14.0.dev31` takes the old branch and passes,
   `1.14.0.dev32` takes the new one and passes.

### 4. Bulk pause and resume are superuser-only, select by provider and ids, and re-arm only what an operator paused

1. Owner `POST /bulk/pause` and `/bulk/resume` → `403`, exact detail.
2. The body refusals above, each by its `type` and `loc`.
3. Seed on provider `P`: the owner's seven `inbound_webhook` states plus an active `e2e.event`, and the
   superuser's active `inbound_webhook`.
4. Intersection: `{provider: P, trigger_ids: [active, <random uuid>], dry_run}` → `matched: 1`; a provider
   that is not `P` with the same id → `matched: 0`.
5. Dry-run pause on `P` → `matched: 9`, the `changed` / `unchanged` split above, `failed: []`,
   `owners: 2`; every row re-reads as before, `admin_paused_at: null`.
6. Pause on `P` → the same split; each changed row reads `paused`, `paused_by_admin`, `admin_paused_at`
   set; the unchanged ones are as before.
7. The owner `disable`s its operator-paused active row → `reason: "paused"`, `admin_paused_at: null`.
8. Dry-run resume on `P` → `unchanged` holds that row and the four never-armed ones; nothing written.
9. Resume on `P` → `changed` = the operator-paused `inbound_webhook` rows, now `active` and unmarked;
   `failed` = the `e2e.event` with the exact detail, and that row reads `paused`, `reason: "paused"`,
   `admin_paused_at: null`, the prefixed `last_error`; the owner-paused row stays `paused`.

### 5. Labels the sessions a trigger on the flow started, and nothing else

1. The owner creates flows A and B, each with an active `inbound_webhook`, and `POST …/test` on both;
   poll each event until it settles with a `session_id`.
2. `GET /triggers/sessions?flow_id=A&session_id=<A's>&session_id=<B's>&session_id=<unknown>` → exactly
   one entry: A's session, with the six keys and A's trigger id, name, kind and provider.
3. Missing `flow_id`, missing `session_id`, and 101 ids → `422` with the measured `type`; 100 ids → `200`.
4. The superuser asking for A → `404` *"Trigger not found"*; a random flow id → the same.

---

## Validation criterion *(required)*

Tests 1–5 pass three consecutive times at `--retries=0` against `1.14.0.dev32` (re-measured for #2525;
originally `1.14.0.dev29` at `--workers=1`), and once at `--workers=2` together with `api/triggers/`,
with:

- the exact 28-key set and the action table, row by row;
- every refusal asserted by its status and its exact detail, or its `type` and `loc`;
- every bulk result asserted as exact id sets per bucket plus `matched` and `owners`, and every bulk
  effect re-read from `GET` — never inferred from the bulk response alone;
- the declared coverage matching what the fixture recorded: `GET /api/v1/triggers`,
  `POST /api/v1/triggers`, `GET /api/v1/triggers/{trigger_id}`, `POST /api/v1/triggers/{trigger_id}/enable`,
  `POST /api/v1/triggers/{trigger_id}/disable`,
  `POST /api/v1/triggers/{trigger_id}/test`, `GET /api/v1/triggers/{trigger_id}/events`,
  `POST /api/v1/triggers/bulk/pause`, `POST /api/v1/triggers/bulk/resume`,
  `GET /api/v1/triggers/sessions`, `POST /api/v1/flows/`, `POST /api/v1/connections`.

Test 3 passes only when all six steps pass. On `1.14.0.dev32` or later, step 6 failing means the
server lists `resume` as allowed on a `config_invalid` row again, which is LE-3454 regressing.

The file drives only the `request` fixture, so the fixture's HTTP-error monitor sees none of the
deliberate `403`s, `404`s, `409`s and `422`s. After the run the instance holds no flow, user or trigger left by
this file.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev16` or later) at `PLAYWRIGHT_BASE_URL`, auto-login or
  superuser. Test 3's step 6 asserts LE-3454's fix from `1.14.0.dev32` (upstream #16450) and the old
  listing before it.
- `src/backend/base/langflow/api/v1/triggers.py` — list, `scope=all`, sessions and the bulk routes.
- `src/backend/base/langflow/api/v1/triggers_helpers.py` — `list_visible_triggers`, `list_all_triggers`,
  `present` and the per-flow caller probe.
- `src/backend/base/langflow/services/triggers/operator.py` — bulk pause and resume, the refused-resume
  release.
- `src/backend/base/langflow/services/triggers/capabilities.py` — the action and reason rules.
- `src/backend/base/langflow/services/triggers/service.py` — `enable`, `disable` and `admin_pause`.
- `src/backend/base/langflow/services/triggers/dispatcher.py` — the `provider-unavailable` deferral
  behind `degraded`.
- `src/lfx/src/lfx/components/triggers/schedule_trigger.py` and
  `src/lfx/src/lfx/base/triggers/schedule.py` — the Schedule node's `schedule_type`, which decides whether
  `cron_expression` is read at all (`schedule_timing`, upstream #16322); the second file is on the
  `release-1.14.0` line only.
- `src/backend/base/langflow/services/triggers/reconciliation.py` — `_apply_schedule_pick`, where the
  reconciler reads the node's template values and calls `schedule_timing` on flow save.
- `src/backend/base/langflow/services/database/models/trigger/schemas.py` — `TriggerRead`,
  `TriggerBulkRequest`, `TriggerBulkResult`, `TriggerSessionRead`.
- `tests/helpers/triggers/trigger-api.ts`, `tests/helpers/integrations/connections-owner.ts`,
  `tests/helpers/integrations/create-connection.ts`, `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/flows/delete-flow.ts` and `tests/helpers/other/served-version.ts`.
