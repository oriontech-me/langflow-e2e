# Core Components — Component That Raises a Python Error

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the error-handling path when a component's Python code raises an
exception at build time (QA-CHECKLIST §8.4): a Custom Component whose
`build_output` does `raise ValueError("THIS IS A TEST ERROR MESSAGE")` must
surface that exact message to the user when the node is run — not swallow it, not
crash the editor. This is the observability guarantee that a broken component
tells the user *why* it broke.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace` `@components`

---

## Step by step *(required)*

1. `awaitBootstrapTest(page)`; register a `POST /api/v1/flows/` `201` waiter and
   click `blank-flow`, capturing the created `flowId` (id-scoped cleanup).
2. Add a Custom Component via `addCustomComponent` (sidebar
   `sidebar-custom-component-button` → node `title-Custom Component`).
3. Open the code editor: select the node title, click `code-button-modal`.
4. Replace the code with a component whose `build_output` raises
   `ValueError("THIS IS A TEST ERROR MESSAGE")`, then Check & Save.
5. Run the component from its terminal-node run button
   (`button_run_custom component`).
6. Assert the exact error message `THIS IS A TEST ERROR MESSAGE` is surfaced in
   the UI (error popup / node error).

`afterEach` navigates to `/` and deletes the captured `flowId` via
`DELETE /api/v1/flows/{id}` (Bearer, id-scoped — never a wipe).

---

## Validation criterion *(required)*

- After running the erroring component, the exact string
  `THIS IS A TEST ERROR MESSAGE` (the message passed to `raise ValueError`) is
  visible in the UI. The assertion is on the *specific* message, so a generic
  error banner or a swallowed exception fails the criterion.

---

## External dependencies *(required)*

- `data-testid="blank-flow"` — new blank flow.
- `data-testid="sidebar-custom-component-button"` / `title-Custom Component` —
  add + locate the Custom Component (via `addCustomComponent`).
- `data-testid="code-button-modal"` — opens the component's code editor (ACE).
- `Check & Save` button — validates and saves the edited code.
- `data-testid="button_run_custom component"` — runs the component (builds the
  upstream graph).
- `POST /api/v1/flows/` `201`, `GET/DELETE /api/v1/flows/{id}` (Bearer) —
  id capture + cleanup.
- Helpers: `awaitBootstrapTest`, `addCustomComponent`, `adjustScreenView`,
  `zoomOut`, `getAuthToken`, `deleteFlow`.

---

## What this test does not cover *(optional)*

- Tool-mode component errors (exceptions become ToolMessage content with
  `handle_tool_error=True`) — covered by `agent-tool-error-handling.spec.ts`.
- Network / timeout error paths — §8.4 siblings (#693 / #694).
- Frontend crash on invalid component replace — covered by
  `general-bugs-frontend-crashing-on-invalid-replace.spec.ts`.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on nightly 1.11.0.dev).
- No LLM / provider key required — the Custom Component raises deterministically,
  no model call.
- No `allowFlowErrors()` needed: a component build error rides the SSE build
  stream and does not surface as a backend 4xx/5xx, so the fixture's HTTP-error
  monitor does not trip (convention #489).

---

## Notes *(optional)*

- The error message is a fixed sentinel (`THIS IS A TEST ERROR MESSAGE`) so the
  assertion cannot pass on an unrelated error.
- Promotion hardening over the pre-`@stable` version: id-scoped cleanup added
  (the flow was leaking every run), arbitrary `waitForTimeout` removed, and tight
  3 s waits raised to render-appropriate budgets.
