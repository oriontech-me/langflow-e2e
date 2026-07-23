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

The spec generates tests per active model via the `getTestTargets()`
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
4. Open the Playground, send, wait for the run to finish (Stop button hidden).
5. **Sequence assert (API):** poll `GET /api/v1/monitor/messages` — nonce-keyed
   session lookup (same as tests 1–2); collect the **ordered** list of
   `tool_use` block names across the session's AI message(s). Assert the list
   contains both `fetch_content` and `perform_search`, with
   `indexOf(fetch_content) < indexOf(perform_search)` — the agent ran the two
   tools one after another in the required order. Only names/order are
   asserted (search content is non-deterministic).
6. No `allowFlowErrors`.

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
- **Force-failure checks** (CONTRIBUTING §2): M1 — expect the sibling tool
  as first call in test 1 ⇒ selection assert must fail; M2 — assert an
  impossible title (e.g. `Sample Slide Show XYZ`) ⇒ the `fetch_content`
  tool-output execution assert must fail (verified against go-httpbin: the assert
  surfaced the real tool output containing *"title": "Sample Slide Show"* and
  failed the impossible pattern); M3 — same first-call swap in test 2 ⇒ must
  fail; M4 — invert the sequence assert (require `perform_search` before
  `fetch_content`) in test 3 ⇒ must fail against the real ordered tool list.

---

## What this test does not cover *(optional)*

- Tool *failure* handling (covered by `agent-tool-error-handling.spec.ts`).
- Ambiguous prompts where either tool is defensible (not a contract).
- Tools added manually beyond the template's two (Custom Component probe
  tools are covered by other §6.4 bullets).
- The transient "Executed …" streaming headers — assertions target persisted
  monitor data and the final reply only.

---

## External dependencies *(required)*

- **LLM provider API** (per `models.json` target): one completion with one
  tool round-trip per test.
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
