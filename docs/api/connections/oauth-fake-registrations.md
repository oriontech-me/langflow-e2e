# Fake OAuth registrations on every lane

**Last validated:** Langflow 1.14.0.dev32 (`langflowai/langflow-nightly:latest`, 2026-11-19) for the four
site-bound registrations (#2498); 1.14.0.dev2 (2026-10-22) for the first four (#2301).

Owning issues: #2301 (Dedicated Integrations, batch 2) and #2498 (the site-bound providers). Consumed by #2307 (the
Add/Reconnect wizard and the OAuth callback) and #2499 (OAuth for Jira, Confluence, Salesforce and ServiceNow).

---

## What this test validates *(required)*

This document specifies **infrastructure, not a test**. It records a lane configuration and the decision behind
it, and ships no `.spec.ts`. The specs that rely on it are #2307's: `api-connections-oauth-callback.md` and
`docs/core-functionality/integrations/connection-oauth-wizard.md`. `docs/serving/end-user-identity-lane.md` is the
precedent for a `docs/` artifact that specifies a mechanism.

### The gap

The product ships no OAuth registration. `GET /api/v1/connections/oauth/registrations` answers
`{"registrations": []}`, so:
- the Add/Reconnect wizard stops before consent at *"No OAuth registration is configured for this provider"*;
- `POST /api/v1/connections/{id}/oauth/start`, the browser handoff and the callback have nothing to start from.

The surface was therefore untested. QA-CHECKLIST § 24.4 deferred the wizard for exactly this reason.

Registrations come only from operator configuration: `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`, a JSON object keyed by
registration id, instance-global and read at startup.

### What a fake registration reaches

Measured on `1.14.0.dev2` with the four registrations in `scripts/lib/fake-oauth-registrations.json`, and no
provider tenant:

| Call | Result |
|---|---|
| `GET /oauth/registrations` | Lists all four (`e2e-google`, `e2e-microsoft`, `e2e-slack-user`, `e2e-slack-bot`) with their scope ceilings, `Cache-Control: no-store`. |
| `POST /{id}/oauth/start` | `200` with an `authorization_url` on each provider's own host: `accounts.google.com`, `login.microsoftonline.com/<tenant>`, `slack.com/oauth/v2/authorize` (`user_scope=` for the user profile, `scope=` for the bot). It sets the `lf_connection_oauth_*` binding cookie (HttpOnly, `Max-Age=600`, path `/api/v1/connections/oauth`) and the three response headers `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`. **No provider is called.** |
| `GET /oauth/google/callback?state=…&error=access_denied` with the cookie | `400` HTML *"OAuth authorization failed. Return to connections and start again."* with the same three headers. The row moves to `status: error`, `status_reason: oauth-denied`. |

So everything short of a real consent is reachable. The last row also makes `status: error` reachable, which
`api-connections-secret-boundary.md` had recorded as out of reach. `api-connections-oauth-callback.md` covers it (#2307).

### The four registrations

One per provider and Slack profile, all confidential with a visibly fake client id and secret. Each scope ceiling
is the union of the scopes the manifest's capabilities of that provider and identity declare. Slack's
`connections:write` is left out: it is an app-level token scope, not an OAuth one.

The redirect is `http://localhost/api/v1/connections/oauth/<provider>/callback`: loopback HTTP at the exact path,
which the server accepts, and **no port**. No provider will ever redirect to it, because none accepts the fake
client. Leaving the port out means one value serves every lane, whatever port its instance listens on. A spec must
therefore assert the redirect's **path**, never its host.

### The four site-bound providers (#2498)

Jira, Confluence, Salesforce and ServiceNow joined the manifest in 1.14. Each signs in through OAuth only — a pasted
token is refused with `422 "This integration does not support manually entered credentials."` — and each is bound to
**one deployment site** the operator names in a server setting of its own. The provider's OAuth adapter refuses any
registration that is not bound to that site with exactly its scopes, and a refused registration is **omitted** from
`GET /oauth/registrations`. So a fake registration alone reaches nothing: without the site, the server drops it and
says nothing.

The lanes therefore carry four fake sites beside the registrations. Canonical copy:
`scripts/lib/fake-integration-sites.json`.

| Setting | Fake value | What the server accepts |
|---|---|---|
| `LANGFLOW_JIRA_CLOUD_ID` | `00000000-0000-4000-8000-0000000e2e10` | a canonical lowercase UUID |
| `LANGFLOW_CONFLUENCE_CLOUD_ID` | `00000000-0000-4000-8000-0000000e2e11` | a canonical lowercase UUID |
| `LANGFLOW_SALESFORCE_ORIGIN` | `https://e2e-fake.my.salesforce.com` | an HTTPS My Domain origin (`*.my.salesforce.com`) |
| `LANGFLOW_SERVICENOW_ORIGIN` | `https://e2e-fake.service-now.com` | an HTTPS instance origin (`*.service-now.com`) |

Each registration names its site as `tenant`, and the adapters demand these scope sets: Jira `offline_access
read:jira-user read:jira-work write:jira-work`; Confluence `offline_access read:confluence-user read:page:confluence
write:page:confluence`; Salesforce exactly `api id refresh_token`; ServiceNow a subset of `langflow_table_read
langflow_table_write` that includes the read scope.

Measured on `1.14.0.dev32` with these values:

| Call | Result |
|---|---|
| `GET /oauth/registrations` | Lists all eight. A site-bound row carries non-empty `required_scopes`, which every `oauth/start` must request: `offline_access` for Jira and Confluence, `api id refresh_token` for Salesforce, `langflow_table_read` for ServiceNow. The first four carry `[]`. |
| `POST /{id}/oauth/start`, Jira and Confluence | `200`, `https://auth.atlassian.com/authorize` with `audience=api.atlassian.com`, `prompt=consent`. |
| `POST /{id}/oauth/start`, Salesforce | `200`, `https://e2e-fake.my.salesforce.com/services/oauth2/authorize` with `prompt=login consent` and PKCE (`code_challenge_method=S256`). |
| `POST /{id}/oauth/start`, ServiceNow | `200`, `https://e2e-fake.service-now.com/oauth_auth.do` with PKCE (`S256`). |
| `POST /{id}/oauth/start` without a required scope | `400 "Requested scopes must include offline_access for this connection."` (Salesforce: `"… include id, refresh_token …"`). |
| Jira callback, `error=access_denied` with the cookie | `400` HTML *"OAuth authorization failed. …"*; the row moves to `status: error`, `status_reason: oauth-denied`. |
| A pasted credential on Jira or Salesforce | Unchanged: `422 "This integration does not support manually entered credentials."` |
| Manage providers: save a Jira registration bound to the site | `204` (it was `422 "The Jira Cloud deployment site is not configured."` on every lane). |
| … bound to a different site | `422 "Jira requires a confidential OAuth registration bound to the configured site and scopes."` |

Every `oauth/start` answered with the same cookie and three headers as the first four providers. **No provider is
called**: the authorize URL is built locally. Only a token exchange would contact a site — a callback carrying a
`code` — and the Salesforce and ServiceNow hosts are real third-party domains, so a spec that sends a code must expect
whatever they answer for an unknown org (`provider-unavailable`, by the adapters' code).

**What the default instance no longer shows.** Without a site, each adapter refuses with its own copy:
`"The Jira Cloud deployment site is not configured."`, `"The deployment Confluence Cloud site is not configured."`,
`"The Salesforce deployment org is not configured."` and `"The ServiceNow deployment instance is unavailable."`.
These are operator-misconfiguration messages, and the same trade as the registrations applies: losing them on the
lanes costs one copy each, while leaving the sites out costs every OAuth route of four providers. To reproduce the
unconfigured state, start an instance with an **invalid** value (`LANGFLOW_JIRA_CLOUD_ID=none`). An empty value does
not work: the starters write `${NAME:-default}`, which treats empty as unset.

**No runtime check, by the same rule as #2301.** A registration the server drops is invisible at startup, so the
guard is twofold: `scripts/fake-oauth-registrations.test.mjs` mirrors the adapters' rules (site, scope set, profile),
and the specs that use a registration **fail** when it is missing (#2499). If upstream changes a scope set, the unit
test still passes and the server drops the registration; the consuming spec then fails and names it.

**Two settings are deliberately left out.** `LANGFLOW_CONFLUENCE_SPACE_IDS` and `LANGFLOW_SERVICENOW_TABLES` gate
which spaces and tables an action may touch, not the OAuth registration. Their unset state is a contract of its own
(`"Configure one to 100 approved Confluence space IDs …"`), which #2501 decides whether to assert.

### The decision: every lane, no selector

Two shapes were weighed.

| | Fake registrations on every lane's own instance **(chosen)** | A second container plus a lane tag |
|---|---|---|
| Extra container | none | one per run (~1.5 GiB; the QA VM is at ~3 Langflow instances before the kernel SIGKILLs one) |
| Runs in the scheduled daily | yes, at no cost | only if the daily pays for the second container |
| `@stable` for the OAuth specs | possible | no (#1010: no scheduled lane) |
| Lane selector | none | a new tag, excluded from normal lanes |
| What the default instance no longer shows | the *"No OAuth registration"* empty state | nothing |

The lost state is a UI copy the page renders from an empty list, so a spec that needs it can mock
`GET /oauth/registrations` to `{"registrations": []}`. Running the OAuth specs nowhere scheduled has no such
workaround.

The precedent is `LANGFLOW_A2A_ENABLED` (#1240): another product default that hides a whole surface, set on every
lane and pinned there by a test.

**Before deciding, every spec that could depend on the old state was run against an instance with the
registrations** (`1.14.0.dev2`, `--retries=0`):
- `api/connections/` with `core-functionality/integrations/` at `--workers=2`: 55/55;
- `governance/integration-policy-enforcement.spec.ts` in the destructive lane: 7/7.

No spec opens the wizard, and the ones that call `oauth/start` name a random registration id, which still answers
`400 "OAuth registration ID is not configured."`.

### Fail, not skip

The specs that use the registrations must **fail** when the instance has none, never skip. A lane that loses the
variable then goes red, instead of passing while testing nothing (#1010).

To reproduce the product default by hand, start an instance with `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS='{}'`.
Every starter takes the override.

---

## Tags *(required)*

None. This document ships no spec. The consuming specs carry `@integrations`, with `@api` or `@ui-ux`.

---

## Step by step *(required)*

Where the value lives, and what keeps the copies equal:

1. **Canonical:** `scripts/lib/fake-oauth-registrations.json`, readable and reviewed.
2. **Workflows:** `pr-validation.yml`, `manual.yml` and `daily-stable.yml` set it on the Langflow **service**, beside
   the A2A flag. A service starts before any checkout, so it cannot read the file; each carries the compact JSON.
3. **Starters:** `start-langflow-docker.sh`, `start-langflow-pip.sh`, `start-langflow-source.sh`,
   `start-langflow-serving-identity.sh` and `start-langflow-instance-migration.sh` carry it inlined as
   `DEFAULT_OAUTH_REGISTRATIONS='…'` and pass
   `"${LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS:-$DEFAULT_OAUTH_REGISTRATIONS}"`. It is inlined rather than read
   from the file, because the VM lane pipes a starter to `bash -s` on the target, where no file of this repo
   exists. `start-langflow-enterprise.sh` is left out: it does not mirror that environment block.
   The four sites travel the same way: each workflow's Langflow service sets them, and each starter passes
   `NAME="${NAME:-<fake site>}"` right after the registrations.
4. **The QA VM's daily** gets it through `start-langflow-source.sh`. `scripts/lib/vm-env-parity.mjs` classifies it,
   and the four sites, as starter-carried and compares the starter's literals with the daily's values. The reader resolves
   `${NAME:-$DEFAULT_X}` to the single `DEFAULT_X='…'` assignment, the shape `LANGFLOW_SQLITE_PRAGMAS` already takes
   in `run-e2e.sh`.

---

## Validation criterion *(required)*

- `scripts/fake-oauth-registrations.test.mjs` checks five things:
  - the eight entries and the server's validation rules this file could break, including each site-bound
    adapter's: `tenant` equal to its site, its exact scope set, the user profile. A refused registration is
    **omitted** from the list, not reported, so a broken entry would read as a shorter list;
  - every fake site is a value the bundle's own reader accepts, and is used by exactly one registration;
  - every client id and secret is visibly fake, because the repository is public;
  - every one of the eight copies equals `JSON.stringify` of the canonical file byte for byte, and every lane and
    starter carries each site with its canonical value, overridable;
  - no starter reads the file.
- `start-langflow-docker.test.mjs` and `start-langflow-source.test.mjs` execute the starters and parse what reaches
  docker and the server: the canonical JSON by default, `{}` when overridden, and each site by default and when
  overridden.
- `check-vm-env-parity` passes with 16 of 16 variables carried.

---

## External dependencies *(required)*

- A Langflow **1.13+** instance. `oauth/start`, the registration list and the callback shipped with Dedicated
  Integrations.
- No provider tenant, no network egress. `oauth/start` builds the authorization URL locally, and a denied callback
  makes no token exchange.
- `src/backend/base/langflow/services/connection/oauth/config.py` — `OAuthRegistration` and its validation rules,
  and `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`.
- `src/backend/base/langflow/api/v1/connections.py` — the registration list, `oauth/start`, the callback and its
  headers.
- `src/backend/base/langflow/services/triggers/providers/jira/oauth.py`,
  `src/backend/base/langflow/services/triggers/providers/confluence/oauth.py`,
  `src/backend/base/langflow/services/triggers/providers/salesforce/oauth.py` and
  `src/backend/base/langflow/services/triggers/providers/servicenow/oauth.py` — each site-bound adapter's
  `validate_registration` and endpoints.
- `src/bundles/jira/src/lfx_jira/schema.py`, `src/bundles/confluence/src/lfx_confluence/schema.py`,
  `src/bundles/salesforce/src/lfx_salesforce/schema.py` and `src/bundles/servicenow/src/lfx_servicenow/schema.py` —
  where each site setting is read and validated.
- A Langflow **1.14** instance for the site-bound four: Jira ships from `1.14.0.dev10`, Confluence, Salesforce and
  ServiceNow from `1.14.0.dev23`.
