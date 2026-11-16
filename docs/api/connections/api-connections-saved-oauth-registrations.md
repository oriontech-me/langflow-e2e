# Connections — saved OAuth registrations (Manage providers API)

**File:** `tests/tests-automations/regression/api/connections/api-connections-saved-oauth-registrations.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev28`)

Owning issue: #2421, a follow-up of #2409 (directive 3). The page half is
`docs/core-functionality/integrations/manage-providers-panel.md`.

---

## What this test validates *(required)*

langflow-ai/langflow#16251 (`c1df9a637db`, first in `1.14.0.dev22`) lets a superuser register OAuth apps for the
whole instance from *Settings › Connections › Manage providers*, stored in the database instead of only in
`LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`. Three routes serve it:

- `GET /api/v1/connections/oauth/registrations/saved`
- `PUT /api/v1/connections/oauth/registrations/saved/{registration_id}`
- `DELETE /api/v1/connections/oauth/registrations/saved/{registration_id}`

Each saved registration is a superuser's `Credential` variable named
`LANGFLOW_OAUTH_REGISTRATION__<id>` holding the registration JSON
(`services/connection/oauth/stored_registrations.py`). After every save or removal the process that handled it
re-merges the environment's registrations with the saved ones. The environment wins for an ID it defines. Other
processes pick a change up only when they restart.

Measured on `1.14.0.dev28`:

### The lifecycle, and what reaches a new connection at once (premise 1)

- `PUT` answers `204`. The saved list (`Cache-Control: no-store`) returns one entry with exactly six keys: `id`,
  `registration`, `has_secret`, `saved_by`, `updated_at` and `status`.
  - `registration` is the object that was sent, minus `client_secret` and `signing_secret`.
  - `has_secret` is `true`.
  - `saved_by` is the saver's username.
  - `status` is `pending`.
- **Within the same process, the save takes effect at once.** The ID appears in
  `GET /api/v1/connections/oauth/registrations?provider=slack`, the list the connection wizard reads. A new Slack
  bot connection's `oauth/start` with that ID returns an authorization URL whose `client_id` and `redirect_uri` are
  the saved ones.
- **Replace** is a second `PUT` to the same ID with a new `client_id` and no secret field. It answers `204`, and that
  answer is itself proof the saved secret was kept: the registration is confidential, and a confidential client
  with no secret is refused (premise 2). The entry then reads:
  - the new `client_id`;
  - `has_secret: true`;
  - a later `updated_at`.

  The next `oauth/start` uses the new `client_id`.
- **Remove** (`DELETE`) answers `204`. The ID then leaves both lists, and `oauth/start` with it answers `400`
  `"OAuth registration ID is not configured."`. A second `DELETE` answers `404` `"Saved OAuth registration not
  found."`.

### An invalid registration is refused with a message that is safe to show (premise 2)

Each refusal answers `422` with this exact `detail`, and saves nothing:

| Sent | `detail` |
|---|---|
| a confidential client with no secret | `Confidential clients require exactly one secret or private key` |
| a redirect URI that is not the provider callback | `OAuth redirect must be HTTPS (or loopback HTTP) at the provider callback` |
| no `client_id` | `OAuth registration field 'client_id' is required.` |
| Microsoft with no tenant | `Microsoft OAuth requires a fixed tenant UUID` |
| a field the registration does not define | `OAuth registration contains unsupported fields.` |
| `Bad_ID` as the path ID | FastAPI's `string_pattern_mismatch` on `["path", "registration_id"]` |

**No refusal echoes the input.** `OAuthRegistration` sets `hide_input_in_errors`, and the server builds every
message itself (`_registration_validation_message`). So neither a secret sent with a bad redirect nor the value of
an unknown field appears in a `422` body.

### The environment wins (premise 3)

Every lane and starter sets four fake registrations (#2301, `scripts/lib/fake-oauth-registrations.json`). Saving
the ID `e2e-slack-bot` with a different `client_id` and scope list answers `204`, and the entry's `status` is
`overridden`. What the instance uses is unchanged:

- the registration list still carries `e2e-slack-bot` with the **environment's** scopes;
- `oauth/start` with it returns the **environment's** `client_id`.

Removing the saved copy (`204`) leaves the environment's registration in the list, unchanged.

### Secrets stay out of every read, including the variable namespace (premise 4)

- Neither the saved list nor the registration list contains the `client_secret` or `signing_secret` sent.
- The registration is stored as the saver's `Credential` variable, yet the saver's `GET /api/v1/variables/` does
  not list it, and neither secret appears in that response.
- `POST /api/v1/variables/` with the name `LANGFLOW_OAUTH_REGISTRATION__<id>` answers `422` `"OAuth registrations
  must be managed from Connections settings."`. This holds for a superuser and a regular user alike, so nobody can
  plant a registration, or overwrite one, through Global Variables. The saved registration is unchanged
  afterwards.

### A regular user is refused (premise 5)

A non-superuser's `GET` on the saved list, `PUT` and `DELETE` each answer `403` `"The user doesn't have enough
privileges"` (`get_current_active_superuser`). The `DELETE` targets an ID that exists. Afterwards the registration
is still listed, unchanged. That the page hides the tab from a regular user is #2410's, in
`connections-page.spec.ts`.

### Measured, not asserted

- **`active` and `removed` need a restart.** A saved registration reads `active` only if the process started with
  it, and `removed` only if the process started with it and it has since been deleted. No lane restarts the
  instance mid-run, so a test can reach `pending` and `overridden` and nothing else. The page shows `Active` for the
  environment's own rows; the UI spec asserts that.
- **The saver's account matters.** Only rows owned by an active superuser count. When the saver is deleted, the
  saved list drops the registration at once, yet the process keeps using it (it stays in
  `oauth/registrations`). The page then shows it as `Active` with `Server environment` as the saver, which it is
  not. The next save or removal, by anyone, re-merges and drops it. That is why this spec removes every
  registration through the API **before** deleting its throwaway superuser.
- **Four of the panel's providers cannot be saved on any lane.** Jira, Confluence, Salesforce and ServiceNow
  refuse a save until the server names their deployment site (`422`, for example `"The Jira Cloud
  deployment site is not configured."`). No lane sets one, so this file saves Slack registrations only.
- **A `403` wins over a malformed body.** A regular user's `PUT` with an empty `registration` answers `403`, not
  `422`: the superuser dependency runs before the body is validated.

---

## Tags *(required)*

`@api` `@integrations` `@stable`; test 5 adds `@auth`.

---

## Step by step *(required)*

**Isolation.** A saved registration is instance-wide state, so the file must not change what any other spec
reads. Every ID it saves is a **Slack `bot`** registration with an ID unique to the test. No other spec reads that
provider/profile pair:
- the wizard spec asserts there is no registration picker for **Google**, and it reconnects **Microsoft**;
- its Slack step reads the sign-in methods, not the registrations.

The override in test 3 uses `e2e-slack-bot`, which the environment keeps using whatever is saved. The UI spec
overrides `e2e-slack-user` instead, so the two files never write the same ID. Each test removes what it saved in
`finally`, through the API, so the process's own environment is re-merged too.

**Owner and budget.** `beforeAll` creates a throwaway user through `createConnectionsOwner` (#2295) and promotes it
to superuser (the pattern of `api-connections-resolution-non-interactive.spec.ts`). Every call is sent with its
token on the test's own `request`. This gives the file its own write bucket (30/min) and `oauth/start` bucket
(5/min) instead of the shared superuser's, and makes `saved_by` a name only this file uses. The file spends four
`oauth/start` calls per run, under that bucket's 5/minute. Test 5 creates its regular user on its own, so a run costs two logins.
`describe.configure({ mode: "default" })` keeps the file in one worker, so the owner is created once per run.

**Gate.** `1.14.0.dev22` or later (`servedVersionAtLeast`), else the file skips. The 1.13.x line has no panel. The
fake registrations must be served; if `e2e-slack-bot` is missing from the registration list, test 3 fails rather
than skips (#2301).

**Single-process premise.** The "at once" assertions read the process that handled the save. Every scheduled and
PR lane pins `LANGFLOW_WORKERS=1`. `manual.yml` does not, and there these assertions can read another worker.

**Test 1 — a saved registration is listed without its secrets, used by the next consent at once, replaced with its
secret kept, and removed.**
1. The ID is in neither the saved list nor the Slack registration list.
2. `PUT` a confidential Slack `bot` registration with a `client_secret` and a `signing_secret` → `204`.
3. The saved list has exactly one entry for the ID, with the six keys. Its `registration` equals what was sent minus
   the two secrets, `has_secret` is `true`, `saved_by` is the owner's username and `status` is `pending`. The list
   carries `Cache-Control: no-store`.
4. The Slack registration list carries the ID, with profile `bot` and the saved scopes.
5. The owner creates a Slack bot connection with no credential. Its `oauth/start` with the ID → `200`, and the
   authorization URL carries the saved `client_id` and `redirect_uri`.
6. `PUT` again with a new `client_id`, a second scope and no secret → `204`. The entry reads the new `client_id`,
   `has_secret: true`, a later `updated_at` and `pending`.
7. `oauth/start` again → `200` with the new `client_id`.
8. `DELETE` → `204`. The ID is gone from both lists. `oauth/start` with it → `400` `"OAuth registration ID is not
   configured."`. A second `DELETE` → `404` `"Saved OAuth registration not found."`.

**Test 2 — an invalid registration is refused with a message that names the problem, and never echoes what was
sent.**
1. The six refusals in the premise 2 table, each `422` with its exact `detail`. Each body contains neither the
   secret sent nor the unknown field's value.
2. The saved list does not carry the ID.

**Test 3 — an ID the environment defines stays the environment's: saved as overridden, not used, and removable
without touching it.**
1. The registration list carries `e2e-slack-bot` with the environment's scopes (from
   `scripts/lib/fake-oauth-registrations.json`).
2. `PUT e2e-slack-bot` with another `client_id` and one scope → `204`. Its entry reads `overridden` and `saved_by`
   the owner.
3. The registration list still carries the environment's scopes for it. `oauth/start` on a Slack bot connection
   with it returns the environment's `client_id`.
4. `DELETE e2e-slack-bot` → `204`. The registration list still carries the environment's registration, unchanged.

**Test 4 — a saved registration's secrets reach no read, and its storage cannot be written as a global variable.**
1. `PUT` a registration with a `client_secret` and a `signing_secret`.
2. Neither secret appears in the saved list or the registration list.
3. The owner's `GET /api/v1/variables/` lists no name starting with `LANGFLOW_OAUTH_REGISTRATION__`, and neither
   secret appears in it.
4. The owner's `POST /api/v1/variables/` named `LANGFLOW_OAUTH_REGISTRATION__<id>` → `422` with its message. The
   saved entry is unchanged: same `client_id`, `has_secret: true`.

**Test 5 — a regular user is refused on all three routes and changes nothing.**
1. The owner saves a registration.
2. A throwaway regular user's `GET` on the saved list, its `PUT` to that ID and its `DELETE` of it each → `403`
   `"The user doesn't have enough privileges"`.
3. The same user's `POST /api/v1/variables/` named `LANGFLOW_OAUTH_REGISTRATION__<id>` → `422` with the reserved-name
   message.
4. The owner's saved list still carries the entry, unchanged.

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1` against `1.14.0.dev28`, and once at
`--workers=2`. On every run:
- each refusal carries its exact status and `detail`;
- no secret sent appears in any response;
- no saved registration and no throwaway user is left behind (the saved list carries no ID the file created).

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.14.0.dev22 or later** at `PLAYWRIGHT_BASE_URL`, auto-login (the superuser), one worker
  process (`LANGFLOW_WORKERS=1`).
- The fake OAuth registrations of #2301 in `LANGFLOW_CONNECTION_OAUTH_REGISTRATIONS`, which every lane and starter
  sets. No provider is ever called: `oauth/start` only builds a URL.
- `src/backend/base/langflow/api/v1/connections.py` — the three routes, the superuser dependency and the response
  model.
- `src/backend/base/langflow/services/connection/oauth/stored_registrations.py` — storage, merge, status and the
  secret fields.
- `src/backend/base/langflow/services/connection/oauth/config.py` — `OAuthRegistration` and its messages.
- `src/backend/base/langflow/services/variable/constants.py` — the reserved variable prefix.
- `src/backend/base/langflow/api/v1/variable.py` — the `422` on a reserved name.
