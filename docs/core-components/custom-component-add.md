# Spec: Custom Component — Add and Save Flow

**Test file:** `tests/tests-automations/regression/core-components/customComponentAdd.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

Confirms the end-to-end flow of adding a **Custom Component** from the sidebar and saving its code:

1. The dedicated **`sidebar-custom-component-button`** drops a new Custom Component onto the canvas.
2. The newly-added component renders its `code-button-modal` with the **`animate-pulse-pink`** class — a visual indicator that the code is unsaved and the user must review/save it before the component is usable.
3. Opening the code editor (Ace editor inside the modal), replacing the boilerplate with valid Python, and clicking **Check & Save** removes the `animate-pulse-pink` class — confirming the save round-trip succeeded and the component is no longer flagged as needing attention.

The pulse-pink visual contract is the user-facing signal that Langflow uses to disambiguate "default scaffolded code" from "user-confirmed code". Losing this signal would silently let unsaved scaffolds propagate into flows.

---

## Tags

`@release` `@stable` `@components`

---

## Step by step

1. Bootstrap and open a blank flow.
2. Click `sidebar-custom-component-button` to add a Custom Component.
3. Assert the last `code-button-modal` on the canvas is visible and has the `animate-pulse-pink` class.
4. Click the `code-button-modal` to open the code editor.
5. Click into the Ace editor, select all (`Ctrl/Cmd+A`), and fill with a minimal valid Custom Component class.
6. Click **Check & Save**.
7. Assert the `code-button-modal` no longer has the `animate-pulse-pink` class.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After sidebar click | `code-button-modal` is visible within 10 s |
| Initial state | `code-button-modal` has `animate-pulse-pink` class |
| After Check & Save | `code-button-modal` no longer has `animate-pulse-pink` class within 10 s |

---

## External dependencies

- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarFooterButtons.tsx` — owns the `sidebar-custom-component-button` test ID. Renaming it breaks step 2.
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/index.tsx` (or equivalent) — emits the `code-button-modal` test ID and applies the `animate-pulse-pink` class while code is unsaved. A change to either the test ID or the class name breaks the entire spec.
- `src/frontend/src/modals/codeAreaModal/index.tsx` — Ace editor lives here. The `.ace_content` selector and the underlying `<textarea>` mirror are stable since multiple specs depend on them.
- `src/backend/base/langflow/custom/custom_component/component.py` — Check & Save calls validation here; if validation rejects the minimal Component class shipped in the spec body, step 6 fails.

---

## What this test does not cover

- Code validation errors. The spec ships a syntactically and semantically valid Custom Component; a syntax error would be caught by a separate test.
- Connecting the saved Custom Component to other nodes. The test stops at save confirmation.
- Persisting the Custom Component code across flow reload — covered by general save/load specs.
- The drag-and-drop alternative to the dedicated sidebar button.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required.

---

## Notes

- Refactored from `waitForSelector` with 3 s timeouts to `expect().toBeVisible({ timeout: 10000 })`, dropped the unused `sleep(60)` line from the embedded code (it was copy-pasted from a stop-building test and never exercised here).
- Force-fail probe on the final `not.toHaveClass` assertion confirms the test catches real regressions.
- Validated with `--retries=0` and `--trace=on`, zero backend errors.
