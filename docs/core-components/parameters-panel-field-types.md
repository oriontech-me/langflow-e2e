# Spec: Parameters Panel — field-type edit matrix

**Test file:** `tests/tests-automations/regression/core-components/parameters-panel-field-types.spec.ts`

**Last validated:** Langflow 1.12.x

---

## What this test validates

The component **Parameters Panel** accepts edits across every field-type input
and **persists** each edited value. This is the §2.1 field-type matrix: for each
distinct input type, a representative component is added to a flow, the field is
edited on the canvas, and the new value is proven to persist in the saved flow.

A **parametrized matrix** — one `test()` per field type — sharing a common
setup/verify shape, so a regression in any single input type is isolated to its
own test.

> **Phased delivery.** The matrix is delivered in phases, all sharing the same
> setup/verify shape:
> - **Phase 1 (#662):** the 6 simple-mechanic types (text, dropdown, textarea,
>   int, tab, toggle) — plain click/fill edits, scalar/string persisted values.
> - **Phase 2 (#795):** float and slider — a numeric fill and a keyboard-stepped
>   slider.
> - **Phase 3 (#798):** 3 modal/complex types — code editor, table
>   modal, key-pair NestedDict. (`KeypairInput` from the checklist era no longer
>   exists as that input type — it maps to today's `NestedDictInput`.)
> - **Phase 4 (#806, this PR):** input list (`SortableListInput`) — the final
>   type; a build-robust remove-chip → open-selection → pick mechanic.
>
> With phase 4 the matrix covers **all 12 live input types**. The 12th —
> **input list** (`SortableListInput`, Read File `storage_location`) — landed in
> phase 4 (#806) with a **build-robust** remove-chip mechanic: the remove control
> renders differently across nightly builds (`icon-x` on some, absent on others),
> so the test removes the pre-selected `Local` chip only when the open-selection
> button is not already available, scoping the remove to the chip `<li>` and
> falling back from `icon-x` to any control inside it.
> Two phase-3 components (**Python Function**, **Alter Metadata**) are `legacy`
> and hidden from the sidebar by default, and API Request's `headers` is an
> `advanced` field — the tests enable legacy and show-or-reveal the advanced
> field (see the matrix and External dependencies). The matrix below marks each
> type's phase.

### Verification model (uniform across types)

Each test:
1. Creates a blank flow via the API and opens it.
2. Adds the representative component from the sidebar.
3. Edits the target field in the Parameters Panel (mechanism per type — see
   matrix).
4. Waits for autosave, then reads back the value via
   `GET /api/v1/flows/{id}` and asserts `data.nodes[].data.node.template.<field>.value`
   equals the edited value.

Reading the persisted template value (not just the on-screen widget) is the
durable proof the edit was accepted **and** saved — it survives re-render and
matches what a reload would load.

### Field-type matrix (13 bullets → 12 live input types)

| # | Field type (checklist) | Input type | Component | Field | Edit mechanism | Phase |
|---|---|---|---|---|---|---|
| 1 | Edit text field (input) | `MessageTextInput` | API Request | `url_input` | fill `popover-anchor-input-url_input` | phase 1 ✓ |
| 2 | Edit dropdown | `DropdownInput` | API Request | `method` | click `dropdown_str_method` → `POST-1-option` | phase 1 ✓ |
| 3 | Edit text area (textarea) | `MultilineInput` | API Request | `curl_input` | fill `textarea_str_curl_input` (cURL tab) | phase 1 ✓ |
| 4 | Edit int field | `IntInput` | API Request | `timeout` | fill `int_int_timeout` | phase 1 ✓ |
| 5 | Edit tab component | `TabInput` | API Request | `mode` | click `tab_1_curl` | phase 1 ✓ |
| 6 | Edit toggle field | `BoolInput` | Save File | `append_mode` | click `toggle_bool_append_mode` | phase 1 ✓ |
| 7 | Edit slider | `SliderInput` | Language Model | `temperature` | click `slider_thumb` + `ArrowRight` | **phase 2 (this PR)** |
| 8 | Edit code field | `CodeInput` | Python Function *(legacy)* | `function_code` | open `codearea_code_function_code` → set ACE value → `checkAndSaveBtn` | **phase 3 (this PR)** |
| 9 | Edit table input | `TableInput` | API Request | `headers` *(advanced)* | show-or-reveal `div-table_headers` → settle (method→POST refresh) → Open table → `add-row-button` (retried until the row lands) → fill key/value cells | **phase 3**; flake-hardened #868 |
| 10 | Edit key-pair list | `NestedDictInput` | Alter Metadata *(legacy)* | `metadata` | `dict_nesteddict_metadata` → Edit Dictionary (text mode) → fill JSON → Save | **phase 3 (this PR)** |
| 11 | Edit input list | `SortableListInput` | Read File | `storage_location` *(advanced)* | show-or-reveal the field → remove the `Local` chip (build-robust) → `button_open_list_selection_…` → `list_item_aws` | **phase 4 (#806)** |
| 12 | Edit float field | `FloatInput` | Semantic Text Splitter | `breakpoint_threshold_amount` | fill `float_float_breakpoint_threshold_amount` | **phase 2 (this PR)** |

> The checklist's *key-pair list* and *input list* correspond to the checklist-era
> `KeypairInput` / `ListInput`, which no longer exist in the current registry;
> they map to today's `NestedDictInput` and `SortableListInput` respectively — the
> spec asserts the live equivalents. The 13th checklist bullet ("Edit tab
> component") is the `TabInput` row.

---

## Tags

`@stable` `@components` `@regression`

`@components` (canvas/parameters-panel configuration) is the functional area.
`@stable` is added after the deterministic-run + force-fail validation.

---

## Validation criterion

For each field type: after editing its field in the Parameters Panel and waiting
for autosave, `GET /api/v1/flows/{id}` returns the target node's
`template.<field>.value` (or the type's persisted shape — a selected option, a
boolean, a numeric, a table row, a code string) **equal to the edited value**.

Each test fails if editing that input type does not persist — a regression in
the panel's handling of that specific field type.

### Type-specific persisted shapes (confirmed live during authoring)

- text / textarea / int / float / code: scalar `value`.
- dropdown / tab: the selected string in `value`.
- toggle: boolean `value` flipped from its default.
- slider: numeric `value` within the field's range.
- code (`function_code`): scalar string `value` — the saved Python source, asserted to contain a unique sentinel. Save runs a Python syntax check, so the edited code must be valid.
- table (`headers`): `value` is an array of `{key, value}` row objects; the edited row is found and asserted.
- key-pair (NestedDict `metadata`): `value` is an object; the edited `{key: value}` pair is asserted.
- input list (SortableList `storage_location`): `value` is a list of `{name, icon, …}` objects (`limit=1`); after switching from the default `Local` to `AWS`, `value[0].name === "AWS"` is asserted (the react-sortablejs `chosen`/`selected` keys are ignored).

---

## External dependencies

- `tests/helpers/flows/create-flow.ts`, `delete-flow.ts`, `auth/get-auth-token.ts`,
  `add-component-from-sidebar.ts`.
- `tests/helpers/flows/add-legacy-components.ts` — phase 3's code and key-pair
  tests add `legacy` components (Python Function, Alter Metadata), hidden from the
  sidebar unless the **Legacy** feature toggle is on; this helper flips it.
- Representative components (all core, non-bundle): API Request, Python Function
  *(legacy)*, Semantic Text Splitter, Alter Metadata *(legacy)*, Read File,
  Language Model.
- **No model-provider credentials required** — no flow is executed; edits are
  read back via the flows API.

Field testids confirmed live on `langflow 1.11.0` during authoring — phase 1/2
(`popover-anchor-input-url_input`, `dropdown_str_method`, `int_int_timeout`,
`tab_1_curl`, `float_float_breakpoint_threshold_amount`, `slider_thumb`) and
phase 3 (`codearea_code_function_code` + `checkAndSaveBtn`, `div-table_headers` +
`add-row-button`, `dict_nesteddict_metadata`, `inspector-add-storage_location` +
`button_open_list_selection_sortablelist_sortablelist_storage_location` +
`list_item_aws`).

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.11.x).
- Auth via `auto_login` (repo default).

---

## What this test does not cover

- Field **validation** (rejecting out-of-range/invalid input) — this matrix
  asserts accepted edits persist, not the rejection path.
- Executing the components — persistence is asserted via the flows API, not a run.
- Advanced-field visibility toggling and connection handles as behaviors —
  covered elsewhere (§2.1 "open advanced", handle specs). Phase 3's input-list
  test reveals `storage_location` only as a setup step to reach the field; it
  asserts the edited value, not the visibility toggle itself.
- The Python syntax validation on code save — the code test uses valid code so
  the save succeeds; the rejection path is not asserted here.

---

## Notes

- **Force-fail probes (executed during validation):** one mutation per `test()`
  (per field type), each observed failing then reverted — documented in the PR
  Validation block.
- Every test creates exactly one flow and deletes it id-scoped in `afterEach`.
