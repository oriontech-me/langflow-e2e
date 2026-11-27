# API keys — scoped permissions are unavailable on OSS, and keys stay full-access

**File:** `tests/tests-automations/regression/api/auth/api-key-permissions-oss.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev39`)

Owning issue: #2573 (Wave 12 — 1.14 OSS features).

---

## What this test validates *(required)*

Langflow 1.14 adds **scoped API keys** (upstream langflow-ai/langflow#16000). A key can
carry a permission policy that restricts it to roles and resource actions, edited from
*Settings › API keys*. The authorization service enforces the policy. On OSS that service
is a pass-through that does not support key scopes. The OSS build therefore has to degrade
to "not available", and that degradation is the contract this spec pins.

Both ways of getting it wrong are bad, and the code makes the second one concrete.
`_scoped_key_can_authenticate` (`api_key/crud.py`) **refuses to authenticate any key that
has a stored policy while authorization is off**. So if OSS ever accepted a policy write,
the key would not become "restricted". It would stop working entirely, silently. The other
failure is an editor that lets a user "restrict" a key that in fact stays full-access.

The spec covers four things:

1. **Unsupported, stated.** The options endpoint says so plainly.
2. **Cannot be set**, by either route that writes a policy: `PATCH …/permissions` and
   `POST /api_key/` with `permissions`. A refused write leaves nothing behind.
3. **Still full-access.** A positive control, so that "unsupported" never reads as
   "broken": after a refused write, the key still authenticates, creates a flow and runs
   it.
4. **The UI matches the API.** A read-only notice is shown instead of an editor, and the
   create-key modal has no scope step.

Contracts measured on `1.14.0.dev39`, with an auto-login bearer:

| Operation | Answer |
|---|---|
| `GET /api/v1/api_key/permission-options` | `200 {"supported": false, "roles": [], "resource_actions": {}, "scope_types": {}}` |
| `PATCH /api/v1/api_key/{id}/permissions` with a well-formed policy (`{"restrictions": [{"resource_type": "flow", "actions": ["read"]}]}`) | `403 "Scoped API keys require enabled authorization"`; the key's `permissions` stays `null` |
| `PATCH …/permissions` with `{"permissions": {}}` | `422`, `loc ["body","permissions"]`, `"Value error, Restricted keys require roles or explicit restrictions"`. Shape validation runs before the authorization check |
| `PATCH …/permissions` with `{"permissions": null}` | `200`, `permissions: null`, `api_key: "********"`. Removing a ceiling is allowed. On OSS it is a no-op that can only ever widen a key |
| `PATCH …/permissions` on an unknown id | `404 "API Key not found"` |
| `POST /api/v1/api_key/` with the same well-formed `permissions` | `403 "Scoped API keys require enabled authorization"`, and **no key is created** |

The authentication controls were measured on a cookie-less request context. The
auto-login cookie authenticates on its own: with it, `POST /flows/` accepted a **bogus**
key with `201`. A spec that kept the cookie would prove nothing about the key.

| With header | `POST /api/v1/flows/` | `POST /api/v1/run/{id}` |
|---|---|---|
| none | `403 "No authentication credentials provided"` | `403` (auto-login message) |
| `x-api-key: <bogus>` | `403 "Invalid API key"` | `403 "Invalid or missing API key"` |
| `x-api-key: <the key>` | `201`, the flow's `user_id` is the key owner | `200`, the echo comes back; `POST /api/v2/workflows` sync too |

Each authenticated call increments the key's `total_uses` by one: create, v1 run and v2
run gave `+3`.

**The UI does render a permissions column.** The issue expected none. What renders
instead is the fallback the issue named, a read-only notice that says why:

- The grid has a `Permissions` column (`col-id="permissions"`). Every key's cell reads
  **"Full owner access"**, as a button named **"Edit permissions for <name>"**.
- That button opens **"Permissions for <name>"**. The modal shows one alert,
  *"Scoped key management requires enabled authorization support. Existing key limits
  have been preserved."*, has no form control at all, and keeps **"Save permissions"
  disabled**. Opening it sends `GET …/permission-options` and no write.
- The create-key modal (`api-key-button-store`) has only the name, the expiry and
  "Generate API Key". There is no permissions text and no scope control. The key it
  creates has `permissions: null`.

**Known product defect (found here, `REGRESSIONS.md` Candidates, #2573): a repeated
options read blocks key creation.** Every page component reads `permission-options`
through one shared query, `useGetApiKeyPermissionOptions`. It runs with `retry: false`
and `staleTime` 0, so each Permissions dialog mount refetches it. When that GET repeats
within 300 ms of the previous request, the axios duplicate-request guard
(`check-duplicate-requests.ts`) throws in the browser, so no request reaches the
network and no HTTP error is logged. The query errors. From then on, the Permissions
dialog shows a second alert, *"Could not load permission options. Key creation and
permission changes are unavailable until they load."*, and *Add New* shows the same
alert with **Generate API Key disabled** until a refetch (tab focus) or a reload.

Measured on `1.14.0.dev39`:

- Closing and reopening a key's Permissions at once blocked creation in 6 of 9 runs.
- Test 5 hit the race on its own in 1 of 8 runs: it clicks the cell 301–506 ms after the
  page's own read, at the edge of the window.

Test 5 is deliberately left as it is, and a red with **two alerts** in its dialog is this
defect, not a spec bug. Do not add a wait to step around it. Triage such a red against
the ticket once filed.

**Out of scope, handed to #2574: queued admission.** Upstream revalidates a key's
credentials when a queued job starts (`authorize_job_start`). A background job whose key
is deleted while the job waits in the queue is refused with *"Job authorization is no
longer valid."* On the in-process backend nothing waits: `POST /api/v2/workflows` in
`mode: "background"` starts the run as soon as the `202` returns. In 5 of 5 attempts,
deleting the key immediately after the `202` still let the job finish `completed` with
its output. The window is reachable only on a backend that actually queues, which is
#2574's subject.

---

## Tags *(required)*

- API tests: `@stable` `@api` `@auth`
- UI tests: `@stable` `@auth` `@settings`

No test calls a model, so none depends on a provider.

---

## Precondition *(required)*

- A Langflow **1.14+** OSS instance at `PLAYWRIGHT_BASE_URL`, with auto-login or the
  superuser.
- `GET /api/v1/api_key/permission-options` decides the precondition:
  - **`404`** means the build predates scoped keys, and every test skips, naming that.
  - **`supported: true`** means an authorization plugin that enforces scopes is active.
    That is the Enterprise contract, not this one, and the suite **fails**. A green
    all-skip would hide either a lane pointed at the wrong instance or an upstream change
    of the OSS default (#1010).

---

## Step by step *(required)*

The tests are independent and parallel-safe. Every key gets a per-test unique name. Its
id is recorded the moment it exists, and `afterEach` deletes exactly those ids, plus the
one flow test 4 creates. The API tests declare their operations with
`apiCoverage.declare()`.

**Test 1 — `permission-options states that scoped keys are unsupported, with no options`**

1. `GET …/permission-options` → `200`, body **equal** to
   `{supported: false, roles: [], resource_actions: {}, scope_types: {}}`.

**Test 2 — `a key's permissions cannot be set, and a refused write leaves the key unchanged`**

1. Create a plain key → `permissions: null`.
2. `PATCH` a well-formed policy → `403` with the exact detail. Re-read the key from
   `GET /api_key/` → `permissions` still `null`.
3. `PATCH {"permissions": {}}` → `422`, with the measured `loc` and message.
4. `PATCH {"permissions": null}` → `200`, `permissions: null`, the secret masked as
   `"********"`.
5. `PATCH` an unknown id → `404 "API Key not found"`.

**Test 3 — `a key cannot be created with permissions, and the refusal creates nothing`**

1. `POST /api_key/` with a unique name and the well-formed policy → `403`, exact detail.
2. `GET /api_key/` → no key carries that name.

**Test 4 — `after a refused restriction the key keeps full owner access: it creates and runs a flow`**

1. Create a key and read its `total_uses` (`0`). `PATCH` a well-formed policy → `403`.
2. In a **cookie-less** request context: `POST /flows/` with no header, then with a bogus
   key → `403` both times (the negative controls).
3. With the key: create a Chat Input → Chat Output flow from the live catalog. Its
   `user_id` is the key owner's.
4. With the key: `POST /api/v1/run/{id}` and `POST /api/v2/workflows` (`mode: "sync"`)
   with distinct sentinels → `200`, and each echoes its own sentinel.
5. Re-read the key → `total_uses` is exactly `3` (create, v1 run, v2 run), and
   `permissions` is still `null`.

**Test 5 — `Settings › API keys shows the permissions read-only: full owner access, an unavailable notice, Save disabled`**

1. Create a key over the API and open `/settings/api-keys`.
2. The grid header has `Permissions` at `col-id="permissions"`. The key's cell reads
   "Full owner access".
3. Click "Edit permissions for <name>". The dialog "Permissions for <name>" shows the
   unavailable alert with its exact text, holds no `input` / `select` / `radio` /
   `combobox`, and keeps "Save permissions" disabled.
4. No `PATCH …/permissions` was sent while the dialog was open. Cancel closes it.

**Test 6 — `the create-key modal has no scope step, and the key it creates is full-access`**

1. Open "Add New" (`api-key-button-store`). Wait for the page's
   `GET …/permission-options` to answer `200`, and for "Generate API Key" to be enabled.
   The button stays disabled while the options load, so an enabled button proves the
   modal has settled. Only then assert that the dialog contains no "Permissions",
   "Full owner access" or "Restricted" text. Without that wait the absence check passes
   vacuously: a force-fail that mocked `supported: true` showed it passing before the
   editor had rendered.
2. Fill a unique name (placeholder "My API Key") and click "Generate API Key"
   (`secret_key_modal_submit_button`). The captured `POST /api_key/` body has no
   `permissions` key.
3. Over the API, the key with that name has `permissions: null`. Its id joins the cleanup.

---

## Validation criterion *(required)*

Three consecutive passes at `--retries=0 --workers=1`, with:

- every refusal asserted on status **and** exact `detail` (or `loc` plus message), never
  on the status alone;
- every refused write followed by a re-read proving nothing changed: the policy is still
  `null`, and no key exists with the refused creation's name;
- the positive control running on a cookie-less context, with its negative controls
  (no header, bogus key) refused first, and `total_uses` matching the exact number of
  calls made with the key;
- the UI asserted on the exact alert text, the disabled Save and the absence of form
  controls, plus zero permission writes sent from the page;
- no key and no flow left behind.

---

## External dependencies *(required)*

- A running Langflow 1.14+ **OSS** instance at `PLAYWRIGHT_BASE_URL`, with no
  authorization plugin enforcing key scopes.
- No provider key, no model, no network egress.
- Upstream sources the contract was read from (`langflow-ai/langflow@release-1.14.0`):
  - `src/backend/base/langflow/api/v1/api_key.py`
  - `src/backend/base/langflow/services/database/models/api_key/crud.py`
  - `src/backend/base/langflow/services/database/models/api_key/permissions.py`
  - `src/backend/base/langflow/services/jobs/api_key_authorization.py` (the queued
    admission handed to #2574)
  - `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/components/PermissionsCellRender/index.tsx`
  - `src/frontend/src/pages/SettingsPage/pages/ApiKeysPage/helpers/column-defs.ts`
  - `src/frontend/src/modals/secretKeyModal/index.tsx`
  - `src/frontend/src/components/core/apiKeyPermissionsEditor/index.tsx`
