# Spec: Vector Store indexing + query of an ingested document (§5.2 Processing and Vectorization)

**Test file:** `tests/tests-automations/regression/core-functionality/knowledge-ingestion-management/vector-store-index-query.spec.ts`

**Last validated:** Langflow 1.13.x

---

## What this test validates

The **vectorization + retrieval** step of RAG ingestion, on a running flow. It
picks up where the sibling Split Text spec (#673, `split-text-chunking.spec.ts`)
stops: the chunks produced by **Split Text** are **embedded and indexed** into a
**native Langflow Knowledge Base**, and a static **search query** is then run
against that index to retrieve the semantically relevant chunk.

It covers the two §5.2 checklist bullets that #673 deliberately left out:

- **§5.2.2 — Indexing in Vector Store (document available for query):** running
  the **Knowledge (Ingest)** node embeds every chunk and indexes it in the KB. A
  broken embeddings key or a failed index build fails this — the KB's chunk count
  is the causal proof that embeddings actually ran.
- **§5.2.3 — Vector Store query returns the relevant chunk:** with the index
  built, running **Knowledge (Retrieve)** answers the static `search_query` and
  its single top result is the one chunk of the document that is actually about
  the query's topic.

### Why the native Knowledge Base (not a vector-store bundle)

Every drop-in vector store in Langflow (FAISS, Chroma DB, …) is a **bundle**
(`ext:…@official`). A bundle-dependent `@stable` test would fail on a future
packaging change (bundles externalized to explicit installs) rather than on a
real regression — the same reasoning that kept #673 on core, bundle-free
components.

The **Knowledge** component (`files_and_knowledge/Knowledge`, non-legacy) is the
**core** vector-store primitive: it is backed by an embedded **ChromaDB** that
ships *inside* core Langflow (a library dependency, not an optional bundle
component), and it is what the current starter templates (Vector Store RAG,
Document Q&A) use for RAG. So this spec exercises real indexing + semantic
retrieval **without any bundle dependency**, and never yields a false failure on
a packaging change.

### Why these components (all confirmed live, non-legacy, on 1.11.0.dev38)

- **Chat Input → Split Text** — reused verbatim from #673: the deterministic,
  bundle-free source + chunker. Split Text is **required** here (not optional):
  the Knowledge component ingests **one chunk per input row**, and its
  `chunk_size` field is the *embedding batch size*, **not** a text splitter — so
  without Split Text the whole document ingests as a single chunk and retrieval
  becomes trivial. Feeding Split Text's 5-row DataFrame yields 5 distinct chunks,
  which is what makes the top-1 retrieval assertion meaningful.
- **Knowledge (Ingest)** — embeds + indexes the chunks into the KB.
- **Knowledge (Retrieve)** — a second Knowledge node in the same flow, over the
  same KB, `mode = Retrieve`, `top_k = 1`, static `search_query`.
- **Embedding**: the KB is created with Google `models/gemini-embedding-001` (the
  embedding model enabled out-of-the-box on the instance; `GOOGLE_API_KEY` is
  auto-imported as a credential and is injected in the daily-stable CI). No
  bundle, no per-user model enablement needed — the KB create API takes just the
  provider + model and resolves the embedding function from the credential at
  ingest time.

### Bundle/key guard

The Knowledge component is core, so **no bundle presence guard is needed**. The
spec **skips** when Google cannot serve a live call (the embedding model needs a
live key) — either `GOOGLE_API_KEY` is unset, or `collect-models` recorded the
provider `inactive` in `providers.json`. The gate is `providerSkipGate("google")`
(`helpers/provider-setup/provider-health.ts`), matching the provider-health skips
elsewhere in the suite: gating on the env var alone let a drained key through, and
the resulting hung call killed the shard's Langflow worker (#1029).

### Node-run wait strategy — race the badge against the failure signal (#1667)

`node_duration_knowledge` is an observable of a **successful** build, not of the
run having finished. The frontend renders it inside a ternary — success yields
`node_duration_<node>`, and every other build status falls through to
`node_status_icon_<node>_<status>`, which for an errored Knowledge run is
`node_status_icon_knowledge_undefined` and is **not visible at all**. A wait that
gates on the badge alone therefore cannot observe a failed run: it burns its whole
budget and reports `element(s) not found`, naming the badge instead of the cause.

This spec shares that surface, that provider and that failure mode with
`rag-pipeline.spec.ts`, whose ingest step failed on four dailies with an
unattributable 90 s timeout while the real reason — a Google Vertex project-wide
per-minute quota rejecting the embedding call with **429 RESOURCE_EXHAUSTED** on
`gemini-embedding` — was on screen within ~1 s. The two specs run on the same
shard, back to back, against the same quota, so they are fixed together (#1667).

Both Knowledge node runs go through the shared
`helpers/flows/run-node-and-wait.ts`, which:

1. Waits for the success badge **or** the page-level `Flow build failed` signal,
   whichever comes first (**45 s**; measured on 1.12.0.dev44 the badge appears in
   2–4 s and the failure signal in ~1 s).
2. On the failure signal, slices the reason out of the page text — it renders
   *next to* the signal, not inside it.
3. Retries the node run, bounded, only for a **provider rate-limit/quota** reason;
   anything else throws immediately, since a hard build error is not transient.
4. Throws with the on-screen reason once the retry budget is exhausted, so a
   sustained provider outage is still a red — never a silent skip, never a pass.

No assertion changes: the `chunks === 5` proof and the top-1 `embedding vector`
sentinel are untouched. The retry is scoped to the *provisioning* attempt only.

---

## Validation criterion (concrete, distinctive)

Fixture flow: `Chat Input → Split Text → Knowledge[Ingest]`, plus a standalone
`Knowledge[Retrieve]` node over the same KB (`top_k = 1`, static query). The
ingested document is the same 5-sentence document as #673 — each sentence on a
**distinct** RAG-pipeline topic, and exactly one (sentence 3) carries the verbatim
phrase `embedding vector`. The static query targets that one topic
(`"How is each chunk converted into a numerical embedding vector?"`).

Both tests create a **fresh, uniquely-named KB per run** (via the KB API) and
delete it in teardown.

- **Test 1 — index (§5.2.2):** run the Knowledge (Ingest) node; the
  successful-build badge `node_duration_knowledge` becomes visible, and
  `GET /api/v1/knowledge_bases/{name}` reports **exactly 5 chunks**. Because the
  ingest embeds every chunk against the live key and writes them to the KB, the
  chunk count is a causal proof the embeddings ran and the document is indexed —
  a broken key or index build leaves it at 0.
- **Test 2 — query (§5.2.3):** run Ingest (populate the KB), then run the
  Knowledge (Retrieve) node; open its `Results` output inspector. With
  `top_k = 1`, the ag-Grid shows **exactly one row**, and that row contains the
  sentinel phrase `embedding vector` (verbatim sentence 3). Because the other four
  sentences are on unrelated topics and only sentence 3 matches the query, the
  top-1 result is deterministic. A retrieval regression (wrong ranking, empty
  results, unindexed document) changes or empties that row.

Top-1 (not top-k) is asserted on purpose: with 5 chunks, a top-4 query would
return 4 of the 5 chunks and almost always contain the target regardless of
retrieval quality — a near-unfalsifiable check. Constraining to the single most
relevant result, against a lexically-close query over distinct-topic sentences,
is both sharp and deterministic.

---

## Tags

`@stable` `@release` `@components` `@files`

(`@files`: knowledge-ingestion surface — functional. `@components`:
canvas-component configuration. `@stable`/`@release` cross-cutting. Second §5.2
RAG spec, builds on #673; created `@stable` after deterministic validation on the
fresh nightly. Core Knowledge component — no bundle guard; skips cleanly when
Google is unusable — key absent or recorded `inactive`.)

---

## Step by step

Two tests, one shared fixture flow (`Chat Input → Split Text → Knowledge[Ingest]`
+ `Knowledge[Retrieve]`), imported via the API with a unique flow name per run.

**Guard (both tests):** skip if Google cannot serve a live call — `GOOGLE_API_KEY`
unset, or the provider recorded `inactive` in `providers.json`
(`providerSkipGate("google")`, #1029). `IGNORE_PROVIDER_HEALTH=1` overrides a stale
local `providers.json`.

**Setup (each test):**
1. Create a fresh KB via `POST /api/v1/knowledge_bases` — unique name per run,
   `embedding_provider = "Google Generative AI"`, `embedding_model =
   "models/gemini-embedding-001"`, `backend_type = "chroma"` (no `model_selection`
   needed — the KB resolves the embedding from provider + model at ingest time).
   Record the KB `dir_name` for teardown.
2. Load the fixture JSON and set `knowledge_base.value` **and**
   `knowledge_base.options = [dir_name]` on **both** Knowledge nodes (both are
   required for the DropdownInput to treat the value as a valid selection —
   setting `value` alone leaves the node showing "Select an option" and it will
   not run).
3. Create the flow via `POST /api/v1/flows/` (`createFlow`, unique name),
   record its id, navigate to `/flow/{id}`, wait for a Knowledge node title,
   then `adjustScreenView` so the node run controls are not occluded by the
   bottom react-flow toolbar panel.
4. Clear the canvas bottom-centre overlay slot once, up front
   (`clearCanvasBottomOverlay(page, { allowAlreadyClear: true })`), so the
   "Flow needs review" banner this fixture raises (3 outdated components on
   1.13.0.dev0) can never overlay any of the node-output clicks that follow. It
   runs after the node title is on screen, which is what makes an empty slot
   readable as "no banner" rather than as "not mounted yet" — measured mount is
   1-3 ms after that gate. `allowAlreadyClear` is set because a refreshed fixture
   would legitimately raise no banner at all.

**Test 1 — Indexing in Vector Store:**
1. Run Ingest: click `button_run_knowledge` scoped to the `Knowledge-ingest`
   node (`[data-id="Knowledge-ingest"]`).
2. Wait for the build badge `node_duration_knowledge` (scoped to that node) **or**
   the page-level `Flow build failed` signal, whichever lands first (45 s). A
   quota/rate-limit reason retries the node run within a bounded budget; any other
   reason throws at once, quoting the on-screen text (see *Node-run wait
   strategy*).
3. Assert `GET /api/v1/knowledge_bases/{dir_name}` reports `chunks === 5`.

**Test 2 — Vector Store query returns the relevant chunk:**
1. Run Ingest (as above); wait for its `node_duration_knowledge`.
2. Run Retrieve: click `button_run_knowledge` scoped to the `Knowledge-retrieve`
   node; wait for its `node_duration_knowledge`.
3. Open the Retrieve node's `Results` output inspector
   (`output-inspection-results-knowledge`, scoped to `Knowledge-retrieve`).
4. Assert the ag-Grid shows **exactly one row** (`[row-index]` count === 1) and
   that row contains the sentinel phrase `embedding vector`.

---

## External dependencies

- Fixture asset `tests/assets/flows/vector-store-index-query-fixture.json` —
  Chat Input (`input_value` = the 5-sentence sentinel document, same as #673) →
  Split Text (`chunk_size = 100`, `chunk_overlap = 0`, `separator = "\n"`) →
  Knowledge (`mode = Ingest`); plus a standalone Knowledge (`mode = Retrieve`,
  `top_k = 1`, `search_query` = the embedding-topic query). Both Knowledge nodes'
  `knowledge_base` is a placeholder (`__KB_NAME__`) the spec replaces per run.
  Built live on the canvas and exported on 1.11.0.dev38. Before the flow is
  created, `loadFixtureFlow` rehydrates every node's component `code` field from
  the running image's current catalog, since the stored source can drift from
  the image and a stale copy can fail to build the graph at all (#1478).
- `GOOGLE_API_KEY` — required (the KB embeds each chunk with
  `models/gemini-embedding-001`), **and** Google recorded `active` in
  `providers.json` by `collect-models` (#1029).
- Knowledge Base API: `POST /api/v1/knowledge_bases` (create),
  `GET /api/v1/knowledge_bases/{name}` (chunk count),
  `DELETE /api/v1/knowledge_bases/{name}` (scoped cleanup).
- Flows API: `POST /api/v1/flows/` (fixture create), `DELETE /api/v1/flows/{id}`
  (scoped cleanup).
- `tests/helpers/ui/clear-canvas-bottom-overlay.ts` — frees the canvas
  bottom-centre overlay slot at flow open (`allowAlreadyClear: true`), which
  Langflow shares between the build-status bar and the "Flow needs review / N
  components need updates" banner (#1643/#1675). The banner is raised because this
  fixture's nodes are behind the running image, it never leaves on its own, and a
  click under it is refused for the full `locator.click` budget. It replaces a
  private `dismissUpdateBannerIfPresent` that searched the whole page for the exact
  label `"Dismiss All"` — a label the banner only renders while more than one
  component is outdated.
- `src/frontend/src/pages/FlowPage/components/flowBuildingComponent/index.tsx` and
  `src/frontend/src/pages/FlowPage/components/UpdateAllComponents/index.tsx` — the
  two components that share that slot. Declared so
  `watch-upstream-areas.mjs --mode=check-docs` fails the PR that renames them.
- Component/UI testids (scouted live on 1.11.0.dev38): node ids `Knowledge-ingest`
  / `Knowledge-retrieve`; `button_run_knowledge`, `node_duration_knowledge`,
  `output-inspection-results-knowledge` (all scoped by node `data-id`); grid rows
  via `.ag-center-cols-container [row-index]`. The build-failure signal is the
  page-level `Flow build failed` text (i18n key `flowBuild.buildFailed`), the same
  signal `api/flows/api-component-regression.spec.ts` gates on; the reason renders
  adjacent to it, so it is read out of the page text rather than out of a
  container.

---

## What this test does not cover

- Split Text chunking itself (§5.2.1 — #673, `split-text-chunking.spec.ts`).
- The complete RAG pipeline with an LLM answer grounded on the retrieved chunks
  (§5.2.4 — #675).
- Drop-in vector-store bundles (FAISS, Chroma DB component, …) — the core
  Knowledge base is used precisely to stay bundle-free.
- File upload as the document source (§5.1); this spec sources the document from
  Chat Input to stay hermetic and deterministic.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (auto_login).
- `GOOGLE_API_KEY` configured in `.env` **and** Google recorded `active` by
  `collect-models` (else both tests skip — #1029).

---

## Flow cleanup

Both the flow and the KB are created via the API, so both ids/names are known up
front. Each test records the created flow id and KB `dir_name` and, in
`afterEach`, deletes exactly those (`deleteFlow` + `DELETE
/api/v1/knowledge_bases/{name}`, both 404-tolerant, scoped — never a global wipe,
which would delete resources other parallel workers are using, #515). The KB is a
persistent instance resource (unlike an in-memory store), so its teardown is
mandatory to avoid orphans. Orphan counts are checked via `GET
/api/v1/flows/` and `GET /api/v1/knowledge_bases` before reporting.
