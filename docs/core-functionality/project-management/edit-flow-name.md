# Project Management – Edit Flow Name

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that renaming a flow from inside the flow editor is persisted and
reflected in the home page listing. The test renames the same flow twice (two
random names in sequence) via the `renameFlow` helper, and after each rename
navigates back to the home listing and confirms the new name appears there
exactly once before re-opening the flow for the next iteration.

Renaming, returning to home, and seeing the updated name proves the rename is
committed to the backend and surfaced by the flow-list refetch — not just held
in editor-local state.

---

## Tags *(required)*

`@release` `@workspace` `@regression` `@stable`

---

## Step by step *(required)*

0. Track the flow this test creates by id and delete it in `afterEach`
   (id-scoped cleanup, #553). The id comes back from `createFlowFromStarter`,
   which creates over `page.request` and therefore emits no page-level response
   event a `POST /api/v1/flows` → 201 listener could observe (#1147).
1. `createFlowFromStarter(page.request, "Basic Prompting", <unique name>)` —
   copy the **Basic Prompting** starter graph into a uniquely-named flow of this
   worker's own, over the REST API. Not a click on the shared template card: see
   *The template-entry race* below.
2. `openFlowById(page, flowId)` — the shared entry helper (#1214):
   `page.goto('/flow/{id}')`, wait for `canvas_controls_dropdown`, then gate on
   `menu_bar_display` being **enabled** (write permission resolved). It also
   suppresses the assistant onboarding tooltip before the load by seeding
   `langflow-assistant-discovered` in localStorage — see *The onboarding tooltip
   is armed on a 10 s timer* below.
3. For each of two random target names:
   1. `renameFlow(page, { flowName: targetName })` — rename via the flow header
      settings modal; then `renameFlow(page)` (read-only) asserts the committed
      header name equals `targetName`.
   2. `leaveFlowEditor(page, { escapeDeadlock: true })` — return to the home
      listing through the helper, which drains in-flight saves, clicks
      `icon-ChevronLeft`, and asserts `home-dropdown-menu`. Never a bare chevron
      click: see *The editor-exit deadlock* below.
   3. Assert exactly one `list-card` carries a `flow-name-div` reading
      `targetName` — auto-waits for the flow-list refetch + render (web-first,
      30 s). This replaced a fixed 3 s `waitForSelector` that raced the refetch
      under parallel load (recurring flaky, issue #410). Scoped to a card, not
      `getByText` over the page: see *The listing assertion must be scoped to a
      card* below.
   4. Re-open the SAME flow with `openFlowById(page, flowId)`, so the next
      iteration starts inside the editor. Addressed by id, never by a
      name-filtered `list-card-open-button` click: on the shared home grid the
      cards other parallel workers leave behind overlap the target's
      absolute-inset open button and intercept a hit-tested click
      (#580/#588/#1005).

---

## Validation criterion *(required)*

- After each rename, the flow header reflects the new name.
- Returning to the home listing shows the renamed flow exactly once — asserted on
  the listing **card**, so the editor header cannot satisfy it — proving the
  rename persisted through the flow-list refetch.

---

## External dependencies *(required)*

- **Basic Prompting** starter template must be available on the fresh instance —
  read through `GET /api/v1/flows/` (the starter row, `user_id === null`) rather
  than clicked in the templates modal.
- Testids: `canvas_controls_dropdown`, `list-card` + `flow-name-div` (read only —
  the listing assertion), the exit controls used by `leaveFlowEditor`
  (`icon-ChevronLeft`, `home-dropdown-menu`), and the flow-header rename controls
  used by `renameFlow` (`menu_bar_display`, `flow_name`, flow-settings name
  input, `save-flow-settings`).
- localStorage key `langflow-assistant-discovered`, seeded before the first load.
- No LLM or provider API key required — the flow is never executed.

---

## Notes on stability *(optional)*

The home-listing waits use web-first assertions (`toBeVisible` / `toHaveCount`
with a 30 s timeout) instead of low-level fixed-timeout `waitForSelector` calls.
The prior 3 s `waitForSelector` on dynamic text failed-then-passed-on-retry in
multiple nightly runs because the return-to-home flow-list API refetch + render
exceeds 3 s under parallel load (issue #410). The web-first assertions auto-retry
until the renamed flow appears, so a genuine failure (flow never listed) still
fails the test.

### The upstream rename-clobber race (issue #995)

This test lost `@stable` on 2026-07-13 as a recurrent flake whose cause #727
never classified. Root-caused on 1.12.0.dev7: `PATCH /api/v1/flows/{id}` has no
version check and `use-save-flow.ts` applies whichever response lands last
(`setCurrentFlow(updatedFlow)` in the mutation's `onSuccess`). The editor's
debounced mount autosave carries the **pre-rename** name, so when it overlaps
the flow-settings save and lands after it, the rename is reverted in the store
**and in the database** — `GET /api/v1/flows/` returns the old name. The header
then never reaches the new name.

This is product behaviour, not test timing; the test is only fast enough to hit
the window. Reproduced naturally in 2 of 6 runs at `--workers=4` under load, and
deterministically by holding the mount autosave so it lands last.

`renameFlow` mitigates it in three layers: `waitForFlowSaveSettled` now waits on
in-flight PATCH **requests** (not just response silence); the barrier is closed a
second time immediately before the save click; and the one variant no barrier can
prevent — an autosave *issued after* our PATCH, from a store that has not yet
received our response — is absorbed by re-applying the rename once, with a
`console.warn`. The closing assertion is unconditional, so a rename that never
persists still fails.

### The template-entry race (issue #1005)

The residual ~7% this test carried after #995 was never one flake. Measured on a
clean `1.12.0.dev10` instance, 36 runs at `--workers=4`, it surfaced as **four**
distinct signatures — and three of them shared one cause that lives in the
test's ENTRY, not in `renameFlow`:

| Signature | Where it landed |
|---|---|
| `flow_name.hover()` → `<html> intercepts pointer events` | `rename-flow.ts` |
| `flow_name` not found | `rename-flow.ts` |
| `save-flow-settings` stays disabled, then the dialog unmounts | `rename-flow.ts` |
| `home-dropdown-menu` not found after `icon-ChevronLeft` | this spec |

The old entry was `awaitBootstrapTest` → templates modal → click the shared
**Basic Prompting** card, with **nothing waiting for the navigation that click
starts**. "New Flow" eagerly creates a blank *placeholder* flow and opens the
welcome overlay on it; picking a template then creates a SECOND flow and
navigates to that one. `renameFlow` opens with `waitForFlowSaveSettled` (700 ms
of PATCH silence) and an assertion that `flow_name` is visible — both of which
are already satisfied *by the placeholder's header*. So the helper would start
driving the wrong flow, mid-navigation, with the welcome overlay still painted
over the canvas. The hover call log proves it: the resolved span reads
`New Flow`, `<html>` intercepts the pointer, and the element then detaches.

Addressing the flow by id removes the whole class: `createFlowFromStarter` copies
the starter graph into a uniquely-named flow over the API (no placeholder, no
overlay, no collision with the parallel workers clicking the same shared card —
the reason that helper exists, #684), and `page.goto('/flow/{id}')` lands on it
with a full document load, so there is no SPA hop left to race. The flow still
carries the real Basic Prompting graph, so the #995 autosave exposure above is
preserved.

### The editor-exit deadlock (issue #1153)

The fourth signature is **not a test defect** and is not addressed by the entry
change above: clicking `icon-ChevronLeft` can leave the editor stuck behind
`SaveChangesModal` — "Flow has unsaved changes" / "Saving your changes…" — which
in autosave mode renders as a button-less spinner (`loading` hardcoded `true`, no
confirm/cancel text) and deadlocks.

`FlowPage.handleSave` calls `saveFlow()` with **no `.catch()`**, so a save that
fails or never settles leaves `proceed` false, the 1200 ms `setTimeout` finds it
false and does nothing, and the dialog has no dismissal path left. Reproduced
deterministically on 1.12.0.dev10 by aborting every flow-save PATCH: the modal
appears, never clears in 30 s, the URL stays on `/flow/{id}`, and the dialog
renders **zero** buttons — so the user is stranded too, not just the test. Under
natural load it fired **2 in 24 runs at `--workers=4`** during this
investigation, where it read as an unattributed `home-dropdown-menu` timeout.

The toast visible in the natural failure screenshot is `success.changesSaved`
("Changes saved successfully"), fired by the **rename** modal — not
`flow.savedSuccessfully` ("Flow saved successfully!"), the one `handleSave`
fires next to `blocker.proceed()`.

The product defect is tracked and reported upstream in **#1153**; this spec
survives it, attributed, through `leaveFlowEditor` — the shared helper #1156
added for the same class. `escapeDeadlock: true` is safe **here specifically**:
the rename's persistence is asserted *after* the exit, against the server (the
home listing is a `GET /api/v1/flows/` refetch), and the next iteration re-enters
by id, so the full page load the escape performs discards nothing this test
relies on. A rename that never landed still fails on the `toHaveCount(1)`
assertion — the escape cannot mask it — and every deadlock it absorbs is warned
loudly, so the suite keeps its only signal on how often #1153 fires.

### The onboarding tooltip is armed on a 10 s timer

`assistant-onboarding-tooltip` renders in a Portal over the editor and its
overlay intercepts clicks on the canvas **and on the Flow Settings modal** — the
one this spec drives on every iteration (#684). Upstream gates it on a
localStorage flag (`langflow-assistant-discovered`, written when the user opens
the assistant or clicks the tooltip's X), which is **empty in every fresh
Playwright context**, so every test is exposed on every entry.

This is owned by `openFlowById` (#1214) since three specs needed it, and
dismissing it on entry does not work, for a reason worth recording:
upstream arms the tooltip on an **idle timer of 10 s** after mount
(`ONBOARDING_TOOLTIP_DELAY_MS` in `CanvasControls.tsx`). A probe right after the
canvas renders looks ~8 s too early, sees nothing, and the tooltip then pops
*mid-rename*, with the settings dialog already open. So the flag is seeded
instead, before the first document load, which removes the affordance entirely.

Measured on 1.12.0.dev10, one run each:

| Seed | `assistant-onboarding-tooltip` within 20 s |
|---|---|
| present | never appears |
| neutralised (key renamed) | **appears** |

### The listing assertion must be scoped to a card

`getByText(targetName)` over the whole page is satisfied by the **flow header**,
which renders the same name — so the unscoped count passed from inside the editor
and never proved this test's title. Measured: with the exit commented out, the
unscoped assertion still passed; the only thing forcing the navigation was the
home marker inside `leaveFlowEditor`. The assertion is therefore scoped to a
`list-card` carrying a matching `flow-name-div`, which fails (`Received: 0`) when
the exit is removed.
