# Connections — the pasted-token providers in the Add dialog

**File:** `tests/tests-automations/regression/core-functionality/integrations/connection-token-providers.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2500 (Dedicated Integrations, the 1.14 connector-provider batch #2498–#2503). The API half of the same
contract — a fake token refused `422`, the same create without credentials stored `pending` — is
`docs/api/connections/api-connections-lifecycle.md`, test 9. The OAuth half of this dialog is
`connection-oauth-wizard.md`.

---

## What this test validates *(required)*

Five 1.14 providers connect **only** through a pasted token. Each has one manual-token profile, read from
`GET /api/v1/integrations` (`manual_token_profiles`):

| Provider | Profile | Identity | `requires_expiry` | `required_scopes` |
|---|---|---|---|---|
| GitHub | `github-installation` | `service` | **true** | — |
| GitLab | `gitlab-personal-token` | `user_delegated` | false | `api` |
| Discord | `discord-bot-token` | `bot` | false | — |
| Telegram | `telegram-bot-token` | `bot` | false | — |
| WhatsApp Business | `whatsapp-system-user` | `service` | false | `whatsapp_business_management`, `whatsapp_business_messaging` |

The suite asserts the API half for all five, and the dialog's token path for **Slack only** (the *Paste a token*
step of `connection-oauth-wizard.spec.ts`). This file asserts the dialog for the five, against the live server: what
the form offers, what it sends, how it shows a refused token, and what it leaves behind.

A ready connection is out of reach: since `1.14.0.dev26` the server checks a pasted token **against the provider**
before saving it, and none accepts a fake one. So every Continue here ends in a refusal, and the refusal is the
contract under test.

### Measured on `1.14.0.dev32`

**The token-only form.** Choosing any of the five in *Add connection* shows, with no sign-in step:
- no method selector (`connection-method`) and no scope list (`connection-scope-*`) — those are Slack's and the OAuth
  providers' — and **no identity selector** (`connection-identity`): each profile has one identity, and the dialog
  sends it without asking;
- `connection-token` (a password input) with `connection-token-help` *"Paste an access token for this provider.
  Langflow checks the token before saving it."*;
- `connection-setup-guide`, whose `href` is the manifest's `docs_url` (GitHub's points at its bundle README, pinned
  to a commit — read from the manifest, never hard-coded);
- `connection-allow-background-runs`, an unchecked `role=checkbox`;
- `connection-continue`, disabled until a handle and a token are filled.

GitHub alone adds `connection-token-expires-at` (`datetime-local`, required) with *"Enter a future expiration time in
your current time zone."*. A past value marks it `aria-invalid="true"` and keeps Continue disabled, so no request is
sent; a future one enables it.

**What Continue sends.** `POST /api/v1/connections` with `provider_key`, the handle as both `name` and
`display_name`, `ownership_mode: "user"`, `executing_identity: {identity: <the profile's>}`,
`granted_scopes: <the profile's required_scopes>`, `allow_non_interactive` (the checkbox) and
`credentials: {access_token}` — plus, for GitHub, `expires_at` as the entered local time converted to UTC
(`2027-06-01T12:00` at UTC−3 sent as `2027-06-01T15:00:00.000Z`).

**A refused token.** The server answers `422` and the dialog:
- shows the response's `detail` **verbatim** in `<p role="alert">`;
- stays open on the same step, keeps the token in the field (it is **not** cleared) and keeps Continue enabled;
- clears the alert as soon as the token is edited.

The `detail` depends on what the provider says, and on whether the server can reach it. Measured with egress:
GitHub *"GitHub rejected this token. Paste a valid GitHub App installation token and try again."*, GitLab and Discord
*"The provider rejected this token. …"*, Telegram *"The provider rejected this connection configuration. …"* —
Discord answered both of the last two on different days for the same fake token. WhatsApp refuses **before** any
provider call, deterministically: *"Configure the WhatsApp app, app secret, WABA, phone ID and Graph API version on
this server."* No lane configures WhatsApp (#2498 left it out on purpose).

**Nothing is stored.** After a refused Add, the connection list carries no row with that handle.

**Reconnect on a `pending` row.** A token connection created through the API without credentials is `pending`, and its
row offers `authorize-<handle>` (*Authorize*). It opens *"Reconnect <handle>"*: the same token-only form without the
provider and handle fields. Continue sends `POST /api/v1/connections/{id}/token` with
`{credentials: {access_token}, allow_non_interactive}` — a route no other spec drives — and a refusal is shown the
same way, leaving the row `pending` with `has_credentials: false`.

### Recorded, not asserted
- **Success** (`authorize` step, *connected*) needs a token the provider accepts: #2503 decides whether the suite takes
  live accounts.
- Which of the provider-dependent refusals a run gets. The test accepts exactly the set `ConnectionService` can
  produce (the same set `api-connections-lifecycle.spec.ts` test 9 accepts), and fails on anything else — a `201`, a
  `5xx`, the no-manual-credentials copy, or WhatsApp's copy on another provider.
- The dialog now preselects **Confluence**, the first provider in the manifest's order (GitHub until `1.14.0.dev23`).
  The test always chooses its provider explicitly.

---

## Tags *(required)*

`@stable`, `@integrations`, `@settings`, `@ui-ux` — the same set as `connection-oauth-wizard.spec.ts`. Not `@api`: the
requests are the page's own, observed rather than sent.

---

## Step by step *(required)*

**The page talks to the server as a throwaway user.** The browser is the superuser (auto-login), but a context route
sends every `/api/v1/connections*`, `/api/v1/integrations` and `/api/v1/users/whoami` request with the token of a
user created for the file (`createConnectionsOwner`, one per worker, deleted with its rows in `afterAll`). The page
then lists, creates and reconnects as that user, and the server's per-user buckets charge that user. Measured on
`1.14.0.dev32`: run beside `connection-oauth-wizard.spec.ts` at `--workers=2` as the superuser, this file's reads
starved the wizard's (60 per minute per user) and failed one of its tests in each of two runs, while the wizard alone
passed 7/7. `whoami` is routed too, so the page agrees about who owns the rows it lists: a row owned by someone other
than the signed-in user is not in the default view. Nothing in this file needs a superuser — a pasted-token
connection is any user's to create.

Every locator is keyed on a unique handle, so the file is parallel-safe. Requires `1.14.0.dev26` (the online token
check): an older build skips with that reason. The five profiles are read from the manifest once, and each test fails
if a profile in the table above is missing or changed.

1. **Each pasted-token provider opens on its token form.** Open *Add connection*; for each of the five, choose it and
   assert the form above: no `connection-method`, `connection-identity` or `connection-scope-*`; the token field and its
   help; the setup guide `href` equal to `docs_url`; the expiry field only for a profile with `requires_expiry`;
   Continue disabled, then enabled once a handle and a token (and, for GitHub, a future expiry) are filled. Sends no
   write.
2. **A refused token is shown verbatim, kept for correction, and stores nothing.** For each of the five: fill a handle
   and a fake token, Continue, and take the `POST /api/v1/connections` the page sends. Assert its body (provider,
   identity and `granted_scopes` from the manifest profile, `allow_non_interactive: false`, the token), the `422`, a
   `detail` inside the accepted set (exactly WhatsApp's copy for WhatsApp), the alert equal to that `detail`, the token
   still in the field, the dialog still open; then edit the token and assert the alert is gone. Finally read the list:
   none of the five handles is there.
3. **GitHub's expiry and the background-runs choice reach the request.** A past expiry: `aria-invalid="true"`,
   Continue disabled, no request. A future one, *Allow background runs* ticked: the `POST` carries
   `allow_non_interactive: true` and `expires_at` equal to that local time in UTC, computed in the page.
4. **Reconnect on a pending row sends the token to the row.** Create a `pending` GitLab connection through the API
   as the throwaway user,
   open the page, click `authorize-<handle>`: the dialog is *"Reconnect <handle>"* with the token form and no
   provider field. Continue: the page sends `POST /api/v1/connections/{id}/token` for that row, the refusal is in
   the alert, and the row read back is still `pending` with `has_credentials: false`.

Cleanup: after each test the throwaway user's list is read and any row carrying one of the test's handles is deleted
(only test 4 creates one on purpose; a refusal that turned into a `201` would be cleaned up too, and test 2 fails on it
first). Deleting the user in `afterAll` takes anything left with it.

---

## Validation criterion *(required)*

- Each provider's form is the token form, with the setup guide its manifest names — a provider gaining a sign-in step,
  an identity choice or a scope list, or losing its token field, fails test 1.
- The dialog shows the server's own refusal, not a generic one, and keeps the token — a dialog that swallowed the
  `detail`, cleared the field or closed fails test 2; a provider that started accepting a fake token (`201`) fails it
  too.
- The request carries the profile's identity and scopes and the user's choices — a dialog that sent the wrong
  identity, dropped `expires_at` or ignored the checkbox fails tests 2 and 3.
- Reconnect writes to the existing row and leaves it unchanged on refusal — a Reconnect that created a second row, or
  a refusal that changed the row, fails test 4.
- Zero `🚨 Backend Error` beyond the refusals the tests provoke, which are declared with `page.allowHttpErrors()`.

---

## External dependencies *(required)*

- A Langflow **1.14** instance from `1.14.0.dev26` (the online token check; the five providers ship from
  `1.14.0.dev23`, GitHub's profile from `1.14.0.dev7`).
- Network egress is **not** required: without it the server answers *"Langflow could not reach the provider. …"*, which
  the accepted set includes.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AddConnectionDialog.tsx` — the token-only
  path, the field error and Reconnect.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/SlackTokenFields.tsx` — the token, expiry and
  background-runs fields every pasted-token provider shares.
- `src/backend/base/langflow/api/v1/connections.py` — the create and `/{id}/token` routes.
- `src/backend/base/langflow/services/connection/service.py` — the online check and its refusals.
- `src/bundles/whatsapp/src/lfx_whatsapp/_messages.py` — WhatsApp's server-settings refusal.
