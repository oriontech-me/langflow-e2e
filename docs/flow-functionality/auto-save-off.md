# Manual Save With Auto-Save Disabled — §12.2 View and Edit Flow

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates the flow persistence contract when **auto-saving is turned off**
(`/api/v1/config` → `auto_saving: false`): unsaved graph edits are **discarded**
on exit unless the user explicitly saves, and an explicit **save persists** the
edits across an exit / re-open cycle.

With auto-save off, the editor must:

1. **Discard on "Exit Anyway"** — after adding a component without saving,
   leaving the flow via the back button raises an unsaved-changes dialog;
   choosing **Exit Anyway** discards the edit (the re-opened flow has zero
   nodes).
2. **Persist on save** — adding a component and then saving (via the on-canvas
   **Save** button or the exit dialog's **Save And Exit**) persists it; the
   re-opened flow shows the saved component.
3. **Persist a subsequent edit** — adding a second core component (Chat Output)
   and saving again persists both; the re-opened flow shows **two** nodes
   (Chat Input + Chat Output).

If this breaks, the auto-save-off workflow is unsafe — either edits are lost
when the user meant to save, or discarded edits silently persist.

---

## Tags *(required)*

`@stable` `@release` `@api` `@database` `@components`

`@api` — mocks `/api/v1/config`. `@database` — asserts server-side persistence
across a full exit/re-open. `@components` — drives a canvas component.

---

## Step by step *(required)*

Setup: mock `/api/v1/config` to `auto_saving: false`, bootstrap the app
(`awaitBootstrapTest`), open a blank flow. Every flow this page creates is
captured from its `POST /api/v1/flows → 201` response and deleted id-scoped in
`afterEach`. The **id of the flow under test** is read from the URL right after
the blank-flow navigation (never before it — the bootstrap parks the page on a
placeholder flow Langflow then deletes) and cross-checked against the ids this
page created; every re-open below is pinned to that id.

Every exit asserts the editor was actually left (the URL leaves `/flow/…`)
before anything else runs.

1. Add a **Chat Input** component to the canvas (sidebar search → hover entry →
   `add-component-button-chat-input`)
2. Assert the on-canvas **`save-flow-button`** is enabled (auto-save off ⇒ manual
   save is available)
3. Leave via the back button (`icon-ChevronLeft`); the unsaved-changes dialog
   ("Unsaved changes will be permanently lost.") appears — click **Exit Anyway**;
   assert the editor was left
4. Re-open the flow **by id** via `openFlowById` (`/flow/<id>`; the helper gates
   on the canvas mounting and on the flow being writable, and the spec
   additionally waits for the flow's own `GET /api/v1/flows/<id>` so the count
   below cannot read a canvas whose graph has not been applied); assert the
   canvas has **0** nodes (`div-generic-node` count = 0) — the edit was discarded
5. Add the Chat Input component again (hover the sidebar entry →
   `add-component-button-chat-input`)
6. Leave via the back button; click **Save And Exit**; assert the editor was left
7. Re-open the flow; assert **`title-Chat Input`** is visible — the edit persisted
8. Add a **Chat Output** component (hover the sidebar entry →
   `add-component-button-chat-output`), click **`save-flow-button`** (the
   on-canvas manual save) and **wait for that save to complete** — its
   `PATCH /api/v1/flows/<id>` must answer **200**. Only then leave via the back
   button. With the save confirmed the flow is no longer dirty, so the exit is
   clean: the unsaved-changes dialog must **not** appear, and the editor must be
   left. Nothing here is conditional (see the #1489 note)
9. Re-open the flow; assert both `title-Chat Input` and `title-Chat Output` are
   visible and `div-generic-node` count = **2**

---

## Validation criterion *(required)*

- After **Exit Anyway** on an unsaved change: the re-opened flow's
  `div-generic-node` count is **0** (discard worked).
- After a **save**: the re-opened flow shows `title-Chat Input`.
- The **on-canvas manual save** answers for itself: the `save-flow-button` click
  produces a `PATCH /api/v1/flows/<id>` → **200**, and the exit that follows it
  raises **no** unsaved-changes dialog.
- After the second save: both `title-Chat Input` and `title-Chat Output` are
  visible and `div-generic-node` count is exactly **2** (both edits persisted
  server-side).

Each observable is a hard count/visibility on the re-opened flow — a mutated
assertion (wrong count, wrong discard) fails deterministically. No step is
conditional: the third exit waits on the manual save's own response before
leaving, so the dialog either does not appear or the test fails (#1489). That
also makes the manual save falsifiable on its own — under the previous design a
broken `save-flow-button` still passed, because the optional **Save And Exit**
fallback persisted the same graph and the final `div-generic-node` count === 2
could not tell the two paths apart.

---

## External dependencies *(required)*

- `/api/v1/config` — mocked to `auto_saving: false` (the surface under test).
- `data-testid="save-flow-button"` — on-canvas manual save (present only when
  auto-save is off).
- `data-testid="icon-ChevronLeft"` — back-to-list navigation.
- Exit dialog: **"Exit Anyway"** (discard) / **"Save And Exit"** (persist; its
  primary button carries `data-testid="replace-button"`). Only the first two
  exits reach it — the third confirms its save first and must exit without it.
- `PATCH /api/v1/flows/{id}` — the save request behind both the on-canvas
  **Save** button and the dialog's **Save And Exit**.
- `data-testid="input_outputChat Input"` / `add-component-button-chat-input` /
  `input_outputChat Output` / `add-component-button-chat-output` /
  `sidebar-search-input` — Chat Input / Chat Output sidebar entries, add buttons,
  search. Adds use the draggable wrapper hover → add button (the sidebar row is
  briefly `pointer-events-none`; dragging it is unreliable).
- `data-testid="title-Chat Input"` / `div-generic-node` — node presence on canvas.
- `GET /api/v1/flows/{id}` and the `/flow/{id}` route — the re-open path, entered
  through `helpers/flows/open-flow-by-id.ts` (see the #1336 note below for why
  this is not the flows-list card).
- `helpers/ui/assistant-onboarding.ts` — the onboarding flag is seeded before the
  first navigation, so the tooltip upstream arms at canvas mount + 10 s cannot
  land over the canvas-controls bar this spec clicks four times.
- No API key — the Chat Input / Chat Output components are added to the graph,
  never executed.

---

## What this test does not cover *(optional)*

- Auto-save **on** (the default) — a separate behavior.
- Renaming / deleting flows.
- Save via keyboard shortcut (Ctrl/Cmd+S).

---

## Notes *(optional)*

- **#1336 (the re-open opened the WRONG flow).** Recurrent flake on the
  2026-07-22 and 2026-08-06 dailies: `locator.click: Timeout 45000ms exceeded`
  re-opening the just-created flow's card. Not a product regression, and not a
  tight wait either — the spec was **driving another worker's flow**. It clicked
  the first `list-card` whose name contained "New Flow", and Langflow names every
  blank flow "New Flow"/"New Flow (N)", so under `fullyParallel` the list holds
  one per worker. Proved on nightly 1.12.0.dev18 by logging the page's own
  network: the page created ids `8e767306` and `ee8e0ab9`, and the re-open landed
  on `164b3c19` — an id it never created. When that flow's real owner ran its
  id-scoped cleanup, the save `PATCH /api/v1/flows/{id}` came back **404**, so the
  editor never navigated back to the list and the next re-open burned its 45 s on
  a card that had no reason to exist. That is also the CI artifact's state: the
  failure screenshot is the *canvas*, not the list, with the flow saved and the
  same two 404s in the advisory log. Reproduced **3/8 at `--workers=4`**;
  **8/8 green** after the fix under the identical burst.
  Two further findings shaped the fix. The card cannot be selected by id either:
  the list is **paginated at 12 and ordered by `updated_at DESC`**, and under load
  this test's own card is routinely off page 1 (measured: 12 of 12 slots taken by
  fresher flows) — so the old spec's "success" depended on *some* other worker's
  "New Flow" being on top, which also made the discard assertion (`count === 0`)
  vacuous whenever it opened a stranger's fresh blank flow. And the id must be
  read **after** the blank-flow navigation: `awaitBootstrapTest` reaches the
  templates modal through "New Flow", which parks the page on a placeholder flow
  that Langflow deletes as soon as the modal navigates elsewhere (#490/#681
  again, from the other side). The re-open is therefore by URL, and each exit now
  asserts the editor was left — verified by forcing the save PATCH to 500, which
  now fails at the exit step instead of 45 s later on an unrelated locator.
- **#1489 (the third exit hung on a dialog the spec never waited for).**
  Recurrent on the 2026-08-18 and 2026-08-19 dailies:
  `page.waitForURL: Timeout 30000ms exceeded` inside `expectLeftEditor`, reached
  from the **third** exit — not from the initial navigation the issue title
  describes. Not a product regression, and not the mid-run backend wedge the
  triage recorded either: the 2026-08-19 occurrence ran on shard 4, measured at
  0 outages, and the 2026-08-18 one comes from a daily the mass-failure guard
  never tripped. The daily's own `error-context` names the cause — at the moment
  of the timeout the unsaved-changes dialog was **open and untouched**, so the
  editor could not leave `/flow/…` because a modal was blocking it. The guard
  meant to dismiss it read
  `if (await saveAndExit.isVisible({ timeout: 5000 }))`, and Playwright
  **ignores that timeout**: `locator.isVisible()` "does not wait for the element
  to become visible and returns immediately" (`types.d.ts`, 1.58.2). The probe
  therefore fired ~1 ms after the back-click and committed to the "no dialog"
  branch before the modal had painted — the same class already recorded in
  `mcp/server/mcp-server.spec.ts` (#1422). The fix removes the conditional
  rather than widening it: the spec now waits for the manual save's own
  `PATCH /api/v1/flows/{id}` → 200 before leaving, which makes the exit
  deterministic **and** closes the coverage hole described under Validation
  criterion.
  One further observation from the same artifact is a **product** finding and is
  filed separately as **LE-2255**: the dialog reported "Last saved: **Never**"
  for a flow whose graph was already persisted — the same attempt had just
  asserted `title-Chat Input` after a full reload. It is not what this spec
  asserts and does not block it.
- **#1342 (the re-open uses the repo's by-id entry, not a local `goto`).** #1336's
  fix hand-rolled `page.goto('/flow/{id}')` + a canvas wait, which was the fourth
  copy of the block `helpers/flows/open-flow-by-id.ts` (#1214) was extracted to
  stop. Migrated to `openFlowById`, which adds two guarantees the copy did not
  have: the onboarding overlay cannot appear, and the editor is not handed back
  while `POST /api/v1/authz/me/permissions` is still in flight — the #1005 window
  in which a mutation is silently swallowed, and this spec adds a component
  immediately after two of the three re-opens. **One thing did not come from the
  helper and must stay**: the wait on the flow's own `GET /api/v1/flows/{id}`.
  `openFlowById` returns on `canvas_controls_dropdown` + writability, neither of
  which implies the graph has been applied — and the discard assertion
  (`div-generic-node` count = 0) is the one check that PASSES VACUOUSLY on a
  canvas that has not painted its nodes yet. The seed is called at the top of the
  test rather than left to the helper, because upstream arms the tooltip at canvas
  mount + 10 s over the bar `adjustScreenView` clicks, and the first editing phase
  (two of those calls, plus the on-canvas save) happens before any re-open.
- **#790 (load-collateral, critical clicks hardened).** On load-degraded /
  guard-tripped dailies (2026-07-15/16) the spec failed with
  `locator.click: Timeout 20000ms exceeded` on a manual-save click target. Not a
  product regression — the spec passes 5/5 clean at `--retries=0` on the current
  nightly (`1.11.0.dev45`) and manual save resolves correctly with
  `auto_saving=false`. This is the suite's heaviest workspace test (two full
  bootstraps + repeated exit/re-open cycles, ~54s cold), so under CI saturation a
  20s default action timeout (`playwright.config.ts` `actionTimeout`) is the first
  thing to blow. Hardened by giving the load-sensitive clicks (the on-canvas
  `save-flow-button` and the card `list-card-open-button` re-open) an explicit
  longer timeout, so transient saturation no longer trips the default. `@stable`
  kept.
- **Hardening for promotion.** The pre-promotion spec left `New Flow` behind
  (no cleanup — confirmed 4 leaked flows on the instance) and used silent
  bypasses: a `try/catch` that logged "skipping dialog confirmation" and
  `if (replaceButton) {…}` / `if (saveExitButton) {…}` guards that could skip a
  save/exit step without failing. Live scouting on 1.11.0.dev41 confirmed all
  the first two exits are deterministic (the unsaved-changes dialog always
  appears; the save button is `replace-button` with text "Save And Exit"), so
  those guards became explicit asserts + clicks. The **third** exit is genuinely
  timing-optional — the on-canvas `save-flow-button` sometimes settles the save
  before the back-navigation, yielding a clean exit with no dialog — so it keeps
  a single conditional for the optional dialog, gated by the final
  `div-generic-node` count === 2 (the force-fail gate that proves persistence
  regardless of path).
- **Flow cleanup.** ids are captured from `POST /api/v1/flows → 201`
  (Pattern-A accumulator; `page.url()` races the bootstrap flow id — #490/#681)
  and deleted in `afterEach`.
- **Core I/O components (Chat Input + Chat Output)** — they render on the canvas
  without an API key and without a run, keeping the test hermetic; neutral core
  components avoid the model-provider connotation of the pre-promotion NVIDIA
  node they replaced. The second edit uses Chat Output rather than a second Chat
  Input because Langflow hides a component's quick-add button once a copy is on
  the canvas.
