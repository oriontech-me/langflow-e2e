# Spec: Parameters Panel — field-type edit matrix

**Test file:** `tests/tests-automations/regression/core-components/parameters-panel-field-types.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

The component **Parameters Panel** accepts edits across every field-type input
and **persists** each edited value. This is the §2.1 field-type matrix: for each
distinct input type, a representative component is added to a flow, the field is
edited on the canvas, and the new value is proven to persist in the saved flow.

A **parametrized matrix** — one `test()` per field type — sharing a common
setup/verify shape, so a regression in any single input type is isolated to its
own test.

> **Phased delivery.** This spec ships the **6 simple-mechanic types** first
> (text, int, dropdown, tab, textarea, toggle) — all with a plain click/fill edit
> and a scalar/string persisted value. The **6 complex/modal types** (slider drag,
> code editor, table modal, key-pair NestedDict, input-list SortableList, float)
> are deferred to a follow-up because each needs a distinct modal/drag mechanic
> and two (`KeypairInput`/`ListInput` from the checklist era) no longer exist as
> those input types — mapping them is tracked separately. The matrix below marks
> each type's phase.

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
| 1 | Edit text field (input) | `MessageTextInput` | API Request | `url_input` | fill `popover-anchor-input-url_input` | **this PR** |
| 2 | Edit dropdown | `DropdownInput` | API Request | `method` | click `dropdown_str_method` → `POST-1-option` | **this PR** |
| 3 | Edit text area (textarea) | `MultilineInput` | API Request | `curl_input` | fill `textarea_str_curl_input` (cURL tab) | **this PR** |
| 4 | Edit int field | `IntInput` | API Request | `timeout` | fill `int_int_timeout` | **this PR** |
| 5 | Edit tab component | `TabInput` | API Request | `mode` | click `tab_1_curl` | **this PR** |
| 6 | Edit toggle field | `BoolInput` | Save File | `append_mode` | click `toggle_bool_append_mode` | **this PR** |
| 7 | Edit slider | `SliderInput` | Language Model | `temperature` | drag `slider_thumb` | follow-up |
| 8 | Edit code field | `CodeInput` | Python Function | `function_code` | code editor modal | follow-up |
| 9 | Edit table input | `TableInput` | API Request | `headers` | table modal → cell | follow-up |
| 10 | Edit key-pair list | `NestedDictInput` | Alter Metadata | `metadata` | key/value row | follow-up |
| 11 | Edit input list | `SortableListInput` | Read File | `storage_location` | list item | follow-up |
| 12 | Edit float field | `FloatInput` | Semantic Text Splitter | `breakpoint_threshold_amount` | numeric input | follow-up |

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
- table: `value` is an array of row objects; the edited cell is asserted.
- key-pair (NestedDict): `value` is an object; the edited key→value asserted.
- input list (SortableList): `value` is a list; the edited item asserted.

---

## External dependencies

- `tests/helpers/flows/create-flow.ts`, `delete-flow.ts`, `auth/get-auth-token.ts`.
- Representative components (all core, non-bundle): API Request, Python Function,
  Semantic Text Splitter, Alter Metadata, Read File, Language Model.
- **No model-provider credentials required** — no flow is executed; edits are
  read back via the flows API.

Field testids confirmed live on `langflow-nightly 1.11.0.dev45` during authoring
(`popover-anchor-input-url_input`, `dropdown_str_method`, `int_int_timeout`,
`title-mode` + `tab_0_url`/`tab_1_curl`, `div-table_headers` + `icon-Table`, …);
the remaining per-type testids are harvested in the PLAN/IMPLEMENT scout.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.11.x).
- Auth via `auto_login` (repo default).

---

## What this test does not cover

- Field **validation** (rejecting out-of-range/invalid input) — this matrix
  asserts accepted edits persist, not the rejection path.
- Executing the components — persistence is asserted via the flows API, not a run.
- Advanced-field visibility toggling and connection handles — covered elsewhere
  (§2.1 "open advanced", handle specs).

---

## Notes

- **Force-fail probes (executed during validation):** one mutation per `test()`
  (per field type), each observed failing then reverted — documented in the PR
  Validation block.
- Every test creates exactly one flow and deletes it id-scoped in `afterEach`.
