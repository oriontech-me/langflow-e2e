# Spec: Delete Handles from Advanced Fields When Code Is Updated

**Test file:** `tests/tests-automations/regression/core-components/general-bugs-delete-handle-advanced-input.spec.ts`

**Last validated:** Langflow 1.10.x

---

## What this test validates

Regression test for a bug where dynamic handles tied to **advanced fields** lingered on the canvas after the component's code was re-saved. Toggling an advanced field exposes an input handle on the node; re-saving the component code should re-evaluate the field config and drop the now-orphaned handle (and the lock icon decorating connected upstream edges).

The test exercises the **If-Else** component because it has a togglable `true_case_message` advanced field that historically left a dangling handle after the user re-saved the code. The contract under test:

1. Toggling `showtrue_case_message` exposes a "Receiving input" placeholder.
2. Connecting Chat Input → If-Else's `case true` produces a locked handle (visible in Advanced view as another "Receiving input" placeholder + a lock icon).
3. After clicking **Check & Save** in the code modal with the default code, the advanced field config is re-evaluated and both the "Receiving input" placeholders and the lock icon are removed (`count === 0`).

---

## Tags

`@release` `@stable` `@components`

---

## Step by step

1. Bootstrap and open a blank flow.
2. Add the **If-Else** component from the sidebar.
3. Disable the inspect panel, open Advanced Options.
4. Toggle `showtrue_case_message`, then close Advanced Options.
5. Add a **Chat Input** component (drag onto canvas).
6. Connect Chat Input's collapsed `noshownode` "Chat Message" output handle to If-Else's `case true` input handle (the node stays minimized — it is used only as a connection source).
7. Click the If-Else title and open Advanced Options again — assert exactly 2 "Receiving input" placeholders are visible.
8. Close Advanced Options.
9. Click the If-Else title, open the code modal, click **Check & Save** (resaves the default code).
10. Open Advanced Options.
11. Assert exactly 0 "Receiving input" placeholders **and** exactly 0 `icon-lock` icons.
12. Close Advanced Options and re-enable the inspect panel.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After connecting Chat Input → If-Else | Advanced view shows `toHaveCount(2)` `Receiving input` placeholders |
| After Check & Save on code modal | Advanced view shows `toHaveCount(0)` `Receiving input` placeholders |
| After Check & Save on code modal | Advanced view shows `toHaveCount(0)` `icon-lock` icons |

---

## External dependencies

- `src/backend/base/langflow/components/logic/conditional_router.py` — If-Else component. The `true_case_message` advanced field and its `show` toggle must exist for step 4 to find `showtrue_case_message` test ID.
- `src/frontend/src/CustomNodes/GenericNode/components/parameterRenderComponent/index.tsx` — emits the `Receiving input` placeholder for unconnected handles.
- `src/frontend/src/modals/codeAreaModal/index.tsx` — Check & Save flow. The post-save handle cleanup happens here (or in the store that handles the resulting reducer call).
- `src/frontend/src/components/genericIconComponent/index.tsx` — emits the `icon-lock` test ID consumed by the spec.
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions`, `closeAdvancedOptions`, `enableInspectPanel`, `disableInspectPanel`. Renaming these helpers breaks the spec.

---

## What this test does not cover

- Persistence across flow reload — the test re-opens the same node in the same session.
- The case where the user modifies the code (not just resaves the default). The bug fix specifically targeted resave with unchanged code.
- Other components with advanced fields. If-Else is the canonical reproduction case.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required.

---

## Notes

- Refactored from `waitForSelector` (with one 100 s timeout) to `expect().toBeVisible(...)` and `toHaveCount`. The first appearance check after canvas bootstrap uses a 30 s timeout (`canvas_controls_dropdown` settles slower on cold workers); subsequent sidebar visibility checks use 10 s.
- Replaced `.hover().then(...)` chain with sequential awaits.
- Stability: 3 / 3 PASS across consecutive runs (~10–12 s each).
- Force-fail probe on the post-save `toHaveCount(0)` assertion confirms the test catches real regressions.
