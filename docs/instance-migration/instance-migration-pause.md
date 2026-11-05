# Instance migration — the pause refuses every write, keeps reads and sign-in, survives a restart, and lifts cleanly

**File:** `tests/tests-automations/regression/instance-migration/instance-migration-pause.spec.ts`

**Last validated:** Langflow 1.14.0.dev17 (`langflowai/langflow-nightly:latest` plus the `pgvector` package, `package: "Langflow Nightly"`), on the `@instance-migration` lane. Every fact below was measured that day over the API and on the page, unless it is marked *(code)*, which means it was read from `langflow-ai/langflow@release-1.14.0` and not observed.

---

## What this test validates *(required)*

*Pause changes* is the instance migration step with the widest reach: it stops **every** user of the instance from changing anything, so that the copy that follows is complete. A write that lands during the copy is *"lost without a report"* *(code: `migration_pause.py`)*. The pause therefore has to:

- wait for the changes already under way, instead of cutting them off or ignoring them;
- refuse every change completely, with a reason;
- keep reads and sign-in working, and tell every signed-in user why changes fail;
- survive a restart;
- come back off cleanly, losing nothing.

Four tests:

1. **The pause waits for a running flow.** With a run under way, *Pause changes* names the run and does **not** begin. The instance is left taking changes. Once the run has ended, *Check again* begins the pause.
2. **Every change is refused, and none of it lands.** While paused, ten write surfaces answer `503` with the reason, and nothing they asked for exists afterwards. Reads keep answering, and a regular user can still sign in, refresh and sign out.
3. **A regular user is told.** A second user, not a superuser, signs in **during** the pause. They see the pause notice on every page, still open their own flow on the canvas, and are told at once why a change failed, with the server's reason and no retry.
4. **A restart keeps the pause, and turning changes back on loses nothing.** The pause survives a container restart. `DELETE /api/v1/migration/pause` then lets through the exact save it refused, and everything written before the pause is still there.

### What the measurements changed in the issue's plan

- **"The pause waits in a *pausing* state and lists what it is still waiting for."** Not quite. `POST /api/v1/migration/pause` waits **5 s** for the changes already let in *(code: `_DRAIN_SECONDS = 5`)*. If something is still running, the server **lifts the pause it had begun** and answers `409`. Measured: with a 12 s flow run under way, the request answered after ~5.1 s with `409` `{"code": "jobs_active", "jobs": [...], "listeners": [], "changes": [...]}`:
  - `jobs` holds the run: `flow_name`, `owner: "langflow"`, `state: "in_progress"`, `cancel: null`;
  - `changes` holds the request itself (`kind: "request"`, `method: "POST"`, the run's path).
  
  After the refusal, `GET /api/v1/migration/pause` reads `{"paused": false}`, the step is still `current`, and a `PATCH` succeeds. The refused pause leaves nothing behind. The code is `jobs_active` and not `requests_active`, because a run through `/api/v1/run` is a **job** too. `requests_active` is what a long request with no job gets.
- **"*Check again* turns the step green."** In two stages. *Check again* sends the pause again (`200`), and the step then reads `blocked: recheck_pending` *(already measured for #2353)*. The page runs *Check this instance* again by itself, and only when that check passes is the step `done`.
- **"Use one test row per surface."** One test, one `test.step` per surface. Every surface needs the same pause, and a pause costs two source checks (~20 s each idle, up to 95 s on a loaded host). Ten separate tests would spend that ten times for the same assertion.
- **The notice on "every page" has an exception.** The notice is not shown on `/settings/migration`, which has its own banner *(code: `ChangesPausedNotice` returns `null` there)*. A regular user cannot open that page anyway. The pages checked are the home page, the user's flow on the canvas, *Settings > General* and *Settings > Global Variables*.

### A regular user's browser on an auto-login lane

The lane runs `LANGFLOW_AUTO_LOGIN=true` (#2347), and the frontend calls `GET /api/v1/auto_login` on **every** load. It becomes the superuser even when the context holds a regular user's session cookies. Measured: `whoami` answered `langflow`, `is_superuser: true` after an API login as another user. So the regular user's **browser context**, and only that one, answers `/api/v1/auto_login` the way an instance with auto-login off does: `403 {"detail": {"message": "Auto login is disabled.", "auto_login": false}}` *(code: `login.py`)*. The frontend then stops retrying *(code: `isAutoLoginDisabledResponse`)*, shows the login form, and keeps the user signed in across loads through `POST /api/v1/refresh`. Measured: `whoami` answered the regular user, `is_superuser: false`, on every page.

Nothing the test asserts goes through that seam. The pause, `GET /api/v1/migration/pause` (which needs only a signed-in user), the `503` and the notice are all the server's real answers. The seam changes only which user the browser is.

### Measured refusals

On 1.14.0.dev17, each of these answered `503 {"detail": "This instance is being migrated."}`, with no `Retry-After`:

| Surface | Request |
|---|---|
| Save a flow | `PATCH /api/v1/flows/{id}` |
| Create a flow | `POST /api/v1/flows/` |
| Run a flow | `POST /api/v1/run/{id}` (API key) |
| Run a flow (v2) | `POST /api/v2/workflows` |
| Upload a file | `POST /api/v2/files` |
| Upload a chat attachment | `POST /api/v1/files/upload/{flow_id}` |
| Sign up | `POST /api/v1/users/` (no auth) |
| Create a global variable | `POST /api/v1/variables/` |
| Delete a global variable | `DELETE /api/v1/variables/{id}` |
| Create an API key | `POST /api/v1/api_key/` |

What still answers during the pause *(code: `_passes_while_paused`)*: every `GET`, `HEAD` and `OPTIONS`; `POST /api/v1/login`, `/refresh`, `/logout`, `GET /api/v1/auto_login`; and everything under `/api/v1/migration/`. All of these were measured `200`.

### Nothing retries a refusal into a pass

The issue's fixture note, checked:

- `retryOnDroppedConnection` repeats only a request that **threw** at the transport layer (`socket hang up`, `ECONNRESET`…), never a response.
- `getAuthToken` repeats only an `/api/v1/auto_login` that did not answer, and that path is never paused.
- `run-node-and-wait`'s `TRANSIENT_PATTERNS` are 429, quota and rate-limit only.
- The frontend's own retry excludes this exact refusal *(code: `isPauseRefusal` in `request-processor.ts`)*. Measured: one `POST /api/v1/variables/` and no second one. Test 3 asserts that count.

## Tags *(required)*

| Test | Tags |
|---|---|
| 1 — waits for a run | `@instance-migration` `@settings` `@api` `@ui-ux` |
| 2 — refuses every change | `@instance-migration` `@settings` `@api` |
| 3 — a regular user is told | `@instance-migration` `@settings` `@auth` `@ui-ux` |
| 4 — restart and resume | `@instance-migration` `@settings` `@api` `@database` |

None is `@stable`: nothing runs `@instance-migration` on a cron (#1010).

## Precondition *(required)*

- The `@instance-migration` lane (`./scripts/start-langflow-instance-migration.sh`), run with `PW_INSTANCE_MIGRATION=1 … --grep @instance-migration`. It is serial, with one worker.
- **Each test starts and ends with `resetInstanceMigration()`.** That lifts any pause first. What a test adds to the source (flows, an API key, a file, a variable, a user) it removes itself, in reverse order.
- The steps before the pause (*Check this instance*, *Where your data goes*, *Hand over the secret key*) are walked through the API, by a new `prepareBeforePause()` split out of `prepareThroughPause()`. The pause itself and the second check stay in `prepareThroughPause()`, which keeps its behaviour for #2353 and #2354.
- A flow that **waits**, for test 1: Chat Input → a `CustomComponent` that sleeps 25 s → Chat Output, built with `build-catalog-flow.ts` (the #2196 shape), and run with an API key. On auto-login, `/api/v1/run` refuses a bearer token.

## Step by step *(required)*

### Test 1 — the pause waits for a running flow, names it, and begins once it has ended

1. Walk to the pause step through the API. Create the waiting flow, a plain flow and an API key.
2. Open *Settings > Migration* on `migration-step-pause`. The page is opened first so that the run's 25 s are not spent loading it.
3. Start a run of the waiting flow through `POST /api/v1/run/{id}` with the API key, without waiting for it. Wait until `GET /api/v1/monitor/messages?flow_id=…` shows the run's input (measured at ~0.3 s), so the run is known to be in flight before the pause is asked for. Then click *Pause changes*, and *Pause* in the dialog *Pause changes now?*.
4. The page's `POST /api/v1/migration/pause` answers `409` with `detail.code: "jobs_active"`:
   - `jobs[0]` is this flow (`flow_name`) in `state: "in_progress"`;
   - `changes` holds `POST /api/v1/run/{id}`.
5. The step shows `migration-job-{jobs[0].id}` (with the flow name and *Running*), `migration-change-0`, the text *"Still running: 1."*, and a *Check again* button.
6. The pause did **not** begin: `GET /api/v1/migration/pause` is `{"paused": false}`, the step is still `current`, and a `PATCH` of the plain flow answers `200`.
7. Wait for the run to end (`200`). Click *Check again*. The page's `POST /api/v1/migration/pause` answers `200`.
8. The step becomes `done` once the second check has passed (polled through the API), and the page shows *"Changes are paused on this instance."*.

### Test 2 — every change is refused with the reason, none of it lands, reads and sign-in work

1. Before the pause, create the test's own state: a flow (name `N0`), a file through `POST /api/v2/files`, a global variable, and a regular user (`createThrowawayUser`). Record what can be counted: flows with the test's prefix, files, variables, API keys.
2. Pause with `prepareThroughPause()`.
3. One `test.step` per surface in *Measured refusals*. Each one answers `503` with `{"detail": "This instance is being migrated."}`, exactly.
4. None of it landed:
   - the flow is still named `N0`;
   - no flow, file, variable or API key was added, and the variable that `DELETE` tried to remove is still there;
   - the signup username does not exist.
5. Reads answer `200`: `GET /api/v1/flows/`, `GET /api/v1/flows/{id}`, `GET /api/v2/files`, `GET /api/v1/variables/`.
6. The regular user, in their own request context: `POST /api/v1/login` → `200` with an `access_token`, `POST /api/v1/refresh` → `200`, `GET /api/v1/migration/pause` → `{"paused": true}`, `POST /api/v1/logout` → `200`.

### Test 3 — a regular user is told on every page, keeps their flow, and a change fails at once

1. Before the pause, create a regular user and a flow of their own, named with a sentinel.
2. Pause with `prepareThroughPause()`.
3. In a separate browser context, `/api/v1/auto_login` answers as disabled (see above). Sign in **during the pause** through the login form (`signInThroughForm`): `200`, and `whoami` names the regular user with `is_superuser: false`.
4. On `/`, `/flow/{their flow}`, `/settings/general` and `/settings/global-variables`, a `role="status"` shows *"Changes are paused on this instance while it moves to a new one. You can look at your work, but changes you make now are not saved."*.
5. On the canvas, the flow's name (`flow_name`) is the sentinel. A read opens the flow during the pause.
6. On *Settings > Global Variables*, click *Add New* (`api-key-button-store`), fill the name and the value (by their placeholders), then click `save-variable-btn`:
   - *"This instance is being migrated."* appears within 5 s (measured: 108 ms);
   - exactly **one** `POST /api/v1/variables/` was sent, and it answered `503`;
   - the variable does not exist.

### Test 4 — a restart keeps the pause; turning changes back on lets the refused save through and loses nothing

1. Before the pause, create a flow (name `N0`, with a sentinel description), a file with known bytes, and a global variable.
2. Pause with `prepareThroughPause()`. A rename to `N1` answers `503`.
3. `docker restart` the source container (~43 s measured), then wait for `/api/v1/version`.
4. Still paused: `GET /api/v1/migration/pause` is `{"paused": true}`, the same rename answers `503`, and the migration record still holds `pause.frozen_at`, unchanged across the restart.
5. `DELETE /api/v1/migration/pause` answers `200`. `GET /api/v1/migration/pause` is `{"paused": false}`, and the pause step is `current` again.
6. The same rename to `N1` now answers `200`, and it reads back.
7. Nothing was lost: the flow keeps its sentinel description, the file downloads with its bytes, and the variable is listed.

## Validation criterion *(required)*

The spec passes only when, on the lane:

- a pause asked for during a run answers `409 jobs_active` naming the run, shows it on the page, and leaves the instance unpaused and writable; after the run ends, *Check again* pauses and the step reaches `done`;
- each of the ten write surfaces answers `503` with the exact reason, and nothing it asked for exists afterwards;
- reads, login, refresh and logout answer `200` during the pause;
- a regular user who signs in during the pause sees the notice on four pages, opens their flow, and gets the reason on the page after exactly one refused request;
- the pause survives a restart, with the same `frozen_at`, and once it is lifted the refused rename succeeds and the earlier flow, file and variable are intact.

**Force-fails**, each to be executed and to fail on its intended assertion:

1. Test 1, with the run not started: the pause begins at once, so the `409` assertion fails.
2. Test 2, with one surface's expected detail changed to another string: that step fails on the body.
3. Test 2, with the "nothing landed" check on the flow name expecting `N1`: it fails on the read-back.
4. Test 3, without the pause (`prepareBeforePause()` only): the notice assertion fails on the home page.
5. Test 3, with the expected `POST` count changed to 2: it fails on the count.
6. Test 4, with `DELETE /pause` skipped: the rename after it answers `503`, not `200`.
7. Test 4, with the expected `frozen_at` after the restart changed: it fails on the record.

## What this does not cover *(and why)*

- **`POST /api/v1/authz/me/permissions` is refused during the pause.** Measured: it answered `503` while a regular user browsed *Settings > Global Variables*. It is a side-effect-free read sent as a `POST` *(code: `use-get-effective-permissions.ts`: "a cacheable, side-effect-free batch read")*, so the middleware treats it as a change. The frontend fails open on a permissions error *(code: `permissionsContext.tsx`)*, and no visible effect was measured. This is recorded as an observation, not asserted, and not filed upstream.
- **`requests_active`**: a long request with no job (a slow upload) still under way after the 5 s wait. A flow run is a job, so test 1 gets `jobs_active`. A slow upload whose length the test controls would need a throttled client. The page renders both codes the same way *(code: `waiting` in `PauseStep.tsx`)*.
- **Cancelling a run from the page.** The admin's own `/api/v1/run` job has `cancel: null` (*"You can't cancel this one from here."*), measured.
- **Turning changes back on through the page.** *Turn changes back on* → *Resume* is driven in the UI by #2354's second test (`instance-migration-target-acceptance.spec.ts`). Here it goes through the API, which is what the button calls.
- **Websockets and loops that write with no request** (triggers, flow sync, telemetry) *(code: `writing()`)*. No spec drives them on this lane.
- **Several workers.** The lane runs one worker by design. The cross-worker lock *(code: `pause.lock`)* is not exercised.

## External dependencies *(required)*

| Upstream | What this spec relies on |
|---|---|
| `src/backend/base/langflow/api/utils/migration_pause.py` | the middleware: reads and the allowed paths pass, every other request gets `503` with `REFUSAL`; the record in `CONFIG_DIR/migrations/migration.json` |
| `src/backend/base/langflow/api/v1/migration.py` | `POST /pause` waits `_DRAIN_SECONDS` and refuses with `jobs_active` / `requests_active`; `GET /pause` for any signed-in user; `DELETE /pause` |
| `src/backend/base/langflow/api/v1/login.py` | the `403` an auto-login-off instance answers on `/api/v1/auto_login` |
| `src/frontend/src/pages/SettingsPage/pages/MigrationPage/PauseStep.tsx` | *Pause changes*, the confirmation dialog, `migration-job-{id}`, `migration-change-{index}`, *Check again* |
| `src/frontend/src/components/common/changesPausedNotice/index.tsx` | the notice on every page but `/settings/migration` |
| `src/frontend/src/controllers/API/services/request-processor.ts` | `isPauseRefusal`: a refused change is not retried |
| `src/frontend/src/controllers/API/queries/auth/use-get-autologin.ts` | an auto-login answer of `auto_login: false` stops retries and leaves the user to sign in |

- **Langflow API**: the routes above, plus `POST /api/v1/run/{flow_id}`, `GET /api/v1/monitor/messages`, `POST`/`PATCH`/`GET`/`DELETE /api/v1/flows/`, `POST`/`GET`/`DELETE /api/v2/files`, `POST /api/v1/files/upload/{flow_id}`, `POST`/`GET`/`DELETE /api/v1/variables/`, `POST /api/v1/api_key/`, `POST`/`PATCH`/`DELETE /api/v1/users/`, `POST /api/v1/login`, `/refresh`, `/logout`.
- **Test ids**: `migration-step-pause`, `migration-job-{id}`, `migration-change-0`, `flow_name`, `api-key-button-store`, `save-variable-btn`. The variable dialog's name and value fields are found by their placeholders (*Enter a name for the variable...*, *Enter a value for the variable...*), as `global-variables-crud.spec.ts` does.
- **The lane**: `scripts/start-langflow-instance-migration.sh`, `scripts/reset-langflow-instance-migration.sh`, `tests/helpers/instance-migration/instance-migration-lane.ts`, `tests/helpers/instance-migration/migration-walk.ts`, and `docker restart` on the source container.
- **No provider key, no model.** `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` (the lane sets it) for the waiting component.
