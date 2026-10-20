# Connections — connector components on the canvas and the connection picker

**File:** `tests/tests-automations/regression/core-functionality/integrations/connector-node-picker.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev47`)

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

- **The provider groups live under the sidebar's *Bundles* tab**, not under *Components*. There are three
  disclosures: `disclosure-bundles-google` (*Google*), `disclosure-bundles-microsoft 365`
  (*Microsoft 365*) and `disclosure-bundles-slack` (*Slack*).
- **The manifest names 28 distinct components behind 30 capabilities.** Two Slack trigger components
  each back two capabilities, one per transport. Of the 28, **20 are actions and 8 are triggers**.
  The catalog marks every trigger with `metadata.trigger_kind`, and the palette uses that marker.
- **All 20 actions are in their provider's group**: 5 Google, 8 Microsoft 365, 7 Slack. Each one's add
  button is `add-component-button-<display name, lowercased, spaces as ->`.
- **No trigger is in the palette.** `ENABLE_TRIGGERS = false` is a compile-time flag, and
  `applyFeatureFlagFilters` drops every component carrying `trigger_kind`, including the ones that sit in
  a provider's group. A trigger node reaches a canvas only through a flow saved over the API or imported.
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
1. Read the manifest and the catalog. Split each provider's `component_ref`s by the catalog entry's
   `metadata.trigger_kind`: actions and triggers. Floors: at least one action and one trigger.
2. Open a blank flow, switch the sidebar to *Bundles*, and expand *Google*, *Microsoft 365* and *Slack*
   one at a time. Collect each group's `add-component-button-*` ids.
3. Every action's add button is in its own provider's group, under the id derived from its catalog
   display name.
4. No trigger's add button is in any group.
5. Every Slack action's display name ends in *"(as user)"* when its capability is `user_delegated`, and
   in *"(as app)"* when it is `bot`.

**Tests 2–4 — one per provider (Google, Microsoft 365, Slack): every manifest action lands on the
canvas.** On a blank flow, each of the provider's actions, read from the manifest at run time:
1. It is added from the sidebar search (`addComponentFromSidebar`).
2. Its new node is found by diffing the node ids.
3. The node's connection field reads *"Select a <provider> connection"*, and no handle is bound.

**Test 5 — the picker lists the provider's connections and says why each cannot run.**
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

**Test 6 — a trigger refuses a connection its flow's owner does not own.**
1. Plant three rows, each granting `gmail.readonly`:
   - the superuser's own row;
   - an instance row (the superuser's);
   - the throwaway owner's row.
2. Build a flow with *Gmail: On Message*. Triggers are not in the palette, so this is the only way one
   reaches a canvas.
3. In the picker, the superuser's own row has no badge. The instance row and the other user's row both
   read *"Not owned by the flow owner"*.

**Test 7 — the requirement line follows the node's inputs.** A flow with *SharePoint/OneDrive: List
Items* and *Slack: On Message*. The four footers in the table above are read in that order, then the
Slack trigger's *"No scope required"*. No connection is planted.

**Test 8 — empty, then Refresh.**
1. The picker's `GET …?provider=google` is fulfilled with `[]`, and the picker reads *"No google
   connections yet. Create one in Settings, then refresh."* with no option.
2. The route is removed, and an owner row is planted. It is not listed yet: the list is cached.
3. **Refresh** lists it.

**Test 9 — a failed list.** The same request is fulfilled with `500`. The picker reads *"Could not load
connections."* within 60 s.

**Test 10 — binding.**
1. Pick a planted row on *Gmail: Send Email*. The field shows its handle, and the saved flow's
   `template.connection.value` becomes that handle (polled through `GET /api/v1/flows/{id}`).
2. Reload. The field still shows it.
3. **Clear**. The field reads *"Select a google connection"*, and the saved value becomes `""`.

**Test 11 — a handle that outlived its connection.**
1. Build a flow whose *Gmail: Send Email* is saved with a planted row's handle.
2. Delete the row, then open the flow.
3. The field shows the handle and the *"not found"* badge.

---

## Validation criterion *(required)*

All eleven tests pass three consecutive times at `--retries=0 --workers=1` against `1.13.0.dev47`, and
once at `--workers=2`. The following hold on every run:

- the palette groups contain every manifest action under its own provider, and no trigger;
- every action lands with an unbound field for its provider;
- every unusable row carries its exact reason, and the usable one none;
- the picker requests its own provider and lists only `<provider>/` handles;
- Refresh, Clear, reload and the dangling badge each behave as stated, judged by the saved flow and not
  only by the DOM;
- no flow or connection this file created is left behind.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login.
- `src/frontend/src/components/core/parameterRenderComponent/components/connectionRefComponent/index.tsx`
  — the picker, its testids, the empty, failed and dangling states, Clear and Refresh.
- `src/frontend/src/components/core/parameterRenderComponent/components/connectionRefComponent/helpers/connection-options.ts`
  — `buildConnectionOptions`, the unusable reasons and their order, and the identity mapping.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/helpers/apply-feature-flag-filters.ts`
  — the triggers hidden from the palette by `metadata.trigger_kind`.
- `src/frontend/src/customization/feature-flags.ts` — `ENABLE_TRIGGERS` and `ENABLE_INTEGRATIONS`.
- `src/frontend/src/locales/en.json` — the `connections.picker.*` copy.
- `src/backend/base/langflow/api/v1/integrations.py` — the manifest the palette is derived from.
- `src/backend/base/langflow/services/connection/service.py` — `_list_visible_rows`, and the superuser
  seeing every user's rows.
- `src/lfx/src/lfx/inputs/input_mixin.py` — `identity_kind` and `ownership_mode` on a connection field.
