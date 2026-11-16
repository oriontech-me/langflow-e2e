# Connectors on the canvas — dedicated integration actions in Tool Mode

**File:** `tests/tests-automations/regression/core-functionality/integrations/connector-tool-mode.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2452. How Tool Mode exposes a component's tools in general (the actions editor, names and
descriptions) is `docs/core-components/edit-tools.md`. Upstream: #16315 (first tag `v1.14.0.dev23`).

---

## What this test validates *(required)*

Since 1.14 every dedicated integration action can run as a tool for an Agent. The contract under test:

1. **Every action offers Tool Mode.** Each action component of each provider (no trigger) declares an
   output with `tool_mode: true` in `GET /api/v1/all`.
2. **The connection stays on the component.** In Tool Mode, the node keeps its connection picker, and no
   tool takes `connection` as an argument. The Agent picks the inputs; the flow's author picks the account.
3. **One tool per output.** An action with a single output becomes one tool. An action with a results
   output and a pagination output becomes two.

The tool schema is observable black-box in `tools_metadata`, which the canvas reads back from
`POST /api/v1/custom_component/update` when Tool Mode is turned on. Each entry carries the tool's `name`
and its `args`. An Agent actually calling the action needs a real account and is out of scope.

### Measured on `1.14.0.dev28`

- **59 action components across 12 providers** carry `connection.provider`. Every one of them has a
  `tool_mode` output:

  | Provider | Actions |
  |---|---|
  | Confluence | 4 |
  | Discord | 2 |
  | GitHub | 8 |
  | GitLab | 9 |
  | Google | 6 |
  | Jira | 5 |
  | Microsoft 365 | 8 |
  | Salesforce | 3 |
  | ServiceNow | 4 |
  | Slack | 7 |
  | Telegram | 3 |
  | WhatsApp | 3 |

  The issue named nine providers. Discord, Salesforce and WhatsApp ship the same.
- **Gmail: Send Email** in Tool Mode exposes one handle, `tool_send_email`, and the output becomes
  `component_as_tool` (`Tool`). Its `tools_metadata` holds one tool, `send_email`, with the args `to`, `cc`,
  `bcc`, `subject`, `body`, `body_is_html`, `thread_id`, `in_reply_to` and `references`, and no
  `connection`. The node still shows the connection picker.
- **Slack: Search Messages** (`matches` and `pagination` outputs) becomes two tools, `build_matches` and
  `build_pagination`, each with `query`, `count`, `sort`, `sort_dir` and `cursor`, and two handles. Neither
  takes `connection`.
- Other actions with a pagination output: Slack *Read Thread* and *List Channel Members*, Microsoft 365
  (`next_link`), and Google Drive and Calendar *List* (`listing`). The spec uses Slack Search as the
  representative.

### What is not covered here, and why

- **An Agent calling one of these tools.** It needs a connection to a real account.
- **Every action's tool schema on the canvas.** The catalog test covers that every action offers Tool
  Mode; two representative actions cover the schema rules.

---

## Tags *(required)*

`@stable` `@components` `@integrations`

`@stable`: no provider key, no model, no network, no connection needed: Tool Mode is a canvas-side
conversion. Every flow is created per test and deleted by id. `@stable` enters in this PR. The file skips
below `1.14.0.dev26`.

---

## Step by step *(required)*

Tests 2–3 build their flow with `createCatalogFlow` and open it with `openFlowById`. A node is put in Tool
Mode by clicking its title (`generic-node-title-arrangement`) and then `tool-mode-button`. The test reads
the `POST /api/v1/custom_component/update` response that follows.

### 1. Every dedicated integration action offers Tool Mode

1. Read `GET /api/v1/all`. Select every component whose `connection` field names a provider and which is
   not a trigger (`metadata.trigger_kind` unset).
2. Expect at least one action for each of the twelve providers above, and every selected action to have an
   output with `tool_mode: true`.

### 2. An action in Tool Mode is one tool whose arguments exclude the connection

1. Open a flow holding *Gmail: Send Email*. Turn on Tool Mode.
2. Expect the handle `tool_send_email`. In the update response:
   - `tools_metadata` holds exactly one tool, `send_email`;
   - its `args` include `to`, `subject` and `body` and not `connection`;
   - the outputs are `component_as_tool`.
3. Expect the node's connection picker still on the node.

### 3. An action with a pagination output becomes two tools

1. Open a flow holding *Slack: Search Messages* (`ext:slack:SlackSearchComponent@official`). Turn on Tool
   Mode.
2. Expect the handles `tool_build_matches` and `tool_build_pagination`. Expect `tools_metadata` to hold
   exactly those two tools, each with a `query` argument and no `connection`.
3. Expect the node's connection picker still on the node.

---

## Validation criterion *(required)*

Tests 1–3 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev28`, and once at
`--workers=2` with the other connection UI specs, with:

- the tool schema asserted from the server's `tools_metadata`, not from the node's labels alone;
- zero `🚨 Backend Error`;
- no flow left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev26` or later) at `PLAYWRIGHT_BASE_URL`, auto-login, with
  the integration bundles the nightly ships.
- `src/lfx/src/lfx/io/schema.py` — how a component's inputs become a tool schema.
- `src/lfx/src/lfx/base/tools/component_tool.py` — `tools_metadata`.
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/custom_component/update`.
- `src/bundles/google/src/lfx_google/components/google/gmail_send.py` and
  `src/bundles/slack/src/lfx_slack/components/slack/slack_search.py` — the two representative actions.
- `tests/helpers/flows/build-catalog-flow.ts`, `tests/helpers/flows/open-flow-by-id.ts`,
  `tests/helpers/flows/unmount-editor-for-cleanup.ts`, `tests/helpers/flows/delete-flow.ts` and
  `tests/helpers/other/served-version.ts`.
