# Instance API — database maintenance mode

**File:** `tests/tests-automations/regression/api/instance/api-maintenance-mode.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2568)

Owning issue: #2568. Maintenance is also the precondition of an applied upgrade repair, covered in
`docs/api/instance/api-upgrade-reports.md` (#2567).

---

## What this test validates *(required)*

Langflow 1.14 adds a **database maintenance mode** (upstream #16181; managed from *Settings › Upgrade reports*
since #16583). An administrator turns it on, with an optional reason, and ordinary changes and new flow runs stop
on the whole instance until it is turned off. Every signed-in page shows a changes-paused notice meanwhile.

**Measured facts that change the issue's plan** (`1.14.0.dev39`, read against `langflow-ai/langflow@release-1.14.0`):

1. **The refusal is per caller, not per route.** The middleware (`MigrationPauseMiddleware`) lets a write through
   when the caller is an active superuser and refuses everyone else with **`503 {"detail": "This instance is in
   maintenance mode."}`**. So "writes are refused" holds for regular users (and unauthenticated callers) only: the
   superuser's flow create and update succeed while it is on. The notice says so itself: *"Administrators can still
   make changes."*
2. **The refusal comes before the route.** A regular user's `POST /maintenance/off` while it is on gets that `503`,
   not the route's `403` superuser gate. With maintenance off, the same call is `403 "The user doesn't have enough
   privileges"`.
3. **Job admission (scope 3) is a refusal, not a hold, for a new run.** A regular user's
   `POST /api/v1/build/{id}/flow` is refused `503` by the middleware. The hold (`_guarded_task` and the background
   executor wait while maintenance is on) applies only to work admitted before maintenance started, which this spec
   does not provoke.
4. **The notice does not show the reason** (the issue expected it to). Its text is fixed: *"Ordinary changes and
   flow runs are paused for maintenance. Administrators can still make changes."* The reason appears only on the
   upgrade reports page, under *Maintenance is on.*
5. **The maintenance controls live in a report's view.** *Settings › Upgrade reports* shows *Turn maintenance on* /
   *off* only once a report is open. The spec imports a checker report with no flows
   (`tests/assets/api/upgrade-report-empty.json`) to open one, instead of running a check (minutes, instance-wide).
6. `GET /maintenance/status` is readable by any signed-in user, but `set_by` (and the job counts) are superuser
   details: a regular user reads `set_by: null`.
7. `POST /maintenance/off` clears `reason` and keeps `set_by` as the superuser who turned it off.

---

## Tags *(required)*

Test 1: `@stable` `@api` `@database`. Tests 2–3: `@destructive` `@api` / `@settings` `@database`.

Test 1 never turns maintenance on: it only checks the superuser gate and the status a regular user reads, takes a
second, and runs in the normal lane as `@stable`. Tests 2 and 3 turn maintenance on, which refuses every regular
user's writes on the instance, so they are `@destructive` and therefore **not** `@stable` (CLAUDE.md: never combine
the two). Run them with `PW_DESTRUCTIVE=1 npx playwright test --grep @destructive` (one worker).

No functional tag fits an instance-administration API, as for the `api/instance/` siblings; test 3 drives the
Settings page, hence `@settings`.

---

## Step by step *(required)*

**Setup (`beforeAll`).** A bearer token and the superuser's id (`GET /api/v1/users/whoami`).

**Test 1 — a regular user can read the status but cannot turn maintenance on or off.**

1. A throwaway regular user (`createThrowawayUser`) reads `GET /api/v1/maintenance/status` → `200`,
   `maintenance: false`, `paused: false`, and `set_by: null` — the last only when the superuser's own read shows a
   `set_by` to hide. The migration seeds the row with `set_by` NULL, so on an instance where maintenance was never
   toggled the hiding is recorded as an `unevaluated` annotation instead; test 2 step 2 pins it either way.
2. `POST /api/v1/maintenance/on` (with a reason) and `POST /api/v1/maintenance/off` as that user → `403`,
   `"The user doesn't have enough privileges"`.
3. Maintenance is still off.

**Test 2 (`@destructive`) — while on, a regular user's writes and runs are refused, reads and sign-in work, and a
superuser can still write.** A throwaway user creates a flow of their own before maintenance is on.

1. `POST /maintenance/on` with a unique reason → `200`, `maintenance: true`, `paused: true`, `migration: false`,
   the reason, `set_by` = the superuser's id; `GET /status` agrees.
2. The user's status read shows it on with the reason and `set_by: null`.
3. As the user, each is refused `503` with exactly `{"detail": "This instance is in maintenance mode."}`: renaming
   their flow (`PATCH /api/v1/flows/{id}`), creating a flow, creating a variable.
4. As the user, starting a run (`POST /api/v1/build/{id}/flow`) → the same `503`.
5. As the user, `POST /maintenance/off` → the same `503`; maintenance is still on.
6. Reads work: the user's flow reads `200` with its original name, and is in `GET /api/v1/flows/`.
7. Sign-in works: `POST /api/v1/login` as the user → `200` with an access token.
8. The superuser creates a flow (`201`) and renames it (`200`).
9. `POST /maintenance/off` → `200`, `maintenance: false`, `paused: false`, `reason: null`, `set_by` the superuser;
   the user reads it off.
10. The user's rename now succeeds (`200`) and a variable create is `201`.

Maintenance is turned off in a `finally`, whatever happened. A failure of that turn-off is recorded as an annotation
rather than thrown, so it never hides the test's own error; `afterAll` turns it off again and does fail.

**Test 3 (`@destructive`) — turning maintenance on and off from the upgrade reports page shows and removes the
paused notice.**

1. Import `tests/assets/api/upgrade-report-empty.json` (`POST /api/v1/upgrade-reports`, raw body) → `201` and a
   report id; create a flow for the editor.
2. Open `/settings/upgrade-reports?report={id}`: *Maintenance is off.*, and the notice
   (`changes-paused-notice` inside the *Maintenance status* region) is empty.
3. *Turn maintenance on* opens the dialog *"Ordinary changes and new flow runs will pause for everyone."*; fill
   *Reason (optional)* and confirm. The dialog closes and the API reads `maintenance: true`, the reason, `set_by`
   the superuser.
4. The page shows *Maintenance is on.* and the reason; the notice reads the maintenance text.
5. `/flow/{id}` (the editor) shows the same notice.
6. Back on the report, *Turn maintenance off* opens *"Ordinary changes and new flow runs will resume for
   everyone."*; confirm. *Maintenance is off.*, the notice is empty again, and the API reads it off.

**Teardown (`afterAll`).** Turn maintenance off if anything left it on; delete the superuser's flows and the
throwaway users (their flows and variables go with them).

---

## Validation criterion *(required)*

- **Superuser gate:** the exact `403` on both routes with maintenance off, and the status readable without `set_by`
  (evaluated when there is a `set_by` to hide; see test 1).
- **On:** the reason and the superuser's id recorded and echoed by `status`.
- **Refusal:** `503` with the exact body on the three writes, the run and `off`, for a regular user; a refused
  rename leaves the stored name unchanged. A maintenance mode that stopped refusing would return `200`/`201` here.
- **Kept:** reads, the regular user's sign-in, and the superuser's writes. A maintenance mode that also froze the
  superuser would fail step 8 (and make it impossible to apply repairs).
- **Off:** the flags back to false, and the same regular-user writes succeeding.
- **Page:** the dialog copy, the on/off state text, the reason, and the notice text appearing (page and editor) and
  disappearing, each checked against the API's status.

---

## Notes

- The notice reads the status through `useMigrationPauseQuery` (every 30 s); on the upgrade reports page
  `useUpgradeMaintenance` polls the same query every 5 s, and the page's own mutation writes the new status into it
  at once (`setQueryData`). The editor reads it on load. The spec never waits on a poll.
- The imported report stays in the instance's report history: report rows have no delete route (see
  `api-upgrade-reports.md`). It holds no flow, and its source identity is a container path, not this instance's.
- Every call this spec makes directly is re-dialled once if the server's 2 s keep-alive closed its socket
  (`retryOnDroppedConnection`); a refusal answered twice still fails as it should. The shared helpers (the throwaway
  user, `postLogin`, `deleteFlow`) and the setup's `whoami` make their own calls.

---

## What this test does not cover *(and why)*

- **Work admitted before maintenance** (a queued or running job held until it is lifted): it needs a run that lasts
  across the switch, a flaky timing setup for a small gain; the refusal of a new run is covered.
- **The notice as a regular user sees it in the browser**: the notice and its text are the same for every
  signed-in user (it reads the same status); the browser here is the superuser's.
- **External SSO sign-in while on** (`ExternalAuthMaintenanceError`, the *externalAuthNotice*): no SSO provider in
  the OSS lanes.
- **The CLI** (`langflow maintenance on|off`) and **instance migration's file pause**, which shares the middleware
  but has its own lane (`instance-migration-pause.spec.ts`).

---

## Preconditions *(required)*

- Langflow 1.14 with the maintenance routes (`1.14.0.dev39` measured).
- Tests 2–3: the destructive lane (`PW_DESTRUCTIVE=1`, one worker).

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/maintenance.py` — `status`, `on`, `off`, the superuser gate, `set_by` hidden from regular users
- `src/backend/base/langflow/services/maintenance/state.py` — `MAINTENANCE_REFUSAL`, `set_maintenance`, `maintenance_status`
- `src/backend/base/langflow/api/utils/migration_pause.py` — `MigrationPauseMiddleware`: reads pass, login passes, superusers pass, everyone else `503`
- `src/backend/base/langflow/services/database/models/maintenance.py` — the maintenance row and `REASON_MAX_LENGTH`
- `src/backend/base/langflow/api/v1/login.py` — sign-in while on skips its own writes
- `src/backend/base/langflow/api/v1/upgrade_reports.py` — report import, used to open a report view
- `src/frontend/src/components/common/changesPausedNotice/index.tsx` — the notice and its test id
- `src/frontend/src/pages/SettingsPage/pages/UpgradeReportsPage/MaintenanceControls.tsx` — the controls, the dialogs and the reason
- `src/frontend/src/pages/SettingsPage/pages/UpgradeReportsPage/RepairControls.tsx` — where the controls render (inside a report)
- `src/frontend/src/pages/SettingsPage/pages/UpgradeReportsPage/ReportView.tsx` — renders the repair controls in every report
- `src/frontend/src/pages/AppAuthenticatedPage/index.tsx` — mounts the notice on every signed-in page, the editor included
- `src/frontend/src/controllers/API/queries/migration/use-migration.ts` — `useMigrationPauseQuery`, the status the notice reads
- `src/frontend/src/controllers/API/queries/upgrade-reports/index.ts` — `useUpgradeMaintenance` and `useSetUpgradeMaintenance`
- `src/frontend/src/locales/en.json` — every string asserted: the notice, the dialog copy, the on/off text, *Reason (optional)*, *Maintenance status*
- `tests/assets/api/upgrade-report-empty.json` — the empty checker report
- `tests/helpers/auth/throwaway-user.ts` — the regular user
