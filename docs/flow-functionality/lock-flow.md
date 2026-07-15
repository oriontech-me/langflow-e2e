# Lock Flow — functional editing-prevention on the canvas

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

A **locked** flow blocks all canvas graph edits, and unlocking restores them —
the functional core of the "Lock flow (prevents editing)" behavior:

1. **Lock persists across navigation** — locking a flow, leaving to the flows
   list, and reopening it keeps the flow locked (the `icon-lock` badge is shown
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

1. Bootstrap, open Templates, select "Basic Prompting" (creates the subject
   flow; id captured for teardown). Wait for `canvas_controls_dropdown`.
2. `lockFlow(page)` — open settings, toggle `lock-flow-switch`, save.
3. Navigate to the flows list (`icon-ChevronLeft`) and reopen the flow via its
   card; assert the `icon-lock` badge is present (lock persisted).
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
- The lock state survives leaving and reopening the flow (`icon-lock` on reopen).

---

## What this test does not cover *(optional)*

- The settings-modal UI (switch state, input disable, modal icons) — covered by
  `flow-lock.spec.ts`.
- Running the flow / model output — the template is loaded but never executed.

---

## External dependencies *(required)*

- `tests/helpers/flows/lock-flow.ts` — `lockFlow` / `unlockFlow` drive the
  settings switch (`flow_name` → `lock-flow-switch` → `save-flow-settings`).
- Canvas edit surface — `.react-flow__edge`, node handles
  (`handle-…-shownode-…`), and the lock enforcement that suppresses
  delete/connect while locked.
- Canvas node chrome — renders the per-node `icon-lock` badge (1.11).
- "Basic Prompting" starter template — the disposable subject flow.

---

## When to review this test *(optional)*

- If the locked-state indicator testid changes (moved from header `icon-Lock` to
  per-node `icon-lock` on 1.11 — see Notes).
- If the "Basic Prompting" template's node/handle testids change, or if the
  lock-enforcement on the canvas changes.

---

## Notes *(optional)*

- **Locked-state indicator drift (#684):** the persistence check waits for the
  per-node **`icon-lock`** badge (lowercase, 1.11) on reopen. The prior header
  `icon-Lock` (capital) no longer renders — asserting it was the sole reason
  this test hard-failed on the nightly while the lock feature itself works
  (locked flows still refuse edge deletion, verified live).
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
