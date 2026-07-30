# Spec: Component Sidebar — Keyboard Search and Keyboard Add

**Test file:** `tests/tests-automations/regression/ui-ux/keyboardComponentSearch.spec.ts`

## What this test validates

Driving the component sidebar entirely from the keyboard — the
`§15.1 Component Sidebar` item *Keyboard search (keyboard shortcut)*: the `/`
shortcut focuses the search field from the canvas, typing filters the tree,
`Tab` walks into the results, and `Space` / `Enter` add the focused component to
the canvas. `Escape` blurs the search field.

One journey test (the shortcut chain only means something end to end):

1. `/` pressed with the canvas focused moves focus to `sidebar-search-input`
   without typing the character into it (the field stays empty).
2. Typing `chat` filters the tree — the `input_output_chat input_draggable` card
   appears and `models_and_agentsPrompt Template` does not.
3. `Tab` is pressed until focus lands on the Chat Input entry's
   **"Add Chat Input to canvas"** button (`add-component-button-chat-input`,
   bounded loop, asserted by `data-testid`), then `Space` adds the component: the
   canvas goes to exactly one node whose testid matches `/^rf__node-ChatInput-/`.
4. `Tab` walks to `add-component-button-chat-output` and `Enter` adds it: two
   nodes, the new one matching `/^rf__node-ChatOutput-/`.
5. `Escape` with the search focused blurs it (focus leaves
   `sidebar-search-input`).

### The keyboard affordance moved (upstream, 1.12 line) — #1124

Until nightly `1.12.0.dev6` the sidebar result **card wrapper**
(`<category>_<name>_draggable`) carried `tabIndex={0}` plus an `onKeyDown`
handler for `Enter`/`Space`, so the card itself was the tab stop and the `+`
button was explicitly removed from the tab order (`tabIndex={-1}`).

On the `release-1.12.0` line — the branch `langflowai/langflow-nightly:latest`
is built from, and therefore what `daily-stable.yml` runs — that anti-pattern was
replaced by a real control:

| | ≤ `1.12.0.dev6` (and the 1.11 line) | ≥ `1.12.0.dev10` |
|---|---|---|
| Card wrapper `…_draggable` | `tabIndex={0}` + `onKeyDown` (Enter/Space) | no `tabIndex` — **not a tab stop** |
| `add-component-button-<slug>` | `tabIndex={-1}` (skipped) | focusable `<button aria-label="Add <name> to canvas">` |
| Plus-icon reveal class | `group-focus/draggable` | `group-focus-within/draggable` |

The user-facing journey is unchanged (and more accessible: a native button with
an accessible name instead of a `div` emulating one), so this is an intentional
product change, not a regression. What broke was the test's focus target: the
old target is no longer reachable by `Tab`, and the walk ran past it into the
bundle sections — the recorded daily failure ended on
`add-component-button-valkey-chat-memory`, the 10th tab stop.

The spec therefore walks to the **add button**, which is also the handle the rest
of this suite already uses for sidebar adds
(`tests/helpers/flows/add-component-from-sidebar.ts`). Targeting the button (and
not "either the button or the old wrapper") is deliberate: accepting both would
stop guarding the a11y contract upstream just shipped. Consequence, stated
explicitly: against a **1.11.x** image this spec fails at step 3 — expected, not
a regression, until the change reaches a release line.

### Chat Input is a singleton — the second walk is shorter

`ChatInput` is constrained to one instance per flow
(`evaluatePlacement` → `singleton`, tooltip *"Chat Input already added"*), so
once step 3 adds it the Chat Input entry becomes `disabled` and stops rendering
its add button. Its tab stop disappears, which is why step 4 reaches
`add-component-button-chat-output` in the same number of presses that step 3
needed for Chat Input. The walk is bounded by testid, not by a press count, so
this costs the spec nothing — it is documented only so a reviewer is not
surprised by the asymmetry.

### The `/` press is retried, bounded — #1124 second symptom

The same daily recorded one attempt where `/` did not move focus into the search
field at all (attempts 2–3 of the same run focused it fine). It does not
reproduce locally: 3/3 fresh flow loads on `1.12.0.dev10` focused the field, and
the binding is intact (`useHotkeys(searchComponentsSidebar /* "/" */)` in
`flowSidebarComponent`, whose only bail-out is `isWrappedWithClass(e, "noflow")`).
Read as a race between the canvas click and the keypress under CI load, the step
presses `/` and re-presses only while the field is **not** focused, bounded to
20 s. A genuinely unbound shortcut still fails the test (0 of N presses land);
the retry only absorbs a lost first keypress, and never presses while the field
already has focus (which would type `/` into it and break the empty-value
assertion).

### What changed from the inherited version

- **Tabbing is targeted, not blind.** The previous version pressed `Tab` three
  times and hoped: a single extra focusable element upstream would have silently
  moved `Space` onto a different control while the test still passed (the
  node-count assertion did not say *which* component was added). The rewrite
  walks until the expected testid holds focus and asserts the **type** of each
  added node.
- **Flow cleanup added.** The old version opened a blank flow through the UI after
  `awaitBootstrapTest` and deleted nothing, leaking one flow per run.
- **Escape's real behavior is documented, not assumed:** on 1.12 `Escape` blurs
  the field but does **not** clear its text; the test asserts the blur only.

## Tags

`@stable` `@workspace` `@ui-ux`

## Validation criterion

| Step | Criterion |
|---|---|
| `/` from the canvas | `sidebar-search-input` is focused AND its value is still `""` |
| Type `chat` | `input_output_chat input_draggable` visible, `models_and_agentsPrompt Template` hidden |
| `Tab` walk | focus reaches `add-component-button-chat-input` within a bounded number of presses (3 on `1.12.0.dev10`, budget 10) |
| `Space` | exactly 1 `.react-flow__node`, testid matching `/^rf__node-ChatInput-/` |
| `Tab` + `Enter` | focus reaches `add-component-button-chat-output`; exactly 2 nodes, the new one matching `/^rf__node-ChatOutput-/` |
| `Escape` | `sidebar-search-input` is not focused |

Non-criterion (deliberate): the search text after adding a component (the field
keeps its query on 1.12), `Escape` clearing the query (it does not), and the
`aria-label` wording of the add button (an i18n string — the testid is the
contract this spec asserts).

## External dependencies

- `sidebar-search-input`, the `<category>_<name>_draggable` result cards, the
  per-result `add-component-button-<slug>` buttons, and the canvas
  `.react-flow__node` / `rf__node-<Type>-<hash>` testids.
- The `/` shortcut binding and the sidebar add button's native `Space`/`Enter`
  activation (upstream `sidebarDraggableComponent.tsx`). A change to the focus
  **order** does not break the test (it walks by testid); moving the keyboard
  affordance to another element does, by design — that is the contract under
  test.
- `POST /api/v1/flows/` — the empty flow the editor opens on.

No provider API key, no LLM, no flow build.

Flow cleanup: the flow is created via the API and deleted by id in `afterEach`.

## Scenarios

### 15.1.5 Keyboard-only component search and add [-]

- **File:** `tests/tests-automations/regression/ui-ux/keyboardComponentSearch.spec.ts`
- **Objective:** prove the sidebar is operable from the keyboard: shortcut →
  filter → focus → add.
- **Precondition:** empty flow created via API; editor open; canvas focused.
- **Step by step:**
  1. Click the canvas pane, press `/` (bounded retry), read focus and the field
     value.
  2. Type `chat`; read the matching and non-matching cards.
  3. Press `Tab` until `add-component-button-chat-input` has focus; press
     `Space`; read the node count and the node testid.
  4. Press `Tab` until `add-component-button-chat-output` has focus; press
     `Enter`; read the node count and the new node's testid.
  5. Focus the search field, press `Escape`, read focus.
- **Validation:** as tabulated above — the criterion is the *identity* of the
  nodes added by the keyboard, not just that the canvas is non-empty.

## Last validated

1.12.x (nightly `1.12.0.dev10`)
