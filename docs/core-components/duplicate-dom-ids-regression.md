# Node Parameter DOM Ids — Uniqueness Across Sibling Nodes

**Last validated:** Langflow 1.12.x (pre-fix negative control on nightly `1.12.0.dev9`; passing build `1.11.1`, which carries langflow#14312)

---

## What this test validates *(required)*

Node parameter fields must not render duplicate DOM `id` attributes when two nodes on the same canvas expose a field with the same name.

Origin: LE-2037 / langflow-ai/langflow#14096. A field's `id` was derived from the template type/name alone, without the `nodeId`, so two nodes sharing a field name produced multiple elements carrying one `id` — a WCAG 4.1.1 (ID uniqueness) violation that also prevents browser autofill from resolving the field. Chrome surfaces it as *"Duplicate form field id in the same form"* in the DevTools **Issues** panel. Fixed upstream by langflow-ai/langflow#14312, which scopes the rendered DOM id by node (`<id>-<nodeId>`).

The test asserts **both halves** of that fix:

1. **Uniqueness** — no `input` / `textarea` / `select` on a two-node canvas shares an `id`.
2. **Test-id stability** — `data-testid` stays **unscoped** and still resolves to both nodes. This is the load-bearing half for this repository: 132 call sites across 45 specs select node fields by `data-testid`. If uniqueness were ever achieved by scoping the testid instead of the id, those specs would break en masse — and this assertion fails first, naming the cause.

If this test fails, either two nodes are colliding on a DOM id again (a renderer that does not call `getNodeScopedDomId`), or the scoping was applied to `data-testid` and this suite's entire selector strategy is about to break.

**Why this is worth covering here even though upstream ships its own test.** langflow#14312 adds `src/frontend/tests/core/regression/duplicateDomIds.spec.ts`, which runs in Langflow's CI against the PR's own code. This suite runs against **published images** — different net: theirs catches the author, ours catches what reached the user. Two properties make the regression likely enough to be worth the net: the fix is **opt-in** (`getNodeScopedDomId` is called manually at each `id={...}` site — 15 renderer files were edited one by one, and the sixteenth renderer someone adds will not call it), and `nodeId` is **optional with a silent fallback** to the unscoped id, so a renderer that merely fails to receive the prop regresses with no signal.

---

## Tags *(required)*

Both tests: `@stable` `@release` `@regression` `@components`
The Agent case additionally carries `@agents`.

No provider credentials and no LLM call: the nodes are placed and inspected, never executed. That is what makes an Agent case cheap enough for `@stable`.

---

## Step by step *(required)*

**Case A — two API Request nodes** (`StrRenderComponent` → `InputComponent` → `popover` id path)

1. `setupBlankFlow(page)` — create a blank flow via the REST API and open it; returns the flow id used for cleanup.
2. `addComponentFromSidebar(page, "API Request", "add-component-button-api-request")`, twice.
3. Assert `.react-flow__node` count is `2`; `adjustScreenView` for trace legibility.
4. Assert `popover-anchor-input-url_input` resolves to **2** elements — the test-id stability half, and the gate that prevents a vacuous pass on a half-mounted canvas.
5. Sweep `input[id], textarea[id], select[id]` in the page and assert no id appears more than once.

**Case B — two Agent nodes** (`TextAreaComponent` id path)

1. `setupBlankFlow(page)`.
2. Open the `disclosure-models & agents` sidebar section; drag `models_and_agentsAgent` onto `//*[@id="react-flow-id"]` at two distinct positions (the proven pattern from `agent-component-regression.spec.ts` — no `add-component-button-agent` testid exists).
3. Assert `.react-flow__node` count is `2`; `adjustScreenView`.
4. Assert `textarea_str_system_prompt` resolves to **2** elements.
5. Same duplicate-id sweep.

**afterEach (both cases)**

1. Navigate to `/` so the unmounted editor stops polling a flow about to be deleted — gated on the test having passed, because Playwright captures the on-failure screenshot after user hooks and navigating would archive the home page instead of the failed canvas.
2. `deleteFlow(request, id, { headers: { Authorization: bearer } })` for each flow created, id-scoped — never a global wipe (#553).

---

## Validation criterion *(required)*

| Assertion | Criterion |
|---|---|
| Both nodes mounted | `.react-flow__node` count is `2` |
| Both fields mounted (test-id stability) | the case's field testid resolves to `2` elements |
| No duplicate ids | the collected duplicate list is exactly `[]`; on failure the message names each offending `<id> x<count>` |

The sweep is **scoped to form controls** (`input` / `textarea` / `select`) on purpose. That is what the reported DevTools warning covers and what breaks autofill. Icon SVGs legitimately repeat their own internal ids (gradients, masks, filters) whenever the same icon renders twice — a distinct concern that must not fail this test for the wrong reason.

Measured behaviour on both sides of the upstream fix, two nodes on canvas:

| build | Case A duplicates | Case B duplicates |
|---|---|---|
| nightly `1.12.0.dev9` (pre-fix) | `popover-anchor-input-url_input x2` | `popover-anchor-input-input_value x2`, `textarea_str_system_prompt x2` |
| `1.11.1` (carries langflow#14312) | none — ids read `…-APIRequest-<suffix>` | none — ids read `…-Agent-<suffix>` |

In both builds the field **testid** resolved to 2 elements, which is the contract half staying green across the fix.

---

## External dependencies *(required)*

- `src/frontend/src/components/core/parameterRenderComponent/helpers/get-node-scoped-dom-id.ts` — the helper that scopes the DOM id by `nodeId`, introduced by langflow#14312. If removed or bypassed, this test fails.
- `src/frontend/src/components/core/parameterRenderComponent/index.tsx` — builds the base id from the template type/name and threads `nodeId` down to the renderers.
- `src/frontend/src/components/core/parameterRenderComponent/components/textAreaComponent/index.tsx` — renders the `textarea_str_*` fields the Agent case asserts; `id` scoped, `data-testid` unscoped.
- `src/frontend/src/components/core/parameterRenderComponent/components/inputComponent/index.tsx` and `.../components/popover/index.tsx` — render the `popover-anchor-input-*` fields the API Request case asserts. Any renderer added here that does not call `getNodeScopedDomId` reintroduces the defect.
- `src/frontend/src/types/components/index.ts` — declares the optional `nodeId` prop. The helper falls back to the unscoped id when it is absent, so a renderer that simply fails to receive the prop regresses silently.
- Sidebar add affordances — `sidebar-search-input`, `add-component-button-api-request`, `disclosure-models & agents`, `models_and_agentsAgent`.
- Node titles — `title-API Request`, `title-Agent` (rendered by `CustomNodes/GenericNode/components/NodeName`).
- React Flow canvas — `.react-flow__node` for node counting, `//*[@id="react-flow-id"]` as the drag drop target.
- Field testids — `popover-anchor-input-url_input`, `textarea_str_system_prompt`.
- `tests/helpers/flows/setup-blank-flow.ts` — API-based flow creation plus the id used for cleanup.

---

## What this test does not cover *(optional)*

- **`IntComponent` / `FloatComponent` / `ToggleShadComponent` id paths.** Upstream's own case uses `int_int_k` on WikipediaAPI. The only proven int field in this suite, `int_int_timeout` on API Request, is `advanced=True` and would have to be revealed per node (`parameters-button` mounts only for the currently-selected node), which is disproportionate for a first iteration.
- **Two *different* components sharing a field name** (e.g. OpenAI + Anthropic both exposing `api_key`). Same defect class, but it needs provider components whose availability varies by distribution (`lfx-bundles` is absent from `langflow-nightly:latest` — #1039), so the case would skip silently.
- **Three or more nodes.** Two proves the scoping; an N-node collision would require the scope itself to be non-unique, which `nodeId` guarantees it is not.
- **The inspector / edit-node surface.** Fields rendered in the parameters side panel carry an edit-mode prefix and are a separate id path.
- **Non-form-control ids.** A pre-fix sweep of *every* `[id]` also showed `other_tools x2` on the Agent canvas; it is not an `input`/`textarea`/`select`, so this test's form-control scope excludes it by design (see Validation criterion).
- **The unrelated, still-open** *"A form field element should have an id or name attribute"* DevTools info-level issue, present before and after this fix.
- **Actual browser autofill behaviour.** Not observable from Playwright; id uniqueness is the proxy.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` on a build that includes langflow#14312. On a pre-fix build both cases fail **by design** — that is the negative control, not a defect in the test.
- No model provider credentials required.

---

## When to review this test *(optional)*

- A new parameter renderer is added under `parameterRenderComponent/components/` — it must call `getNodeScopedDomId` or this test goes red.
- The suite's selector strategy changes, or someone proposes scoping `data-testid`. This test is the tripwire for that.
- The Agent or API Request node stops exposing the asserted field, in which case the `toHaveCount(2)` gate fails first and names it.

---

## Notes *(optional)*

- Chrome reports this defect through the CDP `Audits` domain that feeds the DevTools **Issues** panel — **not** the console. Neither `page.on("console")` nor the repo fixture's response monitor can observe it, which is why the check is an explicit DOM sweep rather than a listener.
- Node overlap is irrelevant: the sweep reads the DOM, not layout. The `adjustScreenView` calls exist only to keep failure traces legible.
- **Chat Input and Webhook are unsuitable subjects** — they are singletons, so adding one removes the other's sidebar `+` and they cannot be duplicated or pasted (which is why upstream had to build its ChatInput case through the API). **Prompt Template is also unsuitable**: its visible field is a prompt-modal surface, not a form control, and a two-node Prompt Template canvas produces no duplicate-id warning at all.
- Sibling specs place two identical nodes but assert only node counts, so none of them would catch this: `ui-ux/langflowShortcuts.spec.ts` (duplication via shortcuts — its header comment states Chat Output was chosen *because* it carries no text field) and `flow-functionality/canvas-copy-paste.spec.ts` (paste of a second Prompt Template). `core-components/chat-input-output-component-regression.spec.ts` actually hit this ambiguity — Chat Input and Chat Output both render `popover-anchor-input-sender_name` — diagnosed it as "DOM ordering", and worked around it with a node-scoped filter.
