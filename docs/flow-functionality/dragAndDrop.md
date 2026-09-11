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
   creates **one flow per entry in the file**: the spec counts the
   `POST /api/v1/flows/` 201 responses the drop fires and requires exactly as many
   as the asset declares, then asserts the imported flows are on screen anchored
   by their own ids (`flow-name-<id>` inside `list-card`).
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
  **bootstrap** listener is installed *before* `awaitBootstrapTest` and feeds its
  own array, which `afterEach` deletes and no assertion ever counts; the
  **import** listener still goes up afterwards and still feeds the array the count
  assertion reads. Never a global sweep — the suite runs `fullyParallel`.
- **Assertions anchored by id, not by list position or free text** — per the
  home-cards convention (the list sorts by `updated_at` DESC, so a positional
  match is another worker's flow under parallel CI).

## Tags

`@release` `@workspace` `@mainpage`

**No `@stable` (deliberate).** This spec covers the `§10.1 Upload flow by
drag-and-drop to folder` bullet, whose promotion belongs to its own wave item —
this change only removes the dead assertions and the flow leak, so promoting it
here would flip a checklist bullet outside the scope of #938. The tests are run
clean and force-failed as part of that change.

## Validation criterion

| Step | Criterion |
|---|---|
| Collection drop | number of `POST /api/v1/flows/` 201 responses equals the asset's `flows.length` (15); the first imported id renders a `flow-name-<id>` card |
| Single-flow drop | exactly 1 `POST /api/v1/flows/` 201; its `flow-name-<id>` card is visible and shows the per-run random name |
| Both | zero `🚨 Backend Error` (fixture monitor) and every imported id deleted in `afterEach` |

## External dependencies

- `tests/assets/flows/collection.json` — 15-flow collection payload; the expected
  count is read from the file, not hardcoded.
- `tests/assets/flows/flow_test_drag_and_drop.json` — single-flow payload whose
  `LANGFLOW TEST` name is replaced per run.
- `helpers/ui/simulate-drag-and-drop.ts` — builds the `DataTransfer` and
  dispatches `mousedown`/`mousemove`/`drop` on the dropzone.
- Home page: `cards-wrapper` (dropzone), `list-card`, `flow-name-<id>`.
- `POST /api/v1/flows/` — one 201 per imported flow (confirmed live on
  1.12.0.dev6); this is the signal both the count assertion and the cleanup use.

## Last validated

1.13.x (nightly `1.13.0.dev8`)
