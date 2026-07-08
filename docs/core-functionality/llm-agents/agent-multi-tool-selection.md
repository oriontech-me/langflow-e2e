# Agent multi-tool selection — correct tool per prompt

**Last validated:** Langflow 1.11.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.2 "Agent with multiple configured tools executes correctly"
and §6.4 "Multiple connected tools — agent selects the correct one for each
prompt". The Simple Agent template ships with **two tools already connected**
to the Agent — URL (`URLComponent`, tool `fetch_content`) and Web Search
(`UnifiedWebSearch`, tool `perform_search`), confirmed in the nightly's
`starter_projects/Simple Agent.json` — making it the canonical multi-tool
surface.

The contract: given a prompt that unambiguously calls for one capability, the
agent must invoke **that tool and not the other**. Two prompts, two tests:

1. **Fetch prompt → URL tool.** "Fetch https://httpbin.org/json …" must
   produce a `fetch_content` `tool_use` block and **no** `perform_search`
   block in the persisted AI message; the reply must contain the
   deterministic content of that endpoint (`Sample Slide Show`).
2. **Search prompt → Web Search tool.** "Search the web for …" must produce
   a `perform_search` `tool_use` block and **no** `fetch_content` block.

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
   message; its `tool_use` blocks must include `fetch_content` and must NOT
   include `perform_search`.
6. **Execution assert (UI):** the final AI bubble (`div-chat-message`)
   contains `Sample Slide Show` — the deterministic title served by
   httpbin.org/json (proves the tool ran and its output reached the answer).
7. No `allowFlowErrors` — any flow error fails the test via the fixture.

**Test 2 — search prompt selects the Web Search tool (§6.4)**

1–2. Same template load and Agent Instructions (fresh load; new nonce).
3. Seed the task: *"Search the web for recent news about the Playwright test
   framework and summarize one headline. (probe `<nonce>`)"*.
4. Open the Playground, send, wait for the run to finish.
5. **Selection assert (API):** same nonce-keyed monitor lookup; the AI
   message's `tool_use` blocks must include `perform_search` and must NOT
   include `fetch_content`.
6. **Execution assert (UI):** the final AI bubble is visible and non-empty
   (search result content is inherently non-deterministic — the selection
   assert in step 5 is the concrete observable; see false-positive notes).
7. No `allowFlowErrors`.

---

## Validation criterion *(required)*

Per prompt, the persisted AI message's `tool_use` blocks name **the expected
tool and not the sibling tool** (`fetch_content` without `perform_search` for
the fetch prompt; `perform_search` without `fetch_content` for the search
prompt), keyed to the run's session via a per-run nonce — plus, for the fetch
prompt, the reply contains the endpoint's deterministic `Sample Slide Show`
title. The positive+negative pair per prompt is the distinctive observable:
a wrong-tool run fails the negative half even when the model salvages a
correct-looking answer.

## Guarding against false positives *(how)*

- **Nonce-keyed session lookup** — monitor messages persist across flow
  wipes; the per-run nonce pins every API assertion to THIS run (same
  technique as `agent-tool-error-handling`).
- **Negative assert is mandatory** — asserting only "expected tool present"
  would pass a run that called BOTH tools indiscriminately; the
  "sibling tool absent" half is what proves *selection*.
- **Tool use is forced, tool choice is not** — instructions demand exactly
  one tool call but never name a tool; a model that answers from memory
  produces zero `tool_use` blocks and fails the positive half (not a silent
  pass).
- **Search output content is NOT asserted** — live search results vary; the
  deterministic observable for test 2 is the tool_use block pair. If the
  search tool errors at runtime (rate limit), `handle_tool_error=True` turns
  it into tool output — the selection evidence still persists and the run
  produces no flow error, so the test still measures what it claims.
- **Force-failure checks** (CONTRIBUTING §2): M1 — swap the expected/negative
  tool names in test 1 ⇒ selection assert must fail; M2 — assert an
  impossible title (e.g. `Sample Slide Show XYZ`) ⇒ execution assert must
  fail; M3 — swap the expected/negative names in test 2 ⇒ must fail.

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
- **httpbin.org** (test 1) — repo-standard deterministic HTTP endpoint
  (`/json` → fixed `Sample Slide Show` payload).
- **Web search backend** (test 2) — the `UnifiedWebSearch` component's live
  search; only tool *selection* is asserted, never result content.
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models).
