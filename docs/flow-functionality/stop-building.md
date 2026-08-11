# Spec: Stop (pause) a running flow build from the canvas

**Test file:** `tests/tests-automations/regression/flow-functionality/stop-building.spec.ts`

**Last validated:** Langflow 1.12.x (nightly `1.12.0.dev23`)

---

## What this test validates

Confirms a user can **cancel an in-progress flow build from the canvas** — the
"pause a flow" capability. While a build is running, the run control on the
terminal node is replaced by a stop control (`stop_building_button`); clicking it
must abort the build and surface a **"build stopped"** confirmation.

This is the canvas counterpart to `stop-button-playground.spec.ts` (which stops
from inside the Playground via `button-stop`). Both exercise the same backend
cancel path; this one asserts the cancel affordance exposed on the graph itself.

The guarantee matters because long-running or stuck builds must be interruptible
without reloading — losing the canvas stop button would strand the user on a
spinning build.

---

## Tags

`@stable` `@release` `@workspace` `@components`

`@stable` added by #687 after deterministic validation on the 1.11 nightly
(burst runs with `--retries=0` + executed force-fail per assert). This spec
replaces the previous fragile version (5 dragged legacy components + manual
connections + text/timeout waits, flagged `// TODO: fix this test`) with the
proven custom-component + `sleep(60)` recipe from `stop-button-playground.spec.ts`.

---

## Step by step

1. Bootstrap and open a blank flow.
2. Add a **Custom Component** via `addCustomComponent`, which clicks
   `sidebar-custom-component-button` and does not return until a node that was not
   on the canvas before is on it (see the #1301 note).
3. Add a **Chat Output** via the sidebar search + drag.
4. Open the custom component code editor and replace the body with a minimal,
   valid Component whose `build_output` calls `sleep(60)` — long enough that the
   build is reliably still running when we click stop. Check & Save.
5. Connect the custom component output handle to the Chat Output input handle.
6. Run the flow from the terminal node (`button_run_chat output`).
7. Assert the canvas stop control `stop_building_button` becomes visible (build
   is running).
8. Click it.
9. Assert the **"build stopped"** confirmation is visible.

---

## Validation criterion

| Step | Criterion |
|---|---|
| After connecting | exactly 1 `.react-flow__edge` exists |
| After run | `stop_building_button` is visible within 30 s (build running) |
| After stop | text **"build stopped"** is visible within 30 s |

---

## External dependencies

- `sidebar-custom-component-button` — sidebar control that drops a Custom
  Component; renaming breaks step 2. Clicked through `addCustomComponent`, never
  bare — Langflow swallows this click (#1301).
- `code-button-modal` / `.ace_content` / Check & Save — code editor round-trip,
  shared with `customComponentAdd.spec.ts` and the playground stop spec.
- `button_run_{terminalNode}` — per-node run control (Langflow 1.11 has no global
  run button); `stop_building_button` is the stop control that replaces it while
  running.
- `src/backend/base/langflow/api/v1/chat.py` (build/cancel endpoints) — owns the
  cancel path that emits "build stopped". A change there breaks step 9.

---

## What this test does not cover

- Stopping from inside the Playground — covered by `stop-button-playground.spec.ts`.
- Resuming a stopped build (Langflow has no resume; stop is terminal).
- Partial-result inspection after a stop.
- The stale `FlowEditorPage.stopFlow()` POM method (uses the non-existent
  `stop-building-button` hyphen testid and `button_run_flow`) — this spec targets
  the real `stop_building_button` directly. A one-line click does not warrant a
  helper (unlike `run-flow.ts`/`delete-component.ts`, which encapsulate real
  branching); extract one only if a second canvas-stop caller appears.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- No model provider credentials required (the sleep is pure Python).

---

## Notes

- **Teardown:** `trackCreatedFlows` captures every flow the page creates from its
  `POST /api/v1/flows → 201` responses and `afterEach` deletes those ids via the
  API. Targeted deletes (not `cleanAllFlows`), so it is safe under parallel runs.
  The one-time `Basic Prompting` flow created by the shared `awaitBootstrapTest` on
  a *freshly empty* instance is not owned by this spec and is left in place.
- The custom component's `sleep(60)` guarantees the build is still in flight when
  we assert/click stop — no race on a fast-completing build.
- Anchoring the stop affordance on `stop_building_button` (underscore) matches the
  live nightly and `chatInputOutputUser-shard-2.spec.ts`; the hyphenated POM
  variant is stale.
- **#1301 — `div-generic-node.nth(1)` timing out at 20 s was the ADD being
  swallowed, not an unclickable node.** Quarantined at triage #1296 as a recurrent
  flake (2026-07-14, 2026-08-05), grouped with
  `core-components/edit-name-description-node.spec.ts` on the shared observable.
  The grouping held on live re-measurement: both specs' first canvas action is a
  click on a node that `sidebar-custom-component-button` was supposed to have
  created, and on nightly `1.12.0.dev23` that click is swallowed — 0 of 26
  instrumented attempts ever had a node present that refused a click, while 9 of
  10 first clicks (40 s budget, repair suppressed) produced no node at all. Step 2
  now goes through `addCustomComponent`, which re-issues the click once and
  otherwise fails naming the swallowed add. `@stable` restored in the same PR.
- **Two further failures surfaced while validating #1301, both in this spec's own
  waits and both AT STEPS AROUND the add** — which is why the quarantine read as
  one bug. Each is now gated with the mechanism named:
  - *Canvas entry.* The `flow-builder-welcome-panel` overlay covers the canvas
    after `blank-flow` and `canvas_controls_dropdown` is not even in the DOM until
    it clears — up on 3 of 3 entries on `1.12.0.dev23`, with the controls
    appearing at ~1 s on one entry and ~10.6 s on another. The gate's 10 s budget
    failed 2 of 3 solo runs on a freshly created instance. The overlay is now
    waited out first (so a stuck overlay is reported as the overlay) and the
    budget is 30 s, matching `setupBlankFlow`.
  - *After Check & Save.* `adjustScreenView` clicks `canvas_controls_dropdown`
    while the code modal is still open, and the Radix overlay (`fixed inset-0
    z-50`) intercepts every pointer event on the canvas. Playwright reports the
    button "visible, enabled and stable" and retries to the 20 s actionability
    budget, so the failure named nothing — 1 of 3 combined runs, 41 retries of
    "subtree intercepts pointer events". The spec now asserts no open dialog
    remains before touching the canvas.
- **Teardown reworked to the shared tracker (#1108).** It captured ONE id, read
  off the canvas URL, which missed the flow `awaitBootstrapTest` creates on its
  way through the templates modal and captured nothing at all when a run died
  before that line: 5 orphan "New Flow"s survived 4 solo runs. Capturing every
  `POST /api/v1/flows → 201` covers both — 0 leaked flows across 13 runs since.
- Validated on `1.12.0.dev23` (2026-08-11): 4 of 5 solo passed (~9–35 s),
  `--workers=1 --retries=0`, 0 orphan flows on all 5; the one red is the
  attributed `[backend-unreachable]` page-entry barrier (the local container
  wedges after `collect-models`, #922/#927), not a spec failure. Force-fail
  executed: removing the `stop_building_button` click fails on the "build stopped"
  assertion after 30 s. The three waits above are force-failed by their own
  pre-fix measurements — the old code is the mutation, and it failed 2 of 3, 1 of
  3 and 5 orphans of 4 runs respectively.
- Supersedes the stale-handle break tracked in issue #298 (connections wired to a
  removed `ParseData` component after `Data to Message` superseded it). The rewrite
  drops that component chain entirely, so the stale-handle failure mode is gone.
