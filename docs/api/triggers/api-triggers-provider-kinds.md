# Triggers — the nine 1.14 providers' trigger kinds: the saved node, and enabling without a connection that could serve it

**File:** `tests/tests-automations/regression/api/triggers/api-triggers-provider-kinds.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev34`)

Owning issue: #2502 (the 1.14 connector-provider batch, #2498–#2503). Before it, the suite ran one provider trigger
kind, Google Calendar (`trigger-node-controls.md`). The nine providers added in 1.14 bring **17** kinds, and none of
them had been saved, enabled or delivered to. The canvas half is in `trigger-node-controls.md` (tests 5–6) and the
policy half in `docs/governance/trigger-policy-enforcement.md` (test 4).

---

## What this test validates *(required)*

None of the nine providers accepts a credential typed in by hand (#2501, measured: `422` for every one), so a `ready`
connection cannot be built offline and no trigger of these kinds can fire on any lane. What can be tested is
everything `enable` checks **before** it calls the provider. Measured on `1.14.0.dev34`, the order is:

1. resolve the node's connection handle among the flow owner's own connections;
2. the trigger's state, then the trigger-kind policy (#2451);
3. the saved canvas, then the provider's own config check (`normalize_config`);
4. the delivery mechanism the deployment supports;
5. `check_ready`: background runs, executing identity, required scopes;
6. the provider's own pre-arm hook (`prepare`).

Each refusal is a `409`, and the trigger stays `pending`. The contract under test:

### 1. Seventeen kinds, each a component, none created through the API

`GET /api/v1/all` serves each kind as a component whose `metadata.trigger_kind` names it, in its provider's category:

| Provider | Kinds | Delivery on these lanes |
|---|---|---|
| GitHub | `github.issue`, `github.pull_request` | push only (`delivery_mode` offers `push`) |
| GitLab | `gitlab.issue`, `gitlab.merge_request` | push only |
| WhatsApp | `whatsapp.event` | push only |
| Jira | `jira.issue_created`, `jira.issue_updated`, `jira.issue_status` | poll |
| Confluence | `confluence.page_created`, `confluence.page_updated` | poll |
| Salesforce | `salesforce.record` | poll |
| ServiceNow | `servicenow.ticket_created`, `servicenow.status_changed` | poll |
| Discord | `discord.message`, `discord.mention` | gateway listener |
| Telegram | `telegram.message`, `telegram.command` | `auto` resolves to poll (`telegram.get_updates`) without public ingress |

`POST /api/v1/triggers` refuses each of the 17 with `422` *"A '<kind>' trigger is created by adding its component to
the flow, not through this API."*, as `api-triggers-lifecycle.md` asserts for the eight Slack, Microsoft and Google kinds.
Nothing is written.

### 2. A saved node becomes one `pending` row, and `enable` refuses it at the first gate it fails

A flow saved with one of these nodes reconciles **one** row: its `kind`, `provider` and `node_id`, `state: pending`.
Then, for every kind:

**(a) A handle no connection carries.** The row has `connection_id: null` and `reason: config_invalid`, with the
save-time `last_error` *"The flow owner does not own this connection. Shared and instance connections cannot back a
source."* `enable` answers `409` `trigger_connection_not_owned`, the same for all 17 kinds:

> The trigger's connection is unavailable. It may have been deleted or may not belong to you. Choose or create one of
> your own connections. Shared and instance connections cannot back a trigger.

**(b) A connection of another provider.** The handle names the owner's real Google connection. The provider refuses
with its own sentence, written to `last_error` at save time and returned by `enable` (`code: null`):

| Provider | Refusal |
|---|---|
| GitHub | *"Choose a GitHub App installation connection."* |
| GitLab | *"Choose a GitLab connection."* |
| WhatsApp | *"Use a WhatsApp connection."* |
| Jira | *"Choose an owned Jira connection."* |
| Confluence | *"Choose an owned Confluence connection."* |
| Salesforce | *"Choose an owned Salesforce connection."* |
| ServiceNow | *"Choose a servicenow connection for this source."* (the server's generic sentence, with the provider id) |
| Discord | *"Choose a Discord connection."* |
| Telegram | *"Choose a Telegram connection for this trigger."* |

**(c) Its own provider's `pending` connection**, with *Allow background runs* off and then on. That is a connection
with no credential, which is what a consent or a token check leaves behind before it succeeds:

| Provider | Background runs off | Background runs on |
|---|---|---|
| GitHub, GitLab, WhatsApp | *"Push delivery requires a supported public HTTPS ingress on this deployment."* | the same |
| Confluence | *"Space ID. Configure one to 100 approved Confluence space IDs as a comma-separated server setting."* | the same |
| Jira | `background_runs_not_allowed` *"Turn on Allow background runs for this source connection."* | *"The source connection is missing required scopes: offline_access, read:jira-work."* |
| Salesforce | the same | *"… missing required scopes: api, refresh_token."* |
| ServiceNow | the same | *"… missing required scopes: langflow_table_read."* |
| Discord, Telegram | the same | *"The source connection has the wrong executing identity."* |

The push refusal is a property of the deployment. A push kind needs a public HTTPS ingress, and the lanes have none:
their OAuth redirect URIs are `http://localhost`. So on these lanes GitHub, GitLab and WhatsApp are refused at the
delivery gate whatever their connection holds. Confluence stops at its own server setting,
`LANGFLOW_CONFLUENCE_SPACE_IDS`, which no lane sets (#2501), before the connection's state is read. A row refused
before its connection is bound keeps `connection_id: null` and `reason: config_invalid`. A poll or gateway row binds
its connection at save time and reads `reason: pending`.

**(d) The provider's own pre-arm gate.** The test creates a `pending` row shaped to pass `check_ready`: background runs
on, plus the identity and scopes the kind requires. Three providers then refuse in their `prepare` hook, before any
provider call:

- ServiceNow, with `langflow_table_read` granted: *"Reconnect ServiceNow to the configured instance before enabling
  this source."*
- Discord, with a `bot` identity: *"Reconnect Discord to verify the bot identity."*
- Telegram, with a `bot` identity: *"Reconnect Telegram to verify the bot identity before enabling a trigger."*

After every refusal in (a)–(d), the row is still `pending` and never `active`.

### 3. A push provider's ingress answers the same `404`, whether or not the id exists

None of the 17 rows has an ingress of its own: `GET /api/v1/triggers/{id}/ingress` answers `409` *"Only inbound webhook
triggers have an owner-managed signing secret."*, so there is no provider public id to probe.

The test takes a real `public_id` from an armed inbound webhook. A signed delivery to `/ingress/webhook/<id>` is
accepted (`202`), and that is the control. The **same** delivery under the `github`, `gitlab`, `telegram` and
`whatsapp` segments answers `404` with the body `{"detail":"Not found"}`. So does each of these:

- a random id;
- the trigger's own UUID;
- a delivery carrying the provider's own event and signature headers;
- WhatsApp's `GET` verification handshake (`hub.mode=subscribe`, `hub.verify_token`, `hub.challenge`).

All are byte-identical to the `404` an unknown provider segment gets. So none of the four verifiers answers in a way
that tells an existing id from a missing one. `api-triggers-webhook-ingress.md` already makes this check for the
Microsoft and Google segments.

### 4. Lead (no upstream ticket yet, asserted as today's behaviour): a `pending` connection with no credential arms a poll trigger

`check_ready` treats only `revoked` and `expired` as unusable (`UNUSABLE_CONNECTION_STATUSES`), so a `pending` row passes
it. Jira (`jira.issue_created`) and Salesforce (`salesforce.record`) have no `prepare` check that catches it.

The test creates a `pending` connection through `POST /api/v1/connections`: background runs on, the kind's scopes
listed, no credential (`has_credentials: false`). With it, `enable` answers `200`. The trigger reads `active` with no
`last_error`, and still did **3 minutes** later, with nothing in the log.

Google Calendar, which is not one of the nine, does the same, so the gap is in the platform's `check_ready`, not in
either bundle. Google is recorded here, not asserted.

This shape cannot be built from the UI. An abandoned OAuth consent leaves `granted_scopes: []`, and
`PATCH /api/v1/connections/{id}` refuses `granted_scopes` (`422 extra_forbidden`). Through the public API, though, any
user can build it on their own connection.

The test asserts today's behaviour, in the repo's *Lead* pattern (`api-triggers-lifecycle.md`). It goes red the day a
`pending` connection is refused. The new refusal is then the contract, and the test flips to assert it.

### What is not covered here, and why

- **A `ready` connection, and so a trigger that arms and fires**, needs a provider account for each of the nine. It is
  #2503's decision (a live-provider lane).
- **Push activation**: the webhook a provider registers, the signing secret it gets and a real delivery. These need a
  public HTTPS ingress and a `ready` connection, so they fall under the same gap.
- **The gateway listener's run-time behaviour** (Discord) and a poll round (Jira, Confluence, Salesforce, ServiceNow,
  Telegram). Both start only after `enable` succeeds.

---

## Tags *(required)*

`@stable` `@api` `@integrations`. Nothing here needs a provider key, a tenant or network egress, and every refusal is a
fixed server sentence.

---

## Step by step *(required)*

Each worker runs as its own throwaway user (`createConnectionsOwner`). That keeps the `pending` connections and the
flows off the superuser's quotas, and deleting the user takes its flows, triggers and connections. Flows are built from
the component catalog (`createCatalogFlow`) with one trigger node, and each test deletes its flows by id.

The connections are left to the user's deletion in `afterAll`. Connection writes share one bucket of 30 per user per
minute (`api-connections-rate-limits.md`), and a `DELETE` counts. A delete per connection doubled the writes, and the
first run waited out two `429` windows (+60 s each). For the same reason, the other provider's connection (Google) is
created once per worker. Requires `1.14.0.dev34`; an older build skips with that reason.

**Test 1 — the seventeen 1.14 provider kinds are served as trigger components and cannot be created through the
triggers API.**
1. `GET /api/v1/all`: each of the 17 component types is present, and its `metadata.trigger_kind` is its kind.
2. For each kind, `POST /api/v1/triggers` on a flow of the owner's answers `422` with the sentence above. The flow
   still has no trigger.

**Tests 2–10 — `<Provider>: each kind's saved node reconciles one pending trigger, and enable refuses it until a
<provider> connection could serve it`**, one test per provider. For each of the provider's kinds:
1. Save a flow with the node bound to a handle no connection carries. Exactly one row: the kind, its provider,
   `node_id`, `pending`, `connection_id: null`, `reason: config_invalid`, and the save-time `last_error` above.
   `enable` → `409 trigger_connection_not_owned` with the exact message. The row is unchanged.
2. Save one bound to the owner's Google connection. `last_error` and `enable` (`409`, `code: null`) both carry the
   provider's own sentence.
3. Save one bound to a `pending` connection of the provider, with background runs off. `enable` → `409` with the
   table's first column.
4. The same with a `pending` connection whose background runs are on. `enable` → `409` with the table's second column.
5. ServiceNow, Discord, Telegram only: a `pending` connection shaped to pass `check_ready`. `enable` → `409` with the
   provider's pre-arm sentence.
6. After each step, the row reads `pending`, never `active`.

**Test 11 — a delivery to a push provider's ingress answers the uniform 404, for an id that exists and one that does
not.**
1. Save an inbound webhook flow, enable its trigger and mint its signing secret. A signed delivery to
   `/ingress/webhook/<public_id>` → `202`, the control.
2. A GitHub trigger row of the owner's: `GET …/ingress` → `409` with the sentence above.
3. For `github`, `gitlab`, `telegram` and `whatsapp`: the signed delivery with the real `public_id`, the same
   delivery to a random id and to the trigger's UUID, and one carrying the provider's own headers. Each answers `404`
   with a body byte-identical to `nosuch`'s. WhatsApp's `GET` handshake does the same.

**Test 12 — Lead (no upstream ticket yet): a Jira or Salesforce trigger arms on a pending connection that holds no
credential.** For `jira.issue_created` and `salesforce.record`:
1. Create a `pending` connection of the provider with `allow_non_interactive: true` and the kind's required scopes
   (Jira `read:jira-work`, `offline_access`; Salesforce `api`, `refresh_token`), and no credential. It reads
   `pending`, `has_credentials: false`.
2. Save a flow with the node bound to it. `enable` → `200`, `state: active`, no `last_error`.
3. Five seconds later the row still reads `active`, `last_error: null`. The connection still reads `pending`,
   `has_credentials: false`.

---

## Validation criterion *(required)*

All 12 tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev34`, and once at
`--workers=2` beside `api-triggers-webhook-ingress` and `api-connections-action-runs`. Every assertion is on an exact
status, code, sentence or state. Every refusal is paired with a step that reaches a later gate on the same kind, so a
refusal that fired too early would fail its own step. The `404`s are paired with the `202` control. Each test has an
executed force-fail mutation. No flow, trigger, connection or throwaway user is left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance at `PLAYWRIGHT_BASE_URL`, auto-login, with the nine provider bundles installed
  (the nightly ships them). No public HTTPS ingress, and no `LANGFLOW_CONFLUENCE_SPACE_IDS`: both are true on every
  lane, and either one set would move a push or Confluence refusal to a later gate.
- No provider account, no OAuth consent, no network egress.
- `src/backend/base/langflow/services/triggers/service.py`: `enable`'s order, and the create refusal.
- `src/backend/base/langflow/services/triggers/locking.py`: the handle resolved before the policy.
- `src/backend/base/langflow/services/triggers/ownership.py`: `trigger_connection_not_owned`, and the statuses
  `check_ready` treats as unusable.
- `src/backend/base/langflow/services/triggers/source_arming.py`: the delivery gate and `check_ready`.
- `src/backend/base/langflow/services/triggers/providers/registry.py`: the kinds and their mechanisms.
- `src/backend/base/langflow/services/triggers/providers/github/config.py`,
  `src/backend/base/langflow/services/triggers/providers/gitlab/config.py`,
  `src/backend/base/langflow/services/triggers/providers/whatsapp/config.py`,
  `src/backend/base/langflow/services/triggers/providers/jira/collector.py`,
  `src/backend/base/langflow/services/triggers/providers/confluence/collector.py`,
  `src/backend/base/langflow/services/triggers/providers/salesforce/collector.py`,
  `src/backend/base/langflow/services/triggers/providers/discord/config.py`,
  `src/backend/base/langflow/services/triggers/providers/telegram/config.py`: each provider's own refusal.
- `src/backend/base/langflow/services/triggers/providers/servicenow/runtime.py`,
  `src/backend/base/langflow/services/triggers/providers/discord/lifecycle.py`,
  `src/backend/base/langflow/services/triggers/providers/telegram/lifecycle.py`: the pre-arm gates.
- `src/bundles/confluence/src/lfx_confluence/schema.py`: the approved-space setting.
- `src/backend/base/langflow/api/v1/triggers.py`: the `409` mapping and the ingress read.
- `src/backend/base/langflow/api/v1/trigger_ingress.py`: the uniform `404`.
