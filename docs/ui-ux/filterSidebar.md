# Spec: Sidebar Connection Filter on Handle Click

**Test file:** `tests/tests-automations/regression/ui-ux/filterSidebar.spec.ts`

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev46`)

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

`@release` `@components` `@api`

---

## Step by step

1. Bootstrap; open a blank flow; drag an **API Request** node onto the canvas.
   The created flow is captured from `POST /api/v1/flows → 201` and deleted
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
- Validated on `1.11.0.dev46` (2026-07-20): 3/3 green (~52s), `--workers=1
  --retries=0`, 0 orphan flows. Force-fail: asserting a component that is not in
  the compatible set (`processingSplit Text`) fails.
