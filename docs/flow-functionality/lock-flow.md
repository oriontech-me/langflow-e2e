# Lock Flow — functional editing-prevention on the canvas

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

A **locked** flow blocks all canvas graph edits, and unlocking restores them —
the functional core of the "Lock flow (prevents editing)" behavior:

1. **Lock persists across a reload** — locking a flow and reopening it by id
   keeps the flow locked (the Flow Settings `lock-flow-switch` reads `checked`
   on reopen).
2. **Locked ⇒ edits blocked** — while locked, clicking edges and pressing
   `Backspace` does **not** delete them (edge count stays constant), and
   clicking node handles does **not** create new connections.
3. **Unlocked ⇒ edits allowed** — after unlocking, edges can be deleted one by
   one (3 → 2 → 1 → 0) and the flow can be fully re-wired back to 3 edges via
   handle clicks.

This is the behavioral counterpart to `flow-lock.spec.ts` (which covers the
settings-modal UI). Together they prove lock both *looks* locked and *is*
locked; neither alone does (see Notes).

If this test fails, either lock stopped preventing edits (a product regression
that breaks the feature's whole point) or unlock stopped restoring them.

---

## Tags *(required)*

`@stable` `@release` `@components` `@workspace`

`@stable` added only after the spec runs clean multiple times with `--retries=0`
on the fresh nightly. `@components` — node/edge canvas manipulation; `@workspace`
— flow lock/canvas management.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`.
- `OPENAI_API_KEY` present — the "Basic Prompting" template ships a Language
  Model node; the test loads (does **not** run) the template and skips when the
  key is absent so the graph renders as authored.
- The "Basic Prompting" starter template available.

---

## Step by step *(required)*

**Test — user must be able to lock a flow and it must be saved**

1. Create a uniquely-named Basic Prompting flow via the API
   (`createFlowFromStarter`) and open it with `openFlowById(page, flowId)`; id
   captured for teardown. That shared helper (#1214) waits for
   `canvas_controls_dropdown`, suppresses the assistant onboarding overlay before
   the load, and gates on the flow being **writable** (`menu_bar_display`
   enabled) — every step below mutates the flow through the settings menu.
   Reopens later in the test also go by id (not `list-card.first()`) so parallel
   workers never open each other's flow — see Notes.
2. `lockFlow(page)` — open settings, toggle `lock-flow-switch`, save.
3. Reopen the **same** flow by id (`openFlowById` again — a full reload, not a
   trip through the flows list) and assert the lock persisted with
   `expectLockState(page, "checked")`: open Flow Settings via `flow_name` and
   require `lock-flow-switch` to read `data-state="checked"`. Deliberately
   **not** the per-node `icon-lock` badge — see Notes.
4. `unlockFlow(page)` — reopen settings, toggle the switch off, save.
5. Reopen the flow. Run `tryDeleteEdge`: **re-lock**, then assert that clicking
   each edge + `Backspace` leaves the edge count at 3 across several attempts
   (locked blocks deletion), then unlock.
6. Unlocked: delete edges one by one and assert the count drops 3 → 2 → 1 → 0.
7. Run `tryConnectNodes`: **re-lock**, then assert clicking handles does not add
   edges (count stays 0), then unlock.
8. Unlocked: reconnect ChatInput → Prompt → Language Model → ChatOutput via
   handle clicks and assert the edge count returns to 3.

---

## Validation criterion *(required)*

- While locked: edge count is invariant under delete attempts, and handle clicks
  create no edges.
- While unlocked: edges delete to 0 and re-wire back to exactly 3.
- The lock state survives a reopen of the flow — `lock-flow-switch` reads
  `checked` after the reload.

---

## What this test does not cover *(optional)*

- The settings-modal UI (switch state, input disable, modal icons) — covered by
  `flow-lock.spec.ts`.
- Running the flow / model output — the template is loaded but never executed.

---

## External dependencies *(required)*

- `tests/helpers/flows/lock-flow.ts` — `lockFlow` / `unlockFlow` drive the
  settings switch (`flow_name` → `lock-flow-switch` → `save-flow-settings`);
  `expectLockState` reads that switch back without mutating it.
- `tests/helpers/flows/open-flow-by-id.ts` — the shared id-addressed entry
  (#1214). Its **writable** gate is load-bearing here and not merely defensive:
  `expectLockState` opens Flow Settings by clicking `flow_name`, upstream renders
  `menu_bar_display` as `disabled={isReadOnly}` and the popover as
  `open={openSettings && !isReadOnly}`, so a click landing while
  `POST /api/v1/authz/me/permissions` is still in flight opens nothing.
- Canvas edit surface — `.react-flow__edge`, node handles
  (`handle-…-shownode-…`), and the lock enforcement that suppresses
  delete/connect while locked.
- "Basic Prompting" starter template — the disposable subject flow.

---

## When to review this test *(optional)*

- If `lock-flow-switch` or `flow_name` moves, or if Flow Settings stops reflecting
  the persisted lock state — that is what the persistence check now reads.
- If the "Basic Prompting" template's node/handle testids change, or if the
  lock-enforcement on the canvas changes.

---

## Notes *(optional)*

- **The persistence check is the settings switch, and it took two corrections to
  get there.** It was originally the header `icon-Lock` badge (capital), which
  stopped rendering and hard-failed this test on the nightly while the lock
  feature itself worked (#684). It then became the per-node **`icon-lock`** badge
  (lowercase, 1.11) — which force-fail showed renders on **every** flow regardless
  of lock state, so it passed even when the flow was never locked (#909). Neither
  badge is asserted today: `expectLockState(page, "checked")` reads
  `lock-flow-switch` out of Flow Settings, the same control `lockFlow` wrote, so a
  lock that did not persist cannot satisfy it. Do not reintroduce an `icon-lock`
  assertion here without first proving it distinguishes locked from unlocked.
- **Complementary to `flow-lock.spec.ts`:** same lock mechanism, different
  assertions — this spec proves the *functional* editing-block; the sibling
  proves the *settings-UI* state. Kept separate so the functional proof stands
  on its own.
- **Flow cleanup:** an `afterEach` deletes the subject flow via the API
  (id-scoped, `getAuthToken` bearer). The spec previously left one "Basic
  Prompting" flow per run on the instance.
- **`OPENAI_API_KEY` skip:** the key gates the test only so the Basic Prompting
  graph renders with its Language Model node as authored; the flow is never run,
  so no tokens are spent.
- **Parallel-safety (#684):** promoting to `@stable` means running under the
  fully-parallel daily/impacted jobs. The spec creates a uniquely-named flow via
  `createFlowFromStarter` and only ever opens it by id — reopening via
  `list-card.first()` would grab whichever card tops the shared home grid, i.e.
  another worker's flow. The shared `lock-flow.ts` helper converges the switch to
  its target state with a retry (a single click drops under load) and saves only
  when a change is pending.
