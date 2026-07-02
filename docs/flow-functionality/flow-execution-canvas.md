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

- Test 1 (canvas run): `@stable` `@release` `@workspace` `@regression`
- Test 2 (Playground round-trip): `@stable` `@release` `@workspace` `@regression` `@playground`

> Note: the canvas-run test carries `@workspace` (cross-cutting) with no
> functional tag — the `CLAUDE.md` taxonomy has none for "flow execution"
> (matches the sibling `run-flow.spec.ts`). The Playground round-trip test adds
> the `@playground` functional tag since it exercises the Playground surface.
> `@stable` is added only after team validation.

---

## Step by step *(required)*

One ChatInput → ChatOutput journey split into three sequential tests inside a
`test.describe.configure({ mode: "serial" })` block. To avoid restarting the
journey between tests, the flow is created **once** via the API and its canvas is
opened **once** on a shared page (`browser.newPage()` in `beforeAll`); the three
tests run in order on that same page.

**`beforeAll`** — create the ChatInput → ChatOutput flow via `POST /api/v1/flows/`
(`createRunnableChatFlowViaApi`, unique name; deterministic, avoids the UI
unique-name race), open `/flow/{id}`, wait for the canvas (`sidebar-search-input`).
No zoom/screen adjustment — the fixture's nodes render in a runnable position.

**Test 1 — `1 - runs the flow from the canvas terminal node`**
1. Gate on the terminal node's run control (`button_run_chat output`) being
   visible — a readiness wait so the run does not race canvas hydration.
2. Trigger the run via `runFlow(page, "chat output")` (Langflow 1.11 has no
   global run button; running a terminal node builds the whole upstream graph).
3. Assert the terminal node's persistent success badge `node_duration_chat output`
   is visible — build completed. **Not** the transient `built successfully` toast,
   which fades and flakes the wait (same anchor-on-node-status fix as #506 / #507).

**Test 2 — `2 - the flow ran correctly: every node reached build success`**
1. Assert **both** duration badges — `node_duration_chat input` and
   `node_duration_chat output` — are visible. A badge renders only on a node's
   successful build, so both present proves the whole graph built, not just the
   output node.

**Test 3 — `3 - the chat input and chat output are visible in the Playground`** (`@playground`)
1. Open the Playground via `playground-btn-flow-io`.
2. **Verify the chat input:** assert the user bubble
   `chat-message-User-Hello` is visible (step 1's run produced the session message).
3. **Verify the chat output:** assert the AI bubble `chat-message-AI-Hello` is
   visible — the Chat Output echo (confirmed live: a canvas run's output shows in
   the Playground of the same flow).

**`afterAll`** — navigate to `/` (unmount editor), `DELETE /api/v1/flows/{id}`,
close the shared page.

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
