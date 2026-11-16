# Connectors on the canvas — Add connection from the node's picker

**File:** `tests/tests-automations/regression/core-functionality/integrations/connector-inline-add.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2452 (the 1.14 triggers and connectors batch). The picker itself (its options, badges, empty
state and *Refresh*) is `docs/core-functionality/integrations/connector-node-picker.md`, which already asserts
that the empty state reads *"No google connections yet."* beside an *Add connection* button. The Add dialog
opened from *Settings › Connections*, its scopes and its consent outcomes, is
`docs/core-functionality/integrations/connection-oauth-wizard.md`. The *unavailable* copy needs a policy
change and is asserted in `docs/governance/integration-policy-v2.md` (#2451). Upstream: #16332 (first tag
`v1.14.0.dev23`) and #16375 (`v1.14.0.dev26`).

---

## What this test validates *(required)*

Since 1.14 a connector node's picker can create a connection without leaving the canvas. The contract
under test:

1. **Availability is read only while it matters.** The picker reads `GET /api/v1/integrations?provider=X`
   only once its popover is open. *Add connection* is enabled when that read answers the provider as
   `approved`. A failed read reads *"Could not load integration availability. Refresh to try again."* and
   leaves *Add connection* disabled.
2. **The dialog is locked to the field's provider and to what the field allows.** The provider offers
   only the field's provider. *Share with the whole instance* appears for a superuser only on a field whose
   `ownership_mode` is not `user`. The dialog has no display-name field, and the row it creates carries its
   handle as `display_name`.
3. **Cancelling leaves nothing behind.** The row the dialog created for consent is deleted, the node and
   the palette are as they were, and the dialog never reloads the catalog without the flow's scope.
4. **A connection that fits the field is selected.** Once consent lands, *Done* writes `provider/handle`
   into the field, and the flow saves it.
5. **A connection that does not fit is reported, not selected.** The toast reads *"The connection was
   created, but it cannot be used by this component."* and names what is missing. The field keeps its
   value.

### Measured on `1.14.0.dev28`

- **The read is lazy.** Opening the flow sends no `/api/v1/integrations` request. Opening the popover sends
  exactly one, `?provider=google`.
- **The field decides the sharing option.** Gmail: Send Email's `connection` field has `ownership_mode:
  "any"`, and its dialog shows `connection-instance-owned`. Google Calendar: On Event's has `"user"`, and
  its dialog does not.
- **The dialog is locked to the provider.** `connection-provider` lists one option, *Google Workspace*.
- **The handle is the display name.** The dialog has `connection-name` and no `connection-display-name`.
  `Continue` creates the row (`POST /api/v1/connections`) with `display_name` equal to `name`, `pending`,
  then calls `oauth/start`. While the consent window is open, the dialog reads *"Waiting for consent in the
  provider's window…"*. The API still requires `display_name` on a direct create (`422 missing`), so the
  equality is the dialog's, asserted here and not in the API spec.
- **Cancel during consent** sends `DELETE /api/v1/connections/{id}` for that row.
- **What #16375 fixed.** The dialog used to reload the catalog (`/api/v1/all`) without the flow's provider
  scope and replace the canvas's palette. On `dev28` the dialog sends **no** `/api/v1/all` request at all:
  it reuses the canvas's scoped catalog. The spec asserts that no catalog request without the flow's scope
  is sent while the dialog is open, and that the node and the palette survive.
- **No real consent can finish here.** The fake registrations (#2301) reach `oauth/start` and a denied or
  expired callback, never a token. `POST /api/v1/connections/{id}/token` on a Google row answers `422`
  *"This integration does not support manual token renewal."*. So the dialog's success is reached by
  playing the provider's last step on the dialog's own read. The dialog learns the outcome by polling
  `GET /api/v1/connections` until the row's `updated_at` moves (`usePendingConnectionPoll`). The spec
  answers that read with the real list, the new row changed to `ready`, `has_credentials: true`, a later
  `updated_at` and the granted scopes the case needs. Everything else is real: the create, `oauth/start`,
  the row the picker writes into the flow and the flow's save. The real row stays `pending`, and the test
  deletes it.
  - With `gmail.send` granted, the dialog reads *Connected*, and *Done* writes `google/<handle>` into the
    field. The saved flow carries it.
  - Without it, *Done* toasts *"The connection was created, but it cannot be used by this component."*
    with *"Missing gmail.send"*, and the field keeps its value.

### What is not covered here, and why

- **A consent that completes for real.** It needs an OAuth app and an account at the provider.
- **The empty state beside the button.** `connector-node-picker.spec.ts` asserts it.
- **The *unavailable* copy.** It needs a policy change; `governance/integration-policy-v2.spec.ts` asserts
  it.
- **A pasted token from the picker.** Every provider that offers one (Discord, GitHub, GitLab, Telegram,
  WhatsApp) checks it against the provider, which a fake token cannot pass. The refusals are asserted in
  `api/connections/api-connections-lifecycle.spec.ts`.

---

## Tags *(required)*

`@stable` `@components` `@integrations`

`@stable`: no provider key, no model call, and no network beyond the instance: the provider's consent page
is answered inside the browser (`tests/helpers/integrations/fake-oauth-provider.ts`). Every flow and
connection is created per test and deleted by id. `@stable` enters in this PR. The file skips below
`1.14.0.dev26`.

---

## Step by step *(required)*

Each test builds a flow with `createCatalogFlow` and opens it with `openFlowById`. The connector nodes are
*Gmail: Send Email* (`ext:google:GmailSendComponent@official`, node `gmail`) and, in test 2, *Google
Calendar: On Event* (`ext:google:GoogleOnCalendarTriggerComponent@official`, node `cal`). The picker is the
node's `connectionref_connection_ref_connection` field. The fake provider answers every consent with a
page that never redirects (`stall`). The UI runs as the auto-login superuser, whose connection list reads
(60 per minute) every connection UI spec shares, and the dialog reads the list every 2 s while it waits:
at `--workers=2` that bucket ran dry. So the page's list reads and the test's own wait a `429` out
(`absorbReadRateLimit`, `untilNotRateLimited`), as the OAuth wizard spec does, and so does `oauth/start`
(5 per minute per user, `absorbStartRateLimit`). A UI outcome that follows such a read is given the wait's
ceiling (180 s). *Continue* is clicked only once the page has read Google's OAuth registrations: a click
before that starts consent with no registration and answers `400` *"OAuth registration ID is not
configured."* (the same race #2307 measured in the wizard). The teardown leaves the editor, deletes the flows, and deletes every
connection whose name carries this run's marker.

### 1. The picker reads availability only while open, and says when it cannot

1. Open a Gmail flow, recording every `GET /api/v1/integrations` request. Expect none.
2. Open the picker. Expect exactly one request, with `provider=google`, and `add-connection-…` enabled.
3. Close it, answer `GET /api/v1/integrations` with `500` (`page.allowHttpErrors()`), and reload. Open the
   picker. Expect *"Could not load integration availability. Refresh to try again."* and
   `add-connection-…` disabled.

### 2. Add connection opens a dialog locked to the field, names the row by its handle, and cancelling leaves nothing

1. Open a flow with the Gmail and Calendar nodes, recording catalog requests.
2. From the Calendar node's picker, click *Add connection*. Expect no `connection-instance-owned`. Close the
   dialog.
3. From the Gmail node's picker, click *Add connection*. Expect:
   - `connection-provider` offering only *Google Workspace*;
   - `connection-instance-owned`;
   - `connection-name` and no `connection-display-name`.
4. Fill a unique handle and click *Continue*. Expect `POST /api/v1/connections` → `201` with `display_name`
   equal to `name` and `status: "pending"`, then *"Waiting for consent in the provider's window…"*.
5. Click *Cancel*. Expect `DELETE` of that row, and the row gone from `GET /api/v1/connections`.
6. Expect two nodes on the canvas, no `/api/v1/all` request without the flow's scope sent while the
   dialog was open, and the sidebar's search to find *Gmail: Send Email*.

### 3. A connection created from the picker is selected when it fits the field

1. Open a Gmail flow. From its picker, click *Add connection*, fill a unique handle and click *Continue*,
   with the dialog's read answering the new row as `ready` with `gmail.send` granted.
2. Expect the dialog to read *Connected*. Click *Done*.
3. Expect the field to read `google/<handle>`, and the saved flow's `connection` value to equal it.

### 4. A connection that does not fit the field is reported, not selected

1. As in test 3, but with the row answered `ready` with only `openid` and `email`.
2. Click *Done*. Expect the toast *"The connection was created, but it cannot be used by this component."*
   with *"Missing gmail.send"*, and the field still reading *Select a google connection*.

---

## Validation criterion *(required)*

Tests 1–4 pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev28`, and once at
`--workers=2` with the other connection UI specs, with:

- the lazy read asserted by counting requests, not by the button's state;
- every row the dialog creates read back from the API, and deleted;
- only the dialog's poll answered by the test, and only for the row it created;
- zero `🚨 Backend Error` (the `500` in test 1 is the test's own, behind `allowHttpErrors`);
- no flow or connection left behind.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev26` or later) at `PLAYWRIGHT_BASE_URL`, auto-login, with
  the fake OAuth registrations every lane sets (`LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`, #2301) and the
  Google bundle installed.
- `src/frontend/src/components/core/parameterRenderComponent/components/connectionRefComponent/index.tsx`
  — the picker, its lazy availability read, *Add connection* and `onConnected`.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AddConnectionDialog.tsx` — the
  dialog, the handle-as-name create, the consent wait and *Done*.
- `src/frontend/src/controllers/API/queries/connections/use-connections.ts` — `usePendingConnectionPoll`
  and `hasConsentLanded`.
- `src/frontend/src/controllers/API/queries/flows/use-get-types.ts` — the scoped catalog (#16375).
- `src/frontend/src/locales/en.json` — every string asserted here.
- `src/backend/base/langflow/api/v1/connections.py` — create, `oauth/start`, delete and `token`.
- `tests/helpers/integrations/fake-oauth-provider.ts`, `tests/helpers/integrations/oauth-callback.ts`,
  `tests/helpers/flows/build-catalog-flow.ts`,
  `tests/helpers/flows/open-flow-by-id.ts`, `tests/helpers/flows/unmount-editor-for-cleanup.ts`,
  `tests/helpers/flows/delete-flow.ts` and `tests/helpers/other/served-version.ts`.
