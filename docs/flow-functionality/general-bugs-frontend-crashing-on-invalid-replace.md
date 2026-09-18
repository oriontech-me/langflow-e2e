# Spec: A `replacement` that names no existing component falls back to "No direct replacement." instead of crashing the canvas

**Test file:** `tests/tests-automations/regression/flow-functionality/general-bugs-frontend-crashing-on-invalid-replace.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

Regression guard for upstream `langflow-ai/langflow#10110` (*"Prevent crash on
invalid replacement components"*, 2025-10-09).

A component may declare `replacement = ["<category>.<Component>", …]`. The node then
shows the **Legacy** banner, which resolves every entry against the component
catalog the frontend has loaded — `data[category]?.[component]` — and renders
*"Use `<display name>`."* for the entries that resolve, or **"No direct
replacement."** when none does. Before #10110 the lookup was
`data[category][component]`: an entry whose **category** does not exist threw, and
the canvas crashed while rendering the node.

The test saves a Custom Component whose three `replacement` entries all fail to
resolve — two name a category that does not exist (`knowledgebases`) and one names
neither a real category nor a real component — and asserts that:

1. the code is accepted — **Check & Save** closes the code editor;
2. the canvas survives — exactly one node, still titled `Custom Component`;
3. that node carries its Legacy banner (`dismiss-warning-bar`) with the fallback
   **"No direct replacement."**, exactly once on the page — not a "Use …" line.

**Premise, measured on `1.13.0.dev16`:** `GET /api/v1/all` has no category named
`knowledgebases` (32 categories; the knowledge components live under
`files_and_knowledge`, whose `KnowledgeIngestion` does exist). So all three entries
go through the missing-category branch — the exact branch #10110 fixed — and none of
them resolves.

---

## Tags

`@stable` `@release` `@regression` `@components` `@ui-ux`

`@regression` because it pins a previously fixed product bug; `@ui-ux` is the
functional area (the node's Legacy banner).

---

## Step by step

1. Create a blank flow over the API with `setupBlankFlow` and open it; its id is
   deleted id-scoped in `afterEach`, after leaving the editor with
   `unmountEditorForCleanup`.
2. Wait for write permission to resolve (`menu_bar_display` enabled) — the editor
   drops an add silently while the permission query is in flight.
3. Add a Custom Component with `addCustomComponent` (the sidebar's dedicated
   `sidebar-custom-component-button`; the helper re-issues one swallowed click and
   otherwise fails naming it). Assert `title-Custom Component` is visible and that
   no Legacy banner is shown yet — the scaffold declares no `replacement`.
4. Open the node's code editor (`code-button-modal`) and replace the scaffold with
   the same component plus
   `replacement = ["knowledgebases.KnowledgeRetrieval", "knowledgebases.KnowledgeIngestion", "THISISNOTEXISTING.COMPONENT"]`.
5. Click **Check & Save** (`checkAndSaveBtn`).
6. Assert the validation criterion below.

---

## Validation criterion

| Claim | Observable |
|---|---|
| The code was accepted | `checkAndSaveBtn` is hidden (the editor closed) |
| The canvas did not crash | exactly one `.react-flow__node`; `title-Custom Component` visible |
| The node shows the Legacy banner | `dismiss-warning-bar` visible inside that node |
| The banner fell back | "No direct replacement." visible inside that node, exactly **1** on the page |

The banner is asserted absent before the save (step 3), so its presence afterwards is
caused by the saved `replacement` and not by the scaffold.

The test fails if the unresolvable entries crash the canvas or remove the node (the
#10110 regression); if the banner is not rendered for a component that declares a
`replacement`; or if the fallback is replaced by a "Use …" line — i.e. an entry that
should not resolve did.

---

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/components/NodeLegacyComponent/index.tsx` —
  the banner, its `dismiss-warning-bar` button and the literal "No direct
  replacement." (not an i18n key on 1.13, so a translated build would change it only
  if this file changes)
- `src/frontend/src/CustomNodes/GenericNode/hooks/use-get-replacement-components.ts` —
  the `data[category]?.[component]` lookup #10110 introduced
- The component catalog (`GET /api/v1/all`). The premise holds only while no category
  named `knowledgebases` exists. If one ever appears carrying `KnowledgeRetrieval` or
  `KnowledgeIngestion`, the banner would correctly read "Use …" and this test would
  fail — a finding about the test's input, not a product bug: re-point the entries at
  names that do not exist
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` — with the image default (`false`) the
  sidebar button is not rendered and `POST /api/v1/custom_component` answers 403

---

## What this test does not cover

- A **mixed** list, where some entries resolve and some do not — the "Use `<X>`."
  rendering that skips unresolved entries, the other half of #10110.
- Following a resolved replacement link — covered for Data Operations by
  `core-components/data-operations-legacy-link.spec.ts`.
- Dismissing the banner.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`
  (set by `scripts/start-langflow-docker.sh` and every CI lane). No provider key.

---

## Notes

- **Wave 9 T2 triage, issue #1907 — outcome PROMOTE.** Imported from upstream's own
  suite (`src/frontend/tests/extended/regression/`, where #10110 added it) with no
  doc and no cleanup; measured 3/3 green (`docs/triage/inherited-spec-triage.md`, T2
  row for this file). No `@stable` spec pins the missing-category branch —
  `core-components/data-operations-legacy-link.spec.ts` covers the banner only for a
  replacement that **resolves** — so DELETE was not available.
- Hardening for the promotion: (a) the file created a flow through
  `awaitBootstrapTest` + `blank-flow` and deleted nothing — **3 flows leaked per
  run** on an empty project (`New Flow`, `New Flow (2)`, `Basic Prompting`), read by
  diffing `GET /api/v1/flows/` around one run on 1.13.0.dev16; it now creates exactly
  one flow over the API and deletes that id; (b) the bare click on
  `sidebar-custom-component-button` became `addCustomComponent`, the shared
  swallowed-add repair (#1304); (c) the `waitForTimeout(1000)` in front of the text
  wait is gone; (d) the only assertion used to be a page-wide text count: the node's
  survival — which is what #10110 is about — was never asserted in its own right,
  and nothing tied the banner to the node that declared the `replacement`. The
  assertions are now scoped to that node, and its presence and title are asserted
  on their own.
