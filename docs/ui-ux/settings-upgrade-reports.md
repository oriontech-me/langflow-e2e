# Settings — Upgrade reports

**File:** `tests/tests-automations/regression/ui-ux/settings-upgrade-reports.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2567)

Owning issue: #2567. The API contract under this page (and the measured facts about checks, the global lock and
the maintenance requirement) is `docs/api/instance/api-upgrade-reports.md`.

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
| Check outcome | `#upgrade-check-feedback`: *"The report for Langflow 1.14.0 is ready."* plus *"OK: n · Needs review: n · Needs repair: n"* |
| Select a flow | `getByLabel("Select <flow name> for preview")` |
| Preview | `getByRole("button", { name: "Preview selected updates" })` |
| Preview outcome | *"Preview complete. No flows have changed."*, the target registry fingerprint, and one line per flow: *"<name> · Ready for update"* / *"<name> · Manual repair required"* |
| Maintenance | *"Maintenance is off."* and `getByRole("button", { name: "Turn maintenance on" })`, which opens a confirmation dialog (`getByRole("dialog")`, optional *Reason*, *Cancel*, *Turn maintenance on*) |
| Apply | the review checkbox *"I reviewed this 1 update and have a current backup."*, then `getByRole("button", { name: "Apply 1 reviewed update" })` (disabled until reviewed and maintenance is on) |

After a check the URL carries `?report=<report_id>`.

---

## Tags *(required)*

Test 1: `@stable` `@settings` `@database`. Test 2: `@destructive` `@settings` `@database`.

**Test 2 is `@destructive` and therefore not `@stable`**: applying requires database maintenance, which refuses
writes instance-wide (see the API doc). It runs with `PW_DESTRUCTIVE=1 npx playwright test --grep @destructive`.

---

## Step by step *(required)*

**Setup.** Through the API, the same two flows as the API spec, with per-run names: *breaking*
(`outdated_flow.json`) and *safe* (its OpenAI node plus a current Chat Output, one edge). Teardown deletes both
and turns maintenance off through the API if it is on.

**Test 1 — a check from the page reports both flows, and its preview matches the API and changes nothing.**

1. Open `/settings/upgrade-reports`. Type the server's `main_version` into *Target release* and click *Check
   upgrade*. If the check is refused because another is running (the instance-wide lock), wait and click again.
2. The feedback reads *"The report for Langflow <main_version> is ready."*; the URL now has `?report=<id>`.
3. `GET /api/v1/upgrade-reports/<id>` holds both flows: *breaking* `fail`, *safe* `ok` (the page's report is the
   API's report).
4. Select both flows and click *Preview selected updates*: *"Preview complete. No flows have changed."*,
   *"<safe> · Ready for update"*, *"<breaking> · Manual repair required"*, and the fingerprint the page shows
   equals the `target_sha256` of `POST /api/v1/upgrade-repairs/preview` for the same flows.
5. Both flows' stored data is unchanged and *Apply* is disabled while maintenance is off.

**Test 2 (`@destructive`) — apply from the page under maintenance.**

1. Run a check and preview the *safe* flow as in Test 1.
2. Click *Turn maintenance on*; a confirmation dialog explains *"Ordinary changes and new flow runs will pause for
   everyone…"*; confirm with its own *Turn maintenance on*. The API's maintenance status then reads `true`.
3. Tick the review checkbox and click *Apply 1 reviewed update*; the page shows the saved outcome for the flow.
4. Through the API: the flow's OpenAI node code changed, the edge is intact, and its versions hold one retained
   entry with `retained_reason: "admin-upgrade-repair"`.
5. Maintenance is turned off in a `finally` (API), whatever happened.

---

## Validation criterion *(required)*

- **Check:** the ready message and a report id whose report holds both flows with the right status.
- **Preview:** the per-flow lines and the fingerprint equal to the API's, with nothing written. A page that
  previewed the wrong flows, or wrote during preview, fails here.
- **Apply (destructive):** the outcome on the page and the API's updated flow plus retained recovery version.

---

## Notes

- **Backend-error gate.** A check holds an instance-wide lock, so a check from the page can meet one another
  spec started (the API spec, in parallel) and get `409 {"code": "check_running"}`, which the spec retries. The
  fixture's gate has no form for an error that is allowed *when* it happens, so the spec calls
  `page.allowHttpErrors()` and replaces the gate with its own listener over the same policy
  (`classifyHttpError` in `tests/fixtures/http-error-policy.ts`) minus that one response:
  `POST /api/v1/upgrade-reports/checks` → `409`. Any other monitored 4xx/5xx fails the test in `afterEach`.
- **Page load under a running check.** A check runs inside the server process (about 40 s). With the API spec's
  check running in parallel, a one-worker server answered the page late enough that its root missed a 30 s wait
  once in three combined runs (never in five runs alone), so the page load waits up to 150 s.

---

## What this test does not cover *(and why)*

- Importing and exporting report files, and the report history pagination.
- Checking against a newer release (needs `uvx` and the network).

---

## Preconditions *(required)*

- Langflow 1.14 with the Upgrade reports page (`1.14.0.dev39` measured).
- Test 2: the destructive lane.

---

## External dependencies *(required)*

- `src/frontend/src/pages/SettingsPage/pages/UpgradeReportsPage/index.tsx` — the page
- `src/backend/base/langflow/api/v1/upgrade_reports.py` — the check and the report the page reads
- `src/backend/base/langflow/api/v1/upgrade_repairs.py` — preview and apply
- `src/backend/base/langflow/services/flow_repair/service.py` — repair statuses and the maintenance requirement
- `tests/assets/flows/outdated_flow.json` — the frozen outdated flow (#2424)
