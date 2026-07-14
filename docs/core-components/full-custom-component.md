# Full Custom Component — Build a Component From Code (§2.4 Code Editing)

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates that a **fully-authored Custom Component** — Python code that declares
its own `display_name`, a named input, and a named output — is compiled by
**Check & Save** into a working node whose on-canvas interface matches what the
code declared. This is the "full custom component" contract (§2.4): not just
that the code saves (that is the sibling pulse-pink spec), but that the saved
code actually **produces a component with the declared surface**.

After adding a Custom Component and replacing the scaffold with code declaring
`display_name = "My Full Component"`, an input `display_name="My Input"`, and an
output `display_name="My Output"`, the node must render:

1. its declared title — `title-My Full Component`;
2. its declared input field — labeled **"My Input"** with an editable value
   control;
3. its declared output handle — `handle-myfullcomponent-shownode-my output-right`;
4. a run affordance — `button_run_my full component`.

If this breaks, user-authored component code could Check-&-Save "successfully"
yet not materialize the declared inputs/outputs — a silently broken component
that fails only later when wired into a flow.

---

## Tags *(required)*

`@stable` `@release` `@components`

---

## Preconditions *(required)*

- Langflow running at `PLAYWRIGHT_BASE_URL` with **`LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true`**.
  The nightly image ships this flag **`false`** by default (a security default
  — custom-component creation is disabled), which hides the
  `sidebar-custom-component-button` and makes `POST /api/v1/custom_component`
  return `403 "Custom component creation is disabled"`. The E2E instance (local
  scripts + CI service) sets the flag `true` so the feature is exercised — see
  Notes.
- No model provider credentials required — the component is a pure
  `MessageTextInput → Message` passthrough; nothing calls an LLM.

---

## Step by step *(required)*

1. Bootstrap the app (`awaitBootstrapTest`) and open a blank flow.
2. Click `sidebar-custom-component-button` to drop a Custom Component.
3. Open the code editor (`code-button-modal`), select all, and fill the Ace
   editor with a full Custom Component class declaring `display_name =
   "My Full Component"`, an input `MessageTextInput(name="input_value",
   display_name="My Input")`, and an output `Output(display_name="My Output",
   name="output", method="build_output")` returning a `Message`.
4. Click **Check & Save**.
5. Assert the node materialized its declared interface (below).

The flow this page creates is captured from its `POST /api/v1/flows → 201`
response and deleted id-scoped in `afterEach`.

---

## Validation criterion *(required)*

After Check & Save, all of the following are visible / present within 10 s,
each derived directly from the submitted code:

| Observable | Proves |
|---|---|
| `title-My Full Component` | the declared `display_name` drove the node title |
| text **"My Input"** (`title-my input`) | the declared input rendered as a field |
| `handle-myfullcomponent-shownode-my output-right` | the declared output produced a real output handle |
| `button_run_my full component` | the compiled component is runnable |

Each assertion targets a distinctive, code-derived identifier — none of these
strings exist in the default scaffold, so a component that failed to adopt the
submitted code fails the assertions deterministically. This is strictly
stronger than, and distinct from, the pulse-pink save-round-trip spec
(`customComponentAdd.spec.ts`).

---

## External dependencies *(required)*

- `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` on the running instance (see
  Preconditions / Notes).
- `data-testid="sidebar-custom-component-button"` — sidebar footer "New Custom
  Component" button (present only when the flag is on).
- `data-testid="code-button-modal"` — the node's code editor trigger.
- `.ace_content` + `textarea` — the Ace editor and its textarea mirror inside
  the code modal.
- **"Check & Save"** button text — compiles and saves the code.
- `title-<display_name>` / `title-<input display_name>` /
  `handle-<name>-shownode-<output display_name>-right` /
  `button_run_<display_name>` — node interface testids, all keyed off the
  code-declared names (lower-cased for input/handle/run testids).

---

## What this test does not cover *(optional)*

- The pulse-pink unsaved-code indicator round-trip — covered by
  `customComponentAdd.spec.ts`.
- Executing the component and asserting the output value. The node preserves the
  scaffold's field value across a code edit (it does not adopt the new code's
  default `value=`), so a run's output value is not a deterministic observable;
  the interface materialization is asserted instead.
- Connecting the custom component to other nodes / running a full flow.
- Code validation errors (invalid Python) — a separate negative case.
- Behavior when `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` (feature disabled) — the
  spec runs with the feature enabled.

---

## Notes *(optional)*

- **Feature-flag dependency (root cause of the infra change shipped with this
  spec).** On nightly `1.11.0.dev42` the image sets
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=false` by default. With it off: the sidebar
  "New Custom Component" button is not rendered (its footer slot shows "Discover
  more components"/Bundles), and `POST /api/v1/custom_component` returns
  `403 "Custom component creation is disabled"`. This silently broke two
  existing `@stable` specs on the daily (`customComponentAdd.spec.ts`,
  `api-custom-component-creation.spec.ts`). This spec's PR adds
  `LANGFLOW_ALLOW_CUSTOM_COMPONENTS=true` to the E2E instance (CI service
  containers + `scripts/start-langflow-docker.sh`) so the custom-component
  surface is exercised, restoring the two broken specs and enabling this one.
  Verified live on 1.11.0.dev42: with the flag on, the button returns, the
  component materializes with the declared interface, and
  `customComponentAdd.spec.ts` passes 1/1.
- **Field value is not asserted.** Scouted live: after Check & Save of new code,
  the node keeps the scaffold's `input_value` ("Hello, World!") rather than the
  new code's `value=`; the declared *names* (title/input/output) do update. The
  criterion therefore asserts the declared interface, not the value.
- **Flow cleanup.** The added component lives in a flow whose id is captured from
  `POST /api/v1/flows → 201` (a bare `page.url()` races the bootstrap flow's
  stale id — #490/#681) and deleted in `afterEach`.
