# Agent tool inspection — Playground names the tool used and captures its input/output

**Last validated:** Langflow 1.12.x

---

## What this test validates *(required)*

QA-CHECKLIST §6.5 "Inspect tools used by Agent in Playground". After an agent
run that invokes a tool, the operator must be able to **inspect** what the
agent did from the Playground: the response renders a tool-usage metadata row
naming the tool that was called, and the run's persisted content block carries
that tool call's **input** (the exact arguments the agent passed) and
**output** (the tool's result payload). Together these are the audit surface
for agent tool usage — if they break, tool calls become a black box.

**Two layers, both asserted:**

1. **UI (which tool) —** the Playground renders a `div-tools_tools_metadata`
   row containing a `tool_<name>` chip (e.g. `tool_fetch_content`, label
   `FETCH_CONTENT`) naming the tool the agent used. This is the operator's
   at-a-glance "tools used" surface on the message.
2. **Payload (what it did) —** the run's persisted `tool_use` content block
   (monitor API, nonce-keyed) carries `name`, `tool_input` (the exact
   arguments — here the URL from the prompt), `output` (the tool's result),
   and `duration`. This is the inspection *data* behind the UI.

> **1.12 rendering — why this differs from the 1.11 draft.** Through ~1.11 the
> tool call surfaced as a `.cursor-pointer` accordion row reading "Called tool
> <NAME>" that **expanded inline** to show `Input:` and `Output:` JSON in the
> DOM. On 1.12 that expandable accordion is **gone** (scouted live on
> `1.12.0.dev0`): the Playground now shows a compact `div-tools_tools_metadata`
> row of `tool_<name>` chips (label only, no inline Input/Output expansion —
> same surface `mcp-client-agent` asserts for MCP tools, #894). The tool call's
> input/output payload is no longer rendered as expandable UI; it lives in the
> persisted `content_blocks` (`tool_use` with `tool_input` + `output`), which is
> what any inspection reads from. This spec therefore asserts the chip (UI) plus
> the persisted payload (monitor API) — deterministic and faithful to the 1.12
> product, rather than driving a DOM accordion that no longer exists.

Distinct from existing coverage: `agent-multi-tool-selection` asserts WHICH
tool the agent picks and the ORDER of a two-tool sequence; `mcp-client-agent`
asserts the chip exists for MCP tools. Neither asserts the tool call's
**input arguments** are captured — that is this spec's subject.

---

## Tags *(required)*

`@regression` `@agents` `@playground`

No `@stable` at creation — this area is in the current flaky cluster (#773);
promotion is gated on the clean non-guarded baseline (#818), per issue #827.

---

## Preconditions *(optional)*

- Langflow running at `PLAYWRIGHT_BASE_URL`.
- `models.json` / `providers.json` generated via
  `npx playwright test tests/collect-models.spec.ts`.
- One active provider (resolved via `resolveTestTargets` — `MODEL_TEST_ID` /
  `MODEL_TEST_PROVIDER` when set, else one model per active provider; the
  inspection surface is provider-agnostic).
- Run with `--workers=1` (agent-family convention — shared instance state).

---

## Step by step *(required)*

1. Load the Simple Agent template (`SimpleAgentTemplatePage.load({ provider,
   model })` — configures the provider key and pins the chat model; the
   template-instantiation `POST /api/v1/flows/` id is captured for cleanup).
2. Set Agent Instructions (`textarea_str_system_prompt`): *"For every user
   question you MUST call exactly one tool to obtain the answer — never answer
   from memory or refuse. Choose the tool that fits the question."*
3. Seed the task on the ChatInput node (`textarea_str_input_value`): *"Fetch
   `${FETCH_URL}` and tell me the exact slideshow title it returns. (probe
   `<nonce>`)"* (`FETCH_URL` = `${ECHO_BASE_URL}/json`, default
   `https://httpbin.org/json` — same env convention as
   `agent-multi-tool-selection`).
4. Open the Playground (`playground-btn-flow-io`), send, wait for the run to
   finish (Stop button hidden).
5. **UI inspection assert:** the `div-tools_tools_metadata` row is visible and
   contains a `tool_fetch_content` chip — the Playground names the URL tool the
   agent used.
6. **Payload inspection assert (API):** poll `GET /api/v1/monitor/messages` —
   nonce-keyed session lookup (same technique as `agent-multi-tool-selection`);
   locate the `fetch_content` `tool_use` block and assert:
   - `tool_input` contains the **exact URL from the prompt** (the `/json`
     endpoint) — proves the captured input is the real arguments, not a label;
   - `output` contains the endpoint's deterministic `Sample Slide Show` title —
     proves the captured output is the real tool result.
7. **Causal anchor:** the final AI message (`chat-message-AI-…`) contains the
   fetched slideshow title (`Sample Slide Show`) — ties the inspected call to a
   real execution that produced the answer.
8. No `allowFlowErrors` — any flow error fails the test via the fixture.

---

## Validation criterion *(required)*

- The Playground renders a `div-tools_tools_metadata` row with a
  `tool_fetch_content` chip after the run (UI names the tool used).
- The run's persisted `fetch_content` `tool_use` block carries `tool_input`
  with the prompt's exact URL AND `output` containing `Sample Slide Show`
  (the input and output are captured for inspection).
- The final answer contains `Sample Slide Show`, content obtainable only
  through the tool — so the inspection reflects a genuine tool execution.

## Guarding against false positives *(how)*

- **Assert the tool `output`, not the model prose** — "Sample Slide Show" is a
  famous httpbin fixture a model can recite from memory; asserting it on the
  persisted `tool_use.output` (not the reply text) means a from-memory answer
  cannot mask a failed/absent fetch.
- **Assert `tool_input` carries the prompt's URL** — proves the captured input
  is the real arguments the agent passed, not a static chip label.
- **Nonce-keyed session lookup** — monitor messages persist across flow wipes;
  the per-run nonce pins the API assertions to THIS run.
- **Force-failure checks** (CONTRIBUTING §2): M1 — assert a bogus chip testid
  (`tool_nonexistent`) ⇒ the UI assert must fail; M2 — assert an impossible
  title in `output` (`Sample Slide Show XYZ`) ⇒ the payload assert must fail
  against the real captured output; M3 — assert a wrong URL in `tool_input`
  ⇒ the input assert must fail.

---

## Flow cleanup *(required)*

The test creates one flow (Simple Agent template). Every `POST /api/v1/flows`
→ 201 id is captured (page `response` listener, as in
`agent-multi-tool-selection`) and deleted by id in `test.afterEach` (id-scoped
— never name-based or delete-all). Behavioral force-fail contract: no-op the
cleanup and the flow count grows.

---

## What this test does not cover *(optional)*

- Which tool the agent selects among several / multi-tool ordering (covered by
  `agent-multi-tool-selection`).
- MCP-tool chips (covered by `mcp-client-agent`).
- The `button_open_actions` per-message actions button (message-level actions,
  not tool inspection).
- Duration-value correctness (`duration` is captured but timing is
  non-deterministic — not asserted).
- Markdown rendering of the answer (`agent-markdown-output.spec.ts`).

---

## External dependencies *(required)*

- **LLM provider API** — one real completion with a tool call (the agent must
  actually invoke `fetch_content`).
- **URL-tool fetch endpoint** — `${ECHO_BASE_URL}/json`, default
  `https://httpbin.org/json` (fixed `Sample Slide Show` payload). In CI the
  daily self-hosts go-httpbin and exports `ECHO_BASE_URL`; its `/json` serves
  the identical slideshow, keeping the output assert deterministic (same
  convention + SSRF-allowlist note as `agent-multi-tool-selection`).
- `src/frontend/src/components/core/chatComponents/` — renders the
  `div-tools_tools_metadata` row and `tool_<name>` chips (the 1.12 tool-usage
  surface).
- `GET /api/v1/monitor/messages` — persisted `content_blocks[].contents[]`
  `tool_use` entries carrying `name`, `tool_input`, `output`, `duration`.
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models).
