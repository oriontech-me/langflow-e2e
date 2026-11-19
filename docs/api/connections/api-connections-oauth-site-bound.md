# Connections API — OAuth for the site-bound providers

**File:** `tests/tests-automations/regression/api/connections/api-connections-oauth-site-bound.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev32`)

Owning issue: #2499 (Dedicated Integrations, the 1.14 connector-provider batch #2498–#2503). It depends on #2498's fake
deployment sites and registrations (`oauth-fake-registrations.md`). The dialog half is
`docs/core-functionality/integrations/connection-oauth-site-bound.md`.

---

## What this test validates *(required)*

Jira, Confluence, Salesforce and ServiceNow are bound to one deployment site the server names, and their OAuth adapters
refuse any registration that is not bound to it. #2498 gives every lane a fake site and a fake registration for each.
This file asserts, through the API, what that reaches: the registrations the server serves, a start that leaves out a
required scope, an expired callback, and Manage providers saving a registration for each of the four.

### Measured on `1.14.0.dev32`

**The served registrations.** `GET /api/v1/connections/oauth/registrations` lists `e2e-jira`, `e2e-confluence`,
`e2e-salesforce` and `e2e-servicenow`, each `self_managed` and `confidential`, with the scopes of
`scripts/lib/fake-oauth-registrations.json` and these `required_scopes`:

| Registration | `required_scopes` |
|---|---|
| `e2e-jira`, `e2e-confluence` | `offline_access` |
| `e2e-salesforce` | `api`, `id`, `refresh_token` |
| `e2e-servicenow` | `langflow_table_read` |

**A start without a required scope** answers `400` naming what is missing, and writes nothing to the row:
`"Requested scopes must include langflow_table_read for this connection."` (ServiceNow) and
`"Requested scopes must include id, refresh_token for this connection."` (Salesforce asked for `api` alone).

**An expired callback.** A start, then the callback with its `state` and binding cookie but neither `code` nor `error`:
`400` *"OAuth authorization failed. Return to connections and start again."*, and the row reads `status: error`,
`status_reason: oauth-expired`, `has_credentials: false`.

**Manage providers.** As a superuser, `PUT /api/v1/connections/oauth/registrations/saved/{id}` with a registration
bound to the provider's fake site answers `204` for each of the four (with `context: "hosted"`, so it never joins the
list the dialogs read). Bound to a **different** site it answers `422` with the adapter's own message:

| Provider | `422 detail` |
|---|---|
| Jira | *"Jira requires a confidential OAuth registration bound to the configured site and scopes."* |
| Confluence | *"Confluence requires a confidential registration bound to the configured site and scopes."* |
| Salesforce | *"Salesforce requires a confidential registration bound to the configured org and scopes."* |
| ServiceNow | *"ServiceNow requires a confidential registration bound to its configured instance and scopes."* |

Before #2498 every one of these answered `422 "… deployment site is not configured."` on every lane.

### Recorded, not asserted
- **A callback carrying a `code`.** It makes the server exchange the code at the provider's **real** token host
  (`auth.atlassian.com`, or the Salesforce domain of the fake site), which refuses a fake client: `400` in ~0.5 s, and the
  row reads `error` / `oauth-failed` with no credential (Jira and Salesforce, measured). The suite does not call the
  public internet from a spec (#1128), so this stays a measurement.
- **A denied callback** is the dialog's to assert, for Jira and Salesforce (`connection-oauth-site-bound.md`).

---

## Tags *(required)*

`@stable`, `@api`, `@integrations`.

---

## Step by step *(required)*

Connections are owned by a throwaway user (`createConnectionsOwner`, one per worker), and saved registrations by a
throwaway user promoted to superuser (`createRegistrationsOwner`): this file spends their buckets — starts are 5 per
minute per user — and never the shared superuser's. Requires `1.14.0.dev23` and #2498's sites; without them the tests
**fail**, never skip.

1. **The four site-bound registrations are served with their required scopes.** Read the registration list; assert each
   of the four is present, `self_managed`, `confidential`, carries the canonical file's scopes and the
   `required_scopes` above.
2. **A start that leaves out a required scope is refused, naming it.** Create a `pending` ServiceNow and a `pending`
   Salesforce connection; start each without its required scopes; assert the `400` and its exact `detail`, and that the
   row is still `pending` with `status_reason: null`.
3. **An expired callback marks the row.** Start the ServiceNow connection with its required scope, send the callback
   with the `state` and the binding cookie and nothing else; assert the `400` page and the row
   `error` / `oauth-expired` / no credential.
4. **Manage providers saves each site-bound registration on its site, and refuses one bound elsewhere.** For each of the
   four, as the promoted owner: save one bound to the fake site (`204`, `context: "hosted"`, then absent from the
   active list) and one bound to another site (`422`, the message above); remove what was saved.

Cleanup: the owners are deleted in `afterAll`, taking their rows with them; saved registrations are removed in the test
that saved them, and again in `afterEach` if a step failed first.

---

## Validation criterion *(required)*

- A site-bound registration the server drops (a missing or changed site, a changed scope set) fails test 1 by name.
- A start that lets a required scope be left out, or refuses one without naming the scope, fails test 2.
- A callback without a code that does not mark the row `oauth-expired`, or stores a credential, fails test 3.
- Manage providers refusing a registration bound to the configured site, or accepting one bound to another, fails
  test 4.
- Zero `🚨 Backend Error`; the deliberate `400`s and `422`s are the tests' subject and are declared.

---

## External dependencies *(required)*

- A Langflow **1.14** instance from `1.14.0.dev23`, started with #2498's fake sites and registrations.
- No provider tenant and no egress: nothing here sends a `code`.
- `src/backend/base/langflow/api/v1/connections.py` — the registration list, `oauth/start`, the callback, Manage
  providers.
- `src/backend/base/langflow/services/connection/oauth/config.py` — `OAuthRegistration` and the adapters' hook.
- `src/backend/base/langflow/services/connection/oauth/stored_registrations.py` — saved registrations.
- `src/backend/base/langflow/services/triggers/providers/jira/oauth.py`,
  `src/backend/base/langflow/services/triggers/providers/confluence/oauth.py`,
  `src/backend/base/langflow/services/triggers/providers/salesforce/oauth.py` and
  `src/backend/base/langflow/services/triggers/providers/servicenow/oauth.py` — each adapter's
  `validate_registration`.
