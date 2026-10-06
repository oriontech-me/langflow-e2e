# Memory Base — ingestion failure modes: unreachable embedding provider and the association guard

**Last validated:** Langflow 1.13.x (`1.13.0.dev33`)

**File:** `tests/tests-automations/regression/core-functionality/memory/memory-base-ingestion-failures.spec.ts`

---

## What this test validates *(required)*

The two §20.4 bullets `memory-base-ingestion.spec.ts` (#2043) left open (issue
#2044): an ingestion whose embedding provider cannot be used fails **naming the
provider**, and a knowledge base a Memory Base manages refuses the generic
knowledge-base routes through `_check_memory_base_association`.

Every route is under `/api/v1/knowledge_bases`, like #2043's, and every test is
API-level — no test opens the browser.

1. **should refuse every guarded knowledge-base route for a knowledge base a Memory
   Base manages** — a Memory Base is registered through `POST /api/v1/memories`,
   which creates its knowledge base (`kb_name` = `<name>_<8 hex>`). Each of the
   **eight** routes the API declares the guard on answers `403` with
   `Access denied: knowledge base '<kb_name>' is managed by a Memory Base.`:
   `GET /{kb}`, `DELETE /{kb}`, `GET /{kb}/chunks`, `GET /{kb}/metadata/keys`,
   `POST /{kb}/ingest`, `POST /{kb}/ingest/folder`, `POST /{kb}/ingest/connector` and
   `POST /{kb}/cancel`. The bulk `DELETE /` does not delete it either — it answers
   `200` with `deleted_count: 0` and names the knowledge base in
   `memory_base_skipped`. After all nine calls the refusals are shown to have been
   refusals: the three ingest calls started **no run** (`GET /{kb}/runs` →
   `total: 0`) and the Memory Base is still listed by
   `GET /api/v1/memories?flow_id=<id>` with the same `kb_name`.
2. **should fail an ingestion whose embedding provider cannot be reached, naming the
   provider** — on a throwaway user that has configured nothing, two knowledge bases
   ingest the same one-line file: one on Ollama `all-minilm` (no `OLLAMA_BASE_URL`,
   so the server falls back to its own `http://localhost:11434`, where no Ollama
   listens) and one on Google `models/gemini-embedding-001` (no `GOOGLE_API_KEY`).
   Each run ends `failed` — never `succeeded` — with an `error_message` that names
   the provider (`Failed to connect to Ollama…` / `Google Generative AI API key is
   required…`), `chunks_created: 0` and a `finished_at`; the knowledge base records
   `status: "failed"` with that same message as its `failure_reason`, and holds no
   chunk.
3. **should send an Ollama ingestion to the server `OLLAMA_BASE_URL` names** —
   `@regression` for `langflow-ai/langflow#13883` (`LE-1689`). On a throwaway user,
   `OLLAMA_BASE_URL` is set to the lane's Ollama, and a knowledge base on an Ollama
   embedding model that server **does not serve** ingests a file. The run fails with
   the configured server's own answer — `model "<model>" not found, try pulling it
   first (status code: 404)` — which only a request that reached that server can
   produce. Before the fix, ingestion ignored the variable and called
   `http://localhost:11434`, so the same run failed with `Failed to connect to
   Ollama` instead: test 2's message, which is exactly what this test must not see.
4. **should keep the Google embedding models the Knowledge dialog offers to ones
   Google still serves** — `@regression` for `langflow-ai/langflow#12277`. The
   catalog request the Create Knowledge Base dialog makes, `GET
   /api/v1/models?purpose=use`, offers Google embedding models, none of them flagged
   `deprecated` and neither of the two that Google's v1beta endpoint answers `404`
   for (`models/text-embedding-004`, `models/embedding-001`). With
   `include_deprecated=true` every model the catalog flags `deprecated` is one the
   default listing leaves out — so the filter, not an accident of the catalog, is
   what keeps them out of the dialog.

---

## Tags *(required)*

| Test | Tags |
|---|---|
| 1, 2 | `@stable` `@api` `@files` |
| 3, 4 | `@stable` `@regression` `@api` `@files` |

`@files` is the functional area, the tag #2043's and the `knowledge-ingestion-management`
specs use. `@model-provider` is deliberately **not** applied: tests 1, 2 and 4 need no
provider at all, and `scripts/provider-dependent-specs.mjs` reads that tag as "needs the
provider sweep", which would exclude them from the PR lane whenever a helper they import
changes. Tests 3 and 4 carry `@regression` for #13883 and #12277.

`@stable` from the first PR — `CONTRIBUTING.md` → *Tag @stable*: none of its exceptions
applies (no lane selector; test 3's Ollama runs on the daily, the manual lane and the VM
lane, and is an explicit skip where there is none, as in `ollama-provider.spec.ts`).

Quarantined 2026-10-05 (#2175) (tests 1–3) together with every spec that creates a knowledge base
through `helpers/knowledge/knowledge-base.ts`: the helper still asked for `backend_type:
"chroma"`, which langflow-ai/langflow#15509 retired on the 1.13 line (`1.13.0.dev33`
answers `422`). The helper now creates `sqlite` knowledge bases and the tag is back.

---

## Validation criterion *(required)*

- **Test 1 asserts the exact refusal on every route, with a schema-valid body.** A
  guard reached only through a malformed body could be a `422` masquerading as
  protection, or a `403` from some other layer. So each call carries a request the
  route's schema accepts — a text file for `/ingest`, `{path}` for `/ingest/folder`,
  `{source_type: "folder", source_config: {path}}` for `/ingest/connector` — and the
  expected body is the guard's own sentence naming the `kb_name`, not merely a status.
- **Test 1 has its attribution control in the same test.** A plain knowledge base the
  test creates answers the same read routes normally (`GET /{kb}` → `200`,
  `/chunks` → `200`, `/metadata/keys` → `200`, `POST /{kb}/cancel` → `404` *"No
  ingestion job found"*) and its `DELETE /{kb}` → `200`; the two folder routes answer
  `400` (*"Folder /nonexistent-kb2044 does not exist."*), which shows the same bodies
  reach the route rather than a `422`. So the `403` is the association, not
  ownership, authentication, the body, or the knowledge base not existing.
  `POST /{kb}/ingest` is left out of the control: it would start a real embedding
  call.
- **Test 1 proves the refusals refused.** `GET /{kb}/runs` is **not** guarded (it
  answers `200` for a Memory Base's knowledge base — measured, and recorded in the
  Notes); the test uses that to show the three ingest calls started nothing
  (`total: 0`). The Memory Base still being listed with the same `kb_name` after the
  single and bulk deletes shows those did not delete it.
- **Test 2 runs on a throwaway user.** `OLLAMA_BASE_URL` and `GOOGLE_API_KEY` are
  per-user global variables shared by every test of the superuser: the daily imports
  `GOOGLE_API_KEY` through `collect-models`, and `ollama-provider.spec.ts` sets
  `OLLAMA_BASE_URL`. A fresh user is the only state in which "nothing is configured"
  is a fact rather than an assumption about test order. Its premise is asserted, not
  assumed: before it ingests, the user's `GET /api/v1/variables/` holds neither name.
  (It is not empty — a new user is seeded with four valueless placeholders,
  `ASTRA_TOKEN`, `COMPONENT_ID`, `FIELD_NAME` and `FLOW_ID`; measured.)
- **Test 2 reads the failure off both the run and the knowledge base.** The run
  (`GET /{kb}/runs/{id}` once settled — `waitForRunToFinish`, #2043) is `failed`,
  never `succeeded`, with `chunks_created: 0` and `finished_at` set; `GET /{kb}`
  reports `status: "failed"` with `failure_reason` equal to the run's
  `error_message`; `GET /{kb}/chunks` answers `total: 0`. The provider is named by
  the message: `/Failed to connect to Ollama/` and `/Google Generative AI API key is
  required/` (which also names `GOOGLE_API_KEY`).
- **Test 3 is the one that discriminates #13883, test 2 is its control.** Both ingest
  on Ollama; the only difference is whether `OLLAMA_BASE_URL` is set. Test 2's run
  fails with `Failed to connect to Ollama` (the server's own `localhost`); test 3's
  fails with the configured server's `404` naming the model. #13883's fix (PR
  `langflow-ai/langflow#13901`, `ollama_base_url=None` in
  `KBIngestionHelper.build_embeddings`) is exactly what turns the first message into
  the second, so reverting it reddens test 3 and leaves test 2 green.
- **Test 3 picks a model the configured server does not serve, from the server.**
  `readOllamaCapabilities` (the probe `ollama-provider.spec.ts` uses) reads the
  instance's tags from the test host; the model is the first Ollama embedding model
  in Langflow's catalog (`GET /api/v1/models?purpose=use`) that is **not** among
  them. A lane whose Ollama served every catalog model would be a skip naming that,
  never a green. `OLLAMA_BASE_URL` is set through `POST /api/v1/variables/`, which
  validates it — it answers `400 "Invalid Ollama base URL"` for an address Langflow
  cannot reach — so a `200` there is itself evidence Langflow reached the server.
- **Test 3 skips, naming why, where there is no Ollama.** No Ollama reachable at
  `OLLAMA_BASE_URL` from the test host is an explicit `test.skip` with the probe's
  reason — the PR lane runs none — the same rule `ollama-provider.spec.ts` follows.
- **Test 4 issues the dialog's own query.** Opening Create Knowledge Base fires
  `GET /api/v1/models?purpose=use` and `GET /api/v1/models/enabled_models?purpose=use`
  (measured on `1.13.0.dev28`); the first is the catalog it lists from, and it passes
  no `include_deprecated`. The test asserts on that exact query, filtered to
  `metadata.model_type === "embeddings"` for the `Google Generative AI` provider, and
  requires it to be **non-empty** — an empty Google list would satisfy "no retired
  model" vacuously.
- **Cleanup is id-scoped.** Test 1 deletes its Memory Base through
  `DELETE /api/v1/memories/{id}` (`204`, which takes the knowledge base with it — the
  test confirms `GET /{kb}` then answers `404`), its plain knowledge base, and its flow.
  Tests 2 and 3 delete each knowledge base as the throwaway user, then the user as the
  superuser (which takes its variables with it). Only the user's empty
  `knowledge_bases/<username>/` directory is left on disk, which no route removes —
  the same residue #2043 records for its empty `<flow_id>` upload directory.
  Every teardown step runs even when an earlier one throws, and the failures are
  rethrown together (#2175): a failed delete used to abort the hook before the flow's.

---

## External dependencies *(required)*

- **None for tests 1, 2 and 4** — no provider key, no model, no external service.
  Test 2 relies on the instance not serving an Ollama on its **own**
  `http://localhost:11434`: true in every lane's container and on the VM lane, whose
  Ollama binds an RFC-1918 address (`scripts/start-ollama-source.sh`). A pip install
  on a machine that runs Ollama on its loopback would make that run reach it.
- **Test 3: an Ollama reachable by Langflow**, at `OLLAMA_BASE_URL_FROM_LANGFLOW`
  (typed into Langflow) and `OLLAMA_BASE_URL` (probed from the test host) —
  `tests/helpers/provider-setup/ollama-endpoint.ts`. The daily, `manual.yml` and
  `nightly.yml` run `ghcr.io/<repo>/ollama-e2e:llama3.2-1b`, the VM lane
  `scripts/start-ollama-source.sh`; locally the Mac's own Ollama through
  `host.docker.internal`. It needs `LANGFLOW_SSRF_ALLOWED_HOSTS` covering that
  address, which every lane sets. No model is needed on it — the test uses one it
  does not serve.
- **Routes** (all `/api/v1`): `knowledge_bases` `POST /`, `GET /{kb}`,
  `DELETE /{kb}`, `DELETE /` (bulk), `GET /{kb}/chunks`, `GET /{kb}/metadata/keys`,
  `POST /{kb}/ingest`, `POST /{kb}/ingest/folder`, `POST /{kb}/ingest/connector`,
  `POST /{kb}/cancel`, `GET /{kb}/runs`, `GET /{kb}/runs/{id}`; `memories` `POST`,
  `GET ?flow_id=`, `DELETE /{id}`; `models?purpose=use` (± `include_deprecated`);
  `variables/`; `users/` (create, `PATCH` to activate, delete) and `login` (one per
  throwaway user — OSS limits it to 5/min per IP, which `postLogin` waits out);
  `flows` create/delete.
- **Upstream source** the assertions derive from:
  `src/backend/base/langflow/api/v1/knowledge_bases.py` (`_check_memory_base_association`,
  `_record_is_memory_base_associated`, `_kb_is_memory_base`, the eight decorated routes,
  `delete_knowledge_bases_bulk`, `list_ingestion_runs`),
  `src/backend/base/langflow/api/utils/kb_helpers.py` (`KBIngestionHelper.build_embeddings`),
  `src/lfx/src/lfx/base/models/unified_models/instantiation.py` (`get_embeddings`, the
  `OLLAMA_BASE_URL` resolution order), `src/backend/base/langflow/api/v1/models.py`
  (`list_models`, `include_deprecated`) and
  `src/lfx/src/lfx/base/models/google_generative_ai_constants.py`
  (`_GOOGLE_DEPRECATED_EMBEDDING_MODELS`).

---

## Notes

### Measured on `1.13.0.dev28`

| Case | Run | Message | Time |
|---|---|---|---|
| Ollama, no `OLLAMA_BASE_URL` | `failed` | `Failed to connect to Ollama. Please check that Ollama is downloaded, running and accessible. https://ollama.com/download` | ~22 s |
| Ollama, `OLLAMA_BASE_URL` → Mac Ollama, `all-minilm` (served) | `succeeded`, 1 chunk | — | ~3 s |
| Ollama, same server, `bge-m3` (not served) | `failed` | `model "bge-m3" not found, try pulling it first (status code: 404)` | ~22 s |
| Google, no `GOOGLE_API_KEY` | `failed` | `Google Generative AI API key is required. Please provide it in the component or configure it globally as GOOGLE_API_KEY.` | ~2 s |

The ~22 s is the embedding call retrying, not the test waiting. A failed run reports
`total_items: 0`, `failed: 0` although a file was submitted — the embeddings are built
before any item is processed, so no item is counted. Recorded, not asserted.

### The issue's wording and what #13883 was

Issue #2044 lists #13883 as *"an unreachable Ollama endpoint"*. The reported defect
was the opposite: the user's Ollama **was** reachable (from flows, from Model
Providers, by `curl`) and ingestion still said `Failed to connect to Ollama`, because
it ignored `OLLAMA_BASE_URL` and called `localhost:11434`. A test that only points
ingestion at an unreachable Ollama and expects that message would pass before and
after the fix, so it is not a regression test for #13883 — it is test 2, the
failure-mode contract. Test 3 is the regression test.

The success path (`all-minilm` → `succeeded`) is the stronger form of test 3, and is
not the one asserted because no lane's Ollama serves an embedding model: the CI image
bakes `llama3.2:1b` only, and Ollama refuses `/api/embed` on a completion model
(`This server does not support embeddings`). Baking `all-minilm` (~46 MB) into
`docker/ollama-e2e/Dockerfile` would allow it.

### #12277 is a filter, not a removal

The two retired Google embedding models are still in the catalog, flagged
`deprecated: true` (`_GOOGLE_DEPRECATED_EMBEDDING_MODELS`), and `list_models` leaves
deprecated models out unless `include_deprecated=true`. The page itself makes an
`include_deprecated=true` request on load; the dialog's picker does not. A live Google
ingestion per offered model would be the stronger check and is not included: it needs
a working `GOOGLE_API_KEY`, the local one answers `401`, and the pipeline force-fails
every test locally.

### Guard coverage the issue under-counted

Issue #2044 says the guard is declared on five routes and #2043's doc names four. On
`1.13.0.dev28` it is declared on eight, listed in test 1; the bulk delete applies the
same check through the non-raising `_kb_is_memory_base`, and the route bodies re-run it
through `_assert_kb_not_memory_base` for a knowledge base reached through a share.
`GET /{kb}/runs` and `GET /{kb}/runs/{id}` carry no guard; both are owner-scoped
(`_guard_kb_action`), so this exposes a user's own Memory Base run history to that user
only — recorded, not asserted either way.
