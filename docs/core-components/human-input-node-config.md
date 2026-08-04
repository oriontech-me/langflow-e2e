# Spec: Human Input node configuration (HITL branch handles)

**Test file:** `tests/tests-automations/regression/core-components/human-input-node-config.spec.ts`

**Last validated:** Langflow 1.12.x (scouted on `1.12.0.dev10`)

---

## What this test validates

Confirms the **configuration surface** of the `Human Input` node shipped with Langflow
1.11.0 (upstream `langflow-ai/langflow#13633`, LE-1449): the node's **branch outputs are
derived from its `User Choices` field**, one handle per choice, and that derivation
holds on three occasions.

1. **On add** — a freshly dragged node already renders the two default branch handles
   (`Approve`, `Reject`), before any field is touched. Upstream relies on a hardcoded
   `outputs` list for exactly this case, because `update_outputs()` only fires on a
   field change (`lfx/components/flow_controls/human_input.py`).
2. **On change (live)** — adding a custom choice creates its branch handle **without a
   reload**: the `real_time_refresh` field round-trips through
   `POST /api/v1/custom_component/update` and the node re-renders with the new handle.
3. **After save + reload** — the configured choices and their handles survive a full
   page load, rebuilt from the persisted `decisions` by `update_frontend_node()`.

The custom choice is deliberately a **two-word label** (`Request Changes`), because the
label→handle mapping is where the two ends of this feature have to agree: the backend
slugifies it (`_action_id()`: lowercase, spaces → underscores) into the output **name**
`branch_request_changes`, while the frontend derives the handle **testid** from the
display name (`handle-humaninput-shownode-request changes-right`) and its own
`toActionId()` mirror decides whether an existing edge still belongs to the renamed
choice. A one-word label would pass even if one side dropped its normalisation.

**Execution is out of scope** — pausing a run, the decision card and branch routing are
covered separately (issue #1189 → `core-functionality/playground/human-input-pause-resume.spec.ts`).
This spec never runs the flow, so it needs **no LLM provider**.

---

## Tags

`@stable` `@components` `@ui-ux` — plus `@database` on the persistence test, which
asserts state read back from the flows API after a reload.

No functional tag maps to HITL today; `@ui-ux` is used because every assertion here is
made against the node's configuration UI. `@regression` is deliberately **absent**: this
is first-time coverage of a new feature, not a previously fixed bug.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on the nightly, `1.12.0.dev10`).
- No provider credentials, no `models.json`, no `--workers=1` — nothing here is
  model-dependent.
- The `Human Input` component must be present in the sidebar under **Flow Control**
  (`add-component-button-human-input`). It is non-legacy and non-beta on 1.12.x, so no
  sidebar toggle is required.

---

## Step by step

**beforeEach (all tests)**
1. `setupBlankFlow(page)` — create a blank flow through the REST API and open it via the
   dashboard card (avoids the UI-creation race); keep the returned id for cleanup.
2. Assert `sidebar-search-input` is visible (the editor is interactive).

**Test 1 — default branch handles on add**
1. `addComponentFromSidebar(page, "Human Input", "add-component-button-human-input")`.
2. Assert `title-Human Input` is visible and `.react-flow__node` has count `1`.
3. Assert the two default choice chips are rendered: `action-edit-Approve`,
   `action-edit-Reject`.
4. Assert both branch handles are visible: `handle-humaninput-shownode-approve-right`,
   `handle-humaninput-shownode-reject-right`.
5. Assert the node has **exactly two** output handles — every
   `[data-testid^="handle-humaninput-shownode-"][data-testid$="-right"]` inside the node,
   count `2` (so a third, unexpected branch fails the test too).

**Test 2 — a custom User Action creates its handle live**
1. Add the node (steps 1–2 above) and assert the output-handle count baseline is `2`.
2. Click `actionpicker-add-decisions` (the `+` next to **User Choices**) and assert the
   inline input `action-add-input` is visible.
3. Fill it with `Request Changes` and press `Enter`.
4. Assert, **on the same page — no reload, no navigation** — that
   `handle-humaninput-shownode-request changes-right` becomes visible, and that the chip
   `action-edit-Request Changes` is rendered.
5. Assert the output-handle count is now `3`, and that the two defaults are still there
   (adding a choice adds a branch; it does not replace the existing ones).

**Test 3 — configured handles persist after save + reload**
1. Add the node and the `Request Changes` choice (Test 2's steps 1–3).
2. Gate on **server truth**, not on network silence: poll `GET /api/v1/flows/{id}`
   (Bearer from `getAuthToken`) until the persisted `Human Input` node's `outputs` names
   are exactly `["branch_approve", "branch_reject", "branch_request_changes"]` — this is
   also the assertion that the `Request Changes` → `branch_request_changes` slug survived
   the round trip.
3. `page.reload()`. No `page.on("dialog")` handler is registered anywhere in the spec, on
   purpose: `FlowPage` installs a `beforeunload` that `preventDefault()`s while the store
   is dirty, and Playwright's default ACCEPTS a `beforeunload` dialog — registering a
   handler would silently cancel the reload (documented in
   `helpers/flows/leave-flow-editor.ts`).
4. Assert the rehydrated node renders all three chips (`action-edit-Approve`,
   `action-edit-Reject`, `action-edit-Request Changes`) and all three branch handles, with
   the output-handle count back at `3`.

**afterEach (all tests)**
1. `page.goto("/")` to unmount the editor (an editor left mounted over a deleted flow
   404s its `GET /flows/{id}/events` poll, which the fixture logs as a backend error),
   then `deleteFlow(page.request, flowId)`.

---

## Validation criterion

| Test | Criterion |
|---|---|
| Human Input renders the default Approve and Reject branch handles when added to the canvas | `handle-humaninput-shownode-approve-right` **and** `handle-humaninput-shownode-reject-right` visible, with the node's output-handle count exactly `2` |
| adding a custom User Action creates its branch handle without a reload | after committing `Request Changes` in `action-add-input`, `handle-humaninput-shownode-request changes-right` becomes visible on the same page and the output-handle count goes `2` → `3` |
| the configured branch handles persist after save and reload | `GET /api/v1/flows/{id}` reports the node's `outputs` names as exactly `branch_approve, branch_reject, branch_request_changes`, and after `page.reload()` the three chips and three handles render again |

---

## External dependencies

- **Sidebar add affordance** — `sidebar-search-input` + `add-component-button-human-input`
  (component `HumanInput`, category `flow_controls`, display name `Human Input`).
- **Node markers** — `title-Human Input`, `.react-flow__node` for scoping and counting.
- **`User Choices` field (`decisions`)** — an `ActionPickerInput` rendered by
  `components/core/parameterRenderComponent/components/actionPickerComponent`: `+` button
  `actionpicker-add-decisions`, inline input `action-add-input` (commits on `Enter` or
  blur, rejects a duplicate with an error toast), chip buttons `action-edit-<label>` /
  `action-remove-<label>` (the label verbatim, **not** slugified).
- **Branch handles** — `handle-{component}-shownode-{output display name lowercased}-{side}`,
  from `CustomNodes/GenericNode/components/handleRenderComponent`. `group_outputs: true`
  on every Human Input output is what makes each branch render its **own** handle instead
  of the single selectable output most components show (`NodeOutputParameter/NodeOutputs.tsx`).
- **`POST /api/v1/custom_component/update`** — the round trip behind the live rebuild
  (`real_time_refresh` on `decisions`). Not asserted directly: the DOM assertion is the
  user-visible outcome, and pinning the endpoint would couple the spec to a refresh
  mechanism upstream may change.
- **`GET /api/v1/flows/{id}`** with a Bearer token (`helpers/auth/get-auth-token.ts`) —
  the persistence oracle.
- **Helpers** — `helpers/flows/setup-blank-flow.ts`,
  `helpers/flows/add-component-from-sidebar.ts`, `helpers/flows/delete-flow.ts`.

---

## What this test does not cover

- **Running the flow** — the pause/resume, the decision card and exclusive branch routing
  belong to #1189 (`human-input-pause-resume.spec.ts`).
- **Removing or renaming a choice** — `action-remove-<label>` / `action-edit-<label>`
  dropping or renaming a branch handle (and the "connection removed" notice when the
  renamed branch had an edge) is adjacent behaviour, deliberately left out of this
  issue's scope.
- **The duplicate-choice guard** — committing a label that already exists surfaces an
  error toast and no new branch.
- **`Enable Fallback`** — the advanced toggle that adds a `Fallback` branch and reveals
  the `Timeout` field.
- **Edge wiring** — connecting a branch handle to a downstream node, and what happens to
  that edge when its choice is renamed or removed.

---

## Notes

- Everything above was scouted against the running nightly (`1.12.0.dev10`) before the
  spec was written: the node's testids were harvested from the live DOM, and the
  persisted shape (`decisions: ["Approve","Reject","Request Changes"]` →
  `outputs: branch_approve, branch_reject, branch_request_changes`) was read back from
  `GET /api/v1/flows/{id}`.
- The three tests each build their own flow rather than sharing one in a serial describe:
  the setup is cheap (no LLM, no build), and independent tests keep a failure in the live
  rebuild from masking the persistence check.
- Sibling reference for shape: `core-components/singleton-components.spec.ts` (blank flow
  + sidebar add + node assertions + id-scoped cleanup).
