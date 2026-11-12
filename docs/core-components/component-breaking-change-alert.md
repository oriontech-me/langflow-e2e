# Spec: Component update with a breaking change — should alert the user

**Test file:** `tests/tests-automations/regression/core-components/component-breaking-change-alert.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev25`, #2424 — OpenAI now
a standard update) and 1.13.x (`1.13.1`, per-flow contract, all five breaking)

---

## What this test validates

When a saved flow contains components whose stored version is **behind** the
current backend version **in a breaking way** (the update may change
inputs/outputs or disconnect the node), Langflow must **alert the user** rather
than silently updating: it surfaces a **"Review"** action (not the plain
"Update"), warns that the update may disconnect the component, defaults to
creating a backup, and refuses to pre-select the breaking components for update.

The behaviour is driven off the frontend's outdated-component diff
(`NodeUpdateComponent` and `UpdateComponentModal`). `hasBreakingChange`
switches the node's action button between `data-testid="update-button"`
(standard, safe) and `data-testid="review-button"` (breaking, must be reviewed),
and the toolbar "update all" button between "Update All" and **"Review All"**.

The state is produced deterministically by importing a fixture flow,
`tests/assets/flows/outdated_flow.json` — 5 components (Prompt, Chat Input,
OpenAI, Chat Output, Chat Memory) pinned to a version old enough that all 5 are
**outdated** on the current nightly, and at least one resolves to a **breaking**
update. Up to `1.14.0.dev23` (and on every 1.13 build) all 5 were breaking; from
`1.14.0.dev24` OpenAI resolves to a **standard** update — see *The breaking rule
changed in 1.14* below. The flow is dropped onto
the flows-page drop zone (`cards-wrapper`) via a synthetic `DataTransfer` — the
same event an OS drag-and-drop fires — the same import mechanism used by the
`@stable` `import-invalid-json` spec.

### Tests

1. **Breaking-change outdated components alert with a Review action, not a
   silent Update.** Import the fixture, open it, and assert that **at least one
   `review-button`** is present (a breaking update is surfaced for Review rather
   than via the one-click silent `update-button`), that the canvas banner reports
   the outdated total (`/\d+ components? needs? updates?/`), and that the toolbar
   action reads **"Review All"** (which renders only when a breaking update is
   present). The count is asserted as `> 0`, not a pinned literal — see the
   *frozen-fixture* caveat below.

2. **Reviewing a single breaking change warns about disconnection and defaults
   to a backup.** Click the first `review-button`; the review dialog must show
   the breaking-change warning copy (it may *disconnect this component from your
   flow, requiring you to review or reconnect it afterward*) and the
   `backup-flow-checkbox` must be **present and checked by default**. The dialog
   is then cancelled — the test never applies an update, so no flow state is
   mutated.

3. **"Review All" tags each breaking component and pre-selects only the
   non-breaking ones.** Capture both counts from the canvas — breaking
   (`review-button`) and standard (`update-button`) — and click the "Review All"
   toolbar button. The multi-component dialog must list every outdated component
   (one grid row each), tag exactly the breaking ones **"Breaking"** and the rest
   **"Standard"**, and default `backup-flow-checkbox` on. Its selection is seeded
   with the **non-breaking components only**
   (`components.filter((c) => !c.breakingChange)` in `updateComponentModal`) — the
   user must opt each breaking update in. The submit **"Update Components"** is
   enabled exactly when something is pre-selected: disabled for an all-breaking
   mix (every 1.13 build, ≤ dev23), enabled for the current one (OpenAI
   pre-selected, `1.14.0.dev24`+). When it is enabled, the test **applies the
   pre-selection** with the backup unchecked and reads what was applied: every
   `update-button` is gone (the standard components were refreshed), the
   `review-button` count is unchanged (no breaking component was), and exactly
   one `POST /api/v1/custom_component` was sent per standard component. The
   pre-selection is read from what is applied rather than from the grid's
   checkboxes, because the grid does not display it reliably — see *The grid
   hides the pre-selection* below. The test no longer requires an all-breaking
   fixture: that precondition was what failed on 2026-11-12 (#2424).

Tests 1–2 never apply an update. Test 3 applies only the pre-selected (standard)
updates, and only to the flow it imported, with the backup unchecked, so no
`(Backup)` flow is created; on an all-breaking mix it applies nothing. Each imported flow is tracked
by id and deleted id-scoped in `afterEach`, through the shared
`trackCreatedFlows` tracker in `{ strict: true }` mode (a failed delete still
fails the teardown, as it did before the tracker existed).

### The import contract changed in 1.14 (#2399)

Up to 1.13 the drop created the flow with one `POST /api/v1/flows/`, answering
the created flow object. From `1.14.0.dev18` (langflow-ai/langflow#16120,
*"Selected flow imports use one atomic request"*) it sends one
`POST /api/v1/flows/upload/` for the whole selection, answering an **array**. The
import helper waited for a pathname of exactly `/api/v1/flows`, which dev18 never
sends, so all three tests timed out at `page.waitForResponse` with the imported
card on screen (2026-11-05). The helper now reads the imported id from whichever
contract the version under test speaks, and requires **exactly one** flow to have
been created by the drop of a single-flow file.

### The breaking rule changed in 1.14 (#2424)

langflow-ai/langflow#16255 (*"integrate administrator upgrade reports and
repairs"*, `2c403778d8`, first nightly `1.14.0.dev24`; not on any 1.13 line)
gave the editor and `lfx upgrade` one shared rule: a saved node is **breaking**
when updating it drops a connection, drops a value, or needs input nobody gave.
A narrowed input or a changed field type counts only when an edge goes into the
field or it holds a value; an added output or a renamed display name is safe.
Under that rule the fixture's OpenAI node is classified a **standard** update
(which of its field differences the old rule counted and the new one does not
was not isolated), while Prompt,
Chat Input, Chat Output and Chat Memory stay breaking (measured on
`1.14.0.dev25`: 4 `review-button`, 1 `update-button` on OpenAI; the dialog lists
OpenAI as `Standard` and pre-selects it). The dialog's seeding contract did not
change. Only the classification of one fixture node did, which is the
"benign drift to a mix" the frozen-fixture caveat below already promised to
tolerate. The VM daily of 2026-11-12 ran Test 3 on `dev25` and failed all three
attempts on the old all-breaking precondition (`Expected: 0`, `Received: 1`);
Tests 1–2 and the other three specs importing this fixture passed there.

---

## Tags

`@stable` `@components` `@regression` `@ui-ux`

---

## Validation criterion

| # | State | Locator | Expected |
|---|---|---|---|
| all | After the drop | flows the import created (either contract) | exactly `1` — the shared import gate, before anything is opened |
| 1 | After import + open | `getByTestId("review-button")` | `≥ 1` (breaking surfaced for Review) |
| 1 | After import + open | `getByText(/\d+ components? needs? updates?/i)` | `toBeVisible()` (also the shared import gate) |
| 1 | After import + open | `getByTestId("update-all-button")` | text `Review All` |
| 2 | Single review dialog | warning copy `/disconnect this component .* review or reconnect/i` | `toBeVisible()` |
| 2 | Single review dialog | `getByTestId("backup-flow-checkbox")` | visible and `toBeChecked()` |
| 3 | Review All dialog | grid data rows (`getByRole("row")` holding a `gridcell`) | `toHaveCount(breakingCount + nonBreakingCount)` — every outdated component listed |
| 3 | Review All dialog | `getByText("Breaking", { exact: true })` / `getByText("Standard", { exact: true })` in the dialog | `toHaveCount(breakingCount)` / `toHaveCount(nonBreakingCount)` (canvas `review-button` / `update-button` counts) |
| 3 | Review All dialog | `getByTestId("backup-flow-checkbox")` | `toBeChecked()` |
| 3 | Review All dialog | `getByRole("button", { name: "Update Components" })` | enabled **iff** `nonBreakingCount > 0` (disabled for an all-breaking mix) |
| 3 | After submitting the pre-selection (only when `nonBreakingCount > 0`, backup unchecked) | canvas `getByTestId("update-button")` | `toHaveCount(0)` — every standard component was updated |
| 3 | same | canvas `getByTestId("review-button")` | `toHaveCount(breakingCount)` — no breaking component was updated |
| 3 | same | `POST /api/v1/custom_component` requests sent from the click on | exactly `nonBreakingCount` — one per pre-selected component |

Each assertion fails if the breaking-change alert regresses: e.g. every breaking
component routed to a silent `update-button` (no `review-button` left, toolbar
falls back to "Update All"), the warning copy removed, the backup default flipped
off, a breaking component pre-selected (a `review-button` disappears and an extra
update request is sent), or a standard one left out of the seed (an
`update-button` survives).

### The grid hides the pre-selection (product finding, #2424)

On `1.14.0.dev25`, with the fixture's mix (OpenAI standard, four breaking), the
Review All grid showed **no row selected**: 0 of 4 runs on a fresh container
showed one within 20 s (`getByRole("row", { selected: true })` stayed `0`), while
"Update Components" was enabled the whole time, and clicking it sent
`POST /api/v1/custom_component` for OpenAI and refreshed it. On an instance that
had been running for hours the same row did read selected, after 0.7–3.6 s. The
dialog keeps its selection in React state (`selectedComponents`, which the submit
reads) and copies it into the grid from an effect keyed on `agGrid.current`, a
ref whose readiness does not re-run the effect; when the grid is not ready on
that pass, nothing re-applies the selection. So a user can apply a selection the
grid does not show. It predates #16255 and was invisible to this spec only
because an all-breaking fixture seeds an empty selection. Recorded here; not
filed upstream. The test therefore reads the pre-selection from what the dialog
applies, which holds whether or not that sync is fixed.

### The banner is gated on the component registry, not on elapsed time (#1061)

The outdated/breaking diff is computed against the frontend's component
registry, fetched at app bootstrap by `GET /api/v1/all?force_refresh=true`.
Measured on the running nightly, the banner appears **≈ the duration of that
request + ~1 s**: stalling the response by 8 s renders the banner at 8.9 s, and
stalling it by 20 s renders it at 21.0 s. Nothing is computed one-shot against
an empty store — the diff re-runs when the registry lands.

That makes a fixed wait on the banner a wait on someone else's clock. The
request rebuilds the whole registry (`force_refresh=true`) on a backend the
daily pins to a single worker while two Playwright workers share it, so it can
outlast any window chosen in advance; the original 30 s bound is exactly what
expired on 2026-07-27 and 2026-07-29 (`element(s) not found`, test duration
38 s, retry green in 6 s once the registry was warm).

The import helper therefore **waits for the registry response itself** before
opening the flow, and only then asserts the banner within a short window. The
generous bound belongs to the environment-dependent request; the assertion on
the product's own behaviour stays tight, so a genuinely missing banner still
fails fast instead of hiding behind a long timeout. The two failures are also
distinguishable in the log: a registry that never lands names the registry.

### Frozen-fixture caveat

`outdated_flow.json` carries no per-node version — only a top-level
`last_tested_version: "1.4.0"`. "Outdated" and "breaking" are therefore
**emergent** from diffing that 1.4.0-era snapshot against whatever the running
nightly ships, not pinned by the fixture. **Every** count-dependent check avoids
a literal — including the shared import gate (a count-agnostic banner regex, not
`"5 components need updates"`), the `≥ 1` / live `review-button` count, the
`"Breaking"`-tag count (tracks the live `review-button` count), and the
submit enabled/disabled branch (a function of the captured non-breaking count).
So a benign, unrelated version bump of one of the five components — whether it
becomes up-to-date (fewer outdated) or non-breaking (a mix) — does **not**
false-fail this `@stable` test as a product regression.

If a future Langflow release ever makes *every* one of these components
up-to-date or non-breaking, the durable signals (`review-button ≥ 1`,
`Review All`, the banner) will legitimately fail — that is the cue to refresh the
fixture to an older snapshot, not a product bug.

---

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/components/NodeUpdateComponent/index.tsx`
  — owns the per-node update bar; `hasBreakingChange` selects
  `data-testid="review-button"` (label "Review") vs `"update-button"` (label
  "Update") and the warning-dot colour / "Update available" label.
- `src/frontend/src/CustomNodes/helpers/check-code-validity.ts` —
  `codeHasBreakingChange`, the rule that classifies each outdated node as
  breaking or standard (shared with `lfx upgrade` since #16255).
- `src/frontend/src/modals/updateComponentModal/index.tsx` — the review dialog:
  the breaking warning copy, the `backup-flow-checkbox` (default checked), the
  "Breaking"/"Standard" update-type column, and the submit disabled when
  `isMultiple && selectedComponents.size === 0` (breaking components start
  unselected).
- `tests/assets/flows/outdated_flow.json` — the fixture flow whose 5 components
  are pinned behind the current version, at least one of them breaking. Shared
  with `import-outdated-flow`, `outdated-component-notification` and
  `update-component-action`, which is why #2424 changed the assertion rather
  than the fixture.
- `tests/helpers/flows/track-created-flows.ts` — reads the imported id from
  either import contract and owns the id-scoped cleanup.
- The import request, which depends on the version under test: one
  `POST /api/v1/flows/` answering the created flow (≤ 1.13), or one
  `POST /api/v1/flows/upload/` answering an array of the created flows
  (≥ 1.14.0.dev18 — `src/frontend/src/hooks/flows/use-upload-flow.ts`).
- No model-provider credentials required — the fixture's OpenAI node carries a
  dummy key and no flow is executed.

Testids, labels, banner text, the disabled-submit state and the 5×"Breaking"
tags were confirmed live against `langflow-nightly 1.11.0.dev38` via a throwaway
scout before authoring.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.11.x).
- Auth via `auto_login` (repo default).

---

## Relationship to existing coverage

`core-components/outdated-component-notification.spec.ts` is an inherited,
non-`@stable`, conditional-bypass "documentation test": it adds a *fresh*
component and only checks for an outdated indicator *if one happens to appear*
(it never does on a current nightly), so it validates nothing deterministically.
This spec is the dedicated, deterministic, `@stable` home for the **breaking**
half of §2.3 — it forces the outdated+breaking state via a fixture import and
asserts the concrete Review/warning/backup/opt-in alert surface. It does not
duplicate the inherited spec's logic; consolidating that inherited spec is out of
scope here.

---

## What this test does not cover

- **Applying** a breaking update, and the update itself as a feature — whether a
  refreshed node keeps its values and connections, and the `(Backup)` flow. Test 3
  applies the standard pre-selection only to observe which components the dialog
  selected (refreshed vs still outdated); what an update does to a node is
  `update-component-action.spec.ts`, the "Update component action" bullet.
- The grid's display of the pre-selection — not asserted, because the product
  does not display it reliably (*The grid hides the pre-selection*). The selection
  is observed through what the dialog applies, never through
  `input[data-ref="eInput"]` indices or grid class names.

---

## Notes

- **Force-fail probes (executed during validation):** documented in the PR
  Validation block — one mutation per test, each observed failing, then reverted.
- The fixture is renamed with a unique per-run suffix before import so the test
  waits for *its own* dropped card (avoids racing bootstrap-seeded cards), the
  same pattern as the upstream `outdated-actions` reference. Since #2399 the
  suffix is the clock **plus a random part**: the three tests run on two workers,
  and two imports reaching `POST /api/v1/flows/upload/` concurrently under the
  same name are refused with an unmapped `500` ("An internal error occurred while
  creating the flow."), where `POST /api/v1/flows/` answers `400 Name must be
  unique` — measured on both 1.13.1 and 1.14.0.dev18, so not new in 1.14, only
  newly reachable from the UI. The frontend retries a 5xx (up to 3 times), so the
  import still lands and the test still passes, but the `🚨 Backend Error` line it
  leaves is noise this spec should not cause.
