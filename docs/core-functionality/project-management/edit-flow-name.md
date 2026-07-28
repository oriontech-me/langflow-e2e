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

0. Install a `POST /api/v1/flows` → 201 listener so every flow the test creates
   is tracked by id and deleted in `afterEach` (id-scoped cleanup, #553).
1. Bootstrap the session (`awaitBootstrapTest(page)`).
2. Open the **Basic Prompting** starter flow.
3. For each of two random target names:
   1. `renameFlow(page, { flowName: targetName })` — rename via the flow header
      settings modal; then `renameFlow(page)` (read-only) asserts the committed
      header name equals `targetName`.
   2. Click `icon-ChevronLeft` to return to the home listing.
   3. Assert `home-dropdown-menu` is visible (home rendered) — web-first
      assertion, 30 s.
   4. Assert `getByText(targetName)` has count `1` — auto-waits for the flow-list
      refetch + render (web-first, 30 s). This replaced a fixed 3 s
      `waitForSelector` that raced the refetch under parallel load
      (recurring flaky, issue #410).
   5. Re-open the flow via the `list-card` `list-card-open-button` overlay button
      (the `/flows` a11y refactor, Langflow #13891, made the card content
      `pointer-events-none`), so the next iteration starts inside the editor.

---

## Validation criterion *(required)*

- After each rename, the flow header reflects the new name.
- Returning to the home listing shows the renamed flow exactly once
  (`toHaveCount(1)`), proving the rename persisted through the flow-list refetch.

---

## External dependencies *(required)*

- **Basic Prompting** starter template must be available on the fresh instance.
- Testids: `icon-ChevronLeft`, `home-dropdown-menu`, `list-card`,
  `flow-name-div`, `list-card-open-button`, and the flow-header rename controls
  used by `renameFlow` (`flow_name`, flow-settings name input).
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
