# Spec: Outdated-component notification

**Test file:** `tests/tests-automations/regression/core-components/outdated-component-notification.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

When a saved flow contains components whose stored version is **behind** the
current backend version, Langflow must **notify the user** that those components
are outdated — both at the **flow level** (a count banner "N components need
updates" plus a bulk update-all affordance) and at the **node level** (each
outdated component carries its own per-node update indicator). This spec
validates the *notification surface only* — it never opens the review dialog or
applies an update.

The notification is driven off the frontend's outdated-component diff: the
canvas renders a per-node update bar (`data-testid="update-button"` when the
update is standard, `data-testid="review-button"` when it is breaking) on every
outdated node, and the flow header shows the aggregate count banner and the
toolbar bulk action (`data-testid="update-all-button"`, labelled "Update All" or
"Review All").

The state is produced **deterministically** by importing the fixture flow
`tests/assets/flows/outdated_flow.json` — the same fixture the `@stable`
`component-breaking-change-alert.spec.ts` uses — whose 5 components (Prompt, Chat
Input, OpenAI, Chat Output, Chat Memory) are pinned to a 1.4.0-era snapshot old
enough that all resolve to outdated updates on the current nightly. A
freshly-added component is never outdated on a current nightly, so importing a
pinned fixture is the only way to force the notification deterministically.

The fixture is imported via the **REST API** (`POST /api/v1/flows/` through the
`createFlow` helper) with a unique per-run name, then opened by navigating
straight to `/flow/<id>`. The outdated notification is computed on flow **open**
regardless of how the flow got there, so how it is imported is not what §8.2
validates — and API import + direct open is materially more deterministic than a
UI drag-and-drop, which on a fresh empty instance races with the empty-page
bootstrap that auto-seeds and opens a starter flow. (The sibling breaking-change
spec still drops onto `cards-wrapper` via a synthetic `DataTransfer`; this spec
deliberately does not, to keep the notification assertion isolated from
import-path flakiness.)

### Tests

1. **Importing a flow with outdated components raises the flow-level outdated
   notification.** Import the fixture, open it, and assert that the canvas count
   banner (`/\d+ components? needs? updates?/i`) is visible and that the toolbar
   bulk action `update-all-button` is visible with a label matching
   `/Review All|Update All/`. Both signals are count- and breaking-agnostic —
   see the *frozen-fixture* caveat.

2. **The outdated-notification count matches the per-node update indicators.**
   Import the fixture, open it, parse the number `N` out of the count banner, and
   count the per-node update affordances on the canvas
   (`review-button` + `update-button`). Assert `N ≥ 1` and that the per-node
   affordance count **equals** `N` — i.e. every component the banner counts as
   outdated is individually notified on its node, and vice-versa. This is the
   notification-integrity invariant: the aggregate total the user sees must match
   the on-canvas indicators. Breaking vs non-breaking is irrelevant here (both
   `review-button` and `update-button` count as "this node is outdated"), so a
   benign version bump that flips a component between the two does not false-fail.

No test opens the review dialog or clicks an update/review button, so the
imported flow is never mutated and no `(Backup)` flow is created. Each imported
flow's id is captured from the `createFlow` call and deleted id-scoped in
`afterEach`.

---

## Tags

`@stable` `@regression` `@components` `@observability`

`@observability` ties the spec to `QA-CHECKLIST.md` §8.2 Notifications ("Outdated
component notification"); `@components` to §2.3 Component Updates. `@stable` is
added on promotion after the deterministic-run and force-fail validation below.

---

## Validation criterion

| # | State | Locator | Expected |
|---|---|---|---|
| 1 | After import + open | `getByText(/\d+ components? needs? updates?/i)` | `toBeVisible()` (flow-level count banner) |
| 1 | After import + open | `getByTestId("update-all-button")` | visible, text `/Review All\|Update All/` |
| 2 | After import + open | `N` parsed from the banner text | `≥ 1` |
| 2 | After import + open | `review-button` count + `update-button` count | `=== N` (per-node indicators match the banner total) |

Each assertion fails if the outdated notification regresses: e.g. the count
banner disappears, the bulk update-all action stops rendering, or the per-node
indicators fall out of sync with the banner count (a node counted as outdated but
showing no update affordance, or vice-versa).

### Frozen-fixture caveat

`outdated_flow.json` carries no per-node version — only a top-level
`last_tested_version: "1.4.0"`. "Outdated" is therefore **emergent** from diffing
that 1.4.0-era snapshot against whatever the running nightly ships, not pinned by
the fixture. Every check is count-agnostic: the banner regex has no literal
count, `N` is parsed live, and the per-node assertion compares the two live
counts to each other rather than to a literal. So a benign, unrelated version
bump of one of the five components — whether it becomes up-to-date (smaller `N`)
or flips breaking↔non-breaking (`review-button` ↔ `update-button`) — does **not**
false-fail this `@stable` test.

If a future Langflow release ever makes *every* one of these components
up-to-date, the banner and per-node indicators legitimately vanish and `N` drops
to 0 — that is the cue to refresh the fixture to an older snapshot, not a product
bug.

Scouted live against `langflow-nightly 1.11.0.dev44` before authoring: the
fixture produced "5 components need updates", 5 `review-button`, 0
`update-button`, `update-all-button` = "Review All", and the per-node "Update
available" / "Flow needs review" copy.

---

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/components/NodeUpdateComponent`
  — owns the per-node update bar; renders `data-testid="update-button"`
  (standard) vs `data-testid="review-button"` (breaking) on every outdated node,
  plus the "Update available" label.
- The flow header / canvas toolbar — owns the "N components need updates" count
  banner and the `data-testid="update-all-button"` bulk action ("Update All" vs
  "Review All").
- `tests/assets/flows/outdated_flow.json` — the fixture flow whose 5 components
  are pinned behind the current version so they resolve to outdated updates.
- `tests/helpers/flows/create-flow.ts` — API import (`POST /api/v1/flows/` with
  transient-5xx retry); `tests/helpers/flows/delete-flow.ts` — id-scoped cleanup.
- No model-provider credentials required — the fixture's OpenAI node carries a
  dummy key and no flow is executed.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.11.x).
- Auth via `auto_login` (repo default).

---

## Relationship to existing coverage

- `core-components/component-breaking-change-alert.spec.ts` (`@stable`, §2.3)
  owns the **breaking** half: it opens the Review dialog and asserts the
  disconnection warning, the default-on backup checkbox, the "Breaking"
  update-type tags, and the opt-in (disabled submit). This spec stays strictly at
  the **notification surface** (banner + toolbar CTA + per-node indicator count)
  and never opens a dialog, so the two do not duplicate each other.
- **"Update component action"** (§2.3) — actually clicking update/review and
  asserting the node refreshes / a backup flow is created — mutates flow state
  and is a separate bullet, deliberately out of scope here.

This spec replaces the inherited conditional-bypass "documentation test" (which
added a *fresh* component and only asserted an indicator *if one happened to
appear* — it never did on a current nightly, so it validated nothing) with a
deterministic, fixture-driven notification test.

---

## What this test does not cover

- **Applying** the update (clicking "Update Component(s)" / "Review") and
  asserting the node refreshes or the backup flow is created — out of scope so no
  flow state is mutated; that is the separate "Update component action" bullet.
- The **breaking-review dialog** internals (backup checkbox, "Breaking" tags,
  disabled submit) — owned by `component-breaking-change-alert.spec.ts`.
- The backend `GET /api/v1/all` version-metadata contract — the notification is
  asserted at its user-facing surface, not via the API that feeds the diff.

---

## Notes

- **Force-fail probes (executed during validation):** documented in the PR
  Validation block — one mutation per test, each observed failing, then reverted.
- The fixture is renamed with a unique per-run suffix before import so the test
  waits for *its own* dropped card (avoids racing bootstrap-seeded or
  sibling-test cards), the same pattern as the sibling breaking-change spec.
