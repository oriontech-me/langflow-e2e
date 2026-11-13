# Connections — connector components on the canvas and the connection picker

**File:** `tests/tests-automations/regression/core-functionality/integrations/connector-node-picker.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev26`; `1.14.0.dev14` before the `dev23` providers, `1.14.0.dev9` before Jira) and 1.13.x (`1.13.1rc0`)

Owning issue: #2297 (Dedicated Integrations, batch 2). It opens `QA-CHECKLIST.md` § 24.6, the
builder-facing half of the feature: placing a connector and binding it to a connection. The picker is
upstream surface **B5**, and the in-field widget **A3**.

---

## What this test validates *(required)*

A connector component never carries a credential. Its `connection` field stores a **handle**
(`google/work`), and the picker beside it is the only place a builder chooses one. Batch 1 covered the
connection and the Settings page. Nothing covered the canvas: whether every action the manifest promises
can be placed, whether the picker offers the right connections, and whether it says why one cannot run.

Measured on `1.13.0.dev47`:

### The palette

- **The provider groups live under the sidebar's *Bundles* tab**, not under *Components*. On the 1.13
  line there are three disclosures: `disclosure-bundles-google` (*Google*), `disclosure-bundles-microsoft 365`
  (*Microsoft 365*) and `disclosure-bundles-slack` (*Slack*).
- **From `1.14.0.dev7` there is a fourth provider, GitHub** (#2360). Upstream #15957 (merged into
  `release-1.14.0` on 2026-10-26) adds the `github` provider to the manifest and its group,
  `disclosure-bundles-github`. Measured on `1.14.0.dev7`: 10 components, 8 actions and 2 triggers
  (*GitHub: On Issue*, *GitHub: On Pull Request*), every capability with identity `service`. Their
  display names start with *"GitHub:"*, and the colon stays in the add button's id
  (`add-component-button-github:-get-repository`). A GitHub action lands on the canvas with the same
  unbound field as the other providers, reading *"Select a github connection"*.
- **From `1.14.0.dev10` there is a fifth provider, Jira** (#2377). Upstream #15952 (merged into
  `release-1.14.0` on 2026-10-29) adds the `jira` provider (manifest `display_name` *Jira Cloud*) and its
  group, `disclosure-bundles-jira` (*Jira*). `langflow==1.14.0.dev10` is the first build that requires
  `lfx-jira`; `1.14.0.dev9` neither requires it nor names the provider. Measured on `1.14.0.dev14`:
  8 components, 5 actions and 3 polling triggers (*Jira: On Issue Created*, *Jira: On Issue Updated*,
  *Jira: On Issue Status Changed*), every capability with identity `user_delegated`. Their display names
  start with *"Jira:"* (`add-component-button-jira:-search-issues`), and an action lands reading
  *"Select a jira connection"*.
- **From `1.14.0.dev23` there are seven more providers** (#2411). `langflow==1.14.0.dev23` is the
  first build that requires `lfx-confluence`, `lfx-discord`, `lfx-gitlab`, `lfx-salesforce`,
  `lfx-servicenow`, `lfx-telegram` and `lfx-whatsapp`; `1.14.0.dev22` requires none of them, and the
  1.13 line (`release-1.13.3`) none either. Measured on `1.14.0.dev26`:

| Provider (manifest `display_name`) | Group | Components | Actions | Triggers | Identity |
|---|---|---|---|---|---|
| `confluence` (*Confluence Cloud*) | `disclosure-bundles-confluence` (*Confluence*) | 6 | 4 | 2 | `user_delegated` |
| `discord` (*Discord*) | `disclosure-bundles-discord` (*Discord*) | 4 | 2 | 2 | `bot` |
| `gitlab` (*GitLab*) | `disclosure-bundles-gitlab` (*GitLab*) | 11 | 9 | 2 | `user_delegated` |
| `salesforce` (*Salesforce*) | `disclosure-bundles-salesforce` (*Salesforce*) | 4 | 3 | 1 | `user_delegated` |
| `servicenow` (*ServiceNow*) | `disclosure-bundles-servicenow` (*ServiceNow*) | 6 | 4 | 2 | `user_delegated` |
| `telegram` (*Telegram*) | `disclosure-bundles-telegram` (*Telegram*) | 5 | 3 | 2 | `bot` |
| `whatsapp` (*WhatsApp Business*) | `disclosure-bundles-whatsapp` (*WhatsApp*) | 4 | 3 | 1 | `service` |

  As with GitHub and Jira, every display name starts with the provider's name and a colon
  (*"Confluence: Search Pages"*, *"WhatsApp: Send Text"*), and an action lands reading
  *"Select a <provider id> connection"*. Telegram's 5 components back 7 capabilities.
- **A manifest action can be legacy, and the palette hides it** (#2411). *Telegram: Send Notification*
  (`TelegramNotifyComponent`, capability `telegram.bot.notify`) ships with `legacy: true` and
  `replacement: ["telegram.TelegramSendMessageComponent"]`. Its description reads *"Use Telegram Send
  Message with Silent Notification enabled for new flows."* The manifest still lists the capability,
  but the default palette shows no legacy component. So the action is in no group, and its sidebar
  search finds nothing. With *Show Legacy Components* on (`sidebar-options-trigger` →
  `sidebar-legacy-switch`), it is listed and lands like any other action. It is the only legacy
  manifest component on `1.14.0.dev26`. The test reads `legacy` from the catalog entry, so it follows
  the catalog: a component that stops being legacy is expected back in its group.
- **The group a provider lives in is not derivable from the manifest.** The group is named after the
  bundle, not after the provider's `display_name`: the manifest says *Google Workspace* and the group is
  *google*. Nor is it derivable from the catalog. Confluence's components live in the
  `confluence_integrations` category (`ext:confluence_integrations:…`, the bundle's own name), and its
  group is `disclosure-bundles-confluence`. #2411 asked whether the provider list could be derived
  instead of pinned. Confluence answers no: neither the manifest nor the catalog gives its group. So the
  test keeps a table of provider → group, each row with the first build that ships it,
  and **asserts that the manifest names exactly the providers that table expects on the served version**.
  A provider added upstream then fails that first step by name, instead of failing three steps later on
  a group nobody read (`toContain` on `undefined`, which is how #2360 surfaced).
- **On the 1.13 line the manifest names 28 distinct components behind 30 capabilities.** Two Slack trigger components
  each back two capabilities, one per transport. Of the 28, **20 are actions and 8 are triggers**.
  The catalog marks every trigger with `metadata.trigger_kind`, and the palette uses that marker.
  With GitHub (`1.14.0.dev7`) the totals are 38 components behind 40 capabilities: 28 actions and
  10 triggers. With Jira as well (`1.14.0.dev14`) they are 46 components behind 48 capabilities:
  33 actions and 13 triggers. With the seven `dev23` providers as well (`1.14.0.dev26`) they are
  86 components behind 90 capabilities: 61 actions and 25 triggers.
- **All 20 actions are in their provider's group**: 5 Google, 8 Microsoft 365, 7 Slack. Each one's add
  button is `add-component-button-<display name, lowercased, spaces as ->`.
- **No trigger is in the palette on the 1.13 line.** `ENABLE_TRIGGERS = false` is a compile-time flag,
  and `applyFeatureFlagFilters` drops every component carrying `trigger_kind`, including the ones that sit
  in a provider's group. A trigger node reaches a canvas only through a flow saved over the API or imported.
- **From `1.14.0.dev4` every provider trigger is in its provider's group** (#2336). Upstream #15940 (TRG-7,
  merged into `release-1.14.0` on 2026-10-23) turned `ENABLE_TRIGGERS` on, together with the trigger
  badge, the Enabled switch and a one-trigger-per-flow placement rule. The test reads the served version
  (`tests/helpers/other/served-version.ts`) and asserts the side that version is on: each trigger in its
  own provider's group and in no other, or no trigger in any group. It never decides by what the palette shows, which
  would let either regression pass.
- **The Google group also lists 4 components the manifest does not own** (BigQuery, Google Generative AI
  and its Embeddings, Google Serper API). The group is therefore asserted to *contain* the manifest's
  actions, never to *equal* them.
- **The executing identity shows before selection (A4)** in the Slack names only. Each Slack action's
  display name ends in *"(as user)"* when its capability is `user_delegated` and *"(as app)"* when it is
  `bot`. Google and Microsoft ship only `user_delegated` actions and carry no suffix.

### The picker (`connectionRefComponent`)

The field's testid is `connectionref_connection_ref_connection` on **every** connector node, so a test
always scopes it by its node (`rf__node-<id>`). The trigger shows the bound handle in
`value-connection-<field id>`, or else *"Select a google connection"*.

The popover lists `connection-option-<handle>` rows and a footer. The footer reads
*"Requires <scopes>"* (or *"No scope required"*) and holds `clear-connection-<id>` (shown only while a
handle is bound) and `refresh-connections-<id>`.

- **The list is the provider's, filtered by the server.** The picker requests
  `GET /api/v1/connections?provider=<the field's provider>`.
- **Every connection of that provider is listed, usable or not.** An unusable row carries a badge naming
  why (`buildConnectionOptions`), with usable rows sorted first. The reasons are checked in this order:

| Reason | Copy | When | Reachable here |
|---|---|---|---|
| `status` | the status label (*"Pending"*, *"Revoked"*, …) | status is not `ready` | yes: a credential-free row, and a revoked one |
| `userOwnedRequired` | *"Not owned by the flow owner"* | the field declares `ownership_mode="user"` and the row is an instance row or another user's | yes: a Google **trigger** (every trigger field declares it) |
| `instanceOwnedRequired` | *"Not an instance connection"* | the field declares `ownership_mode="instance"` | **no**: no shipped field declares it |
| `userRequired` | *"Runs as the instance, not a user"* | the field runs as a user and the row's identity is `bot` or `service` | yes: a Google row planted with identity `bot` |
| `instanceRequired` | *"Runs as a user, not the instance"* | the field runs as the instance and the row is `user_delegated` | **no**, see below |
| `scopes` | *"Missing <scope>"* | the row lacks a required scope | yes: a row with no scopes |

- **Several connections of one provider are all listed (B7)**, each under its own handle.
- **An empty list says how to get one**: *"No google connections yet. Create one in Settings, then
  refresh."* The list is cached. A connection created while the picker is open stays absent until
  **Refresh** re-fetches, measured as 0 options before and 1 after.
- **A failed list says so**: *"Could not load connections."* It does so only after react-query's retries
  are exhausted. Measured with the list answering `500`: 6 requests and **~31 s** before the copy
  replaces *"Loading connections…"*. The test therefore gives it 60 s.
- **The footer follows the node's inputs.** It lists the required scopes plus the conditional ones the
  node's current inputs switch on (`activeRequiredScopes`, the client half of langflow#15810). Measured on
  *SharePoint/OneDrive: List Items* (inputs `popover-anchor-input-site_id` and `…-drive_id`):

| Inputs set | Footer |
|---|---|
| neither | *"Requires Files.Read"* |
| `site_id` | *"Requires Files.Read, Sites.Read.All"* |
| `site_id` and `drive_id` | *"Requires Files.Read, Files.Read.All, Sites.Read.All"* |
| `drive_id` only (`site_id` cleared) | *"Requires Files.Read, Files.Read.All"* |

  A field with no required scope reads *"No scope required"*: *Slack: On Message*, a trigger whose
  manifest entry declares none.

### Binding

- **Picking a row binds its handle.** The trigger shows the handle, and the flow's autosave writes it
  into `data.nodes[].data.node.template.connection.value`, measured within about 4.5 s. It survives a
  reload.
- **Clear unbinds it.** The trigger returns to *"Select a google connection"*, and the saved value
  becomes `""`.
- **A handle can outlive its connection.** Delete the connection a flow names, reopen the flow, and
  the field keeps the handle and adds a *"not found"* badge (`isDangling`). The badge appears only once
  the list has loaded and has no match.

### Why some cases are mocked or seeded the way they are

- **The UI runs as the superuser** (auto-login), and **the superuser's list holds every user's
  connections** (`_list_visible_rows` has no owner clause for a superuser). So the picker shows rows that
  any spec in the run seeded. Every assertion keys on this file's own handles. No count is read, and
  "only the provider's rows" is asserted per row, as a prefix.
- **The empty state is unreachable on a shared instance** for the same reason: some spec always has a
  Google row. It is reached by fulfilling the picker's own `GET …?provider=google` with `[]`. The route is
  then removed, and the next step (Refresh) talks to the real server. That is the only mocked response in
  the file.
- **Rows are seeded through a throwaway owner** (#2295), whose rows the superuser's picker lists. The
  superuser's own write bucket is spent only on what needs the superuser: the instance row, and the
  superuser's own row that shows a trigger accepting its owner (2 rows, 4 writes per run).
- **Seed `google` only.** The manifest spec reserves `microsoft` as its subject and `slack` as its
  untouched control. The Slack and Microsoft nodes here bind nothing.
- **The canvas tests read the connection list once each** (#2411). Every connector node a test places
  sends its own `GET /api/v1/connections?provider=<id>`, and list reads share the superuser's
  `connections-read` bucket (60/minute per user). Measured on `1.14.0.dev26`, the twelve canvas tests
  spent **54** reads, one per node, where the five before #2411 spent 33. On PR #2443's first CI run, at
  `--workers=2`, that pushed the bucket into `429`, and test 19's picker was refused its list and
  flaked. Each canvas test now runs inside `holdConnectionList`: the first read is a real one, and the
  same `200` answers the rest. That is twelve reads instead of 54. The snapshot is what the server would
  answer: every node in one canvas test belongs to one provider, the test creates no connection, and
  the unbound field it asserts does not depend on the list. The picker tests (14–20) read the real list
  every time.

### Recorded, not asserted

- **`instanceRequired` is unreachable black-box.** Only the Slack *"(as app)"* fields run as the
  instance, so the reason needs a `user_delegated` **Slack** row. Planting any non-`xapp-` Slack token
  goes through Slack's `auth.test`, which refuses a fake token. A credential-free Slack row is `pending`,
  and `status` outranks every other reason.
- **`instanceOwnedRequired` is unreachable.** No shipped `ConnectionRefInput` declares
  `ownership_mode="instance"`.
- **The node-header connect button (A2)** is still Composio-only, and **the "managed by connection" state
  (A6)** is not shipped.
- **`ENABLE_INTEGRATIONS` is now a frontend flag, and it is `true`.** `CLAUDE.md` still says the gate is
  wired nowhere. With it off, `applyFeatureFlagFilters` would hide every connection-backed component.

---

## Tags *(required)*

`@components` `@integrations` `@stable`.

`@stable`: no provider key, no model, no network egress. Planted credentials never leave the instance,
and the picker only lists and binds.

---

## Step by step *(required)*

`beforeAll`, per worker: create a throwaway connections owner (#2295). Every flow is the superuser's (the
UI user), built through `POST /api/v1/flows/` and opened with `openFlowById`, and deleted after its test.
Every connection is deleted after its test too. Handles are unique per run.

**Test 1 — the palette.**
1. Read the manifest and the catalog. The manifest's provider ids equal the providers the test expects on
   the served version: `google`, `microsoft` and `slack`, plus `github` from `1.14.0.dev7`, `jira`
   from `1.14.0.dev10`, and `confluence`, `discord`, `gitlab`, `salesforce`, `servicenow`, `telegram`
   and `whatsapp` from `1.14.0.dev23`.
2. Split each provider's `component_ref`s by the catalog entry's `metadata.trigger_kind`: actions and
   triggers. Floors: at least one action per expected provider, and one trigger.
3. Open a blank flow, switch the sidebar to *Bundles*, and expand each expected provider's group one at a
   time. Collect each group's `add-component-button-*` ids.
4. Every action's add button is in its own provider's group, under the id derived from its catalog
   display name. An action whose catalog entry is `legacy: true` is the exception. Its add button is in
   no group, and each component its `replacement` names is in the legacy action's own provider group.
5. From `1.14.0.dev4`, every trigger's add button is in its own provider's group and in no other. Before
   it, no trigger's add button is in any group.
6. Every Slack action's display name ends in *"(as user)"* when its capability is `user_delegated`, and
   in *"(as app)"* when it is `bot`.

**Tests 2–13 — one per provider (Google, Microsoft 365, Slack, GitHub, Jira, Confluence, Discord,
GitLab, Salesforce, ServiceNow, Telegram, WhatsApp): every manifest action lands on the canvas.** A
provider's test skips, naming the version, on a build older than the one that ships it:
`1.14.0.dev7` for GitHub, `1.14.0.dev10` for Jira, `1.14.0.dev23` for the other seven. Test 1
already asserts that such a build has no such provider. On a blank flow, each of the provider's actions, read from the manifest at run time:
1. It is added from the sidebar search (`addComponentFromSidebar`). Before the first legacy action
   (catalog `legacy: true`), *Show Legacy Components* is switched on (`addLegacyComponents`), because
   the default palette hides it. The provider's connection list is served from one real read for the
   whole test (`holdConnectionList`, see *Why some cases are mocked or seeded*).
2. Its new node is found by diffing the node ids.
3. The node's connection field reads *"Select a <provider> connection"*, and no handle is bound.

**Test 14 — the picker lists the provider's connections and says why each cannot run.**
1. Plant five owner `google` rows: usable (`gmail.send` granted), no scopes, identity `bot`,
   credential-free (`pending`), and revoked.
2. Build a flow with *Gmail: Send Email* and *Slack: Post Message (as app)*, and open the Google picker.
3. The picker's request carried `provider=google`. Each planted row is listed under its handle:
   - the usable row with no badge;
   - the others with *"Missing gmail.send"*, *"Runs as the instance, not a user"*, *"Pending"* and
     *"Revoked"*.
4. Every listed handle starts with `google/`, and the footer reads *"Requires gmail.send"*.
5. The Slack picker requested `provider=slack`. It lists none of the planted handles, and every handle
   it lists starts with `slack/`.

**Test 15 — a trigger refuses a connection its flow's owner does not own.**
1. Plant three rows, each granting `gmail.readonly`:
   - the superuser's own row;
   - an instance row (the superuser's);
   - the throwaway owner's row.
2. Build a flow with *Gmail: On Message* over the API. On the 1.13 line triggers are not in the palette,
   so this is the only way one reaches a canvas there.
3. In the picker, the superuser's own row has no badge. The instance row and the other user's row both
   read *"Not owned by the flow owner"*.

**Test 16 — the requirement line follows the node's inputs.** A flow with *SharePoint/OneDrive: List
Items* and *Slack: On Message*. The four footers in the table above are read in that order, then the
Slack trigger's *"No scope required"*. No connection is planted.

**Test 17 — empty, then Refresh.**
1. The picker's `GET …?provider=google` is fulfilled with `[]`, and the picker reads *"No google
   connections yet. Create one in Settings, then refresh."* with no option.
2. The route is removed, and an owner row is planted. It is not listed yet: the list is cached.
3. **Refresh** lists it.

**Test 18 — a failed list.** The same request is fulfilled with `500`. The picker reads *"Could not load
connections."* within 60 s.

**Test 19 — binding.**
1. Pick a planted row on *Gmail: Send Email*. The field shows its handle, and the saved flow's
   `template.connection.value` becomes that handle (polled through `GET /api/v1/flows/{id}`).
2. Reload. The field still shows it.
3. **Clear**. The field reads *"Select a google connection"*, and the saved value becomes `""`.

**Test 20 — a handle that outlived its connection.**
1. Build a flow whose *Gmail: Send Email* is saved with a planted row's handle.
2. Delete the row, then open the flow.
3. The field shows the handle and the *"not found"* badge.

---

## Validation criterion *(required)*

All eleven tests pass three consecutive times at `--retries=0 --workers=1` against `1.13.0.dev47`, and
once at `--workers=2`. With the GitHub provider (#2360), all twelve pass three consecutive times at
`--retries=0 --workers=1` against `1.14.0.dev7`, and against `1.13.1rc0` the GitHub canvas test skips
while the other eleven pass (two runs). With the Jira provider (#2377), all thirteen pass three
consecutive times at `--retries=0 --workers=1` against `1.14.0.dev14` and once at `--workers=2`, and
against `1.14.0.dev9` the Jira canvas test skips while the other twelve pass. With the seven `dev23`
providers (#2411), the file holds twenty tests. Nineteen pass three consecutive times at
`--retries=0 --workers=1` against `1.14.0.dev26`, and once at `--workers=2`. Test 17 is quarantined
for #2413 and is not part of that count. The `since` gate on the seven new rows was not run against a
`dev22` build: it is the same `servedVersionAtLeast` gate the GitHub and Jira rows were validated
with. The following hold on every run:

- the manifest names exactly the providers expected on the served version;
- the palette groups contain every manifest action under its own provider, and each trigger under its
  own provider from `1.14.0.dev4` (no trigger before);
- every action lands with an unbound field for its provider;
- every unusable row carries its exact reason, and the usable one none;
- the picker requests its own provider and lists only `<provider>/` handles;
- Refresh, Clear, reload and the dangling badge each behave as stated, judged by the saved flow and not
  only by the DOM;
- no flow or connection this file created is left behind.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.13** or **1.14** instance at `PLAYWRIGHT_BASE_URL`, auto-login.
- `src/frontend/src/components/core/parameterRenderComponent/components/connectionRefComponent/index.tsx`
  — the picker, its testids, the empty, failed and dangling states, Clear and Refresh.
- `src/frontend/src/components/core/parameterRenderComponent/components/connectionRefComponent/helpers/connection-options.ts`
  — `buildConnectionOptions`, the unusable reasons and their order, and the identity mapping.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/helpers/apply-feature-flag-filters.ts`
  — the triggers hidden from the palette by `metadata.trigger_kind`.
- `src/frontend/src/customization/feature-flags.ts` — `ENABLE_TRIGGERS` and `ENABLE_INTEGRATIONS`.
- `src/frontend/src/locales/en.json` — the `connections.picker.*` copy.
- `src/backend/base/langflow/api/v1/integrations.py` — the manifest the palette is derived from.
- `src/bundles/github/extension.json` — the GitHub bundle and its `github` provider, from `1.14.0.dev7`.
- `src/bundles/jira/src/lfx_jira/extension.json` — the Jira bundle and its `jira` provider, from
  `1.14.0.dev10`.
- `src/bundles/confluence/src/lfx_confluence/extension.json`,
  `src/bundles/discord/src/lfx_discord/extension.json`, `src/bundles/gitlab/extension.json`,
  `src/bundles/salesforce/src/lfx_salesforce/extension.json`,
  `src/bundles/servicenow/src/lfx_servicenow/extension.json`,
  `src/bundles/telegram/src/lfx_telegram/extension.json` and
  `src/bundles/whatsapp/src/lfx_whatsapp/extension.json` — the seven bundles and their providers, from
  `1.14.0.dev23` (#2411).
- `src/backend/base/langflow/services/connection/service.py` — `_list_visible_rows`, and the superuser
  seeing every user's rows.
- `src/lfx/src/lfx/inputs/input_mixin.py` — `identity_kind` and `ownership_mode` on a connection field.
