# Spec: Split Text chunking of an ingested document (§5.2 Processing and Vectorization)

**Test file:** `tests/tests-automations/regression/core-functionality/knowledge-ingestion-management/split-text-chunking.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

The **processing** step of RAG ingestion, on a running flow: a document
(delivered as a `Message` by **Chat Input**) is fed into the **Split Text**
component and **split into the expected number of chunks** for a known
`Chunk Size`. This is the deterministic, standalone-observable part of §5.2.1.

### Scope boundary — why embeddings are not here

The §5.2 bullet names "Split Text **+ Embeddings** component", but the two do not
form a runnable data pipeline on their own: Split Text emits a chunk DataFrame,
while an embeddings component (OpenAI Embeddings, the core **Embedding Model**,
etc.) emits a *model object*, not vectors. They only connect **through a vector
store**, which is where the chunks actually get embedded and indexed.

Every vector store in Langflow is a **bundle** (`ext:…@official`), not a core
component — and bundles may in future require explicit installation, which would
make a bundle-dependent `@stable` test fail on packaging changes rather than on
real regressions. The only core, non-legacy way to observe embeddings is
therefore *nonexistent* (the `Text Embedder` that could is `legacy`). So real
embedding execution is deliberately **out of scope here** and belongs to the
Vector Store spec (**#674**, §5.2.2 "Indexing in Vector Store") and the full RAG
pipeline spec (**#675**, §5.2.4), where the bundle dependency is inherent and
handled with a presence guard. This spec stays on core, bundle-free components
so it never yields a false failure on a packaging change.

### Why these components

- **Chat Input** is the source: `Text Input` became `legacy` and is hidden from
  the sidebar, so Chat Input is the current non-legacy `Message` source. Its
  static `input_value` makes the document deterministic (no upload lifecycle).
- **Split Text** (`processing/SplitText`, non-legacy, core) is the chunking
  component under test.

## Validation criterion (concrete, distinctive)

Opening the pre-wired fixture flow and running the Split Text node:

- after `button_run_split text` succeeds (`node_duration_split text` badge), the
  **Chunks** output inspector (`output-inspection-chunks-splittext`) renders an
  ag-Grid with **exactly 5 data rows** (`[row-index]` count === 5), and
  **exactly one** of those rows carries a distinctive verbatim phrase from the
  ingested document (`embedding vector`) — scoped to the grid, since the
  document is also echoed in the playground preview.

The document is 5 newline-separated sentences, each 91–97 chars, with
`Chunk Size = 100` and `Chunk Overlap = 0`; since no adjacent pair fits in 100
chars, each sentence becomes its own chunk → deterministically 5. A regression
in the split logic changes the row count; a broken component fails the run — both
are specific, causal observables, not a vague "the node rendered".

---

## Tags

`@stable` `@release` `@components` `@files`

(`@files`: knowledge-ingestion surface — functional. `@components`:
canvas-component configuration + `@stable`/`@release` cross-cutting. First-mover
RAG/§5.2 spec; created `@stable` after deterministic validation on the fresh
nightly.)

---

## Step by step

One test, one fixture flow (Chat Input → Split Text), imported via the API.

**Setup:** create the fixture flow via `POST /api/v1/flows/` (`createFlow`,
unique name per run), capture its id for scoped cleanup, navigate to
`/flow/{id}`, wait for the Split Text node title, then call `adjustScreenView`
so the node run control is not occluded by the bottom react-flow toolbar panel.

1. Run Split Text: click `button_run_split text`.
2. Assert the successful build badge `node_duration_split text` is visible
   (Chat Input builds as its upstream dependency).
3. Open the Chunks output inspector `output-inspection-chunks-splittext`.
4. Assert the ag-Grid shows **exactly 5 rows** (`locator('[row-index]')` count
   === 5) and that **exactly one** row contains the sentinel phrase.

---

## External dependencies

- Fixture asset `tests/assets/flows/split-text-chunking-fixture.json` —
  Chat Input (`input_value` = the 5-line sentinel document) →
  Split Text (`chunk_size = 100`, `chunk_overlap = 0`, `separator = "\n"`).
  Built and validated on 1.11.0.dev38.
- Component/UI testids (scouted live on 1.11.0.dev38):
  `title-Split Text`, `button_run_split text`, `node_duration_split text`,
  `output-inspection-chunks-splittext`; chunk rows via `[row-index]`.
- Flows API: `POST /api/v1/flows/` (fixture create), `DELETE /api/v1/flows/{id}`
  (scoped cleanup).
- No model provider credentials required (pure text split, no LLM/embeddings).

---

## What this test does not cover

- Embedding the chunks / vector-store indexing (§5.2.2 — #674, requires a
  bundle vector store).
- Vector-store query / relevant-chunk retrieval (§5.2.3 — #674).
- The complete RAG pipeline with an LLM answer (§5.2.4 — #675).
- File upload as the document source (§5.1 — `upload-via-component.spec.ts`,
  `file-types-upload.spec.ts`); this spec sources the document from Chat Input
  to stay hermetic.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (auto_login).

---

## Flow cleanup

The fixture flow is created via the API, so its id is known up front. The test
records the created id and deletes exactly that flow in `afterEach`
(`deleteFlow`, 404-tolerant, scoped — never a global `cleanAllFlows`, which
wipes flows other parallel workers are building, #515). No files are uploaded,
so there is no file-store artifact to clean. Orphan count is checked via
`GET /api/v1/flows/` before reporting.
