# Templates — the three knowledge-base templates run against an ingested sentinel (§11.5)

**File:** `tests/tests-automations/regression/core-functionality/templates/templates-run-knowledge.spec.ts`

**Last validated:** Langflow 1.13.x (nightly `1.13.0.dev25`, `langflowai/langflow-nightly:latest`,
measured 2026-09-27)

Owning issue: #2045 (row **E4** of the planned spec inventory in
`docs/core-functionality/templates/templates-coverage-scope.md`, the #1860 scoping pass) ·
**Depends on:** #2043 (merged — this spec reuses its ingestion helpers,
`tests/helpers/knowledge/ingestion.ts`, and its embedding model) · **Related:** #1452
(`page.flowErrorReport()`), #1372 / #1678 (a run can silently carry a model nobody picked),
#1864 (**S1**, instantiation — the structural half this spec does not repeat)

---

## What this test validates *(required)*

The three templates of QA-CHECKLIST §11.5 **execute** — retrieval included — against a
knowledge base the test itself fills. One test per template, literal titles:

1. **should run Knowledge Retrieval and show the ingested sentinel in its reply** — the
   template has no LLM: Chat Input → Knowledge (Retrieve) → Parser → Chat Output. Its
   Playground reply is the retrieved text, so it must contain the sentinel.
2. **should run Document Q&A with the ingested sentinel in the Agent's prompt** — Chat Input →
   Knowledge (Retrieve) → Parser → Prompt Template → Agent → Chat Output.
3. **should run Vector Store RAG with the ingested sentinel in the Agent's prompt** — the same graph
   shape as Document Q&A under its own node ids, prompt and system prompt.

Each test:

1. **Fills a knowledge base it owns** — creates one (`POST /api/v1/knowledge_bases`,
   OpenAI `text-embedding-3-small`, the #2043 embedding), ingests a three-line text file
   carrying a **per-test nonce** as its sentinel (`POST /{kb}/ingest`), waits for the run to
   settle as `succeeded` (`GET /{kb}/runs/{id}`, `waitForRunToFinish`) and reads the stored
   chunks back (`GET /{kb}/chunks`): exactly one chunk, containing the sentinel.
2. **Creates the flow from the template as the image registers it** — the entry of
   `GET /api/v1/flows/basic_examples/` with that exact name, with two fields set before the
   flow is created: the Knowledge node's `knowledge_base` (value and options) to the
   knowledge base from step 1, and — for the two Agent templates — the Agent's `model` to the
   one model the test pins (see *External dependencies*). Nothing else of the template is
   changed. The flow gets a unique name and is created with `POST /api/v1/flows/`.
3. **Runs it the way a user does** — opens `/flow/{id}`, opens the Playground
   (`playground-btn-flow-io`), types *"What is the Kestrel access codename?"* into
   `input-chat-playground` and presses Enter.
4. **Reads five observables**, listed under *Validation criterion*: what the run request
   carried, the Playground reply, the Knowledge node's retrieval, the Prompt node's output
   (Agent templates only) and the flow-error report.

### What it is **not**

- **Not instantiation.** Picking the card from the gallery is S1's contract
  (`templates-instantiate.spec.ts`), which proves the created flow's component types, edges,
  notes and wiring equal the same `basic_examples` entry this spec reads. Creating the flow
  from that entry through the API is therefore the template a user gets, minus the gallery
  click S1 already covers — and it is id-addressed, so parallel workers never share a flow.
- **Not the knowledge-base dropdown.** The knowledge base is set in the flow data, not
  picked from the node's `knowledge_base` dropdown; listing knowledge bases there is not what
  §11.5 asks.
- **Not ranking.** The knowledge base holds exactly one chunk and the Knowledge node keeps the
  template's `top_k = 5`, so the chunk is retrieved whatever the similarity. That is on
  purpose: the question is whether the template's graph carries retrieved text to its output,
  and a ranking assertion would couple that to embedding behaviour.
  `knowledge-ingestion-management/vector-store-index-query.spec.ts` owns ranking.
- **Not the model's wording.** The two Agent templates must reply, not reply *correctly*.
  gpt-4o-mini did echo the sentinel in every scout run, but a reply that repeats retrieved
  text is the model choosing to comply, so it is not asserted (the rule `test-targets.ts`
  records for #1187).
- **Not ingestion.** Chunk settings, preview, connectors, runs and cancel are #2043's
  (`memory/memory-base-ingestion.spec.ts`); here ingestion is setup, asserted only as far as
  "the sentinel is stored", so a retrieval miss cannot be an ingestion miss in disguise.

---

## Tags *(required)*

`@stable` `@release` `@templates` `@playground` on all three tests.

- `@templates` is the area; `@playground` because the run is driven from the Playground and
  the reply is read there.
- `@release`: Vector Store RAG is one of the three featured *Get started* cards and all three
  are the templates a user reaches for to try a knowledge base — a happy path that must work
  before a deploy.
- `@stable` from the first PR (`CONTRIBUTING.md` → *Tag @stable*): none of its exceptions
  applies — no lane selector, no known product defect, no model-dependent assertion.

---

## Validation criterion *(required)*

A test passes only when all of the following hold, in this order:

1. **The sentinel is stored.** The ingestion run reports `succeeded` with `finished_at` set,
   and `GET /{kb}/chunks` returns exactly one chunk whose content contains the nonce.
2. **The run carried what the test set, and nothing else was substituted.** The Playground's
   `POST /api/v2/workflows` request is captured and its live-canvas `data` must name the test's
   knowledge base on the Knowledge node and — for Document Q&A and Vector Store RAG — the
   pinned model and provider (`gpt-4o-mini` / `OpenAI` on the local run) on the Agent node. The
   run builds that payload, not the saved flow (#1372, #1678), so this is the only place a
   silent fallback shows. It matters here for cost as well as attribution: the first entry of
   these templates' model options is `gpt-5.5-pro`.
3. **The reply completed.** Exactly one bot message (`div-chat-message`), the stop button
   (`button-stop`) gone and the send button (`button-send`) back — the model-agnostic
   completion signal `memory-history-regression.spec.ts` settled on.
   - **Knowledge Retrieval:** the reply contains the nonce. This is Langflow's output, not a
     model's: Parser formats the retrieved row as `Text: {content}` and Chat Output shows it
     (measured: `Text: Project Kestrel field notes. The Kestrel access codename is <nonce>.
     Kestrel ships quarterly.`).
   - **Document Q&A / Vector Store RAG:** the reply, trimmed, is non-empty.
4. **The retrieval step contains the sentinel.** After the Playground closes
   (`playground-close-button`), the Knowledge node's `output-inspection-results-knowledge`
   opens the retrieved table; its grid (`.ag-center-cols-container [row-index]`) has exactly
   one row, and that row contains the nonce. The control is first asserted **enabled**: an
   empty retrieval leaves it disabled (*"Output can't be displayed"*), and without that
   assertion the force-fail below spent its whole click budget and reported a bare locator
   timeout instead of naming the empty retrieval. The dialog is closed with its `btn-close-modal`
   and asserted hidden — Escape does not close it while focus is inside the grid (measured),
   and a dialog left open intercepts every later click.
5. **The retrieved text reached the Agent — Document Q&A and Vector Store RAG.** The Prompt
   node's `output-inspection-prompt-prompt` shows the formatted prompt the Agent received, and
   it must contain both the nonce and the question. This is Langflow's formatting of the
   Parser's output into the template's `{context}` and `{question}`, not model output, so it
   is the model-free proof that retrieval fed the answer path (measured: `Context:\nText:
   Project Kestrel field notes.\nThe Kestrel access codename is <nonce>. …\nQuestion:\nWhat
   is the Kestrel access codename?`). Without it the two Agent tests would prove only that
   retrieval ran *somewhere* and that the Agent answered.
6. **The flow-error report is evaluated and clean.** `page.flowErrorReport()` returns
   `evaluated > 0` and `clean === true`. Both, because `clean` is vacuously true when no run
   stream was read (#1452); measured `evaluated: 1` per test.

**Why a per-test nonce and not a fixed sentinel.** Every test creates its own knowledge base,
so a fixed token would also be isolated — but a nonce additionally proves the retrieved text
came from *this* test's ingestion, so a stale reply or a knowledge base left over from another
run cannot satisfy steps 3–5.

**What would turn it red.** Retrieval returning nothing or another knowledge base's text
(steps 3–5); the Parser → Chat Output edge lost on Knowledge Retrieval (step 3) or the
Parser → Prompt edge lost on the Agent templates (step 5 — the prompt's context goes empty
while the Agent still answers, which is exactly the case step 5 exists for); a run that errors
anywhere in the graph (step 6, and the fixture's own gate); a run that silently swaps the
pinned model or knowledge base (step 2); and an ingestion that stores nothing (step 1).

**Force-fails, one per test, each aimed at the observable only that test holds** (run on
`1.13.0.dev25`, each red at the step named, reverted):

| Test | Mutation | Red at |
|---|---|---|
| Knowledge Retrieval | the Parser's pattern set to `Text: static` — a Parser that drops the retrieved content | step 3: the reply read `Text: static`, no nonce |
| Document Q&A | the Parser → Prompt edge removed before the flow is created | step 5: the Agent still answered and retrieval still returned the row, but the prompt's `Context:` was empty — the case step 5 exists for |
| Vector Store RAG | the Knowledge node's `metadata_filter` set to a key no chunk carries — retrieval returns nothing | step 4: *"the Knowledge node has no output to display — retrieval returned nothing"* |

The cleanup was force-failed too: with the `afterEach` deletes no-opped, one run left one flow
and one knowledge base behind; reverted, the same run left nothing.

**Cleanup is id-scoped** (#515, #553): the test deletes the flow by id — after leaving the
editor through `unmountEditorForCleanup` — and the knowledge base by `dir_name`, each in its own
`try` so one failing cannot leak the other. Deleting the knowledge base removes its chunks.
Measured after the scout runs: zero user flows and zero knowledge bases left on the instance.

**Parallel-safe, no serial mode.** Every flow and knowledge base carries the nonce in its
name and every locator is scoped to the test's own node ids, so the three tests share nothing.

---

## External dependencies *(required)*

- **OpenAI**, one provider for the whole file: the embeddings (`text-embedding-3-small`, the
  same model #2043 uses) and, for the two Agent templates, the chat model. The key must be a
  Langflow **global variable** (`OPENAI_API_KEY`), which `tests/collect-models.spec.ts` imports;
  `assertEmbeddingCredentialConfigured` fails fast and names that command when it is not. When
  `collect-models` recorded `openai` inactive, every test skips through
  `providerSkipGate("openai")` with the recorded reason.
- **The pinned chat model** is `resolveGptModel()` — the OpenAI model `collect-models` wrote to
  `models.json` (`gpt-4o-mini` on the local run). The file reads no `MODEL_TEST_*` pin and is not
  rotated by the daily (#1185): the embeddings already tie it to OpenAI, and a second provider
  for the Agent would double the ways a key outage skips it. No `models.json` means no pinned
  model, and the Agent tests fail naming `collect-models` rather than run a model nobody chose.
- **Cost** per run of the file: three one-chunk ingestions, three query embeddings and two short
  gpt-4o-mini Agent turns — well under a cent. Runtime: ~45 s for the three tests on one worker
  (Knowledge Retrieval ~2 s of run, the Agent templates 3–5 s).
- **Routes** (all `/api/v1` unless noted): `knowledge_bases` `POST /`, `DELETE /{kb}`,
  `POST /{kb}/ingest`, `GET /{kb}/runs/{id}`, `GET /{kb}/chunks`; `flows/basic_examples/`;
  `flows` create/delete; `variables/`; and `POST /api/v2/workflows`, the Playground run. None
  of the `knowledge_bases` routes is in `/openapi.json` (`include_in_schema=False`).
- **Upstream source** the assertions derive from: the three template JSONs under
  `src/backend/base/langflow/initial_setup/starter_projects/` (*Document Q&A*, *Knowledge
  Retrieval*, *Vector Store RAG*); the Knowledge component's `retrieve_data` in
  `src/lfx/src/lfx/components/files_and_knowledge/knowledge.py` (an empty search query is not an
  error — `similarity_search` runs without scores); the ingestion routes in
  `src/backend/base/langflow/api/v1/knowledge_bases.py`; the run request's `data` override in
  `src/backend/base/langflow/api/v2/workflow.py`.

---

## Notes

### Why the Playground and not a node run

The first scout ran the Chat Output node from the canvas, the way
`knowledge-ingestion-management/rag-pipeline.spec.ts` does. All three templates ship their Chat
Output **minimized** — the node renders as a title pill with no run control — so
`button_run_chat output` resolves to a hidden element and the run never starts. Expanding the
node would be a test-side edit of the template's presentation; the Playground is how these
chat templates are meant to be run, reaches the same `POST /api/v2/workflows` surface the
flow-error report watches, and leaves the template untouched.

### Measured on `1.13.0.dev25` (scout, 2026-09-27)

| Template | Run (send → reply) | Reply | Retrieved rows | Prompt output | Report |
|---|---|---|---|---|---|
| Knowledge Retrieval | ~2 s | `Text: …codename is <nonce>. Kestrel ships quarterly.` | 1, with the nonce | — (no Prompt) | `evaluated: 1`, `clean` |
| Document Q&A | 3–4 s | `The Kestrel access codename is <nonce>.` | 1, with the nonce | context + question | `evaluated: 1`, `clean` |
| Vector Store RAG | ~5 s | `The Kestrel access codename is <nonce>.` | 1, with the nonce | context + question | `evaluated: 1`, `clean` |

The run request carried `gpt-4o-mini` / `OpenAI` on the Agent node in every Agent run, and the
test's knowledge base on the Knowledge node in every run.
