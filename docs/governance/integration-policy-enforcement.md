# Integration Policy — enforcement at discovery, mutation and execution

**File:** `tests/tests-automations/regression/governance/integration-policy-enforcement.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev47`)

Owning issue: #2299 (Dedicated Integrations, batch 2). It closes the bullet `QA-CHECKLIST.md` § 24.3 deferred
to this lane. Batch 1 asserted only the **unrestricted** effective policy (#1968).

---

## What this test validates *(required)*

An operator governs integrations through two fields of the shared policy bundle:

- **`blocked_integration_action_keys`**, a deny-list of capability `policy_keys`
  (`integrations.google.gmail.send`);
- **`approved_integration_provider_ids`**, a provider ceiling.

This file proves the policy is **enforced**, not just stored. A blocked action has to disappear from what a
builder can discover, be refused where it would change state, and stop a flow that already uses it from
running.

Everything below was measured on `1.13.0.dev47` and checked against `release-1.13.0`. The issue's premises
were written from the code; four of them did not hold as worded, and the corrections are part of what this
file asserts.

### Writing the policy

- **The bundle is written whole.** `PUT /api/v1/policy-bundle` is a full replacement, and it requires
  `expected_revision`: without it the write is refused `422` before anything is stored. A stale revision is
  refused `409 {"message": "Policy bundle revision conflict", "expected_revision", "active_revision"}`. An
  integration field the body leaves out is **reset to `[]`**, so every write here sends all six policy sets.
- **What the write refuses** (premise 5, narrower than the issue says):
  - a key that does not start with `integrations.` → `422` on `body.blocked_integration_action_keys`;
  - an action a **loaded** provider does not declare (`integrations.google.nope`) → `422` *"Blocked integration
    action keys must match an action the loaded provider declares: provider 'google' does not declare …"*,
    listing the declared keys.
- **What the write accepts on purpose:** a key under a provider that is **not loaded** (`integrations.nope.x`),
  and an approved id that names no provider. Both let an operator configure policy before a provider is
  installed. Only newly added keys are validated; a key already in the bundle is kept.
- **A refused write changes nothing:** the revision stays where it was.
- **Rollback** (`POST /api/v1/policy-bundle/rollback/{revision}`, body `{expected_revision}`) copies that
  revision's content into a **new** revision, `source: "rollback"`, `rollback_of_revision: <revision>`. A
  revision that does not exist is `404 "Policy bundle revision <n> is missing"`.

### Discovery (premise 1)

With `integrations.google.gmail.send` blocked:

- **`GET /api/v1/integrations`** drops the capability (30 → 29). The `google` provider stays listed, because
  its other actions are still usable. `include_blocked=true` shows it again, with `allowed: false` and
  `blocked_policy_key: "integrations.google.gmail.send"`.
- **`GET /api/v1/all`** drops `ext:google:GmailSendComponent@official` from the `google` category. The
  category and the other Google components stay. `include_blocked=true` (superuser) brings it back.
- **`POST /api/v1/custom_component`** with that component's own code answers **`404 {"detail": "Integration
  not found"}`**. Unblocked, the same body builds (`200`).
- **`GET /api/v1/connections/oauth/registrations`** filters by policy too. The product ships no OAuth
  registration, so this file was written against `{"registrations": []}` and has nothing to see disappear. Every
  lane has carried fake registrations since #2301 (`docs/api/connections/oauth-fake-registrations.md`), so the
  filter is now observable. It is not asserted here yet.

With the ceiling narrowed to `["microsoft"]`, `/integrations` lists only `microsoft`, and no Google or Slack
connector component is left in `/all`.

### Mutation (premise 2, narrower than the issue says)

Mutations are refused per **provider**, not per action. Every refusal is the same body:

`403 {"detail": {"error_code": "policy-blocked", "message": "This integration action is not available under the
current integration policy.", "hint": "Ask an administrator to approve the integration or unblock the action.",
"provider": "google"}}`

| Policy state | create | `oauth/start` | `test` / `health` |
|---|---|---|---|
| one Google action blocked | allowed (`201`) | not refused (`400` "OAuth registration ID is not configured.") | allowed (`200`) |
| **every** Google action blocked | **refused** | **refused** | allowed (`200`) |
| Google outside the ceiling | **refused** | **refused** | **refused** |

- **A refusal is decided before anything is stored.** A refused create leaves no row, and a refused `health`
  leaves `health_checked_at` where it was.
- **`oauth/start` checks the policy before the registration.** The same request answers `400` "not configured"
  when the provider is allowed and `403 policy-blocked` when it is not.
- `PATCH`, revoke, delete and the list carry no policy check (code); this file does not assert them.

### Execution of a saved flow (premise 3)

A flow saved with *Gmail: Send Email* and run through `POST /api/v1/run/{id}` with an API key:

- **Allowed:** `500`, carrying the component's own validation error, *"At least one recipient address is
  required."* That proves the component body ran. It is also why no provider is ever called: every field is
  empty, so the body stops before any network call.
- **Action blocked:** `403 {"detail": {"error_code": "policy-blocked", "message": "This integration action is
  not available: 'integrations.google.gmail.send' is blocked by the current integration policy. Ask an
  administrator to enable it.", …, "retryable": false, "details": {"policy_key":
  "integrations.google.gmail.send"}}}`. The message names the key, and the component's own error is gone: the
  gate runs before the body (`build_results`).
- **Provider outside the ceiling:** `403` with *"The 'google' integration is not available: it is outside the
  approved integration set. Ask an administrator to approve it."*

### Policy data is operator-only (premise 4)

For a non-superuser (the file's throwaway user):

- `include_blocked=true` → `403` on `/integrations` (*"Only superusers can include blocked integrations."*) and
  on `/all` (*"Only superusers can include blocked catalog components."*);
- `GET` and `PUT /api/v1/policy-bundle` → `403`;
- `/integrations/policy/effective` reads `blocked_action_keys: []` while the superuser's reads the key;
- the user's discovery is filtered the same way (29 capabilities).

### The effective policy (premise 7: not a defect)

The issue asked for a `test.fail()` if `/policy/effective` reads `unrestricted: true` with an action blocked.
It does, and **that is the documented contract**: the schema describes `unrestricted` as *"True when no ceiling
is configured, i.e. every loaded provider is allowed."* Blocked actions are reported in `blocked_action_keys`,
not folded into `unrestricted`. So this file asserts the documented meaning both ways:

- `true` with an action blocked;
- `false`, with `approved_provider_ids: ["microsoft"]` and `loaded_provider_ids` still every provider the
  unrestricted manifest listed, under the ceiling. That set is read, not pinned: `1.14.0.dev7` added `github`
  (upstream #15957, #2360), so it is three providers on 1.13 and four from that build.

The issue's second ask, a connection whose only action is blocked "keeps reading `ready` without saying why",
also reproduces, and is also by design. A connection carries no policy field. Upstream's design puts the policy
state on the builder's surfaces instead: catalog, picker, imported node and run errors (B11 in
`design/dedicated-integrations/frontend-surfaces.md`). The catalog and run-error halves are what this file
asserts. The picker and node halves are not shipped (the picker shows no policy state, #2297).

---

## Tags *(required)*

`@api` `@destructive` `@integrations` `@governance`.

**Not `@stable`**, because of the lane, not the test's maturity. The bundle is instance-global: a blocked
action is blocked for every worker sharing the Langflow. `playwright.config.ts` `grepInvert`s `@destructive`
out of every normal run, and the daily has no destructive lane (#1010). Run it alone with `PW_DESTRUCTIVE=1`
(`workers: 1`), like the other governance specs.

---

## Step by step *(required)*

`beforeAll`: read the bundle. If any policy set is non-empty, every test **skips, naming what it found**: a
"blocked ⇒ absent" assertion is unfalsifiable on an instance that already blocks things. Then snapshot it, and
create a throwaway non-superuser (#2295) that owns this file's connections. That way the connection write and
`/health` buckets spent here are not the superuser's.

Every test that writes the bundle restores it in `finally`. `afterAll` restores the snapshot once more and
fails if the active bundle does not match it.

**Test 1 — a blocked action disappears from discovery, and its component no longer builds.**
1. Baseline: `google.gmail.send` is listed and allowed, its catalog key is in `/all`, and its code builds
   through `custom_component` (`200`).
2. Block `integrations.google.gmail.send`. The write answers `200`, echoes the key, and moves the revision by
   one.
3. `/integrations` omits the capability and still lists `google`. `include_blocked=true` shows it with
   `allowed: false` and the key.
4. `/all` omits the key, keeps another Google component, and `include_blocked=true` shows it.
5. `custom_component` with the same code → `404 {"detail": "Integration not found"}`.
6. `/policy/effective`: `blocked_action_keys` is the key, and `unrestricted` stays `true` (no ceiling).
7. A partial block refuses no mutation: a Google connection is created (`201`), and its `health` answers `200`.

**Test 2 — a provider ceiling hides the others and refuses their mutations.**
1. Plant a Google row, and record the `oauth/start` control on it: `400` "OAuth registration ID is not
   configured."
2. Approve `["microsoft"]` only.
3. `/integrations` lists only `microsoft`. `/policy/effective` reads `unrestricted: false`,
   `approved_provider_ids: ["microsoft"]`, and as `loaded_provider_ids` every provider the manifest
   listed before the ceiling.
4. No Google or Slack component of the manifest is left in `/all`.
5. Create a Google row → the exact `403 policy-blocked` body, and no row by that name exists after.
6. `test`, `health` and `oauth/start` on the planted row → the same `403`. `health_checked_at` is unchanged.

**Test 3 — blocking every action of an approved provider refuses its connections, not its checks.**
1. Plant a Google row, then block every Google `policy_key` read from the manifest.
2. `/integrations` no longer lists `google`.
3. Create a Google row → `403 policy-blocked`, and no row is left.
4. `health` on the planted row still answers `200`: only the ceiling refuses checks.

**Test 4 — a saved flow is refused at run time, before its component runs.**
1. Save a flow with *Gmail: Send Email*, every field empty. Create an API key.
2. Allowed: `/run` → `500` carrying *"At least one recipient address is required."*
3. Action blocked: `/run` → `403` with `error_code: policy-blocked`, the message naming the key,
   `details.policy_key`, `retryable: false`, and **not** the component's own error.
4. Ceiling `["microsoft"]`: `/run` → `403` with the "outside the approved integration set" message.

**Test 5 — policy data is operator-only.**
1. With `integrations.google.gmail.send` blocked, as the throwaway user:
   - `include_blocked=true` → `403` on `/integrations` and on `/all`, each with its message;
   - `GET` and `PUT /policy-bundle` → `403`.
2. The user's `/policy/effective` reads `blocked_action_keys: []`, while the superuser's reads the key.
3. The user's `/integrations` also omits the capability.

**Test 6 — the write validates what it can, and a refused write stores nothing.**
1. A key without the `integrations.` prefix → `422` on `body.blocked_integration_action_keys`.
2. An action Google does not declare → `422` naming the provider and the key.
3. A stale `expected_revision` → `409` with `expected_revision` and `active_revision`.
4. After all three, the revision is unchanged.
5. A key under a provider that is not loaded is accepted (`200`): pre-configuration is allowed.

**Test 7 — rollback restores discovery.**
1. Block `integrations.google.gmail.send` and confirm it is gone from `/integrations` and `/all`.
2. Roll back to the revision before the block. The new revision has `source: "rollback"` and
   `rollback_of_revision` set, and an empty deny-list.
3. The capability is listed again, its catalog key is back, and its code builds (`200`).
4. Rolling back to a revision that does not exist → `404 "Policy bundle revision <n> is missing"`.

---

## Validation criterion *(required)*

All seven tests pass three consecutive times with `PW_DESTRUCTIVE=1 --retries=0` against `1.13.0.dev47`, and
the following holds on every run:

- every refusal carries its exact status and body;
- every "allowed" control is asserted next to its refusal, so a policy that refused everything would fail too;
- the active bundle equals the snapshot after the file;
- no flow, connection, API key or throwaway user is left behind.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login, with
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (for `POST /api/v1/custom_component`).
- No provider key, no OAuth registration, no network egress. The run in test 4 stops at the component's own
  input validation when allowed, and at the policy gate when not.
- `src/lfx/src/lfx/services/integration_policy/base.py` — key format, the deny-list and `IntegrationPolicyError`
  messages.
- `src/lfx/src/lfx/services/integration_policy/service.py` — an empty ceiling means unrestricted.
- `src/backend/base/langflow/services/integration_policy_discovery.py` — what `/all` and `custom_component`
  hide.
- `src/backend/base/langflow/api/v1/policy_bundle.py` — the full-replacement write, `expected_revision`, the
  undeclared-key check and rollback.
- `src/backend/base/langflow/api/v1/integrations.py` — `include_blocked`, and how `/policy/effective`
  computes `unrestricted`.
- `src/backend/base/langflow/api/v1/connections.py` and `src/backend/base/langflow/services/connection/service.py`
  — which mutations check the policy, and the `policy-blocked` body.
- `src/lfx/src/lfx/custom/custom_component/component.py` — the run-time gate in `build_results`.
- `src/backend/base/langflow/api/v1/endpoints.py` — `/run`'s `policy-blocked` response and the
  `custom_component` 404.
