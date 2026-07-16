# Spec: Edit tools (Tool Mode) — §2.2

**Test file:** `tests/tests-automations/regression/core-components/edit-tools.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

A component switched to **Tool Mode** exposes its actions in the Tool Mode
actions editor, and a user can **edit** each action (rename its slug, change its
description, flip its *Requires Approval* flag) with the edits **persisting** —
preserved when the editor is reopened, and the slug reverting to its default when
cleared.

Exercised on the **URL** component, whose current single tool action is
**Fetch Content** (node tool handle `tool_fetch_content`, slug `FETCH_CONTENT`).

> **Requires Approval — debounced commit.** The *Requires Approval* toggle commits
> to the frontend store on a debounce with no network/DOM signal to await, so it
> is flipped **last** and given a short settle before the editor is closed. A
> rushed close (only reachable by automation, not human-speed use) races the
> commit and drops the flag; the spec flips-then-settles to assert real
> persistence, not the race.

> **Rewrite note (#664).** The legacy spec was written against an older Tool
> Mode UI that exposed **multiple** URL tool actions and edited them through a
> now-removed sidebar form. On the current nightly the URL component exposes a
> **single** action ("Fetch Content") and editing happens in a redesigned grid +
> side panel. The multi-row checkbox choreography (select-all toggling sibling
> rows) is therefore no longer expressible and is intentionally dropped; the
> durable behaviour — *edit a tool action and it persists* — is kept and
> hardened (id-scoped cleanup, no arbitrary `waitForTimeout`).

### Verification model

The tool edits are proven durable by **reopening** the actions editor, not by a
transient widget read:

1. Enable Tool Mode on the URL node; the node exposes `tool_fetch_content`
   (Tool Mode precondition).
2. Open the actions editor; the single "Fetch Content" action is present and
   selected.
3. Double-click the action's **name cell** to open the side edit panel; edit the
   slug (`input_update_name`) + description (`input_update_description`); then flip
   **Requires Approval** (`requires-approval-toggle`) last and let it settle;
   close.
4. Reopen the editor: the slug (grid `name_1` cell, shown upper-cased),
   description (grid `description` cell) and the *Requires Approval* toggle show
   the edited values (persisted).
5. Clear the slug: the action's slug reverts to its default (`FETCH_CONTENT`).

> **Node tool handle does not rename.** The URL node's tool handle testid is
> derived from the action's fixed **display name** ("Fetch Content"), not from
> the editable slug — so it stays `tool_fetch_content` across edits. The current
> UI exposes no editable display-name field (only Slug + Description), so the
> legacy spec's `tool_<new_name>` handle assertion no longer applies; persistence
> is asserted by reopening the editor instead.

---

### 2.2.1 Edit a URL tool action and it persists [-]

- **File:** `tests/tests-automations/regression/core-components/edit-tools.spec.ts`
- **Objective:** Prove Tool Mode action edits (slug, description, Requires
  Approval) persist across reopening the editor.
- **Precondition:** Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly
  (1.11.x); auto-login (repo default). No provider credentials required (no run).
- **Step by step:**
  1. Create a blank flow via the API (parallel-safe unique name); open it.
  2. Search the sidebar for "URL"; add the URL component
     (`add-component-button-url`).
  3. Open the node title menu (`generic-node-title-arrangement`) → click
     **Tool Mode** (`tool-mode-button`); the node now exposes tool handles.
  4. Assert the node exposes exactly `tool_fetch_content`.
  5. Open the actions editor (`button_open_actions`); assert the grid holds the
     single "Fetch Content" row, selected (checkbox checked).
  6. Double-click the row's **name cell** to open the side edit panel; edit the
     slug (`input_update_name`) and description (`input_update_description`) to
     distinctive values; assert the grid `name_1` / `description` cells reflect
     them live (proves commit + settles before close).
  7. Flip **Requires Approval** (`requires-approval-toggle`) last; let its
     debounced commit settle before closing.
  8. Close the editor (Escape, after blurring the input).
  9. Reopen the actions editor; assert the grid `name_1` cell (upper-cased slug)
     and `description` cell show the edited values, and the *Requires Approval*
     toggle is still on (persisted).
  10. Clear the slug; assert the slug reverts to its default (`FETCH_CONTENT`).
  11. Teardown: delete the flow id-scoped via the API.
- **Validation:** after editing the "Fetch Content" action's slug + description
  and flipping *Requires Approval*, reopening the editor shows the persisted
  values (slug upper-cased, description verbatim, toggle still on); clearing the
  slug restores the default `FETCH_CONTENT`. The node tool handle stays
  `tool_fetch_content` throughout (display-name-derived).

---

## Tags

`@stable` `@release` `@components`

`@components` (canvas/Tool Mode configuration) is the functional area.
`@release` is kept from the legacy spec (Tool Mode edit is a happy-path surface).
`@stable` is added after the deterministic-run + force-fail validation (this
issue, #664).

---

## Validation criterion

After switching the URL component to Tool Mode and editing its single
"Fetch Content" action:

- **Edits persist across reopen:** reopening the actions editor shows the edited
  slug (grid `name_1` cell, upper-cased), description (grid `description` cell)
  and the *Requires Approval* toggle (`requires-approval-toggle`, still on).
- **Revert on clear:** clearing the slug restores its default (`FETCH_CONTENT`).
- **Node handle stable:** the node's tool handle stays `tool_fetch_content`
  (derived from the fixed display name, not the slug).

The test fails if an edit does not persist — a regression in Tool Mode's action
editing.

---

## External dependencies

- `tests/helpers/flows/create-flow.ts`, `delete-flow.ts`,
  `auth/get-auth-token.ts`.
- The core **URL** component (non-bundle); no model-provider credentials (no run
  — edits are asserted on the node/editor, not by executing the tool).

Field testids confirmed live on `langflow-nightly 1.11.0.dev45` during authoring:
`add-component-button-url`, `data_sourceURL`, `generic-node-title-arrangement`,
`tool-mode-button`, `button_open_actions`, `tool_fetch_content`,
`input_update_name` (slug), `input_update_description`,
`requires-approval-toggle`, grid columns `name` / `name_1` / `description`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.11.x).
- Auth via `auto_login` (repo default).

---

## What this test does not cover

- **Multiple tool actions** per component / select-all row choreography — the URL
  component exposes a single action on the current nightly; multi-action
  behaviour is not expressible here.
- **Executing** the tool via an agent — persistence is asserted on the
  node/editor, not by a run.
- Tool Mode **availability** across other components — this validates editing on
  a representative (URL) component.

---

## Notes

- **Force-fail probe (executed during validation):** one mutation on the persist
  assertion (e.g. asserting the reopened slug still equals the default instead of
  the edited value), observed failing then reverted — documented in the PR
  Validation block.
- The spec creates exactly one flow and deletes it id-scoped in `afterEach`
  (the legacy spec leaked a flow — fixed in this rewrite).
