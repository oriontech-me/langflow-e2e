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
6. **Onboarding tooltip suppressed before the first document load**, via
   `seedAssistantDiscovered(page)` in `beforeEach`
   (`tests/helpers/ui/assistant-onboarding.ts`), which writes the
   `langflow-assistant-discovered` localStorage flag upstream reads.

   This **corrects** what item 6 claimed until #1220. It said the spec was protected
   by a `dismissOnboardingIfPresent(page)` call placed after the `blank-flow` click,
   and that protection never held. Measured on 1.12.0.dev15, 3 runs of 3: the probe
   fired **before the canvas-controls bar had even mounted** — i.e. before the timer
   that creates the tooltip had started — so it saw nothing every time. Its
   `isVisible({ timeout: 2000 })` bought no wait either: Playwright ignores that
   option (`locator.isVisible()` returns immediately).

   Dismissing after the load cannot work in principle: upstream snapshots the flag at
   mount (`useState(() => readAssistantDiscovered())` in `CanvasControls.tsx`) and
   arms `ONBOARDING_TOOLTIP_DELAY_MS = 10 000` when it comes back unset, so the
   tooltip appears at **mount + exactly 10 000 ms** and only a pre-load seed disarms
   it. Confirmed rather than inferred: with the flag written 686 ms after the mount
   the tooltip still appeared at 10 766 ms, against 10 713 ms with no write at all.

   The hazard the seed removes is real but narrower than the #684 write-up implies on
   1.12.x: the tooltip is a **282×32 px** opaque element at (378, 669) in a 1280×720
   viewport, `z-index: 40`, `pointer-events: auto` — no body-wide blocking layer, but
   it covers the canvas-controls bar that `adjustScreenView` clicks. Locally this spec
   finishes ~2 s after that mount, well inside the 10 s window; the seed is what
   protects a slower lane, where the tooltip would arrive mid-test.

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
- `src/frontend/src/components/core/canvasControlsComponent/CanvasControls.tsx` — `ONBOARDING_TOOLTIP_DELAY_MS` and the mount-time read of the discovery flag; `assistant-discovery-storage.ts` — the `langflow-assistant-discovered` key the seed writes.

No provider API key needed.

## Last validated

1.12.x (nightly `1.12.0.dev15`)
