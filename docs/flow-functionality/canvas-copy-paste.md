# Flow Functionality — Canvas Copy & Paste

**Last validated:** Langflow 1.10.x

---

## What this test validates *(required)*

Validates that a node on the canvas can be duplicated via `Ctrl+C` then `Ctrl+V` — the project's canonical duplication shortcut (`Ctrl+D` is browser-intercepted on macOS and is documented as forbidden in `langflow-playwright-skill` section 5.4).

Two tests, one per component shape:

1. **ChatOutput** — a simple I/O component with a single fixed input handle.
2. **Prompt Template** — a component with **dynamic ports** (handles created from prompt variables). Validating duplication on this surface catches regressions where the copy/paste pipeline drops dynamically-derived state.

If either breaks, users cannot duplicate components on the canvas via keyboard shortcuts.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace`

---

## Step by step *(required)*

**Both tests share the same shape:**

1. `setupBlankFlow(page)` — creates a blank flow via `POST /api/v1/flows/` with a unique `e2e-blank-{ts}-{rand}` name and navigates through the dashboard. This bypasses the UI's `useAddFlow` race that emits transient 500s on `release-1.10.0`.
2. Search the sidebar for the target component and add it via hover + add-component-button.
3. Assert exactly **1** node on the canvas.
4. Click the node to select it.
5. `Control+C` to copy.
6. Click an empty canvas region to deselect any modal/menu and ensure paste lands on the canvas.
7. `Control+V` to paste.
8. Assert exactly **2** nodes on the canvas.
9. `afterEach`: delete the created flow via `DELETE /api/v1/flows/{id}`.

The two tests differ only in step 2 (which component is added).

---

## Validation criterion *(required)*

- Before paste: `.react-flow__node` count is `1`
- After paste: `.react-flow__node` count is `2`
- Audit step 7 (`🚨 Backend Error` grep) finds zero matches — the API-based flow creation in `setupBlankFlow` avoids the UI race that contaminates other flow-functionality tests

---

## External dependencies *(required)*

- `src/frontend/src/hooks/flows/use-add-flow.ts` — the UI flow-creation path with the unique-name suffix race (`addVersionToDuplicates`). Bypassed via the API helper, but if the API contract for `POST /api/v1/flows/` changes (status, payload shape), the helper fails loudly.
- `src/frontend/src/components/core/.../canvas/...` — ReactFlow node rendering. If the node container's `.react-flow__node` class is renamed upstream, the count assertions break.
- ReactFlow's keyboard handler for copy/paste — if Langflow stops propagating Ctrl+C / Ctrl+V to the canvas, paste produces zero new nodes and the test fails on the post-paste count assertion.

---

## What this test does not cover *(optional)*

- `Ctrl+D` duplication shortcut — explicitly excluded per project convention.
- Right-click context-menu duplication — separate spec (`canvas-right-click-component.spec.ts`).
- Copy/paste of **multiple** selected nodes via box-selection + clipboard — separate spec (`canvas-multiselect.spec.ts`).
- Copy/paste of edges between two pasted nodes — paste duplicates only the selected node, not edges from the original; out of scope.
- LLM-based components (Agent, OpenAI, Anthropic) — coverage on Prompt Template (dynamic ports) is sufficient to exercise the dynamic-state surface; LLM specifics are unrelated to copy/paste.

---

## Preconditions *(optional)*

- Langflow running and accessible at `PLAYWRIGHT_BASE_URL`
- Auto-login enabled (the helper uses `getAuthToken` which expects `/api/v1/auto_login` to issue a token)
- No API key or LLM required
