# Spec: Import Flows by Dropping a File on the Home Page

**Test file:** `tests/tests-automations/regression/flow-functionality/dragAndDrop.spec.ts`

## What this test validates

Dropping a `.json` file onto the home page's flow list imports it: a **collection
file** (many flows in one payload) and a **single flow file**. This is the file
`§10.1 — Upload flow by drag-and-drop to folder` path, NOT the sidebar→canvas
component drag of `§15.2` (that one lives in
`docs/ui-ux/sidebar-add-component.md`) — the two are routinely confused because
of this file's name, and `docs/core-components/component-hover-add.md` previously
pointed at this spec for the §15.2 drag.

Two independent tests:

1. **Collection file** — dropping `tests/assets/flows/collection.json` (15 flows)
   creates **one flow per entry in the file**: the spec counts the **flows** the
   drop created — the ids its import responses carry — and requires exactly as many
   as the asset declares, then asserts the imported flows are on screen anchored
   by their own ids (`flow-name-<id>` inside `list-card`). The count is of flows,
   never of responses: see *The import contract changed in 1.14* below.
2. **Single flow file** — dropping a copy of
   `tests/assets/flows/flow_test_drag_and_drop.json` renamed to a per-run random
   string creates exactly one flow, whose card carries that name and its returned
   id.

### What this change fixed (both tests)

- **Dead assertions removed.** Both tests contained
  `const c = await genericNode?.count(); if (c > 0) { expect(true).toBeTruthy(); }`
  — a check that asserts nothing when the count is 0 and asserts a tautology when
  it isn't. On top of that `div-generic-node` is a *canvas node* testid, which is
  not even present on the home page, so the block could never have meant
  anything. Replaced by the id-anchored card assertions above, which fail when the
  import silently creates nothing.
- **Flow leak stopped.** Each run previously left the imported flows behind (15 + 1
  per full run) *plus* one Basic Prompting flow created by the "add a new flow just
  to have the workspace available" step. Ids are now collected from every
  `POST /api/v1/flows/` 201 response and deleted in `afterEach`; the workspace
  precondition comes from `awaitBootstrapTest(page, { skipModal: true })` instead
  of opening a template.

  **Corrected 2026-09-10 (#1787): "every 201" was the intent, not the behaviour.**
  The capture listener was installed *after* `awaitBootstrapTest`, on the stated
  grounds that the bootstrap's own flows are "shared bootstrap state, not ours to
  delete" and that counting their 201s would break the import-count assertion.
  The second half of that is right and is preserved; the first half conflates a
  flow **this page created** with a flow another worker owns — the bootstrap of a
  parallel worker creates a different id, so deleting by id can never touch it.
  Measured on `1.13.0.dev7`: a green run left the instance two flows heavier,
  `New Flow` plus a second `Basic Prompting`, once per run.

  The fix keeps both reasons intact by separating the two populations. A
  **cleanup** tracker is installed *before* `awaitBootstrapTest` and captures every
  flow the page creates, which `afterEach` deletes and no assertion ever counts;
  the **import** tracker goes up afterwards and is the only thing the count
  assertion reads. Since #2399 both are the shared `trackCreatedFlows` (the import
  tracker's ids are a subset of the cleanup tracker's, so it is disposed, never
  cleaned up). Never a global sweep — the suite runs `fullyParallel`.
- **Assertions anchored by id, not by list position or free text** — per the
  home-cards convention (the list sorts by `updated_at` DESC, so a positional
  match is another worker's flow under parallel CI).

### The import contract changed in 1.14 (#2399)

Up to 1.13 the home-page import created the flows **one `POST /api/v1/flows/` per
flow**, each answering `201` with the created flow object. From `1.14.0.dev18`
(langflow-ai/langflow#16120, *"Selected flow imports use one atomic request"*)
the same drop sends **one `POST /api/v1/flows/upload/`** for the whole selection,
answering `201` with an **array** of the created flows. Both are intended
contracts, and the suite still runs against 1.13 patches on demand, so the spec
reads **either**: the ids come from the shared `trackCreatedFlows` tracker, which
collects them from a creation response (one id) and from an upload response (one
id per element). On 2026-11-05 the spec counted `201`s whose body had a top-level
`id`, so the single upload response — an array — counted as nothing: `expected
15, received 0` while the cards were on screen, and every imported flow leaked.

That is why the assertion is on the **number of flows**, not the number of
responses: on 1.14 a collection drop is one response carrying 15 flows, and
"15 responses" would be a test of the transport rather than of the import.

## Tags

`@stable` `@release` `@workspace` `@mainpage`

Promoted to `@stable` in #1808 (measured green in the T1 triage of #1787).
Quarantined on 2026-11-05 (`test.fixme`, `@stable` removed by hand in #2402,
because the mass-failure guard tripped) when 1.14.0.dev18 changed the import
contract, and restored by #2399 once the spec read both contracts.

## Validation criterion

| Step | Criterion |
|---|---|
| Collection drop | number of **flows** the drop created (ids carried by its `POST /api/v1/flows/` or `POST /api/v1/flows/upload/` 201 responses) equals the asset's `flows.length` (15); every one is readable through `GET /api/v1/flows/{id}`; at least one renders a `flow-name-<id>` card |
| Single-flow drop | exactly 1 flow created, by either contract; its `flow-name-<id>` card is visible and shows the per-run random name, and its stored name is exactly that name |
| Both | zero `🚨 Backend Error` (fixture monitor) and every imported id — plus every flow the bootstrap created — deleted in `afterEach`, on both contracts |

## External dependencies

- `tests/assets/flows/collection.json` — 15-flow collection payload; the expected
  count is read from the file, not hardcoded.
- `tests/assets/flows/flow_test_drag_and_drop.json` — single-flow payload whose
  `LANGFLOW TEST` name is replaced per run.
- `helpers/ui/simulate-drag-and-drop.ts` — builds the `DataTransfer` and
  dispatches `mousedown`/`mousemove`/`drop` on the dropzone.
- `helpers/flows/track-created-flows.ts` — collects the created ids from both
  import contracts; one tracker for every flow the page created (the cleanup),
  one attached after the bootstrap for the drop's flows only (the count).
- Home page: `cards-wrapper` (dropzone), `list-card`, `flow-name-<id>`.
- The import request, which depends on the version under test:
  - `POST /api/v1/flows/` — one 201 per imported flow, answering the created flow
    (≤ 1.13; confirmed live on 1.12.0.dev6 and 1.13.1);
  - `POST /api/v1/flows/upload/` — one 201 for the whole selection, answering an
    array of the created flows (≥ 1.14.0.dev18, langflow-ai/langflow#16120).
- `src/frontend/src/hooks/flows/use-upload-flow.ts` and
  `src/frontend/src/controllers/API/queries/flows/use-post-upload-flows.ts` — the
  1.14 import path.

## Last validated

1.14.x (nightly `1.14.0.dev18`, upload contract) and 1.13.x (`1.13.1`, per-flow
contract)
