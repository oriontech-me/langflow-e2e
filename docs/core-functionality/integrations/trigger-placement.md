# Triggers on the canvas — one per flow: the palette, paste, duplicate and grouping

**File:** `tests/tests-automations/regression/core-functionality/integrations/trigger-placement.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev27`)

Owning issue: #2450 (the 1.14 triggers and connectors batch), which also takes over #2336's directive 3
(the placement rule in the palette and on paste, and the core *Triggers* category). The server half of
the rule is `docs/api/triggers/api-triggers-one-per-flow.md`. Which provider triggers sit in which
*Bundles* group is `connector-node-picker.spec.ts`'s; this file only asserts that they are blocked like
any other trigger once the flow has one.

---

## What this test validates *(required)*

The canvas enforces one trigger per flow through a single placement rule (upstream #15940): every
trigger answers to the placement key `@trigger` besides its own type, and `@trigger` is a singleton. The
sidebar disables what cannot be placed, and paste drops it. The contract under test:

1. **Triggers are told apart in the palette.** The core *Triggers* category holds *Schedule* and
   *Inbound Webhook*, and every trigger row carries the trigger mark (upstream #16278) while an action
   row does not. No row carries a drag grip.
2. **With a trigger on the canvas, every other trigger is blocked, and says why.** Core and provider
   triggers alike lose their add button and cannot be dragged or added from the keyboard, and hovering
   one explains *"This flow already has a trigger. A flow has one trigger."*. The legacy *Webhook*
   component is not a trigger and stays addable. Deleting the trigger unblocks them all.
3. **Paste and duplicate leave the trigger out, and say so.** Pasting a copied trigger, pasting a
   selection that holds a trigger and another node, and duplicating the trigger all add no trigger, show
   *"A flow has one trigger, so the pasted trigger was left out."*, and keep the rest of the selection.
4. **A trigger inside a group is still a trigger** — known defect, pinned (see *Known defect*).

### Measured on `1.14.0.dev27`

- **Sidebar.** `disclosure-triggers` (*Triggers*) holds `triggers_schedule_draggable` and
  `triggers_inbound webhook_draggable`. A trigger row contains `sidebar-trigger-icon`; the Chat Output
  row does not. No `_draggable` row contains `icon-GripVertical`.
- **A blocked row.** With a Schedule on the canvas, `triggers_inbound webhook_draggable`,
  `triggers_schedule_draggable` and provider rows such as `google_gmail: on message_draggable` have no
  `add-component-button-*` inside, carry `cursor-not-allowed`, and their inner button
  (`role=button`, *"Add Inbound Webhook to canvas"*) is `draggable="false"`. Hovering shows a Radix
  tooltip with the sentence above. A drag of the row onto the pane, and `Enter` on its focused button,
  both leave one node on the canvas. `input_output_webhook_draggable` (the legacy *Webhook*) keeps its
  add button. Deleting the Schedule brings the add buttons back.
- **Paste and duplicate.** The notice renders in `role=status`. With a Schedule and a Chat Output on the
  canvas, copying the Schedule and pasting adds nothing; box-selecting both and pasting adds one Chat
  Output and no Schedule; `ControlOrMeta+d` on the Schedule adds nothing. All three show the notice.
- **Two canvas traps, both paid during scouting.** Nodes added one after the other from the sidebar
  land on the same spot, so the second covers the first one's title and a click on it never settles —
  every flow here is therefore created through the API with `buildCatalogFlow`, which spaces the nodes
  (`translate(80px, 80px)`, `translate(540px, 80px)`). And a box selection only commits after
  `adjustScreenView` (#2182's auto-pan trap): without it zero nodes end up selected.
- **Grouping a trigger** — see *Known defect*.

### Known defect — grouping a trigger hides it from the one-trigger rule and stops it (LE-3453)

Reproduced on `1.14.0.dev27`, three runs out of three:

1. A Schedule wired to a Parser (`trigger_event` → `input_data`) is enabled through the API
   (`state: "active"`).
2. Box-selecting both shows `group-node`. Grouping is allowed: no grouping rule mentions triggers
   (`validateSelection` refuses only input/output nodes, unconnected nodes and more than one free
   output).
3. The trigger row turns `paused`, `reason: "node_removed"`, `last_error: "trigger node removed from the
   flow"`. The schedule has stopped, and nothing on the canvas says so: the Group node shows no trigger
   badge and no notice appears.
4. The palette unblocks every trigger, because the placement rule counts top-level nodes only. Adding an
   Inbound Webhook saves (`PATCH` `200`), because `validate_single_trigger_per_flow` also counts
   top-level nodes only. The flow is stored as `[GroupNode(Schedule, Parser), InboundWebhookTrigger]`:
   two triggers, one of them dead.
5. Ungrouping puts both triggers at the top level (the Schedule under a **new** node id), and the next
   autosave is refused `422` with *"Failed to save flow"* and the rule's message. A reload brings the
   grouped canvas back.

Whichever fix upstream picks — refusing to group a trigger, or counting a grouped trigger — the same
two things must hold, so test 4 asserts exactly those and nothing about how the fix is built: after the
grouping attempt, the trigger is still `active` (not `node_removed`), and the palette still blocks a
second trigger. It is pinned with `test.fail()` against the upstream ticket **[LE-3453](https://datastax.jira.com/browse/LE-3453)**,
and flips red the day the fix ships, which is the signal to drop the pin.

### What is not covered here, and why

- The server's refusal on each write path, and import atomicity — the API spec doc.
- Which provider trigger sits in which *Bundles* group — `connector-node-picker.spec.ts`.
- A trigger nested two groups deep — the same code path as one level (both counters read top-level
  nodes only); one level is enough to show it.
- The *exclusivity* rule between Chat Input and the legacy Webhook — `singleton-components.spec.ts`.

---

## Tags *(required)*

Tests 1–3: `@stable` `@components` `@integrations`. Test 4: `@regression` `@components` `@integrations`
— a `test.fail()` pin carries `@regression`, not `@stable`, the same convention as #2328's pin.

`@stable`: no provider key, no model, no network egress; each test owns one flow, deleted by id.
`@stable` enters in this PR. The placement rule, the sidebar mark and the core category are all present
from `1.14.0.dev23` (the first tag carrying #16278); on an older build (the 1.13.x patch lines validated
on demand ship `ENABLE_TRIGGERS = false`) each test skips with that reason through
`servedVersionAtLeast`.

---

## Step by step *(required)*

Each test creates its flow through the API (`createCatalogFlow`) with spaced nodes, opens it
(`openFlowById`), runs `adjustScreenView` before any selection, and waits for the palette to settle: the
Chat Output row is draggable. A row also reads as unavailable — `cursor-not-allowed`, no add button,
`draggable="false"` — while the permissions request is in flight (#2197), so without that wait a blocked
row would not be the rule's. The teardown leaves the editor and deletes the flow by id.

### 1. The Triggers category holds Schedule and Inbound Webhook, and every trigger row is marked apart from the actions

Flow: one Chat Output.

1. Search *schedule*: `triggers_schedule_draggable` sits in the *Triggers* category (the sidebar menu
   item whose header is `disclosure-triggers`) and contains `sidebar-trigger-icon`.
2. Search *inbound webhook*: `triggers_inbound webhook_draggable` sits in the *Triggers* category and
   contains `sidebar-trigger-icon`.
3. Search *gmail on*: `google_gmail: on message_draggable` contains `sidebar-trigger-icon`.
4. Search *chat output*: `input_output_chat output_draggable` has no `sidebar-trigger-icon`.
5. After each search, the visible `_draggable` rows contain no `icon-GripVertical`.

### 2. With a trigger on the canvas every other trigger is blocked in the palette, and removing it unblocks them

Flow: one Schedule.

1. For *inbound webhook*, *schedule* and *gmail on*: the row has no add button and carries
   `cursor-not-allowed`; its inner button is `draggable="false"`.
2. Hover the Inbound Webhook row: a tooltip reads *"This flow already has a trigger. A flow has one
   trigger."* (the row's name tooltip opens alongside it, so the reason is matched by its text).
3. Drag the Inbound Webhook row's button onto the pane, then focus it and press `Enter`: still one node.
4. Search *webhook*: the legacy Webhook row (`input_output_webhook_draggable`) has its add button, and
   dragging it onto the pane adds it — exactly two nodes. This is the drag's positive control, and the
   count also shows the blocked attempts above added nothing, however late.
5. Click `title-Schedule`, press `Delete`: only the Webhook is left. The Inbound Webhook row has its add
   button back, and `Enter` on its button adds an Inbound Webhook — the keyboard's positive control.

### 3. Pasting or duplicating a trigger leaves it out with a notice, and keeps the rest of the selection

Flow: a Schedule and a Chat Output.

1. Click `title-Schedule`, `ControlOrMeta+c`, move over the pane, `ControlOrMeta+v`: still two nodes,
   and the notice is visible in `role=status`.
2. Wait for the notice to leave. Box-select both nodes (two selected), copy, paste: three nodes — a
   second Chat Output, still one Schedule — and the notice is visible.
3. Wait for the notice to leave. Click `title-Schedule`, `ControlOrMeta+d`: node count unchanged, and the
   notice is visible.

### 4. Grouping a trigger keeps it under the one-trigger rule *(pinned: `test.fail()`)*

Flow: a Schedule wired to a Parser (`trigger_event` → `input_data`); its trigger row is enabled through
the API and reads `active`.

1. Box-select both nodes and click `group-node` (or, should a fix refuse the grouping, the selection
   shows `error-group-node` and nothing is grouped — either way the next steps apply).
2. Wait until the stored flow holds the Group node — the autosave, inside which the server reconciles
   the trigger rows (`flows_helpers.py`), so the row read next is final.
3. The trigger row is still `active` and its `reason` is not `node_removed`.
4. Search *inbound webhook*: the row is still blocked, and its tooltip gives the reason.

Today step 3 fails (`paused` / `node_removed`), so the test is expected to fail. `test.fail()` is
declared after step 2, not at the top: a setup that breaks (the selection, the grouping, the save) still
fails the test instead of passing as the expected failure.

---

## Validation criterion *(required)*

Tests 1–3 pass, and test 4 is recorded as an expected failure, three consecutive times at
`--retries=0 --workers=1` against `1.14.0.dev27`, and once at `--workers=2` together with
`core-functionality/integrations/`, with:

- every trigger row marked and every action row unmarked, both core triggers inside
  `disclosure-triggers`, and no grip anywhere;
- every other trigger — core and provider — blocked with the tooltip's exact sentence while one trigger
  is on the canvas, a drag and a keyboard add each leaving the node count unchanged, the legacy Webhook
  still addable, and the add buttons back once the trigger is deleted — with a drag (the legacy Webhook)
  and a keyboard add (the Inbound Webhook, after the delete) each adding its node, so neither blocked
  gesture can pass by not working at all;
- each of paste-alone, paste-with-a-node and duplicate adding no trigger and showing the exact notice,
  and paste-with-a-node still adding the Chat Output;
- test 4 failing at its step 3 for the reason in *Known defect*, and for no other;
- no `🚨 Backend Error` in the run, and no flow or trigger left on the instance afterwards.

---

## External dependencies *(required)*

- A running Langflow **1.14** instance (`1.14.0.dev23` or later) at `PLAYWRIGHT_BASE_URL`, auto-login
  or superuser, with the bundled Google distribution installed (the Gmail trigger row).
- `src/frontend/src/utils/componentConstraints.ts` — `TRIGGER_PLACEMENT_KEY`, the singleton, and
  `getPresentComponentTypes` reading top-level nodes only.
- `src/frontend/src/utils/trigger-component.ts` — `isTriggerComponent` (`metadata.trigger_kind`).
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/helpers/get-disabled-tooltip.ts` —
  the blocked row's tooltip.
- `src/frontend/src/pages/FlowPage/components/flowSidebarComponent/components/sidebarDraggableComponent.tsx`
  — the trigger mark and the absent grip.
- `src/frontend/src/stores/flowStore.ts` — `paste`, which drops the trigger and raises the notice.
- `src/frontend/src/pages/FlowPage/components/SelectionMenuComponent/index.tsx` and
  `src/frontend/src/utils/reactflowUtils.ts` (`validateSelection`) — the grouping rules.
- `src/frontend/src/locales/en.json` — `triggers.palette.*` copy.
- `src/backend/base/langflow/services/triggers/reconciliation.py` — `find_trigger_nodes` and
  `validate_single_trigger_per_flow`, both top-level only.
- `src/backend/base/langflow/api/v1/flows_helpers.py` — `_reconcile_flow_triggers`, run inside the flow
  write itself.
- `src/lfx/src/lfx/components/triggers/schedule_trigger.py` and
  `src/lfx/src/lfx/components/triggers/inbound_webhook_trigger.py`.
- `tests/helpers/flows/build-catalog-flow.ts`, `tests/helpers/flows/open-flow-by-id.ts`,
  `tests/helpers/ui/adjust-screen-view.ts`, `tests/helpers/flows/unmount-editor-for-cleanup.ts`,
  `tests/helpers/flows/delete-flow.ts` and `tests/helpers/other/served-version.ts`.
