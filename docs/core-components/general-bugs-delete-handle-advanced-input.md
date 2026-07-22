# Spec: Delete Handles from Advanced Fields When Code Is Updated

**Test file:** `tests/tests-automations/regression/core-components/general-bugs-delete-handle-advanced-input.spec.ts`

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev46`)

---

## What this test validates

Regression test for a bug where dynamic handles tied to **advanced fields** lingered on the canvas after the component's code was re-saved. Adding an advanced field to the node body exposes an input handle on the node; re-saving the component code should re-evaluate the field config and drop the now-orphaned handle (along with its connected edge and the lock icon decorating it).

The test exercises the **If-Else** component because it has an advanced `true_case_message` field that historically left a dangling handle after the user re-saved the code. The contract under test:

1. Adding `true_case_message` to the node body exposes the `case true` input handle.
2. Connecting Chat Input → If-Else's `case true` produces a connected (locked) handle: the field widget switches to a read-only `Receiving input` placeholder and shows a lock icon.
3. After clicking **Check & Save** in the code modal with the default code, the advanced field config is re-evaluated and the `case true` handle, its edge, the `Receiving input` placeholder, and the lock icon are all removed (`count === 0`).

### dev46 node-inspector model (why this spec changed)

The nightly (~dev46) replaced the old "Controls" edit **modal** with a node **inspector side-panel**:

- The old canvas control that toggled an always-on inspect panel (`canvas_controls_dropdown_toggle_inspector`) was **removed** — the help dropdown now only holds docs / shortcuts / report-a-bug / desktop / smart-guides. There is no longer an inspect-panel on/off feature, so the spec no longer disables/re-enables it.
- Selecting a node exposes a `parameters-button` that opens the inspector panel. Each input renders as an `inspector-param-<field>` row; advanced fields not yet on the node body gain an `inspector-add-<field>` toggle (the modern equivalent of the old `show<field>` toggle). The panel closes via `inspection-panel-close`.
- The inspector panel **does not duplicate** the node's field widgets (the old modal did). Consequently the `Receiving input` placeholder and the lock icon now render **only once**, on the node body — the historic `toHaveCount(2)` (node + modal copy) is now `toHaveCount(1)`, and the field-state assertions no longer require the panel to be open.

---

## Tags

`@release` `@stable` `@components`

---

## Step by step

1. Bootstrap and open a blank flow.
2. Add the **If-Else** component from the sidebar.
3. Select the node, open the inspector (`parameters-button`), click `inspector-add-true_case_message` to add the advanced field to the node body, then close the inspector (`inspection-panel-close`).
4. Add a **Chat Input** component (drag onto canvas).
5. Connect Chat Input's collapsed `noshownode` "Chat Message" output handle to If-Else's `case true` input handle (the Chat Input node stays minimized — it is used only as a connection source).
6. On the node body (no panel open) assert the connected state: the `case true` handle exists, exactly 1 `Receiving input` placeholder is visible, and exactly 1 `icon-lock` icon is visible.
7. Click the If-Else title, open the code modal (`code-button-modal`), click **Check & Save** (`checkAndSaveBtn`) — resaves the default code.
8. On the node body assert the handle was dropped: the `case true` handle, the `Receiving input` placeholder, and the `icon-lock` icon are all `count === 0`.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After adding `true_case_message` to the node body | `handle-conditionalrouter-shownode-case true-left` exists (`toHaveCount(1)`) |
| After connecting Chat Input → If-Else `case true` | node body shows `toHaveCount(1)` `Receiving input` placeholder **and** `toHaveCount(1)` `icon-lock` |
| After Check & Save on code modal | `handle-conditionalrouter-shownode-case true-left` is gone (`toHaveCount(0)`) |
| After Check & Save on code modal | node body shows `toHaveCount(0)` `Receiving input` placeholders **and** `toHaveCount(0)` `icon-lock` icons |

The handle-presence assertion (`case true-left` 1 → 0) is the primary, most direct observable of the bug — the placeholder/lock counts corroborate it.

---

## External dependencies

- `src/backend/base/langflow/components/logic/conditional_router.py` — If-Else component. The `true_case_message` advanced field must exist as an addable inspector field for step 3 to find `inspector-add-true_case_message`.
- `src/frontend/src/CustomNodes/GenericNode/components/parameterRenderComponent/index.tsx` — emits the `Receiving input` placeholder for connected handles and the field widget on the node body.
- `src/frontend/src/modals/codeAreaModal/index.tsx` — Check & Save flow. The post-save handle cleanup happens here (or in the store reducer it triggers).
- `src/frontend/src/components/genericIconComponent/index.tsx` — emits the `icon-lock` test ID consumed by the spec.
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions` (opens the inspector via `parameters-button`), `closeAdvancedOptions` (`inspection-panel-close`). Renaming these helpers breaks the spec. The `enableInspectPanel` / `disableInspectPanel` helpers are **no longer used** by this spec (the inspect-panel toggle feature was removed in dev46).

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

- Migrated to the dev46 node-inspector model (issue #818): removed the `disableInspectPanel` / `enableInspectPanel` calls (feature removed upstream), swapped `showtrue_case_message` → `inspector-add-true_case_message`, and moved the field-state assertions to the node body (no modal duplication). `Receiving input` / `icon-lock` counts dropped from 2 → 1. Added the `case true` handle-presence assertion as the primary observable.
- Live-scouted against `1.11.0.dev46` (2026-07-19): field add → handle appears; connect → `Receiving input` = 1, `icon-lock` = 1; Check & Save → handle, placeholder, lock, and edge all removed.
- Flow cleanup: id-scoped `afterEach` deletes every flow this spec's page created (POST `/api/v1/flows` → 201), per repo convention (#490/#681).
