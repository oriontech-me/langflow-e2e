# Spec: Component update with a breaking change — should alert the user

**Test file:** `tests/tests-automations/regression/core-components/component-breaking-change-alert.spec.ts`

**Last validated:** Langflow 1.11.x

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
OpenAI, Chat Output, Chat Memory) pinned to a version old enough that all 5
resolve to **breaking** updates on the current nightly. The flow is dropped onto
the flows-page drop zone (`cards-wrapper`) via a synthetic `DataTransfer` — the
same event an OS drag-and-drop fires — the same import mechanism used by the
`@stable` `import-invalid-json` spec.

### Tests

1. **Breaking-change outdated components alert with a Review action, not a
   silent Update.** Import the fixture, open it, and assert the canvas banner
   reads **"5 components need updates"**, that there are **5 `review-button`s and
   0 `update-button`s** (every outdated component is breaking → all routed to
   Review, none to a silent Update), and that the toolbar action reads
   **"Review All"**.

2. **Reviewing a single breaking change warns about disconnection and defaults
   to a backup.** Click the first `review-button`; the review dialog must show
   the breaking-change warning copy (it may *disconnect this component from your
   flow, requiring you to review or reconnect it afterward*) and the
   `backup-flow-checkbox` must be **present and checked by default**. The dialog
   is then cancelled — the test never applies an update, so no flow state is
   mutated.

3. **"Review All" flags every outdated component as breaking and pre-selects
   none.** Click the "Review All" toolbar button; the multi-component dialog must
   show **5 "Breaking"** update-type tags (one per component), the
   `backup-flow-checkbox` checked by default, and the submit button **"Update
   Components" disabled** — because breaking components are intentionally *not*
   pre-selected, the user must explicitly opt each one in before the update can
   be applied. The dialog is cancelled without applying.

No test applies the update (no "Update Component(s)" click), so the imported flow
is never mutated and no `(Backup)` flow is created. Each imported flow is tracked
by id (from `POST /api/v1/flows/ → 201`) and deleted id-scoped in `afterEach`.

---

## Tags

`@stable` `@components` `@regression` `@ui-ux`

---

## Validation criterion

| # | State | Locator | Expected |
|---|---|---|---|
| 1 | After import + open | `getByText("5 components need updates")` | `toBeVisible()` |
| 1 | After import + open | `getByTestId("review-button")` | `toHaveCount(5)` |
| 1 | After import + open | `getByTestId("update-button")` | `toHaveCount(0)` |
| 1 | After import + open | `getByTestId("update-all-button")` | text `Review All` |
| 2 | Single review dialog | warning copy `/disconnect this component .* review or reconnect/i` | `toBeVisible()` |
| 2 | Single review dialog | `getByTestId("backup-flow-checkbox")` | visible and `toBeChecked()` |
| 3 | Review All dialog | `getByText("Breaking")` | `toHaveCount(5)` |
| 3 | Review All dialog | `getByTestId("backup-flow-checkbox")` | `toBeChecked()` |
| 3 | Review All dialog | `getByRole("button", { name: "Update Components" })` | `toBeDisabled()` |

Each assertion fails if the breaking-change alert regresses: e.g. a breaking
component routed to a silent `update-button`, the warning copy removed, the
backup default flipped off, or a breaking component pre-selected (submit enabled).

---

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/components/NodeUpdateComponent/index.tsx`
  — owns the per-node update bar; `hasBreakingChange` selects
  `data-testid="review-button"` (label "Review") vs `"update-button"` (label
  "Update") and the warning-dot colour / "Update available" label.
- `src/frontend/src/modals/updateComponentModal/index.tsx` — the review dialog:
  the breaking warning copy, the `backup-flow-checkbox` (default checked), the
  "Breaking"/"Standard" update-type column, and the submit disabled when
  `isMultiple && selectedComponents.size === 0` (breaking components start
  unselected).
- `tests/assets/flows/outdated_flow.json` — the fixture flow whose 5 components
  are pinned behind the current version so all resolve to breaking updates.
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

- **Applying** the update (clicking "Update Component(s)") and asserting the node
  refreshes / the backup flow is created — deliberately out of scope so no flow
  state is mutated; that is the "Update component action" bullet, tracked
  separately.
- The **non-breaking** ("Update", green, auto-selected) path — this spec is about
  the breaking alert. A non-breaking fixture would be a separate case.
- The ag-grid row-checkbox internals — the user-facing "Update Components
  disabled" state is asserted instead of `input[data-ref="eInput"]` indices.

---

## Notes

- **Force-fail probes (executed during validation):** documented in the PR
  Validation block — one mutation per test, each observed failing, then reverted.
- The fixture is renamed with a unique per-run suffix before import so the test
  waits for *its own* dropped card (avoids racing bootstrap-seeded cards), the
  same pattern as the upstream `outdated-actions` reference.
