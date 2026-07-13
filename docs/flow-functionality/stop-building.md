# Spec: Stop (pause) a running flow build from the canvas

**Test file:** `tests/tests-automations/regression/flow-functionality/stop-building.spec.ts`

**Last validated:** Langflow 1.11.x

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
2. Add a **Custom Component** via `sidebar-custom-component-button`.
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
  Component; renaming breaks step 2.
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

- **Teardown:** the test captures the created flow's id from the `/flow/{id}` URL
  and an `afterEach` deletes only that flow via the API (auto_login token). It is a
  targeted delete (not `cleanAllFlows`), so it is safe under parallel runs and does
  not leak flows across repeated runs. The one-time `Basic Prompting` flow created
  by the shared `awaitBootstrapTest` on a *freshly empty* instance is not owned by
  this spec and is left in place.
- The custom component's `sleep(60)` guarantees the build is still in flight when
  we assert/click stop — no race on a fast-completing build.
- Anchoring the stop affordance on `stop_building_button` (underscore) matches the
  live nightly and `chatInputOutputUser-shard-2.spec.ts`; the hyphenated POM
  variant is stale.
- Supersedes the stale-handle break tracked in issue #298 (connections wired to a
  removed `ParseData` component after `Data to Message` superseded it). The rewrite
  drops that component chain entirely, so the stale-handle failure mode is gone.
