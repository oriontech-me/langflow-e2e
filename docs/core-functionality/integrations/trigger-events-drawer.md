# Triggers on the canvas — the events drawer: paging, server filters, replay and the payload tree

**File:** `tests/tests-automations/regression/core-functionality/integrations/trigger-events-drawer.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2449. The node's badge, *Enabled*, consent and secret controls are the sibling file,
`docs/core-functionality/integrations/trigger-node-controls.md`. The API contract of `test`, `replay`
and the events listing is `docs/api/triggers/api-triggers-webhook-ingress.md`. This file asserts what the
drawer does with them. The payload tree is upstream #16332 (first tag `v1.14.0.dev23`).

---

## What this test validates *(required)*

*View events* in the badge popover opens a drawer over the trigger's events. The contract under test:

1. **Pages of 50, newest first.** The drawer lists 50 events and offers *Load older*. That button
   requests the next page by offset (`GET …/events?limit=51&offset=50`) and adds the remaining events to
   the list, then disappears.
2. **Filters are the server's.** Each pill, *Needs attention*, *Skipped*, *Replays* or *Tests*, sends
   `?filter=failed|skipped|replays|tests` and shows only what came back. An empty result reads *"No events
   match this filter."*. Test events carry a *Test* tag.
3. **Replay is a new event with lineage.** Replaying an event from its detail confirms through *"Replay
   this event?"*, which sends `POST …/replay` with that `event_id`. Then:
   - the toast reads *"Replay queued as a new event"*;
   - the filter goes back to *All*, so the new event is in view even when the replay started from a
     filter;
   - the **new** event is selected, tagged *Replay*;
   - its lineage reads *"Replay of"* the original;
   - *Replays* then lists exactly that event.

   While the trigger is paused, *Replay* is blocked with *"Resume the trigger first."*.
4. **Open flow follows the run.** An event whose flow ran (`job_id` set) offers *Open flow*. Without a
   run it is blocked, and the reason says which case it is:
   - an event still queued: *"No run has started for this event yet."*;
   - an event that ended without a run: *"This event ended before a run was started, so there is no run
     to open."*.
5. **The payload tree opens only its root and labels every type.** For a signed delivery with a known,
   nested body:
   - only *Payload* is expanded;
   - fields show their type: Text, Number, Boolean, Null, Array, Object;
   - objects count *"N fields"* and arrays *"N items"*;
   - a list longer than 50 ends with *"Show N more"*, which reveals the rest.

### Measured on `1.14.0.dev28`

- **The drawer pages by offset, not cursor.** The list asks for `limit=51` (one extra row to know a next
  page exists) and *Load older* adds `offset=50`, matching `GET /api/v1/triggers/{id}/events`, which takes
  `limit`/`offset`/`filter` and nothing else.
- **Seeding 50+ events cheaply.** The issue suggested over 50 signed deliveries. Each one runs the flow,
  and on a single backend the dispatcher works one event per trigger per tick (~5 s). 52 deliveries would
  cost minutes of runs for a test about a list. The spec seeds the page with `POST …/test` on a
  **paused** trigger instead:
  - each answers `202` immediately and appends a row tagged *Test*;
  - none runs the flow, since a paused trigger terminalizes them as `failed` (`trigger_paused`) one tick
    at a time.

  The paging assertions do not depend on those states. One real signed delivery is sent first, so the
  list also holds an ingress event that ran.
- **The *Needs attention* count is not fixed** while those tests drain, so the spec asserts that every
  row it shows is `failed` or `dead`, never a count. It waits until the API lists at least one, so the
  pill is never asserted on an empty result.
- **"Newest first" is newest to the second.** The listing orders by `created_at` desc, then `id` desc,
  and `created_at` has one-second resolution. Events sent within the same second therefore list in id
  order, not in the order they were sent (measured with 8 test events over two seconds). The spec
  compares the drawer's order with the API's, never with the order it sent.
- **The test events drain oldest first.** So the events of the last second stay queued for minutes, and
  the drawer selects the first of them by default. The spec uses it for the queued *Open flow* reason,
  with its state read back from the API as `pending` or `claimed`.
- **A replay is queued, not finished.** The new event reads *"Processing: Queued"* and its lineage
  *"Replay of {original's time}"*. The spec asserts the lineage and the selection, not the replay's run.
- **The delivery's stored payload is `{provider: "webhook", delivery: <body>}`.** So the tree's root holds
  2 fields, and the body sits one level down, collapsed. Strings render JSON-quoted (`"webhook"`). A
  53-item array shows `[0]`…`[49]` and *"Show 3 more"*.

### What is not covered here, and why

- The run dialog's trace (*Open flow* → `trigger-run-dialog` → trace view). Tracing is off on the
  scheduled lanes, so only the button's enabled and blocked states are asserted.
- *Skipped* events. Only a provider source that filters senders produces them (`sender_not_allowed`),
  which an inbound webhook does not, so the pill is asserted on its empty result.
- Retried events' *"N of M attempts failed"* line, which needs a run that fails and is retried.

---

## Tags *(required)*

`@components` `@integrations` `@stable`

`@stable`: no provider key, no model call and no external network. Deliveries go to the instance's own
ingress, and every flow is created per test and deleted by id. `@stable` enters in this PR. The file skips
below `1.14.0.dev26` (`servedVersionAtLeast`), like its sibling.

---

## Step by step *(required)*

Each test builds an *Inbound Webhook → Chat Output* flow with `createCatalogFlow`. It mints the secret
and sends deliveries through the API (`tests/helpers/triggers/sign-webhook.ts`), and waits for the
delivery's event to settle `completed` before opening the flow. The drawer is opened from the node:
badge → *View events*. The teardown leaves the editor, then deletes the flow by id.

### 1. The events drawer pages 50 at a time and filters on the server

1. Enable the trigger, send one signed delivery and wait until its event is `completed`. Pause the
   trigger, then send 52 `POST …/test` events (each `202`).
2. Wait until the API lists at least one `failed` event. Open the drawer. Expect:
   - the title *"Events · {flow name}"*;
   - 50 rows;
   - the first row being the API's first event (`limit=1`), selected, read back as `pending` or
     `claimed`, with *Open flow* blocked by *"No run has started for this event yet."*.
3. Click *Load older* once it is not busy. Expect a request carrying `offset=50`, 53 rows, and no *Load
   older* button.
4. Click *Tests*. Expect:
   - a request carrying `filter=tests`;
   - the pill `aria-pressed="true"`;
   - 50 rows, every one tagged *Test*;
   - the delivery's row absent.
5. Click *Needs attention*. Expect a request carrying `filter=failed`, and every row's state badge
   `failed` or `dead`.
6. Click *Replays*, then *Skipped*. For each, expect its request and *"No events match this filter."*.
7. Click *All*. Expect 53 rows again.

### 2. Replaying an event confirms, queues a new event, selects it and shows its lineage

1. Enable the trigger, send one signed delivery and wait for it to complete. Pause the trigger, send one
   test event, and wait until the API reads it `failed` (`trigger_paused`).
2. Open the drawer and select the delivery's row. Expect:
   - the row `aria-current="true"`;
   - *Open flow* (`trigger-event-open-run`) not blocked;
   - *Replay* blocked with *"Resume the trigger first."*.
3. Select the test event's row. Expect *Open flow* blocked with *"This event ended before a run was
   started, so there is no run to open."*.
4. Enable the trigger through the API and wait until *Replay* is no longer blocked.
5. Click *Tests*. The test event is the only row and is selected. Click *Replay*. Expect
   `trigger-replay-dialog` (*"Replay this event?"*). Confirm with `trigger-replay-confirm`. Expect
   `POST …/replay` with the test event's `event_id` → `202`, and the new event's `replay_of_event_id`
   equal to that id. Then expect:
   - the toast *"Replay queued as a new event"*;
   - *All* pressed, the filter having left *Tests*;
   - the new event's row selected and tagged *Replay*;
   - `trigger-event-lineage` reading *"Replay of"*.
6. Click *Replays*. Expect exactly the new event.

### 3. The payload tree opens only its root and labels every type

1. Send a signed delivery with body:

   ```json
   {
     "text": "<sentinel>",
     "order": { "id": 7, "paid": false, "note": null, "tags": ["a", "b"], "lines": [0, 1, …, 52] }
   }
   ```

   Wait for its event to complete.
2. Open the drawer and select the delivery. In `trigger-event-payload`, expect:
   - *Payload* · *Object* · *"2 fields"*, open;
   - `provider` · *Text* · `"webhook"`;
   - `delivery` · *Object* · *"2 fields"*, closed;
   - none of the body's keys rendered yet.
3. Open `delivery`, then `order`. Expect:
   - `text` · *Text* · the quoted sentinel;
   - `order` · *Object* · *"5 fields"*;
   - `id` · *Number* · `7`;
   - `paid` · *Boolean* · `false`;
   - `note` · *Null* · `null`;
   - `tags` · *Array* · *"2 items"*;
   - `lines` · *Array* · *"53 items"*.
4. Open `lines`. Expect `[0]`…`[49]`, no `[50]`, and *"Show 3 more"*. Click it. Expect `[50]`, `[51]`,
   `[52]` and no *Show … more*.

---

## Validation criterion *(required)*

Tests 1–3 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev28`, and once at
`--workers=2` together with the node-controls file, with:

- every filter asserted by the request it sends and by the rows that came back, never by a count the
  dispatcher can change mid-test;
- the replay asserted by its server response (`202`, `replay_of_event_id`) as well as by the selection
  and the lineage;
- the payload tree asserted against a body the test chose;
- zero `🚨 Backend Error`;
- no flow or trigger row left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev26` or later) at `PLAYWRIGHT_BASE_URL`, auto-login,
  with trigger dispatch running (the default).
- `src/frontend/src/components/core/triggers/eventsDrawer/index.tsx` — the drawer, filters, *Load
  older*, replay wiring.
- `src/frontend/src/components/core/triggers/eventsDrawer/TriggerEventList.tsx` — rows and their tags.
- `src/frontend/src/components/core/triggers/eventsDrawer/TriggerEventDetail.tsx` — detail, *Open flow*,
  *Replay*, lineage.
- `src/frontend/src/components/core/triggers/eventsDrawer/ReplayConfirmDialog.tsx` — *"Replay this
  event?"*.
- `src/frontend/src/components/core/triggers/eventsDrawer/TriggerPayloadTree.tsx` — the payload tree.
- `src/frontend/src/components/core/triggers/eventsDrawer/event-helpers.ts` — which reason blocks *Open
  flow*, and the event's origin tag.
- `src/frontend/src/controllers/API/queries/triggers/use-triggers.ts` — `limit + 1` paging by offset, one
  cached list per filter.
- `src/frontend/src/components/core/triggers/TriggerNodeBadge.tsx` — *View events*.
- `src/frontend/src/locales/en.json` — every string asserted here.
- `src/backend/base/langflow/api/v1/triggers.py` — events listing, `test`, `replay`.
- `src/backend/base/langflow/services/triggers/ledger.py` — filters, replay lineage, test markers.
- `src/backend/base/langflow/services/triggers/dispatcher.py` — `trigger_paused` terminalization.
- `src/backend/base/langflow/api/v1/trigger_ingress.py` — the signed delivery and its stored payload.
- `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py` — the trigger component.
- `tests/helpers/triggers/sign-webhook.ts`, `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/flows/open-flow-by-id.ts`, `tests/helpers/flows/unmount-editor-for-cleanup.ts`,
  `tests/helpers/flows/delete-flow.ts` and `tests/helpers/other/served-version.ts`.
