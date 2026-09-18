# Spec: Output Inspection keyboard shortcut (`o`)

**Test file:** `tests/tests-automations/regression/core-functionality/llm-agents/chatInputOutputUser-shard-1.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

The **Output Inspection** shortcut (`o`, the `outputInspection` entry of Langflow's
default shortcuts): pressing it opens the output-inspection dialog of the
**selected, built** node — the same dialog the node's `output-inspection-*` button
opens — and it acts on the selected node only.

On a Chat Input → Chat Output flow, after one run that produced a known value:

1. With **no node selected**, `o` opens no output dialog.
2. With **Chat Input** selected, `o` opens exactly one output dialog,
   `<Chat Input node id>-message-output-modal`, and the dialog shows the value the
   run produced.
3. With **Chat Output** selected, `o` opens exactly one output dialog,
   `<Chat Output node id>-message-output-modal`, showing the same value (Chat Output
   echoes its input).
4. Each dialog closes with its own Close button.

**Why two nodes.** The product decides which output `o` opens by two different
rules (`outputShortcutOpenable` in `NodeOutputfield`): for a node with outgoing
edges, the output that feeds its first edge; for a node with none, the first output
the run logged. Chat Input (it feeds the edge) exercises the first rule and Chat
Output (it feeds nothing) the second, so one flow covers both branches.

**Why the dialog is identified by node id.** The dialog's testid is built from the
node id and the output name (`${nodeId}-${outputName}-output-modal`). Asserting that
id — and that it is the only output dialog open — is what distinguishes "the shortcut
opened the selected node's output" from "some output dialog is open".

---

## Tags

`@stable` `@release` `@components` `@ui-ux`

`@ui-ux` is the functional tag for keyboard shortcuts. The previous array carried
`@agents`; it was dropped because the test runs no model (see Notes) — keeping it
would make `scripts/provider-dependent-specs.mjs` treat an LLM-free spec as
provider-dependent and couple it to key health on the PR lane.

---

## Step by step

1. Create a Chat Input → Chat Output flow over the API with
   `createRunnableChatFlowViaApi` (the committed fixture
   `tests/assets/flows/chat-io-ok-trace-fixture.json`: the two nodes expanded and
   already connected). Its id is deleted id-scoped in `afterEach`, after leaving the
   editor with `unmountEditorForCleanup`.
2. Open `/flow/<id>` and wait for `title-Chat Input` and `title-Chat Output`. Clear
   the canvas' bottom overlay slot once, at flow open, with
   `clearCanvasBottomOverlay(page, { allowAlreadyClear: true })` — the fixture's
   nodes carry an old `lf_version`, so the nightly may raise the "Flow needs review"
   banner there (the helper's documented *at flow open* shape).
3. Resolve both node ids from the canvas — `.react-flow__node` filtered by its
   `title-<Display Name>` testid, pinned with `toHaveCount(1)`, read from `data-id`.
4. Fill Chat Input's `textarea_str_input_value` with a unique sentinel.
5. Run the flow from `button_run_chat output`; wait for `node_duration_chat input`
   and `node_duration_chat output` (the duration badge renders only on a successful
   build).
6. Click an empty spot of the pane and assert no node is selected; press `o`;
   assert no `[data-testid$="-output-modal"]` is open.
7. Click `title-Chat Input` and assert it is the one selected node; press `o`; assert
   exactly one output dialog is open and it is `<Chat Input id>-message-output-modal`;
   assert its `textarea` holds the sentinel; close it with `btn-close-modal` and
   assert it is gone.
8. Repeat step 7 for `title-Chat Output` → `<Chat Output id>-message-output-modal`.

---

## Validation criterion

| Situation | Criterion |
|---|---|
| No node selected | `o` leaves zero `*-output-modal` dialogs open |
| Chat Input selected (node with an outgoing edge) | exactly one output dialog, `<Chat Input id>-message-output-modal`, whose `textarea` = the sentinel |
| Chat Output selected (node with no outgoing edge) | exactly one output dialog, `<Chat Output id>-message-output-modal`, whose `textarea` = the sentinel |
| Close | the dialog leaves the DOM |

The absence in step 6 is asserted twice, and the second read is the decisive one: a
dialog opened by that key press would still be open in step 7 (output dialogs close
only on Close), so step 7's "exactly one, and it is this node's" cannot be satisfied —
the click on the node title would even be blocked by the dialog's overlay. The
immediate read in step 6 only makes the failure name its cause earlier.

The test fails if the shortcut stops being bound to `o` by default; if it opens for
an unselected node; if it opens another node's or another output's dialog; if the
dialog shows anything but the value the run produced; or if the dialog cannot be
closed.

---

## External dependencies

- `src/frontend/src/CustomNodes/GenericNode/components/NodeOutputfield/index.tsx` —
  binds the shortcut (`useHotkeys(outputInspection, handleOpenOutputModal)`), owns
  `outputShortcutOpenable` (the `selected` requirement and the first-edge / first
  logged output rules) and renders `OutputModal` only in its expanded branch — a
  minimized node returns just its handle, so the shortcut has no dialog to open there
- `src/frontend/src/stores/shortcuts.ts` — the default binding, `outputInspection: "o"`
- `src/frontend/src/CustomNodes/GenericNode/components/outputModal/index.tsx` — the
  dialog's `${nodeId}-${outputName}-output-modal` testid and its Close button
- `src/frontend/src/pages/FlowPage/components/UpdateAllComponents/index.tsx` and
  `src/frontend/src/pages/FlowPage/components/flowBuildingComponent/index.tsx` — the
  two occupants of the canvas' bottom slot that `clearCanvasBottomOverlay` mirrors
- `tests/assets/flows/chat-io-ok-trace-fixture.json`, through
  `tests/helpers/flows/create-runnable-chat-flow-via-api.ts`
- No model provider and no network egress: Chat Input → Chat Output is a local
  passthrough

---

## What this test does not cover

- Rebinding the shortcut — covered for Duplicate by `ui-ux/settings-shortcuts-edit.spec.ts`.
- A multi-output node whose first edge leaves a non-first output (the ordering by
  output index inside the first-edge rule).
- Minimized nodes (see External dependencies — the dialog is not rendered for them).
- The output-inspection **button** — covered by
  `core-functionality/playground/output-modal-copy-button.spec.ts`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No provider key and no `collect-models`
  run are needed.

---

## Notes

- **Wave 9 T2 triage, issue #1907 — outcome PROMOTE.** Imported with the suite on
  2026-03-11 with no doc and no cleanup; measured 3/3 green on both tests
  (`docs/triage/inherited-spec-triage.md`, T2 rows for this file). That green
  measured nothing on the surface the titles name:
  - *"user must be able to see output inspection"* built Basic Prompting with a real
    OpenAI completion, clicked the third `icon-TextSearchIcon`, then called
    `getByText("Sender" | "Type" | "User").isVisible()` three times and discarded
    the booleans. It asserted only that the build finished and a third inspection
    icon existed. **Consolidated (deleted)** in favour of the `@stable`
    `core-functionality/playground/output-modal-copy-button.spec.ts` → *"copy
    button copies Chat Input output and toggles Check icon"*, which builds a
    component, opens its output inspection and asserts the "Component Output"
    dialog and its copy action. Dropping it also drops one real completion per
    daily run that bought no assertion.
  - *"user must be able to see output inspection using 'o' shortcut"* pressed `o`
    twice, but each press was followed by `page.getByText(…)` with no `expect` — a
    locator that is never evaluated — and it ended on
    `expect(count).toBeGreaterThanOrEqual(0)`, which holds for any count. It also
    made the backend fetch `https://www.example.com` four times through the URL
    component. **Rewritten** from the shortcut's contract on an offline flow, keeping
    its title and its subject; the tags lost `@agents` with the model.
- Flow leak before the rewrite, read by diffing `GET /api/v1/flows/` around one run
  on an empty project (1.13.0.dev16): **4 flows** — `New Flow`, `New Flow (2)`,
  `Basic Prompting`, `Basic Prompting (1)`. The file had no cleanup at all; part of
  the count is `awaitBootstrapTest` seeding an empty project, which every file that
  calls it and deletes nothing inherits.
- The previous header comment explained why this file did not call
  `clearCanvasBottomOverlay` (#1675): neither test seeded a stored flow, so the
  "Flow needs review" banner could not mount, and it named seeding a fixture as the
  one change that would bring it back. This version seeds one, so it clears the slot
  at flow open with `allowAlreadyClear: true`, before any node is built — exactly
  the shape the helper documents for seeded flows.
- The file keeps its inherited name and folder on purpose: the triage table, the
  frozen backlog baseline and the ownership report all key on this path.
