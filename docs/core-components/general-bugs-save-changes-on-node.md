# Spec: node field edits survive leaving and re-entering the flow

**Test file:** `tests/tests-automations/regression/core-components/general-bugs-save-changes-on-node.spec.ts`

**Last validated:** Langflow 1.12.x (migrated and validated on `1.12.0.dev10`)

---

## What this test validates

That a value typed into a node's text field is **persisted by the debounced autosave and
rehydrated on the way back in** — not merely held in the canvas store. One edit proves the
field accepts input; this proves the round trip, four times in a row:

1. Fill the node's `input_value` textarea with a fresh random value.
2. **Wait for the value to reach the server** — `GET /api/v1/flows/{id}` polled until the
   node's `template.input_value.value` is that value.
3. Leave the editor for the flows list, asserting the exit verdict is `left`.
4. Re-open the same flow.
5. The textarea still holds that value.

**Step 2 is the oracle, and it exists because without it the oracle was a race.** Two
measurements from the #1290 review, deliberately reported together because they disagree:

- the review's trace of the pre-gate version showed the **exit** persisting the value — the
  debounced `PATCH` fires at fill + ~1015 ms, while `leaveFlowEditor`'s drain
  (`quietMs = 700`, armed immediately because nothing is in flight yet) resolved ~707 ms
  after the fill, so the unsaved-changes blocker rendered and `FlowPage.handleSave` saved the
  flow itself, on 4 of 4 exits;
- re-measuring the same shape here (gate removed) showed the **autosave** winning instead —
  all four exits returned `left`, i.e. no blocker at all.

Both are consistent with a ~300 ms race, and *that* is the defect: which mechanism persisted
the value depended on who won it, so the spec could pass with the debounced autosave broken.
The server gate removes the race — the value is on the server before the exit is even
clicked, which makes anything the exit does irrelevant to the assertion.

The exit verdict is also asserted (`left`), but for a **narrower** property than it first
appears: `classifyEditorExit` polls every 200 ms, so a blocker that renders and clears inside
that window reads as `left` — the gate-removed run above proves it does not catch a flashing
dialog. What it catches is a blocker that **lingers**, which is the flake-relevant shape: that
is the one that burns #1153's 15 s grace and then throws.

The repetition is the point, and it is what the original bug was about: the failure mode is
a *later* edit being dropped after an earlier one succeeded (a stale store, a debounce that
coalesces the wrong way, a PATCH racing the navigation), which a single round trip cannot
see.

**Migrated off a deprecated component (#1290).** This spec used to add **Text Output**,
which upstream marked `legacy: true` and hid from the sidebar, so it failed on 1.12 with a
20 s wait for a testid that never renders — silently, because the spec was not `@stable` and
therefore ran in no scheduled lane. It now uses **Chat Input**, whose `input_value` is the
same `MultilineInput` (`multiline: true`) and therefore renders the *same*
`textarea_str_input_value` the assertions already targeted: the mechanism under test is
unchanged, only the host node is one a user can still add.

---

## Tags

`@stable` `@release` `@components` `@ui-ux`

Promoted to `@stable` as part of #1290. It was `@release @components` before, and `@release`
alone runs in **no** scheduled lane (`daily-stable.yml` selects `@stable`), which is exactly
why the legacy breakage above went unnoticed until an unrelated PR's import graph pulled the
file in. A spec no lane runs cannot catch a regression.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on the nightly, `1.12.0.dev10`).
- No provider credentials — nothing here runs the flow.
- Autosave **on** (the default). The sibling `flow-functionality/auto-save-off.spec.ts`
  covers the opposite configuration (manual save with `auto_save` off) and is a different
  subject; this spec must not be read as covering it.

---

## Step by step

1. `awaitBootstrapTest(page)`, then `blank-flow` → the canvas. The flow's real id is captured
   from its creation response by `trackCreatedFlows` (installed in `beforeEach`), which is
   also what deletes it afterwards.
2. `renameFlow(page, { flowName })` — a random name. Not load-bearing for the re-entry, which
   anchors on the flow **id**; it keeps the flow identifiable in the list while debugging.
3. Add **Chat Input** from the sidebar (`add-component-button-chat-input`); assert
   `title-Chat Input` renders.
4. Click the header to take focus off the node.
5. For each of four random values:
   - fill `textarea_str_input_value` and assert `toHaveValue`;
   - poll `GET /api/v1/flows/{id}` until the persisted `template.input_value.value` is that
     value — the autosave, not the exit, must be what commits it;
   - `leaveFlowEditor(page)` and assert the verdict is **`left`** — a lingering
     unsaved-changes dialog fails here, a flashing one is not detectable (see above).
     `escapeDeadlock` is deliberately **not** set: its recovery is a full page load that
     discards unsaved state, the very thing under test;
   - re-open the flow by **id** through its `list-card-open-button`, never by name-and-first
     (the home list sorts by `updated_at`, so position 0 belongs to whichever worker touched
     a flow last);
   - assert `textarea_str_input_value` holds the value again.

**afterEach** — `trackCreatedFlows.cleanup(request)`, which leaves the editor
(`unmountEditorForCleanup`, #1288) and deletes the captured id.

---

## Validation criterion

| Test | Criterion |
|---|---|
| `any changes on the node must be saved on user interaction` | For **four** consecutive random values: the value reaches the server through the debounced autosave (`GET /api/v1/flows/{id}` → `template.input_value.value`) **before** the editor is left, the exit does not sit on the unsaved-changes blocker, and after re-opening the flow by id the textarea reads back **exactly** that value. A broken autosave fails the first, a lingering #1153 dialog the second, a value lost on rehydration the third. |

---

## External dependencies

- **Sidebar** — `sidebar-search-input`, `add-component-button-chat-input`.
- **Node field** — `textarea_str_input_value`, rendered because `ChatInput.input_value` is a
  `MultilineInput` with `multiline: true` (verified live via `GET /api/v1/all`).
- **Node marker** — `title-Chat Input`.
- **Editor exit** — `helpers/flows/leave-flow-editor.ts` (`icon-ChevronLeft` plus the #1153
  blocker handling).
- **Flows list** — `list-card-open-button` anchored by the flow id via `aria-labelledby`, the
  same pattern `helpers/flows/setup-blank-flow.ts` uses.
- **Helpers** — `awaitBootstrapTest`, `adjustScreenView`, `renameFlow`,
  `trackCreatedFlows`.

---

## What this test does not cover

- **Manual save with autosave off** — `flow-functionality/auto-save-off.spec.ts`.
- **The `PATCH` payload.** The oracle is the persisted STATE (`GET /api/v1/flows/{id}`) plus
  the UI read-back after a real re-entry — never the request body, which would pass on a
  backend that accepted it and dropped it.
- **Other field types** (numeric, dropdown, secret, table). The round trip is asserted for a
  multiline text field only.
- **Chat Input's own behaviour** — it is the host node here, not the subject. Its component
  coverage lives in `core-components/chat-input-output-component-regression.spec.ts`. The
  QA-CHECKLIST bullet is nonetheless filed under §3.1 (Chat Input / Output), following the
  checklist's own convention of filing autosave-persistence bullets under the **host**
  component — §3.2 does it for Prompt Template, §3.3 for API Request.

---

## Notes

- The two `waitForTimeout(500)` sleeps the pre-#1290 version used around the navigation are
  gone: persistence is gated on the server, and the re-entry gates on the card and the
  textarea themselves.
- The setup's one-flow guard prints `flows.failedCreations()`, because a
  `POST /api/v1/flows/` 500 (this instance emits "An internal error occurred while creating
  the flow" under load) would otherwise surface as an empty id list and read as a tracker bug.
- Sibling reference for the fixture-free blank-flow shape:
  `core-components/singleton-components.spec.ts`.
