# Spec: Canvas Keyboard Shortcuts

**Test file:** `tests/tests-automations/regression/ui-ux/langflowShortcuts.spec.ts`

## What this test validates

The `§15.10 — Keyboard shortcuts work in editor` checklist item: the canvas
keybind handler actually performs the bound action on the selected node. The node
count on canvas is the concrete observable, so a broken keybind (or a keybind
firing the wrong action) fails immediately, naming the shortcut in the message.

One test walks a single **Chat Output** node through seven documented shortcuts:

| Shortcut | Action | Node count after |
|---|---|---|
| — | node selected; `node-edit-name-description-button` appears | 1 |
| `Ctrl/Cmd+D` | Duplicate | 2 |
| `Backspace` | Delete (the duplicate) | 1 |
| `Ctrl/Cmd+C` then `Ctrl/Cmd+V` | Copy + Paste | 2 |
| `Backspace` | Delete (the pasted node) | 1 |
| `Ctrl/Cmd+X` | Cut | 0 |
| `Ctrl/Cmd+V` | Paste | 1 |
| `Backspace` | Delete | 0 |
| `Ctrl/Cmd+Z` | Undo | 1 |
| `Ctrl/Cmd+Y` | Redo | 0 |

## Changes this validation pass made to the inherited spec

1. **1.12 testid drift (this is why it was failing).** After clicking the node
   title the spec asserted `panel-description`, which **no longer exists** in the
   1.12 nightly bundle (0 occurrences; grepped inside
   `langflowai/langflow-nightly:latest`, `1.12.0.dev5`). The current testid for
   the same affordance is `node-edit-name-description-button` (scouted live).
   Retargeted, not dropped.
2. **Component swapped from Ollama to Chat Output.** Ollama ships as a
   **langchain extra** the nightly image has already dropped once (#907 /
   LE-1987 — the component then disappears from the sidebar), so a shortcut test
   built on it goes red for a provider-packaging reason. Chat Output is core.
   **Chat Input is deliberately NOT used**: its node body carries a text field
   that holds keyboard focus right after the node is added, and a focused field
   swallows `mod+…` keydowns before the canvas hotkey handler sees them (hotkey
   libraries ignore key events originating in inputs). A Chat-Input-based version
   of this spec produced silent Duplicate/Copy no-ops that look exactly like a
   product regression — they are not. Chat Input's body click also focuses the
   field instead of selecting the node.
3. **Selection is gated, not assumed.** Every canvas shortcut acts on the
   selected node, so `selectNode()` clicks `generic-node-title-arrangement` and
   asserts `.react-flow__node.selected` has exactly one match before any
   keypress. Without the gate, an unselected canvas turns every shortcut into a
   no-op and the failure message blames the keybind.
4. **Assertions are nameable and wait properly.** `if (count != n) expect(false).toBeTruthy()`
   became `expect(nodes, "<shortcut> should …").toHaveCount(n)` — auto-retrying
   (the canvas re-renders asynchronously after a keypress) and it names the
   shortcut that broke.
5. **Flow cleanup.** Clicking `blank-flow` creates a real flow
   (`POST /api/v1/flows` → 201); the spec now tracks the id from the response and
   deletes it id-scoped in `afterEach`. The inherited version leaked one
   `New Flow` per run — orphans found on the shared instance were purged while
   validating this issue.
6. **Onboarding tooltip dismissed** via the existing
   `dismissOnboardingIfPresent(page)` helper (its overlay intercepts canvas
   clicks; same reason the flow-lock specs call it).

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Before every keypress | `.react-flow__node.selected` has exactly 1 match |
| Node selected | `node-edit-name-description-button` is visible |
| After each shortcut | `page.getByTestId("title-Chat Output")` has the exact expected count from the table above (`toHaveCount`, 10s) |
| `afterEach` | the flow created by `blank-flow` is deleted by id; `GET /api/v1/flows/` shows no leftover `New Flow` |

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/index.tsx` — `generic-node-title-arrangement`, `title-<display_name>`, `node-edit-name-description-button` testids.
- `src/frontend/src/constants/constants.ts` — `defaultShortcuts` entries `Duplicate` (`mod+d`), `Copy` (`mod+c`), `Paste` (`mod+v`), `Cut` (`mod+x`), `Delete` (`backspace`), `Undo` (`mod+z`), `Redo` (`mod+y`).
- `src/frontend/src/stores/shortcuts.ts` — the store the canvas keybind handler reads.
- Core `Chat Output` component (`add-component-button-chat-output`) — bundled in Langflow core, no provider extra required.

No provider API key needed.

## Last validated

1.12.x (nightly `1.12.0.dev6`)
