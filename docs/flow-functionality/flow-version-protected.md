# Flow Functionality — protected (retained) flow versions

**File:** `tests/tests-automations/regression/flow-functionality/flow-version-protected.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev39`, #2566)

Owning issue: #2566. The versions API without retention is `docs/api/flows/api-flows-versions.md`; the evaluation
that retains a version is `docs/api/evals/api-evaluations.md` (#2564); the upgrade repair that retains one is
`docs/api/instance/api-upgrade-reports.md` (#2567).

---

## What this test validates *(required)*

Since 1.14 the server can **retain** a flow version that something still needs (upstream #16578): the version an
evaluation ran, or the recovery point an upgrade repair kept. A retained version cannot be deleted. The API
refuses it, and the version history in the editor marks it **Protected**, gives the reason, and disables its
*Delete*. Without this, a user could delete the version an evaluation's results were scored against, or the only
way back from an upgrade repair.

**Measured (`1.14.0.dev39`), and what changed relative to the issue:**

1. The list (`GET /api/v1/flows/{id}/versions/`) carries `retained` on every entry, and `retained_reason` only when
   the version is retained: the route excludes `None` fields, so a plain version has no `retained_reason` key.
2. `DELETE` of a retained version is `409` with `detail` *"Version entry {id} is retained and cannot be deleted.
   Reason: {reason}."*, and the version is still listed after it.
3. The badge's tooltip and the disabled *Delete*'s tooltip carry the same text, one per reason:
   *"An evaluation uses this version, so it can't be deleted."* and *"This version is a recovery point from an
   upgrade repair, so it can't be deleted."* The badge also holds that text as `sr-only` content, so the row's
   text contains it.
4. The *Delete* item of a retained version is a disabled `menuitem` (`aria-disabled="true"`), so it ignores the
   pointer: its tooltip sits on a wrapper, and opens only when the pointer arrives from outside that wrapper.
5. The confirmation for deleting a plain version is a portal with no `dialog` role: *"Delete Version"*, *"This will
   permanently delete v2. This can't be undone."*, and *Cancel* / *Delete* buttons.
6. **The issue's optional second source is covered** (#2567 landed first): an upgrade repair's recovery version is
   retained as `admin-upgrade-repair`. That needs database maintenance, which is instance-wide, so it is a
   separate `@destructive` test.

---

## Tags *(required)*

Test 1: `@stable` `@workspace` `@database` `@ui-ux`. Test 2: `@destructive` `@workspace` `@database` `@ui-ux`.

Test 1 retains a version through a keyless evaluation run (an echo flow and a text scorer, no model call), takes
seconds and touches only its own flow, so it runs in the normal lane as `@stable`. Test 2 applies an upgrade repair,
which needs database maintenance: that refuses every regular user's writes on the instance, so it is
`@destructive` and therefore **not** `@stable` (CLAUDE.md: never combine the two). Run it with
`PW_DESTRUCTIVE=1 npx playwright test --grep @destructive` (one worker).

Test 1 is skipped (with the reason) when the evals surface is absent on the instance, as the evals specs are
(`readEvalsSurface`).

---

## Step by step *(required)*

**Setup (`beforeAll`).** A bearer token, the evals surface verdict, and the component catalog (read once).

**Test 1 — an evaluation's version is Protected.**

1. Create an echo flow (Chat Input → Chat Output, `createEchoFlow`), a one-row dataset and an evaluation with an
   `exact_match` scorer; run it and wait for `completed`. Then `POST …/versions/` with a description: a plain v2.
2. The list holds v1 `{version_tag: "v1", description: "Evaluation run", retained: true,
   retained_reason: "evaluation"}` (its id is the run's `flow_version_id`) and v2 `{retained: false}`.
3. `DELETE` v1 → `409` with the exact detail (reason `evaluation`); v1 is still listed.
4. Open the flow, then the history (`sidebar-nav-versions`). v1's row has the badge (`version-protected-badge`,
   *Protected*); hovering it shows the evaluation reason. v1's menu (*More options*): *Delete* is disabled, and
   hovering it shows the same reason.
5. v2's row has no badge, and its *Delete* is enabled.
6. *Delete* on v2 → the confirmation (*"This will permanently delete v2."*) → *Delete*: v2's row is gone, v1's stays,
   and the API lists only v1.

**Test 2 (`@destructive`) — an upgrade repair's recovery version is Protected with its own reason.**

1. Create a repairable flow (`buildOutdatedSafeFlow`, from the frozen `outdated_flow.json` and the live catalog);
   preview it (`ready`). Turn maintenance on, apply the repair (`updated`), and turn maintenance off in a `finally`.
   The flow has one version: the recovery point, `retained: true`, `retained_reason: "admin-upgrade-repair"`, its
   id the apply's `recovery_version_id`.
2. `DELETE` it → `409` with the exact detail (reason `admin-upgrade-repair`); still listed.
3. In the history, the badge and the disabled *Delete* carry the repair's reason.

**Teardown (`afterEach`).** Turn maintenance off if it is on; delete the evaluations (which releases their
versions), then the flows (their versions go with them), then the datasets.

---

## Validation criterion *(required)*

- **API:** the exact `409` detail naming the reason, and the version still listed. A server that stopped retaining
  would answer `204` and drop it.
- **Fields:** `retained` / `retained_reason` as measured, for both sources, and `retained: false` on the plain
  version (the control).
- **UI:** the badge only on the retained version, the reason text per source in both tooltips, *Delete* disabled on
  the retained version and enabled on the plain one, and the plain one actually deleted through the confirmation.

---

## Notes

- Opening a version's menu makes the rest of the page inert (`aria-hidden`), so the rows cannot be located by role
  while it is open; the spec closes it with `Escape` (pressed until the menu is gone: the first press may only close
  the tooltip) before the next row.
- The tooltip on the disabled *Delete* is re-hovered from the *Export* item until it opens (pointer has to enter the
  wrapper from outside).
- Each test's versions go with its flow; nothing is shared between the tests.

---

## What this test does not cover *(and why)*

- **A deployment's retained version** (`wxo_deployments`): behind `feature_flags.wxo_deployments: false` on OSS.
- **Releasing a version** (deleting the evaluation sets `retained: false`): covered by `api-evaluations.spec.ts`.
- **An unknown or empty reason** (*"This version is protected and can't be deleted."* and the generic
  *"{reason}. This version can't be deleted."*): no OSS source writes another reason.

---

## Preconditions *(required)*

- Langflow 1.14 with flow version retention, the evaluations API and upgrade repairs (`1.14.0.dev39` measured).
- Test 2: the destructive lane (`PW_DESTRUCTIVE=1`, one worker).

---

## External dependencies *(required)*

- `src/backend/base/langflow/api/v1/flow_version.py` — the list (`response_model_exclude_none`), `DELETE`, the `409` translation
- `src/backend/base/langflow/services/database/models/flow_version/crud.py` — the retained check and its detail
- `src/backend/base/langflow/services/database/models/flow_version/exceptions.py` — `FlowVersionRetainedError`
- `src/backend/base/langflow/services/evaluations/versioning.py` — the evaluation's retained version
- `src/backend/base/langflow/services/flow_repair/retention.py` — `REPAIR_RETENTION_REASON`
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/FlowVersionSidebar/components/VersionListItem.tsx` — the badge, the tooltips, the disabled *Delete*
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/FlowVersionSidebar/components/DeleteConfirmDialog.tsx` — the confirmation
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/FlowVersionSidebar/utils.ts` — `protectedReasonText`
- `src/frontend/src/locales/en.json` — the *Protected* label and the reason strings
- `tests/helpers/api/evals/evaluations.ts` — the echo flow, the evaluation and its run
- `tests/helpers/api/evals/datasets.ts` — the dataset and the evals surface verdict
- `tests/helpers/flows/outdated-safe-flow.ts` — the repairable flow
- `tests/assets/flows/outdated_flow.json` — the frozen outdated flow
