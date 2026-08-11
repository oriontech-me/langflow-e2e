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
3. `Tab` is pressed until focus lands on the Chat Input **entry row**
   (`input_outputChat Input` — a `role="button"` with the accessible name
   *"Add Chat Input to canvas"*; bounded loop, asserted by `data-testid` and by
   `role`), then `Space` adds the component: the canvas goes to exactly one node
   whose testid matches `/^rf__node-ChatInput-/`.
4. `Tab` walks to the `input_outputChat Output` row and `Enter` adds it: two
   nodes, the new one matching `/^rf__node-ChatOutput-/`.
5. `Escape` with the search focused blurs it (focus leaves
   `sidebar-search-input`).

### The keyboard affordance has moved TWICE — #1124, then #1384

The tab stop that adds a component has changed element twice on the 1.12 line.
Both moves were deliberate a11y work upstream, and both broke this spec's focus
target — so the table below is the contract, and the row this spec targets is
whichever element currently carries `tabIndex={0}` **and** the `Enter`/`Space`
handler:

| | ≤ `1.12.0.dev6` (and the 1.11 line) | `1.12.0.dev10` … `dev21` | ≥ `1.12.0.dev23` (upstream #14250) |
|---|---|---|---|
| Card wrapper `<category>_<name>_draggable` | `tabIndex={0}` + `onKeyDown` | no `tabIndex` — not a tab stop | no `tabIndex` — the hover group only |
| Row div `<category><Display Name>` | (held the "+" as a descendant) | (held the "+" as a descendant) | **`tabIndex={0}` + `role="button"` + `aria-label` + `onKeyDown` (Enter/Space)** — and the "+" is now its SIBLING |
| `add-component-button-<slug>` | `tabIndex={-1}` (skipped) | focusable `<button aria-label="Add <name> to canvas">` | `tabIndex={-1}` — **out of the tab order again** |
| Plus-icon reveal class | `group-focus/draggable` | `group-focus-within/draggable` | `group-focus-within/draggable` |

The second move landed in `langflow-ai/langflow#14250` (commit `46d25720c2`,
merged 2026-08-07, on `release-1.12.0` — the branch the nightly is built from,
and not on upstream `main`), and 2026-08-10 was the first daily to see it. The
failure was the walk running the full 10-press budget and ending on
`datastaxAstra DB Chat Memory` — a *row* testid, because rows are the tab stops
now.

**Keyboard-add is still reachable, so the expectation changed, not the
affordance.** Measured on nightly `1.12.0.dev23` with a scout: from the search
field, 3 `Tab` presses land on `input_outputChat Input`
(`role="button"`, `aria-label="Add Chat Input to canvas"`, `tabindex="0"`), and
`Space` there creates `rf__node-ChatInput-…`. That is why this is recorded as an
**intentional product change**, not a regression: one tab stop per row instead of
two, with the row exposing the accessible name the button used to carry.

The spec therefore walks to the **row** and asserts it is a `role="button"` before
activating it — targeting the row *and* checking the role is what keeps the
assertion about an operable control rather than "some div took focus". Accepting
either the row or the button was rejected for the same reason #1124 rejected it:
it would stop guarding the contract upstream just shipped. Consequence, stated
explicitly: against an image older than `1.12.0.dev23` this spec fails at step 3.

**That failure names itself.** The nightly image is built from a pinned release
branch, so a pin moving to a branch cut from `main` brings an older shape back.
When the walk runs out of presses it reports which older shape it observed — a
`…_draggable` wrapper still carrying `tabindex="0"` (the pre-`dev10`, #1124
shape), or an `add-component-button-*` that is still focusable (the
`dev10`–`dev21`, pre-#14250 shape) — and, if neither, says nothing, so a genuine
keyboard regression still reads as one.

### Chat Input is a singleton — the row stays a tab stop, the "+" does not

`ChatInput` is constrained to one instance per flow
(`evaluatePlacement` → `singleton`, tooltip *"Chat Input already added"*), so once
step 3 adds it the Chat Input entry becomes `disabled` and stops rendering its add
button. Since #14250 the **row keeps `tabIndex={0}` even when disabled** (only
`handleKeyDown` early-returns), so — unlike the `dev10`–`dev21` shape, where the
button's tab stop vanished with it — the disabled Chat Input row still consumes a
press and step 4 reaches `input_outputChat Output` on the 4th press, one more than
step 3 needed. Measured both ways on `1.12.0.dev23`. The walk is bounded by testid,
not by a press count, so this costs the spec nothing; it is documented only so a
reviewer is not surprised, and because it is the fact that makes a fixed-press walk
a bad idea here.

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
| `Tab` walk | focus reaches `input_outputChat Input` within a bounded number of presses (3 on `1.12.0.dev23`, budget 10) and the focused element has `role="button"` |
| `Space` | exactly 1 `.react-flow__node`, testid matching `/^rf__node-ChatInput-/` |
| `Tab` + `Enter` | focus reaches `input_outputChat Output` (4th press — the disabled Chat Input row is still a tab stop); exactly 2 nodes, the new one matching `/^rf__node-ChatOutput-/` |
| `Escape` | `sidebar-search-input` is not focused |

Non-criterion (deliberate): the search text after adding a component (the field
keeps its query on 1.12), `Escape` clearing the query (it does not), and the
`aria-label` **wording** of the focused row (an i18n string — the testid and the
`role` are the contract this spec asserts).

## External dependencies

- `sidebar-search-input`, the `<category>_<name>_draggable` result cards, the
  per-result `<category><Display Name>` rows (the keyboard tab stops), and the
  canvas `.react-flow__node` / `rf__node-<Type>-<hash>` testids.
- The `/` shortcut binding and the row's `onKeyDown` `Space`/`Enter` handler
  (upstream `sidebarDraggableComponent.tsx`). A change to the focus **order** does
  not break the test (it walks by testid); moving the keyboard affordance to
  another element does, by design — that is the contract under test, and it has
  now moved twice (#1124, #1384).
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
  3. Press `Tab` until the `input_outputChat Input` row has focus; read its
     `role`; press `Space`; read the node count and the node testid.
  4. Press `Tab` until the `input_outputChat Output` row has focus; press
     `Enter`; read the node count and the new node's testid.
  5. Focus the search field, press `Escape`, read focus.
- **Validation:** as tabulated above — the criterion is the *identity* of the
  nodes added by the keyboard, not just that the canvas is non-empty.

## Last validated

1.12.x (nightly `1.12.0.dev23`)
