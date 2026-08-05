# Spec: legacy operations components link to Data Operations

**Test file:** `tests/tests-automations/regression/core-components/data-operations-legacy-link.spec.ts`

**Last validated:** Langflow 1.12.x

---

## What this test validates

The other half of `QA-CHECKLIST.md` §3.10. When 1.11.0 merged JSON / Table / Text
Operations into the unified **Data Operations** node (covered by
`data-operations-component.spec.ts`, #1191), the three originals were not deleted — they
were marked `legacy = True` with `replacement = ["processing.Operations"]`, and upstream
`langflow-ai/langflow#14118` wired that pointer into the UI. This spec covers the promise
that pairing makes to a user who already has one of the old components:

> A legacy operations node **tells you what replaced it, by name**, gives you a one-click
> route to it, is still reachable when you search for its old name — and **keeps building**
> in the meantime.

Four tests, one claim each:

1. **All three legacy nodes resolve their replacement.** Each of JSON / Table / Text
   Operations renders the Legacy banner reading `Use Data Operations.`
2. **The banner link is a route, not decoration.** Clicking `Data Operations` in the banner
   filters the component sidebar down to that component.
3. **Searching the old name finds the new component**, with the Legacy toggle in its
   default OFF state.
4. **A legacy operations component still runs**, returning the value its operation defines.

### Why the banner text is the assertion, and why `No direct replacement.` is the trap

`NodeLegacyComponent/index.tsx` does not print the raw `replacement` string. It resolves it
through `useGetReplacementComponents`, which splits `"processing.Operations"` into category
and name and looks up `data["processing"]["Operations"].display_name` in the types store.
Only when that lookup succeeds does it render `Use <display name>.`; otherwise it falls back
to the literal string **`No direct replacement.`**

That makes the observable unusually sharp for a UI string. Asserting `Use Data Operations.`
proves the *whole chain*: the legacy component still declares a `replacement`, the pointer
still names a category and component that exist in this build, and the frontend resolved it
to the display name a user can act on. Rename or move the unified component and the banner
silently degrades to `No direct replacement.` — the node still renders, nothing errors, and
only this assertion notices. So every banner check asserts the positive string **and** the
absence of the fallback.

### Distinct from the sibling spec that looks similar

`flow-functionality/general-bugs-frontend-crashing-on-invalid-replace.spec.ts` also mentions
`No direct replacement` — but it is the **opposite** journey and a different subject: it
builds a *custom* component with a deliberately bogus `replacement`
(`THISISNOTEXISTING.COMPONENT`) and proves the frontend degrades to that fallback instead of
crashing. It asserts the fallback path **works**; this spec asserts the three real legacy
operations components are **not on it**. Neither covers the other.

`core-components/legacy-components-toggle-regression.spec.ts` covers the sidebar Legacy
toggle itself (visibility on/off) with an unrelated component pair, not the
replacement-pointer contract. Test 3 below depends on that toggle's default only as a
precondition.

---

## Tags

`@stable` `@components` `@ui-ux`

`@components` is the cross-cutting tag (canvas/sidebar component behaviour); `@ui-ux` the
functional one — the banner, the sidebar filter and the sidebar search are interface
surfaces. Same reasoning as `data-operations-component.md` and `human-input-node-config.md`.

`@regression` is deliberately **absent**: first-time coverage of a 1.11.0 feature, not a
previously fixed bug. `@destructive` does not apply — each test creates and deletes its own
flow, and the one piece of shared-looking state it touches (`showLegacy`) is **localStorage**
(`getBooleanFromStorage("showLegacy", false)`), so it is per browser context and cannot leak
into a parallel worker.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on the nightly, 1.12.x).
- **No** model provider credentials, no `collect-models`, no `--workers=1`.
- The sidebar **Legacy** toggle defaults to OFF. Tests 1, 2 and 4 turn it on via
  `addLegacyComponents(page)` to reach the legacy components; test 3 depends on it being
  **off** and therefore never touches it.

---

## Scenarios (one `test()` per row)

| # | Scenario | Setup | Asserted observable |
|---|---|---|---|
| 1 | All three legacy operations nodes name their replacement | Legacy toggle on; add JSON Operations, Table Operations and Text Operations to one flow | Each node exposes `dismiss-warning-bar` (the Legacy banner) and contains the text `Use Data Operations.`; none contains `No direct replacement.` |
| 2 | The banner link filters the sidebar to the replacement | Legacy toggle on; one JSON Operations node; click the `Data Operations` link inside its banner | `sidebar-filter-reset` becomes visible (a component filter is active) and the sidebar offers `add-component-button-data-operations` while `add-component-button-json-operations` drops to count 0 |
| 3 | The old names find the new component with Legacy off | Default toggle state; type each legacy name into `sidebar-search-input` | For all three searches the sidebar offers `add-component-button-data-operations`, and the matching legacy button (`…-json-operations` / `…-table-operations` / `…-text-operations`) has count 0 |
| 4 | A legacy operations component still builds | Legacy toggle on; Text Operations, `Case Conversion` = uppercase, text `legacy still works abc123` | `node_duration_text operations` renders (successful build) and `output-inspection-message-textoperations` shows `LEGACY STILL WORKS ABC123` |

Test 3 is what makes the "redirect" claim true for a user who never enables the Legacy
toggle: the unified component carries the old names in `metadata.keywords`
(`"json operations"`, `"table operations"`, `"text operations"` — `operations.py`), so the
search that used to land on the legacy node now lands on its replacement. The negative half
(the legacy button absent) is what keeps the test honest — without it, the assertion would
also pass on a build where the search matched both.

Test 4's expected value comes from the legacy component's own source
(`text_operations.py` → `_case_conversion` → `str.upper`), not from observation, and reuses
the sentinel shape of the #1191 spec.

---

## Step by step

### Shared setup

`openFlowWithLegacy(page, request, bearer, { enableLegacy })` (local helper):

1. `createFlow` via the REST API with a unique name (parallel-safe); push the id onto
   `createdFlowIds` for id-scoped teardown.
2. `page.goto("/flow/<id>")`, wait for `sidebar-search-input`.
3. When `enableLegacy`, call `addLegacyComponents(page)` — the existing helper that opens
   `sidebar-options-trigger`, flips `sidebar-legacy-switch`, asserts it is checked, and
   closes the menu.

### Per-test steps

**Test 1 — the three banners**
1. Setup with the Legacy toggle on.
2. Add `JSON Operations`, `Table Operations` and `Text Operations` from the sidebar
   (`add-component-button-{json,table,text}-operations`), asserting the node count after
   each so a silently missing component fails here and not in the assertion.
3. For each node — located by its own `title-<name>` testid, so the three stacked nodes are
   never confused — assert `dismiss-warning-bar` is attached, the node text contains
   `Use Data Operations.`, and it does **not** contain `No direct replacement.`

The nodes are deliberately **not** separated: this test only reads text and testids inside
each node, so the pointer-interception problem that forces `separateOverlappingNodes` in the
chained #1191 tests does not arise.

**Test 2 — the link filters the sidebar**
1. Setup with the Legacy toggle on; add one `JSON Operations` node.
2. Inside the node, click the banner's `Data Operations` button
   (`getByRole("button", { name: "Data Operations" })` — the link carries no testid).
3. Assert `sidebar-filter-reset` is visible, `add-component-button-data-operations` is
   visible, and `add-component-button-json-operations` has count 0.

**Test 3 — search by the old names, Legacy off**
1. Setup **without** enabling the toggle.
2. For each of `json operations`, `table operations`, `text operations`: fill
   `sidebar-search-input`, then assert `add-component-button-data-operations` is visible and
   the corresponding legacy add-button has count 0.

**Test 4 — a legacy component still builds**
1. Setup with the Legacy toggle on; add `Text Operations`.
2. Fill `textarea_str_text_input` with `legacy still works abc123`.
3. Open `button_open_list_selection_sortablelist_sortablelist_operation`, pick
   `list_item_case_conversion`, set `value-dropdown-dropdown_str_case_type` to `uppercase`.
4. Run via `button_run_text operations`; wait for `node_duration_text operations`.
5. Open `output-inspection-message-textoperations` and assert the modal's textarea equals
   `LEGACY STILL WORKS ABC123`; close it and wait for the modal to be gone.

---

## Validation criterion

| # | Pass condition |
|---|---|
| 1 | All three legacy nodes render the Legacy banner and read `Use Data Operations.`, none reads `No direct replacement.` |
| 2 | After the banner click the sidebar carries an active component filter and offers exactly the replacement, not the legacy origin. |
| 3 | With Legacy off, each old name surfaces `Data Operations` and no legacy button. |
| 4 | The legacy Text Operations node builds (`node_duration_*`) and its Message output equals `LEGACY STILL WORKS ABC123`. |

Nothing here can be satisfied by an empty state: three of the four assert a **positive**
string or element plus the **absence** of the alternative it would degrade to, and the fourth
asserts a value the component had to compute.

---

## External dependencies

- `lfx/components/processing/data_operations.py`, `dataframe_operations.py`,
  `text_operations.py` — each declares `legacy = True` and
  `replacement = ["processing.Operations"]`; `text_operations.py` also owns the
  `_case_conversion` behaviour test 4 asserts.
- `lfx/components/processing/operations.py` — the replacement target; its
  `metadata.keywords` carry the three legacy names that test 3 searches for.
- `src/frontend/src/CustomNodes/GenericNode/components/NodeLegacyComponent/index.tsx` —
  renders the banner, the `dismiss-warning-bar` testid, the `Use <name>.` / `No direct
  replacement.` branch, and the link whose click calls `setFilterComponent`.
- `src/frontend/src/CustomNodes/GenericNode/hooks/use-get-replacement-components.ts` —
  resolves `"processing.Operations"` to a display name via the types store.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/index.tsx` — owns
  `showLegacy` (localStorage, default false) and the `sidebar-filter-reset` control.
- `tests/helpers/flows/add-legacy-components.ts`, `create-flow.ts`, `delete-flow.ts`,
  `add-component-from-sidebar.ts`, `unmount-editor-for-cleanup.ts`,
  `tests/helpers/ui/assistant-onboarding.ts`.

No external network, no provider key.

---

## Flow cleanup

Each test creates exactly one flow via `createFlow`, so the id is known without sniffing
responses. `afterEach` leaves the editor through `unmountEditorForCleanup(page)` — a mounted
editor keeps polling `GET /flows/{id}/events` and would log a burst of `🚨 Backend Error`
404s against a flow being deleted underneath it (#1023/#1103/#1288) — then deletes each id
with an explicit `Authorization` header. Never `cleanAllFlows` or a name/diff-scoped wipe
(#553).

---

## What this test does not cover

- **The `Dismiss` control.** `dismiss-warning-bar` sets `dismissAllLegacy` and persists per
  flow in localStorage (`dismiss_legacy_<flowId>`, `flowStore.ts`). It is banner UX, not the
  replacement contract; its presence is asserted, its behaviour is not.
- **Migrating a legacy node into the unified one.** The banner link *filters the sidebar*; it
  does not rewrite the node. There is no in-place upgrade action for these components on this
  build, so there is nothing to assert.
- **Importing a flow JSON saved by an older Langflow.** Any fixture committed here would be
  serialized by the build under test, so it would prove deserialization of *this* build's
  payload, not of an older one. Test 4 covers the claim that matters and is provable — a
  legacy component still builds and returns the right value.
- **The remaining operations of the legacy components.** Their per-operation semantics were
  the point of the components the unified one replaces; #1191 covers that surface on the
  replacement. Test 4 exercises one operation as proof of life, not as a matrix.
- **The other legacy components in the sidebar** (Python Function, Alter Metadata, …). This
  spec is scoped to §3.10's three operations components.

---

## Notes

- The legacy nodes keep their **original** class names in every testid — the node type is
  `DataOperations` / `DataFrameOperations` / `TextOperations`, not `Operations`. Hence
  `output-inspection-message-textoperations` and `button_run_text operations`, and hence no
  testid collision with the unified component if both ever sit on one canvas.
- The banner link has no testid; it is matched by accessible name
  (`getByRole("button", { name: "Data Operations" })`), scoped to the node so it can never
  resolve to the sidebar entry of the same name.
- `showLegacy` is localStorage-backed and defaults to `false`, so enabling it in one test
  cannot affect a parallel worker, and test 3's precondition holds without any reset.
- All four mechanics were confirmed live on nightly `1.12.0.dev10` during PLAN: the three
  banners read `Use Data Operations.`; the link left the sidebar filtered to a single
  `Data Operations` entry with `sidebar-filter-reset` present; each legacy name searched with
  the toggle off returned only `add-component-button-data-operations`; and the legacy Text
  Operations node built and returned `LEGACY STILL WORKS ABC123`.
