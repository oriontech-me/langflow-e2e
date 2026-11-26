# Settings › Triggers — the caller's triggers, a row menu drawn from the server, and the operator view

**File:** `tests/tests-automations/regression/core-functionality/integrations/triggers-settings-page.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2448 (the 1.14 triggers and connectors batch). The API this page renders is
`docs/api/triggers/api-triggers-operator.md`, from the same issue; this file asserts what the page does
with it. The trigger node's own controls and events drawer are #2449's.

---

## What this test validates *(required)*

*Settings › Triggers* (upstream #15940, QA fixes #16064 and #16132) lists every trigger the user owns and,
for a superuser, every user's triggers with a bulk pause and resume. The page draws each row's controls
from the server's `allowed_actions` / `blocked_actions` and never from the state. The contract under test:

1. **Reaching it and finding a trigger.** `sidebar-nav-Triggers` opens `/settings/triggers`, which shows
   `triggers-table-mine` with one `trigger-row-{id}` per trigger, a search box, a state filter, the
   *"Needs attention ({{count}})"* toggle (`aria-pressed`) and the empty state `triggers-empty`.
2. **A row menu holds exactly what the server returned.** An action the server does not list is absent.
   A blocked action stays in the menu and focusable, with `aria-disabled="true"` and an
   `aria-describedby` reason, and selecting it does nothing. The test button is blocked the same way.
   Delete asks for confirmation, and only the confirm deletes.
3. **The operator view.** For a superuser, the *Scope* combobox switches to *All triggers*: an Owner
   column, a provider filter that lists only the providers present, bulk buttons that stay `disabled`
   until a provider is chosen, a bulk dialog whose counts come from a server dry run (*"Pause {{count}}
   active {{provider}} triggers?"*), and per-row *Pause as admin* / *Resume admin pause*.

### Measured on `1.14.0.dev28`

- **Reaching it.** The settings sidebar renders `sidebar-nav-Triggers` between *Connections* and *Global
  Variables*; the page's title is `Triggers | Langflow`. Rows are `trigger-row-<trigger id>`, the menu
  button `trigger-menu-<id>` (accessible name *"Actions for <trigger name>"*), the test button
  `trigger-test-<id>` (*"Send a test event to <name>"*). The first cell shows the flow's name over the
  trigger's name.
- **Toolbar.** `triggers-search` (matches flow name, trigger name, kind, provider and, in the operator
  view, the owner), `triggers-state-filter`, `triggers-scope-filter` (superuser only, `role=combobox`,
  name *Scope*, options *My triggers* / *All triggers*), and `triggers-attention-toggle`, rendered only
  while at least one listed trigger needs attention (`pending` + `config_invalid`, `needs_reconnect`,
  `error`, `dead`, `expired`). Its text is *"Needs attention (N)"* over **all** listed triggers, and on
  a shared instance N counts other specs' triggers too — the spec never asserts N.
- **Empty state.** With rows listed and a search matching none, `triggers-empty` reads *"No triggers
  match these filters."*. *"No triggers yet. …"* needs a user with no trigger at all, which the shared
  superuser never is.
- **Row menu.** Items are `trigger-action-<action>`: `view_events` and `open_flow` always, then the
  server's `pause` / `resume` / `reconnect` / `rotate_secret` (allowed first, then blocked), then
  `delete`; `test` has its own button and `replay` lives in the events drawer. On a dead
  `inbound_webhook`: no `pause`; `resume` carries `aria-disabled="true"` and an `aria-describedby`
  pointing at *"This trigger stopped permanently. Delete it instead."*. On an active `e2e.event`: no
  `resume` and no `rotate_secret`. On a paused row the test button has `aria-disabled="true"` (not
  `disabled`) described by *"Resume the trigger first."*.
- **Delete.** `trigger-action-delete` opens a `role=dialog` *"This will permanently delete the trigger
  <name>."* with `btn_cancel_delete_confirmation_modal` and `btn_delete_delete_confirmation_modal`.
- **Operator view.** *All triggers* renders `triggers-table-all` with the headers *Trigger, Owner,
  Source, State, Last event, Actions* (no *Connection*). `triggers-provider-filter` lists *All
  providers* then the sorted providers of the listed rows. `triggers-bulk-pause` / `triggers-bulk-resume`
  are `disabled` with text *Pause all* / *Resume all* until a provider is chosen, then enabled as *Pause
  all <provider>* / *Resume all <provider>*. Langflow's `Button` title-cases a string child unless
  `ignoreTitleCase` is set, so the copy *"Pause all {{provider}}"* (the served `en` bundle) renders
  *"Pause All E2eop…"*: the spec matches every `Button` label whole but case-blind. The bulk dialog
  (`triggers-bulk-dialog`) fetches a dry run on open; its title (a `DialogTitle`, not title-cased), the
  three counts (*Will be paused*, *Already paused or not running, unchanged*, *Owners affected*) and
  `triggers-bulk-confirm` (*"Pause N triggers"*) follow it. The row menu is `trigger-operator-menu-<id>`
  with two items, *Pause as admin* and *Resume admin pause*, which call the bulk routes with that one id.
  The operator list pages through every trigger on the instance before it renders, so its first load
  gets 15 s rather than the default 5 s.
- **Escape is layered.** A blocked menu item sits inside a tooltip that opens when the item takes focus,
  and `Escape` dismisses the topmost layer first — the tooltip, then the menu. Closing the menu therefore
  repeats `Escape` until it is hidden. Measured: after `Enter` on the focused blocked *Resume*, one
  `Escape` left the menu open.

### Seeding the operator view

The bulk buttons act on a **provider**, and a bulk by provider is instance-wide across users — a shared
provider would pause other specs' triggers. The create route takes any provider name under
`^[a-z][a-z0-9_-]*$` and any state (measured in the API spec doc), so the spec seeds its rows through
`POST /api/v1/triggers` under a provider unique to the run (`e2eop<run>`). The provider filter then lists
it, the dry run counts only this run's rows, and the confirm can change nothing else. The issue's
alternative — a Gmail trigger on a planted Google connection driven into `error` offline — is not
needed.

The rows the operator acts on belong to a throwaway second user (`createConnectionsOwner`), so the Owner
column has someone else to name. The page itself runs as the lane's superuser (auto-login), which is the
only user the UI can be under on this lane.

### Measured, not asserted

- **The Source cell of a provider with no catalog entry shows the raw key** `triggers.provider.<id>`
  (`TriggerSourceCell` passes no default). Reachable only through the synthetic provider; every real
  provider has a key.
- **Before `1.14.0.dev32`, `config_invalid` offered *Resume*, and the route refused it** (`409
  invalid_cron`) — LE-3454, recorded in the API spec doc. Upstream #16450 (first in `1.14.0.dev32`)
  makes the server list `resume` as blocked by `config_invalid` instead; the API spec asserts that
  (`api-triggers-operator`, test 3, step 6, #2525). The page renders the server's action list
  (upstream #15786's server-driven actions), so it should no longer offer *Resume* there, but that
  was not re-checked in the UI.

### What is not covered here, and why

- The events drawer, the signing-secret dialog and *Open flow* — the node's surfaces, #2449.
- *Reconnect* and *Allow background runs* — need a provider trigger in `needs_reconnect` on a real
  connection, the connections issues' territory.
- *"No triggers yet. …"* — the shared superuser always has a trigger (above).

---

## Tags *(required)*

`@integrations` `@settings` `@stable`

`@stable`: no provider key, no model, no network egress; every row is created through the API for this
run and found by a per-run search term, and the bulk acts only on a provider unique to the run. `@stable`
enters in this PR. The page ships in `1.14.0.dev10` (upstream #15940) and was reworked by #16064
(`dev14`) and #16132 (`dev16`); on an older build each test skips with that reason through
`servedVersionAtLeast`.

---

## Step by step *(required)*

Three tests on the `page` fixture. Every name carries a per-run token `T`. Superuser flows are deleted by
id in the teardown; the owner (one per worker) is deleted in `afterAll`, taking its flows and triggers.

### 1. Reaches Settings › Triggers and lists, searches and filters the caller's triggers

1. Seed (superuser, one flow `E2E triggers page T`): an active, a paused and an `error`
   `inbound_webhook`.
2. Open `/`, then `navigateSettingsPages(page, "Settings", "Triggers")` → URL `/settings/triggers`, title
   `Triggers | Langflow`, `triggers-table-mine` visible.
3. Search `T` → exactly the three seeded rows, each showing the flow's name and its own name.
4. State filter *Paused* → only the paused row; back to *All*.
5. `triggers-attention-toggle` is `aria-pressed="false"`; click → `"true"`, and only the `error` row is
   left; click → `"false"`, all three back.
6. Search `T-nomatch` → `triggers-empty` *"No triggers match these filters."*.

### 2. Renders each row's menu from the server's actions, blocks with a reason, and deletes only after confirming

1. Seed (superuser, one flow): an active `e2e.event`, a dead `inbound_webhook`, a paused `inbound_webhook`.
   Read each through `GET /triggers/{id}`.
2. Search `T`. For each row, open `trigger-menu-<id>` → the `trigger-action-*` items equal
   `view_events`, `open_flow`, the server's menu actions in allowed-then-blocked order, then `delete` — and
   the hard expectations hold: the active `e2e.event` has no `resume` and no `rotate_secret`, the dead row
   has no `pause`.
3. Dead row: `trigger-action-resume` has `aria-disabled="true"` and its `aria-describedby` element reads
   *"This trigger stopped permanently. Delete it instead."*; walking the menu with `ArrowDown` focuses it;
   `Enter` on it keeps the menu open and sends no `POST …/enable`; the row still reads `dead`.
4. Paused row: `trigger-test-<id>` has `aria-disabled="true"`, is not `disabled`, and is described by
   *"Resume the trigger first."*.
5. Paused row → *Delete* → the dialog names the trigger → *Cancel* → the row stays and `GET` answers
   `200`. *Delete* again → confirm → the row is gone and `GET` answers `404`.

### 3. Gives a superuser an operator view across users, with a provider bulk previewed by a dry run and per-row admin actions

1. Seed (owner, one flow, provider `P` unique to the run): two active and one paused `inbound_webhook`.
   Create and delete one more trigger under a provider `P_gone`, so it is on no row.
2. Open the page; `triggers-scope-filter` reads *My triggers*; choose *All triggers* →
   `triggers-table-all` with an *Owner* header and no *Connection* header.
3. Bulk buttons `disabled`, `textContent` *Pause all* / *Resume all*.
4. Provider filter: lists `P`, does not list `P_gone`; choose `P` → exactly the three owner rows, each
   Owner cell = the owner's username; bulk buttons enabled, `textContent` *Pause all P* / *Resume all P*.
5. *Pause all P* → dialog title *"Pause 2 active P triggers?"*, counts 2 / 1 / 1, confirm *"Pause 2
   triggers"* → click → *"Paused 2 triggers"*; `GET … scope=all&provider=P` → both active rows `paused`,
   `paused_by_admin`; the paused one unchanged.
6. Row menu of one admin-paused row → exactly *Pause as admin* and *Resume admin pause* → *Resume admin
   pause* → *"Resumed <name>"*; that row reads `active`, unmarked; the other stays `paused_by_admin`.
7. *Resume admin pause* on the owner's own paused row → *"<name> wasn't paused by an admin, so nothing
   changed."*; it stays `paused`, `reason: "paused"`.
8. *Resume all P* → dialog *"Resume 1 P trigger paused by an admin?"*, confirm → *"Resumed 1 trigger"*;
   the remaining admin-paused row reads `active`.

---

## Validation criterion *(required)*

Tests 1–3 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev28`, and once at
`--workers=2` with the API spec, with:

- every row found by its trigger id, never by position or by a total count;
- every menu compared item by item with the server's answer read in the same test;
- every effect of a UI action re-read through the API — the toast is asserted too, never alone;
- no `🚨 Backend Error` in the run's log.

After the run the instance holds no flow, user or trigger left by this file.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev16` or later) at `PLAYWRIGHT_BASE_URL`, auto-login.
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/index.tsx`
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/components/MyTriggersPanel.tsx`
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/components/OperatorTriggersPanel.tsx`
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/components/TriggersTable.tsx`
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/components/TriggersToolbar.tsx`
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/components/BulkTriggersDialog.tsx`
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/components/OperatorRowMenu.tsx`
- `src/frontend/src/pages/SettingsPage/pages/TriggersPage/components/TriggersListState.tsx`
- `src/frontend/src/components/core/triggers/TriggerActionMenu.tsx`
- `src/frontend/src/components/core/triggers/BlockableButton.tsx`
- `src/frontend/src/components/core/triggers/helpers/filter-triggers.ts`
- `src/frontend/src/components/core/triggers/helpers/trigger-presentation.ts`
- `src/frontend/src/controllers/API/queries/triggers/use-triggers.ts`
- `src/frontend/src/locales/en.json` — the `triggers.*` copy asserted above.
- `tests/helpers/triggers/trigger-api.ts`, `tests/helpers/integrations/connections-owner.ts`,
  `tests/helpers/ui/go-to-settings.ts`, `tests/helpers/flows/delete-flow.ts` and
  `tests/helpers/other/served-version.ts`.
