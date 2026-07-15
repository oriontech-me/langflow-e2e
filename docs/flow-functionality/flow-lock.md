# Flow Lock — settings-modal round-trip & locked-state UI

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

The **Flow Settings** lock control (`lock-flow-switch`) round-trips a flow
between unlocked and locked, and the UI reflects each state:

1. **Round-trip via the settings modal** — opening Flow Settings, toggling the
   lock switch, saving, reopening, and unlocking, with the locked state
   **persisted** across the reopen.
2. **Field disable while locked** — the flow's name/description inputs
   (`input-flow-name`, `input-flow-description`) are enabled when unlocked and
   **disabled** when locked, so a locked flow cannot be renamed/re-described.
3. **Locked-state indicator** — once the lock is saved, the canvas shows the
   locked indicator (`icon-lock`, per-node badge on 1.11) and it disappears
   after unlocking.
4. **Settings-modal icon state** — the modal itself shows `icon-Unlock` when
   unlocked and `icon-Lock` when locked (dialog-scoped icons, distinct from the
   per-node canvas badge).

The **functional** proof that a locked flow blocks canvas edits (edge
delete/connect) lives in the sibling `lock-flow.spec.ts` — this spec covers the
settings-UI surface; the two are complementary, not duplicates (see Notes).

If this test fails, the Flow Settings lock control no longer toggles/persists,
or the locked flow stops disabling its own metadata inputs.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@ui-ux`

`@stable` added only after the spec runs clean multiple times with `--retries=0`
on the fresh nightly (per `CONTRIBUTING.md`). `@workspace` — flow/canvas
management; `@ui-ux` — settings-modal interaction + locked-state indicators.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- The "Basic Prompting" starter template available (the spec loads it as a
  disposable subject flow).

---

## Step by step *(required)*

**Test 1 — lock and unlock a flow and verify UI changes**

1. Bootstrap, open Templates, select "Basic Prompting" (creates the subject
   flow; its id is captured for id-scoped teardown).
2. Assert the flow is initially unlocked — no `icon-lock` badge on the canvas.
3. Open Flow Settings (`flow_name`); wait for `lock-flow-switch`.
4. Assert the switch is `unchecked` and both `input-flow-name` /
   `input-flow-description` are **enabled**.
5. Toggle the switch to `checked`; assert both inputs become **disabled**.
6. Save (`save-flow-settings`); wait for the modal to detach.
7. Assert the canvas shows the locked indicator `icon-lock` (per-node badge).
8. Reopen Flow Settings; assert the switch is still `checked` (persisted) and
   the inputs are still disabled.
9. Unlock (switch → `unchecked`); assert the inputs are **enabled** again.
10. Save; assert `icon-lock` is gone from the canvas.

**Test 2 — settings-modal shows the correct lock/unlock icon per state**

1. Bootstrap, load "Basic Prompting", open Flow Settings.
2. Assert the modal shows `icon-Unlock` (dialog-scoped) while unlocked.
3. Toggle the lock switch; assert the modal now shows `icon-Lock` and hides
   `icon-Unlock`.

---

## Validation criterion *(required)*

- Toggling `lock-flow-switch` flips the persisted lock state (checked survives a
  modal reopen).
- Locked ⇒ `input-flow-name` / `input-flow-description` disabled **and** the
  canvas shows `icon-lock`; unlocked ⇒ inputs enabled **and** `icon-lock` gone.
- The settings modal shows `icon-Unlock` / `icon-Lock` matching the switch state.

---

## What this test does not cover *(optional)*

- The functional editing-block on the canvas (deleting/connecting edges while
  locked) — covered by `lock-flow.spec.ts`.
- Lock behavior via the API rather than the settings UI.

---

## External dependencies *(required)*

- `src/frontend/src/…/flowSettings` (Flow Settings modal) — renders
  `lock-flow-switch`, `input-flow-name`, `input-flow-description`,
  `save-flow-settings`, and the dialog `icon-Lock` / `icon-Unlock`.
- Canvas node chrome — renders the per-node `icon-lock` badge shown while the
  flow is locked (the 1.11 replacement for the old header lock icon).
- "Basic Prompting" starter template — the disposable subject flow.

---

## When to review this test *(optional)*

- If the Flow Settings lock switch, its save button, or the metadata-input
  testids change.
- If the locked-state indicator testid changes again (it moved from a header
  `icon-Lock` to per-node `icon-lock` on 1.11 — see Notes).

---

## Notes *(optional)*

- **Locked-state indicator drift (#684):** on 1.11 the locked-flow indicator is
  a per-node badge with testid **`icon-lock`** (lowercase). The prior header
  `icon-Lock` (capital) no longer renders; asserting it was the sole reason the
  round-trip test hard-failed on the nightly while the lock feature itself works.
  The **dialog** lock/unlock icons kept their capitalized testids
  (`icon-Lock` / `icon-Unlock`) — Test 2 scopes to `[role="dialog"]` and is
  unaffected.
- **Complementary to `lock-flow.spec.ts`, not duplicate:** both use the same
  settings-switch lock mechanism, but this spec asserts the **settings-UI**
  consequences (input disable, modal icon, persistence) while `lock-flow.spec.ts`
  asserts the **functional** consequence (a locked flow refuses edge
  delete/connect). Keeping both preserves the isolated functional proof.
- **Flow cleanup:** an `afterEach` deletes the subject flow via the API
  (id-scoped, `getAuthToken` bearer). The spec previously left one "Basic
  Prompting" flow per run on the instance.
