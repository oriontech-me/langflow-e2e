# Spec: Sidebar Connection Filter on Handle Click

**Test file:** `tests/tests-automations/regression/ui-ux/filterSidebar.spec.ts`

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev40`)

---

## What this test validates

Clicking a node's **input handle** filters the component sidebar to only the
components whose output is a compatible connection source for that input, and the
**legacy** / **beta** sidebar toggles expand that set. Removing the filter
(the `icon-X` on the filter chip) restores the normal sidebar.

The test drives an **API Request** node and exercises two of its inputs:

1. **`url` input handle** → the sidebar filters to string-compatible sources;
   toggling **legacy** reveals legacy components (Chat Input/Output, Prompt
   Template, CSV Agent, ConversationChain, Prompt Hub) and toggling **beta** off
   hides beta-only ones (Prompt Hub).
2. **`headers` input handle** (a `Data`-typed input) → the sidebar filters to
   `Data`-compatible sources; under the beta filter it includes data sources
   (API Request, Astra DB), flow control (Sub Flow), and processing components.

---

## Tags

`@stable` `@release` `@components` `@api` `@ui-ux`

---

## Step by step

1. Bootstrap; open a blank flow from the templates modal; wait out the
   `flow-builder-welcome` onboarding overlay and confirm the editor has mounted
   (`canvas_controls_dropdown`) **before touching the sidebar**; then drag an
   **API Request** node onto the canvas through the shared add primitive. The
   created flow is captured from `POST /api/v1/flows → 201` and deleted
   id-scoped in `afterEach`.
2. Click the `url` input handle → assert the filter chip (`icon-ListFilter`)
   shows and the expected category disclosures are visible.
3. Enable the **legacy** toggle → assert legacy components appear; disable the
   **beta** toggle → assert the beta-only Prompt Hub disappears.
4. Reset the filter (`sidebar-filter-reset`) → assert the filtered components are
   no longer visible.
5. Open the inspector, add the advanced `headers` field to the node body
   (`inspector-add-headers`), close the inspector, and click the `headers` input
   handle → assert the data-sources / llm-operations / processing disclosures and
   representative compatible components are visible (API Request, Astra DB, Sub
   Flow).
6. Enable **beta** → assert Sub Flow and a processing component (`Create Data`)
   remain visible.
7. Remove the filter (`icon-X`) → assert the previously-filtered components are
   hidden.

---

## Validation criterion

| Step | Criterion |
|---|---|
| blank flow entered | the templates modal is gone, `flow-builder-welcome-panel` is hidden and `canvas_controls_dropdown` is visible before any sidebar interaction |
| API Request added | a node id that was **not** on the canvas before the drag is present |
| `url` handle clicked | `icon-ListFilter` visible; category disclosures visible |
| legacy on / beta off | legacy components visible; `Prompt Hub` hidden with beta off |
| `headers` handle clicked | `data_sourceAPI Request`, `datastaxAstra DB`, `flow_controlsSub Flow` visible |
| beta on (headers filter) | `flow_controlsSub Flow` and `processingCreate Data` visible |
| filter removed | the filtered components (`data_sourceAPI Request`, `datastaxAstra DB`, `flow_controlsSub Flow`, `processingSplit Text`) hidden |

---

## External dependencies

- API Request component (its `url` and advanced `headers` inputs).
- `tests/helpers/ui/open-advanced-options.ts` — `openAdvancedOptions` /
  `closeAdvancedOptions` (dev46 inspector; `inspector-add-headers`).
- `tests/helpers/flows/open-blank-flow-from-modal.ts` — `openBlankFlowFromModal`
  (re-issues the `blank-flow` click when the creation is refused, #1468).
- `tests/helpers/flows/add-component-from-sidebar.ts` —
  `dragComponentFromSidebar` (repairs the swallowed sidebar add, #1304/#1320/#1335;
  it also owns the search fill and its reset repair, #1518).
- The `flow-builder-welcome` onboarding overlay (`flow-builder-welcome-panel`)
  and the canvas readiness barrier (`canvas_controls_dropdown`).
- Sidebar legacy/beta toggles (`sidebar-options-trigger`, `sidebar-legacy-switch`,
  `sidebar-beta-switch`) and the filter chip (`icon-ListFilter`, `icon-X`,
  `sidebar-filter-reset`).
- No model provider credentials required.

---

## What this test does not cover

- The actual creation of a connection from the filtered sidebar.
- Every compatible component — it asserts representative ones per state.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.

---

## Notes

- dev46 migration (issue #818): two drifts. (1) `showheaders` →
  `inspector-add-headers` (the advanced `headers` field is now added to the node
  body via the inspector). (2) The set of components compatible with the `headers`
  `Data` input evolved — the monolithic **Data Operations** component was split
  into granular ops (Create Data, Select Data, Update Data, …), so the stale
  `processingData Operations` assertion was updated to `processingCreate Data`, a
  representative compatible processing component present under the beta filter.
  The connection-filtering behavior itself is unchanged; only the representative
  component changed. Added id-scoped `afterEach` flow cleanup.
- **Absorbed `filterEdge-shard-0.spec.ts` and `filterEdge-shard-1.spec.ts`
  (removed, issue #939).** Both anchored on **Retrieval QA**, which is
  `legacy: true` on 1.12 and absent from the default sidebar — shard-1 was
  already red because of it and shard-0 only survived by accident. Their
  subject (clicking a handle reveals the compatible connections) is this
  spec's subject, exercised here on a non-legacy component and with
  substantially stronger assertions.
- **#1623 — readiness, not behavior.** On the 2026-08-27 daily (run
  `33105369510`) this test hard-failed all three attempts, at **two** different
  locators: attempt 0 on `sidebar-search-input` and attempts 1-2 on
  `handle-apirequest-shownode-url-left`. Both are the same root cause class —
  every gate in this spec was budgeted at 3000 ms and the spec drove the entry,
  the search fill and the drag by hand.
  Measured on nightly `1.12.0.dev40`, 3 of 3 blank-flow entries: the
  `flow-builder-welcome-panel` overlay is **visible at the moment of the
  `blank-flow` click**, and `sidebar-search-input` is in the DOM but **not
  visible** — the exact reported shape. On an idle host the overlay clears in
  ~107 ms and the input becomes visible at ~211-231 ms; #1301 measured the
  sibling observable at up to ~10.6 s under load, which is why 3000 ms is the
  whole margin. The overlay is intentional onboarding, present since ~dev17 —
  this is a test-side readiness gap, **not** a Langflow regression, and nothing
  was filed upstream. The second locator is the swallowed sidebar add
  (#1304/#1320): the bare `dragTo` is accepted, no node is created and no flow
  write follows, so the handle never renders — a longer wait provably cannot fix
  it. Fixed by routing the entry through `openBlankFlowFromModal`, gating on the
  overlay and the canvas controls explicitly (attribution: a stuck overlay must
  fail as the overlay), and adding the node through `dragComponentFromSidebar`.
- Validated on `1.11.0.dev46` (2026-07-20): 3/3 green (~52s), `--workers=1
  --retries=0`, 0 orphan flows. Force-fail: asserting a component that is not in
  the compatible set (`processingSplit Text`) fails.
