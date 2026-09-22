# API Connections — lifecycle contract (`/api/v1/connections`)

**File:** `tests/tests-automations/regression/api/connections/api-connections-lifecycle.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev19`)

Owning issue: #1966 (Dedicated Integrations, batch 1 — the `follow-up` exception set;
order and dependencies in the #1971 comment). The seeding helpers this issue builds,
`tests/helpers/integrations/`, are what #1967, #1969 and #1970 seed through.

---

## What this test validates *(required)*

The create / list / update / delete lifecycle of `/api/v1/connections` — the entity
behind every Dedicated Integrations component (upstream INT-4, `LE-2462`). A saved flow
references a connection and never carries a credential, so this is the contract the
rest of the feature stands on, and nothing in the suite touched it before.

Upstream proves the same contract in-process (`test_connections.py`); this file is the
black-box half — the routes as a client reaches them, on the image the daily runs.

Measured on `langflowai/langflow-nightly:latest` = `1.13.0.dev19` before the spec was
written:

| Operation | Answer |
|---|---|
| `POST /api/v1/connections` with the full body and planted `credentials` | `201`, **16 keys** (the `ConnectionRead` field set), `status: "ready"`, `has_credentials: true`, `health: "unknown"`, `health_checked_at: null`, `status_reason: null`; `granted_scopes` and `executing_identity` (including `account`) echoed as sent |
| … the same without `credentials` | `201`, `status: "pending"`, `has_credentials: false` |
| … an existing `(owner, provider_key, name)` | `409 {"detail":"A connection with this provider and name already exists"}` |
| `GET /api/v1/connections` | `200`, a list of rows with the same 16 keys |
| `PATCH /api/v1/connections/{id}` `{display_name}` / `{allow_non_interactive: true}` | `200`, the updated `ConnectionRead`; the list agrees |
| `PATCH` `{granted_scopes}` / `{status}` | `422`, one `extra_forbidden` entry on `["body", "<field>"]` |
| `DELETE /api/v1/connections/{id}` | `204`, empty body; the row is gone from the list |
| `DELETE` of the same id again, or of an unknown UUID | `404 {"detail":"Connection not found"}` |

And the six malformed create bodies, each refused with **exactly one** error naming its
own cause (the redacted `422` shape since `1.13.0.dev10`, langflow#15038 — no `input`
echoed, so the assertion is on `type` and `loc`):

| Body | `type` | `loc` |
|---|---|---|
| no `provider_key` | `missing` | `["body", "provider_key"]` |
| no `name` | `missing` | `["body", "name"]` |
| no `executing_identity` | `missing` | `["body", "executing_identity"]` |
| `name` with a hyphen (the repo's `uniqueName` idiom) | `string_pattern_mismatch` | `["body", "name"]` |
| an undeclared key (`provider_id` next to `provider_key`) | `extra_forbidden` | `["body", "provider_id"]` |
| `executing_identity` as the string `"user_delegated"` | `model_attributes_type` | `["body", "executing_identity"]` |

### Where the measurement disagrees with the issue

- **16 keys, not 17.** `ConnectionRead` declares 16 fields, on `release-1.13.0` and in
  the image's own `/openapi.json`; the create response and every list row carry exactly
  those. 17 is the **revoke** response (`ConnectionRevokeRead` adds
  `provider_revocation`), which is #1967's and #1970's surface, not this one.
- **There is no `GET /api/v1/connections/{id}`.** The item path serves `PATCH` and
  `DELETE` only, and a `GET` on it falls through to the SPA catch-all, which answers
  `404 {"detail":"Not Found"}` **for a connection that exists**. A "follow-up `GET`
  answers `404`" is therefore true before the delete as well as after it — it cannot
  prove a removal. Removal is re-read from the list (the id is gone) and from a second
  `DELETE`, whose `404` carries the route's own `"Connection not found"`. #1970 and
  checklist § 24.5 inherit this trap.

### Recorded, not asserted

- **An unknown `provider_key` is accepted.** `nosuchprovider` answered `201` and a
  `pending` row, although `GET /api/v1/integrations` lists only `google`, `microsoft`
  and `slack`. `enforce_integration_policy_for_provider` is the only check on create,
  and with no integration policy configured it allows any key matching the pattern.
  Whether a free-form key is intended is an upstream question; this file makes no claim
  either way and always creates with `google`.
- `display_name` and each `granted_scopes` entry are **stripped** by the validators
  (`"  Probe  "` is stored as `"Probe"`). Not asserted: the bodies here send no padding.

### The harness — no OAuth app, no tenant, no provider account

`ConnectionCreate` accepts `credentials` (`access_token` / `refresh_token` /
`token_type` / `expires_at`) directly, so a connection reaches `status: "ready"` with a
planted token and no provider in play. The four traps the issue measured are what the
helper encodes, each of which produced a `422` first:

- `name` must match `^[a-z0-9]+(?:_[a-z0-9]+)*$`, max 64 — `uniqueConnectionName()`
  joins with `_` and keeps the base36 discriminator inside the 64;
- `executing_identity` is an object `{identity, account?}`, never a string;
- `provider_key` has its own, different pattern (`^[a-z0-9][a-z0-9._-]*$`);
- an unknown key is `extra_forbidden`.

### The write budget — a design constraint for the whole batch

Connection writes are rate-limited **per user**, and the suite shares one superuser.
Measured on `1.13.0.dev19` (settings `connection_write_rate_limit_per_minute = 30`,
`connection_metadata_rate_limit_per_minute = 60`; `/health`, `/test` and OAuth start
stay on the login-sized 5/min):

- creates, updates, revokes and deletes share **one bucket of 30 per minute**, and a
  `DELETE` that answers `404` **is counted** — the limiter runs before the lookup;
- a `422` is **not** counted: the body is rejected before the handler runs (35
  malformed creates, then 30 deletes, before the first `429`);
- the refusal is `429 {"detail":"Too many requests. Please try again later.","retry_after":"60"}`
  with `retry-after: 60`.

So every write in this file is spent deliberately: **8 per run** (test 1: 1 create +
3 deletes; test 2: 1 seed + 2 patches + 1 teardown delete; the six `422` tests: none),
and the teardown sweep reads the list before deleting, so it never spends a write on a
row that is already gone. The helpers absorb a `429` in **seeding and teardown only** —
waiting out `retry-after` once, with a logged warning — because there the request is a
precondition, and a batch neighbour exhausting the bucket is not a Langflow defect
(`429` is not an infra signature, so an unabsorbed one would score as attributable and
strip `@stable`). The calls **under test** here are raw and are never retried.

### Parallel safety

A connection is scoped to its owner, and every worker is the same superuser, so two
workers see each other's rows. **No assertion reads the list length or a position.**
Every read filters on the unique `name` (or, for a body refused before it has a name,
the unique marker in its `display_name`) the test itself sent.

---

## Tags *(required)*

`@api` `@integrations` `@stable`

`@stable`: no provider key, no model, no run, no network egress — the planted
credential never leaves the instance. `@stable` enters in this PR rather than after a
seasoning period.

---

## Step by step *(required)*

Eight tests over the `request` fixture, each declaring its operations through
`apiCoverage`. Every name and marker a test sends is registered as it is sent, and
`afterEach` reads the list **once** and deletes, through
`tests/helpers/integrations/delete-connection.ts`, only the rows that carry one of them.

**Test 1 — `a connection is created with its full body, listed by its unique name and deleted by id`**
1. `POST /api/v1/connections` with every field: `provider_key: "google"`, a unique
   `name`, `display_name`, `ownership_mode: "user"`, two `granted_scopes`,
   `executing_identity: {identity: "user_delegated", account: {id, display, tenant_id}}`,
   `allow_non_interactive: false` and planted `credentials` (with a future
   `expires_at`) → `201`.
2. The response's key set equals the 16 `ConnectionRead` keys; the echoed values are
   the ones sent; `owner_id` is a UUID; `status: "ready"`, `has_credentials: true`,
   `health: "unknown"`, `health_checked_at: null`, `status_reason: null`.
3. `GET /api/v1/connections` → `200`; **exactly one** row carries that `name`, and it
   equals the create response.
4. `DELETE /api/v1/connections/{id}` → `204` with an empty body.
5. `GET /api/v1/connections` → no row carries that `id` or that `name` — the removal,
   re-read rather than inferred from the status (#1759/#1777/#1807).
6. `DELETE` the same id again → `404 {"detail":"Connection not found"}`.
7. `DELETE` an unknown UUID → the same `404`.

**Test 2 — `PATCH renames and grants the non-interactive opt-in, and refuses a field it does not declare`**
1. Seed a connection through `createConnectionViaApi` (`allow_non_interactive: false`).
2. `PATCH {display_name}` → `200`; the new `display_name`, and `name`, `id` and
   `allow_non_interactive` unchanged.
3. `PATCH {allow_non_interactive: true}` → `200`; `true`, and the new `display_name` kept.
4. `GET /api/v1/connections` → the row, by `name`, agrees on both fields.
5. `PATCH {granted_scopes: [...]}` → `422`, exactly one `extra_forbidden` on
   `["body", "granted_scopes"]`.
6. `PATCH {status: "revoked"}` → `422`, exactly one `extra_forbidden` on
   `["body", "status"]`.
7. `GET /api/v1/connections` → the row still reads `status: "ready"`, its original
   `granted_scopes` and `allow_non_interactive: true` — the refusals changed nothing.

**Tests 3–8 — `a create body with <cause> is refused with one 422 naming it`**, one test
per cause in the table above (`no provider_key`, `no name`, `no executing_identity`,
`a hyphenated name`, `an undeclared key`, `executing_identity as a string`):
1. `POST /api/v1/connections` with an otherwise valid body carrying the defect → `422`.
2. `detail` has **exactly one** entry, and its `type` and `loc` are the ones in the
   table — so a body fails for its own reason and not for a neighbour's.

---

## Validation criterion *(required)*

All eight tests pass three consecutive times at `--retries=0 --workers=1` against
`1.13.0.dev19`, with the create and list shapes asserted as the exact 16-key set, every
`422` asserted on a one-entry `detail` by `type` and `loc`, the removal proven by the
list re-read **and** the second `DELETE`'s `"Connection not found"` (never by a `GET`
on the item path, which answers `404` for a live connection too), and the declared
coverage — `POST` and `GET /api/v1/connections`, `PATCH` and
`DELETE /api/v1/connections/{connection_id}` — matching what the fixture recorded.
`GET /api/v1/connections` reads back **zero** rows carrying this file's markers after
the run.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login or
  superuser, with the default rate limits (`rate_limit_enabled` on — the lanes set
  nothing).
- `src/backend/base/langflow/api/v1/connections.py` — the router under test, and the
  per-route rate-limit buckets.
- `src/backend/base/langflow/services/database/models/connection/schemas.py` —
  `ConnectionCreate` / `ConnectionUpdate` / `ConnectionRead`, the shapes asserted here.
- `src/backend/base/langflow/services/database/models/connection/model.py` — the
  unique `(owner_id, provider_key, name)` index behind the `409`.
- `src/backend/base/langflow/services/connection/service.py` — `status` derived from
  the presence of credentials, and delete-as-revoke-then-remove.
- `src/lfx/src/lfx/services/settings/groups/security.py` — the
  `connection_write_rate_limit_per_minute` / `connection_metadata_rate_limit_per_minute`
  defaults the write budget above is sized against.
- `tests/helpers/integrations/create-connection.ts` and
  `tests/helpers/integrations/delete-connection.ts` — the seeding and teardown helpers.
- These upstream paths resolve on `release-1.13.0` and **not** on `main`, which does
  not carry the feature yet, so the doc-dependency guard reports a `::notice::`, not a
  failure. No provider key, no model, no network egress.
