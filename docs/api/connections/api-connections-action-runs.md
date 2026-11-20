# Connections — the nine 1.14 providers' actions at run time, with no connection to resolve

**File:** `tests/tests-automations/regression/api/connections/api-connections-action-runs.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2501 (the 1.14 connector-provider batch, follow-up). The canvas half, one non-Google provider on the
canvas, is in `docs/core-functionality/integrations/connector-run-errors.md` (tests 4 and 5).

---

## What this test validates *(required)*

Every action of the twelve providers is asserted to **exist** (manifest, catalog, palette, canvas, Tool Mode), and
only Google's had ever been **run**. This file runs one action of each of the nine providers added in 1.14 (GitHub,
GitLab, Jira, Confluence, Salesforce, ServiceNow, Discord, Telegram and WhatsApp) through `POST /api/v2/workflows`,
the way the canvas runs a node (`mode: stream`, `stream_protocol: agui`), and reads the run's one `RUN_ERROR` event.

A **ready** connection is out of reach for these nine without a real account, so every run here fails before any call
could leave the instance. Measured on `1.14.0.dev32`: none of the nine accepts a planted credential.
`POST /api/v1/connections` with `credentials` answers `422`. For the OAuth providers the answer is *"This integration
does not support manually entered credentials."*. WhatsApp answers *"WhatsApp requires your own system-user token on a
configured hosted or self-managed server."*. The pasted-token providers check the token with the provider first (#2500).
Two contracts remain reachable offline, and both are what a flow author sees first when a flow is wrong.

### The action each provider runs

One read action per provider, or the plain *send* where the provider has no read action. The table lists the
inputs a run passes. Every one of them is well formed, so the only thing that can stop the run is the connection.

| Provider | Action (catalog key) | Well-formed inputs |
|---|---|---|
| GitHub | `ext:github:GitHubGetRepositoryComponent@official` | `repository: octocat/hello-world` |
| GitLab | `ext:gitlab:GitLabGetProjectComponent@official` | `project_id: 278964` |
| Jira | `ext:jira:JiraReadIssueComponent@official` | `issue: DEMO-123` |
| Confluence | `ext:confluence_integrations:ConfluenceReadPageComponent@official` | `page_id: 123`, `space_id: 456` |
| Salesforce | `ext:salesforce:SalesforceReadRecordComponent@official` | `record_id: 001000000000001AAA` |
| ServiceNow | `ext:servicenow:ServiceNowReadRecordComponent@official` | `record_id`: 32 lowercase hex characters, `table: incident` (default) |
| Discord | `ext:discord:DiscordSendMessageComponent@official` | numeric `guild_id` and `channel_id`, `text: hi` |
| Telegram | `ext:telegram:TelegramSendMessageComponent@official` | `chat_id: 12345`, `text: hi` |
| WhatsApp | `ext:whatsapp:WhatsAppSendTextComponent@official` | `to: +15551234567`, `text: hi` |

### 1. Resolution: an unbound handle and a `pending` row both fail with `connection-unresolved`, naming the handle

For eight providers (every one but Confluence, see § 3), a run whose `connection` names a handle no row carries ends
with:

```
RUN_ERROR  {"code": "connection-unresolved",
            "message": "Connection '<provider>/<handle>' could not be resolved. Configure the connection for this execution environment.\n\nConfigure the connection for this execution environment."}
```

The same handle repeats inside the message, and the hint repeats after it. That is
`ConnectionUnresolvedError`'s own message plus the translator's hint, as measured for Google in
`connector-run-errors.md`.

**A `pending` row fails the same way, word for word.** The issue expected a distinct "pending sibling" code. There
is none. A row created with no credential is found by its handle, and the resolver still reports it as
`connection-unresolved`, reason `missing` (the sync response's `details.reason`). The test asserts the identical
event and that the row is still `pending`, with no credential, after the run.

### 2. Input validation runs **before** resolution, for seven providers, with the bundle's exact copy

The issue left open whether `ConnectionRefInput` resolves before the component body runs. It does not. The body
calls `resolve_connection()` itself, and seven of the nine validate their inputs first. So a malformed input is
refused with an **unbound** handle, and no connection is needed to reach it:

| Provider | Malformed input | `RUN_ERROR` message (the hint follows) |
|---|---|---|
| GitHub | `repository: not-a-repo` | *"Use a GitHub.com repository in owner/repository form."* |
| GitLab | `project_id: 0` | *"Project ID must be an integer from 1 to 9223372036854775807 (the signed 64-bit range)."* |
| Jira | `issue: demo-123` | *"Use a Jira issue key such as DEMO-123."* |
| Confluence | `space_id: abc` | *"Use a positive Confluence numeric ID within 19 digits."* |
| Salesforce | `record_id: 123` | *"A Salesforce record ID must contain 15 or 18 alphanumeric characters."* |
| Discord | `channel_id: abc` | *"Use a numeric Discord ID copied from developer mode."* |
| Telegram | `chat_id: abc` | *"Use a numeric Telegram ID."* |

Each carries `code: invalid-request` and the hint *"Check the action's inputs and try again."* (message, blank line,
hint). Because the handle is unbound, the refusal is itself the proof of the order: had resolution run first, the
event would read `connection-unresolved`.

**WhatsApp validates first too, but its refusal is not an integration error.** `recipient()` raises a bare
`ValueError`, so `to: abc` ends the run with:

```
RUN_ERROR  {"message": "Use a recipient phone number with country code and digits only."}
```

There is no `code` and no hint. On the canvas that renders as the bare message, without the `[code]` prefix every
other provider gets. The other seven raise `InvalidRequestError`. The test asserts the exact message **and** the
absent `code`. A bundle release that moves WhatsApp onto `InvalidRequestError` then fails here by name, which is a
change worth seeing rather than one to absorb silently.

**ServiceNow is the exception to the order.** Its four actions call `authorize_connection()` before they validate
anything. A malformed `record_id` (`XYZ`) with an unbound handle therefore reads `connection-unresolved`, not *"Record
ID must contain 32 lowercase hexadecimal characters."*. The test asserts that. ServiceNow's own validation copy cannot
be reached offline, because it needs a resolved, ready connection.

### 3. Confluence: an operator setting no lane configures stops every action

Every Confluence action takes a `space_id` and passes it through `approved_space()`. That function checks the value's
shape first, then requires the server setting `LANGFLOW_CONFLUENCE_SPACE_IDS`. No lane sets it: #2498 named the
Confluence **site**, not its spaces. So with a well-formed `space_id`, an unbound handle and a `pending` row both end
with:

```
RUN_ERROR  {"code": "invalid-request",
            "message": "Configure one to 100 approved Confluence space IDs as a comma-separated server setting.\n\nCheck the action's inputs and try again."}
```

The run never reaches the connection. This is the issue's scope item 4 (an operator setting a lane leaves unconfigured
names itself). The message does not spell the variable's name. Configuring the setting on a lane would change this
test's expectation, so a lane change has to update this doc.

### Recorded, not asserted

- **No ready connection, so no token can leak.** The issue's "never a token in the stream" needs a credential to
  leak. None of the nine can hold one offline (above), so there is no sentinel to look for.
- **Operator settings behind the connection.** WhatsApp needs five server settings (`LANGFLOW_WHATSAPP_APP_ID`,
  `…_WABA_ID`, `…_PHONE_ID`, `…_GRAPH_VERSION`, `…_APP_SECRET`) that no lane sets. ServiceNow approves only
  `incident` unless `LANGFLOW_SERVICENOW_TABLES` says otherwise, so `problem` and `change_request` are offered in the
  dropdown and refused at run time. Both are read **after** the connection resolves, so neither is reachable offline.
- **The other 32 actions.** One action per provider is run. Every action of a provider shares the component base
  that resolves the connection, but each action's own validators are not swept.
- **The sync response** (`POST /api/v2/workflows` without `mode: stream`) reports the same failure as
  `errors[0].error`, a `str()` of the error dict (`"400: {'error_code': 'connection-unresolved', …}"`). WhatsApp's
  `ValueError` reads `"Error running graph: Error building Component WhatsApp: Send Text: …"` there. The stream is
  what the canvas reads, so the stream is what is asserted.

---

## Tags *(required)*

`@stable` `@api` `@integrations`.

`@stable` because nothing here needs a provider account, a key or the network. Every run fails inside the instance
before a credential exists.

---

## Step by step *(required)*

Runs as a throwaway user of its own (`createConnectionsOwner`, once per worker), so its `pending` rows spend that
user's connection-write bucket (30/minute) and not the superuser's. Requires `1.14.0.dev23`, where the nine providers
first appear. Flows are built from the live catalog (`createCatalogFlow`), one action node each. Every flow and row a
test creates is deleted after it, by id, and deleting the user in `afterAll` is the last line of cleanup.

A run is `POST /api/v2/workflows` with the owner's bearer token and
`{flow_id, input_value: "", mode: "stream", stream_protocol: "agui"}`. It answers `200`, and its body holds exactly
one `RUN_ERROR` event.

**Tests 1–8: `<provider>: an unbound handle and a pending row both fail the run with connection-unresolved, naming
the handle`**, one per provider except Confluence.
1. Save the provider's action with its well-formed inputs and a handle no row carries. Run it: `connection-unresolved`
   with the message above, naming `<provider>/<handle>`.
2. Create a `pending` row for the provider (no credential) and save the same action bound to it. Run it: the same
   event, naming that row's handle.
3. The row is still `pending`, with `has_credentials: false`.
4. ServiceNow only: the same action with `record_id: XYZ` and an unbound handle also reads `connection-unresolved`,
   because ServiceNow resolves before it validates.

**Tests 9–15: `<provider>: a malformed <input> is refused before the connection is looked up, with the bundle's own
copy`**, one per provider in § 2's table.
1. Save the action with the malformed input and an unbound handle. Run it.
2. The event's `code` is `invalid-request` and its message is the copy above, a blank line, then *"Check the action's
   inputs and try again."*.

**Test 16: `WhatsApp: a malformed recipient is refused before the connection is looked up, as a plain error with no
integration code`.**
1. Save *Send Text* with `to: abc` and an unbound handle. Run it.
2. The event's message is exactly *"Use a recipient phone number with country code and digits only."*, and it has no
   `code`.

**Test 17: `Confluence: an unconfigured approved-space setting stops the action before its connection is looked up`.**
1. Save *Read Page* with well-formed inputs and an unbound handle, run it. Then do the same bound to a `pending`
   Confluence row.
2. Both events read `invalid-request` with *"Configure one to 100 approved Confluence space IDs as a comma-separated
   server setting."* and the hint. The row is still `pending`.

---

## Validation criterion *(required)*

All 17 tests pass three consecutive times at `--retries=0 --workers=1`, and once at `--workers=2` beside
`api-connections-health.spec.ts`, against `1.14.0.dev32`. Every assertion is on an exact code and message. Each
resolution test pairs its failure with a control: the same flow fails for the **connection** only because its inputs
are the well-formed ones the validation tests prove the bundle would otherwise refuse. No flow, row or throwaway user
is left after the run.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance from `1.14.0.dev23`, with the nine provider bundles installed (the nightly
  ships them) and #2498's fake sites (Jira, Confluence, Salesforce and ServiceNow resolve their site before anything
  else). No provider account, no key, no network egress.
- `src/lfx/src/lfx/integrations/errors.py` — `ConnectionUnresolvedError`, `InvalidRequestError` and their hints.
- `src/lfx/src/lfx/workflow/agui_translator.py` — the `RUN_ERROR` event's `code` and message.
- `src/bundles/github/src/lfx_github/client.py` — the repository validator.
- `src/bundles/gitlab/src/lfx_gitlab/client.py` — the positive-integer validator.
- `src/bundles/jira/src/lfx_jira/schema.py` — `issue_key`.
- `src/bundles/jira/src/lfx_jira/base.py` — `perform()` resolving the connection after the body validated.
- `src/bundles/confluence/src/lfx_confluence/schema.py` — `approved_space` and `LANGFLOW_CONFLUENCE_SPACE_IDS`.
- `src/bundles/salesforce/src/lfx_salesforce/schema.py` — the record-id validator.
- `src/bundles/servicenow/src/lfx_servicenow/base.py` — `authorize_connection()`, called before validation.
- `src/bundles/discord/src/lfx_discord/_client.py` — the Discord id validator.
- `src/bundles/telegram/src/lfx_telegram/_validation.py` — the Telegram id validator.
- `src/bundles/whatsapp/src/lfx_whatsapp/_components.py` — `recipient()` raising `ValueError`.
