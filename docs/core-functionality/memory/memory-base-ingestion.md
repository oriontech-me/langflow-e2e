# Memory Base — ingestion: chunk settings, preview, folder connector, runs and cancel

**Last validated:** Langflow 1.13.x (`1.13.0.dev29`)

---

## What this test validates *(required)*

The ingestion half of Memory Base (QA-CHECKLIST §20.4, five of its seven bullets;
issue #2043). Registration is `memory-base-registration.spec.ts`; the two failure
modes — an unreachable embedding provider and the association guard — are #2044.

Every route here lives under `/api/v1/knowledge_bases`. That is not a naming slip:
a Memory Base owns a knowledge base, and the association guard answers `403` on
`/ingest`, `/chunks`, `/cancel` and `GET /{kb}` for a knowledge base a Memory Base
manages. So the ingestion pipeline is exercised on a plain knowledge base, which is
the only way a caller can reach it.

1. **should open Create Knowledge Base with the 1000 / 200 / newline defaults and
   apply the chunk settings chosen there to the stored chunks** — `@regression` for
   `langflow-ai/langflow#13884` (*"the initial chunk settings are not properly set"*,
   `LE-1688`). Through the Knowledge page: the dialog opens with chunk size `1000`,
   overlap `200` and separator `\n`; the test chooses `300` / `60`, uploads a
   document of short lines and creates the knowledge base. The preview the dialog
   shows and the chunks the ingestion stores are both cut at `300` with at most `60`
   carried over, the stored chunks begin with exactly the previewed ones, the
   knowledge base records `300` / `60` / `\n`, and after a reload its **Ingest
   Files** dialog opens pre-filled with `300` / `60` — the second half of #13884's
   reproduction, where it used to fall back to the defaults.
2. **should store exactly the chunks `preview-chunks` promised when every line fits
   the chunk size** — the attribution control for test 3. `POST /preview-chunks` and
   `POST /{kb}/ingest` with the same file and the same settings; the stored chunk
   contents, ordered by `chunk_index`, equal the previewed ones, one for one.
3. **should store exactly the chunks `preview-chunks` promised when a line is longer
   than the chunk size** — the same test with one line longer than the chunk size,
   which it asserts before ingesting. Every stored chunk is at most `chunk_size` and
   the stored chunks equal the previewed ones. `@regression` for LE-2771, fixed in
   `1.13.0.dev28` (see Notes). Until then the test was declared failing.
4. **should ingest a server-side folder through the `folder` connector and read its
   chunks back** — two files are placed in a folder only this test owns, ingested with
   `POST /{kb}/ingest/connector` (`source_type: "folder"`), and read back through
   `GET /{kb}/chunks?source_type=folder&job_id=<run>`: every chunk names one of the
   two files, and each file's sentinel line is in the chunks. `GET /{kb}/runs` lists
   the run and `GET /{kb}/runs/{id}` reports it `succeeded`, `source_type: "folder"`,
   `total_items: 2`, `succeeded: 2`, with `finished_at` set.
5. **should report an in-flight folder ingestion as running and, once cancelled, as
   cancelled with its chunks rolled back** — a folder ingestion big enough to take
   ~30 s is observed as `running` in both `GET /{kb}/runs` and `GET /{kb}/runs/{id}`
   (`finished_at: null`); `POST /{kb}/cancel` answers `200`; the run then reports
   `cancelled` with `error_message: "ingestion cancelled by user"` — never
   `succeeded` — and `GET /{kb}/chunks?job_id=<run>` holds no chunk from it.

---

## Tags *(required)*

| Test | Tags |
|---|---|
| 1 | `@stable` `@regression` `@files` `@ui-ux` |
| 2, 4, 5 | `@stable` `@api` `@files` |
| 3 | `@stable` `@regression` `@api` `@files` |

`@files` is the functional area (upload and ingestion, the same tag the
`knowledge-ingestion-management` specs and `memory-base-registration.spec.ts`'s API
test use); `@ui-ux` marks test 1 as the only one that drives the Knowledge page.
Test 1 carries `@regression` for #13884, and test 3 for LE-2771.

`@stable` from the first PR — `CONTRIBUTING.md` → *Tag @stable*: every new test enters
with the tag, and none of its four exceptions applies here (the file carries no lane
selector: the folder allow-list is set on every lane, not on a variant instance). Test 3
kept it while declared failing. The daily's auto-removal stripped it on 2026-10-01
(`c8cce0d2`), when the fix made the declared failure pass. It was restored together with
the lift (#2115).

---

## Validation criterion *(required)*

- **Test 1 proves the settings were applied, not merely sent.** The document is 120
  lines of 20 characters (`kb2043 line NNNN ok\n`), so the splitter has a boundary
  every 20 characters. Measured on `1.13.0.dev22` with `300` / `60`: **10 chunks**,
  none longer than 300, each one reopening with the last three lines of the one
  before (59 shared characters). With the `1000` / `200` defaults the same file gives
  **3** chunks — so the chunk count, the bound and the overlap each separate "the
  chosen settings" from "the defaults", and the three together cannot be satisfied by
  either default.
- **Test 1 reads the settings off what the server computed, not off the inputs.**
  An input that shows `300` while the request carries `1000` — #13884's actual shape,
  a frontend constant that disagreed with the backend — must fail here, and the
  request body itself cannot be read: Chromium does not expose a multipart body that
  carries a file (measured, `request.postData()` is `""` for both calls). So the test
  reads the three things the server derived from the dialog's requests: the
  `preview-chunks` response the dialog rendered (cut at 300, overlap ≤ 60), the
  chunks the ingestion stored (the same, and starting with the previewed ones), and
  the `chunk_size` / `chunk_overlap` / `separator` the knowledge base records
  (`GET /api/v1/knowledge_bases/{kb}` → `300` / `60` / `\n`).
- **The #13884 defaults are asserted on the create dialog before anything is typed**
  (`kb-chunk-size-input` = `1000`, `kb-chunk-overlap-input` = `200`,
  `kb-separator-input` = `\n`). They are disabled until a file is added, but their
  values render.
- **Tests 2 and 3 compare contents, not counts.** Each stored chunk (sorted by
  `metadata.chunk_index`) must equal the preview chunk at the same index, and there
  must be as many stored chunks as previewed ones. The preview's `total_chunks` is an
  estimate (`len(text) / (size - overlap)`, floored at the chunks it cut) and is not
  used; instead the documents are kept small enough that the preview is not
  truncated (fewer than `max_chunks: 50` chunks, from well under
  `50 * chunk_size * 3` characters), which the test asserts before comparing. The settings are
  the ones the UI sends by default for the separator (`\n`), with `chunk_size: 200`,
  `chunk_overlap: 0`. Test 3 also asserts no stored chunk exceeds `chunk_size`.
- **Test 3 differs from test 2 only by one line's length.** The two run the same
  helpers against the same endpoints with the same settings. So a red test 3 with a
  green test 2 points at the oversized line, which is LE-2771's shape. Test 3 asserts
  the line is longer than `chunk_size`. Without that check, a shortened constant would
  turn it into a second copy of test 2.
- **Tests 4 and 5 own their folder.** `POST /api/v1/files/upload/{flow_id}` stores an
  upload in `<config_dir>/<flow_id>/` (measured: `~/.cache/langflow/<flow_id>/…` in
  the nightly image), a directory keyed by a flow the test creates, so nothing another
  spec or worker uploads can enter the walk. The config directory is **read from the
  server**, not configured on the test side: it is `~/.cache/langflow` in the image,
  `${STATE_DIR}/data` on the source starter (one per shard port on the VM lane) and
  `~/Library/Caches/langflow` on a macOS pip install. The test asks the connector to
  walk `/` (non-recursive, with an extension no file carries, so it reads nothing even
  where `/` were admitted); the refusal names the enforced roots, resolved —
  `Folder / is outside the configured allow-list (/app/data/.cache/langflow).` — and
  the test ingests `<root>/<flow_id>` under the root that holds it. The parsing and the
  root search are unit-tested in `tests/helpers/knowledge/folder-source.test.ts`.
- **Test 4 asserts the run through both run endpoints**, the list (it must contain the
  run id, with `status: "succeeded"`) and the detail (counters, `items[]` naming both
  files, `finished_at`), and the chunks through the connector's own metadata
  (`source_type: "folder"`, `job_id` equal to the run id, `file_name` one of the two
  uploads). Each file carries a unique sentinel line, and both sentinels must be
  found among the chunks.
- **Test 5 requires having seen the run in flight before it cancels**, in both the
  list and the detail. A run that finished before the cancel landed fails the test
  naming that — it is never read as "cancel works". The cancelled run must also carry
  `finished_at`, and `GET /{kb}/chunks?job_id=<run>` must answer `total: 0` (the
  cancel path rolls back what the run had written).
- **A run is read once it has settled.** A run reports its terminal status a moment
  before its `finished_at`: the status is written into the job's metadata by
  `finalize_run`, `finished_at` is projected from the job row's `finished_timestamp`,
  which `execute_with_status` writes only after the ingestion returns. Measured ~70 ms,
  and a 20 ms poll landed inside it 2 times out of 3 (the first version of test 4
  failed on it 2 runs out of 2). `waitForRunToFinish` therefore waits for both, and
  fails naming the timestamp if a terminal run has none after 5 s — so a regression
  that stops setting `finished_at` still reddens the test.
- **A missing allow-list fails, it does not skip.** If the instance answers
  `400 "FolderSource refuses to walk without an allow-list. Configure
  LANGFLOW_KB_ALLOWED_FOLDER_ROOTS."`, tests 4 and 5 fail naming the variable and the
  start scripts that set it. Every lane sets it (see External dependencies), so a skip
  there would be an all-skip green on the one lane that lost it (#1010).
- **An unusable embedding model skips, naming why.** The embedding model is OpenAI
  `text-embedding-3-small`; when `collect-models` recorded `openai` inactive, every
  test skips through the provider-health gate with the recorded reason — never a
  silent pass (the rule #1399 set for Memory Base).
- **Cleanup is id-scoped**: every knowledge base the file creates is deleted by
  `dir_name`, every file in the test's flow folder through
  `DELETE /api/v1/files/delete/{flow_id}/{file_name}` (driven from
  `GET /api/v1/files/list/{flow_id}`, and confirmed empty), then the flow by id, and
  the embedding model's `enabled_models` flag is restored when test 1 flipped it.
  The order is load-bearing: **deleting a flow does not delete its uploads** — measured,
  the files outlive the flow on disk — and the file-delete route resolves the flow
  first, so after the flow is gone its files are unreachable through the API. Only the
  empty `<flow_id>` directory is left behind, which no route removes.

---

## External dependencies *(required)*

- **An embedding model** — OpenAI `text-embedding-3-small`, resolved through the
  `OPENAI_API_KEY` Langflow global variable that `tests/collect-models.spec.ts`
  imports. Test 1 additionally needs the model **enabled** in
  `GET /api/v1/models/enabled_models` (every embeddings model ships disabled), which
  the test sets before the page loads and restores afterwards. Cost per run is under
  a cent: test 5 is the largest, and it is cancelled within seconds.
- **`LANGFLOW_KB_ALLOWED_FOLDER_ROOTS=~/.cache/langflow` on the Langflow instance.**
  The `folder` connector refuses to walk without an operator allow-list, and the
  default is empty (`src/lfx/src/lfx/services/settings/groups/paths.py`,
  `src/lfx/src/lfx/base/knowledge_bases/ingestion_sources/folder.py`). Set on every
  lane's Langflow service (`pr-validation.yml`, `daily-stable.yml`, `manual.yml`,
  `nightly.yml`, `weekly-stable.yml`, `adaptive-impacted.yml`) and by every start
  script, always as the instance's own config directory: `~/.cache/langflow` for the
  image (kept literal, the server expands it), `~/.cache/langflow` and
  `~/Library/Caches/langflow` for the pip starter (Linux and macOS), and
  `${STATE_DIR}/data` for the source starter, which is where its
  `LANGFLOW_CONFIG_DIR` points — so the VM lane carries it through the starter
  (`scripts/lib/vm-env-parity.mjs`). The allow-list is exactly as wide as the
  directory the test writes into.
- **Routes** (all `/api/v1`): `knowledge_bases` `POST /`, `GET /{kb}`,
  `DELETE /{kb}`, `POST /preview-chunks`, `POST /{kb}/ingest`,
  `POST /{kb}/ingest/connector`, `GET /{kb}/chunks`, `GET /{kb}/runs`,
  `GET /{kb}/runs/{id}`, `POST /{kb}/cancel`, `GET /connectors`;
  `POST /files/upload/{flow_id}`, `GET /files/list/{flow_id}`,
  `DELETE /files/delete/{flow_id}/{file_name}`; `flows` create/delete;
  `models` + `models/enabled_models`. None of the `knowledge_bases` routes is in
  `/openapi.json` (`include_in_schema=False`).
- **Upstream source** the assertions derive from:
  `src/backend/base/langflow/api/v1/knowledge_bases.py` (`preview_chunks`,
  `ingest_files_to_knowledge_base`, `ingest_via_connector`, `list_ingestion_runs`,
  `get_ingestion_run`, `cancel_ingestion`),
  `src/backend/base/langflow/api/utils/kb_helpers.py` (`chunk_text_for_ingestion`,
  `perform_ingestion`, `write_documents_to_backend`),
  `src/backend/base/langflow/api/utils/ingestion_run_service.py` (run status),
  `src/backend/base/langflow/services/jobs/service.py` (`execute_with_status`), and
  the create dialog `src/frontend/src/modals/knowledgeBaseUploadModal/KnowledgeBaseUploadModal.tsx`
  with its defaults in `src/frontend/src/modals/knowledgeBaseUploadModal/constants.ts`.

---

## Notes

### The defect test 3 guards — preview and ingestion split differently (fixed)

**Fixed in `1.13.0.dev28`** by `langflow-ai/langflow#15421` (commit `63736e741`,
merged 2026-09-28). `chunk_text_for_ingestion` is now the single splitter for both
endpoints. It places the user's separator before the splitter's own fallbacks,
`[sep, "\n\n", "\n", " ", ""]` (read in the `1.13.0.dev29` image). Test 3 was
declared failing until the fix showed up as an unexpected pass on two dailies
(2026-09-30 on `dev28` and 2026-10-01 on `dev29`). It was then lifted to a normal
passing test (#2115). The rest of this section records the defect as it was.

Filed as **LE-2771**. Measured on `1.13.0.dev22` and re-measured on `1.13.0.dev25`;
both code paths have diverged since they were introduced together in
`langflow-ai/langflow#11541` (February 2026, release 1.8.0), with the dialog's `\n`
default in place from the start, so it had never worked before the fix and was not a regression. The dialog sends the same `separator` (`\n`, its
default) to both endpoints, and the backend builds two different splitters from it:

| | separators handed to `RecursiveCharacterTextSplitter` |
|---|---|
| `POST /preview-chunks` | `[sep, "\n\n", "\n", " ", ""]` |
| `POST /{kb}/ingest` (`chunk_text_for_ingestion`) | `[sep]` only — or the splitter's default when `sep` is empty |

With a single separator the splitter cannot break a piece that contains none, so a
line longer than `chunk_size` is stored whole. Same file, same `200` / `0` / `\n`:
the preview shows **7** chunks, none over 200 characters; the ingestion stores **4**,
two of them **540** and **240** characters. The preview's own docstring promises it
*"accurately reflects what will be stored"*. Extracted PDF text and paragraphs without
hard line breaks hit this routinely: with the dialog's untouched defaults
(1000 / 200 / `\n`), three ~1,500-character paragraphs are stored as three whole
chunks (the table reads Avg Chunk Size ≈ 1505), and a single 60,000-character line as
**one** 60,010-character chunk, where the preview showed ~75. Any non-empty separator
diverges — `\n\n` and `.`, the tooltip's own examples, included; a blank separator
does not, which was the only workaround before the fix. Test 3 cites LE-2771.
Not a regression, so it owes no `REGRESSIONS.md` row.

### The `finished_at` window (worked around, not asserted)

A run reports `succeeded` / `cancelled` ~70 ms before it reports a `finished_at` (see
the Validation criterion). `finalize_run` does write a `finished_at` into the job's
metadata at the same instant as the status, and `_job_to_run_row` ignores it in favour
of the job row's timestamp — so the fix is one line upstream, but a client polling for
a terminal status reads `finished_at: null` in the meantime. Recorded for the upstream
draft; the test waits it out rather than failing on a 70 ms race.

### Measured side effects of a cancel (not asserted)

After a cancel, the knowledge base row reads `status: "failed"` with
`failure_reason: "ingestion cancelled by user"`, and the underlying job reads
`completed` — a second `POST /{kb}/cancel` answers
`400 "Cannot cancel job with status 'completed'"`. `perform_ingestion` catches its own
cancellation and returns normally, so `execute_with_status` records a completion.
The run is what reports the cancellation, and it does so correctly; the job and the
row are recorded here so nobody re-derives them.

### Why the folder connector needs a lane change

Issue #2043 lists the `folder` connector as needing only *"a server-side folder the
instance can read"*. It also needs the operator allow-list above, which no lane set:
until this spec, every lane answered the `400` quoted in the Validation criterion.
§20.4's note that *"one connector ships today"* is also stale — `GET /connectors`
lists `folder`, `google_drive`, `onedrive` and `sharepoint` on `1.13.0.dev22`; the
three others need a connection and are out of scope.
