# Spec: Edit tools (Tool Mode) — §2.2

**Test file:** `tests/tests-automations/regression/core-components/edit-tools.spec.ts`

**Last validated:** Langflow 1.12.x (`1.12.0.dev33`)

**Status:** quarantined (`test.fixme`, `@stable` removed) at the triage of daily
#1517 — see *Quarantine* below. Lifting it is a deliverable of #1519.

---

## What this test validates

A component switched to **Tool Mode** exposes its actions in the Tool Mode
actions editor, and a user can **edit** each action (rename its slug, change its
description, flip its *Requires Approval* flag) with the edits **persisting** —
preserved when the editor is reopened, and the slug reverting to its default when
cleared.

Exercised on the **URL** component, whose current single tool action is
**Fetch Content** (node tool handle `tool_fetch_content`, slug `FETCH_CONTENT`).

> **Quarantine (#1519).** The *Requires Approval* half of this test flaked on the
> 2026-07-30 and 2026-08-20 dailies under one signature — the reopened
> `requires-approval-toggle` reads `aria-checked="false"`. Both days recorded it
> in the run's **flaky** bucket with `attempts: 2` (it passed on retry), so the
> flag *is* wired into the save path; what is not deterministic is **when** the
> write lands. The previous design conceded that: it flipped the toggle last and
> waited a fixed 2.5 s before closing the editor — a wall-clock settle, which is
> not an observable and degrades under CI load.
>
> **Persistence is therefore redefined against a real observable.** The toggle
> writes the per-action HITL decisions into the node's
> `tools_metadata[].approval_actions` list (`lfx/base/tools/component_tool.py`,
> `lfx/custom/custom_component/component.py::_build_tool_data`, LE-1447) — a
> field that is part of the saved flow. The test must gate on that field
> reaching the persisted flow, and only then assert the reopened UI. That makes
> the criterion **stronger** than before: the old assertion could be satisfied by
> frontend state alone, which a page reload would lose.

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
   **Requires Approval** (`requires-approval-toggle`) last.
4. **Wait for the write to be observable**, not for a clock: poll the persisted
   flow until the URL node's `tools_metadata` entry carries a non-empty
   `approval_actions`. Only then close the editor.
5. Reopen the editor: the slug (grid `name_1` cell, shown upper-cased),
   description (grid `description` cell) and the *Requires Approval* toggle show
   the edited values (persisted).
6. Clear the slug: the action's slug reverts to its default (`FETCH_CONTENT`).

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
  (1.12.x); auto-login (repo default). No provider credentials required (no run).
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
  7. Flip **Requires Approval** (`requires-approval-toggle`) last; assert the
     toggle reads `aria-checked="true"` in the panel.
  8. Poll the persisted flow (`GET /api/v1/flows/<id>`) until the URL node's
     `template.tools_metadata.value` entry for the action carries a **non-empty**
     `approval_actions` — the observable that replaces the old fixed 2.5 s wait.
  9. Close the editor (Escape, after blurring the input).
  10. Reopen the actions editor; assert the grid `name_1` cell (upper-cased slug)
     and `description` cell show the edited values, and the *Requires Approval*
     toggle is still on (persisted).
  11. Clear the slug; assert the slug reverts to its default (`FETCH_CONTENT`).
  12. Teardown: delete the flow id-scoped via the API.
- **Validation:** after editing the "Fetch Content" action's slug + description
  and flipping *Requires Approval*, the persisted flow carries the action's
  `approval_actions` non-empty, and reopening the editor shows the persisted
  values (slug upper-cased, description verbatim, toggle still on); clearing the
  slug restores the default `FETCH_CONTENT`. The node tool handle stays
  `tool_fetch_content` throughout (display-name-derived).

---

## Tags

`@stable` `@release` `@components`

`@components` (canvas/Tool Mode configuration) is the functional area.
`@release` is kept from the legacy spec (Tool Mode edit is a happy-path surface).
`@stable` was added by #664, removed at the triage of daily #1517, and is
**restored by #1519** once the persistence wait is observable and the
deterministic burst is clean. There is no `@destructive` / `@enterprise` here, so
`@stable` puts it back on the daily lane.

---

## Validation criterion

After switching the URL component to Tool Mode and editing its single
"Fetch Content" action:

- **Persisted in the flow (the distinctive observable):** the flow read back from
  `GET /api/v1/flows/<id>` carries, on the URL node's
  `template.tools_metadata.value` entry for the edited action, a **non-empty**
  `approval_actions` list. This is the field the backend actually consumes to
  gate the action (`component_tool.py::update_tools_metadata` copies it onto the
  tool as `tool.metadata["approval_actions"]`, and `lfx/run/hitl.py` treats a
  non-empty list as "this action needs approval"), so it is the same contract a
  real user depends on — not a frontend-only echo.
- **Edits persist across reopen:** reopening the actions editor shows the edited
  slug (grid `name_1` cell, upper-cased), description (grid `description` cell)
  and the *Requires Approval* toggle (`requires-approval-toggle`, still on).
- **Revert on clear:** clearing the slug restores its default (`FETCH_CONTENT`).
- **Node handle stable:** the node's tool handle stays `tool_fetch_content`
  (derived from the fixed display name, not the slug).

The test fails if an edit does not persist — a regression in Tool Mode's action
editing. It must **not** be made to pass by lengthening a wait: if the flag never
reaches `approval_actions`, that is the finding.

---

## External dependencies

- `tests/helpers/flows/create-flow.ts`, `delete-flow.ts`,
  `auth/get-auth-token.ts`.
- The core **URL** component (non-bundle); no model-provider credentials (no run
  — edits are asserted on the node/editor, not by executing the tool).
- `GET /api/v1/flows/<id>` — read back the persisted `tools_metadata` (the
  `approval_actions` observable). No new helper is needed if an existing
  flow-read helper covers it; otherwise it is a planned task, not an inline
  improvisation.

Field testids confirmed live on `langflow-nightly 1.11.0.dev45` during authoring
(to be re-confirmed on `1.12.0.dev33` in this issue):
`add-component-button-url`, `data_sourceURL`, `generic-node-title-arrangement`,
`tool-mode-button`, `button_open_actions`, `tool_fetch_content`,
`input_update_name` (slug), `input_update_description`,
`requires-approval-toggle`, grid columns `name` / `name_1` / `description`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` on a recent nightly (1.12.x).
- Auth via `auto_login` (repo default).

---

## What this test does not cover

- **Multiple tool actions** per component / select-all row choreography — the URL
  component exposes a single action on the current nightly; multi-action
  behaviour is not expressible here.
- **Executing** the tool via an agent — persistence is asserted on the
  node/editor plus the persisted flow, not by a run. Whether a non-empty
  `approval_actions` actually pauses an agent run for human approval (the HITL
  behaviour in `lfx/run/hitl.py`) is a separate surface, out of scope here.
- **Scoping the defect to Tool Mode as a whole** — #1519's directive 4 (does the
  toggle persist for a non-URL tool action?) is answered as *investigation*
  evidence on the issue, not as a second test case in this spec.
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
