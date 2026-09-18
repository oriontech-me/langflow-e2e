# Spec: Select-all, copy, delete and paste typed into a node's own text input act on the text, not on the selected node

**Test file:** `tests/tests-automations/regression/flow-functionality/generalBugs-shard-7.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

While a node is selected, the flow editor arms its node shortcuts. `PageComponent`
binds them with `react-hotkeys-hook` — copy (`mod+c`), paste (`mod+v`), cut, delete
(`Backspace` / `Delete`), duplicate, undo/redo — and each handler, when it fires,
calls `preventDefault()` and acts on the **selection**: copy stores the selected
nodes, paste drops a copy of them on the canvas, delete removes them. What keeps
those handlers away from the user's typing is a guard on the event target
(`isWrappedWithClass(e, "noflow" | "nodelete")`) plus the library's own filter for
form fields.

This test types into one of the selected node's own text inputs and asserts every
keystroke reaches **the input**, not the canvas:

1. `Ctrl/Cmd+A` selects the input's text and `Ctrl/Cmd+C` copies it;
2. `Backspace` clears the text — the input reads `""` — instead of deleting the node;
3. `Ctrl/Cmd+V` pastes the text back — the input reads the original value again —
   instead of pasting a node;
4. afterwards the canvas still holds **exactly one** node, the one typed into.

The input is Split Text's `separator`, a core `processing` component rendered with
the same `InputComponent` (`popover-anchor-input-<field>`) as every single-line text
field on a node.

---

## Tags

`@stable` `@release` `@regression` `@components` `@ui-ux`

`@regression` because it pins a general-bugs guard imported from upstream's own
suite; `@components` because it works on a node's field on the canvas; `@ui-ux` is
the functional area the tag table assigns to keyboard shortcuts.

---

## Step by step

1. Create a blank flow over the API (`createFlow`) and open it by id
   (`openFlowById`); the id is deleted in `afterEach`, after leaving the editor with
   `unmountEditorForCleanup`.
2. Add Split Text through the sidebar with `addComponentFromSidebar(page, "split
   text", "add-component-button-split-text")`; assert `title-Split Text` is visible
   and the canvas holds exactly one node.
3. Click the node (`div-generic-node`) so it is **selected** — the state in which the
   node shortcuts are armed.
4. Fill the node's `popover-anchor-input-separator` with a per-run sentinel and
   assert the input reads it; assert the node is still selected
   (`.react-flow__node.selected` count 1).
5. With the focus in that input, press `ControlOrMeta+A`, `ControlOrMeta+C`,
   `Backspace`; assert the input reads `""`.
6. Press `ControlOrMeta+V`; assert the input reads the sentinel again.
7. Assert the canvas holds exactly one node, still `title-Split Text`.

---

## Validation criterion

| Claim | Observable |
|---|---|
| The node shortcuts were armed | exactly one `.react-flow__node.selected` while typing |
| Select-all + Backspace cleared the field, not the node | `popover-anchor-input-separator` value is `""` |
| Paste restored the text, not a node | `popover-anchor-input-separator` value equals the sentinel |
| No node was deleted or pasted | exactly one `.react-flow__node`; `title-Split Text` visible |

The test fails if any of those keystrokes is consumed by the canvas: a select-all
that does not select the text leaves one character behind after `Backspace`; a
`Backspace` that deletes the selected node takes the input with it; a paste the
canvas consumes leaves the field empty (and, when a node copy is held, drops a
second node on the canvas).

---

## External dependencies

- `src/frontend/src/pages/FlowPage/components/PageComponent/index.tsx` — the node
  shortcut handlers (`handleCopy`, `handlePaste`, `handleDelete`, …) and their
  `useHotkeys` bindings
- `src/frontend/src/pages/FlowPage/components/PageComponent/utils/is-wrapped-with-class.tsx`
  — the `noflow` / `nodelete` guard those handlers consult
- `src/frontend/src/components/core/parameterRenderComponent/components/inputComponent/index.tsx`
  — the node's single-line text input and its `popover-anchor-input-<field>` testid
- `src/lfx/src/lfx/components/processing/split_text.py` — Split Text, a core
  component whose `separator` field is shown on the node
- The system clipboard: `playwright.config.ts` grants Chromium clipboard permissions

---

## What this test does not cover

- The node shortcuts themselves acting on a selected node — covered by
  `ui-ux/langflowShortcuts.spec.ts` (Duplicate/Delete/Copy/Paste/Cut/Undo/Redo) and
  `flow-functionality/canvas-copy-paste.spec.ts`.
- Multi-line fields (`textarea`), code editors and list inputs, which render through
  other components.
- `Ctrl/Cmd+X` and `Ctrl/Cmd+Z` typed inside a field.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No provider key; no vendor distribution
  (Split Text is a core component).

---

## Notes

- **Wave 9 T2 triage, issue #1908 — outcome PROMOTE.** Imported from upstream's own
  suite (`src/frontend/tests/extended/regression/`) with no doc and no cleanup;
  measured 3/3 green (`docs/triage/inherited-spec-triage.md`, T2 row for this file).
  DELETE was not available: `ui-ux/langflowShortcuts.spec.ts` and
  `flow-functionality/canvas-copy-paste.spec.ts` press the same keys with the
  **node** focused, and no `@stable` test presses them inside a node's field.
- **Renamed from *"should be able to select all with ctrl + A on advanced
  modal"*.** The advanced modal no longer exists: measured on `1.13.0.dev16`,
  `ControlOrMeta+Shift+A` on a selected node opens no dialog, and the only
  `popover-anchor-input-base_url` on the page is the node's own field on the canvas.
  The inherited test was already exercising a node input under a title that
  described a modal. Upstream renamed its own copy to the title used here
  ("LE-1810: the advanced modal is gone; list inputs stay on the node").
- **Moved from Ollama Embeddings to Split Text.** Ollama Embeddings comes from the
  vendor `ollama` distribution — this file was one of the specs listed in
  `docs/component-distribution-policy.md` inventory (a) — and the component is
  incidental to what the test checks. Split Text renders the same `InputComponent`
  and is core, so the test no longer depends on a packaging decision. Upstream moved
  its copy off Ollama when `lfx-bundles` left the default install (#13869).
- Hardening for the promotion: (a) **3 flows leaked per run** on an empty project
  (`New Flow`, `New Flow (2)`, `Basic Prompting`, through `awaitBootstrapTest` +
  `blank-flow`); it now creates one flow over the API and deletes that id; (b) the
  dead `ControlOrMeta+Shift+A` and the `waitForTimeout(500)` after it are gone;
  (c) the inherited test never checked the canvas, so a keystroke that reached the
  node handlers *and* the field could not fail it — the selected-node precondition
  and the one-node postcondition are new.
