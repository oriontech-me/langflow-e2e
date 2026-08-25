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
   the modal shows no `Provider:` line. Of the three tests covering this
   control (5–7) it is the only one that reads the instance's real provider
   state; it skips, naming the state, when no configured provider exposes an
   embeddings model.
6. **should replace the Embedding Model picker with a provider-setup affordance
   when no provider is configured** — with `GET /api/v1/models` served as the
   nothing-configured state, `#memory-embedding-model` and
   `value-dropdown-memory-embedding-model` are both absent and an **enabled
   button** stands in their place, labelled `Select embedding model`
   (`#memory-embedding-model-setup-provider-label`); clicking it opens the
   **Model providers** dialog. `Create Memory` stays disabled. The empty state
   is an escape hatch, not a dead end — see Notes.
7. **should keep the Embedding Model picker when the configured providers expose
   no embeddings model** — with the same payload stripped of every `embeddings`
   model instead, the picker **does** render (`#memory-embedding-model`, reading
   its unset placeholder), with no `Provider:` line and no setup affordance. The
   third state, distinct from both of the above and previously conflated with
   the second (issue #1569).
8. **should keep Create Memory disabled with an empty form and with only the
   Name filled** — the submit button is disabled on open **and stays disabled**
   after Name is filled, which is the gate (a required Embedding Model), not the
   initial render.
9. **should create no memory base when the Create Memory modal is cancelled** —
   after `Cancel` the modal is gone and `GET /api/v1/memories?flow_id=<id>`
   still answers `total: 0`, asserted against the API, not the panel alone.

---

## Tags *(required)*

`@stable` `@release` `@workspace` `@ui-ux`

`@stable` from the first PR, on the same grounds as the `a2a` specs: every
assertion is LLM-free and provider-free (no embedding model is ever selected),
each test creates and deletes its own flow id-scoped, and the pipeline's
VALIDATE burst runs the file three times at `--retries=0 --workers=1`.

**Recorded coverage decision (issue #1569) — the negative state is made
reachable, so the `@stable` claim is kept and now earned.** As first shipped,
the Embedding Model control was covered by two mutually exclusive tests whose
`test.skip()` guards read the instance's ambient provider configuration. The
negative one — *"the Embedding Model control is absent when no provider offers
embeddings"* — could therefore never run on any lane that configures a
provider, which is every scheduled lane: measured skipped on 4 of the 4 dailies
whose `results.json` artifact was still retained (2026-08-19, 08-20, 08-21,
08-24). A `@stable` tag on a test that never runs claims validated coverage the
lane cannot deliver — the shape #1010 named, reached from the other side (a
precondition that never holds rather than a tag combination that never runs).

The state is now driven **per page** by serving the providers payload the
frontend reads, so tests 6 and 7 run on **every** lane regardless of what is
configured. That is deliberately *not* the instance-global route the issue
raised as an option (disabling the provider through the API), which would make
the file `@destructive` and therefore ineligible for `@stable` (#1010). Test 5
keeps reading the real environment and keeps its skip, which is honest: it
asserts against the backend's own state, and that state holds on every
scheduled lane.

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
- **The Embedding Model control has THREE states, not two, and the product
  renders a different thing in each.** Measured on `1.12.0.dev37`, from the
  shipped bundle and confirmed live (issue #1569):

  | # | Providers payload | `#memory-embedding-model` | Setup affordance | Trigger reads |
  |---|---|---|---|---|
  | A | at least one enabled provider exposing an `embeddings` model | present | absent | `Select a model` |
  | B | providers enabled/configured, **none** exposing an `embeddings` model | **present** | absent | `Select a model` |
  | C | nothing configured and nothing enabled | absent | **present** | `Select embedding model` (a button) |

  The picker is the shared model widget. It collapses to the setup affordance
  only when `!hasEnabledProviders && !showEmptyState && optionCount === 0`,
  where `hasEnabledProviders` is `providers.some(p => p.is_enabled ||
  p.is_configured)` — **any** provider, not an embeddings-capable one — and the
  options come from `providers.filter(p => p.is_enabled)` flat-mapped over
  models whose `metadata.model_type` is `embeddings` (or `embedding`; only the
  plural occurs in the payload today). State B satisfies the option half and
  fails the provider half, so the picker renders with nothing to offer.

- **The original guard conflated B and C, which is why it was a latent red and
  not merely dead coverage.** `embeddingModelAvailable()` asked for a provider
  that is `is_configured` **and** `is_enabled` **and** carries an `embeddings`
  model; its negation is `B ∪ C`, and the test it guarded asserted C's DOM. On
  an instance in state B — reachable with a single provider that ships no
  embeddings model at all, e.g. `anthropic` (13 models, 0 embeddings, measured)
  — the test would have run and **failed**, reporting a product regression that
  is not one. Making the payload explicit removes the ambiguity: each test names
  the state it asserts.

- **The payload is DERIVED from the live response, never fabricated.** Each
  mocked test intercepts `GET /api/v1/models` on the pathname, calls the real
  endpoint, and transforms the body it gets back — clearing `is_configured` /
  `is_enabled` / `models` for state C, dropping only the `embeddings` models for
  state B. A hand-written fixture would keep passing after the backend changed
  the payload's shape, which is the standing objection to mocking; a derived one
  cannot, because it is the backend's own object minus one field's worth of
  content. Fidelity was checked against ground truth rather than assumed: the
  derived state C reproduces a real credential-free nightly on the same build
  (`#memory-embedding-model` 0, affordance 1, label `Select embedding model`,
  submit disabled) element for element.

- **The empty state's assertion is the escape hatch, not the absence.** In state
  C the required label and its `*` still render, and under them an **enabled**
  button whose click opens the **Model providers** dialog listing every
  provider. Asserting only `toHaveCount(0)` on the two picker handles — which is
  what the first version did — passes on a modal that offers a way out and on a
  modal that offers nothing, so it cannot tell a fix from a regression. The
  click-through is what makes the claim falsifiable.

- **State A is asserted against the real backend and keeps its skip.** The
  trigger must match neither a model id nor a `Provider:` line; the pair is what
  makes "unset" falsifiable, since the `Provider:` line renders only once a
  model is chosen. This test is deliberately **not** mocked: it is the one that
  proves the control behaves against Langflow's own provider state, and that
  state holds on every scheduled lane.
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
  configured, and every test but one runs on an instance with providers
  configured too: the ambient provider state decides only whether test 5 skips,
  never whether the file has coverage.
- `GET /api/v1/models` — read for test 5's probe and intercepted for tests 6–7.
  It reports `is_configured` / `is_enabled` per provider plus each model's
  `metadata.model_type`, and needs no inference call, so a configured-but-drained
  key still reads as configured (which is the correct answer here — the picker
  lists models without calling the provider). The frontend reads this same
  endpoint through `useGetModelProviders`, plus
  `GET /api/v1/models/enabled_models`, which is left untouched: with the
  providers payload emptied the option list is already empty, so the second
  query cannot re-add anything.
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
- **The "product gap" this doc previously recorded is withdrawn — measured on
  `1.12.0.dev37`, the empty state works.** The earlier note held that the Create
  Memory modal had no empty state for its required Embedding Model: the picker
  is the shared model widget rendered **without** `showEmptyState` (default
  `false`), so with nothing configured the control is absent from the DOM, and
  the visible `Select embedding model` was read as dead placeholder text beside
  a permanently disabled submit — "a dead end with no message, no link and no
  affordance". That string is not dead text. It is the label of the button the
  widget renders **in place of** the picker
  (`#memory-embedding-model-setup-provider-label`, inside an enabled
  `<button>` carrying a `BrainCircuit` icon), and clicking it opens the **Model
  providers** dialog listing all nine providers — measured live on a
  credential-free `1.12.0.dev37` container and reproduced through the derived
  payload on a configured one. Whether the affordance arrived between
  `1.12.0.dev22` and `.dev37` or was there and misread cannot be settled now and
  does not change the current answer; the modal is not a dead end on the build
  the suite targets. The Knowledge Base modal's `showEmptyState: true` path
  (`#kb-embedding-model` → `No Models Enabled` + `Manage Model Providers`) is a
  **different** rendering of the same intent, not the presence of one against
  the absence of the other. Nothing to file.
- **Issue #1569 — what changed and why.** The two ambient-guarded tests became
  one ambient test (state A) plus two payload-driven ones (states C and B). The
  trigger was a coverage-claim question — a `@stable` test skipped on 4 of 4
  retained dailies — and the investigation found two further things the skip was
  hiding: the guard's negation covered two product states with **different**
  DOM, so the test was a latent false red on any single-provider instance whose
  provider ships no embeddings model (`anthropic` does not); and the assertion
  it carried (`toHaveCount(0)` on both picker handles) could not distinguish the
  empty state working from the picker having been removed. Both are addressed by
  naming the state per test instead of inferring it.
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
