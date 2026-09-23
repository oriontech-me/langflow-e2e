# API Connections — the secret boundary (`/api/v1/connections`)

**File:** `tests/tests-automations/regression/api/connections/api-connections-secret-boundary.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev21`)

Owning issue: #1967 (Dedicated Integrations, batch 1 — the `follow-up` exception set;
order and dependencies in the #1971 comment). Seeds through
`tests/helpers/integrations/`, the helpers #1966 built.

---

## What this test validates *(required)*

The Connections page states the promise in its own subtitle — *"Accounts your flows act
through. Tokens stay on the server; only metadata is shown here."* Upstream records it as
the GA item `secret-redaction` (*"no token material in client error payloads, API
responses, logs, or credential reprs"*), `validated`, with five pieces of evidence, **all
of them Python unit tests**. Nothing asserts it from outside the process.

This is the assertion whose failure is a security incident rather than a broken test, and
it is the cheapest black-box check there is: plant a **sentinel**, then prove the string
appears in no response a client can reach — asserted on the raw **text**, never on the
parsed object, because a token nested under an unexpected key survives a key check.

Measured on `langflowai/langflow-nightly:latest` = `1.13.0.dev21`. Every sweep below read
**0** occurrences of either sentinel:

| Response | Status | Sentinels |
|---|---|---|
| `POST /api/v1/connections` (the `201`, with both sentinels in `credentials`) | `201` | 0 |
| `GET /api/v1/connections` | `200` | 0 |
| `PATCH /api/v1/connections/{id}` | `200` | 0 |
| `POST /api/v1/connections/{id}/health` | `200` | 0 |
| `POST /api/v1/connections/{id}/test` | `200` | 0 |
| `POST /api/v1/connections/{id}/revoke` | `200`, 17 keys | 0 |
| a `201` for a credential already past its `expires_at` | `201` | 0 |
| `GET /api/v1/integrations` | `200` | 0 |
| `GET /api/v1/variables/` | `200` | 0 |
| a create refused `422` whose body carried a sentinel | `422` | 0 |
| a duplicate-name create refused `409` | `409` | 0 |

`ConnectionRead` reports `has_credentials: true` and carries **no** credential field: its
16 keys are asserted as an exact set, not as an absence list, because a denylist of
`access_token` / `refresh_token` / `credentials` would miss a new key called `token`,
`secret` or `envelope` — which is the regression this file exists to catch.

## Three premises of the issue that the measurement refutes

The issue was written from a dev19 probe and three of its statements do not hold. Each is
corrected here rather than encoded as an assertion that would pass while testing nothing.

**1. There is no `GET /api/v1/connections/{id}`.** The item path serves `PATCH` and
`DELETE` only; a `GET` falls through to the SPA catch-all and answers
`404 {"detail":"Not Found"}` **for a connection that exists**. So "the sentinel appeared 0
times in `GET /connections/{id}`" is true of a 22-byte body that never contained the
connection — it proves nothing. The sweep uses `PATCH` (a different serializer, and a real
`ConnectionRead`) in its place, and `GET /api/v1/variables/`, where a leaked credential
would be the same incident by another route. #1966 records the same trap for removal.

**2. `POST /{id}/test` with a scope the connection does not hold is not a refusal.**
`check_health` catches `ScopeMissingError` as an `IntegrationError` and returns `200` with
an ordinary `ConnectionRead` — `health: "unhealthy"`, `status` **unchanged** at `ready`,
`status_reason` still `null`. The body does **not** name the missing scope; a client can
see *that* the request was not satisfiable and not *why*. The issue's "assert the refusal
names the missing scope" is therefore untestable as written, and its `page.allowHttpErrors()`
is unnecessary — there is no 4xx here, and an API-only spec has no `page` to hatch anyway
(the fixture's HTTP monitor is installed on the page, not on the request context, which is
why `api-connections-lifecycle.spec.ts` drives six deliberate `422`s with no hatch either).

What is left is worth asserting and is upstream's own stated intent, in the comment beside
that `except`: *"Scope coverage and principal denials describe this request, not the stored
credential, so the connection's status stands."* The spec asserts exactly that, and that a
second `/test` with the held scope returns `healthy` — so the `unhealthy` was about the
request and not about the credential.

**3. `status_reason` is not "only on `status: error`", and the enum has five values.**
`ConnectionStatusReason` is `credential-missing` | `credential-undecryptable` |
`oauth-denied` | `oauth-expired` | `oauth-failed`. And `_record_failed_authorization`
writes `row.status_reason` **unconditionally** while setting `row.status = "error"` only
when the row has no stored secret — so a `ready` connection whose re-authorization is
denied reads `status: "ready"` with `status_reason: "oauth-denied"`. Asserting "a reason
implies error" would pin a contract the code deliberately does not have.

### What is reachable from outside, and what is not

Four of the five statuses are reachable through the API, and **`error` is not**:

| Status | How it is reached | `status_reason` |
|---|---|---|
| `pending` | create without `credentials` | `null` |
| `ready` | create with `credentials` | `null` |
| `expired` | create with a past `expires_at`, then `POST /health` | `null` |
| `revoked` | `POST /revoke` | `null` |
| `error` | **unreachable** — see below | — |

`credential-undecryptable` needs the instance key to change under a stored envelope (a
container restart with a different `LANGFLOW_SECRET_KEY`, not an API call);
`credential-missing` needs the envelope row to vanish while the connection's status is not
already credential-free, which no route does; and every `oauth-*` reason needs a configured
OAuth registration — the nightly answers
`GET /api/v1/connections/oauth/registrations` with `{"registrations":[]}`, so the whole
OAuth failure path is out of reach without provisioning an OAuth app.

So the spec asserts the half it can reach — **`status_reason` is `null` on every status a
client can drive the connection into** — and says here, rather than in a passing test, that
the `error` half is not black-box reachable. The historical defect the issue names (a
rotated key reported as `credential-missing`, sending the user to re-authorize when the fix
is the instance key) is therefore **not** covered by this file, and a spec that appeared to
cover it would be worse than this sentence.

`pending` is left out of the assertion for budget (see below) and is measured above; #1966
already creates a credential-free row.

## Where a 4xx body is the interesting one

A refused body is a response too, and this one has history: before `1.13.0.dev10`
(langflow#15038) a validation `422` echoed the offending `input`, so a create body carrying
`credentials.access_token` would have echoed the token back to the client. The spec sends
three malformed creates **each carrying both sentinels** and asserts the refusal is
redacted:

| Body defect | `type` | `loc` |
|---|---|---|
| `name` with a hyphen | `string_pattern_mismatch` | `["body", "name"]` |
| no `provider_key` | `missing` | `["body", "provider_key"]` |
| an undeclared key next to `provider_key` | `extra_forbidden` | `["body", "provider_id"]` |

These cost **no** write budget: a `422` is refused before the handler runs and the limiter
does not count it (measured for #1966).

## Known deviation — recorded, never asserted as correct

`POST /connections/{id}/health` answers `health: "healthy"` for a connection whose only
credential is a literal sentinel string, with no provider configured: either the check does
not call the provider, or it treats *"a credential exists and decrypts"* as healthy. **The
spec must not assert that `healthy` proves a working credential** — that would pin behaviour
that may be a defect. It asserts the enum transition and that `health_checked_at` is
stamped, and nothing more. Raised on the product side separately; this file does not block
on it.

## Not in scope

- **Log redaction** — needs container log access, which the suite has no lane for.
- **Token material in the flow export** — the saved-flow contract, a separate issue.
- **Reaching `status: error`** — see the reachability table above.

## Preconditions, budget and parallel safety

- **The rate-limit budget decides the shape of this file, and the binding limit is not
  the write bucket.** `POST /{id}/health` and `POST /{id}/test` pass no
  `limit_per_minute` to `check_rate_limit`, so each falls back to the **login** limit:
  measured on `1.13.0.dev21`, calls 1-5 answer `200` and the **6th** answers `429`, in two
  separate per-user buckets. A `VALIDATE` burst is three runs inside a few seconds, so a
  design using two of either bucket per run would `429` on the third run — a red that says
  nothing about Langflow. This file therefore issues **exactly one `/test` (in test 1) and
  exactly one `/health` (in test 5)**, which is also why the sweep of those two routes is
  split across the two tests instead of both living in test 1: they share
  `check_health` → `to_read`, so each is swept once, on its own connection, with its own
  sentinels. Three runs leave two calls of headroom in each bucket for a neighbour spec.
- **Writes** share one per-user bucket of **30/minute** and the suite shares one superuser,
  so #1966's lesson applies too: a burst plus a neighbour exhausted it once already. This
  file spends **7 writes per run** — one journey per connection rather than one connection
  per assertion. The `422` tests spend nothing at all.
- **The scope denial is re-read from the list, not re-probed with a second `/test`.** The
  persisted row is the stronger evidence — it shows the denial wrote nothing — and it costs
  none of the five-per-minute budget.
- **No assertion reads a list length or a position.** Every read filters on the unique
  `name` the test itself sent; for a body refused before it has a usable name, on the
  unique marker in its `display_name`.
- Every sentinel is unique per test **and** per run, so a sweep can never match a
  neighbour's material and call it a leak.
- The sweep reads `GET /api/v1/variables/`, a shared global list: it asserts only the
  **absence** of this run's sentinels, never a length or a row.

---

## Tags *(required)*

`@api` `@integrations` `@regression` `@stable`

`@regression`: the `422` redaction (langflow#15038, fixed in `1.13.0.dev10`) is a
previously-fixed defect this file pins from outside.

`@stable`: no provider key, no model, no run, no network egress — the planted credential
never leaves the instance, and every connection created is deleted by its own teardown.
`@stable` enters in this PR rather than after a seasoning period.

---

## Step by step *(required)*

Five tests over the `request` fixture, each declaring its operations through
`apiCoverage` — the lifecycle sweep, **one test per refused body** (so a failure names the
cause that stopped being redacted rather than a table row), and the status walk. Every name and marker a test sends is registered **before** it is sent, and
`afterEach` reads the list once and deletes only the rows carrying one of them — a `DELETE`
answering `404` is still charged to the write bucket.

**Test 1 — `a planted token reaches no client response across the connection's lifecycle, and scope coverage describes the request rather than the credential`**
1. `POST /api/v1/connections` with `credentials.access_token` and `credentials.refresh_token`
   set to two **distinct** run-unique sentinels, and one `granted_scopes` entry → `201`.
2. The `201`'s raw **text** contains neither sentinel; its key set equals the 16
   `ConnectionRead` keys — so no field carrying material can have been added under any name
   — and it reads `status: "ready"`, `status_reason: null`, `has_credentials: true`,
   `health: "unknown"`, `health_checked_at: null`.
3. `GET /api/v1/connections` → `200`; neither sentinel in the text; the row for this
   `name` carries the same 16 keys.
4. `PATCH /api/v1/connections/{id}` `{display_name}` → `200`; neither sentinel in the text.
5. `POST /api/v1/connections/{id}/test` with a scope the connection does **not** hold →
   `200` (not a refusal, and the body does not name the missing scope); neither sentinel;
   `health: "unhealthy"` and `health_checked_at` stamped — the enum transition only, never
   a claim that a health value proves a working credential — while `status` is **still**
   `"ready"` and `status_reason` is **still** `null`. Scope coverage describes the request,
   not the stored credential.
6. `GET /api/v1/connections` → the persisted row agrees: `status: "ready"`,
   `status_reason: null`, `has_credentials: true`, `health: "unhealthy"`. A re-read rather
   than a second `/test`: it is the stronger evidence (the denial wrote nothing) and costs
   none of the five-per-minute budget.
7. `POST /api/v1/connections/{id}/revoke` → `200`; neither sentinel; **17** keys (the
   `ConnectionRevokeRead` set, which adds `provider_revocation`); `has_credentials: false`.
8. `GET /api/v1/integrations` → `200`; neither sentinel — the manifest counts this
   connection and must not carry its material.
9. `GET /api/v1/variables/` → `200`; neither sentinel — a connection credential must not
   have become a global variable.

**Tests 2-4 — `a create body refused for a hyphenated name` / `for a missing provider_key` / `for an undeclared key` `does not echo the credential it carried`**, one **literal-titled** test per defect in the table above (a parameterized loop would give all three the same template-literal title, which the force-fail gate reads from the AST and cannot resolve), each sending both sentinels in `credentials`:
1. `POST /api/v1/connections` → `422`.
2. The raw **text** of the refusal contains neither sentinel — the redaction
   langflow#15038 shipped, asserted from outside.
3. `detail` has exactly one entry — asserted in the shared helper, since a future `422`
   that stopped carrying `loc` at all must not read as "redacted" — and its `type` and
   `loc` are asserted **in each test**, so a failure points at the body that stopped
   failing for its own reason rather than at a shared table row.

**Test 5 — `status_reason stays null on every status a client can drive the connection into`**
Its connection carries its own pair of sentinels, because this is the file's only
`POST /health` and that route is swept here.
1. `POST /api/v1/connections` with a credential whose `expires_at` is in the past → `201`,
   neither sentinel, `status: "ready"`, `status_reason: null`.
2. `POST /api/v1/connections/{id}/health` → `200`, neither sentinel, `status: "expired"`,
   `status_reason: null`, `has_credentials: true` — the envelope is still stored; it is the
   token that aged out — and `health_checked_at` stamped.
3. `POST /api/v1/connections/{id}/revoke` → `200`, neither sentinel, `status: "revoked"`,
   `status_reason: null`, `has_credentials: false`.
4. Each response's `status` is a member of the five-value `PersistedConnectionStatus`
   enum and each `status_reason` is `null` — asserted as `null`, never as "absent", since
   the field is always present in `ConnectionRead`.

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1` against
`1.13.0.dev21`, with: both sentinels asserted absent from the raw **text** of all eleven
client-reachable responses of test 1, of test 5's three, and of each of the three `422`
bodies (never from the parsed object); the create response asserted as the exact 16-key `ConnectionRead` set and
the revoke response as the 17-key one, so a new field carrying material fails whatever it
is called; `has_credentials: true` with no credential field present; a missing scope
producing `200` + `health: "unhealthy"` with `status: "ready"` and `status_reason: null`
unchanged, re-read from the list rather than re-probed; `status_reason` asserted
`null` across `ready`, `expired` and `revoked`; and each `422` asserted on a one-entry
`detail` by `type` and `loc`. `GET /api/v1/connections` reads back **zero** rows carrying
this file's markers after the run, and the declared coverage — `POST` and
`GET /api/v1/connections`, `PATCH` and `DELETE /api/v1/connections/{connection_id}`,
`POST /api/v1/connections/{connection_id}/health`, `.../test`, `.../revoke`,
`GET /api/v1/integrations` and `GET /api/v1/variables/` — matches what the fixture
recorded.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login or superuser,
  with the default rate limits and **no OAuth registration configured** (the nightly's
  state — see the reachability table).
- `src/backend/base/langflow/api/v1/connections.py` — every route swept here, and the
  per-route rate-limit buckets the budget is sized against.
- `src/backend/base/langflow/services/database/models/connection/schemas.py` —
  `ConnectionRead` (16 keys), `ConnectionRevokeRead` (17), `ConnectionCredentialWrite`
  (write-only `SecretStr`), and the `ConnectionStatusReason` / `PersistedConnectionStatus`
  enums the reachability table is read against.
- `src/backend/base/langflow/services/connection/service.py` — `check_health` and
  `_set_status`: which exception maps to which status, and why a scope denial leaves the
  status alone.
- `src/backend/base/langflow/services/connection/oauth/broker.py` —
  `_record_failed_authorization`, the code path that writes a `status_reason` **without**
  setting `status: error`, which is why "a reason implies error" is not asserted.
- `tests/helpers/integrations/create-connection.ts` and
  `tests/helpers/integrations/delete-connection.ts` — the seeding and teardown helpers.
- These upstream paths resolve on `release-1.13.0` and **not** on `main`, which does not
  carry the feature yet, so the doc-dependency guard reports a `::notice::`, not a failure.
  No provider key, no model, no network egress.
