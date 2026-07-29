# Freeze and State — freeze component, freeze path, unfreeze

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

The three `QA-CHECKLIST.md` §15.7 *Freeze and State* behaviors, on the canvas:

1. **Freeze component** — freezing a component marks it frozen and makes it **reuse its
   cached output instead of recomputing**. This is the substance of the feature: freeze is
   an execution-cache control, not a visual state.
2. **Freeze path** — freezing a component also freezes **every component upstream of it**.
3. **Unfreeze component** — the same control toggles the state back off, across the whole
   path, and the component recomputes again.

If these fail, freeze is either not applied, not persisted, or — worse — reported as
applied while the component still recomputes, which silently defeats the only reason to
use it.

### The product's freeze contract (measured on 1.12.0.dev8)

Measured live before writing this spec, because the surface is easy to misread:

| Fact | Measurement |
|---|---|
| **There is exactly ONE freeze affordance** | Labelled **`Freeze`**, shortcut `F`. There is **no** separate "Freeze Path" entry |
| Its **location depends on the component** | One testid, `freeze-all-button-modal` (inner `freeze-path-button`, icon `icon-FreezeAll`), rendered in **exactly one** of two places. From `nodeToolbarComponent/index.tsx`: `{!hasToolMode && <ToolbarButton … />}` and `{hasToolMode && <SelectItem value="freezeAll" …>}` — mutually exclusive. A **tool-mode** component (`Prompt Template`) exposes Freeze **only in its right-click menu**; a component **without** tool mode (`Language Model`) **only in its selection toolbar`**. Verified in both directions: selecting the Prompt Template yields 0 controls in the toolbar, selecting the Language Model yields 1, and the Language Model's context menu has 7 entries with no Freeze |
| Its semantics are **path** freeze | Freezing a node sets `frozen: true` on that node **and on all of its upstream ancestors** |
| Freezing an upstream-most node | Freezes only itself — its path is itself. This is what makes checklist items 1 and 2 the *same control*, distinguished by topology |
| It toggles | The same control unfreezes. The label stays `Freeze` while frozen — it never reads "Unfreeze" |
| Unfreezing downstream | Unfreezes the whole path, symmetrically |
| Persisted at | `data.nodes[].data.node.frozen` (boolean), written immediately |
| Canvas indicator | one `icon-Snowflake` per frozen node. **`icon-FreezeAll` is the control's own icon, not a canvas indicator** — with a node frozen and no menu open, `icon-Snowflake` = 1 and `icon-FreezeAll` = 0 |

The last row is the trap that made the inherited spec a false green (see **Notes**).

---

## Tags *(required)*

`@release` `@regression` `@components` `@workspace` `@ui-ux`

`@components` / `@workspace` (cross-cutting — canvas component state) · `@ui-ux`
(functional area). `@stable` is added only after the team validation run; the three
inherited specs this replaces carried **no** functional tag at all.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- **No API key required.** The cache proof runs a `Prompt Template` on its own, whose
  output is deterministically its own template text — no provider, no model call. This is
  a deliberate design choice; see **What this test does not cover**.
- The flow is created via `POST /api/v1/flows/` from the committed
  `two-non-io-connected.json` asset (Prompt Template → Language Model) and deleted in
  `afterEach` regardless of outcome.

---

## Step by step *(required)*

**Test 1 — freezing a component makes it serve its cached output instead of recomputing**
1. Create the two-node flow via the API and open it from the flows list
2. Run the `Prompt Template` on its own (`button_run_prompt template`) and read its output
   through `output-inspection-prompt-prompt` — it equals the current template text (call it
   **A**)
3. Edit the template through `button_open_prompt_modal` →
   `modal-promptarea_prompt_template` → `genericModalBtnSave`, setting a distinct sentinel
   (**B**). Confirm through `GET /api/v1/flows/{id}` that the stored template value is now B
4. Freeze the Prompt Template from its **right-click menu** — asserting first that its
   toolbar carries no freeze control, which locks the `hasToolMode` placement rule
5. Assert the frozen state: one `icon-Snowflake` on the canvas, and polled from the
   backend, `frozen: true` on the Prompt node and `false` on the Language Model
6. Run the Prompt Template again and read its output — it must still be **A**. The stored
   input is B, so serving A proves the cached result was reused rather than recomputed

**Test 2 — freezing a component freezes the whole upstream path**
1. Create the two-node flow and open it
2. Confirm both nodes start at `frozen: false`
3. Freeze the **downstream** `Language Model` from its **selection toolbar** (it has no
   tool mode, so its Freeze entry lives there and not in the context menu)
4. Assert **two** `icon-Snowflake` on the canvas and, polled from the backend, `frozen:
   true` on **both** nodes — the upstream Prompt Template was frozen by association, which
   is the path semantics

**Test 3 — unfreezing releases the whole path and the component recomputes**
1. Reach the frozen-path state of Test 2, with the template already set to sentinel B and
   a cached output of A
2. Click the same control on the downstream node again
3. Assert zero `icon-Snowflake` and, polled from the backend, `frozen: false` on **both**
   nodes
4. Run the Prompt Template — its output is now **B**, proving it recomputed from the
   current input rather than serving the stale cache

---

## Validation criterion *(required)*

- **Frozen ⇒ stale output.** With the stored template equal to B and the node frozen, a run
  returns A. This is the only assertion that distinguishes a working freeze from a freeze
  that merely renders an icon
- **Unfrozen ⇒ fresh output.** The same run after unfreezing returns B
- Every DOM assertion is paired with a persisted-state assertion polled from
  `GET /api/v1/flows/{id}` (`data.node.frozen`), because canvas autosave is debounced
- Path semantics are asserted on **both** nodes at once, never on the clicked node alone —
  asserting only the clicked node would pass identically for a component-only freeze

---

## External dependencies *(required)*

- `src/frontend/src/pages/FlowPage/components/nodeToolbarComponent/index.tsx` — owns the
  `freeze-all-button-modal` entry **and the `hasToolMode` condition that decides whether it
  renders in the toolbar or in the right-click menu**. A rename, a split into two entries
  ("Freeze" vs "Freeze Path"), or a change to that condition breaks these tests — and each
  of those is itself the finding, which is why the placement is asserted rather than
  worked around with a `.first()`
- The build/caching layer that honours `frozen` when a component is run — the behavioural
  assertions fail if freezing stops short-circuiting the rebuild
- `tests/assets/flows/two-non-io-connected.json` — committed flow asset (Prompt Template →
  Language Model, explicit positions), shared with
  `core-components/nested-grouping-regression.spec.ts`

---

## What this test does not cover *(optional)*

- **The freeze cache through a real model call.** The deleted `freeze-path.spec.ts` proved
  path caching end-to-end with OpenAI (run, change prompt, run, freeze, run, assert the
  2nd and 3rd replies are identical). That is genuine extra signal, but it needs
  `OPENAI_API_KEY`, costs ~20 s per run, and it **failed in a batch run while passing in
  isolation** during the #943 baseline — a contention flake. The deterministic Prompt
  Template proof asserts the same property (frozen ⇒ cached) causally, in seconds, with no
  provider. Restore an LLM-backed variant only if a defect is found that the deterministic
  proof cannot see
- Freezing a selection of several components at once
- Freeze interaction with the Playground (these tests drive per-component runs)
- The keyboard shortcut `F` — the tests drive the toolbar entry

---

## When to review this test *(optional)*

- If the freeze affordance is split into separate "Freeze" and "Freeze Path" controls, or
  the shared `freeze-all-button-modal` testid is disambiguated between the toolbar and the
  context menu
- If `frozen` moves off `data.node` in the persisted flow schema
- If running a single component from its node stops being possible

---

## Notes *(optional)*

### Product observation — an untranslated i18n key in the output panel

The output-inspection textarea renders `placeholder="common.empty"` — the raw i18n key,
not the resolved string `Empty`. Measured on 1.12.0.dev8. It is cosmetic and outside §15.7,
so no assertion here depends on it, but it is a real localisation defect and it is the
reason the inherited spec's `getByPlaceholder("Empty")` still matched: Playwright's
placeholder matching is substring and case-insensitive, so `"Empty"` matches
`"common.empty"` by accident.

### Three inherited specs deleted by #943

Per-test disposition, so the removal is auditable:

| Deleted test | Why |
|---|---|
| `freeze.spec.ts` → *user must be able to freeze a component* | **Asserts the opposite of the product's behaviour and passes anyway.** After freezing it expects the run to return the *new* input; the product correctly returns the cached one. Reproduced its exact scenario (legacy toggle, `Text Input`, toolbar freeze): the freeze applies (`frozen: true` persisted, one `icon-Snowflake`) and the run returns the **old** value. The spec cannot notice, because it asserts `icon-FreezeAll` — the control's icon, present only while the toolbar is open — instead of the canvas `icon-Snowflake`, and reads the output through a placeholder that no longer exists |
| `freeze-path.spec.ts` → *user must be able to freeze a path* | Semantically the **correct** test, and the only one that asserted the caching property. Dropped for its cost profile, not its logic: requires `OPENAI_API_KEY`, ~20 s per run, `waitForTimeout(2000)`, `getByText("Freeze").first()`, no flow cleanup, and it failed in the baseline batch while passing in isolation. Its property is preserved deterministically by Tests 1 and 3 |
| `freeze-unfreeze-component.spec.ts` → *frozen component shows frozen indicator, clicking again unfreezes it* | Asserts only the CSS class `text-blue-500` on the button — no canvas indicator, no persisted state, no behaviour. Red on 1.12 |
| `freeze-unfreeze-component.spec.ts` → *freeze button toggles on each click* | Near-duplicate of the previous test, same CSS-only observable. Red on 1.12 |
| `freeze-unfreeze-component.spec.ts` → *frozen component can still be selected* | Tracks **no** §15.7 checklist item; asserts a node can be selected, which is §15.4 |

Baseline on 1.12.0.dev8: **3 failed, 2 passed**, and 5 flows leaked (none of the three
files deleted the flows it created). None carried `@stable`, so the daily never ran them
and the redness was invisible.

### Why the fixture is Prompt Template

`Text Input` — the component the old `freeze.spec.ts` used — is `legacy: true` on 1.12 and
absent from the default sidebar; that spec had to switch the sidebar legacy toggle on to
reach it. That toggle is a **persisted user setting** and its own test surface
(`core-components/legacy-components-toggle-regression.spec.ts`), so flipping it inside an
unrelated spec is a side effect this file deliberately avoids. `Prompt Template` is
non-legacy, runs standalone, and its output is deterministically its own template text —
which is precisely what makes the cache assertion possible without a model.
