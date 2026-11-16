# Templates — five prompt and agent templates run to a clean flow-error report (§11.3)

**File:** `tests/tests-automations/regression/core-functionality/templates/templates-run-prompts.spec.ts`

**Last validated:** Langflow 1.14.x (nightly `1.14.0.dev29`, `langflowai/langflow-nightly:latest`,
measured 2026-11-16)

Owning issue: #2459 (row **E1** of the planned spec inventory in
`docs/core-functionality/templates/templates-coverage-scope.md`, the #1860 scoping pass) ·
**Sibling:** #2045 (`templates-run-knowledge.spec.ts`, row **E4** — the same run shape against
a knowledge base) · **Related:** #1452 (`page.flowErrorReport()`), #1372 / #1678 (a run can
silently carry a model nobody picked), #1128 (the self-hosted echo endpoint), #1864 (**S1**,
instantiation — the structural half this spec does not repeat), #2460 (**E2**, the image
template of the same §11.3)

---

## What this test validates *(required)*

Five templates of QA-CHECKLIST §11.3 **execute** from the Playground with one model the test
chose. One test per template, literal titles:

1. **should run Basic Prompting and build all four of its components** — Chat Input →
   Language Model ← Prompt (system message) → Chat Output.
2. **should run Blog Writer on a source URL served by the echo endpoint** — Chat Input → Prompt
   Template (`{URL}`) → Agent (system prompt) → Chat Output, with the URL component wired to
   the Agent as a tool.
3. **should run Multi Agent Flow through all three of its Agents** — Chat Input → Agent 1 →
   Agent 2 → Agent 3 → Chat Output, a linear chain.
4. **should run SEO Keyword Generator, which has no Chat Input, from the Playground** — Prompt →
   Agent (input) → Chat Output.
5. **should run Twitter Thread Generator to a non-empty thread** — Chat Input and Prompt
   (system prompt) → Agent → Chat Output.

Each test:

1. **Resolves the one model it runs** — `resolveGptModel()`, the OpenAI chat model
   `collect-models` wrote to `models.json` (`gpt-4o-mini` here), and that model's entry in
   `GET /api/v1/model_options/language`. That listing is the source of the options the
   model picker offers, so the value the test writes is the value the picker would write; it
   names no model `collect-models` did not enable.
2. **Creates the flow from the template as the image registers it** — the entry of
   `GET /api/v1/flows/basic_examples/` with that exact name, created with `POST /api/v1/flows/`
   under a unique name. Before creating it, the test checks the template still has the shape
   the assertions below are keyed on (the type and number of model nodes; whether it has a
   Chat Input; the set of components whose build is checked; Blog Writer's Chat Input →
   Prompt Template `{URL}` edge), and sets exactly these fields:
   - the `model` of **every** model node (Language Model or Agent) to the resolved option;
   - **Blog Writer only:** the Chat Input's message and the URL component's `urls` to
     `<echo>/html`, so the source URL the template asks for is served by the self-hosted echo
     endpoint instead of `docs.langflow.org`.

   Nothing else of the template is changed: every other test sends the template's own message.
3. **Runs it the way a user does** — opens `/flow/{id}`, opens the Playground
   (`playground-btn-flow-io`). Where the template has a Chat Input, the Playground's input
   (`input-chat-playground`) is pre-filled from that node; the test asserts it holds the
   template's own message and presses Enter. SEO Keyword Generator has no Chat Input: the
   Playground renders no input at all, only `button-send`, and the test asserts the input is
   absent and clicks the button.
4. **Reads the observables** listed under *Validation criterion*: what the run request carried,
   which components built, the reply, the Prompt Template's output (Blog Writer) and the
   flow-error report.

### What it is **not**

- **Not instantiation.** Picking the card from the gallery is S1's contract
  (`templates-instantiate.spec.ts`), which proves the created flow equals the same
  `basic_examples` entry this spec reads. Creating the flow from that entry through the API is
  the template a user gets minus the gallery click, and it is id-addressed, so parallel
  workers never share a flow. The sibling `templates-run-knowledge.spec.ts` made the same call.
- **Not the model's wording.** Each template must reply, not reply well; the reply is
  asserted non-empty and nothing more (the rule `test-targets.ts` records for #1187).
- **Not Blog Writer's tool call.** The template's prompt tells the Agent to fetch the source URL
  with its `fetch_content` tool, and in every scout run it did — the reply was an essay about
  the *Moby-Dick* excerpt go-httpbin serves at `/html`. Whether the Agent calls a tool is the
  model's choice, so it is not asserted. What *is* asserted is model-free: the run's input was
  the echo URL, and the formatted system prompt the Agent received names it. The URL
  component is therefore excluded from the "every component built" check — in tool mode it
  builds only if the tool is called.
- **Not Image Sentiment Analysis.** The vision template of §11.3 needs an image and a
  vision-capable model, and is E2 (#2460). Memory Chatbot and Simple Agent, the other two
  §11.3 bullets, are already `[x]` through `memory-history-regression.spec.ts` and
  `agent-component-regression.spec.ts`.
- **Not multi-provider.** One provider for the whole file, for the reason the sibling gives (see
  *External dependencies*).

---

## Tags *(required)*

`@stable` `@release` `@templates` `@playground` on all five tests, plus `@agents` on the four
whose model node is an Agent (Blog Writer, Multi Agent Flow, SEO Keyword Generator, Twitter
Thread Generator).

- `@templates` is the area; `@playground` because the run is driven from the Playground and the
  reply is read there; `@agents` per the scope doc's tag rule for templates whose model is an
  Agent.
- `@release`: Basic Prompting is one of the three featured *Get started* cards
  (`template-get-started-card-basic-prompting`), and these are the starter templates a new user
  runs first — a happy path that must work before a deploy.
- `@stable` from the first PR (`CONTRIBUTING.md` → *Tag @stable*): none of its exceptions
  applies — no lane selector, no known product defect, no model-dependent assertion.

---

## Validation criterion *(required)*

A test passes only when all of the following hold, in this order:

1. **The run carried the pinned model on every model node.** The Playground's
   `POST /api/v2/workflows` request is captured and its live-canvas `data` must carry the
   resolved model and provider (`gpt-4o-mini` / `OpenAI`) on each model node — one on Basic
   Prompting, Blog Writer, SEO Keyword Generator and Twitter Thread Generator, three on Multi
   Agent Flow. The run builds that payload, not the saved flow (#1372, #1678), so this is the
   only place a silent fallback shows; the first entry of these templates' model options is
   `gpt-5.5-pro`. **Blog Writer** additionally: the request's `input_value` is `<echo>/html`.
2. **Every component that should build did.** Before the message is sent, each expected node's
   output-inspection control (`[data-testid^="output-inspection-"]` inside `[data-id="<node
   id>"]`) is **disabled**; after the reply completes and the Playground closes, each one is
   **enabled**. The control is disabled while a node has no output and enabled once it built
   (measured on all five templates), so the pair proves *this* run built that node. The
   expected set is every component node of the template except a node in tool mode (it builds
   only when the model calls it) and a node with `showNode: false` (it renders no control):

   | Template | Nodes checked | Excluded |
   |---|---|---|
   | Basic Prompting | Chat Input, Prompt, Language Model, Chat Output | — |
   | Blog Writer | Chat Input, Prompt Template, Agent, Chat Output | URL (tool mode) |
   | Multi Agent Flow | Chat Input, Agent 1, Agent 2, Agent 3, Chat Output | — |
   | SEO Keyword Generator | Prompt, Agent, Chat Output | — |
   | Twitter Thread Generator | Chat Input, Prompt, Agent | Chat Output (`showNode: false`) |

   The set is derived from the template at run time, and a template whose derived set differs
   from the table fails before the run, naming the difference — so an upstream edit is read by
   a human instead of silently shrinking what is checked.
3. **The reply completed.** Exactly one AI message (`[data-testid^="chat-message-AI-"]`), the
   stop button (`button-stop`) gone and the send button (`button-send`) back, and the message's
   text neither blank nor the *"Message empty."* placeholder an empty message renders as. The
   count is on the AI container and not on `div-chat-message` (the sibling's choice) because on
   SEO Keyword Generator the empty user turn also renders a `div-chat-message`, reading
   *"Message empty."* (measured) — which is also why the non-empty check excludes that text:
   a bare non-whitespace match would pass on an empty reply.
4. **Blog Writer: the source URL reached the Agent.** The Prompt Template's
   `output-inspection-prompt-prompt template` shows the system prompt the Agent received; it
   must contain `<echo>/html`. This is Langflow's formatting of the Chat Input into the
   template's `{URL}`, not model output — the model-free proof that the run was pointed at the
   echo endpoint (measured: `SOURCE URL: http://172.17.0.5:8080/html`).
5. **The flow-error report is evaluated and clean.** `page.flowErrorReport()` returns
   `evaluated > 0` and `clean === true` — both, because `clean` is vacuously true when no run
   stream was read (#1452).

**What would turn it red.** A run that silently swaps the pinned model on any model node (step
1); a component that does not build — a lost edge, a node that errors, a chain that stops at
Agent 2 (steps 2 and 5); a run that produces no reply (step 3); Blog Writer's message not
reaching the system prompt, or a run pointed back at a public host (steps 1 and 4); and a run
that errors anywhere in the graph (step 5, and the fixture's own gate).

**Force-fails, one per test, each aimed at the observable only that test holds** (run on
`1.14.0.dev29` in isolation with `--retries=0`, each red at the step named, reverted):

| Test | Mutation | Red at |
|---|---|---|
| Basic Prompting | the Prompt → Language Model (`system_message`) edge removed before the flow is created | step 2: *"node Prompt-t2oaK has no output to display — it did not build"* — the Language Model still answered, so only this check sees it |
| Blog Writer | the Chat Input's message set to `https://docs.langflow.org/` — the run pointed back at the public host | step 1: the run's `input_value` was `https://docs.langflow.org/`, expected `<echo>/html` |
| Multi Agent Flow | Agent 3 alone pinned to a model id that does not exist | step 1: *"model node Agent-maf-3 ran"* — proves the per-node check reaches the last of the three |
| SEO Keyword Generator | the Agent → Chat Output edge removed | the send: *"the Playground sent no run request … the run never started"*. Measured: with Chat Output disconnected the send control stays enabled, the click sends nothing and nothing is shown; the first version of the test died on a bare `waitForRequest` timeout here, which is why the send now names it |
| Twitter Thread Generator | the Agent's `api_key` set to an invalid literal | step 3 (*"the reply should not be empty"*) and the fixture's flow-error gate: *"Test failed due to 1 flow execution error(s): Incorrect API key provided"* |

The cleanup was force-failed too: with the `afterEach` delete no-opped, one run of Basic
Prompting left one flow behind; reverted, every run — green or red, including the five above —
left none.

**Cleanup is id-scoped** (#515, #553): the test deletes its flow by id in `afterEach`, after
leaving the editor through `unmountEditorForCleanup`, so the editor's polls do not hit a flow
being deleted. The user-flow count is the same before and after a run, green or red.

**A dropped pooled connection is re-dialled, once, on idempotent calls only.** One run here
died on `apiRequestContext.get: socket hang up` reading `model_options/language` — the ~2 s
keep-alive edge `helpers/api/retry-on-dropped-connection.ts` records, not the mechanism under
test. The three reads and the `afterEach` delete go through `retryOnDroppedConnection` (the
delete is safe to repeat: `deleteFlow` reads a 404 as already gone); the flow-creating POST
does not, because a retried POST whose first attempt landed would leak a second flow. A
response is never retried, so no assertion is softened.

**Parallel-safe, no serial mode.** Every flow carries a per-test nonce in its name and every
locator is scoped to the test's own node ids, so the five tests share nothing.

---

## External dependencies *(required)*

- **OpenAI**, one provider for the whole file. The key must be a Langflow **global variable**
  (`OPENAI_API_KEY`), which `tests/collect-models.spec.ts` imports. When `collect-models`
  recorded `openai` inactive, every test skips through `providerSkipGate("openai")` with the
  recorded reason.
- **The pinned model** is `resolveGptModel()` (`gpt-4o-mini` on the local run), and its option
  comes from `GET /api/v1/model_options/language`, which lists only the models enabled on the
  instance. No `models.json`, or a model the listing does not carry, fails the test naming
  `collect-models` — never a run on a model nobody chose. The file reads no `MODEL_TEST_*` pin
  and is not rotated by the daily (#1185): one provider keeps the ways a key outage skips it to
  one, the sibling's reasoning.
- **The echo endpoint** (Blog Writer only): `ECHO_BASE_URL`, else `HTTPBIN_BASE_URL`, else
  `https://httpbin.org` — the resolution `agent-multi-tool-selection.spec.ts` uses. Every CI lane
  and the VM lane set it to a self-hosted go-httpbin (#1128), so the fallback only ever applies
  to a local run without one. A private address is reachable only because
  `LANGFLOW_SSRF_ALLOWED_HOSTS` admits it, which every lane and `scripts/start-langflow-docker.sh`
  set. `/html` serves the same *Moby-Dick* excerpt on go-httpbin and httpbin.org.
- **Cost** per run of the file: five gpt-4o-mini runs, one of them three Agent turns and one a
  page fetch — well under a cent. **Runtime** (send → reply, measured): Basic Prompting 2.5–5 s,
  Blog Writer ~15 s, Multi Agent Flow 14–17 s, SEO Keyword Generator 13–14 s, Twitter Thread
  Generator 6–9 s.
- **Routes** (all `/api/v1` unless noted): `flows/basic_examples/`; `flows` create/delete;
  `model_options/language`; and `POST /api/v2/workflows`, the Playground run.
- **Upstream source** the assertions derive from: the five template JSONs under
  `src/backend/base/langflow/initial_setup/starter_projects/` (*Basic Prompting*, *Blog Writer*,
  *Multi Agent Flow*, *SEO Keyword Generator*, *Twitter Thread Generator*); the options listing in
  `src/backend/base/langflow/api/v1/model_options.py`; the run request's `data` override in
  `src/backend/base/langflow/api/v2/workflow.py`; the URL component in
  `src/lfx/src/lfx/components/data_source/url.py`.

---

## Notes

### Why the Playground, for a template with no Chat Input too

The sibling runs from the Playground because its templates ship Chat Output minimized. Here
two of the five do not, but the Playground is still the one path that runs all five the same
way, and it is how these templates are meant to be run. SEO Keyword Generator was the open
question in #2459: with no Chat Input the Playground renders no text input, and its
`button-send` is enabled and runs the flow (measured). The run is the same
`POST /api/v2/workflows` — without a `start_component_id`, which every other template's request
carries.

### Measured on `1.14.0.dev29` (scout, 2026-11-16)

| Template | Model nodes | Run (send → reply) | Reply length | Nodes disabled → enabled |
|---|---|---|---|---|
| Basic Prompting | 1 Language Model | 2.5–5.2 s | ~240 chars | 4 of 4 |
| Blog Writer | 1 Agent | 14.6–15.1 s | ~3.5k chars (on the fetched page) | the four checked; URL enabled too (the tool ran) |
| Multi Agent Flow | 3 Agents | 14.3–17.0 s | ~1.7k chars | 3 of 3 Agents |
| SEO Keyword Generator | 1 Agent | 13.1–14.2 s | ~3.6k chars | 3 of 3 |
| Twitter Thread Generator | 1 Agent | 6.1–9.3 s | ~1.75k chars | 3 of 3 |

Every run request carried `gpt-4o-mini` / `OpenAI` on every model node. On Basic Prompting the
Language Model's `options` are empty in `basic_examples` (the picker fills them at load), which
is why the option comes from `model_options/language` and not from the template.

### Validation runs (`1.14.0.dev29`, 2026-11-16, `--workers=1 --retries=0`)

- **35 of 35 passed** across three separate invocations: one run of the file (5/5, 1.3 min), a
  `--repeat-each=4` burst (20/20, 5.0 min) and, after the last edit to the spec, a
  `--repeat-each=2` burst (10/10, 3.2 min). Zero `🚨 Backend Error`, zero flows left behind.
- Per-test duration across those runs: Basic Prompting 6–21 s, Blog Writer 16–25 s, Multi
  Agent Flow 16–28 s, SEO Keyword Generator 10–19 s, Twitter Thread Generator 10–15 s.
- **`--trace=on` was not usable locally**: the first test hit the 5-minute cap writing its
  trace (the archive was left truncated) — the known local `--trace=on` hang the
  `langflow-e2e` skill records, unrelated to this file's assertions. Step-by-step evidence comes from the
  scout snapshots, the bursts and the force-fails above instead; CI's
  trace-on-first-retry still captures a usable trace.
