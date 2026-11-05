# Instance migration — only a superuser can reach it, and a regular user reads nothing sensitive

**File:** `tests/tests-automations/regression/instance-migration/instance-migration-authorization.spec.ts`

**Last validated:** Langflow 1.14.0.dev17 (`langflowai/langflow-nightly:latest` plus the `pgvector` package, `package: "Langflow Nightly"`), on the `@instance-migration` lane. Every fact below was measured that day over the API, on the page and inside the source container, unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

---

## What this test validates *(required)*

Instance migration can pause every write on the instance, download its whole database and hand it to another server. Authorization is therefore the boundary that matters most: only a superuser may run it *(code: `Superuser = Annotated[User, Depends(get_current_active_superuser)]`)*. One route is typed `SignedIn` instead. Every signed-in user reads the pause state, so that every page can show the paused notice (#15779). The spec tells the two apart from a measured list of the routes, not from a hand-picked sample.

Three tests:

1. **Every superuser route refuses a regular user and a client with no session, and a refusal changes nothing.** The list of routes is read from the router running in the source container. For each superuser route and method, a regular user gets `403` with the privilege message, and a client with no credentials gets `403` with the missing-credentials message. After all the attempts, `migration.json` is byte-for-byte unchanged and no pause exists.
2. **A regular user reads only whether changes are paused, and cannot change that.** During a pause, the regular user's `GET /api/v1/migration/pause` answers exactly `{"paused":true}`, and nothing else: no destination, no secret-key path, no finding. The same user cannot lift the pause or start another one, and a client with no session cannot read the pause state.
3. **Settings shows a regular user no way into the migration.** Signed in in the browser, the regular user has no *Migration* entry in Settings. Opened directly, `/settings/migration` shows only *"Only admins can move this instance."*, with no step, and the page never asks the server for the migration state.

### What the measurements changed in the issue's plan

- **The route list comes from the running router, not from OpenAPI.** The router is `include_in_schema=False`, so `/openapi.json` does not list it. The test runs a short Python script inside the source container. The script reads `langflow.api.v1.migration.router` and records, for each route, its path, its methods and which current-user dependency guards it. Measured on dev17: **19 routes**, 18 guarded by `get_current_active_superuser` and one, `GET /migration/pause`, by `get_current_active_user`. Each superuser route answering `403` and not `404` also shows the route is mounted.
- **A client with no session gets `403` too, not `401`,** with `{"detail": "No authentication credentials provided"}`, even though the lane runs `LANGFLOW_AUTO_LOGIN=true`: auto-login does not log in a request that carries no credentials. That detail tells it apart from the regular user's `{"detail": "The user doesn't have enough privileges"}`, so the test asserts both bodies exactly.
- **"The direct route does not render the page" is half right.** `/settings/migration` stays on its address and renders the page's heading, *Move to a new instance*, and its introduction, then *"Only admins can move this instance."* in place of the steps *(code: `MigrationPage` asks for the state only when the user is a superuser, and shows `superuserOnly` otherwise)*. No `migration-step-*` element exists, and the page sends no request under `/api/v1/migration` except the `GET /pause` that every page polls.
- **The pause has to be reached first.** A `POST /pause` is refused with `409 locked` until the steps before it are done, so test 2 walks them as the superuser before it reads the pause as a regular user.

### Measured answers (1.14.0.dev17)

| Caller | Every superuser route | `GET /api/v1/migration/pause` |
|---|---|---|
| Regular user (bearer token) | `403 {"detail":"The user doesn't have enough privileges"}` | `200`, body exactly `{"paused":false}` or `{"paused":true}` (16 or 15 bytes) |
| No credentials | `403 {"detail":"No authentication credentials provided"}` | `403 {"detail":"No authentication credentials provided"}` |

`GET /api/v1/config` tells every signed-in user that the feature is on (`feature_flags.instance_migration: true`). It says nothing about the migration itself, and the test does not assert on it.

## Tags *(required)*

| Test | Tags |
|---|---|
| 1 — every superuser route refuses | `@instance-migration` `@auth` `@api` |
| 2 — a regular user reads only the pause state | `@instance-migration` `@auth` `@api` |
| 3 — Settings shows no way in | `@instance-migration` `@auth` `@settings` `@ui-ux` |

None is `@stable`: nothing runs `@instance-migration` on a cron (#1010).

## Precondition *(required)*

- The `@instance-migration` lane (`./scripts/start-langflow-instance-migration.sh`), run with `PW_INSTANCE_MIGRATION=1 … --grep @instance-migration`. It is serial, with one worker.
- **Each test starts and ends with `resetInstanceMigration()`.** Each creates one regular user (`createThrowawayUser`) in its own request context, and deletes it afterwards.
- In test 3, the regular user's browser context, and only that one, answers `/api/v1/auto_login` the way an instance with auto-login off does: `403 {"detail": {"message": "Auto login is disabled.", "auto_login": false}}`. Without that, the auto-login lane would make the browser the superuser on every load (`instance-migration-pause.md` measured this). The user then signs in through the form. Nothing asserted passes through that route.

## Step by step *(required)*

### Test 1 — every superuser route refuses a regular user and a client with no session, and a refusal changes nothing

1. As the superuser, through the API, every step before the pause (`prepareBeforePause`): the check, the lane's destinations and the verified key. The record then holds a finished check, saved destinations and a verified key to protect.
2. Create a regular user, and a request context with no credentials at all.
3. Read the route list from the source container (`migrationRouteInventory`, `docker exec … python -c`). The only route not guarded by `get_current_active_superuser` is `GET /migration/pause`, guarded by `get_current_active_user`. As a control, the list includes `GET /migration`, `PUT /migration/destinations` and `POST /migration/backup/database`.
4. Snapshot `<CONFIG_DIR>/migrations/migration.json` and the superuser's step states.
5. One `test.step` per superuser route and method, with `{step_id}` as `copy_database`, `{run_id}` as 32 zeros, and an empty JSON body where the method takes one:
   - the regular user gets `403`, body exactly `{"detail":"The user doesn't have enough privileges"}`;
   - the client with no credentials gets `403`, body exactly `{"detail":"No authentication credentials provided"}`.
   This covers `POST /backup/database` too: the answer is that JSON, never the database.
6. Nothing changed: `migration.json` is byte-for-byte the snapshot, the step states are the same, and `GET /api/v1/migration/pause` answers `{"paused":false}`.

### Test 2 — a regular user reads only whether changes are paused, and cannot change that

1. Create a regular user first, because during the pause `POST /api/v1/users/` is refused with `503`. Then, as the superuser, walk the steps through the pause (`prepareThroughPause`).
2. The regular user's `GET /api/v1/migration/pause` answers `200` with the raw body exactly `{"paused":true}`. As a second check, the body contains none of: the lane's planted secrets, the key's fingerprint, the destination database's host, the bucket's name, the source's config folder and database path, or a check's name (`acceptable_checks`). The secret key comes from the environment on the lane, so there is no key file path to look for. As a control, the superuser's `GET /api/v1/migration` does name the bucket and the checks.
3. Snapshot `migration.json`. The regular user's `DELETE /api/v1/migration/pause` and `POST /api/v1/migration/pause` both answer `403` with the privilege message. The instance is still paused, and `migration.json` is unchanged.
4. A client with no credentials gets `403` on `GET /api/v1/migration/pause`.

### Test 3 — Settings shows a regular user no way into the migration

1. **Control.** In a second browser context, on the lane's auto-login, the superuser's *Settings > Messages* shows `sidebar-nav-Migration`, and `/settings/migration` shows `migration-step-check_source`. This pins the two test ids whose absence the rest of the test checks.
2. Create a regular user. In the browser, answer `/api/v1/auto_login` as disabled, and sign in through the form: `200`, and `GET /api/v1/session`, read with the browser's cookies, names the user with `is_superuser: false`. The page does not always ask for `whoami` after a sign-in (measured: absent within 30 s on some runs), so the test does not wait for it.
3. Open *Settings > Messages*. On a load after a sign-in the page takes the user from `GET /api/v1/session`, not from `whoami` (measured). Wait for the page's own `GET /api/v1/config` and `GET /api/v1/session` and for the page to go quiet. Then:
   - with the browser's cookies, `/api/v1/config` reports `instance_migration: true` and `/api/v1/session` names the regular user with `is_superuser: false`. They are read again rather than from the page's responses, because the load can start over once and the first body is gone by then (measured);
   - the sidebar shows `sidebar-nav-Messages`, and has no `sidebar-nav-Migration` and no link to `/settings/migration`.
4. Open `/settings/migration` directly:
   - the page shows *"Only admins can move this instance."* and *Move to a new instance*;
   - the address stays `/settings/migration`;
   - once the page is quiet, no `migration-step-*` element exists. A request for the state would leave at mount, and the pause is fetched on mount and on navigation, not on a timer (measured), so the test waits for the quiet period rather than for another poll.
5. Across the whole test, the regular user's page sent at least one request under `/api/v1/migration`, and every one was a `GET /api/v1/migration/pause` answered `200`. None asked for the state, and none was refused.

## Validation criterion *(required)*

The spec passes only when, on the lane:

- the router inside the running image lists exactly one route that is not superuser-only, `GET /migration/pause`;
- every superuser route answers the regular user and the client with no credentials with `403` and the exact body for each, and none of those attempts changes `migration.json`, the step states or the pause;
- a regular user reads the pause state as exactly `{"paused":true}`, cannot lift or start a pause, and a client with no credentials cannot read it;
- a regular user's Settings has no *Migration* entry while the superuser's does, and the direct address shows the regular user only the admin-only line, with no step and no request for the state.

**Force-fails**, each to be executed and to fail on its intended assertion:

1. Test 1, with the regular user's expected body changed: it fails on the first route.
2. Test 1, expecting no route outside the superuser guard: it fails on the inventory, which shows the list is read from the running router.
3. Test 1, with the superuser verifying a wrong key after the snapshot: the `migration.json` comparison fails, which shows the comparison catches a change.
4. Test 2, expecting `{"paused":false}`: it fails on the raw body.
5. Test 2, expecting the regular user's `DELETE /pause` to answer `200`: it answers `403`.
6. Test 3, expecting a *Migration* entry in the sidebar: there is none.
7. Test 3, expecting the steps to render (one `migration-step-*`): there are none.
8. Test 3, with the request recorder also listening to the superuser's control page: the last step fails naming `GET /api/v1/migration`, which shows the recorder catches a request for the state.

## What this does not cover *(and why)*

- **An inactive user, or a deleted one with a token still valid.** `get_current_active_user` refuses an inactive user with its own message *(code)*. It is the same guard every route in the product uses, and it is not specific to migration.
- **A superuser of another instance, or an API key.** The lane has one instance, and a migration route takes the session user. An API key that belongs to a superuser is a separate feature.
- **`/api/v1/config`'s flag** (`instance_migration: true`) is readable by every signed-in user. It names a feature, not any state, and is left as it is.
- **The pause notice and the refused writes a regular user meets during a pause.** `instance-migration-pause.spec.ts` (#2352, test 3) covers both.

## External dependencies *(required)*

| Upstream | What this spec relies on |
|---|---|
| `src/backend/base/langflow/api/v1/migration.py` | the router (`include_in_schema=False`); `Superuser` on every route but `GET /pause`, which is `SignedIn` |
| `src/backend/base/langflow/api/router.py` | `include_migration_router`: the routes are mounted under `/api/v1` when the feature flag is on |
| `src/backend/base/langflow/services/auth/utils.py` | `get_current_active_superuser` and `get_current_active_user`, and their `403` messages |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/index.tsx` | the state is asked for only by a superuser; anyone else sees `superuserOnly` |

- **Langflow API**: every route under `/api/v1/migration`, `POST /api/v1/users/`, `PATCH`/`DELETE /api/v1/users/{id}`, `POST /api/v1/login`, `GET /api/v1/session`, `GET /api/v1/config`.
- **Test ids**: `sidebar-nav-Migration` and `migration-step-check_source` (present for the superuser, the control), `sidebar-nav-Messages`, `migration-step-*` (absent for the regular user).
- **The lane**: `scripts/start-langflow-instance-migration.sh`, `scripts/reset-langflow-instance-migration.sh`, `tests/helpers/instance-migration/instance-migration-lane.ts`, `tests/helpers/instance-migration/migration-walk.ts`, and `docker exec` on the source container (the route list and `migration.json`).
- **No provider key, no model.**
