# Settings — Upgrade reports

**File:** `tests/tests-automations/regression/ui-ux/settings-upgrade-reports.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2567)

Owning issue: #2567. The API contract under this page (and the measured facts about checks, their cost, the lock
and the maintenance requirement) is `docs/api/instance/api-upgrade-reports.md`.

---

## What this test validates *(required)*

*Settings › Upgrade reports* (`/settings/upgrade-reports`, root `data-testid="upgrade-reports-page"`): an
administrator checks the flows in the database against a target release, opens the report, previews updates for
selected flows and, under database maintenance, applies them. The page must show what the API gives.

The page carries no test ids below its root; everything is located by role and accessible name, all
live-scouted on `1.14.0.dev39`:

| Control | Locator |
|---|---|
| Target release (free text over a release datalist) | `getByLabel("Target release")` |
| Run the check | `getByRole("button", { name: "Check upgrade" })` (disabled until a target is typed) |
| Check outcome | `#upgrade-check-feedback`: *"The report for Langflow 1.14.0 is ready."* plus *"OK: n · Needs review: n · Needs repair: n"*, or a `role="alert"` when the check is refused |
| Narrow the flow list | `getByLabel("Search names, owners, projects, or labels")` — the list shows 20 flows a page, ordered by flow id, so the spec searches its per-run suffix before selecting |
| Select a flow | `getByLabel("Select <flow name> for preview")` |
| Preview | `getByRole("button", { name: "Preview selected updates" })` |
| Preview outcome | *"Preview complete. No flows have changed."*, the target registry fingerprint, and one line per flow: *"<name> · Ready for update"* / *"<name> · Manual repair required"* |
| Maintenance | *"Maintenance is off."* and `getByRole("button", { name: "Turn maintenance on" })`, which opens a confirmation dialog (`getByRole("dialog")`, optional *Reason*, *Cancel*, *Turn maintenance on*) |
| Apply | the review checkbox *"I reviewed this 1 update and have a current backup."*, then `getByRole("button", { name: "Apply 1 reviewed update" })` (disabled until reviewed and maintenance is on); the outcome line becomes *"<name> · Updated"* |

After a check the URL carries `?report=<report_id>`.

---

## Tags *(required)*

Both tests: `@destructive` `@settings` `@database`. **No test in this file is `@stable`**, and that absence is
deliberate: each test runs a check from the page, which scans and dry-runs every flow on the instance (242 s with
30 flows, see the API doc) and loads the server meanwhile, and Test 2 also turns database maintenance on, which
refuses writes for everyone. Both belong to the serial lane, decided with the team on #2567's review. Run them
with `PW_DESTRUCTIVE=1 npx playwright test --grep @destructive`.

---

## Step by step *(required)*

**Setup (per test).** Through the API, the same two flows as the API spec, with names carrying a per-run suffix:
*breaking* (`outdated_flow.json`) and *safe* (`buildOutdatedSafeFlow`: the frozen OpenAI node plus a current Chat
Output, one edge). Teardown deletes both and turns maintenance off through the API if it is on.

A *check from the page* types the server's `main_version` into *Target release*, clicks *Check upgrade*, and
waits for either the ready message or the alert (up to 600 s for a running check). Only the lock refusal (*"A
check is already running on this server…"*) waits 5 s and clicks again, for at most 300 s; any other alert
(`check_failed`, `timeout`, `invalid_target_version`…) fails the test at once with its text.

**Test 1 — a check from the page reports both flows, and its preview matches the API and changes nothing.**

1. Open `/settings/upgrade-reports` and run a check from the page. The feedback reads *"The report for Langflow
   <main_version> is ready."*; the URL now has `?report=<id>`.
2. `GET /api/v1/upgrade-reports/<id>` holds both flows: *breaking* `fail`, *safe* `ok` (the page's report is the
   API's report).
3. Search the per-run suffix, select both flows and click *Preview selected updates*: *"Preview complete. No flows
   have changed."*, *"<safe> · Ready for update"*, *"<breaking> · Manual repair required"*, and the fingerprint the
   page shows equals the `target_sha256` of `POST /api/v1/upgrade-repairs/preview` for the same flows.
4. Both flows' stored data is unchanged and *Apply* is disabled while maintenance is off.

**Test 2 — apply from the page under maintenance.**

1. Run a check and preview the *safe* flow as in Test 1; record its stored edges.
2. Click *Turn maintenance on*; a confirmation dialog explains *"Ordinary changes and new flow runs will pause for
   everyone…"*; confirm with its own *Turn maintenance on*. The API's maintenance status then reads `true`.
3. Tick the review checkbox and click *Apply 1 reviewed update*; the page shows *"<safe> · Updated"*.
4. Through the API: the flow's OpenAI node code changed, its nodes are the same two, its stored edges deep-equal
   the recorded ones, and its versions hold one retained entry with `retained_reason: "admin-upgrade-repair"`.
5. Maintenance is turned off in a `finally` (API), whatever happened.

---

## Validation criterion *(required)*

- **Check:** the ready message and a report id whose report holds both flows with the right status.
- **Preview:** the per-flow lines and the fingerprint equal to the API's, with nothing written. A page that
  previewed the wrong flows, or wrote during preview, fails here.
- **Apply:** *Updated* on the page and, through the API, the updated flow with unchanged edges and a retained
  recovery version.

---

## Notes

- The page always calls `GET /api/v1/upgrade-reports/checks/releases`, which asks PyPI and answers
  `502 releases_unavailable` when it cannot. The fixture logs that response and does not fail on it; the check
  against the running release needs no network either way.

---

## What this test does not cover *(and why)*

- Importing and exporting report files, and the report history pagination.
- Checking against a newer release (needs `uvx` and the network).

---

## Preconditions *(required)*

- Langflow 1.14 with the Upgrade reports page (`1.14.0.dev39` measured).
- The destructive lane (`PW_DESTRUCTIVE=1`, one worker).

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/UpgradeReportsPage/index.tsx` — the page
- `src/frontend/src/pages/SettingsPage/pages/UpgradeReportsPage/FlowList.tsx` — the 20-a-page flow list and its search
- `src/frontend/src/pages/SettingsPage/pages/UpgradeReportsPage/RepairControls.tsx` — preview, maintenance and apply controls
- `src/backend/base/langflow/api/v1/upgrade_reports.py` — the check and the report the page reads
- `src/backend/base/langflow/api/v1/upgrade_repairs.py` — preview and apply
- `src/backend/base/langflow/services/flow_repair/service.py` — repair statuses and the maintenance requirement
- `tests/assets/flows/outdated_flow.json` — the frozen outdated flow (#2424)
- `tests/helpers/flows/outdated-safe-flow.ts` — the repairable flow
