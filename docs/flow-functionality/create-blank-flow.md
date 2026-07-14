# Flow Functionality — Create Blank Flow

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the "create a blank flow" journey (QA-CHECKLIST §12.1): from the
new-project modal, clicking **Blank Flow** creates a brand-new flow, opens its
editor, and the persisted flow has an **empty graph** (no nodes, no edges). This
is the foundational entry point into the flow editor — every canvas/component
test depends on it working. It is exercised implicitly as a setup step across the
suite (e.g. `setupPlayground`), but had no dedicated spec asserting the behavior
itself; this is that dedicated proof, promoted to `@stable`.

Distinct from the siblings under §12.1: `duplicate-flow.spec.ts` (clone an
existing flow) and the template/import paths (create *from* content) — this spec
covers the **empty** creation path specifically.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace`

---

## Step by step *(required)*

1. `awaitBootstrapTest(page)` — loads the app and leaves the new-project modal
   open (its `blank-flow` option visible).
2. Register a `page.waitForResponse` for `POST /api/v1/flows/` → `201` **before**
   the click (the canvas URL id is transient; the 201 body carries the real id).
3. Click `blank-flow`.
4. Capture the created `flowId` from the 201 response body; assert it is truthy.
5. Assert the flow editor opened — `sidebar-search-input` visible (the editor
   mounts only after the creation POST resolves).
6. Assert the canvas is blank — `.react-flow__node` has count `0`.
7. Assert the persisted flow is genuinely empty — poll `GET /api/v1/flows/{flowId}`
   (Bearer) until it returns and its `data.nodes` and `data.edges` are both empty.

`afterEach` navigates to `/` and deletes the captured `flowId` via
`DELETE /api/v1/flows/{id}` (id-scoped cleanup, never a wipe).

---

## Validation criterion *(required)*

- Clicking Blank Flow yields a `POST /api/v1/flows/` `201` (real id captured),
  **and** the editor opens (`sidebar-search-input` visible), **and** the canvas
  shows `0` nodes, **and** the persisted flow (`GET /api/v1/flows/{id}`) has an
  empty `data.nodes` / `data.edges`. All must hold — an editor that opens onto a
  non-empty graph (e.g. a template silently loaded) fails the criterion.

---

## External dependencies *(required)*

- `POST /api/v1/flows/` — flow creation; returns `201` with the persisted id.
- `GET /api/v1/flows/{id}` (Bearer) — confirms the persisted graph is empty.
- `data-testid="blank-flow"` — the Blank Flow option in the new-project modal.
- `data-testid="sidebar-search-input"` — editor-open readiness signal.
- `.react-flow__node` — canvas node elements (count `0` for a blank flow).
- `awaitBootstrapTest`, `getAuthToken`, `deleteFlow` helpers.

---

## What this test does not cover *(optional)*

- Creating a flow **from a template** — §12.1, separate spec (#677).
- Creating a flow **via JSON import** — §12.1, `import-flow-json.spec.ts` (#678).
- Duplicating an existing flow — `duplicate-flow.spec.ts`.
- Adding/connecting components on the blank canvas — covered by the
  `canvas-*.spec.ts` family.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on nightly 1.11.0.dev).
- No LLM / provider key required — pure workspace operation.

---

## Notes *(optional)*

- The real flow id comes from the creation POST, **not** `page.url()` — the
  canvas URL id is transient on 1.11 and 404s on delete (repo convention #505).
- Empty-graph assertion is the distinctive check: it separates "a blank flow was
  created" from "some flow opened", so a regression that silently seeds content
  cannot pass.
