# Spec: Connected Inputs Cannot Be Hidden

**Test file:** `tests/tests-automations/regression/flow-functionality/general-bugs-hidden-input-edges.spec.ts`

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev46`)

---

## What this test validates

Regression test guarding the rule that **a node input with a connected edge
cannot be hidden**. Hiding a connected input would orphan its edge (a "hidden
input edge"), so the UI disables the visibility toggle for any field whose handle
is currently wired, and re-enables it once the edge is removed.

The test exercises the **Language Model** node's `input_value` field (wired in the
Basic Prompting template):

1. While `input_value` is connected, its inspector visibility toggle
   (`inspector-remove-input_value`) is **present but disabled**, and hovering its
   wrapper shows the tooltip *"Cannot change visibility of connected handles"*.
2. After the edge is deleted, the toggle becomes **enabled** and the field can be
   hidden — which removes it from the node body.

### dev46 node-inspector model

The nightly removed the inspect-panel on/off toggle and the old edit-fields modal
+ `show<field>` toggles. Field visibility is now driven from the node inspector:
`openAdvancedOptions` (`parameters-button`) opens it, a shown field carries an
`inspector-remove-<field>` toggle (and a hidden one an `inspector-add-<field>`),
and the disabled toggle's tooltip lives on the `inspector-remove-wrapper-<field>`
span (the disabled button itself has `pointer-events-none`).

---

## Tags

`@release` `@api` `@database`

---

## Step by step

1. Bootstrap; open the **Basic Prompting** template (`side_nav_options_all-templates`
   → *Basic Prompting*). Every flow created is captured from its
   `POST /api/v1/flows → 201` and deleted id-scoped in `afterEach`.
2. Select the **Language Model** node; open the inspector (`openAdvancedOptions`).
3. Assert `inspector-remove-input_value` is visible **and disabled**; hover
   `inspector-remove-wrapper-input_value` → the tooltip *"Cannot change
   visibility of connected handles"* is visible. Close the inspector.
4. Delete the `input_value` edge (`.react-flow__edge` nth 0 → Delete); assert the
   edge count drops to 2 (Basic Prompting wires 3).
5. Re-select the node; open the inspector; assert `inspector-remove-input_value`
   is now **enabled**; click it to hide the field. Close the inspector.
6. `unselectNodes`; assert the `Input` label is no longer on the node body.

---

## Validation criterion

| State | Criterion |
|---|---|
| `input_value` connected | `inspector-remove-input_value` visible + `toBeDisabled()`; wrapper hover shows *"Cannot change visibility of connected handles"* |
| after deleting the edge | edge count `toHaveCount(2)`; `inspector-remove-input_value` `toBeEnabled()` |
| after hiding the field | `getByText("Input", { exact: true })` `toBeHidden()` |

---

## External dependencies

- Basic Prompting starter template (Language Model with a wired `input_value`).
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions` /
  `closeAdvancedOptions` (dev46 inspector).
- `tests/helpers/ui/unselect-nodes.ts` — `unselectNodes`.
- No model provider credentials required — no flow execution, only inspector
  state + edge editing.

---

## What this test does not cover

- Other input fields / components (Language Model `input_value` is the canonical
  case).
- Persistence of the hidden/shown state across reload.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.

---

## Notes

- dev46 migration (issue #818): collapsed from two tests to one. The nightly
  removed the inspect-panel on/off toggle, so the former "…when inspection panel
  is disabled" variant no longer describes a distinct scenario. The single
  surviving behavior (connected → toggle visible **but disabled** + tooltip) is
  what dev46 renders; the old "hidden when connected" assertion no longer holds.
  Migrated `showinput_value` → `inspector-remove-input_value` (+ its
  `-wrapper-` tooltip trigger), `edit-fields`/`show<field>` → the inspector, and
  added id-scoped `afterEach` flow cleanup.
- Validated on `1.11.0.dev46` (2026-07-20): 3/3 green (~49s), `--workers=1
  --retries=0`, 0 orphan flows. Force-fail: flipping the connected-state
  `toBeDisabled()` to `toBeEnabled()` fails.
