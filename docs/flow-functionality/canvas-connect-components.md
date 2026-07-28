# Spec: Canvas — Connecting Components

**Test file:** `tests/tests-automations/regression/flow-functionality/canvas-connect-components.spec.ts`

## What this test validates

Covers two `§15.3` checklist items — `Connect two compatible components` and
`Prevent connection between incompatible types` — asserted on the canvas **and**
in the persisted flow, since an edge that renders but never reaches the autosave
`PATCH` is lost on reload.

Four tests on a blank flow:

1. **Compatible pair connects** — Chat Input's `chat message` output (Message)
   into Chat Output's `inputs` target (Message) produces exactly one
   `.react-flow__edge`, and the flow gains exactly one entry in `data.edges`.
2. **The same pair twice does not duplicate** — repeating the connection leaves
   the count at one, in the DOM and in the flow.
3. **A type-incompatible pair does not connect** — Chat Input's `chat message`
   output (Message) into Structured Output's **`language model`** target
   (LanguageModel) produces **no** edge. The same test then connects the very
   same source to the **`input message`** target (Message) **on the same node**
   and asserts the edge appears. Keeping the positive control on the same node,
   changing only the destination handle, is what proves the zero came from the
   input's *type* rather than from a click that missed or a node that was
   unreachable.

   A first attempt used Split Text's `chunks` (DataFrame) → Chat Output
   (Message); measured on `1.12.0.dev8` that pair **does** connect, so Langflow
   coerces DataFrame into Message. `LanguageModel` is a genuinely closed type
   and is the one asserted here.
4. **Target-to-target does not connect** — clicking the same target handle twice
   creates no edge. This is invalid *topology* rather than a type mismatch; it is
   kept as a separate test so the two failure modes stay distinguishable.

Tests 3 and 4 are deliberately separate: the inherited suite had only the
target-to-target case filed under "incompatible connection", which never
exercised type checking at all.

### What this file replaces

`flow-functionality/canvas-incompatible-connection.spec.ts` was merged in (its
three tests map to tests 4, 1 and 2 here) and removed, along with
`flow-functionality/twoEdges.spec.ts`, whose single test only observed that two
edges render — subsumed by the edge-count assertions here and in
`canvas-edge-reconnect.spec.ts`.

The inherited test `should connect ChatInput to TextOutput and verify edge` was
red on `1.12.0.dev8`: **`Text Output` is now `legacy: true`** in the component
catalog and no longer appears in the default sidebar. That is an intentional
product change, so the fixture moved to non-legacy components rather than the
legacy toggle being switched on.

## Tags

`@stable` `@release` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| Blank flow + Chat Input + Chat Output | `.react-flow__node` count is 2, `.react-flow__edge` count is 0 |
| Click the Chat Input source handle, then the Chat Output target handle | `.react-flow__edge` count is 1; polling `GET /api/v1/flows/{id}` converges on `data.edges.length === 1` |
| Repeat the same two clicks | the edge count stays 1 in both layers |
| Chat Input `chat message` (Message) → Structured Output `language model` (LanguageModel) | `.react-flow__edge` count stays 0 |
| …then the same source → Structured Output `input message` (Message), same node | `.react-flow__edge` count becomes 1 (positive control: only the destination handle's type changed) |
| Click the Chat Output target handle twice | `.react-flow__edge` count stays 0 |

Non-criteria (deliberate):

- **No flow execution.** Whether a connected graph *runs* is
  `flow-functionality/run-flow.spec.ts`; the inherited
  "connected ChatInput and ChatOutput opens Playground without errors" test is
  covered there and by the playground specs.
- **Edge identity is not asserted**, only the count and its persistence — the
  edge id format is an implementation detail that has changed upstream.
- **Legacy components are never used as fixtures.** `Text Output` and
  `Retrieval QA` are `legacy: true` on 1.12 and only reachable behind the
  sidebar's legacy toggle, which is a different surface
  (`core-components/legacy-components-toggle-regression.spec.ts`).

## External dependencies

- Handle testids: `handle-chatinput-noshownode-chat message-source`,
  `handle-chatoutput-noshownode-inputs-target`,
  `handle-structuredoutput-shownode-language model-left`,
  `handle-structuredoutput-shownode-input message-left`.
- Sidebar: `add-component-button-chat-input`,
  `add-component-button-chat-output`,
  `add-component-button-structured-output`.
- `helpers/ui/separate-overlapping-nodes.ts` — sidebar-added components land
  stacked, and the top node's subtree intercepts pointer events aimed at the
  handles underneath it (which silently produced the *wrong* connection during
  development).
- `GET /api/v1/flows/{id}` — `data.edges`.

No provider API key and no LLM call. Each test creates one flow via
`setupBlankFlow` and deletes exactly that id in `afterEach` (`deleteFlow`); the
inherited file had no cleanup at all.

## Last validated

1.12.x (nightly `1.12.0.dev8`)
