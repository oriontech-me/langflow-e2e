# Connections — the Add dialog for the site-bound OAuth providers

**File:** `tests/tests-automations/regression/core-functionality/integrations/connection-oauth-site-bound.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2499 (Dedicated Integrations, the 1.14 connector-provider batch #2498–#2503). It depends on #2498's fake
deployment sites and registrations (`docs/api/connections/oauth-fake-registrations.md`). The API half is
`docs/api/connections/api-connections-oauth-site-bound.md`. The same dialog for Google, Microsoft and Slack is
`connection-oauth-wizard.md`, whose way of playing the provider this file reuses.

---

## What this test validates *(required)*

Jira, Confluence, Salesforce and ServiceNow sign in through OAuth only, each bound to one deployment site the server
names. Until #2498 no lane named one, so their registrations were dropped and the Add dialog stopped before consent.
This file walks the dialog to consent for each of the four.

**The test plays the provider**, as `connection-oauth-wizard.spec.ts` does: a context route answers the provider's
authorization URL with a redirect to the instance's real callback, or with a page that never redirects. The
authorization hosts are `https://auth.atlassian.com` for Jira and Confluence, and the fake sites of
`scripts/lib/fake-integration-sites.json` for Salesforce and ServiceNow.

### Measured on `1.14.0.dev32`

**The scope list.** Every scope the provider's registration offers is listed and **ticked** when the dialog opens. A
scope the registration requires (`required_scopes` in `GET /api/v1/connections/oauth/registrations`) is ticked,
**disabled**, and labelled *"Required for this connection"*; every other scope names each action that needs it, with
that action's risk (*Read* / *Write*):

| Provider | Required (locked) | Optional |
|---|---|---|
| Jira | `offline_access` | `read:jira-work`, `read:jira-user`, `write:jira-work` |
| Confluence | `offline_access` | `read:page:confluence`, `read:confluence-user`, `write:page:confluence` |
| Salesforce | `api`, `refresh_token`, `id` | — |
| ServiceNow | `langflow_table_read` (*"Read tickets"*) | `langflow_table_write` (*"Create and update tickets"*) |

The setup guide (`connection-setup-guide`) points at the manifest's `docs_url`
(`https://docs.langflow.org/next/bundles-<provider>`).

**Continue** creates the row (`POST /api/v1/connections`, no credential), opens the consent popup and sends
`POST /api/v1/connections/{id}/oauth/start` with `registration_id: e2e-<provider>` and the ticked scopes. The
authorization URL the popup opens:

| Provider | Origin and path | Provider-specific parameters |
|---|---|---|
| Jira, Confluence | `https://auth.atlassian.com/authorize` | `audience=api.atlassian.com`, `prompt=consent` |
| Salesforce | `<fake site>/services/oauth2/authorize` | `prompt=login consent`, PKCE: `code_challenge` (43 chars), `code_challenge_method=S256` |
| ServiceNow | `<fake site>/oauth_auth.do` | PKCE: `code_challenge` (43 chars), `code_challenge_method=S256` |

All four carry `client_id` (the fake registration's), `redirect_uri` (`…/api/v1/connections/oauth/<provider>/callback`),
`response_type=code`, a 43-character `state`, and `scope` = the ticked scopes joined by spaces. **An unticked optional
scope is in neither the start request nor the authorization URL.**

**A denied consent.** The dialog shows *"The provider denied authorization."* with *Try again*, and — since
`1.14.0.dev10` — deletes the row it created (`DELETE /api/v1/connections/{id}`, `204`).

**A cancelled wait.** While the dialog shows *"Waiting for consent in the provider's window…"*, *Cancel* deletes the
row it created too, with no callback.

**The Continue race.** Continue is enabled before the provider's registration list (`?provider=<id>`) has arrived, and a
Continue sent meanwhile names the provider id as the registration, which the server refuses
(`400 "OAuth registration ID is not configured."`). Measured again here on Jira. Every test waits for that list
before Continue, as the wizard spec does.

### Recorded, not asserted
- *Share with the whole instance* is offered only to a superuser, and ServiceNow then reads *"ServiceNow connections
  belong to an individual user and cannot be shared with the instance."* This file runs the page as a regular user (see
  *Step by step*), which sees neither.
- What a callback carrying a `code` does: it exchanges the code at the provider's real token host. That is
  `docs/api/connections/api-connections-oauth-site-bound.md`'s to record, and no spec sends one.

---

## Tags *(required)*

`@stable`, `@integrations`, `@settings`, `@ui-ux` — the set of `connection-oauth-wizard.spec.ts`.

---

## Step by step *(required)*

**The page talks to the server as a throwaway user**, as in `connection-token-providers.spec.ts`: the browser is the
superuser, and a context route sends every `/api/v1/connections*` (except the OAuth callback), `/api/v1/integrations`
and `/api/v1/users/whoami` request with the token of a user created for the file (one per worker, deleted with its rows
in `afterAll`). The starts (5 per minute per user) and the reads (60 per minute per user) are then that user's. The
callback stays unrouted: it is authenticated by its `state` and binding cookie, not by a token, and its 5-per-minute
budget is per client IP, so the fake provider's `nextCallback` waits a refused one out.

Requires `1.14.0.dev23` (the four providers) and #2498's sites and registrations; without them the registration list
lacks `e2e-<provider>` and the tests **fail**, never skip.

1. **Each site-bound provider lists its scopes, required ones locked, and its setup guide.** For each of the four: open
   *Add connection*, choose the provider, wait for its registration list. Assert the scope checkboxes are exactly the
   registration's scopes, all ticked; the registration's `required_scopes` are disabled and read *"Required for this
   connection"*; each optional scope's label names at least one action with its risk; the setup guide `href` is the
   manifest's `docs_url`. Sends no write.
2. **Consent at each provider starts with the ticked scopes, and a denied or cancelled one leaves no row.** For each of
   the four, with the fake provider stalling: fill a handle, untick `write:jira-work` for Jira only, Continue. Assert
   the create, the start's `registration_id` and scopes, and the authorization URL (origin, path, the common and the
   provider-specific parameters, the unticked scope absent). Then:
   - **Jira and Salesforce** (one Atlassian, one origin provider): the provider denies; the dialog shows the denied
     copy, and the row is deleted (`204`) and gone from the list;
   - **Confluence and ServiceNow**: *Cancel* while waiting; the row is deleted and gone from the list.

Two callbacks per run, not four: the callback budget is per client IP and shared by every spec on the host.

---

## Validation criterion *(required)*

- A site-bound provider whose registration is dropped (a missing site, a changed scope set) fails test 1 by name: its
  registration list is empty, and the dialog has no scopes to list.
- A required scope the dialog let the user untick, an optional one it forced, or a scope list that no longer names its
  actions, fails test 1.
- A start or authorization URL with the wrong registration, scopes, endpoint, audience or PKCE fails test 2 — as does
  an unticked scope that still reaches the provider.
- A denied or cancelled Add that leaves its row behind fails test 2.
- Zero `🚨 Backend Error` beyond the denied callback's `400`, declared with `page.allowHttpErrors()`.

---

## External dependencies *(required)*

- A Langflow **1.14** instance from `1.14.0.dev23`, started with #2498's fake sites and registrations (every lane and
  starter carries them).
- No provider tenant and no egress: the popup's provider is played by the test.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/components/AddConnectionDialog.tsx` — scopes, Continue,
  consent, the discarded row.
- `src/backend/base/langflow/api/v1/connections.py` — the create, `oauth/start` and the callback.
- `src/backend/base/langflow/services/triggers/providers/jira/oauth.py`,
  `src/backend/base/langflow/services/triggers/providers/confluence/oauth.py`,
  `src/backend/base/langflow/services/triggers/providers/salesforce/oauth.py` and
  `src/backend/base/langflow/services/triggers/providers/servicenow/oauth.py` — each provider's endpoints.
