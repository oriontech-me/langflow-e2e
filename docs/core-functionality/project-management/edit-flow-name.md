# Project Management – Edit Flow Name

**Last validated:** Langflow 1.10.x

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
