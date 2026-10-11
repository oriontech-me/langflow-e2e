# Spec: Settings — Edit Shortcut

**Test file:** `tests/tests-automations/regression/ui-ux/settings-shortcuts-edit.spec.ts`

## What this test validates

Verifies that editing a keyboard shortcut from Settings → Shortcuts persists to the table and that the new combination actually triggers the bound action on the flow canvas.

The test selects the **Duplicate** shortcut (default `Ctrl/Cmd+D`), opens the edit modal via double-click on its row, records a new combination (`Ctrl/Cmd+Alt+U`), clicks **Apply**, and confirms (a) the success toast `"Duplicate shortcut successfully changed"`, (b) the Duplicate row in the table now shows the new combination, and (c) pressing the new combination on the canvas duplicates a previously selected Ollama node (count goes from 1 to 2).

The Ollama node is put on the canvas by **dragging** its sidebar entry, and that drag is a precondition of (c), not the behavior under test. It is issued only once the entry reports `draggable="true"` — the editor's own signal that it will accept the gesture — and a drag that still lands no node fails under a message naming the add, so a broken add can never read as a broken shortcut (#2235).

Key implementation detail: the shortcut store (`useShortcutsStore`) writes to `localStorage["langflow-shortcuts"]` and the canvas keybind handler reads from the same store. Both must stay in sync — this test fails if either layer regresses.

## Tags

`@stable` `@release` `@regression` `@settings` `@ui-ux`

`@stable` was added by #1788, on the evidence the inherited-spec triage table
produced (`docs/triage/inherited-spec-triage.md`): 3/3 green over nine
`manual.yml` dispatches at `retries=0`, plus the force-fail run and the
id-scoped cleanup that promotion also requires. No lane selector is present, so
the tag cannot silence the spec (#1010).

The VM daily auto-removed it on 2026-10-09 (`6311f4d05`, run `20261009T080017Z`,
`1.13.0.dev37`) after the Ollama drop landed no node on all 3 attempts; #2235
restores it together with the readiness wait described below.

## Validation criterion

| Step | Criterion |
|---|---|
| After clicking `Apply` | Toast `"Duplicate shortcut successfully changed"` is visible AND the Duplicate row shows the new combination |
| Before dragging Ollama onto the blank canvas | The `ollamaOllama` sidebar entry reports `draggable="true"` |
| After the drag | Exactly one `title-Ollama` node is on the canvas; a drag that lands none fails naming the add, not the shortcut |
| After pressing the new combination on canvas | `page.getByTestId("title-Ollama").count() === 2` |
| After the `afterEach` Restore | localStorage `langflow-shortcuts` is empty and the Duplicate row shows the default combination |

## External dependencies

- `src/frontend/src/pages/SettingsPage/pages/ShortcutsPage/index.tsx` — `settings_menu_header` testid, `onCellDoubleClicked` handler, page-level Restore button.
- `src/frontend/src/pages/SettingsPage/pages/ShortcutsPage/EditShortcutButton/index.tsx` — literal strings `"Key Combination"`, `"Recording your keyboard"`, `"Apply"`. Toast template `"<name> shortcut successfully changed"` is built in `editCombination()`.
- `src/frontend/src/constants/constants.ts` — `defaultShortcuts` array. If the `"Duplicate"` entry is renamed or removed, row lookup breaks.
- `src/frontend/src/stores/shortcuts.ts` — Zustand store persisting to `localStorage["langflow-shortcuts"]`.
- `src/frontend/src/components/core/appHeaderComponent/components/AccountMenu/index.tsx` — `user-profile-settings` testid (entry point to Settings).
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx` — renders the sidebar entry `draggable={!error && !isUnavailable}`, with `isUnavailable` folding in the flow's read-only verdict. The readiness wait keys on that attribute.
- `src/frontend/src/contexts/permissionsContext.tsx` — `useIsFlowReadOnly` fails closed while `POST /api/v1/authz/me/permissions` resolves, which is the window a drag must not be issued into.

## Flow cleanup

The test creates flows on two paths and used to delete neither. Measured on
2026-09-10 against a purged instance (0 user flows, default project empty), one
run left **3** behind: `New Flow` and `Basic Prompting` — created by
`awaitBootstrapTest` → `addFlowToTestOnEmptyLangflow` when the default project is
empty — plus `New Flow (2)`, the blank flow the test itself opens to reach the
canvas.

`trackCreatedFlows(page)` now captures every `POST /api/v1/flows/` → `201` the
page performs and `afterEach` deletes exactly those ids. The pre-existing
`afterEach` still restores the shortcut table (UI **Restore**, with a
`localStorage` fallback); the two teardowns are independent and both run.

Reading this off a source grep does not work: the two bootstrap flows are created
by a helper, so a file that never spells `deleteFlow` and a file that leaks are not
the same set. The audit is purge → run one spec → diff the flow list.

## Sidebar drop readiness (#2235)

On the 2026-10-09 VM daily (`1.13.0.dev37`) the bare `dragTo` landed no node on
3 of 3 attempts. The retry trace settles what happened, and it is not a product
regression:

- At the instant of the drag, the `ollamaOllama` entry was `draggable="false"`
  with `cursor-not-allowed` and its icon still a loading skeleton — the editor
  was refusing the gesture, so Chromium started no native drag session and no
  node could land.
- Ten seconds later, in the failure snapshot, the same entry was
  `draggable="true"`. The refusal was transient; nothing was broken.
- The flow page's `POST /api/v1/authz/me/permissions` had already answered
  ~1 s before the drag, on a page where the search click alone took 2.2 s and
  the filtered entry 1.9 s to render. So the window outlived its network cause
  on a saturated host — which is why the wait keys on the entry's own
  `draggable` attribute rather than on the permissions response.
- The sidebar, permissions and flow-page frontend did not change between
  `1.13.0.dev36` and `1.13.0.dev37`; the window has always existed, and this
  spec dragged into it bare — without the readiness wait #2197 added for the
  same gesture in `generalBugs-shard-3.spec.ts`.

The drag is therefore issued only after `draggable="true"`. A drag the editor
accepted that still lands no node is a real defect, and fails under a message
naming the add rather than as a missing `title-Ollama`.

## Last validated

1.13.x (nightly `1.13.0.dev37`)
