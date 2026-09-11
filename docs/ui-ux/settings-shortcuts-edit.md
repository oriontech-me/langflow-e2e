# Spec: Settings — Edit Shortcut

**Test file:** `tests/tests-automations/regression/ui-ux/settings-shortcuts-edit.spec.ts`

## What this test validates

Verifies that editing a keyboard shortcut from Settings → Shortcuts persists to the table and that the new combination actually triggers the bound action on the flow canvas.

The test selects the **Duplicate** shortcut (default `Ctrl/Cmd+D`), opens the edit modal via double-click on its row, records a new combination (`Ctrl/Cmd+Alt+U`), clicks **Apply**, and confirms (a) the success toast `"Duplicate shortcut successfully changed"`, (b) the Duplicate row in the table now shows the new combination, and (c) pressing the new combination on the canvas duplicates a previously selected Ollama node (count goes from 1 to 2).

Key implementation detail: the shortcut store (`useShortcutsStore`) writes to `localStorage["langflow-shortcuts"]` and the canvas keybind handler reads from the same store. Both must stay in sync — this test fails if either layer regresses.

## Tags

`@stable` `@release` `@regression` `@settings` `@ui-ux`

`@stable` was added by #1788, on the evidence the inherited-spec triage table
produced (`docs/triage/inherited-spec-triage.md`): 3/3 green over nine
`manual.yml` dispatches at `retries=0`, plus the force-fail run and the
id-scoped cleanup that promotion also requires. No lane selector is present, so
the tag cannot silence the spec (#1010).

## Validation criterion

| Step | Criterion |
|---|---|
| After clicking `Apply` | Toast `"Duplicate shortcut successfully changed"` is visible AND the Duplicate row shows the new combination |
| After pressing the new combination on canvas | `page.getByTestId("title-Ollama").count() === 2` |
| After the `afterEach` Restore | localStorage `langflow-shortcuts` is empty and the Duplicate row shows the default combination |

## External dependencies

- `src/frontend/src/pages/SettingsPage/pages/ShortcutsPage/index.tsx` — `settings_menu_header` testid, `onCellDoubleClicked` handler, page-level Restore button.
- `src/frontend/src/pages/SettingsPage/pages/ShortcutsPage/EditShortcutButton/index.tsx` — literal strings `"Key Combination"`, `"Recording your keyboard"`, `"Apply"`. Toast template `"<name> shortcut successfully changed"` is built in `editCombination()`.
- `src/frontend/src/constants/constants.ts` — `defaultShortcuts` array. If the `"Duplicate"` entry is renamed or removed, row lookup breaks.
- `src/frontend/src/stores/shortcuts.ts` — Zustand store persisting to `localStorage["langflow-shortcuts"]`.
- `src/frontend/src/components/core/appHeaderComponent/components/AccountMenu/index.tsx` — `user-profile-settings` testid (entry point to Settings).

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

## Last validated

1.13.x (nightly `1.13.0.dev8`)
