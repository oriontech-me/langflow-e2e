# Agent multi-tool selection — correct tool per prompt

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.2 "Agent with multiple configured tools executes correctly",
§6.4 "Multiple connected tools — agent selects the correct one for each
prompt", and §6.4 "Agent executes multiple tools **in sequence**". The Simple
Agent template ships with **two tools already connected** to the Agent — URL
(`URLComponent`, tool `fetch_content`) and Web Search (`UnifiedWebSearch`, tool
`perform_search`), confirmed in the nightly's `starter_projects/Simple
Agent.json` — making it the canonical multi-tool surface.

The contract: given a prompt that unambiguously calls for one capability,
the agent's **first tool call** must be that tool — the first call IS the
selection decision. A third prompt chains the two tools to prove the agent
**runs multiple tools in sequence**. Three prompts, three tests:

1. **Fetch prompt → URL tool first.** "Fetch https://httpbin.org/json …"
   must produce a persisted AI message whose FIRST `tool_use` block is
   `fetch_content`; the reply must contain the deterministic content of
   that endpoint (`Sample Slide Show`).
2. **Search prompt → Web Search tool first.** "Search the web for …" must
   produce a FIRST `tool_use` block of `perform_search`.
3. **Chained prompt → both tools, in order (§6.4 sequence).** "First fetch
   `<URL>` to read the slideshow title, THEN web-search that title …" must
   produce a persisted run whose ordered `tool_use` blocks include BOTH tools
   with `fetch_content` **before** `perform_search` — the agent executed a
   dependent two-tool sequence, not a single call. Only the tool **names and
   their order** are asserted (search result content is non-deterministic).

> **Why first-call, not exclusive-call (drift event, 2026-07-08).** The
> original design asserted the sibling tool was NEVER called. Overnight —
> with zero Langflow changes (dev34 and dev36 fail identically; template,
> `agent.py` and `web_search.py` byte-identical between the images) —
> gemini-3.5-flash started appending a "verification" `perform_search`
> call after a correct `fetch_content` call, despite instructions to use
> exactly one tool. That is provider-side model drift, not mis-selection:
> the agent still reaches for the right tool first. Asserting the FIRST
> call keeps the §6.4 contract sharp (a fetch prompt answered by search
> still fails) while surviving stylistic extra calls the test does not
> own.

The Agent Instructions force tool use for every question **without naming any
tool** ("you MUST call exactly one tool… choose the tool that fits") — tool
*use* is instructed so the model can't answer from memory (which would make
the test flaky), but tool *choice* is left entirely to the agent, which is
exactly the behavior under test.

Both runs finishing with zero flow errors (fixture, no `allowFlowErrors`)
with both tools wired is what proves §6.2's "executes correctly".

If this test fails, agents mis-route prompts across their toolset — the core
usefulness contract of multi-tool agents.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

`@stable` added after 4 clean `--retries=0` runs on the fresh nightly
(1.11.0.dev34; issue #486's "Done when" includes `@stable`). `@regression` — guards tool routing across
the agent's toolset; `@agents` — agent tool-calling behavior; `@playground` —
the run and the reply observable live in the Playground.

**@stable removed then restored (#631).** On the 2026-07-10 daily the fetch test
hard-failed because `httpbin.org` returned sustained 503s/timeouts — the tool
executed and Langflow surfaced the upstream error correctly (no product bug), but
the deterministic-title assert cannot pass when the third-party endpoint is down.
The daily's `auto-remove-stable` stripped `@stable` from the fetch test only.
Root cause (verified live on `1.11.0.dev38`): httpbin.org was reachable only
~1 in 3 attempts *from the Langflow container's network*, so the `fetch_content`
tool hung/timed out and the run ended with an empty reply (the "Message empty."
placeholder) — the same symptom as #634, but here driven by endpoint
unavailability, not a UI-only race. Two-part fix: (1) route the fetch through
the daily's self-hosted go-httpbin via `ECHO_BASE_URL` (see External
dependencies); (2) assert the deterministic title on the **persisted
`fetch_content` tool output** (monitor API) instead of the live bubble (which
shows the empty placeholder mid-run) or the model's prose (recitable from
memory) — the tool output proves the real fetch and fails when the endpoint is
unreachable. The completed-but-empty final turn is left to #634 (not asserted
here). Validated on `1.11.0.dev38`: clean `--retries=0` runs via go-httpbin on
`gpt-4o-mini` + force-fail M2. Then `@stable` restored. The search test was
unaffected (never depended on httpbin).

**Test 3 promoted to `@stable` (#1449).** It shipped without the tag under two
gates, and by the time it was promoted **both had closed** — #827's clean
non-guarded baseline (closed by #818 on 2026-07-30) and the unbounded Web Search
payload (`langflow-ai/langflow#14469`, closed by `#14489` on 2026-08-10, in the
nightly from `1.12.0.dev25`). Neither expiry was noticed until #1381 went to
review, which is why the promotion is recorded here with its evidence rather
than as a tag flip. Validated on `1.12.0.dev25`, `--workers=1 --retries=0`,
`gpt-4o-mini`, with `ECHO_BASE_URL` on a local go-httpbin:

- **6 clean runs of the whole file, 18/18 tests**, 45–55 s per run — the first
  local validation of test 1 in this file's history, since `httpbin.org` was
  answering `503` that day (the #631 mode) and the serial describe had always
  skipped its siblings behind it.
- Test 3 alone, measured earlier the same day on the same image: **7/7** at
  `max_iterations=8` and **4/4** at the default 15.
- Force-fail executed per test — see **Force-failure checks** below.

Two limits of that evidence, stated because the daily rotates providers by
weekday (#1185) and will not always run this on OpenAI. **anthropic could not be
measured locally** — `collect-models` reports its key `inactive` for a billing
reason, so its targets skip. What exists for the other two is CI: #1381's lane on
2026-08-13 ran the file on **google** and **anthropic** and passed both (its
OpenAI targets skipped on a drained CI key, #1450) — so every provider the daily
can pick has at least one green run of test 3 behind it, none of them on the same
box as the others.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL` (fresh nightly).
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- At least one active provider API key in `.env`.
- Run with `--workers=1` — area rule for agent specs (shared instance state).
  Each test captures its flow id from the template-instantiation
  `POST /api/v1/flows/` response and deletes exactly that id in `afterEach`
  (`loadTemplateByName` does no cleanup — post-#553 contract).

---

## Step by step *(required)*

The spec generates tests per active model via the `resolveTestTargets()`
machinery (same as `agent-tool-error-handling.spec.ts`). Per model, a serial
describe with two tests:

**Test 1 — fetch prompt selects the URL tool (§6.4 + §6.2)**

1. Load the Simple Agent template (provider/model from `models.json`/`.env`).
2. Set Agent Instructions (`textarea_str_system_prompt`): *"For every user
   question you MUST call exactly one tool to obtain the answer — never
   answer from memory or refuse. Choose the tool that fits the question."*
3. Seed the task on the ChatInput node (`textarea_str_input_value`; prefill
   re-injection race): *"Fetch https://httpbin.org/json and tell me the
   exact slideshow title it returns. (probe `<nonce>`)"*.
4. Open the Playground (`playground-btn-flow-io`), send, wait for the run to
   finish (Stop button hidden).
5. **Selection assert (API):** poll `GET /api/v1/monitor/messages` — find the
   user message with the nonce, take its `session_id`, find the session's AI
   message; its **first** `tool_use` block must be `fetch_content` (first call is
   the selection decision; extra follow-up calls are tolerated — see the
   first-call note above).
6. **Execution assert:** a reply bubble renders in the Playground
   (`div-chat-message` visible), and — asserted on the **persisted** run (monitor
   API, same nonce-keyed session lookup as step 5) — the `fetch_content`
   `tool_use` block's **OUTPUT** contains `Sample Slide Show`, the deterministic
   title served by the `/json` endpoint. This proves the tool actually fetched
   the real payload (the #631 root cause was the endpoint unreachable from the
   backend → the tool returned an error/nothing, never the slideshow). Two
   deliberate choices: (a) assert the persisted tool output, **not** the live
   bubble, which shows the empty placeholder ("Message empty.") mid-run and races
   the stream (#631); (b) assert the tool **OUTPUT**, **not** the model's prose —
   the slideshow title is a famous httpbin fixture a model can recite from
   memory, so a prose check could false-pass even if the fetch failed. A
   completed-but-empty final reply ("Message empty.") is NOT asserted here: it is
   a rare model-side behavior tracked as a flake in #634, and this test's
   contract (tool selection + execution) is fully proven by step 5 + this output
   assert without coupling to it.
7. No `allowFlowErrors` — any flow error fails the test via the fixture.

**Test 2 — search prompt selects the Web Search tool (§6.4)**

1–2. Same template load and Agent Instructions (fresh load; new nonce).
3. Seed the task: *"Search the web for recent news about the Playwright test
   framework and summarize one headline. (probe `<nonce>`)"*.
4. Open the Playground, send, wait for the run to finish.
5. **Selection assert (API):** same nonce-keyed monitor lookup; the AI
   message's **first** `tool_use` block must be `perform_search` (first-call
   design; extra follow-up calls tolerated).
6. **Execution assert (UI):** the final AI bubble is visible and non-empty
   (search result content is inherently non-deterministic — the selection
   assert in step 5 is the concrete observable; see false-positive notes).
7. No `allowFlowErrors`.

**Test 3 — chained prompt runs both tools in sequence (§6.4 sequence)**

1. Load the Simple Agent template (fresh load; new nonce).
2. Set Agent Instructions that PERMIT a multi-step sequence (distinct from the
   single-tool instruction of tests 1–2): *"Use the connected tools to
   complete the task. You may call multiple tools in sequence as the task
   requires; never answer from memory."*
3. Seed a task that makes the second tool depend on the first's result:
   *"First fetch `${FETCH_URL}` and read its exact slideshow title. Then search
   the web for that title and summarize one result. (probe `<nonce>`)"*.
4. **Cap `max_iterations` at 8** on the Agent node (advanced field, exposed via
   the inspector — same handles `agent-max-iterations.spec.ts` uses), and assert
   the field actually holds that value. This is load-bearing, not tuning: a cap
   that silently fails to apply leaves the default 15 and re-opens #1378 on a
   run that still looks green. See the note below.
5. Open the Playground, send, wait for the run to finish (Stop button hidden).
6. **Sequence assert (API):** poll `GET /api/v1/monitor/messages` — nonce-keyed
   session lookup (same as tests 1–2); collect the **ordered** list of
   `tool_use` block names across the session's AI message(s). Assert the list
   contains both `fetch_content` and `perform_search`, with
   `indexOf(fetch_content) < indexOf(perform_search)` — the agent ran the two
   tools one after another in the required order. Only names/order are
   asserted (search content is non-deterministic).
7. No `allowFlowErrors`.

> **Why `max_iterations` is capped here and nowhere else (#1378).** Unlike
> tests 1–2, this test's instruction *permits* a multi-tool sequence, and the
> agent does not reliably converge on it. When it doesn't, it keeps calling
> `perform_search`, and each call injects the Web Search component's full
> result set into the conversation. That component capped nothing — until
> `langflow-ai/langflow#14489`, see the update at the end of this note:
> `perform_web_search()` iterated every `div.result` DuckDuckGo returns and
> scraped each linked page's **entire** text (upstream
> `langflow-ai/langflow#14469`). Measured on `1.12.0.dev20`, query
> `"Sample Slide Show"`: **10 results, 182,316 chars ≈ 45.6k tokens in one
> call** (largest single page: 40,755 chars). The conversation is re-sent
> every turn, so a non-converging run grows without bound and the provider
> rejects it — the 2026-08-08 PR run reported requests of
> **206,881 / 206,902 / 271,317** tokens and a local run reported
> **5,060,863**, after which the run returns no reply at all.
>
> **This is a volume problem, not a rate-limit tier problem, and the
> distinction decides the fix.** The CI organization's cap is 200k TPM and
> the local one's is 4M TPM — 20× larger — and the local run blew through it
> anyway. A bigger tier, or a model with a wider context window, buys
> nothing: no window on the market holds 5M tokens. Bounding the iteration
> count is what bounds the run.
>
> **What the cap does — and what it does not.** It bounds the worst case; it
> does **not** make this test deterministic. Measured on `1.12.0.dev20` /
> `gpt-4o-mini` with `--retries=0`:
>
> | `max_iterations` | Pass rate | Failure mode |
> |---|---|---|
> | 15 (default) | 4/5 | context blow-up, up to 5,060,863 tokens |
> | **8** (this spec) | **5/6** | context blow-up, 129,150 tokens — same rate within noise, far smaller blast radius |
> | 4 | **0/2** | `Recursion limit of 13 reached without hitting a stop condition` |
>
> An earlier version of this note derived the cap from a token budget (three
> calls needed, plus headroom, worst case inside a 128k window) and arrived
> at **4**. That was wrong in both directions and is recorded so it is not
> repeated. The failure at 4 is not a smaller version of the failure at 15:
> `max_iterations=4` sets a LangGraph `recursion_limit` of 13, the agent hits
> it, and **a run that stops that way persists no AI message at all** — so
> the sequence assert fails on *absent* data rather than wrong data, and the
> cap meant to fix the test breaks it a second way.
>
> **The upstream cap landed, and it retires this note's central argument
> (measured 2026-08-13).** `langflow-ai/langflow#14489` bounded the component
> with two advanced inputs: `max_results` (default 5) and
> `max_content_length` (default 2,000 chars, truncation marked
> `... [truncated]`). It merged on 2026-08-10 and reached the nightly in
> **`1.12.0.dev25`** — *not* `dev24`, whose image was cut before the
> merge-back landed on `release-1.12.0`. **Reading the fix on the branch does
> not say the running image has it**, and that mistake costs a whole
> measurement: the check is `grep max_results` in the INSTALLED wheel
> (`/app/.venv/lib/python*/site-packages/lfx/components/data_source/web_search.py`),
> never the ref. Measured on `1.12.0.dev25`, same query as above: **5 results,
> 10,000 chars ≈ 2.5k tokens**, all five truncated at 2,000 — a **17.9×**
> reduction against the 178,830 chars the identical call returned on `dev24`.
> The bound reaches this test and not merely the library: Langflow freezes
> component code into the saved flow, and the `Simple Agent` starter in
> `dev25` ships both the new fields and the new embedded code (verified on the
> instantiated flow, not assumed from the package).
>
> **What that retires.** The previous version of this note argued that no
> iteration cap could ever guarantee this test, because a *single*
> `perform_search` was itself unbounded — measured across three queries:
> **15,857 / 53,714 / 78,848** tokens for one call, a 5× spread, with the query
> chosen by the agent and not by us. That premise is gone: one call now has a
> hard ceiling of 5 × 2,000 chars ≈ 2.5k tokens, so even the worst case of 15
> iterations accumulates ~37k tokens of search payload — inside
> `gpt-4o-mini`'s 128k window and inside CI's 200k TPM.
>
> **What it does not retire: the cap.** Measured on `1.12.0.dev25` /
> `gpt-4o-mini`, `--retries=0 --workers=1`:
>
> | `max_iterations` | Pass rate | Note |
> |---|---|---|
> | 15 (default) | 4/4 | 27–51 s |
> | **8** (this spec) | **7/7** | 21–48 s, on a warm backend |
>
> One further run at 8 failed and is excluded on purpose: it was the first run
> after the container came up, and it failed `read-failed` with **0** successful
> reads of the persisted flow — a state the credential guard itself reports as
> saying nothing about the binding (#1077). Counting a cold-start wedge as a
> failure of this test is how an infra number becomes a product number.
>
> Both arms green is **not** evidence that the cap is dispensable, and reading
> it that way is the trap this table exists to close: on `dev24` — the still
> *unbounded* image — 10 of 10 runs passed the same day, so this environment
> did not reproduce the failure at all and the two arms cannot discriminate
> between them. A 4M-TPM local org is the least sensitive place there is to
> measure a volume problem. The cap stays at **8**: it costs nothing, and it is
> still the only thing stopping an agent that does not converge from running 15
> turns. **Re-measure before changing the number — do not re-derive it on
> paper.**
>
> **Promoted to `@stable` in #1449, after the gate that outlived two others.**
> #827 gated promotion on "the clean non-guarded baseline"; **#818 closed on
> 2026-07-30 declaring that baseline achieved, twice**. #1378 then recorded
> #14469 as the gate; **#14489 closed that one on 2026-08-10**. Both expired
> without anyone noticing — and the first attempt to correct that record
> restated the #818 gate as live, so the trap is not hypothetical. The third
> reason was the real one and it is now measured: #1378's failure is
> **provider-specific** (OpenAI's 200k TPM on `gpt-4o-mini`), and the missing
> evidence was a post-#14489 run on that provider. It exists — see the Tags
> section for the full validation set, providers included.
>
> The cap stays at 8 after promotion. Nothing above argues it is unnecessary;
> it argues that the failure it bounds became far rarer.

---

## Validation criterion *(required)*

Per prompt, the **first** `tool_use` block persisted for the run's
nonce-keyed session names the expected tool (`fetch_content` for the fetch
prompt, `perform_search` for the search prompt) — plus, for the fetch
prompt, the `fetch_content` tool_use block's **output** contains the
endpoint's deterministic `Sample Slide Show` title (asserted on the tool
output, not the model prose, so a from-memory recitation cannot mask a failed
fetch). First-call is the distinctive observable: a wrong-tool run fails on
its very first block even when the model salvages a correct-looking answer
later; extra follow-up calls (provider-side style drift) do not pass a
wrong first choice.

For the chained prompt (test 3), the run's **ordered** `tool_use` list
contains both `fetch_content` and `perform_search` with the fetch call
appearing **before** the search call — the distinctive observable that the
agent executed a dependent two-tool sequence (a single-tool run, or the
tools in the wrong order, fails).

## Guarding against false positives *(how)*

- **Nonce-keyed session lookup** — monitor messages persist across flow
  wipes; the per-run nonce pins every API assertion to THIS run (same
  technique as `agent-tool-error-handling`).
- **First-call assert, not presence** — asserting only "expected tool
  present anywhere" would pass a run that opened with the WRONG tool and
  recovered; anchoring on the chronologically first `tool_use` block is
  what proves *selection*. (Sibling-absent was the original, stricter form
  — retired after the 2026-07-08 provider drift; see the Why note above.)
- **Tool use is forced, tool choice is not** — instructions demand exactly
  one tool call but never name a tool; a model that answers from memory
  produces zero `tool_use` blocks and fails the positive half (not a silent
  pass).
- **Search output content is NOT asserted** — live search results vary; the
  deterministic observable for test 2 is the tool_use block pair. If the
  search tool errors at runtime (rate limit), `handle_tool_error=True` turns
  it into tool output — the selection evidence still persists and the run
  produces no flow error, so the test still measures what it claims.
- **Sequence, not just presence (test 3)** — asserting both tools appear
  anywhere would pass a run that searched then fetched (or fetched twice);
  anchoring on `indexOf(fetch) < indexOf(search)` is what proves ordered
  *sequence*. The instruction permits multiple calls but the ORDER is the
  agent's, driven by the prompt's data dependency (it cannot search for the
  title before fetching it).
- **No live-bubble assert in test 3 (#1378)** — tests 1–2 assert a rendered
  `div-chat-message` because their contract includes a completed reply (test 1
  additionally pins the deterministic title on the persisted tool output).
  Test 3's contract is the ordered `tool_use` list and nothing else, so the
  spec doc never specified a bubble assert for it. The code carried one
  anyway — never documented here — and it was the line that failed on every
  context blow-up, reporting `element(s) not found` instead of the real cause.
  It is removed rather than relaxed — and the cost of that has to be stated
  plainly, because the natural phrasing ("no `allowFlowErrors`, so the fixture
  catches a crashed run") is **false on this surface today**. The Playground
  runs through `POST /api/v2/workflows`, where the flow-error verdict is
  ADVISORY by design (#1165) — the fixture prints *"this does NOT fail the test
  yet"*, and #1378's own evidence carries that exact line for this spec. So the
  ordered `tool_use` assert is now the **only** gate, and it reads data
  persisted *before* an overflow: a run that calls both tools and then dies
  could satisfy it. That is unmeasured rather than disproven — an attempt to
  force the overflow on `1.12.0.dev20` did not reproduce it — and #14489 makes
  the scenario much harder to reach from `dev25` on, which is why it is a
  follow-up rather than a blocker. When the v2 verdict flips to failing, the
  fixture becomes the gate this paragraph used to claim it already was; until
  then the honest gate would be a fixture accessor for the advisory verdict,
  never a proxy assert on the reply bubble.
- **Force-failure checks** (CONTRIBUTING §2): M1 — expect the sibling tool
  as first call in test 1 ⇒ selection assert must fail; M2 — assert an
  impossible title (e.g. `Sample Slide Show XYZ`) ⇒ the `fetch_content`
  tool-output execution assert must fail (verified against go-httpbin: the assert
  surfaced the real tool output containing *"title": "Sample Slide Show"* and
  failed the impossible pattern); M3 — same first-call swap in test 2 ⇒ must
  fail; M4 — invert the sequence assert (require `perform_search` before
  `fetch_content`) in test 3 ⇒ must fail against the real ordered tool list;
  M5 — point the `max_iterations` cap at a non-existent field id in test 3 ⇒
  the cap step must fail rather than silently leaving the default 15 in place
  (a cap that quietly does not apply is exactly the #1378 failure, and a
  passing run would not reveal it).

  **Re-executed for the #1449 promotion** on `1.12.0.dev25`, each isolated with
  `--grep` because the describe is `mode: "serial"` and the first failure would
  otherwise skip its siblings: **M1** failed with *first tool called was
  "fetch_content", expected "perform_search"*; **M3** with the mirror image;
  **M4** with *tools out of order: ["fetch_content","perform_search"] (indices
  [1,0])*; **M5** with `TimeoutError` on
  `inspector-add-max_iterations_FF_MUTATION`. M4 failed on its **first**
  attempt, against the two #1381 needed on `dev20` — where the first attempt
  died on the context blow-up instead of on the mutation, which is the same
  difference `#14489` makes everywhere else in this note.

---

## What this test does not cover *(optional)*

- Tool *failure* handling (covered by `agent-tool-error-handling.spec.ts`).
- Ambiguous prompts where either tool is defensible (not a contract).
- Tools added manually beyond the template's two (Custom Component probe
  tools are covered by other §6.4 bullets).
- The transient "Executed …" streaming headers — assertions target persisted
  monitor data and the final reply only.

**Expected noise in the log, so a reviewer does not re-diagnose it (#1449).**
Most runs of this file print one `🚨 Backend Error: 500 … DELETE /api/v1/flows/`
per test, body `{"detail":"An internal error occurred while deleting flows."}`.
That is **#1225** — `cascade_delete_flow` losing a `SQLITE_BUSY` race
(`OperationalError: database is locked`), measured at 10–22× per `daily-stable`
run across the whole suite and closed by decision rather than by a fix. It is
not caused by this spec and predates the promotion; it is left as an advisory
log entry on purpose. `page.expectKnownHttpError()` would be the natural
mechanism and is **wrong here**: it is verified in both directions, so a
declared defect that does not fire fails the test — and this one is
intermittent (5 of 6 runs in one local batch, 1 of 4 in another). Declaring it
would trade a known-noisy log for a test that goes red whenever the delete
happens to win the race.

---

## External dependencies *(required)*

- **LLM provider API** (per `models.json` target): one completion with one
  tool round-trip for tests 1–2. **Test 3 is not one round-trip** — it runs a
  multi-tool sequence bounded by the `max_iterations` cap of **8**, so it costs
  up to 8 model calls; the heaviest measured run sent **129,150** tokens in a
  single request (see the note in Step by step). It was unbounded before the
  cap, at up to 15 calls and requests of millions of tokens.
- **Web Search → DuckDuckGo + the linked pages** (tests 2 and 3): the component
  scrapes each result's page text, so this test's token cost is set by whatever
  pages DuckDuckGo returns that day. It was **unbounded** upstream
  (`langflow-ai/langflow#14469`) and is bounded from `1.12.0.dev25` on
  (`#14489`: 5 results × 2,000 chars ≈ 2.5k tokens per call, measured). Against
  an image older than `dev25` the `max_iterations` cap is the only thing keeping
  the total finite on our side.
- **URL-tool fetch endpoint** (test 1) — `${ECHO_BASE_URL}/json`, defaulting to
  `https://httpbin.org/json` (fixed `Sample Slide Show` payload). httpbin.org is
  chronically unreliable (sustained 503s/timeouts hard-failed this test on the
  2026-07-10 daily — #631), so the daily workflow self-hosts a go-httpbin service
  and exports `ECHO_BASE_URL` to its container IP; go-httpbin's `/json` serves the
  identical `Sample Slide Show` slideshow, keeping the content assert deterministic
  while removing the third-party-availability dependency in CI. The env-var names
  (`ECHO_BASE_URL` / `HTTPBIN_BASE_URL`) match the ones `daily-stable.yml` already
  exports — no workflow change was needed. **Note the endpoint runs the fetch from
  Langflow's backend, so a private-IP override must be in `LANGFLOW_SSRF_ALLOWED_HOSTS`
  (the daily already allows the RFC-1918 CIDRs).**
- **Web search backend** (test 2) — the `UnifiedWebSearch` component's live
  search; only tool *selection* is asserted, never result content.
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models).
