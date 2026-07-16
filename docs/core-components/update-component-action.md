# Spec: Update component action

**Test file:** `tests/tests-automations/regression/core-components/update-component-action.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

A user can **apply** the update of an outdated component and the flow reacts
correctly: the component is updated in place, the flow's outdated count drops by
one, and — because the review dialog defaults to creating a backup — a
**`<flow> (Backup)`** flow is persisted before the change.

This is the §2.3 "Update component action" behaviour — the *apply* half of the
component-updates story, distinct from its two siblings which never mutate the
flow:

- `outdated-component-notification.spec.ts` (#689) — asserts the outdated
  **notification** only.
- `component-breaking-change-alert.spec.ts` — opens the review dialog and asserts
  the **alert** (warning, backup default, opt-in), then **cancels**.

This spec is the only one that actually clicks **Update Component** and asserts
the post-apply effects.

---

## Setup & determinism

- A flow with outdated components is produced deterministically by importing the
  fixture `tests/assets/flows/outdated_flow.json` (5 components pinned to a
  1.4.0-era snapshot — all resolve to outdated updates on the current nightly)
  via the REST API (`createFlow`, with the fixture's own `id`/`endpoint_name`
  stripped so the backend mints a fresh id) and opening it at `/flow/<id>`.
- A **one-time assistant onboarding tooltip** can overlay the canvas and
  intercept clicks; the spec dismisses it defensively
  (`getByLabel("Dismiss assistant onboarding tooltip")`) before interacting.
- The **outdated count is emergent** (frozen fixture vs the running nightly), so
  the spec never pins a literal count: it parses the banner number `N` before the
  apply and asserts it becomes `N - 1` after (count-agnostic — see the caveat).

### Tests

1. **Applying a single component update refreshes it, decrements the outdated
   count, and creates a backup.** Import the fixture and open it. Read the
   outdated count `N` from the banner (`/\d+ components? needs? updates?/i`). Open
   the first component's review dialog (`review-button`), confirm the backup
   checkbox is checked by default (`backup-flow-checkbox`), and click
   **Update Component**. Then assert:
   - the banner count drops to `N - 1` (one fewer outdated component);
   - the **per-node update indicators refresh**: the total on-canvas indicators
     (`review-button` + `update-button`) also drop to `N - 1`, staying consistent
     with the banner (the applied component no longer shows an update affordance).
     Counted as the breaking-agnostic sum because applying an update can re-diff
     the remaining nodes (a breaking `review-button` may become a non-breaking
     `update-button`), so the durable invariant is the *total*, not a specific
     button;
   - a backup flow whose name ends with **"(Backup)"** now exists
     (`GET /api/v1/flows/`), i.e. the update created a safety copy before
     mutating. Its id is captured for id-scoped cleanup.

---

## Tags

`@stable` `@regression` `@components` `@ui-ux`

`@components` (canvas component update) + `@ui-ux` (functional). `@stable` is
added on promotion after the deterministic-run and force-fail validation below.
No prior test covered the apply action (the inherited conditional-bypass
apply-update was removed in #689); this is a new dedicated spec.

---

## Validation criterion

| # | State | Locator / call | Expected |
|---|---|---|---|
| 1 | Before apply | banner `/\d+ components? needs? updates?/i` → `N` | `N ≥ 1` |
| 1 | Review dialog | `getByTestId("backup-flow-checkbox")` | `data-state="checked"` (backup default) |
| 1 | After **Update Component** | banner count | `N - 1` (one fewer outdated component) |
| 1 | After **Update Component** | `review-button` + `update-button` count | `N - 1` (per-node indicators refresh, consistent with banner) |
| 1 | After apply | `GET /api/v1/flows/` → a flow whose name ends `"(Backup)"` | exists (safety copy created) |

Each assertion fails if the apply-update action regresses: clicking Update
Component no longer refreshes the component (count stays at `N`), or the
default-on backup is not created.

### Frozen-fixture caveat

`outdated_flow.json` carries no per-node version (only `last_tested_version:
"1.4.0"`); outdatedness is emergent from diffing it against the running nightly.
The spec asserts a **relative** decrement (`N → N-1`), never a literal count, so
a benign version bump that changes how many components are outdated does not
false-fail it. If a future release makes every fixture component up-to-date,
`N` becomes 0 and the `N ≥ 1` precondition legitimately fails — the cue to
refresh the fixture, not a product bug.

Scouted live against `langflow-nightly 1.11.0.dev44` before authoring: applying
the first component's update moved the banner from "5 components need updates" to
"4 components need updates" and created a `… (Backup)` flow.

---

## External dependencies

- `tests/assets/flows/outdated_flow.json` — the outdated fixture (shared with the
  notification and breaking-change specs).
- `tests/helpers/flows/create-flow.ts` — API import;
  `tests/helpers/flows/delete-flow.ts` — id-scoped cleanup;
  `tests/helpers/auth/get-auth-token.ts` — auth.
- Review/apply UI: `review-button` (per-node breaking update), the review dialog's
  `backup-flow-checkbox` (default checked) and its **Update Component** button
  (no testid — matched by role/name), `getByLabel("Dismiss assistant onboarding
  tooltip")` for the one-time overlay.
- No model-provider credentials required — no flow is executed.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.11.x).
- Auth via `auto_login` (repo default).

---

## What this test does not cover

- The **non-breaking** silent `update-button` path (the fixture is all-breaking;
  a non-breaking apply would need a different fixture).
- **Review All** / bulk apply of every outdated component at once — this spec
  applies a single component to keep the count assertion precise.
- The notification surface and the alert/dialog copy — owned by
  `outdated-component-notification.spec.ts` and
  `component-breaking-change-alert.spec.ts` respectively.

---

## Notes

- **Force-fail probes (executed during validation):** documented in the PR
  Validation block — one mutation per test, observed failing, then reverted.
- Both created flows (the imported host flow and the `(Backup)` copy) are deleted
  id-scoped in `afterEach` — applying the update mutates state and creates the
  backup, so cleaning both is load-bearing.
