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
2. **search flows** — the home search filters the flow grid by name
   *(known-weak: assertions are dead `isVisible()`/`isHidden()` booleans —
   NOT hardened here, out of #682's scope; do not promote as-is)*.
3. **search components** — sidebar component search after saving components
   *(known-weak: whole body inside an `if (visible)` guard, the #505
   conditional-bypass class — NOT hardened here, do not promote as-is.
   PROVEN vacuous on 1.11.0.dev41 during #682's force-fail pass: the
   `components-btn` guard is false, the body never executes, and an
   in-guard mutation cannot make the test fail)*.

## What broke the old Test 1 contract *(hardening rationale)*

The pre-#682 test could never fail: both its "assertions" were bare
`locator.isVisible()` calls whose boolean result was discarded (a fully
broken delete flow still produced a green run), the dropdown was targeted
with `.first()` (parallel-unsafe), and nothing verified the flow actually
disappeared. Hardening these is the required force-failability work of a
validate-&-promote issue (see #505 precedent).

---

## Tags *(required)*

- Test 1: `@stable` `@release` `@workspace` `@mainpage` (promoted by #682;
  `@workspace` added — flow lifecycle management is the subject)
- Tests 2–3: `@release` `@mainpage` (unchanged; not promoted — see
  known-weak notes)

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
