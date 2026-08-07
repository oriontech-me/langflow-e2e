# Memory Base — registration from the FlowPage Memories panel

**File:** `tests/tests-automations/regression/core-functionality/memory/memory-base-registration.spec.ts`
**Last validated:** `1.12.x`
**Status:** SPEC — awaiting confirmation, no test code written yet

---

## What this test validates

The **Memory Base** surface introduced in 1.12: the `Memories` panel inside the
Flow editor and the `Create Memory` modal that registers one. A memory base is a
Knowledge Base (`/api/v1/knowledge_bases`) bound to a flow, storing vectors in a
configured vector database.

This area has **no coverage today** — no spec, no checklist bullet. It was missed
because "memory" was already taken in our vocabulary by the Agent's conversation
memory (Message History, session isolation, `context_id`), which is unrelated.

## Tags

`@regression` `@workspace` (cross-cutting) + `@files` (functional).

`@files` is the closest existing functional tag — the surface is knowledge/vector
ingestion. **Not `@stable`** on the first delivery: `@stable` is added only after
team validation.

Scenario 5 additionally carries `@model-provider`, because it is the only one
that needs an embedding provider.

## Validation criterion

The suite passes when, on a flow with no memory base:

1. The `Memories` panel opens from the flow sidebar and shows its empty state.
2. The `Create Memory` modal exposes its five documented controls and its
   defaults.
3. `Create Memory` stays **disabled** until every required field is filled.
4. `Cancel` closes the modal and creates nothing — asserted against
   `GET /api/v1/knowledge_bases`, not against the UI alone.
5. *(provider-dependent)* Completing the form creates a memory base that appears
   both in the panel and in `GET /api/v1/knowledge_bases`.

## External dependencies

- A running Langflow **1.12.x** instance with the Memories panel
  (`sidebar-nav-memories`).
- **Scenarios 1–4: none.** No provider, no key, no network beyond the instance.
- **Scenario 5 only:** a configured provider exposing an **embedding** model.
  With none, the picker renders `No Models Enabled` and the scenario `test.skip`s
  with that reason — never a silent pass.
- The default vector database is **Chroma Local**, bundled with the instance, so
  scenario 5 needs no external vector service.

**Note — the API is absent from the instance's OpenAPI schema.** `GET /openapi.json`
lists 104 paths and none is `knowledge_bases`, yet the endpoint answers `200`.
Assertions therefore target observed responses, not the published schema.

---

## Scenarios

### 1.1 Memories panel opens with its empty state [ ]

**File:** `core-functionality/memory/memory-base-registration.spec.ts`
**Objective:** The panel is reachable from the flow editor and reports "no memory"
honestly, so later scenarios start from a known state.
**Precondition:** A flow open in the editor with no memory base registered.

**Step by step**

1. Create a flow via `POST /api/v1/flows/` and open it (repo pattern: `goto("/")`
   then open the card by name — `page.goto("/flow/{id}")` races the SPA cache).
2. Click `sidebar-nav-memories`.

**Validation:** The `Memories` heading is visible, the empty state reads
`No memory selected` / `Select a memory from the sidebar to view details`, and a
`Create` control is present.

---

### 1.2 Create Memory modal exposes its contract [ ]

**Objective:** Pin the form's shape and defaults, so an upstream change to either
is caught rather than absorbed.
**Precondition:** Scenario 1.1 state, modal closed.

**Step by step**

1. Click `Create` in the Memories panel.
2. Read the modal.

**Validation:** The dialog titles `Create Memory` and scopes itself to the flow
(`Create a memory for "<flow name>"`). It exposes:

| Control | Selector | Expectation |
|---|---|---|
| Name | `input#memory-name` | required, placeholder `Memory name` |
| Embedding Model | `memory-embedding-model` | required, empty (`Select a model`) |
| Vector Database | `memory-db-provider` | required, **defaults to `Chroma Local`** |
| Batch Size | `input#memory-batch-size` | required, placeholder `1` |
| LLM Preprocessing | checkbox | optional, off by default |
| Cancel | `btn-cancel-modal` | enabled |

The flow-name assertion is the load-bearing one: it proves a memory base is
**scoped to a flow**, not global.

---

### 1.3 Create is gated on the required fields [ ]

**Objective:** The primary action cannot submit an incomplete registration.
**Precondition:** Modal open, untouched.

**Step by step**

1. Assert `Create Memory` is disabled with the form empty.
2. Fill `#memory-name` with a per-run sentinel.
3. Assert it is **still** disabled — Name alone is not enough (Embedding Model
   has no value and no default).

**Validation:** The button is disabled in both states. Asserting the second state
is what makes this a gate test rather than a render test.

> **Known limitation.** `Create Memory` carries **no `data-testid`** — it is
> located by role+name. Same for the Name and Batch Size inputs (`id` only), the
> search field and the empty state. Only the two dropdowns and Cancel have
> testids. This is worth raising upstream; until then the spec documents the
> weaker locators rather than inventing testids that do not exist.

---

### 1.4 Cancel creates nothing [ ]

**Objective:** Abandoning the form leaves no server-side record — the failure mode
a UI-only assertion would miss.
**Precondition:** Modal open with `#memory-name` filled.

**Step by step**

1. Record `GET /api/v1/knowledge_bases` (baseline).
2. Click `btn-cancel-modal`.
3. Re-read `GET /api/v1/knowledge_bases`.

**Validation:** The modal closes, the panel is back to its empty state, and the
API list is byte-identical to the baseline.

---

### 1.5 Registering a memory base end-to-end [ ] — provider-dependent

**Objective:** The happy path the feature exists for.
**Precondition:** A provider with an **embedding** model configured. If
`memory-embedding-model` offers `No Models Enabled`, `test.skip` with that reason.

**Step by step**

1. Open the modal, fill `#memory-name` with a per-run sentinel.
2. Select an embedding model via `value-dropdown-memory-embedding-model`.
3. Leave Vector Database at `Chroma Local` and Batch Size at its default.
4. Assert `Create Memory` is now **enabled**, then click it.
5. Wait for the `POST` to `/api/v1/knowledge_bases` to answer `201`.

**Validation:** The sentinel appears in the Memories sidebar **and** in
`GET /api/v1/knowledge_bases`. Both are required: the panel alone could render
optimistic local state.

**Cleanup:** `DELETE /api/v1/knowledge_bases/{name}` in `afterEach`, plus the
flow. The suite has a documented history of cross-worker damage from destructive
cleanup (#519/#562), so cleanup deletes **only** the sentinel it created — never
"all memory bases".

---

## Open decisions for the team

1. **Area placement.** This spec proposes a new
   `core-functionality/memory/` area. The alternative is folding it into
   `core-functionality/knowledge-ingestion-management/` (§5, 8 bullets, all
   validated), which today covers the **component-based** ingestion path (Split
   Text, vector store components) — a different mechanism reaching a similar
   outcome. Separate area recommended; §5 covers components, this covers a
   managed platform object.
2. **Is this surface in the team's scope at all?** Bundles and data migration
   were both scoped out to other owners this cycle. This is a platform feature
   and the same question applies before the tests are written.
3. **Deferred deliberately:** ingestion (`POST /{kb_name}/ingest`), chunk preview,
   run history (`/runs`), cancel, connectors and the `memory base association`
   guards (5 routes carry `_check_memory_base_association`). Those are a second
   spec once registration is covered — this one stops at *registering* it, which
   is what was asked.
