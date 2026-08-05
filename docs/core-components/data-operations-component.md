# Spec: Data Operations — unified component, per-operation outputs

**Test file:** `tests/tests-automations/regression/core-components/data-operations-component.spec.ts`

**Last validated:** Langflow 1.12.x

---

## What this test validates

Langflow 1.11.0 merged the three separate operation components — **JSON Operations**
(`DataOperations`), **Table Operations** (`DataFrameOperations`) and **Text Operations**
(`TextOperations`) — into a single **Data Operations** component
(`lfx/components/processing/operations.py`, class `OperationsComponent`, `name="Operations"`).
Upstream: `langflow-ai/langflow#13743` (unify) and `#14025` (naming). The three originals
remain in the sidebar as `legacy: true` with `replacement = ["processing.Operations"]`.

The unification rests on one contract, and this spec proves exactly that contract:

> An **Input Type** tab (Text / JSON / Table) selects which operations are offered, which
> main input is shown, and which output the node advertises — and the **selected operation**
> can then override the output type. Each operation must produce the value its own semantics
> define, from the input the selected type accepts.

Four tests cover it, one per axis:

1. **Text → Message.** The default path: `Case Conversion` on a Text input returns a
   `Message` whose text is the converted string.
2. **Word Count overrides the output type.** Still on Input Type `Text`, choosing
   `Word Count` re-advertises the node's output as **JSON** (`as_data`) — the output is
   decided by the *operation*, not only by the input type. This is the single most
   distinctive consequence of the merge: two operations under the same tab emit different
   Langflow types.
3. **JSON → Data, fed by the component itself.** A second Data Operations node in
   Input Type `JSON` consumes the Word Count node's JSON output and runs `Select Keys`,
   returning only the requested key. This proves both the JSON operation semantics and that
   the unified component's own output plugs into its own typed input.
4. **Table → DataFrame, fed by the component itself.** An upstream node converts a
   pipe-separated text block into a Table (`Text to DataFrame`, which likewise overrides the
   Text tab's default output); a downstream node in Input Type `Table` runs `Filter` and
   returns only the matching rows.

Tests 3 and 4 also assert the **operation picker is filtered by the Input Type**: after
switching to JSON the picker offers `Select Keys` and no longer offers `Case Conversion`;
after switching to Table it offers `Filter` and, again, not `Case Conversion`. That is
`update_build_config`'s `build_config["operation"]["options"] = OPERATIONS_BY_TYPE[input_type]`
observed from the UI — a regression that stopped filtering would leave a Text operation
selectable against a Table input and fail here.

**No model provider is required.** Every operation is pure Python (string ops, dict ops,
pandas); the spec neither resolves a model nor consumes `models.json`.

### Why the assertion surface is the output inspector

Each test reads the value the component actually returned, from the node's output inspector
(`output-inspection-<output>-operations`), not from a downstream sink:

- `Message` output → the inspector renders a `textarea`; assert `toHaveValue(...)`.
- `JSON` output → the inspector renders a JSON viewer; assert the dialog's text contains the
  exact `"key": value` pairs (and, negatively, that a key the operation should have dropped
  is absent).
- `Table` output → the inspector renders an ag-grid; assert the `role="gridcell"` contents.

The inspector testid itself carries the output's display name
(`output-inspection-${title.toLowerCase()}-${type.toLowerCase()}`, from
`CustomNodes/GenericNode/components/NodeOutputfield/index.tsx`), so asserting on
`output-inspection-json-operations` *is* an assertion that the node advertises a JSON output
— the testid cannot exist unless `update_outputs` produced that output.

---

## Tags

`@stable` `@components` `@ui-ux`

`@components` is the cross-cutting tag (canvas component configuration and execution).
`@ui-ux` is the functional tag: no functional tag maps to data processing today, and every
assertion here is made through the node UI and its output inspector — the same reasoning
recorded in `docs/core-components/human-input-node-config.md`.

`@regression` is deliberately **absent**: this is first-time coverage of a 1.11.0 feature,
not a previously fixed bug. `@destructive` does not apply — each test creates and deletes
exactly its own flow.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on the nightly, 1.12.x).
- **No** model provider credentials, no `collect-models` pre-flight, no `--workers=1`.
- No legacy-components toggle: **Data Operations is the non-legacy component** and is
  present in the default sidebar (`add-component-button-data-operations`). The three
  originals it replaces are the legacy ones and are not used here.

---

## Scenarios (one `test()` per row)

| # | Scenario | Input Type | Operation | Input value | Advertised output | Asserted result |
|---|---|---|---|---|---|---|
| 1 | Text operation returns the converted Message | Text | Case Conversion (`case_type=uppercase`) | `data ops probe abc123` | Message | inspector textarea === `DATA OPS PROBE ABC123` |
| 2 | Word Count overrides the Text output to JSON | Text | Word Count | `data ops probe abc123 data ops` | **JSON** (not Message) | `"word_count": 6`, `"unique_words": 4`, `"character_count": 30`; `output-inspection-message-operations` has count 0 |
| 3 | JSON operation selects one key from an upstream JSON output | JSON (downstream node) | Select Keys (`["word_count"]`) | upstream Word Count JSON | JSON | output is `{ "word_count": 6 }` and does **not** contain `unique_words` |
| 4 | Table operation filters the rows of an upstream Table output | Table (downstream node) | Filter (`column_name=score`, `greater than`, `15`) | upstream `Text to DataFrame` of a 4-line pipe table | Table | grid cells are exactly `beta, 30, gamma, 20` (2 of 3 rows) |

### Expected values are derived from the component source, not observed

- `_word_count` (operations.py): `word_count = len(text.split())`, `unique_words =
  len(set(text.split()))`, `character_count = len(text)`. For
  `data ops probe abc123 data ops` → 6 / 4 / 30. The sentinel repeats `data` and `ops`
  **on purpose**, so `unique_words` (4) differs from `word_count` (6) — a regression that
  returned the same list for both would pass a same-value sentinel and fails here.
- `select_keys`: `{key: value for key, value in data_dict.items() if key in filter_criteria}`
  → a single-key dict. The negative half of the assertion (`unique_words` absent) is what
  separates "Select Keys ran" from "the upstream payload was passed through".
- `filter_rows_by_value` with `greater than`: `pd.to_numeric(filter_value)` then
  `column > numeric_value`. `_convert_numeric_columns` has already made `score` numeric, so
  `10, 30, 20 > 15` → rows `beta` and `gamma`. Values are chosen so the survivors are **not**
  the first N rows — a `head`-like regression, or a comparison done on strings
  (`"10" > "15"` is `False`, `"30" > "15"` is `True`, `"20" > "15"` is `True` — same rows,
  but `"9"` would flip), cannot be mistaken for a pass. The table's row order also proves
  the filter preserves order.

---

## Step by step

### Shared setup

`openFlowWithDataOperations(page, request, bearer)` (local helper):

1. `createFlow` via the REST API with a unique name (parallel-safe), pushing the id onto the
   spec's `createdFlowIds` for id-scoped teardown.
2. `page.goto("/flow/<id>")`, wait for `sidebar-search-input`.
3. `addComponentFromSidebar(page, "data operations", "add-component-button-data-operations")`.
4. Assert `title-Data Operations` is visible.

Tests 3 and 4 call it once, then add a **second** Data Operations node from the sidebar and
call `zoomOut` + `adjustScreenView` + `separateOverlappingNodes` — two sidebar `+` clicks land
the nodes ~10 px apart, and a stacked node intercepts pointer events aimed at a handle
underneath it (#939).

### Node identity in the two-node tests

The two nodes share every testid (both are type `Operations`), so they are **not** addressed
by DOM order once configured. After the downstream node is switched to its Input Type, the
two are distinguished by an identity-carrying child:

- upstream = the node containing `textarea_str_text_input` (only a Text-mode node has it);
- downstream = the node containing `handle-operations-shownode-json-left` (test 3) or
  `handle-operations-shownode-table-left` (test 4) — only a JSON/Table-mode node has it.

Each locator is asserted to resolve to exactly **one** node before use, so a mis-selection
fails naming the cause instead of silently configuring the wrong node.

### Per-test steps

**Test 1 — Text → Message**
1. Setup (one node). Input Type stays on the default `Text` tab.
2. Fill `textarea_str_text_input` with `data ops probe abc123`.
3. Open the operation picker (`button_open_list_selection_sortablelist_sortablelist_operation`)
   and click `list_item_case_conversion`.
4. Set `value-dropdown-dropdown_str_case_type` → option `uppercase`.
5. Click `button_run_data operations`; wait for `node_duration_data operations`.
6. Click `output-inspection-message-operations`; assert the dialog textarea has value
   `DATA OPS PROBE ABC123`; close with `btn-close-modal`.

**Test 2 — Word Count overrides the output type**
1. Setup (one node), Input Type `Text`.
2. Fill the text with `data ops probe abc123 data ops`.
3. Pick `list_item_word_count`.
4. **Before running**, assert the advertised output flipped: `output-inspection-json-operations`
   is visible and `output-inspection-message-operations` has count 0.
5. Run; wait for `node_duration_data operations`.
6. Open the JSON inspector and assert its text contains `"word_count": 6`,
   `"unique_words": 4` and `"character_count": 30`.

**Test 3 — JSON mode over the component's own JSON output**
1. Setup, then add a second node; separate them.
2. Upstream node: text `data ops probe abc123 data ops`, operation `Word Count`.
3. Downstream node: click `tab_1_json`. Assert the picker is now filtered — open it, expect
   `list_item_select_keys` visible and `list_item_case_conversion` count 0 — and pick
   `list_item_select_keys`.
4. Fill `inputlist_str_select_keys_input_0` with `word_count`.
5. Wire `handle-operations-shownode-json-right` (upstream) →
   `handle-operations-shownode-json-left` (downstream); assert 1 edge exists.
6. Run the **downstream** node; wait for its `node_duration_data operations`.
7. Open its `output-inspection-json-operations`; assert the dialog contains `"word_count": 6`
   and does **not** contain `unique_words`.

**Test 4 — Table mode over the component's own Table output**
1. Setup, add a second node, separate them.
2. Upstream node: open the text-area modal
   (`button_open_text_area_modal_textarea_str_text_input`), fill `text-area-modal` with
   ```
   name|score
   alpha|10
   beta|30
   gamma|20
   ```
   and click `genericModalBtnSave`. (The node-level field is an `<input>` and strips
   newlines — the modal is the only way to enter a multi-line value.) Then pick
   `list_item_text_to_dataframe` and assert the advertised output became
   `output-inspection-table-operations`.
3. Downstream node: click `tab_2_table`; assert the picker offers `list_item_filter` and no
   longer `list_item_case_conversion`; pick `list_item_filter`.
4. Fill `popover-anchor-input-column_name` = `score`,
   `popover-anchor-input-filter_value` = `15`, and set
   `value-dropdown-dropdown_str_filter_operator` → `greater than`.
5. Wire `handle-operations-shownode-table-right` → `handle-operations-shownode-table-left`;
   assert 1 edge exists.
6. Run the downstream node; open `output-inspection-table-operations`; assert the grid cells
   are exactly `["beta", "30", "gamma", "20"]`.

---

## Validation criterion

| # | Pass condition |
|---|---|
| 1 | The Message inspector's textarea equals `DATA OPS PROBE ABC123` exactly. |
| 2 | `output-inspection-json-operations` exists **and** `output-inspection-message-operations` does not, before the run; after it, the JSON payload carries `word_count: 6`, `unique_words: 4`, `character_count: 30`. |
| 3 | The JSON-mode picker offers `Select Keys` and not `Case Conversion`; the downstream node's JSON output contains `"word_count": 6` and no `unique_words` key. |
| 4 | The Table-mode picker offers `Filter` and not `Case Conversion`; the downstream node's Table output has exactly the cells `beta, 30, gamma, 20`. |

Every criterion is a value the component computed in that run. None of them can be satisfied
by an empty output, a passthrough, or a node that failed to build (the run gate is
`node_duration_data operations`, which renders only on a successful build).

---

## External dependencies

- `lfx/components/processing/operations.py` — `OperationsComponent`: `OPERATIONS_BY_TYPE`
  (the picker's source of truth), `update_build_config` (input-type filtering + field
  reveal), `update_outputs` (per-operation output routing), `as_message` / `as_data` /
  `as_dataframe`, `_word_count`, `select_keys`, `_text_to_dataframe`,
  `filter_rows_by_value`.
- `src/frontend/.../parameterRenderComponent/components/tabComponent/index.tsx` — emits
  `tab_{index}_{testIdCase(tab)}` for the Input Type selector.
- `src/frontend/.../parameterRenderComponent/components/sortableListComponent/index.tsx` —
  emits `button_open_list_selection_sortablelist_sortablelist_<field>` and the
  `list_item_<snake_case_name>` options.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeOutputfield/index.tsx` — emits
  `output-inspection-<output>-<type>`, the spec's per-operation output-type assertion.
- `tests/helpers/flows/create-flow.ts`, `delete-flow.ts`,
  `add-component-from-sidebar.ts`, `unmount-editor-for-cleanup.ts`.
- `tests/helpers/ui/zoom-out.ts`, `adjust-screen-view.ts`, `separate-overlapping-nodes.ts`,
  `assistant-onboarding.ts` (`seedAssistantDiscovered`).

No external network, no provider key, no `httpbin`/echo endpoint.

---

## Flow cleanup

Each test creates exactly one flow through `createFlow` (REST), so its id is known without
sniffing responses. `afterEach` navigates off the canvas via `unmountEditorForCleanup(page)`
— the mounted editor polls `GET /flows/{id}/events` and would log a burst of
`🚨 Backend Error` 404s against a flow being deleted underneath it (#1023/#1103/#1288) —
then deletes each id with an explicit `Authorization` header (`page.request`/`request` is
unauthenticated under AUTO_LOGIN and would 401). Never `cleanAllFlows`, never a name-scoped
or diff-based wipe: those kill flows other parallel workers are driving (#553).

---

## What this test does not cover

- **The other 25 operations.** Text has 10, JSON 8, Table 12; four are exercised here, one
  per axis plus the output-override case. The remaining ones share the same dispatch
  (`_json_handlers`, `table_handlers`, `text_handlers`) and the same `update_outputs`
  routing that these four prove; individual operation semantics are separate coverage.
- **`Merge` / `Concatenate`** (Table) and **`Combine`** (JSON), which consume *multiple*
  connected inputs (`left_dataframe`/`right_dataframe`, `is_list=True`). Different wiring
  shape; out of scope here.
- **`Path Selection`**, whose `mapped_json_display` refresh repopulates a dynamic
  `selected_key` dropdown via `update_build_config` — a distinct dynamic-field behaviour.
- **`Text Join`**, the only operation advertising **two** outputs (Text + Message).
- **The legacy link/redirect.** `QA-CHECKLIST.md` §3.10's second bullet — legacy JSON/Table/Text
  Operations components pointing at Data Operations, and legacy flows still building — is
  separate coverage (`core-components/data-operations-legacy-link.spec.ts`) and is not
  touched here.
- **Persistence across reload.** `update_frontend_node` re-derives the picker options and the
  outputs from the saved `input_type` on load; asserting that would be a reload test, and the
  four tests here assert the live-configuration path only.

---

## Notes

- The operation picker is a `SortableListInput` with `limit=1`: once an operation is chosen
  the "Select Operation" button is replaced by a chip. Every test picks its operation **once**,
  so no chip removal is needed. Switching the **Input Type** clears the selection by itself
  (`build_config["operation"]["value"] = []`), which is what lets tests 3 and 4 re-open the
  picker after clicking the tab.
- `count_words` / `count_characters` / `count_lines` are `advanced=True` and default to
  `True`; test 2 relies on those defaults and never reveals them.
- The Text main input renders as an `<input type="text">` on the node
  (`textarea_str_text_input`) — multi-line values must go through
  `button_open_text_area_modal_textarea_str_text_input` → `text-area-modal` →
  `genericModalBtnSave` (test 4).
- `seedAssistantDiscovered(page)` runs in `beforeEach`, before the first document load: the
  two-node tests click the canvas-controls bar (`zoomOut`, `adjustScreenView`), which the
  assistant onboarding tooltip covers (#1220).
- All four mechanics were confirmed live on nightly `1.12.0.dev10` during PLAN, including the
  two chained flows: the JSON chain returned `{"word_count": 6}` and the Table chain returned
  the two-row grid `beta/30, gamma/20`.
