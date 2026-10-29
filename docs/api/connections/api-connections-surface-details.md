# Connections — the small reachable surface details

**File:** `tests/tests-automations/regression/api/connections/api-connections-surface-details.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev9`)

Owning issue: #2305 (Dedicated Integrations, batch 2). Seven behaviours that are shipped and reachable but too small
for a spec of their own. Each one either gets an assertion here, is already asserted elsewhere (and this doc says
where), or is recorded with the reason it cannot be asserted.

---

## What this test validates *(required)*

Measured on `1.13.0.dev47`. Upstream code read on `release-1.14.0` (`ad4e00b7a4`), where `connections.py`,
`integrations.py`, `knowledge_bases.py` and the deployment-artifact builder are identical to `release-1.13.0`.

### 1. `GET /api/v1/connections?provider=` returns that provider's rows only

The filter's `422` (a value outside `^[a-z0-9][a-z0-9._-]*$`) is already asserted in
`api-validation-redaction.spec.ts`. The positive half is not. With one Google and one Microsoft row:
- `?provider=google` lists the Google row and not the Microsoft one, and every row it lists is a Google row;
- `?provider=microsoft` is the mirror image;
- a well-formed provider id that no row carries answers `200 []`.

The filter goes into the same visibility query as the unfiltered list (`_list_visible_rows`), so a superuser would see
every user's rows here too. The test reads as a throwaway user, which sees its own rows and instance rows.

### 2. `provider_revocation` on revoke

`ConnectionRevokeRead.provider_revocation` is one of `revoked`, `unsupported`, `failed`, `not_applicable`
(`broker.revoke`). What a client can reach without an OAuth registration:

| Row | `provider_revocation` | Why |
|---|---|---|
| Pasted Google token (`ready`) | `not_applicable` | No OAuth binding, not Slack: nothing to revoke at the provider |
| `pending` row (no credential) | `not_applicable` | No stored secret |
| A row already revoked | `not_applicable` | The first revoke removed the secret |
| Pasted Slack app-level token (`xapp-…`) | **`failed`** | A pasted Slack token is revoked with `auth.revoke`. Slack refuses a fake token, and a network failure raises the same `OAuthError`, so the outcome is `failed` with or without egress |

Every revoke also moves the row to `revoked` with `has_credentials: false`, whatever the provider outcome.

The page picks its toast from this field (langflow#15766, #2291): `revoked` → *"revoked"*, `failed` →
`connections.toast.revokeFailed`, anything else → `connections.toast.revokedLocally`. The `not_applicable` toast is
already asserted by `connections-row-actions.spec.ts`. This file asserts the `failed` one:
*"Credential removed from Langflow, but provider revocation failed. Revoke the token in the provider's settings."*
The superuser revokes the throwaway user's `xapp-` row from the page's **Other users** tab. In OSS a superuser may
revoke another user's row (#2300), so the page spends one superuser write and the user's own bucket pays for the rest.

**Not reachable:** `revoked` and `unsupported` need a row with an OAuth binding (Google → `revoked`, Microsoft →
`unsupported`, since Entra has no revocation endpoint for a delegated grant), which only the OAuth callback writes.
That is #2301's fake-registration lane. A pasted Slack bot or user token (`xoxb-`, `xoxp-`) would reach `revoked`, but
the create validates it against Slack and refuses a fake one (*"Slack rejected this token. Paste a valid token and try
again."*).

**Depends on #2317 (PR #2323).** The `xapp-` row is a Slack row. Before #2323, `api-integrations-manifest.spec.ts`
test 3 read its Slack control as the superuser, who counts every user's rows, so this row could move that control
while it lived. After #2323 the control is read as that test's own throwaway user, which counts only its own rows and
instance rows. This row is neither.

### 3. `DELETE` of a `ready` row: the API accepts it, the page locks it

**Already asserted, in two specs:**
- the API half: `api-connections-lifecycle.spec.ts` deletes a row created with a planted credential (`ready`) and gets
  `204`, with the removal re-read from the list. `ConnectionService.delete` revokes first, then deletes;
- the UI half: `connections-row-actions.spec.ts` asserts *Delete* is `aria-disabled` while the row holds a credential,
  and enabled after *Revoke*.

A change to either side already fails one of them, so this file adds nothing for item 3.

### 4. `GET /api/v1/projects/{id}/deployment-snapshot` lists the project's required connections

The backend half of the publication preflight (B10, whose UI is not shipped). The snapshot reads the saved flows, not
the connections table:
- every template field of `type: "connection_ref"` with a non-empty `value` (`<provider>/<name>`) contributes its
  handle;
- handles are merged across nodes, and `scopes` is the sorted union of each field's `required_scopes`;
- a connector node whose handle is blank contributes nothing;
- the handle does **not** need to name an existing connection.

A project holding *Gmail: Send Email* and *Drive: List Files* bound to the same handle, plus an unbound *Calendar:
List Events*, answers `200` with `Cache-Control: no-store` and:

```json
"required_connections": [
  { "provider": "google", "name": "<handle>",
    "scopes": ["https://www.googleapis.com/auth/drive.file", "https://www.googleapis.com/auth/gmail.send"] }
]
```

A project with no flows answers `422 {"detail": "project has no flows to package"}` with
`x-langflow-error-code: snapshot_empty`.

**The snapshot has carried its own `schema_version` since `1.14.0.dev9`** (upstream #15892, which added it together
with `required_variable_declarations`; #2372). Its body is exactly twelve keys: `project`, `flows`, `dependencies`,
`required_variables`, `required_variable_declarations`, `schema_version`, `required_connections`,
`required_providers`, `required_models`, `unresolved_model_fields`, `required_mcp_variables`, `required_mcp_projects`.
Up to `1.14.0.dev8` it had ten, without those two.

The snapshot's `schema_version` is **not** the artifact manifest's, and reading one for the other gets this test's
expected value wrong. The snapshot claims `7` when its flows declare any variable and `1` otherwise: connections, model
providers, MCP requirements and dependencies do not raise it. The manifest built by `build_project_artifact` still
claims `4` for a project that needs a connection (`7` for variable declarations, `6` for MCP requirements, `5` for model
providers, `3` for dependencies, `1` otherwise), and no OSS route calls that function on `release-1.14.0`, so the
manifest is not black-box reachable. This project's flow binds a connection and references no global variable, so its
snapshot answers `schema_version: 1` and `required_variable_declarations: []`. Both are asserted, with the exact key
set. The `7` path (a flow that declares a variable) is not covered here.

**Recorded, not asserted:** the snapshot is owner-scoped even for the superuser. The superuser reading the throwaway
user's project gets `404`, unlike connections, where a superuser sees every row.

### 5. `GET /api/v1/knowledge_bases/connectors` names a provider and scopes for each credentialed connector

Four entries, each with exactly seven keys (`source_type`, `display_name`, `description`, `icon`,
`requires_credentials`, `provider_key`, `required_scopes`). `file_upload` is left out by design (it has its own upload
modal).

| `source_type` | `requires_credentials` | `provider_key` | `required_scopes` |
|---|---|---|---|
| `folder` | `false` | `null` | `[]` |
| `google_drive` | `true` | `google` | `https://www.googleapis.com/auth/drive.file` |
| `onedrive` | `true` | `microsoft` | `Files.Read` |
| `sharepoint` | `true` | `microsoft` | `Files.Read` |

**Cross-check:** every credentialed connector's `provider_key` is a provider of `GET /api/v1/integrations`, and each of
its `required_scopes` is one that provider's capabilities declare. Without that, a connector would ask for a scope no
connection made for the provider could hold, and its ingest would always stop at `scope-missing`.

### 6. A connection never writes a global variable

Upstream's rule for this surface: connections must not appear in `/settings/global-variables`, where provider
credentials land today. The throwaway user's variable names are read before a connection is created, after it is
created with a planted credential, and after it is revoked and deleted. The three sets are equal. (A fresh user has four
default variables on the nightly, which is why the test compares sets instead of expecting an empty list.)

### 7. `deployment_contexts` is not enforced, and this lane cannot show it

`IntegrationListRead.deployment_context` is documented as filtering: *"A capability or auth profile whose deployment
contexts exclude it is not offered here (hosted has no Slack Socket Mode, Desktop no Slack Events API)"*. The handler
reads `deployment_contexts` nowhere: it copies the field into each capability and filters only by policy. #2074
measured it on `1.13.0.dev26` with `LANGFLOW_CONNECTION_OAUTH_CONTEXT=hosted`: the two Socket Mode capabilities,
which exclude `hosted`, were still listed.

On this lane the variable is unset, so the context is `self_managed`, and **all 30 capabilities include
`self_managed`**. On this lane, filtering and no filtering produce the same list. So the test asserts the premise of
that blind spot: the context reads `self_managed` and no listed capability excludes it. The day a capability drops
`self_managed`, this assertion fails, and enforcement becomes observable here.

---

## Tags *(required)*

`@api` `@integrations` `@stable` on every API test. Test 3 drives the page, so it carries `@stable`
`@integrations` `@settings` instead of `@api`.

---

## Step by step *(required)*

**Setup.** `beforeAll` creates one throwaway user per worker through `createConnectionsOwner` (#2295): one login, the
user's own write and read buckets, and no superuser rows. Every row, flow and project is deleted by id in the test
that created it, and `afterAll` disposes the user, which removes anything left.

**Test 1 — the provider filter lists that provider's rows and no other.**
1. The owner creates a Google and a Microsoft row. The unfiltered list carries both, so a filtered list missing one
   is the filter's doing.
2. `?provider=google` carries the Google row's name, not the Microsoft one's, and every row has `provider_key: google`.
3. `?provider=microsoft` is the mirror image.
4. `?provider=<a per-run provider id no row carries>` answers `200 []`.

**Test 2 — revoke reports what happened at the provider.**
1. A `pending` row → `not_applicable`.
2. A planted Google token → `not_applicable`; revoked again → `not_applicable`.
3. A planted `xapp-` Slack token → `failed`.
4. Each response reads `status: revoked`, `has_credentials: false`.

**Test 3 — the page says when the provider revocation failed.** *(Tags `@stable` `@integrations` `@settings`: the only
browser test in the file.)*
1. The owner creates an `xapp-` Slack row.
2. The superuser opens `/settings/connections`, the **Other users** tab, and searches the row's name.
3. *Revoke* answers `200` with `provider_revocation: failed`. The `revokeFailed` toast shows its exact copy, and the
   row's badge reads *Revoked*.
4. The owner's list agrees: `revoked`, `has_credentials: false`.

**Test 4 — the deployment snapshot names the connections a project needs.**
1. The owner creates a project. Its snapshot answers `422` `snapshot_empty`.
2. A flow with Gmail Send and Drive List bound to one handle and Calendar List unbound goes into the project. The
   expected scopes are read from the live catalog.
3. The snapshot answers `200`, `Cache-Control: no-store`, the exact twelve-key body, `schema_version: 1`, no variable
   declaration, one flow, and exactly one `required_connections` entry: the handle with the sorted union of the two
   nodes' scopes.

**Test 5 — the KB connector catalog names a provider and scopes for each credentialed connector.**
1. Each entry carries the exact seven-key set. `folder` is uncredentialed: `provider_key: null`, no scopes.
2. `google_drive`, `onedrive` and `sharepoint` carry the provider and scopes measured above.
3. Each credentialed connector's provider is in the manifest, and each of its scopes is declared by one of that
   provider's capabilities. At least one credentialed connector exists, so the loop cannot pass empty.

**Test 6 — a connection never writes a global variable.**
1. Read the owner's variables (name and id).
2. Create a row with a planted credential; the variables are unchanged.
3. Revoke and delete it (`204`); the variables are still unchanged.

**Test 7 — on this lane's deployment context, no capability is filtered, and none could be.**
1. `GET /api/v1/integrations` reads `deployment_context: self_managed`.
2. No listed capability omits `self_managed` from its `deployment_contexts`.

---

## Validation criterion *(required)*

All tests pass three consecutive times at `--retries=0 --workers=1`, and once at `--workers=2`. On every run:
- no connection, flow, project or throwaway user is left behind;
- each test has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev9` or later: test 4 asserts the twelve-key snapshot) at `PLAYWRIGHT_BASE_URL`, auto-login (the superuser), with user
  self-registration through `POST /api/v1/users/`.
- No provider key and no OAuth registration. One outbound call per revoke of an `xapp-` row (tests 2 and 3): revoking the `xapp-` row makes the backend call Slack's
  `auth.revoke` with a fake token. The outcome is `failed` whether Slack answers or the call cannot leave the instance.
- `src/backend/base/langflow/api/v1/connections.py` — the provider filter, revoke and delete.
- `src/backend/base/langflow/services/connection/service.py` — `list_for_user`, `revoke`, `delete`.
- `src/backend/base/langflow/services/connection/oauth/broker.py` — the `provider_revocation` decision.
- `src/backend/base/langflow/services/connection/oauth/providers.py` — Slack's `auth.revoke` and its errors.
- `src/backend/base/langflow/api/v1/projects.py` — the deployment-snapshot route.
- `src/backend/base/langflow/api/v1/schemas/deployment_snapshot.py` — the snapshot's twelve keys.
- `src/backend/base/langflow/services/deployment_artifacts/builder.py` — `_collect_required_connections`, the
  snapshot's `schema_version` and the artifact manifest's.
- `src/backend/base/langflow/api/v1/knowledge_bases.py` — the connector catalog.
- `src/backend/base/langflow/api/v1/integrations.py` — `deployment_context` and the capabilities' `deployment_contexts`.
- `src/frontend/src/pages/SettingsPage/pages/ConnectionsPage/index.tsx` — the revoke toast chosen from
  `provider_revocation`.
- `src/frontend/src/locales/en.json` — `connections.toast.revokeFailed`.

