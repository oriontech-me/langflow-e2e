# Memory Base — Memories panel and Create Memory modal

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

The read-only surface of the flow editor's **Memories** panel and the shape of
its **Create Memory** modal — the entry point to a memory base. Nothing here
creates a memory base (that is `memory-base-registration.spec.ts`, issue #1399);
this spec pins the panel, the modal's controls, its defaults and its submit
gate, so a rename or a dropped field is caught before the registration spec
fails on it for the wrong reason.

1. **should open the Memories panel with its empty state, Create action and
   search field** — clicking `sidebar-nav-memories` in the flow editor renders
   the panel with the `No memory selected` empty state (`#no-memory-selected-title`
   / `#no-memory-selected-description`), a `Create` button and the
   `Search memories...` input — not a blank panel.
2. **should scope the Create Memory modal to the current flow** — the modal's
   title reads `Create Memory` and its description reads
   `Create a memory for "<flow name>"`, naming the flow the spec created.
3. **should expose the five Create Memory controls** — Name (`#memory-name`),
   Embedding Model (`#memory-embedding-model`), Vector Database
   (`#memory-db-provider`), Batch Size (`#memory-batch-size`) and the LLM
   Preprocessing toggle (`#llm-preprocessing-switch`) all render.
4. **should default Vector Database to Chroma Local and Batch Size to 1** — both
   shipped defaults, on an instance with nothing configured under DB Providers.
5. **should show Embedding Model carrying no default model when a provider
   offers embeddings** — the control renders reading its unset placeholder and
   the modal shows no `Provider:` line. Skips, naming the state, when no
   configured provider exposes an embeddings model.
6. **should show the Embedding Model control absent when no provider offers
   embeddings** — the required label renders with **no control** under it
   (`#memory-embedding-model` and `value-dropdown-memory-embedding-model` both
   absent) and nothing defaulted in its place. Skips when a provider does offer
   embeddings. See Notes — this is a product gap, asserted rather than skipped
   past.
7. **should keep Create Memory disabled with an empty form and with only the
   Name filled** — the submit button is disabled on open **and stays disabled**
   after Name is filled, which is the gate (a required Embedding Model), not the
   initial render.
8. **should create no memory base when the Create Memory modal is cancelled** —
   after `Cancel` the modal is gone and `GET /api/v1/memories?flow_id=<id>`
   still answers `total: 0`, asserted against the API, not the panel alone.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@ui-ux`

`@stable` from the first PR, on the same grounds as the `a2a` specs: every
assertion is LLM-free and provider-free (no embedding model is ever selected),
each test creates and deletes its own flow id-scoped, and the pipeline's
VALIDATE burst runs the file three times at `--retries=0 --workers=1`.

No new functional tag is introduced — `@workspace` covers the flow-editor
panel and `@ui-ux` its modal chrome. The area is identified by its path
(`core-functionality/memory/`), as the `knowledge-ingestion-management` specs
are.

---

## Validation criterion *(required)*

- **The panel's empty state is asserted by id, not by text** —
  `#no-memory-selected-title` and `#no-memory-selected-description` are real
  element ids in 1.12.0.dev19; the visible strings come from the
  `memory.noMemorySelected*` i18n keys and would move under a locale change
  (#1400). The `Create` button and the search input carry **no** `data-testid`
  at all (measured), so they resolve by role/name and by placeholder.
- **The flow-scoping assertion names the flow the test created**, not a
  substring of the label: the modal's description is
  `Create a memory for "<flow name>"` with the exact name passed to
  `POST /api/v1/flows/`. A test asserting only the literal prefix would pass
  against any flow and prove nothing about scoping.
- **The Embedding Model default is covered by two mutually exclusive tests, one
  per environment state, decided by an API probe before the browser opens** —
  `GET /api/v1/models`, looking for a provider that is `is_configured` **and**
  `is_enabled` **and** carries a model whose `metadata.model_type` is
  `embeddings`. Written as two tests rather than one branching test so neither
  state is silently accepted: whichever the instance is in, one test asserts
  something falsifiable and the other's skip reason names why it stood down. The
  probe is deliberately **not** a `count() === 0` check on the control itself —
  that would read a genuine regression removing the control as "no provider
  configured", which is exactly the false negative this spec exists to prevent.
  In the configured state the trigger must match neither a model id nor a
  `Provider:` line; the pair is what makes "unset" falsifiable, since the
  `Provider:` line renders only once a model is chosen.
- **The Vector Database default is the opposite case and is asserted
  literally**: `Chroma Local`, which the frontend ships as `defaultEnabled` with
  no config fields, so it holds on any instance. Batch Size likewise reads `1`.
- **The disabled gate is asserted in two states, not one** — empty form and
  Name-only. Only the second distinguishes a real required-field gate from a
  button that is simply disabled until first input.
- **"Cancel creates nothing" is asserted against
  `GET /api/v1/memories?flow_id=<id>`** — `total: 0` for the flow the test owns.
  This is the endpoint the panel itself lists from (measured: opening the panel
  fires exactly one request, `GET /api/v1/memories?flow_id=…&page=1&size=50`).
  `GET /api/v1/knowledge_bases` — named in issue #1398 — is a **different
  resource** (`kb_name`, `/ingest`, `/chunks`) and is never touched by this
  surface, so asserting it empty would be vacuous. It is asserted as a
  secondary, flow-independent check only.

---

## External dependencies *(required)*

- A running Langflow instance with the flow editor reachable — **no provider key
  and no LLM call**. Every test runs on an instance with zero providers
  configured; the provider state only decides **which** of the two Embedding
  Model tests runs (see Validation criterion), never whether the file has
  coverage.
- `GET /api/v1/models` for that probe: it reports `is_configured` / `is_enabled`
  per provider plus each model's `metadata.model_type`, and needs no inference
  call, so a configured-but-drained key still reads as configured (which is the
  correct answer here — the picker lists models without calling the provider).
- `POST /api/v1/flows/` (flow creation), `DELETE /api/v1/flows/{id}` (cleanup)
  and `GET /api/v1/memories?flow_id=<id>` (the panel's own list).
  `/api/v1/memories` is **absent from `/openapi.json`** on 1.12.0.dev19 (it
  answers `403` unauthenticated, `200` with the session) — do not conclude from
  the schema that the route does not exist.
- The `Memories` nav item requires a flow to be open: the panel's `Create`
  button is disabled without a `currentFlowId`.

---

## Cleanup *(required)*

Each test creates its own flow through `POST /api/v1/flows/` and deletes it
id-scoped in `afterEach` (`deleteFlow`), leaving the editor first via
`unmountEditorForCleanup` so the deleted flow's editor poll cannot 404 into the
fixture's HTTP log. No memory base is ever created, so there is nothing else to
remove — the cancel test asserts exactly that. Never name-based, never
delete-all (#553/#520).

---

## What this test does not cover *(optional)*

- Actually registering a memory base (completing the form) — issue #1399,
  `memory-base-registration.spec.ts`; it needs a provider exposing an
  **embedding** model and must skip loudly without one.
- The LLM Preprocessing branch's extra fields (`#memory-preprocessing-model`,
  `#preprocessing-prompt`), which only render with the toggle on.
- Memory detail views, message/session tables, auto-capture, refresh and
  delete of an existing memory base.
- Non-`chroma` vector databases (Chroma Cloud, OpenSearch, Postgres pgvector),
  which require DB Providers configuration.
- The Agent's conversation memory (§6.3) — a different surface that shares the
  word "memory".

---

## Notes *(optional)*

- **Where the selectors come from.** Every selector here was harvested twice
  rather than copied from the sibling doc: from the shipped frontend bundle
  inside the running container (`langflow/frontend/assets/index-*.js`) and then
  confirmed live against a running nightly with a throwaway scout. That is what
  produced the endpoint correction below.
- **This doc disagrees with `memory-base-registration.md` on one point, and this
  one is the measured side.** That doc (the §20 audit, and the reference issue
  #1398 names) states the surface is asserted against
  `GET /api/v1/knowledge_bases`. The panel lists from
  `GET /api/v1/memories?flow_id=<id>` — opening it fires exactly that one request
  and no `knowledge_bases` call at all — and the modal submits to
  `POST /api/v1/memories/`. A memory base may well be backed by a knowledge base
  underneath, which is presumably where that reading came from, but the
  account-wide `knowledge_bases` list is not the flow-scoped observable a
  "created nothing" assertion needs. Whether registration also writes a
  `knowledge_bases` row is #1399's measurement to make, on the endpoint it
  actually observes.
- **Three corrections to the issue's wording**, each verified live:
  (a) `Create a memory for "<flow name>"` is the modal's **description**; its
  **title** is `Create Memory` (which is also the submit button's label — assert
  the two by role, not by text alone);
  (b) the panel lists from `/api/v1/memories`, not `/api/v1/knowledge_bases`
  (see Validation criterion);
  (c) Batch Size also has a default (`1`), so "Vector Database defaults, Embedding
  Model does not" is not the whole picture — Embedding Model is the only unset
  required control.
- **Product gap found while validating this spec — the Create Memory modal has
  no empty state for its required Embedding Model, and the Knowledge Base modal
  does.** The picker is the shared model widget, rendered **without**
  `showEmptyState` (which defaults to `false`), so on an instance where no
  configured, enabled provider exposes an `embeddings` model the control is
  **absent from the DOM entirely** — while the label `Embedding Model` and its
  required `*` still render, the placeholder text `Select embedding model` shows
  as dead text, and `Create Memory` stays disabled forever with nothing
  explaining why. Registering a memory base is therefore a dead end with no
  message, no link and no affordance. The sibling Knowledge Base modal passes
  `showEmptyState: true` on the same widget (`#kb-embedding-model`) and renders
  `No Models Enabled` plus `Manage Model Providers`, which is the working
  behaviour this one is missing. Measured on `1.12.0.dev22` with every provider
  `is_configured: false`, and again with `OPENAI_API_KEY` configured (3
  embeddings models), where the control appears reading `Select a model`. Both
  states are asserted — see tests 5 and 6 — so if upstream adds the empty state,
  test 6 fails and this doc is updated. **Candidate defect, not yet filed.**
- **The instance's provider state is part of the measurement, not background.**
  The first version of this spec asserted `#memory-embedding-model` present
  unconditionally and was green three times on `1.12.0.dev19` — an instance that
  happened to carry credentials from an earlier `collect-models`. Restarting on
  the current nightly (a fresh container, no credentials) turned two tests red.
  The version bump was not the cause; the provider state was.
- **The submit gate, from the bundle:**
  `disabled = !name.trim() || embedding.length === 0 || !backendConfigured ||
  (preprocessing && preprocModel.length === 0) || (preprocessing && !prompt.trim())`.
  `backendConfigured` is true for `chroma` out of the box, which is why the
  Name-only state is disabled by the embedding model alone.
- **Checklist placement.** The bullets flip the existing `## memory/ — Memory
  Base Registration (1.12)` §20.1–§20.2 entries in place; the section and its
  `MODULES` entry in `scripts/coverage-summary.ts` already landed with the audit
  that opened this issue. §20.3 stays open for #1399 and §20.4 (ingestion) is a
  separate wave item.
