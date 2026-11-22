# Templates — the three file-input templates run on an uploaded text file (§11.4)

**File:** `tests/tests-automations/regression/core-functionality/templates/templates-run-file-input.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev29`, `langflowai/langflow-nightly:latest`,
measured 2026-11-16)

Owning issue: #2461 (row **E3** of the planned spec inventory in
`docs/core-functionality/templates/templates-coverage-scope.md`, the #1860 scoping pass) ·
**Siblings:** #2459 (`templates-run-prompts.spec.ts`, **E1**) and #2045
(`templates-run-knowledge.spec.ts`, **E4**) — the same run shape, the same observables ·
**Related:** #1452 (`page.flowErrorReport()`), #1372 / #1678 (a run can silently carry a model
nobody picked), #2043 (uploaded files outlive their flow), #1864 (**S1**, instantiation), #2467
(the helpers the family shares, `tests/helpers/flows/template-run.ts`)

---

## What this test validates *(required)*

The three templates of QA-CHECKLIST §11.4 **execute** on a plain-text file the test uploads,
with one model the test chose. One test per template, literal titles:

1. **should run Financial Report Parser on an uploaded report through its Parser** — Read File
   → Agent (input; structured output) → Parser → Chat Output.
2. **should run Portfolio Website Code Generator on an uploaded resume** — Read File → Agent
   (input) → Chat Output.
3. **should run Text Sentiment Analysis on an uploaded digest to both of its Chat Outputs** —
   Read File → Agent A → Prompt → Agent B → Chat Output 1, and Read File → Agent C → Chat
   Output 2.

The graphs above are as measured, and they correct two premises of the issue and of the old
§11.4 bullets: in Financial Report Parser the Parser comes **after** the Agent (it formats the
Agent's structured output), not between the file and the Agent; and in Text Sentiment Analysis
the file reaches **two** of the three Agents directly — the third gets Agent A's output through
the Prompt.

Each test:

1. **Resolves the one model it runs** — `resolveGptModel()` (`gpt-4o-mini` here) and its option
   from `GET /api/v1/model_options/language`, exactly as `templates-run-prompts.spec.ts` does.
2. **Uploads its fixture** — a short plain-text document carrying a **per-test nonce**, written
   for the template (a financial report, a resume, a community-discussion digest), through
   `POST /api/v2/files`. Plain text, so no OCR or Docling model is involved.
3. **Creates the flow from the template as the image registers it** — the entry of
   `GET /api/v1/flows/basic_examples/`, created with `POST /api/v1/flows/` under a unique name.
   Before creating it, the test checks the template still has the shape the assertions are
   keyed on (the type and number of model nodes, no Chat Input, the number of Chat Outputs, the
   set of components whose build is checked, and an edge from the Read File node into each
   Agent the file feeds), and sets exactly these fields:
   - the `model` of every Agent to the resolved option;
   - the Read File node's `path` to the uploaded file — `value: [<name>]` and
     `file_path: [<server path>]`, the shape the node's own upload writes (measured by uploading
     through the node in the UI and reading the saved flow back).
4. **Runs it the way a user does** — opens `/flow/{id}` and the Playground. None of the three
   has a Chat Input, so the Playground renders no text input; the test asserts it is absent and
   clicks `button-send`, which runs the flow (the path measured for SEO Keyword Generator in
   #2459).
5. **Reads the observables** under *Validation criterion*.

### What it is **not**

- **Not the upload UI.** Attaching a file through the Read File node's file manager is
  `knowledge-ingestion-management/upload-via-component.spec.ts`; here the file is uploaded
  through the API and written into the node in the shape that UI writes, so the test exercises
  the template's run, not the file manager.
- **Not instantiation** — S1's contract, as for the siblings.
- **Not the model's wording, nor its extraction.** Financial Report Parser's Agent extracts
  metrics into a schema, and gpt-4o-mini filled every one of them from the fixture in the scout
  — but which values land in the table is the model's work, so only the Parser's own table
  skeleton is asserted.

---

## Tags *(required)*

`@stable` `@release` `@templates` `@playground` `@files` `@agents` on all three tests.

- `@templates` is the area; `@playground` because the run is driven from the Playground;
  `@files` because the input is an uploaded file; `@agents` because every model node is an Agent
  — the scope doc's tag rule for execution specs.
- `@release`: these are the starter templates for "bring a document", a happy path that must
  work before a deploy.
- `@stable` from the first PR (`CONTRIBUTING.md` → *Tag @stable*): no lane selector, no known
  product defect, no model-dependent assertion.

---

## Validation criterion *(required)*

A test passes only when all of the following hold, in this order:

1. **The run carried the test's file, the pinned model and an input for every Agent.** The
   Playground's `POST /api/v2/workflows` request is captured; its live-canvas `data` must carry
   the uploaded file's server path in the Read File node's `path.file_path`, the resolved model
   and provider (`gpt-4o-mini` / `OpenAI`) on every Agent — one on Financial Report Parser and
   Portfolio Website Code Generator, three on Text Sentiment Analysis — and, in its `edges`, an
   edge into every Agent's `input_value`. That last check exists because a force-fail showed it
   was missing: with Text Sentiment Analysis's Prompt → Agent B edge removed, Agent B still
   built and answered from its system prompt alone, both Chat Outputs replied, and every other
   assertion passed.
2. **Every component that should build did.** Each expected node's output-inspection control is
   disabled before the send and enabled after the reply — the observable `templates-run-prompts`
   uses. The "before" half waits first for the editor to finish loading
   (`canvas_controls_dropdown`, up to 60 s): on a loaded host the editor sat on *"Loading..."*
   past the 30 s a node control is given, and the failure then read as a control "not found"
   rather than as the page that never loaded. Expected = every component node except tool-mode nodes and nodes with `showNode: false`;
   all three templates ship their Chat Outputs that way, so they are proven by the replies
   instead:

   | Template | Nodes checked | Excluded (`showNode: false`) |
   |---|---|---|
   | Financial Report Parser | Read File, Agent, Parser | Chat Output |
   | Portfolio Website Code Generator | Read File, Agent | Chat Output |
   | Text Sentiment Analysis | Read File, Agent A, Agent B, Agent C, Prompt | both Chat Outputs |

3. **Every Chat Output replied.** The number of AI messages (`[data-testid^="chat-message-AI-"]`)
   equals the number of Chat Outputs — one, one and **two** — once the stop button is gone and
   the send button is back, and each is neither blank nor the *"Message empty."* placeholder.
4. **The file's content reached the graph.** The Read File node's output
   (`output-inspection-raw content-file`) contains the nonce. That is the node's own reading of
   the test's file, not model output; with the File → Agent edges checked in setup and the Agents
   built, it is the model-free proof that the uploaded content fed the Agents.
5. **Financial Report Parser: the Agent's structured output reached the Parser.** The Parser's
   output (`output-inspection-parsed text-parsercomponent`) contains the template's table header
   `| Metric | Value |` — Langflow's formatting of the pattern, whatever values the model
   extracted.
6. **The flow-error report is evaluated and clean** — `evaluated > 0` and `clean` (#1452).

**What would turn it red.** A run that reads another file or none (steps 1 and 4); a node that
does not build — a lost edge, an Agent that errors, a Parser that cannot format (steps 2, 5 and
6); a Chat Output that never replies, including the second one of Text Sentiment Analysis (step
3); a silently swapped model (step 1).

**Force-fails, one per test, each aimed at the observable only that test holds** (run on
`1.14.0.dev29` in isolation with `--retries=0`, each red at the step named, reverted):

| Test | Mutation | Red at |
|---|---|---|
| Financial Report Parser | the Parser's `pattern` replaced by `Report: {COMPANY}` — a Parser that no longer formats the table | step 5: expected `\| Metric \| Value \|`, received `Report: Kestrel Dynamics` |
| Portfolio Website Code Generator | the fixture uploaded without the nonce | step 4: the Read File output read `…(reference no-reference)`, no nonce |
| Text Sentiment Analysis | the Prompt → Agent B edge removed | step 1: *"Agent Agent-tsa-b ran with nothing wired into its input"* — before that check existed, the same mutation **passed** (see step 1) |

A second Text Sentiment Analysis mutation, the Agent B → Chat Output edge removed, also went red,
but earlier than aimed: with **one** of the two Chat Outputs disconnected the Playground sends no
run at all (measured — the other Chat Output stays connected), so the test stopped at *"the
Playground sent no run request … the run never started"*.

The cleanup was force-failed too: with the file `DELETE` no-opped, one run left **one file and
no flow** behind — deleting the flow does not delete its file; reverted, every run left neither.

**Cleanup is id-scoped** (#515, #553): `afterEach` deletes the flow by id (after
`unmountEditorForCleanup`) and the uploaded file by id (`DELETE /api/v2/files/{id}`) — an
uploaded file outlives its flow (#2043), so deleting only the flow would leak one file per run.
Each in its own `try`, so one failing cannot leak the other. The idempotent calls re-dial once on
a dropped pooled connection (`retryOnDroppedConnection`, as in the sibling); the POSTs that
create the file and the flow do not.

**Parallel-safe, no serial mode.** Every flow and file carries the nonce in its name and every
locator is scoped to the test's own node ids.

---

## External dependencies *(required)*

- **OpenAI**, one provider for the whole file, gated by `providerSkipGate("openai")`; the key is
  the `OPENAI_API_KEY` global variable `collect-models` imports. The pinned model is
  `resolveGptModel()` and its option comes from `GET /api/v1/model_options/language`; a missing
  catalog or a model that is not enabled fails naming `collect-models`. No `MODEL_TEST_*` pin, no
  daily rotation — the siblings' reasoning.
- **Cost** per run of the file: five gpt-4o-mini Agent turns, the longest a portfolio page —
  well under a cent. **Runtime** (send → last reply, measured): Financial Report Parser ~12 s,
  Portfolio Website Code Generator ~17 s, Text Sentiment Analysis ~30 s.
- **Routes** (all `/api/v1` unless noted): `flows/basic_examples/`; `flows` create/delete;
  `model_options/language`; `POST /api/v2/files`, `DELETE /api/v2/files/{id}`; and
  `POST /api/v2/workflows`, the Playground run.
- **Upstream source** the assertions derive from: the three template JSONs under
  `src/backend/base/langflow/initial_setup/starter_projects/` (*Financial Report Parser*,
  *Portfolio Website Code Generator*, *Text Sentiment Analysis*); the Read File component in
  `src/lfx/src/lfx/components/files_and_knowledge/file.py` and its base
  `src/lfx/src/lfx/base/data/base_file.py` (the `path` input and its `file_path` list); the
  Parser in `src/lfx/src/lfx/components/processing/parser.py`; the file store in
  `src/backend/base/langflow/api/v2/files.py`; the options listing in
  `src/backend/base/langflow/api/v1/model_options.py`; the run request's `data` override in
  `src/backend/base/langflow/api/v2/workflow.py`.

---

## Notes

### Validation runs (`1.14.0.dev29`, 2026-11-16, `--workers=1 --retries=0`)

- One run of the file: 3/3 (1.5 min).
- First `--repeat-each=4` burst: **10/12**. Both reds were the host, not the spec — the local Docker
  VM shared a load average of 17–22 with other projects. One Financial Report Parser run found
  the editor still on *"Loading..."* after 30 s (reported as a node control "not found"), and one
  Text Sentiment Analysis run had `GET /api/v1/flows/basic_examples/` exceed its 20 s timeout.
  The editor-load gate in step 2 was added in response, so the first case now names itself.
- With the gate: a `--repeat-each=4` burst **12/12** (load rose to 47 during it), then — after the
  input-wiring check of step 1, the last edit — a `--repeat-each=3` burst **9/9**. Zero
  `🚨 Backend Error`; zero flows and zero files left behind, counted before and after every run.
- Per-test duration (green runs): Financial Report Parser 10–48 s, Portfolio Website Code
  Generator 22–59 s, Text Sentiment Analysis 17–55 s — the spread is the host's load.

### Measured on `1.14.0.dev29` (scout, 2026-11-16)

| Template | Agents | Run (send → last reply) | AI replies | Read File output has the nonce | Nodes disabled → enabled |
|---|---|---|---|---|---|
| Financial Report Parser | 1 (structured output) | 12.1 s | 1 — the Parser's table, every metric filled | yes | 3 of 3 |
| Portfolio Website Code Generator | 1 | 17.3 s | 1 — ~3.8k chars of HTML | yes | 2 of 2 |
| Text Sentiment Analysis | 3 | 30.0 s | 2 — 442 and 1,140 chars | yes | 5 of 5 |

Every run request carried the uploaded file's `file_path` on the Read File node and
`gpt-4o-mini` / `OpenAI` on every Agent. With `path` set through the API, the node shows the
file's chip on the canvas exactly as after a UI upload.

Text Sentiment Analysis's Agent A ships with a system prompt that begins with stray UI text
(*"New / Prompt Template / Create a prompt template with dynamic variables. / Use Double
Brackets / Tool Placeholder"*) before the real instructions — a cosmetic defect in the template's
content, recorded here rather than asserted on.
