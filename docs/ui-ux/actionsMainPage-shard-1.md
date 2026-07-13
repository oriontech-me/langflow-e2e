# Main page actions (shard 1) — delete individual flow, search flows, search components

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Three main-page (home) actions. The promotion target of #682 is **Test 1 —
"select and delete a flow"** (QA-CHECKLIST §12.3 "Delete individual flow"):
deleting a single flow through its card's dropdown menu removes it
everywhere — the confirmation modal gates the action, the card disappears
from the home grid, and the flow is gone from the backend.

1. **select and delete a flow** *(promoted by #682)* — create a flow from
   the Basic Prompting template, return to home, open THAT flow's card
   dropdown (id-scoped — never `.first()`, which under parallel workers can
   target another worker's card), delete it through the confirmation modal,
   and prove removal three ways: success toast, card gone from the grid,
   `GET /api/v1/flows/{id}` → 404.
2. **search flows** *(hardened by #706)* — the home search filters the flow
   grid by name: with two template flows created (Basic Prompting + Memory
   Chatbot, both tracked by POST-201 id), searching "Memory Chatbot" leaves
   the memory flow's card (`flow-name-{id}`) visible and removes the basic
   flow's card (count 0); clearing the search restores both. Id-anchored
   asserts — the pre-#706 version discarded its `isVisible()`/`isHidden()`
   booleans and could not fail.
3. **search components** *(redesigned by #706 — old premise DEAD)* — the
   home `components-btn` tab the old test guarded on no longer exists on
   1.11 (proven vacuous during #682's force-fail pass: the guard was false
   and the body never executed). Saved components now live in the CANVAS
   sidebar under the **`disclosure-saved`** category (scouted live on
   1.11.0.dev41). The redesigned test saves the Chat Input node as a
   component (node → `more-options-modal` → `icon-SaveAll`), then proves
   the sidebar search exposes it. **Assert order is part of the contract**
   (both searches are debounced — a positive assert evaluated first
   resolves on the pre-filter DOM and can pass vacuously, an FF finding of
   #706): first the causal negative — searching "Prompt", a component that
   exists but was NOT saved, must remove `disclosure-saved` once the filter
   settles — then searching "Chat Input" must bring `disclosure-saved`
   back, a 0→1 transition that necessarily observes the post-filter
   sidebar. The same negative-first ordering applies to Test 2's grid
   asserts.

## What broke the old contracts *(hardening rationale)*

The pre-#682 Test 1 could never fail: both its "assertions" were bare
`locator.isVisible()` calls whose boolean result was discarded (a fully
broken delete flow still produced a green run), the dropdown was targeted
with `.first()` (parallel-unsafe), and nothing verified the flow actually
disappeared. Hardening these is the required force-failability work of a
validate-&-promote issue (see #505 precedent).

Tests 2–3 (hardened by the #706 follow-up) had the same disease: dead
boolean asserts in Test 2, and Test 3's whole body inside an
`if (components-btn visible)` guard whose home-tab surface left the
product — green in seconds while executing nothing. The saved-components
feature itself survives (node menu → Save As Component; canvas sidebar
`disclosure-saved`), so Test 3 was redesigned against the live surface
rather than re-scoped away.

---

## Tags *(required)*

- Test 1: `@stable` `@release` `@workspace` `@mainpage` (promoted by #682;
  `@workspace` added — flow lifecycle management is the subject)
- Test 2: `@release` `@mainpage` `@workspace` (hardened by #706; promotion
  is a separate decision after soak)
- Test 3: `@release` `@components` `@ui-ux` (redesigned by #706 — the
  observable moved to the canvas sidebar, so `@mainpage` no longer applies;
  promotion after soak)

---

## Step by step *(required — Test 1, the #682 target)*

1. Track every `POST /api/v1/flows` → 201 id via a `page.on("response")`
   listener (cleanup + the id handle for scoping; the canvas URL id is
   transient on 1.11).
2. Bootstrap to the templates modal and instantiate **Basic Prompting**;
   wait for the canvas, then navigate back to home (`icon-ChevronLeft`).
3. Locate the created flow's card: `list-card` containing
   `flow-name-{flowId}` (scouted live on 1.11.0.dev38); open its
   `home-dropdown-menu`.
4. Click `btn_delete_dropdown_menu`; assert the confirmation modal renders
   its warning (*"This will permanently delete the flow and its message
   history."* / *"This can't be undone."*).
5. Confirm via `btn_delete_delete_confirmation_modal`.
6. **Prove removal (all hard asserts):**
   - toast *"Selected items deleted successfully"* becomes visible;
   - the `flow-name-{flowId}` card is gone from the grid (count 0);
   - `GET /api/v1/flows/{flowId}` returns **404** (backend truth, not just
     UI state).

---

## Validation criterion *(required)*

- The confirmation modal gates the deletion and names the consequence.
- After confirming: success toast visible, the specific flow's card no
  longer renders, and the flows API returns 404 for its id. A regression in
  any layer (menu action, modal wiring, backend delete, list refresh) fails
  the test.

---

## Flow cleanup *(required)*

Test 1 deletes its own flow as the behavior under test; the id-scoped
`test.afterEach` (`createdFlowIds` + `deleteFlow`, which tolerates 404 as
"already gone") covers the failure path — a run that dies before the delete
still removes its flow. Tests 2–3 create up to 3 template flows each and
previously leaked all of them; the same shared `afterEach` now cleans every
tracked id. Behavioral force-fail contract: no-op the cleanup and the flow
count grows.

---

## What this test does not cover *(optional)*

- Bulk deletion / multi-select (covered by
  `project-management/bulk-actions.spec.ts`, §12.3 siblings).
- Cancel path of the confirmation modal (`btn_cancel_delete_confirmation_modal`).
- Deletion from inside the canvas or via API-only (API delete is exercised
  by helpers throughout the suite).
- Hardening of Tests 2–3's dead assertions (out of #682 scope — flagged in
  their known-weak notes above).

---

## External dependencies *(required)*

- None external to Langflow (no LLM call — Basic Prompting is only
  instantiated, never run).
- Home-page card markup: `list-card`, `flow-name-{id}`,
  `home-dropdown-menu`, `btn_delete_dropdown_menu`,
  `btn_delete_delete_confirmation_modal` /
  `btn_cancel_delete_confirmation_modal` (scouted live on 1.11.0.dev38;
  renaming these testids breaks the test).
- Toast wording "Selected items deleted successfully" (shared with bulk
  delete).
