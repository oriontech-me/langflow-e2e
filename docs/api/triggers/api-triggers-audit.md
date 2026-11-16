# Triggers API — the audit trail of owner and operator actions

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-audit.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2451. The audit row a policy writes (`trigger:policy_denied`) needs a policy change, so it
is asserted in `docs/governance/trigger-policy-enforcement.md`, which runs in the destructive lane. The
actions themselves are covered elsewhere: an owner's `enable`, `disable`, `test` and `replay` by
`docs/api/triggers/api-triggers-webhook-ingress.md`, and an operator's bulk pause and resume by #2448.
Upstream: #16271 (`v1.14.0.dev23`), #16374 and #16384 (`v1.14.0.dev26`).

---

## What this test validates *(required)*

Each trigger action an operator would need to reconstruct writes a row to the authorization audit log,
which a superuser reads through `GET /api/v1/authz/audit` (filters `action`, `resource_type`,
`resource_id`, `user_id`, `since`, among others). These rows are written whether or not
`AUTHZ_AUDIT_ENABLED` is set. The contract under test:

1. **Owner actions.** `trigger:resume` for each `enable`, `trigger:pause` for each `disable`, and
   `trigger:replay` for each replay. Each row:
   - names its trigger: `resource_type: "trigger"` and `resource_id`;
   - names its actor: `user_id`;
   - reads `result: "allow"`;
   - carries `details.event: "mutation"` and the trigger's `flow_id`.

   The replay row also names both events: `original_event_id` and `replay_event_id`.
2. **Operator actions.** A bulk pause and resume by `trigger_ids` write `trigger:admin_pause` and
   `trigger:admin_resume` for each trigger they change, and no row for a trigger they did not select.
3. **Who may read it.** The log answers a superuser only, and is left out of the OpenAPI schema.

### Measured on `1.14.0.dev28`

- **One row per action.** On one trigger, `enable`, `disable`, `enable`, then a replay, wrote exactly
  two `trigger:resume` rows, one `trigger:pause` and one `trigger:replay`. The spec counts per action,
  filtered by `resource_id`, so another test's rows never enter the count.
- **The row shape.** An owner row reads `details: {event: "mutation", flow_id, provider: null,
  request_id, auth_method: "jwt"}`. An operator row carries `event`, `provider`, `request_id` and
  `auth_method`, but **no** `flow_id`, so the spec asserts `flow_id` on owner rows only. `user_id` is the
  acting superuser in both.
- **The bulk pause** answers `{action: "pause", matched: 1, changed: [id], unchanged: [], failed: [],
  owners: 1}`, and the trigger reads `paused` with `reason: paused_by_admin`. The resume puts it back to
  `active`.
- **A non-superuser** gets `403` *"The user doesn't have enough privileges"*.
- **`/openapi.json`** lists `/api/v1/audits`, `/api/v1/flows/audits` and `/api/v1/projects/audits`,
  but not `/api/v1/authz/audit` (`include_in_schema=False`).

### What is not covered here, and why

- **`trigger_ingress:accept` and `trigger_ingress:reject`.** They are written only with
  `LANGFLOW_AUTHZ_AUDIT_ENABLED=true`, which no OSS lane sets; only
  `scripts/start-langflow-enterprise.sh` does. This is recorded here rather than widening a lane for it.
- **`trigger:policy_denied`.** It needs an instance-global policy change, so it is asserted in the
  destructive lane (`governance/trigger-policy-enforcement.spec.ts`).
- **Audit rows for subscription creation on provider triggers.** Those triggers need a real tenant (see
  the governance doc's *Not covered*).

---

## Tags *(required)*

`@stable` `@api` `@integrations`

`@stable`: no policy change, no provider key and no external network. Every row is read by the test's own
trigger ids, and the bulk actions select by `trigger_ids`, so a parallel worker's triggers are never
touched. `@stable` enters in this PR. The file skips below `1.14.0.dev26`, the first nightly carrying
every audit fix of the batch.

---

## Step by step *(required)*

Every test runs as the superuser, whose id is read from `GET /api/v1/users/whoami`. Each builds
*Inbound Webhook → Chat Output* flows with `createCatalogFlow` and deletes them by id in `afterEach`.
Audit reads filter by `action` and `resource_id`.

### 1. An owner's resume, pause and replay each write one audit row naming the trigger

1. Create a webhook flow. `enable`, `disable`, then `enable` its trigger (each `200`).
2. Send one test event (`202`) and replay it (`202`), keeping both ids.
3. Expect exactly two `trigger:resume` rows, one `trigger:pause` and one `trigger:replay`. Each row:
   - reads `resource_type: "trigger"` with the trigger's id, the superuser's `user_id` and `result:
     "allow"`;
   - carries `details.event: "mutation"` and the flow's id as `details.flow_id`.

   The replay row's `details` also name the test event as `original_event_id` and the replay as
   `replay_event_id`.

### 2. An operator's bulk pause and resume write admin rows only for the triggers it selected

1. Create two webhook flows and enable both triggers.
2. `POST /api/v1/triggers/bulk/pause` with the first trigger's id only. Expect `changed` to hold exactly
   that id, the first trigger `paused` with `reason: paused_by_admin`, and the second still `active`.
3. Expect one `trigger:admin_pause` row for the first trigger, with the superuser's `user_id` and
   `result: "allow"`, and none for the second.
4. `POST /api/v1/triggers/bulk/resume` with the same id. Expect the first trigger `active`, one
   `trigger:admin_resume` row for it, and none for the second.

### 3. The audit log answers only a superuser and is left out of the OpenAPI schema

1. Create a throwaway non-superuser (`createConnectionsOwner`). Expect `GET /api/v1/authz/audit` to
   answer it `403` *"The user doesn't have enough privileges"*, and the superuser `200` with `items`
   and `total`.
2. Expect `/openapi.json` to list `/api/v1/triggers` and not `/api/v1/authz/audit`.

---

## Validation criterion *(required)*

Tests 1–3 pass three consecutive times at `--retries=0 --workers=1` and once at `--workers=2` against
`1.14.0.dev28`, with:

- every row matched by its action and its trigger's id, and counted exactly;
- the operator's rows asserted absent for the trigger the request did not select;
- zero `🚨 Backend Error`: the `403` is driven through a separate request context;
- no flow, trigger row or throwaway user left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev26` or later) at `PLAYWRIGHT_BASE_URL`, auto-login,
  with trigger dispatch running (the default).
- `src/backend/base/langflow/api/v1/authz_audit.py` — the audit read, its filters and its superuser
  guard.
- `src/backend/base/langflow/api/v1/triggers.py` — `_commit_trigger_action` and the owner actions' rows.
- `src/backend/base/langflow/services/triggers/operator.py` — the bulk pause and resume, and their rows.
- `src/backend/base/langflow/services/triggers/constants.py` — the audit action names.
- `src/backend/base/langflow/services/triggers/ingress/intake.py` — the ingress rows written only when
  audit is enabled.
- `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py` — the trigger component.
- `tests/helpers/integrations/connections-owner.ts`, `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/flows/delete-flow.ts` and `tests/helpers/other/served-version.ts`.
