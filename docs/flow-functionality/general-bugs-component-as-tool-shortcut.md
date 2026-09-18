# Spec: The Tool Mode shortcut works only while the component declares a `tool_mode=True` input

**Test file:** `tests/tests-automations/regression/flow-functionality/general-bugs-component-as-tool-shortcut.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev16`)

---

## What this test validates

A component can be put in Tool Mode — from the toolbar's `tool-mode-button` or with the
`Ctrl/Cmd+Shift+M` shortcut — only while its template qualifies: `checkHasToolMode`
answers true when at least one input declares `tool_mode=True` (or the component has no
inputs at all, or is already in Tool Mode). The Prompt Template declares exactly one such
input, `tool_placeholder`.

The test proves both sides on the same node:

1. **Offered** — with the stock Prompt Template selected, the toolbar shows
   `tool-mode-button`; the shortcut posts `POST /api/v1/custom_component/update` and the
   node renders its `Toolset` output; a second press takes it back out.
2. **Withdrawn** — after the node's code is saved with that input changed to
   `tool_mode=False` (Check & Save, `POST /api/v1/custom_component` → 200), the toolbar
   shows the Freeze button (`freeze-all-button-modal`) in place of `tool-mode-button`, and
   the same shortcut sends **no** `POST /api/v1/custom_component/update` and renders no
   `Toolset`.

The node is taken back out of Tool Mode before the code edit on purpose: the final
check must be unable to pass by toggling Tool Mode **off**, so it starts from a node that
is not in Tool Mode.

---

## Tags

`@stable` `@release` `@components` `@ui-ux`

`@ui-ux` is the functional area: the node toolbar and a keyboard shortcut.

---

## Step by step

1. Create over the API a flow holding one Prompt Template built from the live
   `GET /api/v1/all` catalog (`build-catalog-flow`), and open it with `openFlowById`. The
   flow id is deleted id-scoped in `afterEach`, after leaving the editor with
   `unmountEditorForCleanup`.
2. Assert `Toolset` count 0. Click `title-Prompt Template` — assert `tool-mode-button`
   visible.
3. Press `ControlOrMeta+Shift+M` — assert a `POST /api/v1/custom_component/update` is
   sent and `Toolset` renders. Press it again — assert `Toolset` count 0.
4. Open the code editor (`code-button-modal`). The code is the catalog's own (step 1
   built the node from it): assert it contains `tool_mode=True` exactly once, replace it
   with `tool_mode=False`, and click **Check & Save** (`checkAndSaveBtn`). Assert the save
   request — `POST /api/v1/custom_component`, matched on the pathname — answers 200 and the
   editor closes.
5. Click `title-Prompt Template` — assert `freeze-all-button-modal` visible and
   `tool-mode-button` count 0.
6. Arm a listener for `POST /api/v1/custom_component/update`, press
   `ControlOrMeta+Shift+M`, and assert no such request within 5 s and `Toolset` count 0.

---

## Validation criterion

| Claim | Observable |
|---|---|
| Tool Mode is offered while `tool_mode=True` is declared | `tool-mode-button` visible (step 2) |
| The shortcut toggles it | refresh request sent + `Toolset` visible; `Toolset` count 0 after the second press |
| The code change was accepted | `POST /api/v1/custom_component` → 200; `checkAndSaveBtn` hidden |
| Tool Mode is withdrawn | `freeze-all-button-modal` visible **and** `tool-mode-button` count 0 |
| The shortcut is inert | no `POST /api/v1/custom_component/update` within 5 s of the key press; `Toolset` count 0 |

The negative in step 6 is calibrated by step 3: the same key press on the same node did
send the refresh request while Tool Mode was offered.

The test fails if the shortcut or the button stays available after the component stops
declaring a Tool Mode input, if the shortcut stops working on a component that declares
one, or if Check & Save rejects the edited code.

---

## External dependencies

- `src/frontend/src/utils/reactflowUtils.ts` — `checkHasToolMode`
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/hooks/use-toolbar-node-state.ts`
  — `hasToolMode`
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/components/ToolbarButtonRow.tsx`
  — `tool-mode-button` vs `freeze-all-button-modal`
- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/index.tsx` — the
  `Ctrl/Cmd+Shift+M` handler (`handleActivateToolMode`)
- `src/frontend/src/modals/codeAreaModal/index.tsx` — the code editor and `checkAndSaveBtn`
- `src/backend/base/langflow/api/v1/endpoints.py` — `POST /api/v1/custom_component`
  (validates and rebuilds the edited code) and `POST /api/v1/custom_component/update`
- `src/lfx/src/lfx/components/models_and_agents/prompt.py` — the one `tool_mode=True`
  input the test flips
- `tests/helpers/flows/build-catalog-flow.ts` — builds the node from the live catalog
- `src/backend/base/langflow/api/v1/custom_component_policy.py` —
  `resolve_component_code_for_action`: with custom components disabled, only code whose
  hash matches a known template passes, so the edited code is refused
- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` — saving edited component code goes through
  `POST /api/v1/custom_component`, which answers 403 with the image default (`false`)

---

## What this test does not cover

- Repeated on/off toggling and the Tool Mode outputs of a running component —
  `core-components/tool-mode.spec.ts`.
- Editing the tool list of a component in Tool Mode — `core-components/edit-tools.spec.ts`.
- Tool Mode on a Group node — `core-components/toolModeGroup.spec.ts`.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` with `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`
  (set by `scripts/start-langflow-docker.sh` and every CI lane). No provider key.

---

## Notes

- **Wave 9 T2 triage, issue #1911 — outcome PROMOTE.** Row in
  `docs/triage/inherited-spec-triage.md`: T2,
  `flow-functionality/general-bugs-component-as-tool-shortcut.spec.ts`, 0/3 green.
- **Why it failed (drift, not product).** Measured on `1.13.0.dev16`: it died at
  `page.waitForResponse("**/custom_component")` (20 s). The save still happens and still
  answers 200 — but the frontend now sends `POST /api/v1/custom_component?flow_id=<id>`,
  and a glob matches the whole URL, query string included, so it never matched. Same
  class as #1644; the request is now matched on its pathname.
- **Why DELETE was not available.** `core-components/tool-mode.spec.ts` toggles Tool Mode
  on a component that offers it; no `@stable` test asserts that Tool Mode is **withdrawn**
  from a component whose inputs stop declaring it.
- Hardening for the promotion: (a) the inherited file reached the canvas through
  `awaitBootstrapTest` + `blank-flow` and deleted nothing — **3 flows leaked per run** on an
  empty project, read by diffing `GET /api/v1/flows/` around one run; it now creates one
  flow over the API and deletes that id; (b) the final "no Toolset" read happened right
  after the key press, so it could not tell an inert shortcut from a slow one — it is now
  paired with the absence of the refresh request, calibrated by step 3; (c) the node is
  taken out of Tool Mode before the edit, so the final check cannot pass by toggling off;
  (d) the code is edited from the catalog's source rather than scraped from the editor's
  DOM.
- `docs/ui-ux/minimize.md` cites this spec for the `Toolset` absent-then-present
  assertion; its path read `core-components/`, corrected to `flow-functionality/`.
