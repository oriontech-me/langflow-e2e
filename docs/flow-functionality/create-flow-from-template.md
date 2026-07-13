# Flow Functionality — Create Flow from Template

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

Validates the "create a flow from a starter template" journey (QA-CHECKLIST
§12.1): from the New Flow → templates modal, picking a template (**Basic
Prompting**) instantiates a new flow **pre-populated with that template's
components**, opens its editor, and persists a **non-empty graph** named after
the template. This is the template entry point into the editor. It is exercised
implicitly as a setup step across the suite (via `loadTemplateByName`) but had no
dedicated spec asserting the behavior itself; this is that dedicated proof,
promoted to `@stable`.

Distinct from the §12.1 siblings: `create-blank-flow.spec.ts` (empty creation —
asserts a graph with **zero** nodes) and `duplicate-flow.spec.ts` (clone an
existing flow). This spec is the mirror of the blank case: it proves the created
flow arrives **with** the template's content.

---

## Tags *(required)*

`@stable` `@release` `@regression` `@workspace`

---

## Step by step *(required)*

1. `loadTemplateByName(page, "Basic Prompting")` — opens the templates modal via
   the New Flow entry point (handling the welcome overlay), switches to the All
   Templates tab, clicks the **Basic Prompting** template, and returns the real
   `flowId` captured from the template-instantiation `POST /api/v1/flows/` `201`
   (the canvas URL id is transient on 1.11). It resolves once
   `canvas_controls_dropdown` is visible (editor open).
2. Assert the returned `flowId` is truthy.
3. Assert the canvas is populated — `.react-flow__node` count `> 0` (the template
   loaded its components onto the canvas).
4. Assert the persisted flow matches the template — poll `GET /api/v1/flows/{flowId}`
   (Bearer) until its `data.nodes` is **non-empty** and its `name` contains
   "Basic Prompting".

`afterEach` navigates to `/` and deletes the captured `flowId` via
`DELETE /api/v1/flows/{id}` (id-scoped cleanup, never a wipe).

---

## Validation criterion *(required)*

- Picking the Basic Prompting template yields a `POST /api/v1/flows/` `201` (real
  id captured via the helper), **and** the editor opens, **and** the canvas shows
  `> 0` nodes, **and** the persisted flow (`GET /api/v1/flows/{id}`) has a
  non-empty `data.nodes` with a `name` matching `Basic Prompting`. All must hold —
  a flow that opens empty (template not applied) fails the criterion, which is
  exactly what separates this from the blank-flow path.

---

## External dependencies *(required)*

- `loadTemplateByName` / `openNewFlowTemplatesModal` helpers — the canonical
  New-Flow → All-Templates → pick-by-name path; returns the created flow id.
- `POST /api/v1/flows/` — template instantiation; returns `201` with the id.
- `GET /api/v1/flows/{id}` (Bearer) — confirms the persisted graph + name.
- `data-testid="canvas_controls_dropdown"` — editor-open readiness (awaited by
  the helper).
- `.react-flow__node` — canvas node elements (count `> 0` for a template flow).
- `getAuthToken`, `deleteFlow` helpers.
- Starter template **Basic Prompting** present in the running Langflow (used by
  `duplicate-flow.spec.ts` too).

---

## What this test does not cover *(optional)*

- Creating an **empty** flow — `create-blank-flow.spec.ts` (#676).
- Creating a flow **via JSON import** — `export-import-flow.spec.ts`.
- Duplicating an existing flow — `duplicate-flow.spec.ts`.
- Running the template's flow or asserting its exact component set — out of
  scope; the check is "template content arrived", not per-node structure (which
  drifts across Langflow releases).

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (validated on nightly 1.11.0.dev).
- No LLM / provider key required — the flow is created from the template but not
  executed.

---

## Notes *(optional)*

- Uses `Basic Prompting` (not the Agent templates) so the load stays a light,
  deterministic canvas render — avoids the heavy Simple-Agent template that
  hangs `--trace=on` (repo convention #490).
- The non-empty-graph + template-name assertion is the distinctive check: it
  separates "a flow was created from THIS template" from "some flow opened",
  mirroring the blank-flow spec's zero-node assertion.
