# Instance migration — off by default: no Settings entry, no routes, no pause

**File:** `tests/tests-automations/regression/instance-migration/instance-migration-disabled-by-default.spec.ts`

**Last validated:** Langflow 1.14.0.dev17 (`langflowai/langflow-nightly:latest`, `package: "Langflow Nightly"`), on the **normal** lane, with `LANGFLOW_FEATURE_INSTANCE_MIGRATION` unset. The first measurements were taken on 1.14.0.dev14 and repeated on dev17 with the same results. Every fact below was measured unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

---

## What this test validates *(required)*

Instance migration (*Settings > Migration*) can pause every write on an instance and copy all of its data out. It is off unless `LANGFLOW_FEATURE_INSTANCE_MIGRATION=true` is set at process start *(code: `feature_flags.py`, `instance_migration: bool = False` under `env_prefix = "LANGFLOW_FEATURE_"`)*. The default build is what almost every user runs, so the most useful assertion is that **nothing** of the feature is reachable there. If the default flipped, every instance would show a pause button and a copy path nobody had reviewed.

Three tests, one per surface:

1. **The page.** *Settings* lists no **Migration** entry, opening `/settings/migration` directly lands on *General*, and the frontend never asks the server about a migration.
2. **The routes.** The migration routes answer exactly like a route that does not exist: the router is not mounted.
3. **The pause guard.** A normal write succeeds.

### What the measurements changed in the issue's plan

- **"`POST /api/v1/migration/pause` answers `404`."** It does not. With the router unmounted it answers **`405 Method Not Allowed`** with `allow: GET, HEAD`. Every non-`GET` request to a path under `/api/` that matches no route answers this way. `POST /api/v1/im-2348-no-such-route` gets the same status, the same body (`{"detail":"Method Not Allowed"}`) and the same `allow`. A `GET` of either answers `404 {"detail":"Not Found"}`. So "not mounted" is asserted as **"answers exactly as a route that does not exist"**, with a control request in the same test, and not as a fixed status. That also holds if a later build changes how unmatched `/api/` paths answer.
- **The `allow` header's order is not stable.** It was `GET, HEAD` on dev14 and `HEAD, GET` on dev17. The test compares it as a set.
- **"Navigating to the page's route directly does not render it — measure what happens."** It **redirects**. `/settings/migration` replaces itself with `/settings`, which lands on `/settings/general`. *(code: `MigrationPage/index.tsx` — `if (!enabled) return <CustomNavigate replace to="/settings" />`; the route itself is always mounted in `routes.tsx`.)*
- **"Declare both with `page.allowHttpErrors()`."** Not needed, and it would do harm. Tests 2 and 3 send their requests through Playwright's `request` context, which the fixture's backend-error monitor does not observe (it listens to `page` responses). Test 1 has a page, and its frontend sends no migration request at all, so nothing is reported. Calling `allowHttpErrors()` in test 1 would hide any **unrelated** `/api/` 4xx/5xx the Settings page produced (#1084).
- **"A normal write succeeds, which proves the pause middleware is inert when the flag is off."** On its own it proves less than that. A fresh instance has no pause record, so a write succeeds whether or not the guard checks the flag. The flag check was **measured once, by hand**: a paused record (`{"pause": {"frozen_at": …}}`) was planted at `<config_dir>/migrations/migration.json` in the dev14 container, the flag was still off, and `PATCH /api/v1/flows/{id}` answered `200` and saved the new name. Test 3 cannot plant that record, because the suite only has the instance's URL and no API writes the record while the router is unmounted. It asserts what is portable: the default build does not refuse a write. See *What this does not cover*.

### What the feature looks like when it is on — the contrast every assertion depends on

Measured on the `@instance-migration` lane (1.14.0.dev16, flag on, auto-login superuser):

- The Settings sidebar has `sidebar-nav-Migration` (`href="/settings/migration"`) after `sidebar-nav-Messages`.
- **Every page**, the home page included, sends `GET /api/v1/migration/pause` once the feature flags are known. That request feeds the pause notice. With the flag off, neither the home page nor Settings sends any `/api/v1/migration*` request. That absence is the assertion that "no pause notice" can rest on: the notice has no data without the request.
- `GET /api/v1/migration` answers `200` with the migration's state.

## Tags *(required)*

| Test | Tags |
|---|---|
| 1 — the page | `@stable` `@settings` `@ui-ux` |
| 2 — the routes | `@stable` `@api` `@settings` |
| 3 — a write | `@stable` `@api` `@database` `@settings` |

- **No `@instance-migration`.** This is the exception the tracker (#2357) records: it targets the **normal** lane, where the flag is unset. The `@instance-migration` lane is run with `--grep @instance-migration`, its documented command (`tests/fixtures/lane.ts` only excludes the other lane tags there), so this spec does not run on it. Run there without the grep, tests 1 and 2 fail on their first assertion. That is correct, because that instance is not the default build.
- **`@stable` in this PR.** It needs no provider key or model and no second instance, so the scheduled daily can run it.

## Precondition *(required)*

- A Langflow on the normal lane: `LANGFLOW_FEATURE_INSTANCE_MIGRATION` unset (or `false`), auto-login on. `./scripts/start-langflow-docker.sh` and every CI lane start it this way. `grep -rln FEATURE_INSTANCE_MIGRATION .github scripts ops` names only the `@instance-migration` lane's start script and its test.
- Nothing seeded. Test 3 creates one flow and deletes it.

## Step by step *(required)*

### Test 1 — Settings shows no Migration entry, and its address falls back to General

1. Start recording every request the page sends whose pathname starts with `/api/v1/migration`.
2. Open `/settings/messages`. Wait for the page's own `GET /api/v1/config` and its own `GET /api/v1/users/whoami`. `feature_flags.instance_migration` must be `false`; if it is anything else, the instance is not the default build, and the test stops there with a message that says so. `is_superuser` must be `true`, so the entry's absence is due to the flag and not to the viewer.
3. Wait for the network to go quiet, wait for `sidebar-nav-General` to be visible, then assert `sidebar-nav-Migration` has **count 0** and no sidebar link has `href="/settings/migration"`.
4. Open `/settings/migration`, wait for that load's own `GET /api/v1/config`, then assert the URL becomes `/settings/general` and `settings_menu_header` reads *General*.
5. Open `/` (the home page), wait for its `GET /api/v1/config`, then wait for the network to go quiet.
6. Assert the recorded list is **empty**. With the flag on, steps 2, 4 and 5 would each have sent `GET /api/v1/migration/pause`.

**Why each wait is there**: each one was measured, or found by a failure:

- **Both responses before the sidebar check (step 2).** The entry needs the flag (from `/config`) **and** a superuser (from `/users/whoami`) *(code: `use-settings-sidebar-items.tsx` — `isSuperuser && migrationEnabled`)*. The two responses arrive in either order: on dev17 `whoami` came 3 ms after the config, and on the lane 24 ms before it. Waiting for the config alone could check before the user is known, and that passes on any build. A force-fail delays `whoami` by 3 s on the flag-on lane and still fails on the entry.
- **A quiet network before the sidebar check (step 3).** The store updates and the sidebar re-renders only after the responses are received. Checking at once could run before the render that adds the entry.
- **Messages, not General (step 2).** The sidebar is the same on every Settings page. *General* loads every profile picture: 116 requests, quiet only after ~11 s. *Messages* makes 38 requests and is quiet after ~3.4 s (measured on dev17). The first version opened *General*, and test 1 took up to 33 s.
- **The config before the URL (step 4).** A full load of `/settings/migration` shows a spinner until the flags arrive, and only then redirects *(code: `if (enabled === undefined) return <Loading …/>`)*. The first version asserted the URL directly, with the 5 s default timeout. It failed once in a run made right after the lane reset loaded the host: the URL was still `/settings/migration` after 5 s. Delaying the config by 6 s with `page.route` reproduced that failure exactly. With the wait in place, the same 6 s delay passes.

### Test 2 — the migration routes answer exactly as a route that does not exist

1. `GET /api/v1/config`: `feature_flags.instance_migration` is `false` (same guard as test 1, over the API).
2. Control: `GET` and `POST` `/api/v1/im-2348-no-such-route`. Record status, body and `allow` as a set.
3. `GET /api/v1/migration` and `GET /api/v1/migration/pause` each answer **the same status and body as the control `GET`** (`404 {"detail":"Not Found"}`).
4. `POST /api/v1/migration/pause` answers **the same status, body and `allow` set as the control `POST`** (`405`, `{"detail":"Method Not Allowed"}`, `{GET, HEAD}`).
5. All requests carry the superuser's token, because a mounted route would answer an unauthenticated request with `401`/`403`, which is a different shape from "not found". An authenticated request is the one a mounted router would serve.

### Test 3 — a normal write succeeds on the default build

1. `POST /api/v1/flows/` with an empty flow named `IM-2348 write <timestamp>` returns `201`.
2. `PATCH /api/v1/flows/{id}` with a new name returns `200`, **not** `503` (the status a pause gives every write).
3. `GET /api/v1/flows/{id}` returns the new name, so the write was saved and not just answered.
4. Cleanup in `finally`: delete the flow through `deleteFlow` (verified).

## Validation criterion *(required)*

The spec passes only when, on an instance started without the flag:

- the server reports `feature_flags.instance_migration: false`;
- *Settings* has no Migration entry once the flags and a superuser's `whoami` have arrived, and `/settings/migration` ends on `/settings/general`;
- no request to `/api/v1/migration*` leaves the page across Settings, the direct address and the home page;
- `GET /api/v1/migration`, `GET /api/v1/migration/pause` and `POST /api/v1/migration/pause` answer exactly like the matching request to a path that does not exist;
- a flow rename answers `200` and is read back.

**Force-fails**: each was executed and failed on its intended assertion. The `@instance-migration` lane ran 1.14.0.dev16 with the flag on; the normal lane ran dev17.

1. The whole spec against the lane (`PLAYWRIGHT_BASE_URL=http://127.0.0.1:7895/`): tests 1 and 2 fail on the `feature_flags.instance_migration` guard (`Received: true`). Test 3 passes there, as expected: a write is not refused when nothing is paused (see *What this does not cover*).
2. Test 1 against the lane with the guard disabled, run once per assertion, each run with the earlier assertions disabled:
   - the sidebar assertion fails with `whoami` delayed by 3 s (`sidebar-nav-Migration`: `Received: 1`);
   - the redirect assertion fails (the URL stays `http://127.0.0.1:7895/settings/migration`);
   - the request assertion fails (4 `/api/v1/migration*` requests recorded).
3. Test 2 against the lane with the guard disabled: it fails on *"GET /api/v1/migration and GET /api/v1/migration/pause answer as the control GET"*.
4. Test 2 on the normal lane, with the control `POST` pointed at a mounted route (`/api/v1/flows/`): it fails on *"POST /api/v1/migration/pause answers as the control POST"*. This proves the comparison is live, not vacuous.
5. Test 3, with the read-back expecting the old name: it fails on *"the new name is read back"*.

After the force-fails against the lane, it was reset with `./scripts/reset-langflow-instance-migration.sh`.

**Runs:** three `--retries=0` runs on dev17, all 3 passed: 14.5 s, 9.6 s and 9.0 s in total, test 1 taking 5.8–8.5 s. No `🚨 Backend Error`. No `IM-2348` flow left behind.

## What this does not cover *(and why)*

- **That the pause guard checks the flag before the record.** Measured by hand once (see above): a planted paused record on a flag-off instance does not block a write. The spec cannot plant one. It has only the instance's URL, and the record lives in the server's config directory. An instance with a planted record is a lane-only setup that no CI lane builds.
- **A regular (non-superuser) user.** On the default build nothing is mounted for anyone, so a second user adds no information. What a regular user sees with the flag **on** is #2349.
- **Other values of the flag.** Only "unset" is tested, because that is the default. `LANGFLOW_FEATURE_INSTANCE_MIGRATION=false` is the same code path *(code: a pydantic `bool` field)*.
- **API coverage credit.** No operation is declared through `apiCoverage`. An unmounted route's `404` does not cover the route's contract, and the flow `PATCH` is already declared by `api/flows/api-flows-crud.spec.ts`.

## External dependencies *(required)*

| Upstream | What this spec relies on |
|---|---|
| `src/lfx/src/lfx/services/settings/feature_flags.py` | `instance_migration` defaults to `False`, read from `LANGFLOW_FEATURE_INSTANCE_MIGRATION` |
| `src/backend/base/langflow/api/router.py` | `include_migration_router` mounts the routes only when the flag is on |
| `src/backend/base/langflow/api/utils/migration_pause.py` | `is_paused()` returns `False` before reading any record when the flag is off |
| `src/frontend/src/pages/SettingsPage/use-settings-sidebar-items.tsx` | the *Migration* entry is added only for a superuser with the flag on |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/index.tsx` | the page redirects to `/settings` when the flag is off, and fetches nothing |

- **Langflow API**: `GET /api/v1/config`, `GET /api/v1/users/whoami`, `GET /api/v1/auto_login`, `POST`/`PATCH`/`GET`/`DELETE /api/v1/flows/`, and the three migration requests above.
- **Test ids**: `sidebar-nav-General`, `sidebar-nav-Migration` (measured on the lane, flag on), `settings_menu_header`.
- **No provider key, no model, no second instance.**
