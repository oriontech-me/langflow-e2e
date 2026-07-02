# Flow Functionality — Flow Execution via Canvas

**Last validated:** Langflow 1.11.x (nightly `1.11.0.dev29`)

**Test file:** `tests/tests-automations/regression/flow-functionality/flow-execution-canvas.spec.ts`
**Reusable helper:** `tests/helpers/flows/run-flow.ts` (`runFlow`)

---

## What this test validates *(required)*

The generic **"run a flow"** journey on the canvas: triggering a run from a
terminal node builds the **entire upstream graph**, every node reaches
build-success, the output is produced, and a second run is **idempotent**
(re-running rebuilds cleanly).

This is deliberately distinct from the two specs that look adjacent:

- `run-flow.spec.ts` validates the **RunFlow *component*** (a node that executes
  *another* flow) — a different feature.
- `chat-input-output-component-regression.spec.ts` validates the **components'**
  handles, fields and value propagation. Here the subject is the **run/build
  orchestration itself** — that clicking run drives the whole graph to success
  and that the run is repeatable — not any single component's plumbing.

Langflow (1.11) has **no global "run flow" button**; a flow is run by triggering
a terminal node's run control (`button_run_<node>`), which builds all upstream
dependencies. (Confirmed live: `button_run_flow` does not exist in the DOM; the
`FlowEditorPage.runFlow()` POM method referencing it is dead code.) This spec
codifies that real journey and ships a reusable `runFlow` helper for it — the
PART I "Run a flow" checklist item.

No LLM / provider / API key required (ChatInput → ChatOutput echo).

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@regression`

> Note: `flow-functionality` specs carry `@workspace` (cross-cutting) and no
> functional tag — the tag taxonomy in `CLAUDE.md` has no functional tag for
> "flow execution" (functional tags are provider/agents/mcp/playground/auth/
> observability/files/templates/settings/ui-ux). This matches the sibling
> `run-flow.spec.ts` (`@release @workspace @api @regression`). `@stable` is added
> only after team validation.

---

## Step by step *(required)*

### Test 1 — `user can run a flow from the canvas; every node reaches build success and output is produced`

1. Create a ChatInput → ChatOutput flow via `POST /api/v1/flows/` using the
   `chat-io-ok-trace-fixture.json` fixture (via `createRunnableChatFlowViaApi`,
   which applies a unique name — deterministic, avoids the UI unique-name race).
2. Navigate to `/flow/{id}` and wait for the canvas (`sidebar-search-input`).
   No zoom/screen adjustment — the fixture's nodes render in a runnable position.
3. Gate on the terminal node's run control (`button_run_chat output`) being
   visible before running — a readiness wait so the run does not race canvas
   hydration (this replaces the sync that `adjustScreenView` implicitly provided).
4. Trigger the run from the terminal node via the reusable `runFlow(page, "chat output")`
   helper (clicks `button_run_chat output`, expanding the node first if minimized).
5. Assert the `built successfully` toast appears (whole-graph build completed).
6. Assert **both** nodes reached success — each shows its duration badge
   (`node_duration_chat input`, `node_duration_chat output`) after the run
   (confirmed live in the running nightly).
7. Open the Chat Output inspection (`output-inspection-output message-chatoutput`)
   and assert the echoed input value (`Hello`) is present.
8. `finally`: `DELETE /api/v1/flows/{id}`.

---

## Validation criterion *(required)*

The spec must:

- Trigger the run from a **terminal node** and assert the `built successfully`
  toast — proving the run drove the whole graph, not a single node in isolation.
- Assert **every** node reached success (both duration badges present), not only
  the output value — a regression where an upstream node silently fails but the
  output node still renders stale data would be caught.
- Assert the Chat Output inspection contains the echoed value — proves the run
  actually produced output end-to-end.
- Use the reusable `runFlow` helper (not an inline click) so the PART I "Run a
  flow" building block is exercised by a real test.
- Delete the flow in `finally` — no workspace artifact accumulation across runs.
- Log zero `🚨 Backend Error` (the fixture's monitor must stay clean; this is a
  happy-path run).

---

## External dependencies *(required)*

- `tests/assets/flows/chat-io-ok-trace-fixture.json` — the ChatInput → ChatOutput
  fixture (1 edge, no LLM); the flow under test.
- `tests/helpers/auth/get-auth-token.ts` — Bearer token for the API create/delete.
- `tests/helpers/flows/run-flow.ts` — **new** reusable `runFlow` helper (generalizes
  the existing `run-chat-output.ts` to any terminal node).
- Langflow node run control testid `button_run_{node display name}` and the
  per-node duration badge `node_duration_{node}` — the test breaks if these are
  renamed upstream.

---

## What this test does not cover *(optional)*

- Component-level handles/fields/propagation — covered by
  `chat-input-output-component-regression.spec.ts`.
- Stopping/pausing a run — covered by `flow-functionality/stop-building.spec.ts`
  and `core-functionality/playground/stop-button-playground.spec.ts`.
- Running via the Playground send action — exercised by playground specs.
- Running flows that require an LLM/provider — this is the deterministic,
  provider-free baseline.
- The RunFlow component (running one flow from another) — `run-flow.spec.ts`.
- **Idempotent re-run (running the same flow twice in one session)** — descoped.
  After the first build, the terminal node's run control sits under a
  right-anchored `react-flow__panel` (and, transiently, the success toast),
  which intercepts the second click. A `force` click works but would bypass real
  actionability and could mask a genuine regression, so a reliable re-run
  assertion is deferred rather than shipped flaky. Reopen if Langflow exposes a
  stable re-run affordance (e.g. a global run button).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (latest nightly).
- `LANGFLOW_SUPERUSER` / `LANGFLOW_SUPERUSER_PASSWORD` for the API auth token.
- No LLM required.

---

## When to review this test *(optional)*

- Langflow introduces a global "run flow" button — the spec should then target
  it directly (and the dead `FlowEditorPage.runFlow()` / `button_run_flow` becomes
  live).
- The per-node run testid pattern `button_run_{node}` or the success badge
  `node_duration_{node}` is renamed.
- The `built successfully` toast text changes.
