# Flow Lock — settings-modal round-trip & locked-state UI

**Last validated:** Langflow 1.13.x

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
5. **A saved lock survives a node update landing mid-save** (#2075) — the lock
   the user just saved is the one the editor shows on reopen, and a later canvas
   edit does not unlock the flow. **Declared failing** (`test.fail()`) against a
   live product regression, [LE-2785](https://datastax.jira.com/browse/LE-2785) —
   see Notes.

The **functional** proof that a locked flow blocks canvas edits (edge
delete/connect) lives in the sibling `lock-flow.spec.ts` — this spec covers the
settings-UI surface; the two are complementary, not duplicates (see Notes).

If Test 1 or Test 2 fails, the Flow Settings lock control no longer
toggles/persists, or the locked flow stops disabling its own metadata inputs. If
Test 3 reports *expected to fail, but passed*, upstream fixed the regression —
see Notes for what to do.

---

## Tags *(required)*

- Test 1 and Test 2: `@stable` `@release` `@workspace` `@ui-ux`
- Test 3: `@stable` `@regression` `@workspace` `@ui-ux`

`@stable` added only after the spec runs clean multiple times with `--retries=0`
on the fresh nightly (per `CONTRIBUTING.md`). `@workspace` — flow/canvas
management; `@ui-ux` — settings-modal interaction + locked-state indicators.
Test 1 was quarantined (`test.fixme`, `@stable` removed) by #2076 and lifted by
#2075. Test 3 carries `@stable` **with** `test.fail()` on purpose: it runs in
the daily so the day upstream fixes the regression surfaces as an unexpected
pass, and `@regression` because it pins a product regression (#2075).

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
   unlocks through the settings menu. Then wait until the load-time node updates
   (`POST /api/v1/custom_component/update`, which the starter fires on load)
   have finished and stayed quiet — tracked from before the load, because the
   shared settle helper cannot see a request already open when it attaches. A
   node update landing while the settings Save is in flight is Test 3's defect;
   Test 1 covers the round trip, not the race.
2. Assert the flow is initially unlocked — the persisted flow's `locked` flag
   (`GET /api/v1/flows/{id}`) reads `false`.
3. Open Flow Settings with `openFlowSettings(page)` — the `menu_bar_display`
   button once enabled, never the `aria-hidden` `flow_name` span (#1215); wait
   for `lock-flow-switch`.
4. Assert the switch is `unchecked` and both `input-flow-name` /
   `input-flow-description` are **enabled**.
5. Toggle the switch to `checked` and assert it **stays** `checked`; assert both
   inputs become **disabled**.
6. Save (`save-flow-settings`); wait for the modal to detach.
7. Assert the lock **persisted** — the flow's `locked` flag reads `true`.
8. Reopen Flow Settings; assert the switch is still `checked` (persisted) and
   the inputs are still disabled.
9. Unlock (switch → `unchecked`, and it stays there); assert the inputs are
   **enabled** again.
10. Save; assert the unlock **persisted** — the flow's `locked` flag reads
    `false`.

**Test 2 — settings-modal shows the correct lock/unlock icon per state**

1. Create + open an isolated Basic Prompting flow by id (as in Test 1), open
   Flow Settings.
2. Assert the modal shows `icon-Unlock` (dialog-scoped) while unlocked.
3. Toggle the lock switch; assert the modal now shows `icon-Lock` and hides
   `icon-Unlock`.

**Test 3 — a lock saved while a node update lands mid-save is kept** *(declared failing)*

1. Create an isolated Basic Prompting flow and, **before** opening it, route two
   requests of this page: every node-update response is held until the flow's
   first `PATCH /api/v1/flows/{id}` (the settings Save) has been committed by the
   backend, then delivered while that Save's own response is still held; the
   Save's response is released only after those updates landed (+1 s for the
   editor to apply them). The backend answers both immediately — only the
   browser's view is reordered.
2. Open the flow and Flow Settings, toggle the lock on (a single toggle sticks),
   and Save; wait for the dialog to detach.
3. **Anchors, asserted before `test.fail()`** so a harness that cannot force the
   overlap goes red instead of passing as the expected failure: the load issued
   ≥ 1 node update; the Save sent `locked: true`; the backend committed
   `locked: true`; ≥ 1 node update was delivered while the Save was in flight;
   `GET /api/v1/flows/{id}` reads `locked: true`; a canvas node exists to drag.
4. `test.fail()` — everything below is the correct contract, which fails today.
5. Reopen Flow Settings: the switch reads `checked` (soft assertion, so step 6
   is still evaluated).
6. Close the modal, drag a canvas node, and assert **no**
   `PATCH /api/v1/flows/{id}` carrying `locked: false` is issued within one
   autosave debounce plus slack (`saveScheduledDeadlineMs`) — the absence is
   asserted on the request, not on a state read — and that the flow still reads
   `locked: true`.

---

## Validation criterion *(required)*

Each observable below is distinctive — none of them holds on a flow whose lock
control is broken:

- **Initial state:** `GET /api/v1/flows/{id}` → `locked: false`; the switch reads
  `data-state="unchecked"`; `input-flow-name` / `input-flow-description` are
  enabled.
- **One toggle sticks:** after the user's toggle the switch reads
  `data-state="checked"` and keeps reading it — a switch that flips and is then
  reset to `unchecked` by the form (#2075's symptom) is a failure, never retried
  away; both inputs are disabled.
- **Lock persists:** after Save the dialog detaches and `GET /api/v1/flows/{id}`
  → `locked: true`; reopening Flow Settings shows the switch `checked` with the
  inputs still disabled.
- **Unlock persists:** toggling back reads `unchecked` with the inputs enabled,
  and after Save `GET /api/v1/flows/{id}` → `locked: false`.
- **Dialog icon (Test 2):** `icon-Unlock` while unlocked; `icon-Lock` visible and
  `icon-Unlock` hidden once the switch is `checked`.
- **Lock survives a mid-save node update (Test 3, declared failing):** with the
  anchors of step 3 holding, the reopened switch reads `checked` and a canvas
  edit issues no `PATCH {locked: false}` — the flow still reads `locked: true`.
  Today both fail (the switch reads `unchecked`, the edit unlocks the flow), so
  the test passes as an expected failure; on a build without the regression
  (`1.11.4`) it reports *expected to fail, but passed*.

The canvas `icon-lock` badge is deliberately **not** a criterion — its testid is
reused by unrelated input-placeholder icons on an unlocked flow (dev49 note in
*What this test validates*).

---

## What this test does not cover *(optional)*

- The functional editing-block on the canvas (deleting/connecting edges while
  locked) — covered by `lock-flow.spec.ts`.
- Lock behavior via the API rather than the settings UI.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/editFlowSettingsComponent/` (Flow Settings
  modal fields) — renders `lock-flow-switch`, `input-flow-name`,
  `input-flow-description`, and the dialog `icon-Lock` / `icon-Unlock`.
- `src/frontend/src/components/core/flowSettingsComponent/` — owns the
  `save-flow-settings` action that commits the modal.
- `src/frontend/src/hooks/flows/use-save-flow.ts` — adopts the Save's PATCH
  response into the editor only when no node changed while it was in flight
  (`graphUnchanged`, langflow#14765); the source of Test 3's defect.
- `POST /api/v1/custom_component/update` — the node updates the Basic Prompting
  starter fires on load; Test 1 waits them out, Test 3 holds them.
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

### #2075 — the switch that read `unchecked` after a persisted lock

The recurrent first-attempt red on the VM daily (2026-09-07 on `1.13.0.dev5`,
2026-09-28 on `1.13.0.dev26`) was **not** a dropped toggle. The failing assertion
polled 19 times over 15 s, which only the reopened-modal check has the budget for
(the old toggle loop asserted with 2 s); the backend had already confirmed
`locked: true` on the line before. So the lock was saved and the editor did not
know it.

**Mechanism.** [langflow#14765](https://github.com/langflow-ai/langflow/pull/14765)
(`f1a6c3151f`, 2026-08-25) fixed "an edit made during a save is lost" by making
`use-save-flow.ts` call `setCurrentFlow(updatedFlow)` only when the store's
`nodes`/`edges` arrays are the ones the save started with. Any node update landing
mid-save therefore discards the response — including the settings Save's
`locked: true`. The settings modal initialises its switch from the editor's copy of
the flow, so it reads `unchecked`; and because `saveFlow` then sees a requested
`locked: false` against a persisted lock, the next canvas edit is sent as an
**unlock** (`PATCH {locked: false}`), which the backend accepts. The Basic Prompting
starter fires two `custom_component/update` requests on load, and `openFlowById`
does not wait for them, so a slow backend makes the overlap natural.

**Measured** on `1.13.0.dev26` with the ordering forced by `page.route`: 3/3 lost
with a node update delivered mid-save, 3/3 kept without the overlap; the
pre-regression control `1.11.4` keeps the lock under the same forced race (its
stale autosave gets `423 Locked`) and Test 3 reports an unexpected pass there.
Un-forced, the pre-quarantine spec went 0/10 locally — the overlap needs a slow
backend. Slowing it for real (the container capped at 0.25 CPU, no injected
ordering) reproduces the daily's exact signature on the unmodified pre-quarantine
spec in 5 of 5 valid runs (one more voided on a cold-start request timeout),
while Test 1 as it stands — waiting the load-time updates out — passed 5 of 5
under the same cap. 16/16 single toggles stuck under 4 workers, which is why the
convergence re-click loops (#684) were removed: they could not have helped here,
and a retry that turns a reset switch green would hide exactly this class.

**Lifting Test 3.** When it reports *expected to fail, but passed*, verify the fix
in the image the daily pulls (not only on a ref), delete `test.fail()` and its
comment, flip the QA-CHECKLIST §12.5 bullet to `[x]`, update the
[LE-2785](https://datastax.jira.com/browse/LE-2785) row in `REGRESSIONS.md` to
`Fixed`, and close #2075. The sibling
`lock-flow.spec.ts` flaked on the same 2026-09-28 run with 2 edges instead of 3 —
consistent with the same cause (an editor that believes the flow is unlocked lets
an edge be deleted), but not measured here.
