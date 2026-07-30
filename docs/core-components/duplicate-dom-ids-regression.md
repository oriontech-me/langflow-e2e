# Node Parameter DOM Ids — Uniqueness Across Sibling Nodes

**Last validated:** Langflow 1.11.x — validated against a build carrying langflow#14312 (see *Preconditions*; the fix has **not** reached the 1.12 line yet, where both cases fail by design)

---

## What this test validates *(required)*

Node parameter fields must not render duplicate DOM `id` attributes when two nodes on the same canvas expose a field with the same name.

Origin: LE-2037 / langflow-ai/langflow#14096. A field's `id` was derived from the template type/name alone, without the `nodeId`, so two nodes sharing a field name produced multiple elements carrying one `id` — a WCAG 4.1.1 (ID uniqueness) violation that also prevents browser autofill from resolving the field. Chrome surfaces it as *"Duplicate form field id in the same form"* in the DevTools **Issues** panel. Fixed upstream by langflow-ai/langflow#14312, which scopes the rendered DOM id by node (`<id>-<nodeId>`).

The test asserts **both halves** of that fix, per field:

1. **Uniqueness** — the two elements sharing a field testid carry distinct, non-empty DOM ids, and no form control anywhere on the canvas shares an id.
2. **Test-id stability** — `data-testid` stays **unscoped** and still resolves to both nodes. This is the load-bearing half for this repository: 132 call sites across 45 specs select node fields by `data-testid`. If uniqueness were ever achieved by scoping the testid instead of the id, those specs would break en masse — and this spec fails first, naming the cause.

If this test fails, either two nodes are colliding on a DOM id again (a renderer that does not call `getNodeScopedDomId`), or the scoping was applied to `data-testid` and this suite's entire selector strategy is about to break.

**Why cover this here when upstream ships its own test.** langflow#14312 adds `src/frontend/tests/core/regression/duplicateDomIds.spec.ts`, which runs in Langflow's CI against the PR's own code. This suite runs against **published images** — different net: theirs catches the author, ours catches what reached the user. Two properties make the regression likely enough to be worth the net: the fix is **opt-in** (`getNodeScopedDomId` is called manually at each `id={...}` site — 15 renderer files were edited one by one), and `nodeId` is **optional with a silent fallback** to the unscoped id, so a renderer that merely fails to receive the prop regresses with no signal.

---

## Tags *(required)*

Case A: `@regression` `@components` · Case B: `@regression` `@components` `@agents`

**`@stable` is deliberately absent, and this is the reason.** The upstream fix landed on the **`release-1.11.2`** branch (PR merged 2026-07-29). `langflowai/langflow-nightly:latest` — the image `daily-stable.yml` runs against — is built from the highest `release-*` branch, currently `release-1.12.0`, where the helper `get-node-scoped-dom-id.ts` is **verifiably absent** (it 404s on both `main` and `release-1.12.0`). Both cases therefore hard-fail on today's nightly *by design*. Tagging them `@stable` would open a `daily-failure` issue every weekday and trigger the `auto-remove-stable` path, which would strip the tag and commit to `main` — burning triage cycles to rediscover something already known.

`@stable` should be added once the fix reaches `main` / the 1.12 line and a run against the nightly confirms both cases green. Verify with:

```bash
gh api repos/langflow-ai/langflow/contents/src/frontend/src/components/core/parameterRenderComponent/helpers/get-node-scoped-dom-id.ts?ref=main --jq .sha
```

`@release` is also deliberately absent: this is a DOM-contract / accessibility regression guard, not a happy-path flow required before a deploy.

---

## Step by step *(required)*

**Case A — two API Request nodes** (`StrRenderComponent` → `InputComponent` → `popover` id path)

1. `setupBlankFlow(page)` — create a blank flow via the REST API and open it; returns the flow id used for cleanup.
2. `addComponentFromSidebar(page, "API Request", "add-component-button-api-request")`.
3. Gate on `title-API Request` being visible before adding the second node — the sidebar click is fire-and-forget, and asserting the count immediately can observe 1 while the second node is still mounting.
4. Add the second API Request the same way; assert `.react-flow__node` count is `2`.
5. Read the `id` of every element matching `popover-anchor-input-url_input` and assert: exactly 2 elements, both with a non-empty id, and the two ids distinct.
6. Sweep `input[id], textarea[id], select[id]` **inside the canvas** and assert no id appears more than once.

**Case B — two Agent nodes** (`TextAreaComponent` id path)

1. `setupBlankFlow(page)`.
2. Open the `disclosure-models & agents` sidebar section; drag `models_and_agentsAgent` onto `//*[@id="react-flow-id"]` at two distinct positions (the proven pattern from `agent-component-regression.spec.ts` — no `add-component-button-agent` testid exists).
3. Assert `.react-flow__node` count is `2`.
4. Same id assertions as step 5 above, for `textarea_str_system_prompt`.
5. Same canvas-scoped duplicate sweep.

The two tests are **not** serial: they drive independent flows with unique generated names and share no state. Independence is deliberate — under `mode: "serial"` a failure in case A would *skip* case B, leaving no verdict for it at all.

**afterEach (both cases)**

1. Navigate to `/` so the unmounted editor stops polling a flow about to be deleted — gated on the test having passed, because Playwright captures the on-failure screenshot after user hooks and navigating would archive the home page instead of the failed canvas.
2. `deleteFlow(request, id, { headers: { Authorization: bearer } })` for each flow created, id-scoped — never a global wipe (#553). A failed delete is logged, not swallowed.

---

## Validation criterion *(required)*

| Assertion | Criterion |
|---|---|
| Both nodes mounted | `.react-flow__node` count is `2` |
| Test-id stability | the field testid resolves to exactly `2` elements |
| Ids exist | both elements carry a non-empty `id` — guards the vacuity path where a dropped `id` attribute would empty the sweep and pass for the wrong reason |
| Ids distinct | `new Set(ids).size === 2` |
| No duplicates on the canvas | the collected duplicate list is exactly `[]`; on failure the message names each offending `<id> x<count>` |

Measured behaviour on both sides of the upstream fix, two nodes on canvas:

| build | Case A duplicates | Case B duplicates |
|---|---|---|
| nightly `1.12.0.dev9` (pre-fix) | `popover-anchor-input-url_input x2` | `popover-anchor-input-input_value x2`, `textarea_str_system_prompt x2` |
| build carrying langflow#14312 | none — ids read `…-APIRequest-<suffix>` | none — ids read `…-Agent-<suffix>` |

In both builds the field **testid** resolved to 2 elements — the contract half staying green across the fix.

### Scope of the sweep, and what that costs

**Canvas-scoped, not document-scoped.** The parameters side panel renders the same field with the **same DOM id** as the node body: `popover/index.tsx` applies `getNodeScopedDomId(id, nodeId)` unconditionally, and only `data-testid` gets the `-edit` suffix in edit mode. A document-wide sweep would therefore report a duplicate whenever that panel is open for a selected node — a false failure with no LE-2037 regression behind it. Scoping to `#react-flow-id` also excludes app-chrome and portal noise. The sweep throws if the canvas root is missing, so a selector change surfaces as an error instead of an empty list that would pass vacuously.

**Form controls only** (`input` / `textarea` / `select`) — what the DevTools warning covers, what breaks autofill, and what upstream's own regression test sweeps. Icon SVGs legitimately repeat their internal ids (gradients, masks, filters) whenever the same icon renders twice and must not fail this test for the wrong reason. **The cost is real:** of the 15 `id=` sites langflow#14312 edited, those whose id lands on a `span`, a `div`, a contenteditable `div` or a Radix `button[role="switch"]` — `promptComponent`, `mustachePromptComponent`, `accordionPromptComponent`, `emptyParameterComponent`, `toggleShadComponent` — are **not** reached by this sweep. The per-field assertions cover the two paths this spec claims regardless of element type; the broader sweep is a bonus net over form controls only. (`select[id]` is defensive: Langflow renders Radix Select, not a native `<select>`.)

---

## External dependencies *(required)*

- `src/frontend/src/components/core/parameterRenderComponent/helpers/get-node-scoped-dom-id.ts` — the helper that scopes the DOM id by `nodeId`, introduced by langflow#14312. If removed or bypassed, this test fails.
- `src/frontend/src/components/core/parameterRenderComponent/index.tsx` — builds the base id from the template type/name and threads `nodeId` down to the renderers.
- `src/frontend/src/components/core/parameterRenderComponent/components/textAreaComponent/index.tsx` — renders the `textarea_str_*` fields the Agent case asserts; `id` scoped, `data-testid` unscoped.
- `src/frontend/src/components/core/parameterRenderComponent/components/strRenderComponent/index.tsx` — routes single-line string fields and forwards `nodeId`.
- `src/frontend/src/components/core/parameterRenderComponent/components/inputComponent/index.tsx` and `.../components/popover/index.tsx` — render the `popover-anchor-input-*` fields the API Request case asserts. Any renderer added here that does not call `getNodeScopedDomId` reintroduces the defect.
- `src/frontend/src/types/components/index.ts` — declares the optional `nodeId` prop. The helper falls back to the unscoped id when it is absent, so a renderer that simply fails to receive the prop regresses silently.
- Sidebar add affordances — `sidebar-search-input`, `add-component-button-api-request`, `disclosure-models & agents`, `models_and_agentsAgent`.
- Node titles — `title-API Request` (rendered by `CustomNodes/GenericNode/components/NodeName`).
- React Flow canvas — `.react-flow__node` for node counting, `#react-flow-id` as both the sweep root and the drag drop target.
- Field testids — `popover-anchor-input-url_input`, `textarea_str_system_prompt`.
- `tests/helpers/flows/setup-blank-flow.ts` — API-based flow creation plus the id used for cleanup.

---

## What this test does not cover *(optional)*

- **Renderers whose id lands on a non-form-control element** — see *Scope of the sweep* above. The two asserted fields are covered directly; the other renderers are not.
- **`IntComponent` / `FloatComponent` id paths.** Upstream's own case uses `int_int_k` on WikipediaAPI. The only proven int field in this suite, `int_int_timeout` on API Request, is `advanced=True` and would have to be revealed per node (`parameters-button` mounts only for the currently-selected node), which is disproportionate here.
- **Two *different* components sharing a field name** (e.g. OpenAI + Anthropic both exposing `api_key`). Same defect class, but it needs provider components whose availability varies by distribution (`lfx-bundles` is absent from `langflow-nightly:latest` — #1039), so the case would skip silently.
- **Three or more nodes.** Two proves the scoping; an N-node collision would require the scope itself to be non-unique, which `nodeId` guarantees it is not.
- **The parameters side panel.** It shares the node body's DOM id by design (only the testid differs), so it is excluded from the sweep rather than asserted — covering it would require deciding whether that shared id is itself a defect, which is out of scope here.
- **Non-form-control ids on the canvas.** A pre-fix sweep of every `[id]` on a two-Agent canvas also reported `other_tools x2`. That element is not an `input`/`textarea`/`select`, so this scope excludes it — note this is a *dropped true positive*, not noise like the SVG gradient ids.
- **The unrelated, still-open** *"A form field element should have an id or name attribute"* DevTools info-level issue, present before and after this fix.
- **Actual browser autofill behaviour.** Not observable from Playwright; id uniqueness is the proxy.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` on a build that includes langflow#14312 — currently the **`release-1.11.2`** line. On any build without it (including today's `langflowai/langflow-nightly:latest`, built from `release-1.12.0`) both cases fail **by design**; that is the negative control, not a defect in the test.
- The positive validation for this spec ran against a local instance reporting version `1.11.1` / package `Langflow` that demonstrably carries the fix (its ids read `popover-anchor-input-url_input-APIRequest-<suffix>`), consistent with a build off the `release-1.11.2` line. Note that the **published** `langflowai/langflow:1.11.1` image does not contain the helper, so it is not a reproduction target.
- No model provider credentials required — the nodes are placed and inspected, never executed, so the Agent case makes no LLM call.

---

## When to review this test *(optional)*

- **The fix reaches `main` / the 1.12 line** — that is the trigger to add `@stable` (see *Tags*).
- A new parameter renderer is added under `parameterRenderComponent/components/` **whose id lands on an `input`, `textarea` or `select`** — it must call `getNodeScopedDomId` or this test goes red. Renderers using a `span`, `div` or Radix switch are outside the sweep's reach.
- The suite's selector strategy changes, or someone proposes scoping `data-testid`. This spec is the tripwire for that.
- The Agent or API Request node stops exposing the asserted field, in which case the field assertion fails first and names it.

---

## Notes *(optional)*

- Chrome reports this defect through the CDP `Audits` domain that feeds the DevTools **Issues** panel — **not** the console. Neither `page.on("console")` nor the repo fixture's response monitor can observe it, which is why the check is an explicit DOM sweep rather than a listener.
- Node overlap is irrelevant: the sweep reads the DOM, not layout. React Flow is not configured with `onlyRenderVisibleElements`, so off-screen nodes keep their fields mounted and no zoom/pan state can make this vacuous. There is deliberately **no** `adjustScreenView` call — it would add a dependency on the canvas-controls layout (#997) for a purely cosmetic gain.
- **Chat Input and Webhook are unsuitable subjects** — they are singletons, so adding one removes the other's sidebar `+` and they cannot be duplicated or pasted (which is why upstream had to build its ChatInput case through the API). **Prompt Template is also unsuitable**: its visible field is a prompt-modal surface, not a form control, and a two-node Prompt Template canvas produces no duplicate-id warning at all.
- Sibling specs place two identical nodes but assert only node counts, so none of them would catch this: `ui-ux/langflowShortcuts.spec.ts` (duplication via shortcuts — its header comment states Chat Output was chosen *because* it carries no text field) and `flow-functionality/canvas-copy-paste.spec.ts` (paste of a second Prompt Template). `core-components/chat-input-output-component-regression.spec.ts` actually hit this ambiguity — Chat Input and Chat Output both render `popover-anchor-input-sender_name` — diagnosed it as "DOM ordering", and worked around it with a node-scoped filter.
