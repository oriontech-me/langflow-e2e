# Spec: A component whose icon cannot be loaded still renders — in the sidebar and on the canvas — with the icon fallback

**Test file:** `tests/tests-automations/regression/ui-ux/general-bugs-icons-fallback.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

Regression guard for upstream `langflow-ai/langflow#6989` (2025-03-10, *"improve ref
naming causing fallback error on icons + regression test"*): component icons that
could not be shown got stuck on a loading indicator instead of degrading to a
fallback.

On 1.13 every component icon — in the sidebar entry and in the node header — renders
through `ForwardedIconComponent`. It resolves the icon lazily (`getNodeIcon`; each
lucide icon is its own asset, `/assets/<icon>-<hash>.js`), shows a skeleton while the
asset loads, and when the load fails its error boundary switches the icon to an empty
fallback `div` with `data-testid="icon-placeholder"`. The contract:

1. a component whose icon asset cannot be loaded **still renders** — its sidebar
   entry keeps its name, and adding it places a node with its title;
2. both show the **fallback** (`icon-placeholder`) in place of the icon — the icon
   settles on the fallback instead of staying on a loader, which is #6989's symptom;
3. the failure is **contained** — the other entries keep their icons.

The test makes the icon genuinely not found: the browser is refused Split Text's icon
asset (`/assets/scissors-line-dashed-<hash>.js`). It then expands the two sidebar
categories the original expanded — **data sources** and **processing** — and adds
Split Text to the canvas.

---

## Tags

`@stable` `@release` `@regression` `@components` `@ui-ux`

`@regression` because it pins a previously fixed product bug; `@components` because it
covers component rendering in the sidebar and on the canvas; `@ui-ux` is the
functional area.

---

## Step by step

1. Before any navigation, route every request for
   `/assets/scissors-line-dashed-<hash>.js` to an abort, recording each refused URL.
2. Create a blank flow over the API (`createFlow`) and open it by id
   (`openFlowById`); the id is deleted in `afterEach`, after leaving the editor with
   `unmountEditorForCleanup`.
3. Expand the sidebar categories `disclosure-data sources` and
   `disclosure-processing`; assert the entries `processingSplit Text`,
   `processingParser` and `data_sourceAPI Request` are visible.
4. Assert the premise: at least one request for Split Text's icon asset was made and
   refused.
5. Assert the Split Text entry renders its name with the fallback, and the two
   control entries render their icons.
6. Add Split Text with `addComponentFromSidebar(page, "split text",
   "add-component-button-split-text")` and assert the node renders with the fallback
   in its header.

---

## Validation criterion

| Claim | Observable |
|---|---|
| Premise: the icon is its own asset and it was refused | the route recorded ≥ 1 refused request for `scissors-line-dashed-<hash>.js` |
| The sidebar entry still renders | `processingSplit Text` visible, its `display-name` reads `Split Text` |
| It settled on the fallback, not on a loader | the entry contains `icon-placeholder` and no `icon-scissors-line-dashed` |
| The failure is contained | `processingParser` and `data_sourceAPI Request` each contain an `svg` whose testid starts with `icon-`, and no `icon-placeholder` |
| The component is still usable | exactly one `.react-flow__node`, `title-Split Text` visible, and that node's header shows `icon-placeholder` with no `icon-scissors-line-dashed` |

The test fails if a missing icon leaves the entry or the node on a pending loader
(the skeleton never becomes `icon-placeholder` — the #6989 regression), if the
missing icon takes the entry or the node down with it, or if the failure spreads to
icons that did load.

---

## External dependencies

- `src/frontend/src/components/common/genericIconComponent/index.tsx` — the icon
  states: skeleton while loading, `icon-placeholder` when the icon is unresolved or
  its load failed, and the error boundary that switches between them
- `src/frontend/src/utils/styleUtils.ts` — `getNodeIcon`, which resolves a lucide icon
  to a lazy import of its own asset
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx`
  — the sidebar entry and its icon
- `src/frontend/src/CustomNodes/GenericNode/components/nodeIcon/index.tsx` — the node
  header icon
- `src/lfx/src/lfx/components/processing/split_text.py` — declares
  `icon = "scissors-line-dashed"`
- The frontend build emitting one asset per lucide icon, named `<icon>-<hash>.js`
  under `/assets/` (measured on `1.13.0.dev16`: `scissors-line-dashed-c-caocoL.js`).
  If a build bundles icons together, or Split Text changes its icon, the premise
  assertion fails naming it — re-point the route, do not loosen the assertions

---

## What this test does not cover

- An icon **name** no icon set knows (as opposed to an asset that fails to load):
  `getNodeIcon` resolves it to an empty component that renders nothing, so there is
  no fallback element to observe.
- Category and bundle icons in the sidebar headers.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No provider key; no vendor distribution
  (Split Text, Parser and API Request are core components).

---

## Notes

- **Wave 9 T2 triage, issue #1908 — outcome PROMOTE, rewritten.** Imported from
  upstream's own suite (`src/frontend/tests/extended/regression/`, where #6989 added
  it) with no doc and no cleanup; measured 3/3 green
  (`docs/triage/inherited-spec-triage.md`, T2 row for this file).
- **Why the inherited test could not fail.** It expanded the same two categories and
  asserted `getByTestId("loading-icon").count() === 0`. `loading-icon` is the
  `Loading` spinner in `src/frontend/src/components/ui/loading.tsx`, which #6989
  tagged when it wrote this test. On 1.13 the icon pipeline never renders it — its
  loading state is a skeleton and its failure state `icon-placeholder` — and none of
  the components that still import `Loading` is part of the flow editor's sidebar.
  Measured on `1.13.0.dev16`: 0 `loading-icon`, 0 placeholders and 0 skeletons after
  expanding both categories, every entry an `svg` icon. The count was 0 by
  construction.
- **DELETE was not available:** no `@stable` test asserts a sidebar or node icon at
  all, so no replacement could be named. The title is kept — it now describes what
  the test checks.
- The inherited file created flows through `awaitBootstrapTest` + `blank-flow` and
  deleted nothing — **3 flows leaked per run** on an empty project (`New Flow`,
  `New Flow (2)`, `Basic Prompting`). It now creates one flow over the API and
  deletes that id.
