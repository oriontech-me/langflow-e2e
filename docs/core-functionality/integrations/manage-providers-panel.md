# Connections — the Manage providers panel

**File:** `tests/tests-automations/regression/core-functionality/integrations/manage-providers-panel.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2421, a follow-up of #2409 (directive 3). The API half, which also holds the server-side
validation, the environment-precedence rule at run time and the secret boundary, is
`docs/api/connections/api-connections-saved-oauth-registrations.md`.

---

## What this test validates *(required)*

From `1.14.0.dev22` (langflow-ai/langflow#16251) `/settings/connections` carries a superuser-only **Manage
providers** tab. #2410 asserts the tab exists and that a regular user does not see it, and nothing more. This
file covers the panel itself: `ManageProvidersPanel.tsx`, `data-testid="manage-providers"`.

Measured on `1.14.0.dev28`:

### The table

- The panel shows the intro paragraph verbatim, beginning *"OAuth apps registered here are shared with the whole
  instance."*, and an **Add provider** button (`manage-providers-add`).
- The table has no testid. Its columns are *Registration ID*, *Provider*, *Status* and *Saved by*, plus an
  unlabelled actions column.
- **Rows are the union of two reads**: the saved list (`GET …/oauth/registrations/saved`) and the registrations
  the running server uses (`GET …/oauth/registrations`). So an environment registration is a row too:
  - *Status* is *Active*;
  - *Saved by* is *Server environment*;
  - it has no actions.
- A row saved here shows its status, the saver's username and two buttons, **Replace** and **Remove**. The status
  text depends on the saved entry:
  - `pending` reads *"Saved. Restart Langflow to finish applying it"*, with an info icon whose tooltip reads
    *"New connections can use it now. Trigger listeners and other Langflow processes pick it up after a
    restart."*;
  - `overridden` reads *"Not in use: the server environment defines this ID"*.
- **The empty state *"No providers configured yet."* cannot be reached on any lane**, because every lane serves
  the four fake registrations of #2301. It is asserted with both reads answered empty by a route; nothing else in
  this file is mocked.

### Add provider

- The dialog is titled *Add provider*. Its fields carry labels and no testids, so every field is found by its
  label:
  - *Provider*, a native select;
  - *Registration ID*;
  - *Client ID*;
  - *Client secret*;
  - *Client type* (*Confidential* or *Public*);
  - *Tenant (optional)*, which becomes *Tenant* for Microsoft 365, with the placeholder
    `00000000-0000-0000-0000-000000000000`;
  - *Redirect URI*;
  - *Scopes (comma-separated)*.
- The provider list is the manifest's OAuth providers, the ones with a capability whose auth profile is not a
  manual-token profile. On `1.14.0.dev28` that is seven, in manifest order: Confluence Cloud, Google Workspace,
  Jira Cloud, Microsoft 365, Salesforce, ServiceNow and Slack. The first is preselected.
- Choosing a provider prefills the form:
  - *Registration ID* is `<provider>-work`;
  - *Redirect URI* is this page's origin followed by `/api/v1/connections/oauth/<provider>/callback`;
  - *Client type* is *Confidential*.
- The footer reads *"Some features need a restart"* (`manage-providers-restart-note`), beside *Cancel* and *Save*
  (`manage-providers-save`).

### Five checks before anything is sent

Five mistakes are caught in the browser. Each is shown as an `alert`, and **no `PUT` is sent**:

| Mistake | Alert |
|---|---|
| an invalid registration ID | *Choose a provider and a registration ID with lowercase letters, numbers, hyphens or underscores.* |
| an ID already in the table (an environment ID included) | *The registration ID `<id>` is already in use. Choose another ID.* |
| no client ID | *Enter the client ID and the redirect URI.* |
| a confidential client with no secret | *A confidential client needs a client secret.* |
| Microsoft 365 with no tenant | *Microsoft 365 needs a tenant, for example 00000000-0000-0000-0000-000000000000.* |

### Replace and Remove

- **Replace** opens *Replace `<id>`*:
  - *Provider* and *Registration ID* are disabled and show the saved values;
  - *Client ID*, *Redirect URI* and *Scopes* hold the saved values, the scopes joined with `, `;
  - *Client secret* is empty, with the placeholder *"Leave blank to keep the current secret"*.
- Saving with a new client ID sends a `PUT` with **no `client_secret` key**. The fields the form does not show
  (`profile: "bot"` among them) are carried over. The toast reads *"Provider saved. Restart Langflow to finish
  applying it."*, and the dialog closes. Afterwards:
  - the server's entry has the new client ID and `has_secret: true`, so the secret was kept;
  - *Saved by* becomes the user who replaced it.
- **Remove** asks for no confirmation. It sends the `DELETE` at once, and the toast reads *"Provider removed.
  Restart Langflow to finish removing it."*. The row leaves the table, and the ID leaves both server lists.
- No secret saved through the API ever appears in the page.

### A defect: Slack cannot be added from the panel

On `1.14.0.dev28`, with the release line's tip unchanged, adding a **Slack** provider always fails.

- The form sends the manifest's auth-profile ID as the registration's `profile`. For Slack that ID is
  `slack-user-oauth`.
- `OAuthRegistration.profile` accepts only `user` or `bot`, so the server answers `422` `"OAuth registration field
  'profile' is invalid."`.
- The page shows the alert *Could not save the provider* with that message. The dialog stays open.

Google Workspace and Microsoft 365 use the profile `user` and save. The form also has no field to choose between a
Slack user registration and a bot one. Test 5 asserts the intended behaviour and is **declared failing**
(`test.fail()`), so it turns red on its own the day upstream fixes it. The defect is listed in
`REGRESSIONS.md › Candidates` until a ticket is filed.

### What this file does not do, and why

- **A successful *Add provider* through the page.** Only Google Workspace and Microsoft 365 can be saved today.
  A second Google or Microsoft registration is visible to every user's connection wizard, and
  `connection-oauth-wizard.spec.ts` asserts that Google offers **no** registration picker and reconnects through
  `e2e-microsoft`. A save here, in parallel with that file, would break it. The save itself is covered by the API
  spec and by Replace. Test 5 covers *Add provider* end to end once the Slack defect is fixed.
- ***Active* for a saved registration, and *"Removed. Restart Langflow to finish removing it"*** need the instance
  to restart. See the API doc's *Measured, not asserted*.
- **The regular user's view** is #2410's.

---

## Tags *(required)*

`@integrations` `@settings` `@ui-ux` `@stable`.

---

## Step by step *(required)*

**Isolation and budget.** The page always runs as the auto-login superuser, whose buckets every connections spec
shares: writes (30/min) and the `connections-read` bucket (60/min), which the wizard spec drains. So:

- the rows this file needs are **seeded through the API** by a throwaway superuser, created in `beforeAll` through
  `createConnectionsOwner` and promoted. The page itself spends only the two writes it exists to make, a Replace and
  a Remove, in test 3;
- a context route sends the page's connection **reads** with the owner's token: the connection list and both
  registration lists. The owner is a superuser too, so the server gives the same answer: the saved list is shared
  by every superuser, and the panel shows no connection. But the reads cost the owner's `connections-read` bucket,
  not the shared superuser's. **This is measured, not defensive.** With the reads left on the superuser, a run at
  `--workers=2` beside `connection-oauth-wizard.spec.ts` (~63 reads in 37 s on its own) held `429`s for 21–32 s.
  That pushed this file's Remove toast past its wait, and failed the wizard's Microsoft Reconnect, which passes
  alone. Writes are never routed: Replace and Remove are the superuser's own, which is what *Saved by* then
  asserts;
- every seeded ID is a **Slack `bot`** registration with an ID unique to the test, a pair no other spec reads;
- the override in test 4 uses `e2e-slack-user`, which the API spec never writes;
- each test removes what it saved in `finally`, through the API.

`describe.configure({ mode: "default" })` keeps the file in one worker: one owner, so one login per run.

**Gate.** `1.14.0.dev22` or later, else the file skips.

**Test 1 — the environment's registrations are listed as Active, from the server environment, with no action; Add
provider opens a form prefilled for this instance; with no registration at all the panel says so.**
1. Open `/settings/connections` and select the *Manage providers* tab. The panel shows the intro and the button.
2. The rows for `e2e-google` and `e2e-microsoft` read their provider, *Active* and *Server environment*, with no
   *Replace* or *Remove*. These two IDs are never written by any spec, unlike the Slack IDs this suite overrides.
3. *Add provider* opens the dialog. The *Provider* options are the manifest's OAuth providers' display names, in
   manifest order, the first one selected. *Registration ID* is `<first>-work` and *Redirect URI* is the page's own
   callback for it.
4. Choosing *Google Workspace* changes the ID to `google-work` and the redirect to the Google callback. *Client
   type* is *Confidential*. The restart note is shown. *Cancel* closes the dialog, and nothing was written.
5. With both lists answered `{"registrations": []}` by a route, a reload shows *"No providers configured yet."* and
   no table, and *Add provider* stays enabled.

**Test 2 — the form catches five mistakes before sending anything.**
1. Open *Add provider*.
2. Make each mistake in the table above, in turn, and press *Save*. Each time the matching alert is shown and the
   dialog stays open.
3. No `PUT` or `DELETE` was sent during the test.

**Test 3 — a saved registration shows its status and saver; Replace keeps the secret and Remove deletes it.**
1. The owner saves a confidential Slack `bot` registration with a `client_secret` and a `signing_secret`.
2. Open the panel. The row reads `slack`, *"Saved. Restart Langflow to finish applying it"* and the owner's
   username, and offers *Replace* and *Remove*. Hovering the status shows its tooltip. Neither secret appears in
   the page.
3. *Replace* opens *Replace `<id>`*, with *Provider* and *Registration ID* disabled and the saved values, and an
   empty secret field with its placeholder.
4. Change *Client ID* and press *Save*. The `PUT` answers `204`, and its body carries the new client ID,
   `profile: "bot"` and no `client_secret` key. The saved toast is shown and the dialog closes. The server's entry
   reads the new client ID, `has_secret: true` and `saved_by` the superuser. The row's *Saved by* follows.
5. *Remove* sends the `DELETE` (`204`) with no confirmation, and the removed toast is shown. The row is gone. The
   ID is in neither server list.

**Test 4 — an environment ID saved here reads "Not in use".**
1. The owner saves `e2e-slack-user` with its own client ID.
2. Open the panel. That row reads *"Not in use: the server environment defines this ID"*, *Saved by* the owner,
   with *Replace* and *Remove*.

**Test 5 — *Add provider* saves a Slack registration (declared failing).**
1. Open *Add provider* and choose *Slack*. The ID becomes `slack-work` and the redirect becomes the Slack callback.
2. Set a unique ID, a client ID and a secret.
3. From here on the test is declared failing (`test.fail()`), and the page's HTTP errors are not reported
   (`allowHttpErrors()`). The `422` is the defect itself.
4. Press *Save*. The `PUT` answers `204`. The saved toast is shown. The row lists the ID with
   *"Saved. Restart Langflow to finish applying it"*.

Today step 4's first assertion fails on the `422`, which is the expected failure. If the defect is fixed, the test
passes, Playwright reports it as an unexpected pass, and the test goes red. The cleanup removes the ID if it was
saved.

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev28`, and once at
`--workers=2`. Test 5 passes as an expected failure. On every run:
- no `🚨 Backend Error` is logged;
- no saved registration and no throwaway user is left behind.

Each test also has a force-fail mutation executed against it. For test 5, the mutation is a route that rewrites the
`profile` to `bot`: the fixed behaviour, simulated, must turn the test red.

---

## External dependencies *(required)*

- A running Langflow **1.14.0.dev22 or later** at `PLAYWRIGHT_BASE_URL`, auto-login (the superuser).
- The fake OAuth registrations of #2301, which every lane and starter sets.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/ManageProvidersPanel.tsx` — the panel, the
  form, the client-side checks and the profile it sends.
- `src/frontend/src/locales/en.json` — every `connections.providers.*` string asserted here.
- `src/backend/base/langflow/api/v1/connections.py` — the saved-registration routes the page calls.
- `src/backend/base/langflow/services/connection/oauth/config.py` — `OAuthRegistration.profile`, the field the Slack
  defect breaks on.
