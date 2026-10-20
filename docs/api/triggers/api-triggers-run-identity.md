# Triggers — a trigger run acts as the flow owner

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-run-identity.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev47`)

Owning issue: #2309 (Dedicated Integrations, batch 2). It reuses the probe from #2296
(`tests/helpers/integrations/connection-probe.ts`) and the throwaway owner from #2295
(`tests/helpers/integrations/connections-owner.ts`). Its sibling
`docs/api/connections/api-connections-resolution-non-interactive.md` (#2306) covers the other
non-interactive families: webhook, HITL resume and KB ingest. The trigger lifecycle itself (CRUD,
the state machine, validation, flow-save reconciliation) is #2303's; this file uses only the calls
it needs to fire a run.

---

## What this test validates *(required)*

A trigger run has nobody present. The dispatcher stamps it `trigger_push` (an ingress delivery,
including every `inbound_webhook` run) or `trigger_listener` (a schedule tick), and either way the
run executes as the **flow owner**, non-interactively:
`ExecutionPrincipal(kind="flow_owner", interactive=False)` (`services/triggers/principal.py`). So a
trigger run may use a **user** connection only when that user opted in (`allow_non_interactive`),
it may use an **instance** connection without any opt-in, and it may never use another user's
connection.

The refusal happens in **one of two places**, depending on how the flow names the connection.
Measured on `1.13.0.dev47`:

| How the connection is named | Where the opt-in is checked | What a refusal looks like |
|---|---|---|
| By **handle**, inside the flow (a `ConnectionRefInput` on a node) | Inside the run, by the resolver | The event is `dispatched` with a `job_id`, the run completes, the node reports `connection-not-authorized` / `non-interactive-opt-in-required`, and the trigger **stays `active`** |
| By the trigger's own **`connection_id`** | Before the job exists, by the dispatcher's `connection_preflight`, on every event | The event is `failed` with `error: "connection_not_authorized"` and no `job_id`, and the trigger is marked **`needs_reconnect`** with `last_error: "connection_not_authorized"` |

The issue's first scope item put both halves on the handle path (*"a probe node references the
owner's connection … and the trigger moves to `needs_reconnect`"*). The code and the measurement
both say otherwise: `needs_reconnect` comes only from the preflight, and the preflight reads only
`trigger.connection_id`. A flow that resolves by handle is authorized inside the run, and a refusal
there leaves the trigger running. Both paths are asserted.

### The oracle

The probe component from #2296 calls `self.resolve_connection(<field>).get_credential()` for each of
its handles and prints one line per field: `PROBE <field> resolved owner_kind=<kind>
connection_id=<id>`, or `PROBE <field> denied code=<code> reason=<reason>`. It never prints the token
and never calls a provider.

A trigger run's Chat Output lands in the owner's `GET /api/v1/monitor/messages?flow_id=…`, under the
`session_id` the event reads once it is `dispatched` (`trigger:<trigger_id>:<event_id>`). The run is
matched by that `session_id`, never by count or position. Measured: an event is `dispatched` 2–10 s
after it is appended (the dispatcher polls every 5 s by default), and its message is there ~0.2 s
after that. On the dispatcher's next pass `reconcile_dispatched` closes the event out as
`completed`, so a run is accepted in either state; both carry the `job_id` and the `session_id`.

### Measured on `1.13.0.dev47`

- **A signed ingress delivery is a real `trigger_push` run.** `POST /api/v1/triggers/{id}/signing-secret`
  arms an `inbound_webhook` trigger's ingress and answers its `ingress_url` and `signing_secret` once.
  `GET …/ingress` before that answers `public_id: null`, `ingress_url: null`. A delivery signed
  `X-Langflow-Signature: v1=<hex HMAC-SHA256 of "v1:{timestamp}:{body}">` with `X-Langflow-Timestamp`
  answers `202` and appends an event whose `dedupe_key` starts with `ingress:webhook:` and whose
  `payload` is `{provider: "webhook", delivery: <the body>}`. A wrong signature answers `404`
  `{"detail": "Not found"}`, the same as an unknown id.
- **The opt-in is read at run time.** With it off, the run reports `non-interactive-opt-in-required`
  for the owner's connection. After `PATCH allow_non_interactive: true`, the next delivery to the same
  trigger resolves the same row (`owner_kind=user`, its id).
- **An instance connection resolves** with its own flag sent explicitly off (`owner_kind=instance`,
  its id).
- **Another user's connection is not the run's to use.** The superuser's own row, opted in, reads
  `connection-unresolved` / `missing` inside the owner's run: the resolver looks the handle up as the
  flow owner, who cannot see it.
- **`needs_reconnect` marks the trigger; it does not hold its events.** It is one of the dispatcher's
  dispatchable states (`_DISPATCHABLE_TRIGGER_STATES`), so every new event is claimed and preflighted
  again. With the opt-in still off, it fails the same way. Once the owner turns the opt-in on, the
  next event is dispatched and resolves the row **with no re-enable**, and the trigger still reads
  `needs_reconnect` afterwards: a successful run does not clear the mark. `POST …/enable` clears it,
  back to `active` with `last_error: null`. (Only Microsoft and Google source triggers are held in
  that state, and those cannot be created through this API.)
- **A Schedule trigger imported through flow JSON fires.** A `ScheduleTrigger` node
  (`cron_expression: "* * * * *"`, `timezone: "UTC"`) in a flow created through `POST /api/v1/flows/`
  makes the flow-save reconciler create a `schedule` row in state `pending`, with `node_id` set to the
  node's id and `config` `{cron, timezone, catchup_policy: "coalesce", share_session: false}`.
  `next_fire_at` is still `null` right after `enable`; the scheduler sets it on its next pass (up to
  one 5 s poll later), to the first minute boundary after **that pass** — so an `enable` a few seconds
  before a boundary can arm the boundary after it. The same write moves the row's `updated_at`. At that minute an event with `dedupe_key: "tick:<that instant>"`
  and `payload.scheduled_at` equal to it is appended, dispatched ~4 s later, and the run reports the
  same verdicts as a webhook run. `disable` answers `paused`.

### What is not covered here, and why

- **A trigger created by a collaborator still runs as the owner** (scope item 3) is **not reachable on
  the OSS nightly**. `create_trigger` keys the row on `flow.user_id`, but in OSS nobody except the
  owner can write the flow: `_read_flow` is owner-scoped unless an authorization plugin supports
  cross-user fetch (`authorized_or_owner_scoped`). Measured: the superuser creating a trigger on the
  owner's flow gets `404 "Trigger not found"`. A collaborator exists only on an Enterprise instance
  with RBAC (`@enterprise` `@authz`), which this file does not target. The OSS half of the guarantee
  (the run uses the owner's connection and never another user's) is asserted in test 1.
- **That the run is stamped `trigger_push` vs `trigger_listener`** has no black-box observable:
  both families share their rules today (`family_for`'s docstring), and nothing a run returns names
  its family.
- **Replay**, the ledger's dedupe of a redelivery, and the trigger state machine are #2303's.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model and no network egress. The planted credentials never leave the
instance, and the dispatcher and the scheduler are on by default on every lane
(`trigger_dispatcher_enabled`). `@stable` enters in this PR.

---

## Step by step *(required)*

Three tests over the `request` fixture, each declaring its operations through `apiCoverage`. Each
test creates its own throwaway owner (`createConnectionsOwner`) and sends the owner's token on the
test's own `request`. Instance rows are created by the superuser (only a superuser may create one).
Teardown deletes the instance rows, then the owner, which takes the owner's flows, triggers and
connections with it.

**Test 1 — `a webhook delivery runs as the flow owner: the owner's connection needs the opt-in, the instance's does not, another user's never resolves`**
1. Plant three `google` rows: the owner's (opt-in off), an instance row with `allow_non_interactive`
   sent `false`, and the superuser's own row with the opt-in **on**.
2. Create the owner's probe flow (Chat Input → Probe → Chat Output) with one probe field per row.
3. `POST /api/v1/triggers` (`kind: "inbound_webhook"`, no `connection_id`) → `201`, `user_id` is the
   owner's. `POST …/enable` → `active`. `POST …/signing-secret` → an `ingress_url` and a
   `signing_secret`.
4. Deliver a signed body to the ingress URL → `202`. Wait for the event whose `dedupe_key` starts with
   `ingress:webhook:` and whose `payload.delivery` is the body to be `dispatched` with a `job_id`, and
   read its run's probe message by `session_id`:
   - owner → `denied`, `connection-not-authorized` / `non-interactive-opt-in-required`;
   - instance → `resolved`, `instance`, the instance row's id;
   - superuser → `denied`, `connection-unresolved` / `missing`.
5. `GET` the trigger → still `active`, `last_error: null`: a refusal inside the run does not take the
   trigger out of service.
6. `PATCH` the owner's row `allow_non_interactive: true`. Deliver a second signed body → `202`; its run
   reads owner → `resolved`, `user`, the owner's row id; instance unchanged; superuser still `missing`.

**Test 2 — `a trigger that names its connection fails closed before any run, and runs again as soon as the owner opts in`**
1. Plant the owner's `google` row (opt-in off) and create the probe flow with one field for it.
2. `POST /api/v1/triggers` (`kind: "inbound_webhook"`, `connection_id` = that row) → `201`. Enable →
   `active`.
3. `POST …/test` → `202`, a `pending` event. Wait for it to settle → `failed`,
   `error: "connection_not_authorized"`, `job_id: null`, `session_id: null`: no run was created.
4. `GET` the trigger → `needs_reconnect`, `last_error: "connection_not_authorized"`.
5. `PATCH` the row `allow_non_interactive: true`, with **no** re-enable. `POST …/test` → the event
   runs (it carries a `job_id` and a `session_id`), and its run reads owner → `resolved`, `user`, the
   row's id. The trigger still reads `needs_reconnect`.
6. `POST …/enable` → `active`, `last_error: null`.

**Test 3 — `a schedule trigger imported through flow JSON fires on its cron and runs as the flow owner`**
1. Plant the owner's `google` row (opt-in off) and an instance row (flag sent `false`).
2. Create the owner's probe flow with a `ScheduleTrigger` node added (`cron_expression: "* * * * *"`,
   `timezone: "UTC"`), through `POST /api/v1/flows/`.
3. `GET /api/v1/triggers?flow_id=…` → exactly one row: `kind: "schedule"`, `node_id` = the node's id,
   `config.cron: "* * * * *"`, `config.timezone: "UTC"`, `state: "pending"`, `user_id` = the owner's.
4. `POST …/enable` → `active`. Poll the trigger until `next_fire_at` is set. It is a whole minute
   (`:00` seconds), after the scheduler's write (the row's `updated_at`) and no more than 61 s after it
   (60 s to the boundary, plus the second `updated_at` is truncated to). The bound is measured from the
   scheduler's write, not from the enable, for the reason above.
5. Poll the events until the one with `dedupe_key: "tick:<next_fire_at>"` has run (it carries a
   `job_id`), with `payload.scheduled_at` equal to `next_fire_at`. The wait is capped at 120 s: at most
   the minute to the boundary, plus the scheduler's and the dispatcher's polls and the run. The test
   timeout is 240 s.
6. Its run reads owner → `denied` / `non-interactive-opt-in-required`, instance → `resolved`.
7. `POST …/disable` → `paused`, so the schedule stops firing before teardown.

---

## Validation criterion *(required)*

All three tests pass three consecutive times at `--retries=0 --workers=1` against `1.13.0.dev47`,
and once at `--workers=2` together with `api/connections/`, with:

- every probe verdict asserted on the **code and the typed reason** for a denial, and on the
  **exact connection id and `owner_kind`** for a resolution, read from the run whose `session_id`
  the event names;
- the handle path (test 1) leaving the trigger `active` with `last_error: null` after a refused run;
- the preflight path (test 2) leaving no run at all (`job_id` and `session_id` both `null`), the
  trigger marked `needs_reconnect`, the next event running as soon as the opt-in is on, and `enable`
  clearing the mark;
- the schedule (test 3) firing exactly at `next_fire_at`, the first whole minute after the
  scheduler armed it, with the tick's
  `dedupe_key` and `scheduled_at` naming it;
- no planted token appearing in any probe message;
- no backend error logged, and the declared coverage matching what the fixture recorded:
  `POST /api/v1/triggers`, `GET /api/v1/triggers`, `GET /api/v1/triggers/{trigger_id}`,
  `POST /api/v1/triggers/{trigger_id}/enable`, `POST /api/v1/triggers/{trigger_id}/disable`,
  `POST /api/v1/triggers/{trigger_id}/test`, `GET /api/v1/triggers/{trigger_id}/events`,
  `POST /api/v1/triggers/{trigger_id}/signing-secret`,
  `POST /api/v1/triggers/ingress/{provider}/{public_id}`, `POST /api/v1/connections`,
  `PATCH /api/v1/connections/{connection_id}`, `POST /api/v1/flows/`,
  `GET /api/v1/monitor/messages`.

After the run, the instance has no connection, flow or user left from this file.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser, with the
  trigger dispatcher and ingress at their defaults (`trigger_dispatcher_enabled`,
  `trigger_ingress_enabled`, a 5 s `trigger_dispatcher_poll_interval_s`).
- `src/backend/base/langflow/services/triggers/dispatcher.py` — `dispatch_event`: the preflight, the
  `needs_reconnect` transition, `build_submit_request` and the run's `session_id`.
- `src/backend/base/langflow/services/triggers/principal.py` — `family_for`,
  `trigger_execution_principal` (`flow_owner`, `interactive=False`) and `connection_preflight`.
- `src/backend/base/langflow/api/utils/execution_principal.py` — the families and the principal they
  stamp.
- `src/lfx/src/lfx/services/connection/base.py` — `authorize_principal`, the floor that answers
  `non-interactive-opt-in-required`.
- `src/backend/base/langflow/api/v1/triggers.py` — the routes this file drives, and
  `create_trigger` keying the row on the flow owner.
- `src/backend/base/langflow/api/v1/trigger_ingress.py` and
  `src/backend/base/langflow/services/triggers/ingress/verifiers.py` — the ingress route and the
  `X-Langflow-Signature` scheme.
- `src/backend/base/langflow/services/triggers/scheduler.py` and
  `src/lfx/src/lfx/components/triggers/schedule_trigger.py` — the tick's fire time and dedupe key, and
  the node's `trigger_config`.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_read_flow`, owner-scoped in OSS, which is
  why scope item 3 is not reachable here.
- `tests/helpers/integrations/connection-probe.ts`, `tests/helpers/integrations/connections-owner.ts`,
  `tests/helpers/integrations/create-connection.ts` and `tests/helpers/flows/build-catalog-flow.ts`.
