# Spec: Re-running a flow with If-Else resets the previous run's branch state

**Test file:** `tests/tests-automations/regression/flow-functionality/general-bugs-reset-flow-run.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

The same flow can be run again and again from the canvas with the **If-Else** component
routing a different way each time, and each run's node status replaces the previous
run's instead of accumulating on top of it.

If-Else (`ConditionalRouter`) compares `input_text` with `match_text` and emits on
`true_result` or on `false_result`; the branch it does not take is stopped, and the
canvas marks that branch's node **inactive** (`node_status_icon_<name>_inactive`) while
the built one shows its build duration (`node_duration_<name>`). The inherited bug this
file is named after is about the *second* run: the branch skipped last time must build
now, and the branch built last time must now be the inactive one.

Four runs alternate the route — True, False, True, False — and after **each** the test
asserts both halves of the state: the routed branch shows a build duration and **no**
inactive icon, and the other branch shows the inactive icon and **no** build duration.
Asserting the absences is what makes this about the reset: a stale badge from the
previous run would satisfy the presences alone.

---

## Tags

`@stable` `@release` `@regression` `@components` `@ui-ux`

`@regression` because the file pins a previously fixed product bug (re-running a flow
after a branch switch). `@ui-ux` is the functional area: what is asserted is the node
status the canvas shows after each run — the same choice
`flow-functionality/graph-execution-canvas.spec.ts` made for its canvas feedback.

---

## Step by step

1. Create over the API a flow — built from the live `GET /api/v1/all` catalog
   (`build-catalog-flow`) — holding one If-Else and two Chat Outputs named
   `true branch` and `false branch`, wired `true_result → true branch` and
   `false_result → false branch`, and open it with `openFlowById`. The display names are
   what the canvas testids derive from (`button_run_true branch`, …). The flow id is
   deleted id-scoped in `afterEach`, after leaving the editor with
   `unmountEditorForCleanup`.
2. Type `1` into `popover-anchor-input-match_text`.
3. **Run 1 — True.** Type `1` into `popover-anchor-input-input_text` and click
   `button_run_true branch`.
4. **Run 2 — False.** Type `2` into `input_text` and click `button_run_false branch`.
5. **Run 3 — True again.** Type `1` and click `button_run_true branch`.
6. **Run 4 — False again.** Type `2` and click `button_run_false branch`.
7. After each run, assert the state below for that run's routed branch (`R`) and the
   other branch (`O`).

---

## Validation criterion

After every run, in this order (presences first, so the absences are read after the run
has settled):

| Claim | Observable |
|---|---|
| The routed branch built | `node_duration_<R>` count 1 |
| The other branch was skipped | `node_status_icon_<O>_inactive` count 1 |
| The routed branch carries no stale inactive mark | `node_status_icon_<R>_inactive` count 0 |
| The other branch carries no stale build badge | `node_duration_<O>` count 0 |

Runs 2 and 3 are the regression: each flips a branch from the state the previous run
left it in.

The test fails if a re-run keeps the previous run's routing or status — a branch that
stays inactive after the route flips to it, or a build badge that survives on a branch
the new run skipped — or if If-Else stops inactivating the branch it does not take.

---

## External dependencies

- `src/lfx/src/lfx/components/flow_controls/conditional_router.py` — If-Else: the
  comparison and the `stop()` of the branch not taken
- `src/lfx/src/lfx/components/input_output/chat_output.py` — the branch terminals
- `src/frontend/src/CustomNodes/GenericNode/components/NodeStatus/index.tsx` —
  `node_status_icon_<name>_inactive` and the build-duration badge
- `tests/helpers/flows/build-catalog-flow.ts` — builds the three nodes and both edges
  from the live catalog

---

## What this test does not cover

- The operators, case sensitivity and regex of If-Else, each on a fresh flow —
  `core-components/if-else-component-regression.spec.ts` (11 `@stable` tests).
- Branch skipping through the API / stream contract —
  `api/flows/graph-execution-contract.spec.ts`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`. No provider key.

---

## Notes

- **Wave 9 T2 triage, issue #1911 — outcome PROMOTE.** Row in
  `docs/triage/inherited-spec-triage.md`: T2,
  `flow-functionality/general-bugs-reset-flow-run.spec.ts`, 0/3 green.
- **Why it failed (drift, not product).** Measured on `1.13.0.dev16`: it died at
  `locator.hover` on `panel-description` (20 s) — the node-rename wrapper that no longer
  exists (the rename controls are `node-edit-name-description-button` now, as
  `if-else-component-regression.spec.ts` already records). The rename only existed to give
  the two terminals distinct testids; the display names are now set when the flow is
  built.
- **The issue's "renamed component" lead did not hold.** #1911 suggested If-Else had left
  the catalog. It has not: `flow_controls.ConditionalRouter` has `display_name` `If-Else`
  on `1.13.0.dev16`, and the failing run found `flow_controlsIf-Else` in the sidebar and
  added it — it failed later, at the rename.
- **Why DELETE was not available.** The If-Else siblings each build a fresh flow and run
  it **once**; none re-runs the same canvas with the route flipped, which is this spec's
  subject.
- Hardening for the promotion: (a) the inherited file built the flow through the sidebar
  with drags and a rename, reached through `awaitBootstrapTest`, and deleted nothing —
  **3 flows leaked per run** on an empty project; the flow is now built over the API and
  deleted by id; (b) the terminals were **Text Output**, which is legacy on 1.13 (its
  `replacement` is Chat Output) and needed the legacy toggle — they are Chat Outputs now;
  (c) every fixed `waitForTimeout` and the reliance on the `built successfully` toast
  (which a previous run leaves on screen) are gone — each run is judged by its node
  states; (d) the absences in the table are new: the inherited counts could not see a
  stale badge.
