# Agent tool inspection — Playground names the tool used and captures its input/output

**Last validated:** Langflow 1.12.x (promotion measured on 1.12.1)

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

1. **UI (which tool) —** the Playground renders a **completed tool step** for
   the call — a `tool-status-done` marker in a row naming the tool
   (`FETCH CONTENT`) with its duration. This is the operator's at-a-glance
   "tools used" surface on the message, and it exists only because the agent
   actually invoked the tool.
2. **Payload (what it did) —** the run's persisted `tool_use` content block
   (monitor API, nonce-keyed) carries `name`, `tool_input` (the exact
   arguments — here the URL from the prompt), `output` (the tool's result),
   and `duration`. This is the inspection *data* behind the UI.

> **1.12 rendering — why this differs from the 1.11 draft.** Through ~1.11 the
> tool call surfaced as a `.cursor-pointer` accordion row reading "Called tool
> <NAME>" that **expanded inline** to show `Input:` and `Output:` JSON in the
> DOM. On 1.12 that expandable accordion is **gone** (scouted live on
> `1.12.0.dev0`): the Playground now shows a compact per-call step naming the
> tool and its duration. The tool call's input/output payload is no longer
> rendered as expandable UI; it lives in the persisted `content_blocks`
> (`tool_use` with `tool_input` + `output`), which is what any inspection reads
> from. This spec therefore asserts the completed step (UI) plus the persisted
> payload (monitor API) — deterministic and faithful to the 1.12 product,
> rather than driving a DOM accordion that no longer exists.

> **Why not `div-tools_tools_metadata` / `tool_<name>` (#1451).** Until the
> promotion below, layer 1 asserted those two test ids with an unscoped
> `.last()`, on the stated premise that *"the block only exists after a real
> tool call, so a hallucinated text-only answer has no chip"*. **That premise is
> false and the assertion was a no-op.** They are the `tools_metadata` **field
> of the URL and Web Search nodes on the canvas** —
> `aria-labelledby="node-URLComponent-…-field-tools_metadata-label"`, with the
> node's `button_open_actions` gear inside — and the canvas stays mounted
> **behind** the Playground modal, so an unscoped locator matches it. Playwright
> visibility is a non-empty bounding box, not "on top", so being behind a modal
> does not hide it. They list the tools **attached** to the agent, not the ones
> it used, and they exist before any run.
>
> Measured on `1.12.1`: an agent instructed never to call a tool, answering
> `4` to *"What is 2+2?"*, still renders **2** metadata blocks and **both**
> chips (`tool_fetch_content`, `tool_perform_search`) with **no** `tool_use`
> block persisted — and the old layer 1 **passed**. Only the payload layer
> caught it. On the same runs `tool-status-done` is **0**, and on a real call it
> is exactly **1**, inside a row reading `FETCH CONTENT 834ms`
> (`ToolCallCard.tsx`). `mcp-client-agent.spec.ts` asserts the same two test
> ids and its doc states the same premise as *"Proof #1"* — reported separately,
> not fixed here.

Distinct from existing coverage: `agent-multi-tool-selection` asserts WHICH
tool the agent picks and the ORDER of a two-tool sequence; `mcp-client-agent`
asserts the chip exists for MCP tools. Neither asserts the tool call's
**input arguments** are captured — that is this spec's subject.

---

## Tags *(required)*

`@stable` `@regression` `@agents` `@playground`

**Promoted in #1451.** The spec shipped without `@stable` under two gates that
have both been closed since 2026-07-30 — the flaky cluster #773 and the clean
non-guarded baseline #818, per #827 — and the justification then outlived its
reason silently for two weeks, which is what #1451 was raised about.

Promotion was **not** a tag flip: the forced-failure pass found layer 1 to be a
false positive (see the `#1451` note above) and it was rewritten first.
Evidence, on `1.12.1` with `MODEL_TEST_PROVIDER=openai MODEL_TEST_ID=gpt-4o-mini
--workers=1 --retries=0`:

- **6 clean whole-file runs** of the rewritten spec (5 plain + 1 `--trace=on`),
  15.0–17.8 s each.
- **Five forced failures, each re-executed against the committed fix**, and each
  failing on its own assertion: a wrong tool name in the step (layer 1), a wrong
  URL in `tool_input`, an impossible title in `output`, a wrong causal anchor,
  and the premise itself — an agent told never to call a tool, which now fails
  at layer 1 (*"Playground must show a COMPLETED tool step"*) where before it
  reached the payload layer.
- **Backend-error audit:** one advisory across the six runs, a
  `404 {"detail":"Flow not found"}` on `GET /api/v1/flows/{id}` — the known
  teardown race where the editor polls a flow `afterEach` has just deleted, not
  a product failure. An earlier pre-fix run also logged one
  `500 {"detail":"Could not update the flow."}` on an autosave `PATCH`, seen
  once in five and not reproduced in the six post-fix runs; it is recorded here
  rather than dismissed, since an HTTP error never fails a test (#1084).

**What is NOT covered by that evidence:** only `openai` was measured locally —
the Anthropic key is drained (`credit balance is too low`) and google was not
exercised, so both rest on the daily's own rotation (#1185). And the run used
public `httpbin.org`; the go-httpbin path is CI's (#1128).

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
   finish (Stop button hidden). No "expand the Steps accordion" step: the tool
   card `collapses to header-only once the producer attaches a duration`
   (`ToolCallCard.tsx`), so the trigger row carrying the status dot and the tool
   name is always rendered — only the args/result body collapses. The spec
   carried such a helper, inherited from 1.11; it was measured dead on 1.12.1
   (it matches zero rows) and removed.
5. **UI inspection assert:** a completed tool step is visible
   (`tool-status-done`), and the row that carries it names `fetch_content` —
   the Playground names the URL tool the agent used. Asserted in two steps on
   purpose: "the agent invoked no tool at all" and "it invoked a different
   tool" are different failures and must not report the same message.
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
8. No `allowFlowErrors` — a flow error the fixture reaches a verdict on fails the test
   (v1, and v2 since #1165). A run it could NOT read — a cancelled stream, a
   provider outage — is reported as *unevaluated* and does not fail anything;
   `page.flowErrorReport()` is how a spec asserts that guarantee for itself
   (#1452, `CONTRIBUTING.md` step 5).

---

## Validation criterion *(required)*

- The Playground renders a completed tool step (`tool-status-done`) whose row
  names `fetch_content` after the run (UI names the tool actually used).
  `done` is not the only terminal status — `toolStatus.ts` derives
  `error | done | running` and `error` wins over a duration — so a tool that was
  called and FAILED renders no `tool-status-done` and this assertion fails. That
  is correct for this spec, which goes on to assert the fetched payload, and the
  failure message names BOTH causes rather than claiming no tool was invoked.
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
- **Assert an element only an invocation creates** — `tool-status-done` is
  rendered per tool CALL, so layer 1 cannot pass on a run where the agent
  answered from memory. The test ids it replaced could, and did (see the
  `#1451` note above): that is the difference between asserting the tools the
  agent HAS and the tools it USED.
- **Force-failure checks** (CONTRIBUTING §3), all five executed against the
  committed spec and all five red: **M1** — the step must name
  `perform_search` ⇒ layer 1 fails *"The tool named in the Playground step must
  be fetch_content"*; **M2** — a wrong URL as the `tool_input` needle ⇒ the
  payload assert fails against the real captured input; **M3** — an impossible
  title as the `output` regex ⇒ the payload assert fails against the real
  captured output; **M4** — an impossible causal anchor ⇒ the final-answer
  assert fails; **M5** — the premise: the system prompt forbids tool use and the
  task is answerable from memory (*"What is 2+2?"*) ⇒ layer 1 fails, *no tool
  step exists*. M5 is the one that matters: it is the mutation the previous
  layer 1 survived.

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
- MCP tools in the Playground (covered by `mcp-client-agent` — whose own
  tool-indicator assertion carries the premise corrected here, reported
  separately rather than fixed in this PR).
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
- `src/frontend/src/components/core/chatComponents/ToolCallCard.tsx` — renders
  the per-call step: `data-testid={`tool-status-${status}`}` beside the tool
  title, inside an accordion row. This is the 1.12 tool-USAGE surface, and it is
  rendered only for a call the agent made.
- `GET /api/v1/monitor/messages` — persisted `content_blocks[].contents[]`
  `tool_use` entries carrying `name`, `tool_input`, `output`, `duration`.
- `tests/helpers/provider-setup/data/models.json` + `providers.json`
  (collect-models).
