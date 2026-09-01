# Spec: Edit tools (Tool Mode) — §2.2

**Test file:** `tests/tests-automations/regression/core-components/edit-tools.spec.ts`

**Last validated:** Langflow 1.12.x (`1.12.0.dev39`; §2.2.2 re-validated on
`1.12.0.dev44` after #1644 — see *Notes*)

**Status:** active, `@stable`. The quarantine from the triage of daily #1517 was
lifted in #1536 (wait design rebuilt on an observable); the product race behind
it — **LE-2272** — was fixed upstream in `langflow-ai/langflow#14741`, first
shipped in `1.12.0.dev39`, and §2.2.2 now guards it deterministically instead of
depending on CI load to expose it.

---

## What this test validates

A component switched to **Tool Mode** exposes its actions in the Tool Mode
actions editor, and a user can **edit** each action (rename its slug, change its
description, flip its *Requires Approval* flag) with the edits **persisting** —
preserved when the editor is reopened, and the slug reverting to its default when
cleared.

Exercised on the **URL** component, whose current single tool action is
**Fetch Content** (node tool handle `tool_fetch_content`, slug `FETCH_CONTENT`).

> **LE-2272 — the race this spec is built around (#1519).** The *Requires
> Approval* half of this test flaked on the
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
>
> **What the flake actually was.** None of the panel edits reach the flow while
> the editor is OPEN — at +2.5 s after the toggle flip (exactly where the old
> `waitForTimeout(2500)` sat) the persisted node still reads
> `name: "fetch_content", approval_actions: []`. They are applied on editor
> **close**, which fires `POST /api/v1/custom_component/update` and then the
> autosave `PATCH /api/v1/flows/{id}`. A round trip still in flight when the
> editor closes answers with the **pre-edit** `tools_metadata`, and the frontend
> applied it over the edits with no staleness check — the autosave then persisted
> the loss. Filed as **LE-2272**; recorded in `REGRESSIONS.md`.
>
> **Fixed upstream, and still guarded.** `langflow-ai/langflow#14741`
> (`keepUserEdits` + a per-node `lastAppliedValues` baseline in
> `mutate-template.ts`) makes a field the user edited win over an older
> response; it landed in `release-1.12.0` on 2026-08-25 and ships from
> `1.12.0.dev39`. Measured A/B on the same host with the same script: `dev38`
> reverts (reopened editor reads `FETCH_CONTENT`), `dev39` keeps the edits.
> §2.2.1 keeps its pre-close barrier — it is what a human user satisfies by
> being slower than automation, and it must not depend on the fix — so §2.2.2
> exists to **force** the race: it drops the barrier, holds the pre-edit refresh
> and releases it across the close, which is the only way a recurrence stays
> visible here without waiting for a loaded runner to expose it.

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
4. **Wait out the node update round trip before closing**, not a clock: block
   until no `POST /api/v1/custom_component/update` is in flight and none has
   settled for a short quiet window. Nothing is observable in the flow yet — the
   panel edits are applied on close — so this barrier is what a human user
   satisfies simply by being slower than automation.
5. Close the editor (Escape, after blurring the input). The close is what applies
   the edits, so this is the first moment they exist outside the panel.
6. Assert the edits in the **persisted flow**: poll `GET /api/v1/flows/<id>` for
   the URL node's `template.tools_metadata.value[0]` and require the edited
   `name`, the edited `description` **and** a non-empty `approval_actions`.
7. Reopen the editor: the slug (grid `name_1` cell, shown upper-cased),
   description (grid `description` cell) and the *Requires Approval* toggle show
   the edited values — then **re-read the persisted flow**, because the nastier
   half of LE-2272 leaves the editor rendering the edits while the document has
   already lost them.
8. Clear the slug: the action's slug reverts to its default (`FETCH_CONTENT`).

The **guard** (§2.2.2) inverts step 4: it holds the pre-edit `tools_metadata`
refresh instead of waiting it out, releases it across the close, and then makes
the same two assertions — reopened editor and persisted flow. Under LE-2272 both
fail; with the upstream fix both hold.

> **Node tool handle does not rename.** The URL node's tool handle testid is
> derived from the action's fixed **display name** ("Fetch Content"), not from
> the editable slug — so it stays `tool_fetch_content` across edits. The current
> UI exposes no editable display-name field (only Slug + Description), so the
> legacy spec's `tool_<new_name>` handle assertion no longer applies; persistence
> is asserted by reopening the editor instead.

---

### 2.2.1 Edit a URL tool action and it persists [x]

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
  8. Wait out any in-flight `POST /api/v1/custom_component/update` (the barrier
     that replaces the old fixed 2.5 s wait, and sits on the other side of it).
  9. Close the editor (Escape, after blurring the input).
  10. Poll the persisted flow (`GET /api/v1/flows/<id>`) until the URL node's
     `template.tools_metadata.value` entry carries the edited `name`, the edited
     `description` and a **non-empty** `approval_actions`.
  11. Reopen the actions editor; assert the grid `name_1` cell (upper-cased slug)
     and `description` cell show the edited values, and the *Requires Approval*
     toggle is still on (persisted); then re-read the persisted flow.
  12. Clear the slug; assert the slug reverts to its default (`FETCH_CONTENT`).
  13. Teardown: delete the flow id-scoped via the API.
- **Validation:** after editing the "Fetch Content" action's slug + description
  and flipping *Requires Approval*, the persisted flow carries the action's
  `approval_actions` non-empty, and reopening the editor shows the persisted
  values (slug upper-cased, description verbatim, toggle still on); clearing the
  slug restores the default `FETCH_CONTENT`. The node tool handle stays
  `tool_fetch_content` throughout (display-name-derived).

---

### 2.2.2 A stale node-update response does not revert the action edits [x]

- **File:** `tests/tests-automations/regression/core-components/edit-tools.spec.ts`
- **Objective:** Guard **LE-2272** deterministically — a
  `POST /api/v1/custom_component/update` response computed from the **pre-edit**
  template, applied after the editor closed, must not revert the action's slug,
  description or `approval_actions`.
- **Precondition:** same as §2.2.1. No provider credentials, no run. Requires a
  build carrying `langflow-ai/langflow#14741` (`1.12.0.dev39` or later) to pass;
  on `dev38` and earlier it fails, which is the intended signal.
- **Step by step:**
  1. Create a blank flow via the API; open it; add the URL component.
  2. Install a route handler on `POST /api/v1/custom_component/update`,
     matching on the request's **pathname**
     (`url => new URL(url).pathname === UPDATE_PATH`) and **never** on a URL
     glob: a glob has to match the WHOLE URL, and this endpoint carries a
     `?flow_id=<uuid>` query string it did not carry when this test was written
     (#1644 — see *External dependencies*). The handler **claims the pre-edit
     `tools_metadata` refresh** — discriminated on the request payload
     (`field === "tools_metadata"` and the action still carrying the default
     slug), never on arrival order — fetches its response immediately, and parks
     the fulfilment behind a gate.
  3. Switch the node to Tool Mode; open the actions editor; confirm the held
     response is parked before editing (an unparked run would measure nothing).
  4. Edit slug + description — and **not** *Requires Approval*: LE-2272 reverts
     the whole `tools_metadata` entry, so those two detect it in full, while the
     toggle drags in a second, unrelated defect (see *What this test does not
     cover*). Approval persistence stays asserted by §2.2.1.
  5. **No barrier here** — that is the point: close the editor (Escape) with the
     stale response still held.
  6. Release the gate so the pre-edit response is applied **after** the close,
     inside the window LE-2272 lands in, and let the autosave settle.
  7. Reopen the actions editor and assert the edited slug, description and the
     *Requires Approval* toggle are intact.
  8. Re-read the persisted flow and assert the same three values — the UI alone
     reads healthy in the post-reopen variant of the defect.
  9. Teardown: open the gate unconditionally, unroute, delete the flow id-scoped.
- **Validation:** with the stale pre-edit response delivered across the editor
  close, the reopened editor still reads `WEB_FETCH` and the edited description,
  and the persisted flow still carries `name: "web_fetch"` with that
  description. Under LE-2272 the reopened editor reads `FETCH_CONTENT` and the
  flow has the whole entry back at its defaults — measured on `1.12.0.dev38`,
  3 runs of 3, against 5 of 5 clean on `1.12.0.dev39`.

---

## Tags

§2.2.1 — `@stable` `@release` `@components`
§2.2.2 — `@stable` `@regression` `@components`

`@components` (canvas/Tool Mode configuration) is the functional area of both.
`@release` is kept from the legacy spec on §2.2.1 (Tool Mode edit is a happy-path
surface). §2.2.2 carries `@regression` instead: it exists for a specific fixed
product defect (LE-2272), which is what that tag means in this repo, and it is
not a happy path. `@stable` was added by #664, removed at the triage of daily
#1517, and restored by #1536 once the persistence wait became observable and the
deterministic burst was clean; §2.2.2 ships `@stable` from the start, on the
`1.12.0.dev39`+ evidence below. There is no `@destructive` / `@enterprise` here,
so both run on the daily lane.

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
- **Survives a stale node update (§2.2.2):** with the pre-edit
  `custom_component/update` response held and released **across** the editor
  close, the slug and description still hold in both places — the reopened editor
  and the persisted flow. This is the LE-2272 contract, and the only assertion
  here that does not depend on CI load to be meaningful.

Either test fails if an edit does not persist — a regression in Tool Mode's action
editing. Neither must **ever** be made to pass by lengthening a wait: if the flag
never reaches `approval_actions`, that is the finding. §2.2.2 in particular must
not be repaired by adding the barrier §2.2.1 uses — the missing barrier is the
mechanism under test.

---

## External dependencies

- `tests/helpers/flows/create-flow.ts`, `delete-flow.ts`,
  `auth/get-auth-token.ts`.
- The core **URL** component (non-bundle); no model-provider credentials (no run
  — edits are asserted on the node/editor, not by executing the tool).
- `POST /api/v1/custom_component/update` — the node round trip both the §2.2.1
  barrier and the §2.2.2 hold key on. **It carries a `?flow_id=<uuid>` query
  string**, added upstream in a nightly built between 2026-08-28 and 2026-08-31,
  so anything matching this endpoint must match on the **pathname**, never with
  a URL glob spelled as the bare path (#1644).
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
- **The 200 ms row-commit window** — upstream #14741 records, as out of scope, a
  separate smaller defect: the *Requires Approval* switch lives in the grid row
  itself (`col-id="approval_actions"`; there is no second copy in the side
  panel), `aria-checked` is its own local state, and the write onto the row lands
  ~200 ms after the click. If anything remounts the cell first, that write is
  lost — traced on `1.12.0.dev39`, the editor-close request then carries
  `name: "web_fetch"` with `approval_actions: []`, so the value never reached the
  store and no staleness guard could have recovered it. Measured at ~1 run in 6
  when the flip is not followed by a settle. §2.2.1 stays outside the window
  through its `custom_component/update` barrier (unchanged, and the reason it has
  been green since #1536); §2.2.2 sidesteps the toggle altogether. Neither
  asserts on the defect, and it has no ticket of its own — upstream declared it
  out of scope for #14741.
- Tool Mode **availability** across other components — this validates editing on
  a representative (URL) component.

---

## Notes

- **§2.2.2 was quarantined for #1644 and is not any more, and the cause was neither the
  product nor the wait strategy.** On the 2026-08-31 daily (run 33410643882) it failed 3
  of 3 attempts on its own precondition — `expect.poll(() => parked).toBe(true)` false for
  the full 20 s — so it asserted nothing at all. Upstream had added a `?flow_id=<uuid>`
  query string to `POST /api/v1/custom_component/update` in a nightly built between the
  2026-08-28 daily (green) and that one, and a Playwright URL glob must match the
  **entire** URL, so the handler's `**/api/v1/custom_component/update` stopped matching
  and the park never engaged. Measured on `1.12.0.dev44`: the pre-edit refresh still
  fires, still carrying `field: "tools_metadata"` with `name: "fetch_content"` and
  `approval_actions: []`. Baseline before the fix: 5 of 5 failures at
  `--retries=0 --workers=1`. The fix matches on the **pathname** rather than adding a
  trailing wildcard, which is what this file's own `waitForComponentUpdateSettled` already
  did — and why §2.2.1, which shares the endpoint, stayed green through the change.
- **Force-fail probes (executed during validation):** §2.2.1 —
  `APPROVAL_DECISION` changed to a value Langflow never writes, so the
  persisted-flow poll can never match (failed, reverted). §2.2.2 — three: the
  persisted assertion pointed at the **reverted** slug so it can only pass on a
  clobbered document (failed); the gate release removed, so the held response is
  never delivered (failed); and, strongest of all, the unmutated test run against
  `1.12.0.dev38`, where the product defect is live (failed 3 of 3). All
  documented in the PR Validation block.
- The spec creates exactly one flow and deletes it id-scoped in `afterEach`
  (the legacy spec leaked a flow — fixed in this rewrite).
