# Evals UI — the evaluations entry, the Datasets page and the Evaluate stepper

**File:** `tests/tests-automations/regression/core-functionality/evals/evals-ui.spec.ts`

**Last validated:** Langflow 1.14.x (`1.14.0.dev39`)

Owning issue: #2565 (Wave 12 — 1.14 OSS features). Third spec of the evals family, after
the datasets API (#2563, `docs/api/evals/api-datasets.md`) and the evaluations API (#2564,
`docs/api/evals/api-evaluations.md`), whose helpers it reuses to seed and to check.

---

## What this test validates *(required)*

Langflow 1.14 ships evals with a UI of its own (upstream langflow-ai/langflow#15999), on by
default since #16591 (`feature_flags.evals: true`). This spec drives the three surfaces a
user meets, and checks each against the API rather than trusting the rendered text alone:

1. **The flag gate.** The project sidebar's **Evaluations** entry, the evals pages and the
   flow toolbar's **Evaluate** button exist only while `feature_flags.evals` is `true`.
2. **The Datasets page.** A dataset created from a bundled example shows all its rows, and
   a row added through the *Add item* dialog is persisted.
3. **The Evaluate stepper and the result view.** From a flow's toolbar, the three-step
   modal (Setup → Scoring → Review) starts a keyless run, and the evaluation page reports
   the same pass count as the API.

Measured on the nightly with `playwright-cli` (testids from the live DOM):

| Surface | What renders |
|---|---|
| Project sidebar | `sidebar-evaluations` ("Evaluations", a button) → `/assets/datasets`. **Only when a flow exists**: an instance with no flow shows the empty welcome page, which has no project sidebar at all |
| Evals pages | `datasets-title`, tabs `evals-tab-datasets` / `evals-tab-evaluations`, `new-dataset-button`, `search-datasets-input`; rows are an ag-grid (`role=row`). **The examples entry depends on whether the caller has a dataset**: with at least one, a `dataset-examples-menu` button opens items `dataset-example-menu-<key>` (role `menuitem`, "<name> <n> items"); with none, the page reads "No datasets yet" and shows the examples as cards (`dataset-example-<key>`) instead, with no menu |
| Create from example | navigates to `/assets/datasets/<id>`: `dataset-detail-title`, `dataset-name`, a line "`<n> items` · Updated …", the grid's `aria-rowcount` = rows + 1 (the header); the grid **virtualises** rows, so the DOM holds fewer `role=row` than the dataset |
| Add item dialog | `add-item-button` → dialog "Add item": `item-input`, `item-expected` (textareas), `item-save` **disabled until the input has text**, `btn-cancel-modal` |
| Flow toolbar | `evaluate-btn-flow` ("Evaluate") beside `publish-button` |
| Evaluate modal | "Evaluate flow"; steps `evaluate-step-setup` / `-scoring` / `-review`, the active one with `aria-current="step"`; Setup: `evaluate-dataset` → `evaluate-dataset-search` + `role=option` "<name> (<n> items)", then `evaluate-dataset-preview` ("First rows …"), `evaluate-ready` ("Answers are read from Chat Output."), `evaluate-next` disabled until a dataset is picked; Scoring: `scorer-exact_match` / `-contains` / `-similarity` / `-llm_judge`, `role=checkbox`, **Exact match checked by default**; Review: `evaluate-review`, `evaluate-version`, `evaluate-estimate` ("No model calls: 2 rows run without spending tokens."), `evaluate-submit` ("Create and run") |
| Evaluation page | navigates to `/assets/evaluations/<evaluation id>?run=<run id>`: `evaluation-detail-title`, `detail-tab-runs` / `detail-tab-results`, `run-row`, `run-status-completed` ("Completed"), the row showing pass rate and rows done; Results tab: "Pass rate 50%", "1 of 2 rows passed", filters `results-filter-all` / `-passed` / `-failed` / `-errored` with their counts |
| Flag off | `/assets/datasets` **redirects to `/flows`**; the project sidebar renders without `sidebar-evaluations`; the flow page renders `publish-button` without `evaluate-btn-flow` |

**The comparison with the API is the point of tests 2 and 3.** A page that rendered its own
optimistic state would pass a text-only check: the dataset's row count is read back with
`GET /api/v1/datasets/{id}` and the added row with its items, and the run's pass count with
`GET /api/v1/evaluation-runs/{id}`, and each is asserted equal to what the page shows.

---

## Tags *(required)*

`@stable` `@mainpage` `@database` `@evals`

Keyless: the run uses `exact_match` on an echo flow (Chat Input → Chat Output), so no model
is called. Not provider-dependent (#1216).

---

## Precondition *(required)*

- A Langflow **1.14+** instance at `PLAYWRIGHT_BASE_URL`, auto-login.
- The evals premise of #2563 through `readEvalsSurface()`: `feature_flags.evals` absent →
  every test skips naming it; `false` → the suite fails (the default is on, #1010).
- Each test creates its own echo flow over the API first, which is also what makes the
  project sidebar render (an instance with no flow shows the welcome page instead).

---

## Step by step *(required)*

Three independent tests. Flows, datasets and evaluations are tracked by id — including the
ones the UI creates, whose ids are read from the URL it navigates to — and deleted in
`afterEach`, evaluations first (they do not cascade from the flow, #2564).

**Test 1 — `the evaluations entry, pages and Evaluate button follow the evals flag`**
1. With the real config: on `/flows`, `sidebar-evaluations` is visible; clicking it lands on
   `/assets/datasets` with `datasets-title` and both evals tabs.
2. On the echo flow's page, `evaluate-btn-flow` is visible beside `publish-button`.
3. With `GET /api/v1/config` routed to the real response but `feature_flags.evals: false`
   (the technique `voice-assistant.spec.ts` uses): opening `/assets/datasets` lands on
   `/flows`; `project-sidebar` is visible and `sidebar-evaluations` is not.
4. On the same flow page, `publish-button` is visible and `evaluate-btn-flow` is not.
   Same pages both ways, so either half fails if the gate inverts.

**Test 2 — `a dataset created from a bundled example shows all its rows, and an added row persists`**
1. Read the examples with `GET /api/v1/datasets/examples` and take the first, and seed one
   dataset over the API. The seed makes the menu path deterministic: every worker shares the
   superuser, so whether the list is empty is not the test's to decide, and the empty state
   replaces the menu with cards.
2. On `/assets/datasets`, open `dataset-examples-menu` and choose
   `dataset-example-menu-<key>` → the page navigates to `/assets/datasets/<id>`.
3. `dataset-detail-title` starts with the example's name; the page reads
   "`<item_count>` items"; the grid's `aria-rowcount` is `item_count + 1`; and
   `GET /api/v1/datasets/<id>` reports that `item_count`.
4. `add-item-button` → `item-save` is disabled; filling `item-input` with a per-run sentinel
   enables it; fill `item-expected`, save → the dialog closes and the page reads
   "`<item_count + 1>` items".
5. The API's last item is the sentinel pair, `source: "manual"`.

**Test 3 — `the Evaluate stepper runs a keyless evaluation and the result view agrees with the API`**
1. Seed a two-row dataset over the API: `alpha`/`alpha` (passes) and `beta`/`nope` (fails).
2. On the echo flow, `evaluate-btn-flow` opens "Evaluate flow" on `evaluate-step-setup`
   (`aria-current="step"`), with `evaluate-next` disabled and `evaluate-ready` naming Chat Output.
3. Pick the dataset through `evaluate-dataset` → `evaluate-dataset-search` → its option;
   `evaluate-dataset-preview` shows its first rows and `evaluate-next` enables.
4. Scoring: `scorer-exact_match` is checked and the other three are not; Next.
5. Review: `evaluate-estimate` reads "No model calls: 2 rows run without spending tokens.";
   `evaluate-review` names the flow and the dataset; `evaluate-submit`.
6. The page lands on `/assets/evaluations/<evaluation id>?run=<run id>`; `run-status-completed`
   appears.
7. `GET /api/v1/evaluation-runs/<run id>` reports `completed`, `passed_items: 1` of `2`,
   `pass_rate: 0.5`; the Results tab reads "1 of 2 rows passed", "Pass rate 50%", and the
   Passed and Failed filters count 1 each — the server value and the rendered value agree.

---

## Validation criterion *(required)*

Three consecutive passes at `--retries=0 --workers=1`, with:

- the flag gate proven in both directions on the same pages;
- every count the page shows (dataset rows, added row, passed rows) asserted equal to the
  API's value for the same id, never on the rendered text alone;
- the stepper's gating asserted (Next disabled until a dataset is picked, Save disabled until
  an input is typed);
- the ids the UI created read from its URLs and deleted, with no flow, dataset or
  evaluation left behind.

---

## External dependencies *(required)*

- A running Langflow 1.14+ OSS instance at `PLAYWRIGHT_BASE_URL` with
  `feature_flags.evals: true` (the default).
- No provider key, no model, no network egress.
- Upstream sources the UI was read from (`langflow-ai/langflow@release-1.14.0`):
  - `src/frontend/src/pages/MainPage/pages/evalsPage/EvalsRoute.tsx`
  - `src/frontend/src/pages/MainPage/pages/evalsPage/DatasetsPage.tsx`
  - `src/frontend/src/pages/MainPage/pages/evalsPage/DatasetDetailPage.tsx`
  - `src/frontend/src/pages/MainPage/pages/evalsPage/EvaluationDetailPage.tsx`
  - `src/frontend/src/modals/evaluateFlowModal/index.tsx`
  - `src/frontend/src/components/core/flowToolbarComponent/components/evaluate-button.tsx`
  - `src/frontend/src/components/core/folderSidebarComponent/components/sideBarFolderButtons/index.tsx`
- Repo helpers: `tests/helpers/api/evals/datasets.ts`, `tests/helpers/api/evals/evaluations.ts`.
