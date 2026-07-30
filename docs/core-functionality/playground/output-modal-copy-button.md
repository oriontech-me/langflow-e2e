# Output Modal — Copy Button

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

Validates that the **Copy** button inside a component's Output Modal copies the component's text output to the clipboard and gives the user a clear visual confirmation:

1. The "Copied to clipboard" toast appears
2. The button's icon transitions from Copy → Check (success state)
3. The button reverts back to Copy after the success state expires

If this breaks, users have no reliable way to grab the output of a component into the clipboard from the modal — a primary path for sharing or pasting results out of Langflow.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@playground`

---

## Step by step *(required)*

1. Create the blank flow with the shared `setupBlankFlow` helper: it creates the flow
   over the API, navigates to it, and returns the flow id (no `POST /api/v1/flows`
   response interception needed)
2. Gate on write permission having resolved (`menu_bar_display` enabled) and on
   `sidebar-search-input` being visible, then add a **Chat Input** component, expand
   it (it is added minimized), and fill its `textarea_str_input_value` with
   `"Test content to copy"`
3. Run the component (`button_run_chat input`) and wait for the "built successfully" toast
4. Click the first `output-inspection-*` button to open the Component Output modal
5. Click `copy-output-button`
6. Assert "Copied to clipboard" toast is visible
7. Assert the Check icon (`icon-Check`) is visible inside the button
8. Assert the Copy icon (`icon-Copy`) returns within 5s (web-first assertion — no `waitForTimeout`)

`afterEach` navigates to `/` (so the editor's background polling cannot complete
after the delete and log spurious 404s) and deletes the returned flow id via
`DELETE /api/v1/flows/{id}`, passing an explicit bearer from `getAuthToken` — under
AUTO_LOGIN a bare request context is unauthenticated, so an unheadered delete 401s
and silently leaks the flow.

**Sidebar entry race (#1063).** This step used to drive the home page → "New Flow" →
templates modal → `blank-flow` path, which is what made the spec flake: while the
welcome overlay is open, `FlowPage` mounts the whole `FlowSidebarComponent` inside a
`display: none` wrapper, so `sidebar-search-input` was in the DOM with an empty
bounding box — what Playwright reports as `hidden`. "New Flow" opens that overlay
before navigating and "Browse more templates" does not close it. Creating the flow
over the API never opens it. Full chain in
`docs/ui-ux/execution-error-notification.md`.

---

## Validation criterion *(required)*

- "Copied to clipboard" toast appears within 5s of clicking the copy button
- Button shows `icon-Check` immediately after the click (success state)
- Button returns to `icon-Copy` within 5s (state revert)

---

## External dependencies *(required)*

- `data-testid="copy-output-button"` — copy button rendered inside the Output Modal
- `data-testid="icon-Check"` and `data-testid="icon-Copy"` — icon components inside the button
- `data-testid="output-inspection-*"` — the inspector entry point that opens the Output Modal
- `data-testid="textarea_str_input_value"` and `button_run_chat input` — Chat Input component fields
- Backend endpoints: `POST /api/v1/flows` (flow creation), `DELETE /api/v1/flows/{id}` (cleanup)

---

## What this test does not cover *(optional)*

- Copying outputs of other component types (e.g., JSON from API Request) — was previously a separate test that depended on `httpbin.org` and was removed for being flaky and externally dependent
- The clipboard contents themselves — the test asserts the UI confirmation (toast + icon transitions), not the OS clipboard

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`
- No LLM, no external HTTP calls — Chat Input runs are local

---

## Notes *(optional)*

- Runs in `serial` mode (only one test, but kept for consistency with sibling playground specs)
- Cleanup is scoped to the flow this test creates (id captured from the 201 response of `POST /api/v1/flows`)
