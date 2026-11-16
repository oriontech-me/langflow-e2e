# Triggers on the canvas — the trigger node's own controls: badge, Enabled, background-run consent, webhook secret

**File:** `tests/tests-automations/regression/core-functionality/integrations/trigger-node-controls.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2449 (the 1.14 triggers and connectors batch). The node's events drawer and payload tree
are the sibling file, `docs/core-functionality/integrations/trigger-events-drawer.md`, from the same issue.
The API side of webhook ingress (signing, the uniform `404`, `test`, `replay`) is
`docs/api/triggers/api-triggers-webhook-ingress.md`. Placement rules (one trigger per flow) are
`trigger-placement.md` (#2450). Upstream's own Playwright specs for this UI mock the whole backend
(`src/frontend/tests/utils/trigger-mocks.ts`). This file runs it against a live server.

---

## What this test validates *(required)*

Since 1.14 a trigger node carries controls of its own, and each one reads or writes the trigger row that
flow-save reconciliation keeps for the node (`GET /api/v1/triggers?flow_id=`, matched by `node_id`). The
contract under test:

1. **Unsaved, then a badge that follows the trigger.** A trigger node whose flow has not saved yet shows
   *"Save the flow to create this trigger."* and no badge. Once the save lands, the badge appears. Its
   `data-state` equals the row's `state` and its accessible name is *"Trigger state: {Label}. Show
   details."*
2. **The details popover.** The badge opens *Trigger details* from the keyboard (Enter), and Escape
   closes it and returns focus to the badge. The popover shows:
   - the state;
   - the reason line;
   - *"Checked every N s."*, where N is `trigger_polling_interval` from the authenticated
     `GET /api/v1/config` divided by 1000;
   - the transport (*"Signed request"* for an inbound webhook);
   - *"Last event"* (*"Never"* before any event).
3. **Enabled resumes and pauses.** Turning the *Enabled* switch on calls `POST …/enable`, and turning it
   off calls `POST …/disable`. The badge follows the server, and success shows no toast. While the
   trigger is paused, *Send test event* is blocked, and its `aria-description` reads *"Resume the
   trigger first."*.
4. **A refused resume says why.** When the server refuses the resume, the switch stays off and a toast
   reads *"Couldn't resume {trigger name}"*, followed by the server's reason.
5. **Background-run consent belongs to the connection.** A connection-backed trigger shows *Allow
   background runs* to the connection's owner, off by default. Turning it on writes
   `allow_non_interactive: true` on the **connection**, and the value survives a reload. While consent is
   off, *Enabled* is blocked with *"Allow background runs first."*.
6. **The fix path allows and resumes in one step.** A trigger stopped for missing consent
   (`needs_reconnect` with reason `consent_required`) offers *Reconnect*. That opens *"Allow background
   runs?"*, and *Allow and resume* turns consent on and enables the trigger.
7. **The webhook secret is shown once and is the one that signs.** An inbound webhook node reads *"Not
   set. Requests are refused until you create one."* and shows no endpoint. *Create secret* shows the
   secret once, and then:
   - the panel reads *"Set. Shown only when created or rotated."*;
   - its endpoint equals `GET /triggers/{id}/ingress`'s `ingress_url`;
   - the plaintext is gone from the page and from every trigger read;
   - a delivery signed with the value the dialog showed answers `202`.

   After *Rotate secret* in the UI, the old value is refused (`404`) and the new one accepted.

### Measured on `1.14.0.dev28`

- **When the endpoint appears.** An inbound webhook trigger has no `public_id` until its first secret, so
  `GET …/ingress` reads `public_id: null, ingress_url: null` and the panel renders no endpoint field.
  `POST …/signing-secret` mints both, and only its response carries the plaintext (`signing_secret`).
- **A pending trigger already accepts deliveries.** A signed delivery to a `pending` trigger answers
  `202` and runs the flow; a `paused` one answers `404`. So *Enabled* is not what makes the endpoint
  live. The spec asserts the secret contract on a trigger left `pending`, which keeps it independent of
  the switch.
- **The reachable refusal for "Couldn't resume".** The issue asked for a refusal that is reachable for
  real, not mocked. Measured:
  - *Missing consent is not that refusal.* With consent off, the server would refuse
    (`409 background_runs_not_allowed`), but the node blocks the switch first (`aria-disabled="true"`,
    *"Allow background runs first."*), so no request is sent.
  - *A missing scope is.* With consent **on** and a connection that lacks the source's scope, the
    switch is live. The server answers `409` *"The source connection is missing required scopes:
    https://www.googleapis.com/auth/calendar.events.readonly."*, and the toast reads *"Couldn't resume
    Google Calendar: On Event"* with that sentence below it. Scopes are checked at enable time, not at
    save, so the trigger saves `pending` with `resume` allowed.

  A deleted connection also reaches a real `409` (`trigger_connection_not_owned`). The spec uses the
  scope case because it is the one a user produces by connecting the wrong account.
- **The connection-backed trigger is Google Calendar.** *Gmail: On Message* (the issue's first
  candidate) cannot be armed with a planted credential at all: enable answers *"Gmail requires a
  customer-owned OAuth registration."* before consent is read. *Google Calendar: On Event*
  (`ext:google:GoogleOnCalendarTriggerComponent@official`) with a planted `ready` connection reaches
  every consent state. Its `connection` field takes the handle `google/<name>`. Reconciliation fills
  `connection_id` and picks the `google.calendar_sync_poll` mechanism, which the popover shows as
  *"Poll"*.
- **Reaching `consent_required` for real.** The trigger is enabled with consent on, then consent is
  turned off, then a test event is sent. Its dispatch fails `connection_not_authorized`, and the row moves
  to `needs_reconnect` with reason `consent_required`: `reconnect` allowed, `resume` blocked. The badge
  reads *"Needs reconnect"*. The dialog's *Allow and resume* sends
  `PATCH /api/v1/connections/{id} {"allow_non_interactive": true}` then `POST …/enable`, then toasts
  *"Resumed Google Calendar: On Event"*.
- **Unsaved is only visible while the save is in flight.** With autosave, a palette-added trigger node is
  unsaved only until its `PATCH /api/v1/flows/{id}` lands. The spec holds that request with `page.route`
  and asserts the unsaved text. It then lets the request through and waits for the badge, which follows
  within one polling interval (measured ~5 s).
- **Button labels are title-cased in the DOM** (*"Create Secret"*, *"Allow And Resume"*), because the
  shared `Button` title-cases string children. The spec matches by testid and asserts text where the
  label is the contract.

### What is not covered here, and why

- The events drawer, replay and the payload tree — the sibling spec doc.
- The non-owner consent hint (*"Only the connection's owner can allow background runs."*). It needs a
  second user viewing the owner's flow, which the auto-login canvas cannot do.
- The WhatsApp *Pause/Resume* button that replaces the switch for that provider, which needs a WhatsApp
  connection.
- A failing pause. Every pause refusal is either a race or needs a `dead` trigger, and the switch maps a
  dead trigger to *resume*.

---

## Tags *(required)*

`@components` `@integrations` `@stable`

`@stable`: no provider key, no model call and no external network. The Google connection is a planted
row (`createConnectionViaApi`), never a real account, and the calendar poll it arms never reaches Google
within the test. Every flow and connection is created per test and deleted by id. `@stable` enters in
this PR. The files skip below `1.14.0.dev26` (`servedVersionAtLeast`), the first nightly that serves
all of this batch, instead of failing on a surface the build does not have.

---

## Step by step *(required)*

Each test builds its flow with `createCatalogFlow` over the live `GET /api/v1/all`, opens it with
`openFlowById`, and finds the node by `.react-flow__node[data-id=…]`. The page is told the assistant
onboarding was seen (`localStorage["langflow-assistant-discovered"]`), because that popover otherwise
takes the first Escape. Webhook deliveries are signed by `tests/helpers/triggers/sign-webhook.ts`,
extracted from `api-triggers-webhook-ingress.spec.ts`, which now imports it. The teardown leaves the
editor (`unmountEditorForCleanup`), then deletes the flows and connections by id.

### 1. A trigger node is unsaved until its flow saves, then shows a badge that follows the trigger

1. Open a flow holding only a Chat Output. Hold every `PATCH /api/v1/flows/{id}` with `page.route`.
2. Add *Inbound Webhook* from the palette (search, then Enter on its row once it is draggable).
3. Expect `trigger-node-unsaved` to read *"Save the flow to create this trigger."* and no
   `trigger-node-badge`.
4. Release the held requests, then remove the route. Expect the badge, with `data-state` equal to the
   row's `state` (`pending`) and accessible name *"Trigger state: Pending. Show details."*, and the
   unsaved text gone.
5. Focus the badge and press Enter. Expect `trigger-node-popover` (*Trigger details*) to show:
   - *"Not listening yet. Turn on Enabled to start, or wait while the provider subscription
     completes."*;
   - *"Checked every {trigger_polling_interval / 1000} s."*, read from `/api/v1/config`;
   - *Transport* *"Signed request"*;
   - *Last event* *"Never"*.
6. Press Escape. Expect the popover gone and focus on the badge.

### 2. The Enabled switch resumes and pauses the trigger, and a refused resume says why

1. Open a saved inbound webhook flow. Expect `trigger-node-enabled` to be a `switch` named *"Enabled"*,
   `aria-checked="false"`.
2. Click it. Expect `POST …/enable` → `200`, the badge `data-state="active"`, the row `active`, and no
   toast.
3. Click it again. Expect `POST …/disable` → `200` and the badge `paused`. Open the popover and expect
   `trigger-node-test` to carry `aria-disabled="true"` and `aria-description` *"Resume the trigger
   first."*
4. Open a Google Calendar trigger flow whose connection has consent **on** and no granted scope. Click
   *Enabled*. Expect:
   - `POST …/enable` → `409`;
   - a toast *"Couldn't resume Google Calendar: On Event"* listing *"The source connection is missing
     required scopes: …calendar.events.readonly."*;
   - the switch still `aria-checked="false"`;
   - the badge still `pending`.

### 3. Background-run consent is the connection owner's switch, persists, and the fix path allows and resumes

1. Open a Google Calendar trigger flow whose connection has the scope and consent off. Expect:
   - `trigger-node-consent` off;
   - its description naming the connection (*"Lets triggers and schedules use {display name} while
     you're away. …"*);
   - *Enabled* blocked (`aria-disabled="true"`, *"Allow background runs first."*).
2. Click the consent switch. Expect `PATCH /api/v1/connections/{id}` with body
   `{"allow_non_interactive": true}`, the connection reading `true` through the API, and *Enabled* no
   longer blocked.
3. Reload. Expect the consent switch still on.
4. Put a second Calendar trigger into `consent_required`: enable it with consent on, turn consent off,
   send a test event, and poll until `reason` is `consent_required`. Open its flow. Expect:
   - the badge *"Needs reconnect"*;
   - the popover reason *"Allow background runs is off for this connection."*;
   - `trigger-fix-reconnect`.
5. Click *Reconnect*. Expect `trigger-consent-dialog` (*"Allow background runs?"*). Confirm with
   `trigger-consent-confirm`. Expect, in order, `PATCH …/connections/{id}`
   `{"allow_non_interactive": true}` and `POST …/enable`. Then expect:
   - the toast *"Resumed Google Calendar: On Event"*;
   - the dialog closed;
   - the badge `active`;
   - the consent switch on.

### 4. The webhook secret is shown once, signs deliveries, and rotating it refuses the old one

1. Open a saved inbound webhook flow. Expect `trigger-webhook-panel` to read *"Not set. Requests are
   refused until you create one."* and no `trigger-node-endpoint`.
2. Click `trigger-node-secret` (*Create secret*). In `trigger-secret-dialog`, confirm with
   `trigger-secret-rotate`. Read the value of `trigger-secret-value`, then click *Done*.
3. Expect:
   - the panel to read *"Set. Shown only when created or rotated."*;
   - `trigger-node-endpoint` equal to `GET …/ingress`'s `ingress_url`;
   - the secret absent from the page's HTML;
   - the secret absent from `GET …/ingress`, `GET /api/v1/triggers/{id}` and
     `GET /api/v1/triggers?flow_id=`.
4. POST a delivery to the endpoint, signed with the value the dialog showed → `202`.
5. Click *Rotate secret* and confirm. Expect the dialog's rotate description (*"Rotating replaces the
   secret right away. …"*) before confirming, and a new value after. A delivery signed with the old value
   → `404`; one signed with the new value → `202`.

---

## Validation criterion *(required)*

Tests 1–4 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev28`, and once at
`--workers=2` together with the events-drawer file, with:

- every state the UI shows read back from the server (the row's `state`/`reason`, the connection's
  `allow_non_interactive`, the ingress `ingress_url`), never asserted from the UI alone;
- the refusal toast driven by a real `409`, not a mocked one;
- the secret accepted when signed with the value the dialog showed, and the rotated-out value refused;
- zero `🚨 Backend Error`: the one deliberate `409` and the two `404` probes go through
  `page.allowHttpErrors()` (test 2) or the `request` fixture (test 4);
- no flow, connection or trigger row left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev26` or later) at `PLAYWRIGHT_BASE_URL`, auto-login,
  with the Google bundle installed (the nightly ships it) and trigger dispatch running (the default).
- `src/frontend/src/components/core/triggers/TriggerNodeBadge.tsx` — the badge and the details popover.
- `src/frontend/src/components/core/triggers/TriggerNodeControls.tsx` — unsaved text, Enabled, consent.
- `src/frontend/src/components/core/triggers/TriggerStatusSummary.tsx` — the reason line and the inline
  fix.
- `src/frontend/src/components/core/triggers/BackgroundRunsConsentDialog.tsx` — *Allow and resume*.
- `src/frontend/src/components/core/triggers/WebhookIngressPanel.tsx` and
  `src/frontend/src/components/core/triggers/SigningSecretDialog.tsx` — endpoint and secret.
- `src/frontend/src/components/core/triggers/helpers/trigger-enabled.ts` — when the switch reads on.
- `src/frontend/src/components/core/triggers/hooks/use-node-trigger.ts` — the row the node reads.
- `src/frontend/src/locales/en.json` — every string asserted here.
- `src/backend/base/langflow/api/v1/triggers.py` — enable, disable, test, ingress, signing secret.
- `src/backend/base/langflow/services/triggers/capabilities.py` — `allowed_actions` / `blocked_actions`.
- `src/backend/base/langflow/services/triggers/source_arming.py` — the scope and consent checks.
- `src/backend/base/langflow/services/triggers/ingress/verifiers.py` — the signature the helper produces.
- `src/backend/base/langflow/api/v1/connections.py` — `allow_non_interactive`.
- `src/bundles/google/src/lfx_google/components/google/calendar_trigger.py` and
  `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py` — the two trigger components.
- `tests/helpers/triggers/sign-webhook.ts`, `tests/helpers/integrations/create-connection.ts`,
  `tests/helpers/flows/build-catalog-flow.ts`, `tests/helpers/flows/open-flow-by-id.ts`,
  `tests/helpers/flows/unmount-editor-for-cleanup.ts`, `tests/helpers/flows/delete-flow.ts` and
  `tests/helpers/other/served-version.ts`.
