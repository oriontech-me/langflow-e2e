# Connections — cross-user isolation and ownership

**File:** `tests/tests-automations/regression/api/connections/api-connections-ownership.spec.ts`

**Last validated:** Langflow 1.13.x (`1.13.0.dev47`)

Owning issue: #2300 (Dedicated Integrations, batch 2). It closes the last bullet of `QA-CHECKLIST.md` § 24.6,
*"Cross-user isolation: one user's connection is invisible and unusable to another"*, which waited on a second
user.

---

## What this test validates *(required)*

Connections are owner-scoped. Batch 1 showed the Settings page sorting rows into `Mine` / `Other users` (#1969),
but never that a user is **refused** on someone else's row. This file runs the boundary through the API with two
throwaway non-superusers, **A** (the owner) and **B** (the other user), plus the superuser.

Measured on `1.13.0.dev47`:

### Another user's row is indistinguishable from a missing one (premise 1)

B sends six requests on A's row: `PATCH`, `POST …/test`, `POST …/health`, `POST …/revoke`, `POST …/oauth/start`
and `DELETE`. Each one answers **`404 {"detail": "Connection not found"}`**, byte for byte what the same request
answers for an id that does not exist. Ownership is not an existence oracle. A's row is unchanged afterwards. B's
list does not carry it, either unfiltered or filtered with `?provider=google`.

### Instance rows: shared to read, superuser-only to change (premise 2)

- B's create of an instance row → `403 {"detail": "Only a superuser may create an instance connection."}`.
- B's `PATCH`, `revoke` and `DELETE` of the superuser's instance row → `403 {"detail": "Only a superuser may
  change or remove an instance connection."}`. The row is unchanged.
- **B's list does carry the instance row.** That is why B gets a `403` here and not the `404` of premise 1: the
  row is visible to B, but it is not B's to change. Any non-anonymous principal may resolve an instance row, a
  decision still `proposed` upstream (`instance-connection-referenceability.md`), the same caveat
  `api-connections-resolution-non-interactive.md` carries.
- **Recorded, not asserted:** B's `test` and `health` on the instance row answer `200`, so a non-superuser can
  trigger a check of the instance credential. Nothing in the issue or in the design names that as wanted or
  unwanted, so this file pins neither.

### Opt-in widening is owner-only (premise 3)

- The superuser enabling `allow_non_interactive` on A's row → `403 {"detail": "Only the connection owner may
  allow non-interactive use."}`, and the row still reads `false`.
- A enables it on its own row (`200`, `true`).
- The superuser **clears** it (`200`, `false`): narrowing needs only write access.

### What a superuser can do to another user's row in OSS (premise 4)

OSS authorization is pass-through, so the superuser lists A's row, checks it (`/test` → `200`), renames it, revokes
it and deletes it. A sees each change in its own list:
- the new display name;
- status `revoked`;
- then no row at all.

### Deleting a user removes its connections (premise 5)

`DELETE /api/v1/users/{id}` has been **asynchronous** since langflow#15470 (`1.13.0.dev36`): it answers
`202 {"detail": "User deletion started", "request_id": …}`, and the erase runs in the background with the user row
last. `deleteThrowawayUser` waits for the user to answer `404` (#2228). Measured:
- A's connections leave the superuser's list ~0.7 s after the `202`;
- the user ~2.9 s after it.

So once the delete returns, the rows must already be gone. The issue also asks for the stored secrets. Those are
not observable from outside, so the removal is asserted on the rows, and the doc does not claim the envelope.
`GET /api/v1/data-subjects/requests/{id}` answers `404` on the nightly, so the request id is not followed either.

### The write limit is per user, not per client (premise 6)

A spends its write bucket:
- one create plus renames: the 30th write is still accepted, and the 31st answers **`429`** with
  `retry-after: 60` and `{"detail": "Too many requests. Please try again later.", "retry_after": "60"}`;
- B's create from the same client right after is accepted (`201`).

The bucket's size and the independence of the read and `/test`/`/health` buckets belong to #2302. This file
asserts only the key: one user's spent bucket does not refuse another.

---

## Tags *(required)*

`@api` `@auth` `@integrations` `@stable`.

---

## Step by step *(required)*

**`describe.configure({ mode: "serial" })`.** Test 5 spends A's write bucket and deletes A, so it must run after
every other test that uses A, and in the same worker.

**Setup.** `beforeAll` creates **A and B through `createConnectionsOwner`** (#2295). That is two logins per worker
against the OSS limit of 5/min per client IP. The helper waits out a refused window, so at `--workers=2` the
second worker may pay up to a minute of setup; that cost is recorded rather than avoided. Each test deletes the
rows it created. `afterAll` disposes B, and A too if test 5 did not run.

**Test 1 — another user's connection answers 404 on every route, exactly like one that does not exist.**
1. A creates a Google row.
2. B sends `PATCH`, `test`, `health`, `revoke`, `oauth/start` and `DELETE` on A's id, then the same six on a
   random id. Each pair answers the same `404` body.
3. A's row is unchanged: same display name, status `ready`, `allow_non_interactive: false`.
4. B's list carries no row of A's, unfiltered or with `?provider=google`.

**Test 2 — an instance connection is visible to every user, but only a superuser may create, change or remove
it.**
1. The superuser creates an instance row. B's list carries it.
2. B's create of an instance row → `403` with its message.
3. B's `PATCH`, `revoke` and `DELETE` of the superuser's row → `403` with their message.
4. The row is unchanged: display name, status `ready`.

**Test 3 — only the owner may allow non-interactive use; anyone with write access may clear it.**
1. A creates a row. The superuser's `PATCH allow_non_interactive: true` → `403` with its message; the row still
   reads `false`.
2. A's own `PATCH true` → `200`, `true`.
3. The superuser's `PATCH false` → `200`, `false`. A's list agrees.

**Test 4 — a superuser can check, rename, revoke and delete another user's connection.**
1. A creates a row. The superuser's list carries it.
2. The superuser's `test` → `200`.
3. The superuser's rename → `200`; A's list shows the new name.
4. The superuser's revoke → `200`, status `revoked`; A's list agrees.
5. The superuser's delete → `204`; A's list no longer carries the row.

**Test 5 — the write limit is per user, and deleting a user removes its connections.**
1. A creates two rows, then renames one until a write answers `429`. That write carries `retry-after: 60` and the
   exact body. The writes before it were accepted, and there are at most 30.
2. B creates a row from the same client → `201`.
3. A is deleted (`202`, then erased). Neither of A's rows is in the superuser's list.

---

## Validation criterion *(required)*

All five tests pass three consecutive times at `--retries=0 --workers=1` against `1.13.0.dev47`, and once at
`--workers=2`. On every run:
- every refusal carries its exact status and body;
- every refused request leaves its row as it was;
- no connection or throwaway user is left behind.

Each test also has a force-fail mutation executed against it.

---

## External dependencies *(required)*

- A running Langflow **1.13** instance at `PLAYWRIGHT_BASE_URL`, auto-login (the superuser) with user
  self-registration through `POST /api/v1/users/` available to the superuser.
- No provider key, no OAuth registration, no network egress: the `test` and `health` checks of a planted token
  never leave the instance.
- `src/backend/base/langflow/api/v1/connections.py` — the routes, the `404` for a row the caller cannot see, and
  the owner-only opt-in.
- `src/backend/base/langflow/services/connection/service.py` — the owner scoping, the instance-row rules and the
  per-user write limiter.
- `src/backend/base/langflow/api/v1/users.py` — the asynchronous user delete (`202`).
