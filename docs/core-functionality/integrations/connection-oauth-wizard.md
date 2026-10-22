# Connections — the Add and Reconnect wizard, up to consent

**File:** `tests/tests-automations/regression/core-functionality/integrations/connection-oauth-wizard.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev2`)

Owning issue: #2307 (Dedicated Integrations, batch 2; upstream surfaces A10, B2 and B3). It depends on #2301's fake
OAuth registrations (`docs/api/connections/oauth-fake-registrations.md`). The callback's controls are asserted
through the API in `docs/api/connections/api-connections-oauth-callback.md`.

---

## What this test validates *(required)*

The dialog a user connects an account through: *Add connection* from the page, *Reconnect* from a row's menu, and
*Authorize* on a `pending` row. Until #2301 it stopped at *"No OAuth registration is configured for this
provider"*. With the fake registrations it walks to consent, and this file walks it there and back.

**The test plays the provider.** Continue opens a popup on the provider's authorization URL. A context route answers
that URL the way the provider would at the end of consent: a `302` to the instance's callback with the `state` it
was given, plus `error=access_denied`, or neither `code` nor `error`. Or it serves a stub page and never redirects,
to stand for a user who has not answered yet. The browser then delivers the real callback, with the real binding
cookie `oauth/start` set, to the real backend, and the dialog learns the outcome the way it does in production: by
polling the row. Nothing leaves the machine, and nothing is mocked on Langflow's side, apart from the registration
list in tests 2 and 3.

The popup must reach the callback through the provider's redirect, never through `popup.goto()`. Measured: a
browser-initiated navigation of the popup to another site swaps its browsing instance. The dialog's handle on the
window then reads as closed, so *Try again* opened nothing and the dialog waited forever.

Measured on `1.14.0.dev2`:

| What the user does | What the dialog shows | What the row reads |
|---|---|---|
| Opens *Add connection* | *Provider* (`connection-provider`), *Handle*, *Display name*, *Share with the whole instance*, *Scopes to request*: one checkbox per scope (`connection-scope-<scope>`), all checked, each labelled with every action that needs it and that action's risk (*Read* / *Write*), from the manifest's `display_name` and `risk`. Slack adds *How to connect* (`connection-method`: *Sign in with Slack* / *Paste a token*) and *Runs as* (`connection-identity`). | — |
| Picks *Paste a token* | A *Token* field (`connection-token`) in place of the scope list, and the *Setup guide* points to the Slack bundle's page | — |
| Continue | *"Waiting for consent in the provider's window…"* and a popup on the provider's authorization URL | `pending` (`oauth/start` does not touch the row) |
| The provider denies | `role=alert` *"The provider denied authorization."*, *Try again*, *Cancel* | `error` / `oauth-denied` |
| *Try again*, and the provider returns neither `code` nor `error` | *"The sign-in link expired. Start again to get a new one."* | `error` / `oauth-expired` |
| *Try again*, then closes the popup unanswered | *"Langflow can no longer track the sign-in window. If the provider shows an error, ask your administrator to check the OAuth registration before trying again."* and the setup help | unchanged |
| *Cancel* on an Add | the dialog closes | **deleted** (`DELETE` → `204`): an unfinished Add leaves nothing behind |
| *Reconnect* on a `ready` row, *Authorize*, then *Cancel* | dialog titled *"Reconnect <display name>"*, the held scopes checked and marked *Granted* | **unchanged**: no write is sent, `ready`, credential kept, badge `Ready` |
| *Authorize* on a `pending` row (`authorize-<name>`), denied, *Cancel* | *Authorize* stays disabled until a scope is checked (a pending row holds none) | `error` / `oauth-denied`, and the page shows the badge `Error` with *"The provider denied authorization."* under it |

Two states need the registration list mocked, because the lanes serve one registration per provider and profile:

- **No registration.** The setup help (`connection-setup-help`) says *"No OAuth registration is configured…"* and
  tells the operator to set `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`. It suggests a redirect URI
  (`connection-callback-url`) built from the page's own origin, `<origin>/api/v1/connections/oauth/<provider>/callback`,
  which *Copy redirect URI* (`connection-copy-callback`) puts on the clipboard (*"Redirect URI copied."*).
  Continue stays disabled. The suggestion is offered only on HTTPS or loopback HTTP, the broker's own rule. Any
  other origin gets *"Open Langflow at its public HTTPS URL…"* instead, and the test asserts whichever the lane's
  origin calls for.
- **Two registrations for one provider and profile.** An *OAuth registration* select (`#connection-registration`)
  appears, preselecting the first. The test lists a fake id **first** and the real `e2e-google` second, picks the
  real one, and checks that `oauth/start` was sent with it. A start the server accepted is the proof the pick was
  honoured.

### Recorded, not asserted

- **The *Connected* state** needs a real token exchange. It is out of scope with the rest of a successful consent.
- **The popup after a failure.** The dialog closes the popup on success only. After a denial it stays open on the
  callback's failure page.
- **Add's *Continue* does not wait for the registration list.** Reconnect's *Authorize* waits for it
  (`canAuthorize` checks `!registrations.isLoading`), and Add's `canContinue` does not. A *Continue* sent before the
  list arrives finds no list, falls back to the provider id as the registration (`resolveRegistrationId`'s path for a
  backend without the listing route) and starts consent with `registration_id: "google"`. The server answers `400 "OAuth
  registration ID is not configured."`, and the dialog shows *"Authorization did not complete."*. Measured on
  `1.14.0.dev2` by delaying the list, and seen once in this PR's CI, where it was the first attempt of test 4. A user
  rarely beats the request, so the spec waits for the list before it touches the dialog, and the race is recorded here
  instead of asserted.
- **The 10-minute client timeout**, which also shows the *expired* copy, is not waited out. The server-side
  `oauth-expired` reaches the same copy.
- **The Reconnect defect manual QA recorded on 1.13** is fixed upstream (langflow#15822), and could not reproduce
  against a planted credential anyway: the API spec doc explains why. Test 5 asserts the user-visible half: an
  abandoned Reconnect sends no write, and the row stays `Ready`.

### Budgets, and why the helpers wait

Two limits bind this file, and both are shared with something else.
- **`oauth/start`**: 5/minute **per user**. This file runs as the superuser, because a UI under auto-login cannot
  switch users. It spends exactly 5 starts per run.
- **The callback**: 5/minute **per client IP**, so shared with the API spec, which also exhausts it on purpose. This
  file spends 3.

A refused start or callback consumes nothing, so the helpers wait out the window and send the same request again,
and log that they did:
- a start the browser sends goes through a page route that resends it after a `429`;
- a popup whose callback answered `429` is reloaded once the window resets.

So a validation burst or a CI retry costs time, not a red test. Measured: a popup reloaded after the reset delivered
the callback, and the dialog showed the denial.

A third limit follows from that wait. A waiting dialog reads the connection list every 2 s, and list reads are
limited to 60/minute per user. Measured at `--workers=2`: two tests waiting out the callback window side by side
read the superuser's list into `429` four times. The tests stayed green, but each `429` is a `🚨 Backend Error` line
in the log. So the file runs its tests **in order, in one worker** (`describe.configure({ mode: "default" })`, which
does not skip the rest after a failure), and one waiting dialog stays at about half the read bucket.

---

## Tags *(required)*

`@stable` `@integrations` `@settings` `@ui-ux`.

`@stable` because every lane, scheduled ones included, carries the fake registrations (#2301). Without them,
*Continue* is disabled behind *"No OAuth registration is configured"* and test 4 **fails**, never skips (#1010).

---

## Step by step *(required)*

The page is `/settings/connections`, opened directly. Rows are found by their unique handle (`connection-row-<name>`,
`connection-menu-<name>`, `authorize-<name>`). Each test records the handles it creates, and `afterEach` deletes
whatever is left through the API. The fake provider is a context route on `https://accounts.google.com/**`, with
the outcome set per step. The tests run in order in one worker (see *Budgets* above).

**Test 1 — the Add dialog lists every Google scope with the risk of each action that needs it, and offers Slack a
token instead of a sign-in.**
1. Read `GET /api/v1/integrations`. Open *Add connection*. The provider options are the manifest's providers, with
   Google preselected.
2. For every Google capability and every scope it requires, `connection-scope-<scope>` is checked, and its label
   carries the capability's `display_name` with its risk label. The registration select is absent (one registration
   per profile), and so is the callback help.
3. Pick Slack. *How to connect* offers *Sign in with Slack* (selected) and *Paste a token*. *Runs as* offers *The
   signed-in user* and *A bot*.
4. Pick *Paste a token*. `connection-token` appears, the scope list goes, and *Setup guide* points to
   `…/bundles-slack#two-executing-identities`. Close: nothing was created.

**Test 2 — with no OAuth registration, the dialog explains the operator setup and offers this instance's callback
URL.**
1. Mock the registration list to `{"registrations": []}` and open *Add connection*.
2. `connection-setup-help` carries the no-registration alert and names `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`.
3. On HTTPS or loopback HTTP, `connection-callback-url` reads exactly
   `<page origin>/api/v1/connections/oauth/google/callback`. *Copy redirect URI* puts that string on the clipboard
   and says *"Redirect URI copied."*. On any other origin, the *callback unavailable* copy shows instead.
4. Fill a valid handle and display name: *Continue* stays disabled. Close: nothing was created.

**Test 3 — the registration picked is the one consent starts with, a closed sign-in window is reported, and
Cancel discards the half-made connection.**
1. Mock the registration list so Google lists a fake `e2e-google-alt` first and the real `e2e-google` second. Open
   *Add connection*: *OAuth registration* offers both and preselects `e2e-google-alt`. Pick `e2e-google`.
2. The provider will not answer (stub page). Fill the form and press *Continue*. The `oauth/start` request names
   `registration_id: "e2e-google"` and the checked scopes, and answers `200`. The popup opens on
   `accounts.google.com`. The dialog waits.
3. Close the popup. The dialog reports that it can no longer track the sign-in window, and offers *Try again*.
4. *Cancel*: a `DELETE` of the new row answers `204`, and the list no longer carries it.

**Test 4 — a denied consent, then an expired sign-in link, each say so, and the row records why.**
1. The provider will deny. Fill the form and press *Continue*. The dialog shows *"The provider denied
   authorization."* as an alert. The API row reads `status: error`, `status_reason: oauth-denied`.
2. The provider will return neither `code` nor `error`. *Try again*: the same popup receives the new attempt, and
   the dialog shows *"The sign-in link expired. Start again to get a new one."*. The row reads `oauth-expired`.
3. *Cancel*: the row is deleted.

**Test 5 — an abandoned Reconnect leaves a working connection as it was.**
1. Plant a `ready` Google row through the API, holding `openid`, `email` and `gmail.send`.
2. *Reconnect* from its menu. The dialog is titled *"Reconnect <display name>"*, and the three held scopes are checked
   and marked *Granted*.
3. The provider will not answer. *Authorize*: `oauth/start` is sent with the held scopes, and the dialog waits.
4. *Cancel*. The dialog and the popup close, and no non-`GET` connection request is sent.
5. The API row is unchanged: `ready`, `status_reason: null`, `has_credentials: true`, the same `granted_scopes` and
   `updated_at`. The page row still shows `Ready` with no reason line.

**Test 6 — a pending connection the provider refuses shows Error, with the reason, on the page.**
1. Plant a Google row with no credential (`pending`). Its row offers *Authorize* (`authorize-<name>`).
2. *Authorize* opens *"Reconnect <display name>"* with nothing checked, and its *Authorize* button is disabled.
   Check `openid` and `email`, and it is enabled.
3. The provider will deny. *Authorize*: the dialog shows the denial. *Cancel* sends no write, because a Reconnect
   never deletes its row.
4. The page row shows the badge `Error` with *"The provider denied authorization."* under it, and the API row
   reads `error` / `oauth-denied`.

---

## Validation criterion *(required)*

All six tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev2`, and once at
`--workers=2` together with the API spec. Every outcome is asserted twice: in the dialog's exact copy and on the
row through the API. After the run, `GET /api/v1/connections` carries no row with this spec's handles.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.13+** instance at `PLAYWRIGHT_BASE_URL`, with auto-login (the superuser) and #2301's fake
  registrations (`LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`). Rate limiting on, at its defaults.
- Chromium with clipboard permissions (granted by `playwright.config.ts`).
- No provider tenant and no network egress: the provider's URL is answered by a context route.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AddConnectionDialog.tsx` — the steps, the
  popup handling, the polling and the copy chosen per `status_reason`, and *Cancel* deleting an unfinished Add.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AuthorizeStatus.tsx` — the waiting, untracked
  and failed states.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ConnectionSetupHelp.tsx` and
  `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/helpers/setup-guide.ts` — the setup help and the
  suggested redirect URI.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/RegistrationSelect.tsx` — the picker, shown
  only with two or more registrations.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ScopeChecklist.tsx` and
  `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/helpers/scopes.ts` — the scope list and its risk labels.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/SlackTokenFields.tsx` — *How to connect* and
  the token field.
- `src/frontend/src/customization/components/custom-connection-authorization.ts` — how a registration is chosen and
  the popup opened.
- `src/backend/base/langflow/api/v1/connections.py` — `oauth/start`, the registration list and the callback.
