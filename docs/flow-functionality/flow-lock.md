# Flow Lock — settings-modal round-trip & locked-state UI

**Last validated:** Langflow 1.12.x

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
3. **Authoritative lock state** — the persisted flow's `locked` flag
   (`GET /api/v1/flows/{id}`) is `false` initially, `true` after locking, and
   `false` again after unlocking. dev49 note: the canvas `icon-lock` testid is
   NO LONGER a reliable indicator — it is now also used by unrelated
   input-placeholder icons (present, count ≥ 2, on an UNLOCKED flow), so the
   spec asserts lock state via the `locked` flag and the settings switch, not a
   canvas badge.
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

1. Create a uniquely-named Basic Prompting flow via the API
   (`createFlowFromStarter`) and open it with `openFlowById(page, flowId)`; its id
   is kept for id-scoped teardown. This id-addressed open (rather than clicking
   the shared "Basic Prompting" template card) is what keeps the spec
   parallel-safe — see Notes. The shared helper (#1214) also suppresses the
   assistant onboarding overlay before the load and gates on the flow being
   **writable** (`menu_bar_display` enabled), which this spec needs: it locks and
   unlocks through the settings menu.
2. Assert the flow is initially unlocked — no `icon-lock` badge on the canvas.
3. Open Flow Settings with `openFlowSettings(page)` — the `menu_bar_display`
   button once enabled, never the `aria-hidden` `flow_name` span (#1215); wait
   for `lock-flow-switch`.
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

1. Create + open an isolated Basic Prompting flow by id (as in Test 1), open
   Flow Settings.
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
- **Parallel-safety (#684):** `@stable` specs run fully parallel (the daily
  suite and the PR "impacted" job pass no `--workers=1`). Two changes make this
  spec safe under that: (a) each test creates a uniquely-named flow via
  `createFlowFromStarter` and opens it by id, so concurrent workers never share
  a "Basic Prompting" flow's lock state (a `--workers=1`-only validation missed
  this — a shared-template click let one worker see another's locked flow); (b)
  the lock switch is converged to its target `data-state` with a retry loop and
  Save is clicked only once enabled, because a single toggle/click is dropped
  while the modal is still binding under load. The lock-persisted assertions read
  the authoritative `GET /api/v1/flows/{id}` `locked` flag before trusting the
  reopened modal.

### Opening the header must drive the button, not the span (#1215)

`flow_name` is an **`aria-hidden` `<span>` inside** the `menu_bar_display` button,
which upstream renders as `disabled={isReadOnly}` with

```ts
useIsFlowReadOnly = Boolean(flowId) && (isLoading || !can(flowId, "write"))
```

i.e. it fails **closed** for the whole time `POST /api/v1/authz/me/permissions` is
in flight — deliberately, per its own docstring. A `<span>` is not a form control,
so Playwright's actionability check never covers that disabled state: a click
landed in the window is swallowed by the browser with **no error at all**, and the
failure surfaces later and elsewhere (a control inside the dialog that never
appears). Two of the four signatures #1005 classified were exactly that.

This spec therefore opens the popover through `openFlowSettings(page)`, which
asserts the header is present, waits for the **button** to report enabled, and
then clicks it. The `disabled` attribute arrived upstream on 2026-07-15
(`887f2a552d`, langflow-ai/langflow#14068), so it is live on the nightly the daily
runs.
