# Spec: Full RAG pipeline — ingest → embed → store → retrieve → answer (§5.2 Processing and Vectorization)

**Test file:** `tests/tests-automations/regression/core-functionality/knowledge-ingestion-management/rag-pipeline.spec.ts`

**Last validated:** Langflow 1.11.x

---

## What this test validates

The **complete RAG pipeline end-to-end** (§5.2.4), on a running flow. It is the
final §5.2 step that the two sibling specs deliberately left out:

- #673 (`split-text-chunking.spec.ts`) covers §5.2.1 — deterministic chunking.
- #674 (`vector-store-index-query.spec.ts`) covers §5.2.2/§5.2.3 — embedding +
  indexing into a native Knowledge Base and semantic retrieval of the relevant
  chunk.

This spec adds §5.2.4 — the **answer** step: the chunk retrieved from the vector
store is fed to a language model, and the model's answer is proven to be
**grounded on that retrieved chunk** rather than on the model's own parametric
knowledge. That is the whole point of RAG, and the property this test is designed
to make falsifiable.

### The grounding observable (fabricated, unguessable fact)

The ingested document contains a **fabricated fact that no language model could
know from training**: sentence 3 states that each chunk is converted into an
embedding vector *"by the internal **ZEPHYR-42** codec"*. `ZEPHYR-42` is an
invented token; it exists only inside the document.

The pipeline's static question asks exactly for that codec name, and the test
asserts the Chat Output answer **contains `ZEPHYR-42`**. Because the token is
fabricated:

- If retrieval → context injection → the model answer all work, the answer echoes
  the verbatim `ZEPHYR-42` from the retrieved chunk.
- If retrieval is broken, the context empty, or the model answers from its own
  knowledge, it **cannot** produce `ZEPHYR-42` — the assertion fails.

The model runs at `temperature = 0`, so the grounded, verbatim token is
deterministic. This is sharper than asserting a real phrase from the document
(which a model could plausibly emit unaided) — a real-phrase check would carry a
latent false-positive; the fabricated token removes it.

### Topology (single fixture flow)

```
Ingest:  Chat Input(document) → Split Text → Knowledge[Ingest]
Answer:  Knowledge[Retrieve] → Parser → Prompt{context} → Language Model → Chat Output
```

- **Ingest side** — reused verbatim from #674: the deterministic, bundle-free
  Chat Input → Split Text → native Knowledge Base ingest. Split Text is required
  (the Knowledge component ingests one chunk per input row; its `chunk_size` is
  the embedding batch size, not a splitter), so the 5-sentence document yields
  exactly 5 indexed chunks.
- **Answer side** — `Knowledge[Retrieve]` (`mode = Retrieve`, `top_k = 1`, static
  `search_query`) returns the relevant chunk as a **Table**; a **Parser** converts
  that Table into a **Message** (the Retrieve output is JSON/Table, not a Message,
  so the Parser is the required bridge to the Prompt); the **Prompt** injects it
  into a single `{context}` variable and bakes the question into the template text
  (no Chat Input on the answer side — the question is static); the **Language
  Model** answers; **Chat Output** exposes the answer.

### Why the native Knowledge Base + these components (bundle-free)

Same rationale as #674: every drop-in vector store (FAISS, Chroma DB, …) is a
**bundle** (`ext:…@official`), so a bundle-dependent `@stable` test would fail on
a packaging change rather than a real regression. The **Knowledge** component
(`files_and_knowledge/Knowledge`, non-legacy) is the **core**, ChromaDB-backed
vector-store primitive; **Split Text**, **Parser**, **Prompt** and **Chat Output**
are all core; the **Language Model** component is core. So the whole pipeline is
bundle-free and never yields a false failure on a packaging change.

### Embedding + answer model (single-key: Google)

- **Embedding:** the KB is created with Google `models/gemini-embedding-001` (the
  embedding model enabled out-of-the-box; `GOOGLE_API_KEY` is auto-imported as a
  credential and injected in the daily-stable CI).
- **Answer:** the Language Model uses Google **`gemini-flash-latest`** at
  `temperature = 0`. Its `api_key` resolves from the same `GOOGLE_API_KEY` global
  variable (`load_from_db`), so the entire spec depends on **one** provider key —
  one skip guard, aligned with the daily-stable CI. The unified model selector's
  serialized value (`model` field, provider `Google Generative AI`) was captured
  live from the UI; hand-crafting it is unreliable because it overrides the legacy
  provider/model fields.

### Key/bundle guard

The components are all core, so **no bundle presence guard is needed**. The spec
**skips** only when `GOOGLE_API_KEY` is not configured (embedding + answer both
need a live Google key), matching the provider-key skips elsewhere in the suite.

## Validation criterion (concrete, distinctive)

Fixture flow as above. The ingested document is the #674 5-sentence document with
sentence 3 rewritten to carry the fabricated fact:
`"Each chunk is converted into a numerical embedding vector by the internal ZEPHYR-42 codec."`
The static retrieve query targets that sentence
(`"Which internal codec converts each chunk into a numerical embedding vector?"`),
and the Prompt asks the model to answer *with the exact codec name only*.

A **fresh, uniquely-named KB per run** (via the KB API) is created and deleted in
teardown.

**Single test — full pipeline (§5.2.4):**
1. Run the **Knowledge (Ingest)** node; its success-build badge
   `node_duration_knowledge` becomes visible, and `GET
   /api/v1/knowledge_bases/{name}` reports **exactly 5 chunks** — a precondition
   proof that the document is embedded + indexed (so a later answer failure is
   unambiguously an answer-side failure, not a broken ingest).
2. Run the **Chat Output** node (which pulls the whole answer chain
   Retrieve → Parser → Prompt → Language Model → Chat Output; the ingest branch is
   *not* upstream of Chat Output, so it does not re-run). Its
   `node_duration_...` badge becomes visible.
3. Open the Chat Output node's output inspector and read the answer; assert it
   **contains `ZEPHYR-42`** (case-sensitive, verbatim).

The answer observed live on 1.11.0.dev38 is exactly `ZEPHYR-42`.

> **Why the pipeline is run node-by-node, not via `POST /api/v1/run`.** Running
> the whole flow via the run/build API re-executes the ingest branch with an
> empty Chat Input (the document is only present when the ingest node runs on the
> canvas), which fails at `Knowledge[Ingest]` (`Column 'text' not found in
> DataFrame`). Ingest and answer must be run as separate node runs — exactly the
> #674 pattern. Running the **Chat Output** node builds only its upstream
> (Retrieve → … → Chat Output); Retrieve reads the KB already populated by the
> prior Ingest run.

---

## Tags

`@stable` `@release` `@components` `@files`

(`@files`: knowledge-ingestion surface — functional. `@components`:
canvas-component configuration. `@stable`/`@release` cross-cutting. Third and
final §5.2 RAG spec, builds on #673/#674; created `@stable` after deterministic
end-to-end validation on the fresh nightly. All-core components — no bundle guard;
skips cleanly only when `GOOGLE_API_KEY` is absent.)

---

## Step by step

One test, one shared fixture flow, imported via the API with a unique flow name
per run.

**Guard:** skip if `GOOGLE_API_KEY` is unset.

**Setup:**
1. Create a fresh KB via `POST /api/v1/knowledge_bases` — unique name per run,
   `embedding_provider = "Google Generative AI"`, `embedding_model =
   "models/gemini-embedding-001"`, `backend_type = "chroma"`. Record the KB `dir_name`
   for teardown.
2. Load the fixture JSON and set `knowledge_base.value` **and**
   `knowledge_base.options = [dir_name]` on **both** Knowledge nodes (both are
   required for the DropdownInput to treat the value as a valid selection).
3. Create the flow via `POST /api/v1/flows/` (`createFlow`, unique name), record
   its id, navigate to `/flow/{id}`, wait for a Knowledge node title, then adjust
   the canvas view so the target node run controls are rendered and clickable.

**Test — full RAG pipeline:**
1. Run Ingest: click `button_run_knowledge` scoped to `[data-id="Knowledge-ingest"]`;
   assert its `node_duration_knowledge` badge is visible.
2. Assert `GET /api/v1/knowledge_bases/{dir_name}` reports `chunks === 5`.
3. Run the answer path: click the Chat Output run button
   (`button_run_chat output`) scoped to `[data-id="ChatOutput-answer"]`; wait for
   its build badge.
4. Open the Chat Output output inspector
   (`output-inspection-output message-chatoutput`, scoped to
   `ChatOutput-answer`) and assert the answer text contains `ZEPHYR-42`.

---

## External dependencies

- Fixture asset `tests/assets/flows/rag-pipeline-fixture.json` — Chat Input
  (`input_value` = the 5-sentence document, sentence 3 carrying the fabricated
  `ZEPHYR-42` codec fact) → Split Text (`chunk_size = 100`, `chunk_overlap = 0`,
  `separator = "\n"`) → Knowledge (`mode = Ingest`); plus Knowledge
  (`mode = Retrieve`, `top_k = 1`, `search_query` = the codec question) → Parser →
  Prompt (`{context}` + baked question) → Language Model (Google `gemini-flash-latest`,
  `temperature = 0`, `api_key` from the `GOOGLE_API_KEY` global variable) → Chat
  Output. Both Knowledge nodes' `knowledge_base` is a placeholder (`__KB_NAME__`)
  the spec replaces per run. Built + configured live on the canvas and validated
  end-to-end on 1.11.0.dev38.
- `GOOGLE_API_KEY` — required (embeds each chunk with `models/gemini-embedding-001` and
  answers with `gemini-flash-latest`).
- Knowledge Base API: `POST /api/v1/knowledge_bases` (create),
  `GET /api/v1/knowledge_bases/{name}` (chunk count),
  `DELETE /api/v1/knowledge_bases/{name}` (scoped cleanup).
- Flows API: `POST /api/v1/flows/` (fixture create), `DELETE /api/v1/flows/{id}`
  (scoped cleanup).
- Component/UI testids (scouted live on 1.11.0.dev38): node ids `Knowledge-ingest`,
  `Knowledge-retrieve`, `Parser-answer`, `Prompt-answer`, `LanguageModel-answer`,
  `ChatOutput-answer`; `button_run_knowledge`, `node_duration_knowledge` (scoped by
  Knowledge node `data-id`); `button_run_chat output`,
  `output-inspection-output message-chatoutput` (scoped by `ChatOutput-answer`);
  the answer text is the `textarea` inside the Component Output dialog.

---

## What this test does not cover

- Split Text chunking itself (§5.2.1 — #673, `split-text-chunking.spec.ts`).
- Vector-store indexing + retrieval in isolation (§5.2.2/§5.2.3 — #674,
  `vector-store-index-query.spec.ts`). This spec re-asserts the 5-chunk index only
  as a precondition, not as new coverage.
- Drop-in vector-store bundles (FAISS, Chroma DB component, …) — the core
  Knowledge base is used precisely to stay bundle-free.
- File upload as the document source (§5.1); this spec sources the document from
  Chat Input to stay hermetic and deterministic.
- Multi-turn / conversational RAG, re-ranking, and multi-document retrieval.

---

## Preconditions

- Langflow running at `PLAYWRIGHT_BASE_URL` (auto_login).
- `GOOGLE_API_KEY` configured in `.env` (else the test skips).

---

## Flow cleanup

Both the flow and the KB are created via the API, so both ids/names are known up
front. The test records the created flow id and KB `dir_name` and, in
`afterEach`, deletes exactly those (`deleteFlow` + `DELETE
/api/v1/knowledge_bases/{name}`, both 404-tolerant, scoped — never a global wipe,
which would delete resources other parallel workers are using, #515). The KB is a
persistent instance resource, so its teardown is mandatory to avoid orphans.
Orphan counts are checked via `GET /api/v1/flows/` and `GET
/api/v1/knowledge_bases` before reporting.
