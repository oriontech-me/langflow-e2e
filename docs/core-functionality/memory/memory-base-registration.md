# Memory Base — registering a memory base end-to-end

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

The write half of the memory-base surface: **completing the Create Memory form
actually registers a memory base**, and the registration is real server state
rather than optimistic UI. The read half — the panel, the modal's controls,
defaults and submit gate — is `memory-base-panel.spec.ts` (issue #1398) and is
deliberately not repeated here.

1. **should register a memory base from the Create Memory modal** — with an
   embeddings provider configured, filling Name and selecting an Embedding Model
   enables `Create Memory`; submitting it answers `201` on
   `POST /api/v1/memories`, the memory appears in the Memories panel, and
   `GET /api/v1/memories?flow_id=<id>` reports it with a server-assigned `id`
   and `kb_name`. The panel is then re-read **after a full page reload**, which
   is what distinguishes persisted state from an optimistic local render.
   Skips, naming the state, when no configured provider exposes an embeddings
   model.
2. **should expose a registered memory base through the Memory Base API only,
   never through the generic knowledge-base list** — a memory base created
   through `POST /api/v1/memories` is listed by `GET /api/v1/memories` and its
   `kb_name` is **absent** from `GET /api/v1/knowledge_bases`. Provider-free, so
   this half of the file has coverage on any instance.

---

## Tags *(required)*

Test 1: `@release` `@workspace` (cross-cutting) + `@ui-ux` `@model-provider`
(functional).
Test 2: `@api` `@workspace` (cross-cutting) + `@files` (functional).

`@model-provider` is on test 1 only — it is the only one that resolves a model.
`@files` on test 2 is the repo's functional tag for the knowledge/vector
ingestion family, which is the resource boundary that test asserts.

**`@stable` decision:** both. Test 2 is provider-free and fully deterministic.
Test 1 skips loudly rather than failing when the daily's provider key is drained
(a state this account has been in three times — #772, #1029, #1169), so it cannot
redden the daily for a credential reason. Neither is `@destructive`.

Test 1's `@stable` was **auto-removed** by the daily triage (`f6f4c398`, daily
`31786538844`) when the `sr-only` counter broke its option matcher, and is
**restored here** — that is the quarantine #1460 asks to lift. The removal was
correct as triage: with no scheduled lane running it afterwards, the defect
stayed invisible to the daily and surfaced only on PRs, because the
impacted-specs lane selects by import graph rather than by tag (#871/#1054).

---

## Validation criterion *(required)*

- **The API axis is `/api/v1/memories`, not `/api/v1/knowledge_bases` — the
  issue's wording is wrong here and the correction is load-bearing, not
  cosmetic.** Issue #1399 asks for the memory base to be present "both in
  `GET /api/v1/knowledge_bases` and in the panel". Measured on 1.12.0.dev22: a
  memory base created through the API leaves `GET /api/v1/knowledge_bases/`
  answering `[]`. This is **by design**, stated in the shipped source
  (`langflow/api/v1/knowledge_bases.py`, in `list_knowledge_bases`): *"Skip KBs
  that are managed by a Memory Base — those are exposed through the Memory Base
  APIs, not the generic KB list."* Asserting presence in `knowledge_bases` would
  therefore fail forever; asserting *absence* there is the falsifiable statement
  the issue was reaching for, and it is the one this spec makes.
- **The two-sided check the issue asks for is kept, on the right pair.** The
  panel could render optimistic local state, so the panel assertion is paired
  with `GET /api/v1/memories?flow_id=<id>` — the endpoint the panel itself lists
  from — and the panel is additionally re-read after `page.reload()`. A memory
  written only into client state survives neither.
- **The created record is asserted by its server-assigned shape, not just by
  name.** `POST /api/v1/memories` returns `id`, `flow_id` equal to the flow the
  test created, and `kb_name` matching `^<sanitized name>_[0-9a-f]{8}$` — the
  auto-generated backing KB name documented in `create_memory_base`. Asserting
  the `kb_name` pattern is what lets test 2 look the KB up by the exact string
  the server chose, instead of by a name the test invented.
- **The provider precondition is decided by an API probe before the browser
  opens, never by a `count()` on the control.** `GET /api/v1/models`, looking
  for a provider that is `is_configured` **and** `is_enabled` **and** carries a
  model whose `metadata.model_type` is `embeddings`. The Embedding Model picker
  is the shared model widget rendered **without** `showEmptyState`, so with no
  configured provider at all the control is absent from the DOM entirely — a
  `count() === 0` check would read a genuine regression that removes the control
  as "no provider configured". The skip reason names the measured state.
- **A configured key is NOT the whole precondition — the embeddings model must
  also be enabled, and none is by default.** Measured on 1.12.0.dev22 with
  `OPENAI_API_KEY` configured: `GET /api/v1/models` reports openai
  `is_configured: true`, `is_enabled: true` with three embeddings models, while
  `GET /api/v1/models/enabled_models` reports **all three `false`** — and the
  open picker lists exactly one option, `No Models Enabled` (the string issue
  #1399 predicts, reached by this route rather than by an absent key). The
  picker lists from `/api/v1/models/enabled_models`, not from `/api/v1/models`.
  The test therefore **enables one embeddings model itself** through
  `POST /api/v1/models/enabled_models` before the page loads, and restores the
  model's previous flag in cleanup. That is setup, not a weakened assertion: the
  registration behaviour under test is unaffected, and without it the test would
  skip on every instance the suite ever runs against, which is coverage of
  nothing. The write is **additive** (measured: the handler merges the update
  into the user's enabled/disabled variable lists rather than replacing the map),
  so it cannot disturb a parallel worker's model enablement.
- **The enablement must precede the page load.** The frontend caches the model
  list: enabling a model while the modal is open leaves the picker reading
  `No Models Enabled` until `refresh-model-list` is clicked (measured). The
  spec avoids the refresh path entirely by doing the API write first.
- **The embedding option is selected by its IDENTITY, never by its rendered
  text — issue #1460.** Since **1.12.0.dev26** every option of the unified model
  picker renders its own position inside itself as
  `<span class="sr-only">N of M</span>`: invisible to a user, but part of both
  `textContent` and the accessible name. Measured on **1.12.0.dev37** in this
  very picker, with one enabled embeddings model, the single option reads

  ```
  data-testid  Google Generative AI-gemini-embedding-2-option
  data-value   Google Generative AI::gemini-embedding-2
  textContent  "gemini-embedding-21 of 1"        <- .sr-only = ["1 of 1"]
  ```

  so `getByRole("option", { name: "gemini-embedding-2", exact: true }).count()`
  is **0** (the loose matcher: 1) and the click the spec used to make times out
  at 20 s. The selection therefore goes through `selectPinnedModelOption`
  (`tests/helpers/provider-setup/model-option.ts`, built for the sibling
  issue #1459): it resolves the option by `data-value` / `data-testid`, clicks by
  identity, and raises a loud `MODEL_PICKER_DEFECT` when the picker contradicts
  the API probe rather than degrading into a skip (#1461). The announcement can
  change wording, position or total without touching this test.
- **The counter is intended product behaviour, and the trigger is the clean
  half.** Both readings #1460 asked to separate were measured on 1.12.0.dev37.
  Re-read after a 4 s settle the option is byte-identical (`1 of 1` persists), so
  it is not a mid-update render artefact. And after selecting, the trigger
  `#memory-embedding-model` carries `textContent === "gemini-embedding-2"` with
  **zero** `.sr-only` descendants — so the existing
  `toHaveText(embedding.modelId)` assertion on the trigger asserts a real product
  contract and is kept unweakened. Only the *matcher* that reached the option was
  wrong; nothing about what the test proves is relaxed.
- **A skip is never a silent pass.** Test 1 skips with the concrete reason; test
  2 runs regardless, so the file always executes at least one falsifiable
  assertion about registration.
- **No embedding call is made.** Registration writes the KB directory and
  `embedding_metadata.json`; ingestion — which would call the provider — is out
  of scope (§20.4). The provider only needs to be *configured*, so a drained key
  still satisfies test 1.

---

## External dependencies *(required)*

- A running Langflow **1.12.x** instance with the Memories panel
  (`sidebar-nav-memories`) and the `/api/v1/memories` router.
- **Test 1 only:** a configured, enabled provider exposing an **embedding**
  model (e.g. OpenAI's `text-embedding-3-small`). No inference call is made, so
  a configured-but-drained key is sufficient. With no such provider, test 1
  skips with that reason. The model's own enablement is not a precondition —
  the test writes it (see Validation criterion) via
  `POST /api/v1/models/enabled_models` and `GET /api/v1/models/enabled_models`.
- **Test 2: none** — it creates its memory base through the API with an
  `embedding_model` string and no provider configured (measured: `201`).
- The default vector database is **Chroma Local**, bundled with the instance, so
  no external vector service is required.
- `POST /api/v1/flows/` + `DELETE /api/v1/flows/{id}` (flow lifecycle),
  `POST /api/v1/memories`, `GET /api/v1/memories?flow_id=<id>`,
  `DELETE /api/v1/memories/{id}` (`204`) and `GET /api/v1/knowledge_bases/`.
- **`/api/v1/memories` is absent from `/openapi.json`** — it answers `403`
  unauthenticated and `200` with the session. Do not conclude from the published
  schema that the route does not exist.

---

## Cleanup *(required)*

Every test creates its own flow (`POST /api/v1/flows/`) and its own memory base,
and deletes both id-scoped in `afterEach`: `DELETE /api/v1/memories/{id}` first
(the record and its on-disk KB directory), then `deleteFlow`, leaving the editor
via `unmountEditorForCleanup` before the flow goes so the editor's polls cannot
404 into the fixture's HTTP log. The memory-base id comes from the `POST`
response (test 2) or from `GET /api/v1/memories?flow_id=<id>` (test 1), never
from a name lookup and never from a delete-all sweep (#553/#520) — the account
is shared with parallel workers.

---

## What this test does not cover *(optional)*

- The panel, the modal's controls, its defaults and its disabled gate —
  `memory-base-panel.spec.ts` (§20.1–20.2).
- Ingestion, chunk preview, run history, cancel and connectors — §20.4, a
  separate wave item, and where all three known upstream defects live.
- The LLM Preprocessing branch (`preprocessing: true` + `preproc_model`), which
  the API answers `422` for when the model is missing.
- Non-`chroma` vector databases (Chroma Cloud, OpenSearch, pgvector), which need
  DB Providers configured.
- Duplicate-name handling (`409`), `PATCH`, `/flush`, `/regenerate` and
  `/mismatch`.
- The Agent's conversation memory (§6.3) — a different surface sharing the word.

---

## Notes *(optional)*

- **This doc supersedes its own earlier draft.** The version written during the
  §20 audit described all five scenarios of the surface and asserted them
  against `GET /api/v1/knowledge_bases`. Scenarios 1–4 shipped as
  `memory-base-panel.spec.ts`, and that spec's own measurement contradicted the
  endpoint; the source read above settles it.
- **Measured facts, 1.12.0.dev22** (`langflowai/langflow-nightly:latest`):
  `POST /api/v1/memories` with `{name, flow_id, embedding_model, threshold}`
  answers `201` with `backend_type: "chroma"`, `backend_config: {}`,
  `auto_capture: true` and `kb_name: "<sanitized>_<8 hex>"`;
  `GET /api/v1/knowledge_bases/` answers `200 []` with that memory base
  present; `DELETE /api/v1/memories/{id}` answers `204` and the list returns to
  `total: 0`.
- **The UI path, measured end to end on 1.12.0.dev22** with one embeddings model
  enabled: opening the picker lists the enabled model as a `role=option`;
  choosing it sets `#memory-embedding-model` to the model id and renders
  `Provider: OpenAI`; `Create Memory` becomes enabled once Name is filled;
  clicking it fires `POST /api/v1/memories/` → `201`, closes the dialog, and the
  panel lists the name. After `reload()` and reopening the panel the name is
  still there. The submit button and the panel's list item carry **no**
  `data-testid` (the item is a plain `div`), so they resolve by role+name and by
  exact text inside the panel's `aside`.
- **The option markup measured for #1460, on 1.12.0.dev37**, with
  `Google Generative AI / gemini-embedding-2` enabled (the model
  `findEmbeddingModel` picks on the suite's own instance — Anthropic is
  configured but exposes no embeddings model, so it is skipped):
  `role=option` count 1, accessible name `"gemini-embedding-21 of 1"`,
  `exact: true` count **0** / loose count 1, unchanged after a 4 s settle;
  trigger after selection `"gemini-embedding-2"` with no `.sr-only` node, and
  `Provider: ` rendered. The `data-testid` embeds the provider display name
  **spaces included** (`Google Generative AI-…-option`), which is why the
  identity is read from `data-value` first and the testid only as a fallback.
- **Batch Size is `threshold` on the wire** — the modal's `#memory-batch-size`
  maps to the `threshold` field (default `50` in the model, `1` in the modal).
  Worth knowing before reading a payload and concluding a field is missing.
